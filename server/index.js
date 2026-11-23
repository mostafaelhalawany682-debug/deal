'use strict';
/**
 * Deal — server (Express + PostgreSQL/Supabase).
 * Business rules mirror the Muse Space version (sbwnsr):
 * commission-first P2P bookings, automatic verification, computed badges,
 * graduated penalties, opportunities matching, owner dashboard.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, pool, init, normalizeContact } = require('./db');

const PORT = process.env.PORT || 3000;
const COMMISSION_RATE = 0.10;
const COMMISSION_PHONE = process.env.COMMISSION_PHONE || ''; // server-side only — من متغير البيئة فقط، بلا أي قيمة افتراضية في الكود
const FEE_REVIEW_WINDOW_MS = 24 * 3600 * 1000;   // نافذة رفض المالك لمرجع عمولة خاطئ: ٢٤ ساعة (قرار المالك)
/* نموذج إفراج باينانس (قرار المستخدم النهائي 2026-11-23): لا تأكيد استلام
   تلقائياً بالوقت أبداً — المحتجَز لا يتحرك إلا بتأكيد العميل نفسه (إفراج
   فوري)، أو بقرار مراجعة موثّق من المالك. سكوت العميل بعد إثبات سليم يفتح
   للمقدم «طلب مراجعة الإفراج» بعد ٣ ساعات من تسليم الإثبات. */
const APPEAL_AFTER_MS = 3 * 3600 * 1000; // طلب مراجعة الإفراج متاح بعد ٣ ساعات من إثبات سليم بلا تأكيد عميل

/* ---------------- باقة «نجم Deal» — إعدادات واحدة من الخادم ----------------
   السعر والمدة والعملة ثابتة هنا فقط (قابلة للتعديل لاحقاً من مكان واحد)،
   وقاعدة المال الصارمة: لا ميزة قبل تأكيد المالك وصول التحويلة فعلياً. */
const STAR_PRICE = 199;
const STAR_CURRENCY = 'EGP';
const STAR_DURATION_MS = 30 * 24 * 3600 * 1000; // 30 يوماً من لحظة تأكيد المالك
const STAR_REMIND_BEFORE_MS = 3 * 24 * 3600 * 1000; // تذكير قبل الانتهاء بـ3 أيام
const STAR_TERMS_VERSION = 'star-terms-v1';
const STAR_WEEK_MS = 7 * 24 * 3600 * 1000;

const app = express();
/* مسارات المال تحمل صور إيصالات base64 (حتى 2MB) — محلّل أكبر لها وحدها،
   يُسجَّل قبل المحلّل العام فيتولاها هو ويتخطاها العام (body-parser يعلّم
   الطلب مُعالجاً فلا يعيد تحليله). */
app.use('/api/money', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
// إنشاء الجداول عند أول طلب API (مرة واحدة لكل نسخة serverless — init() آمن للتكرار).
app.use('/api', async (req, res, next) => {
  try { await init(); next(); } catch (e) { next(e); }
});

const now = () => Date.now();
const rnd = (n) => crypto.randomBytes(n).toString('hex');

/* ---------------- helpers ---------------- */
async function notify(userId, type, text, ref = '') {
  if (!userId) return; // طرف ضيف (بلا حساب) — لا إشعارات داخلية له
  await db.prepare('INSERT INTO notifications (user_id,type,text,ref,created_at) VALUES (?,?,?,?,?)')
    .run(userId, type, text, ref, now());
  // مرآة Web Push (حزمة الإشعارات): نفس الحدث يصل جهاز المشترك — فشلها لا يعطّل شيئاً أبداً.
  try { await pushMirror(userId, type, text, ref); } catch (e) { /* Push اختياري دائماً */ }
}
async function getUser(id) { return await db.prepare('SELECT * FROM users WHERE id=?').get(id); }

/* ---------------- المتابعة (Follow) ---------------- */
async function followersCount(userId) {
  return (await db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id=?').get(userId)).c;
}
async function isFollowing(viewerId, userId) {
  if (!viewerId || viewerId === userId) return false;
  return !!(await db.prepare('SELECT 1 x FROM follows WHERE follower_id=? AND followee_id=?').get(viewerId, userId));
}

/* ---------------- الإحالات الموثقة (Referrals) ----------------
   كل صانع له رابط ملف قابل للمشاركة (#/u/<id>)؛ من يهبط عبره ويُسجّل يُنسب
   إليه (referred_by). الإحالة لا «تُحتسب» موثقة إلا عندما يصبح المسجَّل
   موثّقاً وغير مجمّد/محظور — والعدّ يُحسب من السجلات لحظياً فأي تجميد/حظر
   لاحق يُسقط الاحتساب تلقائياً. المكافآت: ٣+ إحالات موثقة = «ظهور مميز»
   (featured_until يُجدَّد +٧ أيام مع كل إحالة موثقة جديدة)، و٥ = شارة
   «سفير Deal» عبر محرك الشارات القواعدي القائم (computeBadges). */
const REFERRAL_FEATURED_MIN = 3;
const REFERRAL_AMBASSADOR_TARGET = 5;
async function verifiedReferralCount(userId) {
  return (await db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by=? AND verified=1 AND banned=0 AND frozen=0').get(userId)).c;
}
/* تُستدعى عند انتقال مستخدم إلى حالة «موثّق» (فحص آلي أو مراجعة استثنائية):
   إشعار للمُحيل + تجديد الظهور المميز عند بلوغ العتبة + مزامنة شاراته. */
async function onReferralVerified(u) {
  if (!u || !u.referred_by) return;
  const referrer = await getUser(u.referred_by);
  if (!referrer) return;
  await notify(referrer.id, 'referral_verified', `توثّق صانع سجّل من رابطك: ${u.name} — إحالة موثقة جديدة`, `user:${u.id}`);
  const cnt = await verifiedReferralCount(referrer.id);
  if (cnt >= REFERRAL_FEATURED_MIN) {
    await db.prepare('UPDATE users SET featured_until=? WHERE id=?').run(now() + 7 * 24 * 3600 * 1000, referrer.id);
  }
  await syncBadges(referrer.id);
}
/* ملخص اجتماعي آمن للقوائم (متابِعون/محادثات): هوية علنية فقط — بلا أي وسيلة تواصل.
   ومدينة المؤسس تحديداً لا تخرج لأي أحد غيره (طلب المالك الصريح): تُحذف من
   ملخصه في كل القوائم، بينما مدن الصناع العاديين تبقى كما هي. */
function socialSummary(u) {
  if (!u) return null;
  const founder = !!u.is_platform_founder;
  const s = {
    id: u.id, name: u.name, role: u.role, niche: u.niche, city: u.city,
    avatar: founder ? '' : (u.avatar || ''),
    accent: founder ? '' : (u.accent || ''),
    founder_seat: founder ? null : (u.founder_seat ?? null),
    verified: !!u.verified, pioneer: !!u.pioneer,
    is_platform_founder: founder, is_founder_member: !!u.is_founder_member,
  };
  if (founder) delete s.city;
  return s;
}

/* ---------------- باقة «نجم Deal»: حالة الاشتراك ودوران نجم الأسبوع ----------------
   الاشتراك «نشط» فقط إن كان مؤكداً من المالك ولم تنتهِ مدته — والحالة تُشتق من
   السجل لحظياً (status='active' AND expires_at>now) فتنطفئ المزايا تلقائياً عند
   الانتهاء حتى قبل أي مسح دوري. المسح (sweepStar) مسؤوليته الإشعارات وختم
   الحالة «expired» فقط، لا تفعيل/إطفاء المزايا نفسها. */
async function activeStarSub(userId) {
  if (!userId) return null;
  return await db.prepare(`SELECT * FROM star_subscriptions WHERE user_id=? AND status='active' AND expires_at>? ORDER BY activated_at DESC LIMIT 1`)
    .get(userId, now()) || null;
}
async function isStar(userId) { return !!(await activeStarSub(userId)); }
/* نجم الأسبوع — قاعدة دوران حتمية موثقة: رقم الأسبوع (منذ بدء العصر) modulo
   عدد المشتركين النشطين، والقائمة مرتبة بمعرّف العضو تصاعدياً (ترتيب ثابت لا
   يتغير داخل الأسبوع إلا بتغيّر مجموعة النشطين نفسها). نجم واحد فقط في كل وقت. */
async function weekStarUserId() {
  const rows = await db.prepare(`SELECT user_id FROM star_subscriptions WHERE status='active' AND expires_at>? ORDER BY user_id ASC`)
    .all(now());
  if (!rows.length) return null;
  const weekIndex = Math.floor(now() / STAR_WEEK_MS);
  return rows[weekIndex % rows.length].user_id;
}
async function sweepStar() {
  const t = now();
  // تذكير «قارب على الانتهاء» مرة واحدة لكل اشتراك.
  const soon = await db.prepare(`SELECT * FROM star_subscriptions WHERE status='active' AND expires_at>? AND expires_at-?<=? AND reminded_expiring=0`)
    .all(t, t, STAR_REMIND_BEFORE_MS);
  for (const s of soon) {
    await db.prepare('UPDATE star_subscriptions SET reminded_expiring=1 WHERE id=?').run(s.id);
    await notify(s.user_id, 'star_expiring', '⭐ اشتراكك في «نجم Deal» بينتهي خلال ٣ أيام — جدّد بنفس خطوات الاشتراك عشان مزاياك ماتتقطعش', 'star');
  }
  // ختم الانتهاء + إشعار مرة واحدة (تغيّر الحالة نفسه يمنع التكرار).
  const done = await db.prepare(`SELECT * FROM star_subscriptions WHERE status='active' AND expires_at<=?`).all(t);
  for (const s of done) {
    await db.prepare(`UPDATE star_subscriptions SET status='expired' WHERE id=?`).run(s.id);
    if (!s.reminded_expired) {
      await db.prepare('UPDATE star_subscriptions SET reminded_expired=1 WHERE id=?').run(s.id);
      await notify(s.user_id, 'star_expired', 'انتهى اشتراكك في «نجم Deal» — انطفأت مزايا النجم. جدّد في أي وقت من صفحة الباقة ⭐', 'star');
    }
  }
}
/* عرض اشتراك آمن للواجهات: بلا decided_by ولا أي بيانات تواصل. */
function starSubView(s) {
  if (!s) return null;
  return {
    id: s.id, user_id: s.user_id, amount: s.amount, currency: s.currency, ref: s.ref,
    status: s.status, terms_version: s.terms_version, terms_accepted_at: s.terms_accepted_at,
    created_at: s.created_at, decided_at: s.decided_at, reject_reason: s.reject_reason,
    activated_at: s.activated_at, expires_at: s.expires_at,
    days_left: s.status === 'active' && s.expires_at > now() ? Math.ceil((s.expires_at - now()) / (24 * 3600 * 1000)) : 0,
  };
}
/* حالة العضو مع الباقة في صورة واحدة تستخدمها /api/star/me والواجهة:
   none (لا اشتراك) | pending (قيد التحقق — بلا أي ميزة) | active | rejected | expired. */
async function myStarState(userId) {
  await sweepStar();
  const active = await activeStarSub(userId);
  if (active) return { state: 'active', subscription: starSubView(active), is_week_star: (await weekStarUserId()) === userId };
  const latest = await db.prepare('SELECT * FROM star_subscriptions WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 1').get(userId);
  if (!latest) return { state: 'none', subscription: null, is_week_star: false };
  return { state: latest.status, subscription: starSubView(latest), is_week_star: false };
}

/* ---------------- المرجع المالي الموحد + نظام أمان المعاملات ----------------
   قرار المالك الملزم: كل التزام مالي في المنصة (اشتراك باقة، عمولة حجز،
   عربون، دفعة أخيرة) يحمل «مرجعاً مالياً» يعرفه الطرفان: كود معاملة بشري
   (DL-XXXXXX) + مبلغ فريد بكسور بصمة (base + قروش 1..99 لا تصطدم بأي التزام
   مفتوح لنفس المستلم) — لأن تحويلات المحافظ الشخصية بلا خانة ملاحظات، فالكسور
   نفسها هي المرجع الذي يطابقه الإيصال. كل انتقال حالة يُسجَّل في money_ledger
   (سجل append-only: INSERT فقط في كل الكود — لا UPDATE ولا DELETE عليه أبداً).
   قاعدة الأمان الحاكمة: لا حالة فلوس تتحرك بكلمة طرف واحد — الادعاء (claimed)
   وحده لا يؤكّد؛ التأكيد يحتاج مطابقة إيصال كاملة صارمة، أو قرار المستلم/المالك،
   أو مهلة قائمة في آلة الحجز. */
const MONEY_OB_TTL_MS = 3 * 3600 * 1000;       // مهلة الدفع الموحّدة (٣ ساعات — حد باينانس الأقصى؛ قرار المستخدم «بدّلهم» 2026-11-23) — عمر الالتزام المفتوح قبل انتهائه
const NEGOTIATION_MS = 10 * 60 * 1000;         // طور التفاوض في التحكيم قبل التصعيد للمالك (قاعدة باينانس)
const REAPPEAL_COOLDOWN_MS = 5 * 60 * 1000;    // مهلة من يلغي تحكيمه بنفسه قبل فتح آخر (قاعدة باينانس)
const DEEMED_AFTER_MS = 3 * 3600 * 1000;       // سكوت العميل بعد إثبات سليم + باقٍ محتجَز = استلام مُعتبَر (قاعدة باينانس — قرار المستخدم 2026-11-23)
const RELEASE_ALERT_MS = 15 * 60 * 1000;       // تنبيه المالك العاجل: مبلغ جاهز للإفراج ينتظر أكثر من ١٥ دقيقة (قاعدة باينانس)
const FRAUD_SUSPEND_AT = 3;                    // ٣ مطالبات دفع كاذبة مثبتة = إيقاف وظائف الحجز (رقم باينانس)
const TX_TERMS_VERSION = 'deal-tx-terms-v2';   // إصدار «شروط المعاملات» الحالي — إصدار جديد يطلب قبولاً جديداً للحجوزات الجديدة
const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;     // أقصى حجم لصورة الإيصال
const RECEIPT_MAX_ATTEMPTS = 5;                // بعدها يُقفل الرفع على الالتزام
const RECEIPT_DATE_WINDOW_MS = 48 * 3600 * 1000; // حداثة تاريخ الإيصال المطلوبة
const RECEIPT_HOURLY_CAP = 20;                 // حد إيصالات الرافع الواحد في الساعة
const mround = (x) => Math.round(x * 100) / 100; // نفس تقريب آلة الحجز القائمة حرفياً

async function moneyLedger(obligationId, from, to, actor, note = '') {
  await db.prepare('INSERT INTO money_ledger (obligation_id,from_status,to_status,actor,note,created_at) VALUES (?,?,?,?,?,?)')
    .run(obligationId, from || '', to, actor, String(note || '').slice(0, 300), now());
}
/* انتقال حالة وحيد لكل الالتزامات: تحديث + سجل في خطوة واحدة، فلا حالة بلا أثر. */
async function setObligationStatus(ob, to, actor, note = '', patch = {}) {
  const allowed = ['transfer_ref', 'receipt_hash', 'decided_by', 'decided_at', 'fraud_flag', 'receipt_locked', 'receipt_attempts', 'reject_kind'];
  const sets = ['status=?'], args = [to];
  for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k}=?`); args.push(patch[k]); }
  await db.prepare(`UPDATE money_obligations SET ${sets.join(',')} WHERE id=?`).run(...args, ob.id);
  await moneyLedger(ob.id, ob.status, to, actor, note);
  /* ختم المُحصّل (جولة السفير): انتقال التزام منصة إلى «مؤكد» يعني أن المال
     وصل فعلاً إلى نقطة تحصيل — تُختم هوية المُحصّل (السفير النشط لنطاق
     الالتزام وقتها، أو المالك نفسه) ورقمه ووقت التحصيل على الالتزام، فتبقى
     نسبة التحصيل وحسابات التسوية ثابتة تاريخياً مهما تبدّل السفراء بعدها.
     الختم توثيقي بحت: أي فشل فيه لا يعطّل تأكيداً مالياً أبداً. */
  if ((to === 'confirmed' || to === 'auto_confirmed') && ob.payee === 'owner') {
    try {
      const fresh = await db.prepare('SELECT * FROM money_obligations WHERE id=?').get(ob.id);
      if (fresh) await stampObligationCollector(fresh);
    } catch (e) { /* توثيق المُحصّل لا يعطّل المال */ }
  }
  return await db.prepare('SELECT * FROM money_obligations WHERE id=?').get(ob.id);
}
async function getObligation(id) { return await db.prepare('SELECT * FROM money_obligations WHERE id=?').get(id); }
async function notifyOwner(type, text, ref = '') {
  const founder = await db.prepare('SELECT id FROM users WHERE is_platform_founder=1').get();
  if (founder) await notify(founder.id, type, text, ref);
}
/* عرض الالتزام الآمن للدافع وحده: الكود والمبلغ بالبصمة والحالة — بلا بيانات غيره. */
/* عرض الالتزام للدافع نفسه داخل خطوة دفعه: يضيف وسيلة دفع دولة الدافع
   (payLabel من التصنيف — مصدر الحقيقة نفسه) ورقم المستلم الذي سيحوّل إليه:
   رقم العمولات يُكشف فقط بينما الالتزام «مفتوح» (خطوة دفع نشطة — نفس بوابة
   payment-info القائمة؛ فلا يظهر أبداً في حالة «قيد التحقق»)، ورقم المقدم
   يُكشف لطرفي حجزه لأنه وسيلة التحويل نفسها. */
async function payerObligationView(ob, countryCode) {
  const v = obligationView(ob);
  const c = countryOf(countryCode) || countryOf('EG');
  v.country = c.code;
  v.method_label = c.payAr;
  v.method_label_en = c.payEn;
  if (ob.payee === 'owner') {
    /* رقم المستلم داخل خطوة الدفع: سفير فعّال لنطاق الالتزام (مدينة/دولة
       الدافع) يقدّم رقمه المحلي بدل رقم المالك الافتراضي — بنفس بوابة الكشف
       القائمة (الالتزام «مفتوح» فقط) وبنفس المرجع وبصمة الكسور حرفياً. */
    if (ob.status === 'open') {
      const col = await collectorForObligation(await stampObligationScope(ob));
      if (col.phone) {
        v.payee_phone = col.phone;
        v.collector = col.via;
        if (col.ambassador) { v.collector_city = col.ambassador.city; v.collector_country = col.ambassador.country; }
      }
    }
  } else if (ob.payee_user_id) {
    const pu = await getUser(ob.payee_user_id);
    if (pu && pu.contact) v.payee_phone = pu.contact;
  }
  return v;
}
async function guestCountryByToken(token) {
  const r = await db.prepare('SELECT country FROM shop_requests WHERE guest_token=?').get(token);
  return (r && r.country) || 'EG';
}
function obligationView(ob) {
  if (!ob) return null;
  return {
    code: ob.code, kind: ob.kind, booking_id: ob.booking_id,
    base_amount: ob.base_amount, exact_amount: mround(ob.exact_amount),
    currency: ob.currency, status: ob.status, payee: ob.payee,
    created_at: ob.created_at, expires_at: ob.expires_at,
    receipt_locked: !!ob.receipt_locked,
  };
}
const MONEY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newMoneyCode() {
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += MONEY_CODE_ALPHABET[bytes[i] % MONEY_CODE_ALPHABET.length];
  return `DL-${s}`;
}
/* مخصّص البصمة: كسور 1..99 لا يستخدمها أي التزام مفتوح/مُدّعى لنفس المستلم
   وبنفس المبلغ الأساسي — والفهرس الفريد الجزئي في القاعدة ظهر أخير عند السباق. */
async function allocFingerprint(payee, baseAmount) {
  const used = new Set((await db.prepare(`SELECT fingerprint_cents FROM money_obligations WHERE payee=? AND base_amount=? AND status IN ('open','claimed')`)
    .all(payee, baseAmount)).map((r) => r.fingerprint_cents));
  const free = [];
  for (let c = 1; c <= 99; c++) if (!used.has(c)) free.push(c);
  if (!free.length) return null;
  return free[crypto.randomInt(free.length)];
}
async function createObligation(f) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cents = await allocFingerprint(f.payee, f.base_amount);
    if (cents == null) throw new Error('لا توجد بصمة مبلغ متاحة الآن — حاول بعد قليل');
    try {
      const info = await db.prepare(`INSERT INTO money_obligations (code,kind,booking_id,user_id,base_amount,fingerprint_cents,exact_amount,currency,payer_user_id,guest_token,payee,payee_user_id,status,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`)
        .run(newMoneyCode(), f.kind, f.booking_id ?? null, f.user_id ?? null, f.base_amount, cents,
          mround(f.base_amount + cents / 100), f.currency || 'EGP', f.payer_user_id ?? null,
          f.guest_token || '', f.payee, f.payee_user_id ?? null, now(), now() + MONEY_OB_TTL_MS);
      const ob = await getObligation(info.lastInsertRowid);
      await moneyLedger(ob.id, '', 'open', 'system', `أُنشئ الالتزام (${f.kind})`);
      return ob;
    } catch (e) { if (e && e.code === '23505') continue; throw e; } // سباق بصمة/كود — أعد التخصيص
  }
  throw new Error('تعذر إنشاء المرجع المالي — حاول مجدداً');
}
/* جلب التزام الغرض نفسه إن كان مفتوحاً/مُدّعى (يُعاد استخدامه)، وإن انتهت
   صلاحيته يُختم «expired» في السجل ويُولد بديل جديد — فلا بصمة محجوزة للأبد. */
async function getOrCreateObligation(f) {
  let existing = null;
  if (f.kind === 'star_subscription') {
    existing = await db.prepare(`SELECT * FROM money_obligations WHERE kind='star_subscription' AND user_id=? AND status IN ('open','claimed') AND is_difference=0 ORDER BY id DESC LIMIT 1`).get(f.user_id);
  } else {
    existing = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND status IN ('open','claimed') AND is_difference=0 ORDER BY id DESC LIMIT 1`).get(f.kind, f.booking_id);
  }
  if (existing) {
    if (!existing.expires_at || existing.expires_at > now()) return await stampObligationScope(existing);
    await setObligationStatus(existing, 'expired', 'system', 'انتهت صلاحية الالتزام المفتوح');
  }
  return await stampObligationScope(await createObligation(f));
}
/* مبالغ أرجل الحجز بنفس صيغ آلة الحالات القائمة حرفياً (عمولة/نصف الصافي). */
function bookingLegAmounts(b) {
  const fee = mround(b.price * COMMISSION_RATE);
  const net = b.price - fee;
  const half = mround(net / 2);
  return { fee, deposit: half, rest: half };
}
const OBLIGATION_KIND_FOR_LEG = { fee: 'booking_commission', deposit: 'booking_deposit', rest: 'booking_final' };
/* ربط دفعة مسجلة في آلة الحجز بالتزامها: ادعاء الدافع بمرجعه (claimed) — لا
   تأكيد؛ التأكيد يأتي من مطابقة إيصال أو قرار مالك/مستلم أو اكتمال الحجز. */
async function claimObligationForPayment(b, kind, ref, actor) {
  const legKind = OBLIGATION_KIND_FOR_LEG[kind];
  if (!legKind) return null;
  const amounts = bookingLegAmounts(b);
  const base = kind === 'fee' ? amounts.fee : amounts[kind];
  /* المستلم: العمولة وحدها → المنصة (إيراد Deal الخاص). العربون والدفعة
     الأخيرة → المقدم مباشرة بين المحافظ — Deal لا تستلم ولا تحتجز أموال
     المعاملات بين الأطراف في أي مرحلة (قرار المستخدم 2026-11-23: الضمان في
     الشغل لا في الفلوس — النسخة النهائية لا تُسلَّم إلا بعد تأكيد قبض الباقي). */
  const toOwner = kind === 'fee';
  const ob = await getOrCreateObligation({
    kind: legKind, booking_id: b.id, user_id: b.talent_id, base_amount: base, currency: b.currency,
    payer_user_id: b.client_id || null, guest_token: b.guest_token || '',
    payee: toOwner ? 'owner' : `user:${b.talent_id}`,
    payee_user_id: toOwner ? null : b.talent_id,
  });
  if (ob.status === 'open') {
    const claimed = await setObligationStatus(ob, 'claimed', actor, 'سجّل الدافع مرجع التحويلة في الحجز', { transfer_ref: String(ref || '').slice(0, 120) });
    // اكتمال الحجز لاحقاً/سابقاً هو عامل التأكيد الثاني لهذه الرجل (عدا الأخيرة:
    // تأكيد التزامها يقود خطوة التسليم النهائي — عبر syncFinalLeg).
    const fresh = await getBooking(b.id);
    if (legKind !== 'booking_final') {
      if (fresh && fresh.status === 'completed') await settleLegObligation(b.id, legKind, 'اكتمل الحجز واكتمل القبض');
      else if (legKind === 'booking_deposit' && fresh && fresh.proof_at) await settleLegObligation(b.id, legKind, 'قدّم المنفذ إثبات التنفيذ');
    }
    if (legKind === 'booking_final') await syncFinalLeg(b.id);
    return await getObligation(claimed.id);
  }
  if (legKind === 'booking_final') await syncFinalLeg(b.id);
  return ob;
}
/* تسوية التزام رجل (عربون/أخيرة) إلى «confirmed» عندما يثبت اكتمال الحجز —
   اكتمال القبض نفسه هو عامل التأكيد الثاني بعد ادعاء الدافع. */
async function settleLegObligation(bookingId, legKind, note) {
  const ob = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND status='claimed' ORDER BY id DESC LIMIT 1`).get(legKind, bookingId);
  if (ob) await setObligationStatus(ob, 'confirmed', 'system', note);
}

/* ---------------- سفير المدينة = نقطة التحصيل المحلية (اقتراح ٤) ----------------
   المالك يعيّن عضواً موثّقاً «سفير مدينة» لنطاق (دولة + مدينة): رقم محفظته
   المحلية يصبح رقم التحصيل الذي يظهر داخل خطوات دفع التزامات المنصة الواقعة
   في نطاقه (عمولة حجز، باقي محتجَز، اشتراك نجم) بدل رقم المالك الافتراضي —
   والمرجع المالي الموحد وبصمة الكسور كما هما تماماً. «نطاق الالتزام» هو
   مدينة/دولة الدافع (عضواً كان: حسابه؛ أو ضيفاً: طلبُه) — لأن خطوة الدفع
   خطوته هو ووسيلة دفع دولته هي ما يراه أصلاً في الالتزام. خارج أي نطاق سفير:
   الرقم الافتراضي الحالي كما هو حرفياً. نسبة/مقابل السفير حقل يضبطه المالك
   ويُحفظ للعرض فقط — لا منطق خصم ولا توزيع فلوس يُبنى حوله أبداً. */
function normCity(s) { return String(s || '').trim().replace(/\s+/g, ' '); }
/* نطاق الالتزام من سجلاته: أعمدة مختومة أولاً، وإلا يُشتق من الدافع. */
async function obligationScope(ob) {
  if (ob.scope_country) return { city: ob.scope_city || '', country: ob.scope_country };
  let city = '', country = '';
  if (ob.payer_user_id) {
    const u = await getUser(ob.payer_user_id);
    if (u) { city = u.city || ''; country = u.country || 'EG'; }
  } else if (ob.guest_token) {
    const r = await db.prepare('SELECT city, country FROM shop_requests WHERE guest_token=?').get(ob.guest_token);
    if (r) { city = r.city || ''; country = r.country || 'EG'; }
  }
  if (!country && ob.user_id) {
    const u = await getUser(ob.user_id);
    if (u) { city = u.city || ''; country = u.country || 'EG'; }
  }
  return { city, country };
}
/* ختم النطاق على الالتزام مرة واحدة (من أول إنشاء/عرض) فتستقر قراءته لاحقاً. */
async function stampObligationScope(ob) {
  if (!ob || ob.scope_country) return ob;
  const sc = await obligationScope(ob);
  if (!sc.country) return ob;
  await db.prepare('UPDATE money_obligations SET scope_city=?, scope_country=? WHERE id=?').run(sc.city || '', sc.country, ob.id);
  return await getObligation(ob.id);
}
/* السفير الفعّال لنطاق (مدينة، دولة) — واحد فقط بفهرس فريد جزئي في القاعدة. */
async function activeAmbassadorFor(city, country) {
  const c = countryOf(country);
  if (!c || !normCity(city)) return null;
  const rows = await db.prepare('SELECT * FROM ambassadors WHERE active=1 AND country=? ORDER BY id ASC').all(c.code);
  const target = normCity(city);
  return rows.find((a) => normCity(a.city) === target) || null;
}
async function ambassadorForObligation(ob) {
  if (!ob || ob.payee !== 'owner') return null;
  const sc = await obligationScope(ob);
  return await activeAmbassadorFor(sc.city, sc.country);
}
/* رقم التحصيل الفعلي لالتزام منصة: رقم السفير النشط لنطاقه، وإلا الافتراضي. */
async function collectorForObligation(ob) {
  const amb = await ambassadorForObligation(ob);
  if (amb && amb.collection_phone) return { phone: amb.collection_phone, via: 'ambassador', ambassador: amb };
  return { phone: COMMISSION_PHONE, via: 'owner', ambassador: null };
}
/* ختم المُحصّل عند تأكيد الالتزام (يُستدعى من setObligationStatus): السفير
   النشط للنطاق في هذه اللحظة (أو المالك نفسه بلا سفير) + رقمه + وقت التحصيل. */
async function stampObligationCollector(ob) {
  const scoped = await stampObligationScope(ob);
  const amb = await ambassadorForObligation(scoped);
  await db.prepare('UPDATE money_obligations SET collector_user_id=?, collector_phone=?, collector_at=? WHERE id=?')
    .run(amb ? amb.user_id : null, amb ? amb.collection_phone : (COMMISSION_PHONE || ''), now(), ob.id);
}
/* نطاق سفارة عضو (لشارة ملفه/بطاقته) — المؤسس بلا سفارة أبداً. */
async function activeAmbassadorScopeOf(userId) {
  if (!userId) return null;
  const a = await db.prepare('SELECT city, country FROM ambassadors WHERE user_id=? AND active=1 ORDER BY id ASC LIMIT 1').get(userId);
  return a ? { city: a.city, country: a.country } : null;
}
/* وسائل تسوية السفراء — حقل قابل للاختيار لكل تعيين (settlement_method)
   وليست ثابتة في الكود (قرار المستخدم 2026-11-23 «بعد كدا نضيف وسائل
   أخرى»): السجلّ هنا هو مصدر القيم المسموحة، وإضافة وسيلة لاحقاً = قيمة
   جديدة في السجلّ فقط بلا إعادة بناء. المفعّل الآن: payoneer لنطاقات
   الخارج (تحويل فوري بلا رسوم بين حسابي بايونير — صفقة بصفقة بقرار
   المستخدم 2026-11-23)؛ وbank_transfer مسجّلة كمقعد بنيوي غير مفعّل بعد.
   مصر بلا وسيلة ('' = تسوية مباشرة مع المالك برقمه كما هي). */
const SETTLEMENT_METHODS = {
  payoneer: { enabled: true, ar: 'Payoneer — تحويل فوري بين حسابي بايونير', en: 'Payoneer — instant transfer between Payoneer accounts' },
  bank_transfer: { enabled: false, ar: 'تحويل بنكي', en: 'Bank transfer' },
};
function settlementMethodOf(appt) {
  const m = String((appt && appt.settlement_method) || '');
  if (m && SETTLEMENT_METHODS[m]) return m;
  return appt && appt.country && appt.country !== 'EG' ? 'payoneer' : '';
}
/* إعدادات المنصة البسيطة (مفتاح/قيمة) — منها معرّف استلام بايونير الخاص
   بالمالك: يضبطه المالك من لوحته بنفسه، افتراضياً فارغ، ولا يظهر إلا
   للسفير المعيَّن داخل قسم تسويته. */
async function getSetting(key) {
  const r = await db.prepare('SELECT value FROM platform_settings WHERE key=?').get(key);
  return r ? String(r.value || '') : '';
}
async function setSetting(key, value) {
  await db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?,?,?)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`).run(key, String(value || ''), now());
}
/* تسوية مؤكدة صفقةً بصفقة لالتزام (صف obligation_settlements بحالة
   confirmed) — تُستخدم لحساب «المُسوّى» في وضع التسوية لكل التزام. */
async function confirmedSettlementByObligation(obligationIds) {
  const map = new Map();
  if (!obligationIds.length) return map;
  const rows = await db.prepare(`SELECT * FROM obligation_settlements WHERE status IN ('declared','confirmed')`).all();
  for (const s of rows) if (obligationIds.includes(s.obligation_id)) map.set(s.obligation_id, s);
  return map;
}
/* محصّلات تعيين سفير من الالتزامات المؤكدة المختومة باسمه في نطاقه، وحالة
   التسوية منها: في وضع «وسيلة لكل التزام» (settlement_method مضبوطة)
   المُسوّى = ما له تسوية مؤكدة من المالك صفقةً بصفقة؛ وفي الوضع القديم
   (مصر/بلا وسيلة) ما خُتم قبل لحظة «تمت التسوية» الأخيرة = مُسوّى.
   الأرقام من السجلات فقط — لا تُحسب من التعيين نفسه. */
async function ambassadorCollected(appt) {
  const rows = await db.prepare(`SELECT id, exact_amount, currency, collector_at, scope_city, scope_country FROM money_obligations WHERE collector_user_id=? AND status IN ('confirmed','auto_confirmed')`).all(appt.user_id);
  const cur = (countryOf(appt.country) || {}).currency || '';
  const perDeal = !!settlementMethodOf(appt);
  const settleMap = perDeal ? await confirmedSettlementByObligation(rows.map((o) => o.id)) : new Map();
  let total = 0, settled = 0;
  for (const o of rows) {
    if ((o.scope_country || '') !== appt.country || normCity(o.scope_city || '') !== normCity(appt.city)) continue;
    if (cur && o.currency !== cur) continue;
    total += o.exact_amount;
    if (perDeal) { const s = settleMap.get(o.id); if (s && s.status === 'confirmed') settled += o.exact_amount; }
    else if (appt.settled_at && o.collector_at && o.collector_at <= appt.settled_at) settled += o.exact_amount;
  }
  total = mround(total); settled = mround(settled);
  const pending = mround(total - settled);
  return { total, settled, pending, currency: cur, status: total === 0 ? 'none' : (pending > 0 ? 'pending' : 'settled') };
}
async function ambassadorView(appt) {
  const u = await getUser(appt.user_id);
  return {
    id: appt.id, user_id: appt.user_id, user_name: u ? u.name : '—',
    city: appt.city, country: appt.country, collection_phone: appt.collection_phone,
    compensation: appt.compensation || '', active: !!appt.active,
    settlement_method: settlementMethodOf(appt),
    created_at: appt.created_at, removed_at: appt.removed_at || 0, settled_at: appt.settled_at || 0,
    collected: await ambassadorCollected(appt),
  };
}

/* ---------------- الدفعة الأخيرة المباشرة + التسليم النهائي (لا احتجاز) ----------------
   قرار المستخدم الجوهري (2026-11-23، قلق المساءلة القانونية): Deal لا تستلم
   ولا تحتجز أموال المعاملات بين الأطراف في أي مرحلة — الباقي (٤٥٪) يتحوّل من
   العميل إلى المنفذ مباشرة مثل العربون تماماً (التزام booking_final بمستلم
   المنفذ، بنفس المرجع الموحد والبصمة والمطابقة الصارمة). الضمان انتقل من
   الفلوس إلى الشغل نفسه: إثبات التنفيذ «معاينة»، وبعد قبول الاستلام (تأكيد
   العميل أو الاستلام المُعتبَر بسكوت ٣ ساعات) تُفتح خطوة دفع الباقي بعدّاد
   ٣ ساعات؛ ولا يكتمل الحجز إلا بـ(أ) تأكيد قبض الباقي (مطابقة إيصال صارمة
   على رقم المنفذ أو تأكيد المنفذ اليدوي «وصلني») و(ب) ضغط المنفذ «تم تسليم
   النسخة النهائية» ثم تأكيد العميل استلامها أو سكوته ٣ ساعات (اكتمال
   مُعتبَر). عدم دفع الباقي بعد قبول الاستلام = «مستحق متأخر» يضرب نسبة
   إتمام العميل ويفتح تحكيم المالك (عقوبات/أدلة) — بلا أي حركة مال عند المنصة.
   أعمدة escrow_* القديمة في bookings بقيت في القاعدة بلا استخدام (توافق
   رجعي للبيانات) ولا تُكتب ولا تُقرأ في هذا النموذج. */
async function finalObligation(bookingId) {
  return await db.prepare(`SELECT * FROM money_obligations WHERE kind='booking_final' AND booking_id=? AND is_difference=0 ORDER BY id DESC LIMIT 1`).get(bookingId);
}
async function restPaymentRow(bookingId) {
  return await db.prepare(`SELECT * FROM payments WHERE booking_id=? AND kind='rest' ORDER BY id DESC LIMIT 1`).get(bookingId);
}
/* مزامنة خطوة الباقي مع حالة التزامها — مصدر الحقيقة الوحيد لانتقال «تأكد
   القبض» و«مرفوض»، وتُستدعى من كل حدث يمسّ الالتزام. آمنة للتكرار. */
async function syncFinalLeg(bookingId) {
  if (!bookingId) return null;
  let b = await getBooking(bookingId);
  if (!b) return null;
  const ob = await finalObligation(bookingId);
  if (!ob) return b;
  let pay = await restPaymentRow(bookingId);
  if (['confirmed', 'auto_confirmed'].includes(ob.status)) {
    // القبض تأكد (إيصال مطابق على رقم المنفذ أو «وصلني» من المنفذ نفسه):
    // صف الدفعة يُختم «confirmed» — حتى لو سبق التأكيدُ ادعاءَ العميل.
    if (!pay) {
      const info = await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at) VALUES (?,?,?,?,?,?)')
        .run(b.id, 'rest', bookingLegAmounts(b).rest, ob.transfer_ref || '', 'confirmed', now());
      pay = await db.prepare('SELECT * FROM payments WHERE id=?').get(info.lastInsertRowid);
    } else if (pay.status === 'claimed') {
      await db.prepare(`UPDATE payments SET status='confirmed' WHERE id=?`).run(pay.id);
    }
    if (['awaiting_rest', 'rest_overdue'].includes(b.status)) {
      await db.prepare(`UPDATE bookings SET status='awaiting_final_delivery' WHERE id=?`).run(b.id);
      await addBookingEvent(b.id, 'rest_received', 'تأكد قبض المنفذ للباقي — الخطوة الجاية: تسليم النسخة النهائية');
      await notify(b.talent_id, 'booking', `حجز #${b.id}: ✅ اتأكد قبضك للباقي — سلّم النسخة النهائية دلوقتي من صفحة الحجز`, `booking:${b.id}`);
      if (b.client_id) await notify(b.client_id, 'booking', `حجز #${b.id}: اتأكد قبض المنفذ للباقي — النسخة النهائية في طريقها ليك`, `booking:${b.id}`);
      b = await getBooking(b.id);
    }
  } else if (ob.status === 'rejected') {
    if (pay && pay.status === 'claimed') {
      await db.prepare(`UPDATE payments SET status='rejected' WHERE id=?`).run(pay.id);
      if (b.client_id) await notify(b.client_id, 'booking', `حجز #${b.id}: تحويلة الباقي لم تُقبَل — راجع المرجع والمبلغ بالبصمة وحوّل من جديد للمنفذ`, `booking:${b.id}`);
    }
  }
  return await getBooking(bookingId);
}
/* اكتمال الحجز في النموذج المباشر: قبض باقٍ مؤكد + نسخة نهائية مُسلَّمة +
   استلام نهائي مؤكد (أو مُعتبَر بالسكوت عبر المسح) — فتُختم الصفقة وتُزامَن
   شارات المنفذ. لا مال عند المنصة في أي خطوة من هذه. */
async function tryCompleteFinal(b) {
  if (!b || ['completed', 'cancelled', 'disputed'].includes(b.status)) return b;
  const ob = await finalObligation(b.id);
  if (!ob || !['confirmed', 'auto_confirmed'].includes(ob.status)) return b;
  if (!(b.final_delivered_at > 0) || !(b.final_confirmed_at > 0)) return b;
  await db.prepare(`UPDATE bookings SET status='completed', completed_at=? WHERE id=?`).run(now(), b.id);
  await addBookingEvent(b.id, 'completed', 'اكتملت الصفقة — الباقي اتقبض والنسخة النهائية اتسلمت واتأكد استلامها');
  const nb = await getBooking(b.id);
  const rest = bookingLegAmounts(nb).rest;
  await notify(nb.talent_id, 'booking', `حجز #${nb.id}: 🎉 اكتملت الصفقة — قبضت باقيك ${rest} ${nb.currency} والنسخة النهائية اتسلمت`, `booking:${nb.id}`);
  if (nb.client_id) await notify(nb.client_id, 'booking', `حجز #${nb.id}: 🎉 اكتملت الصفقة — النسخة النهائية عندك والباقي اتقبض`, `booking:${nb.id}`);
  await notifyOwner('booking', `حجز #${nb.id}: اكتملت صفقة (باقٍ مباشر ${rest} ${nb.currency} بين الطرفين — بلا أي مال عند المنصة)`, `booking:${nb.id}`);
  await syncBadges(nb.talent_id);
  return nb;
}
/* نسبة إتمام العميل (الطرف الدافع): اكتماله كعميل يُضرب بإلغاءات خطئه
   و«المستحقات المتأخرة» — تظهر في ملفه العام كما تظهر نسبة المنفذ. */
async function clientStats(userId) {
  const r = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM bookings WHERE client_id=? AND status='completed') AS completed,
      (SELECT COUNT(*) FROM bookings WHERE client_id=? AND status='cancelled' AND cancel_fault='client') AS fault_cancelled,
      (SELECT COUNT(*) FROM bookings WHERE client_id=? AND status='rest_overdue') AS overdue
  `).get(userId, userId, userId);
  const completed = r.completed || 0, denom = completed + (r.fault_cancelled || 0) + (r.overdue || 0);
  return { client_completed: completed, client_overdue: r.overdue || 0, client_completion_rate: denom ? Math.round((completed / denom) * 100) : null };
}

/* ---------------- حزمة الأدلة (تُولَّد تلقائياً عند أي نزاع) ----------------
   تجمع كل ما يثبت الصفقة من سجلات الخادم نفسها: بيانات الحجز وأطرافه ومراحله
   بتواريخ الخادم وروابط إثبات التنفيذ ومراجع كل التحويلات وسجل التزام الدفعة
   الأخيرة — جاهزة لاستخدام المقدم في بلاغات حقوق النشر على المنصات (Deal لا
   يحذف عملاً من منصة أخرى؛ الحزمة هي أداته الرسمية للإثبات) ولأي مراجعة. */
async function buildEvidenceBundle(b) {
  const talent = await getUser(b.talent_id);
  const client = b.client_id ? await getUser(b.client_id) : null;
  const pays = await db.prepare('SELECT kind,amount,ref,status,created_at FROM payments WHERE booking_id=? ORDER BY id ASC').all(b.id);
  const obs = await db.prepare('SELECT code,kind,base_amount,exact_amount,currency,status,transfer_ref,created_at FROM money_obligations WHERE booking_id=? ORDER BY id ASC').all(b.id);
  const finalOb = await finalObligation(b.id);
  const ledger = finalOb ? await db.prepare('SELECT from_status,to_status,actor,note,created_at FROM money_ledger WHERE obligation_id=? ORDER BY id ASC').all(finalOb.id) : [];
  const dispute = await db.prepare('SELECT id,opened_by,reason,status,created_at FROM disputes WHERE booking_id=? ORDER BY id DESC LIMIT 1').get(b.id);
  const appeals = await db.prepare('SELECT id,status,client_note,created_at,decided_at,decision FROM release_appeals WHERE booking_id=? ORDER BY id ASC').all(b.id);
  const chat = await db.prepare('SELECT sender,body,created_at FROM guest_messages WHERE booking_id=? ORDER BY created_at ASC, id ASC').all(b.id);
  const sysEvents = await bookingEvents(b.id, 500);
  const termsAcc = await db.prepare('SELECT side,user_id,version,accepted_at FROM booking_terms_acceptances WHERE booking_id=? ORDER BY accepted_at ASC').all(b.id);
  const fmt = (ts) => (ts ? new Date(ts).toISOString() : null);
  const amounts = bookingLegAmounts(b);
  return {
    bundle: 'Deal — حزمة أدلة حجز (Evidence Bundle)',
    generated_at: fmt(now()),
    booking: { id: b.id, title: b.title, price: b.price, currency: b.currency, status: b.status, source: b.source, created_at: fmt(b.created_at), completed_at: fmt(b.completed_at) },
    parties: {
      client: client ? { id: client.id, name: client.name } : { guest_name: b.guest_name || '' },
      talent: talent ? { id: talent.id, name: talent.name, role: talent.role, niche: talent.niche, city: talent.city } : null,
    },
    amounts: { fee: amounts.fee, deposit: amounts.deposit, final: amounts.rest, net_to_talent: b.price - amounts.fee },
    timeline: [
      { step: 'booking_created', at: fmt(b.created_at) },
      ...(b.fee_confirmed_at ? [{ step: 'fee_confirmed', at: fmt(b.fee_confirmed_at), ref: b.fee_ref }] : []),
      ...(b.proof_at ? [{ step: 'proof_submitted_verified', at: fmt(b.proof_at), url: b.proof_url, check: b.proof_check }] : []),
      ...(b.receipt_confirmed_at ? [{ step: appeals.some((x) => x.status === 'decided_release') ? 'receipt_confirmed_by_owner_appeal_decision' : 'receipt_confirmed_by_client', at: fmt(b.receipt_confirmed_at) }] : []),
      ...appeals.map((x) => ({ step: `release_appeal_${x.status}`, at: fmt(x.decided_at || x.created_at), appeal_id: x.id })),
      ...(b.final_delivered_at ? [{ step: 'final_copy_delivered', at: fmt(b.final_delivered_at) }] : []),
      ...(b.final_confirmed_at ? [{ step: b.final_auto ? 'final_receipt_deemed_confirmed' : 'final_receipt_confirmed_by_client', at: fmt(b.final_confirmed_at) }] : []),
    ],
    payments: pays.map((p) => ({ kind: p.kind, amount: p.amount, ref: p.ref, status: p.status, at: fmt(p.created_at) })),
    obligations: obs.map((o) => ({ code: o.code, kind: o.kind, base_amount: o.base_amount, exact_amount: o.exact_amount, currency: o.currency, status: o.status, transfer_ref: o.transfer_ref, at: fmt(o.created_at) })),
    final_leg: { obligation_code: finalOb ? finalOb.code : null, obligation_status: finalOb ? finalOb.status : null, payee: 'talent_direct', note: 'الباقي يتحوّل من العميل للمنفذ مباشرة — Deal لا تستلم ولا تحتجز أموال المعاملات', final_delivered_at: fmt(b.final_delivered_at), final_confirmed_at: fmt(b.final_confirmed_at), final_auto: !!b.final_auto, ledger: ledger.map((e) => ({ from: e.from_status, to: e.to_status, actor: e.actor, note: e.note, at: fmt(e.created_at) })) },
    proof: b.proof_url ? { url: b.proof_url, server_timestamp: fmt(b.proof_at), check: b.proof_check } : null,
    dispute: dispute ? { id: dispute.id, reason: dispute.reason, status: dispute.status, opened_at: fmt(dispute.created_at) } : null,
    appeals: appeals.map((x) => ({ id: x.id, status: x.status, client_note: x.client_note || '', created_at: fmt(x.created_at), decided_at: fmt(x.decided_at), decision: x.decision || '' })),
    chat: [...chat.map((m) => ({ sender: m.sender, body: m.body, at: fmt(m.created_at) })),
      ...sysEvents.map((e) => ({ sender: 'system', kind: e.kind, body: e.body, at: fmt(e.created_at) }))].sort((x, y) => String(x.at || '').localeCompare(String(y.at || ''))),
    terms_acceptances: termsAcc.map((x) => ({ side: x.side, user_id: x.user_id, version: x.version, accepted_at: fmt(x.accepted_at) })),
    deemed: b.deemed_at ? { deemed_confirmed_at: fmt(b.deemed_at), rule: 'سكوت العميل ٣ ساعات بعد إثبات سليم وباقٍ محتجَز = استلام مُعتبَر (قاعدة باينانس)' } : null,
    statement: 'هذه الحزمة مُولَّدة آلياً من سجلات منصة Deal المختومة بوقت الخادم، وتثبت أن العمل المنشور على رابط الإثبات نُفّذ ضمن حجز مدفوع المراحل على المنصة — صالحة للاستخدام في بلاغات حقوق النشر لدى المنصات.',
  };
}

/* تفعيل اشتراك نجم معلّق بسبب التزام (تأكيد تلقائي أو قرار مالك) — نفس شروط
   التفعيل اليدوي القائمة: 30 يوماً من لحظة القرار، وإشعار للمشترك. */
async function activateStarSubForObligation(ob, decidedBy) {
  let sub = null;
  if (ob.id) {
    sub = await db.prepare(`SELECT * FROM star_subscriptions WHERE obligation_id=? AND status='pending' ORDER BY id DESC LIMIT 1`).get(ob.id);
  }
  if (!sub && ob.user_id) {
    sub = await db.prepare(`SELECT * FROM star_subscriptions WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1`).get(ob.user_id);
  }
  if (!sub) return null;
  const t = now();
  await db.prepare(`UPDATE star_subscriptions SET status='active', decided_at=?, decided_by=?, activated_at=?, expires_at=?, obligation_id=? WHERE id=?`)
    .run(t, decidedBy ?? null, t, t + STAR_DURATION_MS, ob.id, sub.id);
  await notify(sub.user_id, 'star_active', '⭐ مبروك! اتفعّل اشتراكك في «نجم Deal» — مزاياك شغالة من دلوقتي ولمدة 30 يوم', 'star');
  return await db.prepare('SELECT * FROM star_subscriptions WHERE id=?').get(sub.id);
}
/* أثر التأكيد على العمل بحسب نوع الالتزام — يُستدعى بعد auto_confirmed/confirmed. */
async function applyObligationEffect(ob, actor) {
  if (ob.is_difference && ob.parent_obligation_id) {
    /* تأكيد التزام «إكمال الفرق» = اكتمال الرجل الأصلية: الأصل (المُدّعى بالمبلغ
       الناقص) يُختم «confirmed» بنفس عامل التأكيد ثم يُطبَّق أثره الطبيعي. */
    const parent = await getObligation(ob.parent_obligation_id);
    if (parent && parent.status === 'claimed') {
      const confirmed = await setObligationStatus(parent, 'confirmed', actor, `اكتملت الرجل: وصل إكمال الفرق عبر الالتزام ${ob.code}`);
      await applyObligationEffect(confirmed, actor);
    }
    return;
  }
  if (ob.kind === 'star_subscription') {
    await activateStarSubForObligation(ob, actor === 'owner' ? (await db.prepare('SELECT id FROM users WHERE is_platform_founder=1').get() || {}).id : null);
  } else if (ob.kind === 'booking_commission') {
    const b = await getBooking(ob.booking_id);
    if (b && b.fee_status !== 'confirmed' && b.status === 'awaiting_fee') {
      await applyClientPayment(b, 'fee', ob.transfer_ref || `AUTO-${ob.code}`);
    }
  } else if (ob.kind === 'booking_final') {
    // تأكيد التزام الدفعة الأخيرة (إيصال مطابق على رقم المنفذ أو «وصلني» منه)
    // = الباقي اتقبض فعلاً بين الطرفين → خطوة التسليم النهائي تُفتح.
    await syncFinalLeg(ob.booking_id);
  }
}

/* ---------------- تخصيص البروفايل: لوحة ألوان التمييز المنسّقة ----------------
   ثمانية ألوان فاخرة يختار منها العضو مفتاحاً واحداً؛ اللون نفسه يُشتق من
   المفتاح هنا وفي الواجهة من نفس القائمة، فلا لون حراً يخرج عن الهوية.
   المؤسس مستثنى: هويته الفحمية/الذهبية ثابتة ولا لون له. */
const ACCENTS = {
  gold: '#c9a227', emerald: '#0e9f6e', sapphire: '#2b5fd9', ruby: '#c2255c',
  violet: '#7048c9', teal: '#1098ad', copper: '#e8720c', rose: '#d6336c',
};
const ACCENT_KEYS = Object.keys(ACCENTS);

/* ---------------- الصداقة (طلبات صداقة مقبولة = بوابة المراسلة) ----------------
   حالة العلاقة بين عضوين من سجل واحد في أي اتجاه:
   none | pending_out (أنا أرسلت) | pending_in (وصلني) | friends | declined. */
async function friendshipRow(a, b) {
  return await db.prepare('SELECT * FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)')
    .get(a, b, b, a) || null;
}
async function friendState(viewerId, userId) {
  if (!viewerId || viewerId === userId) return 'self';
  const r = await friendshipRow(viewerId, userId);
  if (!r) return 'none';
  if (r.status === 'accepted') return 'friends';
  if (r.status === 'pending') return r.requester_id === viewerId ? 'pending_out' : 'pending_in';
  return 'declined';
}
async function areFriends(a, b) {
  const r = await friendshipRow(a, b);
  return !!r && r.status === 'accepted';
}

async function publicUser(u, viewerId = null) {
  if (!u) return null;
  const stats = await talentStats(u.id);
  const founder = !!u.is_platform_founder;
  const earnedBadges = (await computeBadges(u.id)).filter(b => b.earned);
  // حساب المؤسس عرض فقط: بلا سعر وبلا معرض أعمال وبلا أي وسيلة تواصل في أي رد عام.
  // (contact/phone لا يخرجان من publicUser أصلاً لأي مستخدم — والمؤسس تحديداً لا
  // يظهر سعره ولا أعماله، وسعره يُحجب حتى عن الحقول الرقمية.)
  const out = {
    id: u.id, name: u.name, role: u.role, niche: u.niche,
    provider_category: u.provider_category, provider_custom: u.provider_custom || '', city: u.city, country: u.country,
    currency: u.currency, followers: u.followers,
    price: founder ? null : u.price,
    bio: founder ? '' : u.bio,
    avatar: founder ? '' : (u.avatar || ''),
    is_platform_founder: founder,
    is_founder_member: !!u.is_founder_member,
    // مقعد المؤسس المرقّم (١–١٠٠ بالأسبقية العالمية): المؤسس صاحب المنصة بلا
    // مقعد — ختمه «مؤسس Deal» منفصل تماماً عن فئة الأعضاء المؤسسين.
    founder_seat: founder ? null : (u.founder_seat ?? null),
    // غلاف شخصي + لون تمييز من اللوحة المنسّقة — المؤسس بهوية ثابتة بلا كليهما.
    cover: founder ? '' : (u.cover || ''),
    accent: founder ? '' : (u.accent || ''),
    // سفير المدينة (نقطة تحصيل محلية بتعيين المالك): نطاقه العلني فقط (مدينة/
    // دولة) — رقم تحصيله لا يخرج هنا أبداً؛ يظهر للدافع وحده داخل خطوة دفع
    // التزام واقع في نطاقه. المؤسس بلا سفارة (لا يُعيَّن ولا يدخل نطاق أحد).
    ambassador_scope: founder ? null : await activeAmbassadorScopeOf(u.id),
    verified: !!u.verified, pioneer: !!u.pioneer,
    // باقة «نجم Deal»: لا تظهر إلا لاشتراك نشط فعلياً (مؤكد وغير منتهٍ) — المؤسس
    // لا يشترك أصلاً فتبقى false له دائماً. star_of_week لنجم الأسبوع الحالي وحده.
    is_star: founder ? false : await isStar(u.id),
    star_of_week: founder ? false : (await weekStarUserId()) === u.id,
    featured: (u.featured_until || 0) > now(),
    boost_active: u.boost_until > now() && u.penalty_level !== 'suspended',
    member_since: u.created_at,
    completion_rate: stats.completion_rate,
    completed_deals: stats.completed_deals,
    // نسبة إتمام العميل (كدافع): تظهر لأصحاب المحلات/البراندات في ملفاتهم.
    ...(await clientStats(u.id)),
    // عدّاد «صفقات موثقة عبر Deal»: من الحجوزات المكتملة فعلياً في السجلات فقط.
    verified_deals: stats.completed_deals,
    positive_pct: stats.positive_pct,
    avg_stars: stats.avg_stars,
    badges: earnedBadges.slice(0, 3).map(b => b.key),
    // أعلى شارة مكتسبة (أول محصّلة بترتيب تعريف الشارات) تقود لمسة البروفايل البصرية.
    top_badge: earnedBadges.length ? { key: earnedBadges[0].key, color: earnedBadges[0].color } : null,
    // حالة الصداقة مع المشاهد المسجل (لبناء أزرار مراسلة/صداقة صادقة في الواجهة).
    friend_state: viewerId && viewerId !== u.id ? await friendState(viewerId, u.id) : (viewerId === u.id ? 'self' : 'none'),
    portfolio: founder ? [] : await portfolioOf(u.id),
    frozen: !!u.frozen, penalty_level: u.penalty_level,
    // متابِعو Deal (من جدول follows) — مختلف عن followers (متابعو حساباته الخارجية).
    // يظهر للمؤسس أيضاً (عدّاد متابِعيه جزء من ملفه)، وis_following خاص بالمشاهد المسجل.
    followers_count: await followersCount(u.id),
    is_following: await isFollowing(viewerId, u.id),
    // «متاح اليوم» لمقدمي الخدمة/الصناع (يضبطه صاحبه من لوحته) — المؤسس عرضه فقط.
    available_today: founder ? false : !!u.available_today,
  };
  // مدينة المؤسس ودولته (وعملته المشتقة منها) غير ظاهرة للعامة (طلب المالك
  // الصريح): تُحذف من كل رد عام (الدليل، الملف العام، أطراف الحجوزات...) —
  // وتبقى له وحده عندما يكون المشاهد هو نفسه، وهو ما يحدث في /api/me
  // ولوحته وتعديل ملفه فقط.
  if (founder && viewerId !== u.id) { delete out.city; delete out.country; delete out.currency; }
  return out;
}

async function portfolioOf(userId) {
  return (await db.prepare(`SELECT proof_url FROM bookings WHERE talent_id=? AND status='completed' AND proof_url!='' ORDER BY completed_at DESC LIMIT 12`)
    .all(userId)).map(r => r.proof_url);
}

async function talentStats(userId) {
  // استعلام واحد مجمّع (لقطة متّسقة واحدة من القاعدة) بدل ثلاثة استعلامات منفصلة
  // كانت تُقرأ في لحظات مختلفة فتتذبذب القيم (نسبة الإتمام 100 ثم 0) بين تحميلين.
  const r = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM bookings WHERE talent_id=? AND status NOT IN ('cancelled')) AS total,
      (SELECT COUNT(*) FROM bookings WHERE talent_id=? AND status='completed') AS completed,
      (SELECT COUNT(*) FROM bookings WHERE talent_id=? AND status='cancelled' AND cancel_fault='talent') AS fault_cancelled,
      (SELECT COUNT(*) FROM reviews WHERE reviewee_id=?) AS rc,
      (SELECT COALESCE(SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END),0) FROM reviews WHERE reviewee_id=?) AS pos,
      (SELECT AVG(stars) FROM reviews WHERE reviewee_id=?) AS avg_s
  `).get(userId, userId, userId, userId, userId, userId);
  const total = r.total || 0, completed = r.completed || 0, rc = r.rc || 0;
  const faultCancelled = r.fault_cancelled || 0;
  /* «نسبة إتمام الصفقات» بأسلوب ملفات متداولي باينانس (جولة المحاذاة الحرفية):
     مكتملة ÷ (مكتملة + ملغية بخطأ المنفذ نفسه بحكم مالك/تحكيم) — فلا تُعاقَب
     على إلغاءات العملاء ولا الإلغاءات التلقائية بانتهاء مهلة دفع العميل.
     بلا أي سجل (المقام صفر) النسبة null — الواجهة تعرض «جديد» بدل رقم مضلّل. */
  const rateDenom = completed + faultCancelled;
  return {
    total_deals: total,
    completed_deals: completed,
    fault_cancelled: faultCancelled,
    completion_rate: rateDenom ? Math.round((completed / rateDenom) * 100) : null,
    positive_pct: rc ? Math.round(((r.pos || 0) / rc) * 100) : null,
    avg_stars: r.avg_s ? Math.round(r.avg_s * 10) / 10 : null,
    reviews_count: rc,
  };
}

/* ---------------- badges (computed from the record) ---------------- */
const BADGE_DEFS = [
  { key: 'perfect',   name: 'إتمام مثالي',   color: '#0e9f6e' },
  { key: 'top_rated', name: 'الأعلى تقييماً', color: '#d4a017' },
  { key: 'fast',      name: 'تنفيذ سريع',     color: '#e8720c' },
  { key: 'rising',    name: 'صانع صاعد',      color: '#2f9e44' },
  { key: 'ambassador',name: 'سفير Deal',      color: '#7048c9' },
  { key: 'veteran',   name: 'مخضرم',          color: '#1098ad' },
];
/* مدخلات الشارات الخام من السجلات — مصدر الحقيقة الوحيد: computeBadges يبني
   منها قرار التحصيل، ومسار /api/me/badges-progress يبني منها أرقام التقدم،
   فلا توجد قواعد موازية يمكن أن تختلف عن المحرك الفعلي. */
async function badgeMetrics(userId) {
  const u = await getUser(userId);
  const s = await talentStats(userId);
  const lastProofs = await db.prepare(`SELECT proof_at, deadline FROM bookings WHERE talent_id=? AND status='completed' AND proof_at>0 ORDER BY completed_at DESC LIMIT 5`).all(userId);
  const onTimeCount = lastProofs.filter(p => !p.deadline || p.proof_at <= p.deadline).length;
  const invitedDone = await verifiedReferralCount(userId); // إحالات موثقة عبر رابط الملف — تُحتسب بعد توثيق المسجَّل
  const ageMs = now() - u.created_at;
  return { s, lastProofs, onTimeCount, invitedDone, ageMs };
}
async function computeBadges(userId) {
  const { s, lastProofs, invitedDone, ageMs } = await badgeMetrics(userId);
  const onTime = lastProofs.length === 5 && lastProofs.every(p => !p.deadline || p.proof_at <= p.deadline);
  const defs = {
    perfect:    { earned: s.completed_deals >= 10 && s.completion_rate === 100, progress: `${Math.min(s.completed_deals,10)}/10 صفقات بإتمام 100%` },
    top_rated:  { earned: s.reviews_count >= 10 && s.positive_pct >= 95, progress: `${Math.min(s.reviews_count,10)}/10 تقييمات بإيجابية 95%+` },
    fast:       { earned: onTime, progress: `${lastProofs.filter(p => !p.deadline || p.proof_at <= p.deadline).length}/5 إثباتات قبل المهلة` },
    rising:     { earned: s.completed_deals >= 5, progress: `${Math.min(s.completed_deals,5)}/5 صفقات` },
    ambassador: { earned: invitedDone >= REFERRAL_AMBASSADOR_TARGET, progress: `${Math.min(invitedDone, REFERRAL_AMBASSADOR_TARGET)}/${REFERRAL_AMBASSADOR_TARGET} صناع موثّقين سجلوا من رابطك` },
    veteran:    { earned: ageMs >= 180 * 24 * 3600 * 1000 && s.completed_deals >= 20, progress: `${Math.min(s.completed_deals,20)}/20 صفقة + 6 أشهر عضوية` },
  };
  return BADGE_DEFS.map(d => ({ ...d, ...defs[d.key] }));
}
async function syncBadges(userId) {
  if (!userId || !(await getUser(userId))) return; // ضيف بلا حساب — لا شارات
  const badges = await computeBadges(userId);
  for (const b of badges) {
    const row = await db.prepare('SELECT earned FROM badge_state WHERE user_id=? AND badge_key=?').get(userId, b.key);
    const prev = row ? row.earned : 0;
    if (b.earned && !prev) await notify(userId, 'badge', `شارة جديدة: ${b.name}`, `badge:${b.key}`);
    if (!b.earned && prev) await notify(userId, 'badge_lost', `سُحبت شارة: ${b.name}`, `badge:${b.key}`);
    await db.prepare('INSERT INTO badge_state (user_id,badge_key,earned) VALUES (?,?,?) ON CONFLICT(user_id,badge_key) DO UPDATE SET earned=excluded.earned')
      .run(userId, b.key, b.earned ? 1 : 0);
  }
}

/* ---------------- penalties (automatic, graduated) ---------------- */
async function applyPenalties(userId) {
  if (!userId || !(await getUser(userId))) return; // ضيف بلا حساب — لا عقوبات
  const neg = (await db.prepare(`SELECT COUNT(*) c FROM reviews WHERE reviewee_id=? AND sentiment='negative'`).get(userId)).c;
  const frauds = (await db.prepare(`SELECT COUNT(*) c FROM money_obligations WHERE payer_user_id=? AND fraud_flag=1`).get(userId)).c;
  const u = await getUser(userId);
  let level = 'none';
  if (neg >= 5 || frauds >= FRAUD_SUSPEND_AT) level = 'suspended'; else if (neg >= 3 || frauds >= 1) level = 'warning';
  if (level !== u.penalty_level && !u.banned) {
    const frozen = level === 'suspended' ? 1 : u.frozen;
    await db.prepare('UPDATE users SET penalty_level=?, frozen=? WHERE id=?').run(level, frozen, userId);
    if (level === 'warning') await notify(userId, 'penalty', 'تنبيه: تراكمت لديك 3 تقييمات سلبية', '');
    if (level === 'suspended') await notify(userId, 'penalty', 'تم تعليق حسابك وتجميد رصيدك داخل المنصة بسبب 5 تقييمات سلبية', '');
  }
}

/* صرامة باينانس: إعلان «حوّلت» كاذب (مطالبة بلا تحويل فعلي — يثبت بمطابقة
   الإيصال/المرجع آلياً أو بقرار رفض المالك) يدخل سلم العقوبات المتدرج القائم
   نفسه: أول مرة تنبيه رسمي، والثانية تعليق وتجميد، والحظر النهائي قرار
   المالك من لوحته (احتيال) كما هو قائم. العدد يُحتسب من الالتزامات الموسومة
   بعلم الاحتيال للمستخدم نفسه — فلا سجل موازٍ جديد، وكل خطوة في money_ledger. */
async function applyFraudPenalty(userId) {
  if (!userId) return; // ضيف بلا حساب — الرفض الموثّق يكفي
  const u = await getUser(userId);
  if (!u || u.banned) return;
  const n = (await db.prepare(`SELECT COUNT(*) c FROM money_obligations WHERE payer_user_id=? AND fraud_flag=1`).get(userId)).c;
  /* عتبة باينانس المضبوطة لهذا النوع تحديداً (جولة المحاذاة الحرفية): ٣ مطالبات
     دفع كاذبة مثبتة = إيقاف وظائف الحجز (suspended + تجميد)؛ قبلها تنبيه رسمي
     متصاعد (الأولى تنبيه، والثانية تنبيه أخير صريح بأن الثالثة إيقاف). باقي
     سلم العقوبات (التقييمات السلبية) كما هو بلا أي تغيير. */
  if (n >= FRAUD_SUSPEND_AT && u.penalty_level !== 'suspended') {
    await db.prepare('UPDATE users SET penalty_level=?, frozen=1 WHERE id=?').run('suspended', userId);
    await notify(userId, 'penalty', 'تم تعليق حسابك وتجميد رصيدك داخل المنصة: ٣ إعلانات دفع كاذبة مثبتة (مطالبات بلا تحويل فعلي) — قاعدة باينانس. تواصل مع الدعم لو فيه خطأ', '');
    await notifyOwner('penalty', `⛔ تعليق تلقائي بسلم العقوبات: المستخدم #${userId} وصل لحد باينانس — ${n} إعلانات دفع كاذبة مثبتة`, `user:${userId}`);
  } else if (n >= 1 && u.penalty_level === 'none') {
    await db.prepare('UPDATE users SET penalty_level=? WHERE id=?').run('warning', userId);
    await notify(userId, 'penalty', 'تنبيه رسمي: سُجّل عليك إعلان دفع كاذب (مطالبة بلا تحويل فعلي). عند ٣ مطالبات كاذبة مثبتة يُعلَّق حسابك وتُجمَّد وظائف الحجز — قاعدة باينانس', '');
    await notifyOwner('penalty', `⚠️ تنبيه بسلم العقوبات: المستخدم #${userId} أعلن دفعاً كاذباً (مرة ${n} من ${FRAUD_SUSPEND_AT})`, `user:${userId}`);
  } else if (n === FRAUD_SUSPEND_AT - 1 && u.penalty_level === 'warning') {
    await notify(userId, 'penalty', 'تنبيه أخير: سُجّلت عليك مطالبة دفع كاذبة ثانية مثبتة — المطالبة الكاذبة التالية (الثالثة) تُعلّق حسابك وتجمّد وظائف الحجز فوراً', '');
    await notifyOwner('penalty', `⚠️ تنبيه أخير بسلم العقوبات: المستخدم #${userId} عنده مطالبتان كاذبتان مثبتتان — الثالثة إيقاف`, `user:${userId}`);
  }
}

/* ---------------- auth ---------------- */
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = token && await db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s) return res.status(401).json({ error: 'سجل الدخول أولاً' });
  req.user = await getUser(s.user_id);
  if (!req.user) return res.status(401).json({ error: 'حساب غير موجود' });
  if (req.user.deleted_at) return res.status(403).json({ error: 'هذا الحساب محذوف' });
  if (req.user.banned) return res.status(403).json({ error: 'هذا الحساب محظور' });
  next();
}
async function makeSession(userId) {
  const token = rnd(24);
  await db.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').run(token, userId, now());
  return token;
}

const TOS_VERSION = 'deal-tos-v1'; // إصدار «شروط الاستخدام» — يُسجَّل قبولها عند التسجيل
app.post('/api/auth/register', async (req, res) => {
  /* قبول الشروط شرط تسجيل (الحزمة القانونية): بلا قبول صريح لشروط الاستخدام
     وتأكيد سن ١٨+ يُرفض التسجيل خادمياً؛ القبول يُسجَّل بالإصدار والوقت. */
  if ((req.body || {}).tos_accepted !== true) return res.status(400).json({ error: 'لازم توافق على شروط الاستخدام الأول عشان تسجل', tos_required: true, tos_version: TOS_VERSION });
  if ((req.body || {}).age_confirmed !== true) return res.status(400).json({ error: 'التسجيل لمن هم ١٨ سنة أو أكثر فقط — أكّد سنك', age_required: true });
  const { name, role, niche = '', provider_category = null, provider_custom = '', city = '', followers = 0, price = 0, bio = '', links = '' } = req.body || {};
  // الدولة من القائمة المدعومة فقط (افتراضي مصر)، والعملة تُشتق منها خادمياً
  // — لا تُقبل عملة من العميل أبداً حتى لا ينفصل السعر عن بلد صاحبه.
  const countryDef = countryOf((req.body || {}).country || 'EG');
  if (!countryDef) return res.status(400).json({ error: 'دولة غير مدعومة حالياً' });
  const country = countryDef.code, currency = countryDef.currency;
  // تسجيل واحد فقط لكل شخص: وسيلة التواصل تُطبَّع قبل أي فحص أو حفظ،
  // فلا يفلت تسجيل مكرر بتغيير صيغة الرقم (+20 مقابل 0) أو حالة حروف الإيميل.
  // الهاتف يُطبَّع بقاعدة دولة التسجيل نفسها (مصر بصيغتها المحلية القائمة،
  // وغيرها بالصيغة الدولية الكاملة) — ورقم لا يطابق قاعدة دولته يُرفض صراحة.
  const rawContact = String((req.body && req.body.contact) || '').trim();
  let contact;
  if (rawContact.includes('@')) contact = normalizeContact(rawContact);
  else {
    contact = normalizePhoneForCountry(rawContact, country);
    if (!contact) return res.status(400).json({ error: phoneErrorFor(countryDef) });
  }
  const rawPhone = String((req.body && req.body.phone) || '').trim();
  const phone = (rawPhone && !rawPhone.includes('@') ? normalizePhoneForCountry(rawPhone, country) : null) || contact;
  if (!name || !role || !contact) return res.status(400).json({ error: 'الاسم والدور ووسيلة التواصل مطلوبة' });
  if (!['creator', 'provider', 'shop', 'brand'].includes(role)) return res.status(400).json({ error: 'دور غير صحيح' });
  if (role === 'provider') {
    // أي خدمة يحتاجها السوق: من القائمة الموحّدة، أو «أخرى» بنص حر إلزامي يظهر كما كتبه.
    if (![...SERVICE_KEYS, 'other'].includes(provider_category)) return res.status(400).json({ error: 'اختر خدمتك من القائمة' });
    if (provider_category === 'other' && !String(provider_custom || '').trim()) return res.status(400).json({ error: 'اكتب خدمتك كما تريد أن تظهر في ملفك' });
  }
  if (await db.prepare('SELECT id FROM users WHERE contact=?').get(contact)) return res.status(409).json({ error: 'وسيلة التواصل مسجلة من قبل — سجل الدخول' });

  /* إحالة رابط الملف (#/u/<id>): تُقبل فقط إن كان المُحيل موجوداً وليس الشخص
     نفسه — المقارنة بالتواصل المطبّع حتى لا يلتف أحد بصيغة أخرى لنفس الرقم.
     المؤسس مُحيل مشروع (رابطه يوزّع المنصة). أي رمز غير صالح يُتجاهل بصمت
     ولا يعطّل التسجيل أبداً. */
  let referredBy = null;
  const refId = +((req.body || {}).ref) || 0;
  if (refId) {
    const referrer = await getUser(refId);
    if (referrer && normalizeContact(referrer.contact) !== contact) referredBy = referrer.id;
  }

  const totalUsers = (await db.prepare('SELECT COUNT(*) c FROM users').get()).c;
  const creatorsCount = (await db.prepare(`SELECT COUNT(*) c FROM users WHERE role='creator'`).get()).c;
  const isFounder = totalUsers === 0 ? 1 : 0;
  const isFounderMember = role === 'creator' && creatorsCount < 100 ? 1 : 0;
  const info = await db.prepare(`INSERT INTO users (name,role,niche,provider_category,provider_custom,city,country,currency,contact,phone,followers,price,bio,links,is_platform_founder,is_founder_member,referred_by,created_at,tos_version,tos_accepted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, role, niche, provider_category, role === 'provider' ? String(provider_custom || '').trim() : '', city, country, currency, contact, phone, followers, price, bio, links, isFounder, isFounderMember, referredBy, now(), TOS_VERSION, now());
  /* مقعد المؤسس المرقّم: يُسنَد فوراً عند التسجيل برقم = ترتيب هذا العضو بين
     المؤهلين (صناع/مقدمون، بلا صاحب المنصة) — أول ١٠٠ فقط، والرقم لا يتغير
     أبداً بعد إسناده (نفس قاعدة الإسناد الرجعي في ترحيلات db.js). */
  if (!isFounder && ['creator', 'provider'].includes(role)) {
    const newId = info.lastInsertRowid;
    const rank = (await db.prepare(`SELECT COUNT(*) c FROM users WHERE role IN ('creator','provider') AND is_platform_founder=0 AND id<=?`).get(newId)).c;
    if (rank >= 1 && rank <= 100) {
      await db.prepare('UPDATE users SET founder_seat=? WHERE id=? AND founder_seat IS NULL').run(rank, newId);
    }
  }
  const user = await getUser(info.lastInsertRowid);
  if (referredBy) await notify(referredBy, 'referral', `سجّل ${user.name} من رابط ملفك على Deal`, `user:${user.id}`);
  res.json({ token: await makeSession(user.id), user: await publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const rawLogin = String((req.body && req.body.contact) || '').trim();
  const contact = normalizeContact(rawLogin);
  let user = contact && await db.prepare('SELECT * FROM users WHERE contact=?').get(contact);
  // دخول برقم هاتف بأي صيغة: من سجّل برقم دولي (مثل +966…) قد يكتب رقمه
  // بالصيغة المحلية عند الدخول — نجرّب تطبيع كل دولة مدعومة حتى نجد حسابه،
  // فلا يُقفل أحد خارج حسابه بسبب صيغة كتابة.
  if (!user && rawLogin && !rawLogin.includes('@')) {
    for (const c of COUNTRIES) {
      const cand = normalizePhoneForCountry(rawLogin, c.code);
      if (cand && cand !== contact) {
        user = await db.prepare('SELECT * FROM users WHERE contact=?').get(cand);
        if (user) break;
      }
    }
  }
  if (!user) return res.status(404).json({ error: 'لا يوجد حساب بهذه البيانات — سجل أولاً' });
  if (user.banned) return res.status(403).json({ error: 'هذا الحساب محظور' });
  res.json({ token: await makeSession(user.id), user: await publicUser(user) });
});

app.get('/api/me', auth, async (req, res) => {
  await syncBadges(req.user.id);
  const user = await publicUser(req.user, req.user.id);
  // بيانات التواصل الخاصة تظهر لصاحب الحساب نفسه فقط (لتعبئة نموذج تعديل ملفه) —
  // ولا تخرج في الدليل أو ملف أي مستخدم آخر، والمؤسس تحديداً لا يراها أحد غيره.
  user.contact = req.user.contact;
  user.phone = req.user.phone || '';
  user.links = req.user.links || '';
  res.json({ user, verify_status: req.user.verify_status, verify_code: req.user.verify_code });
});

/* ---------------- ملفي الشخصي: تعديل + صورة + نماذج شورتس ---------------- */
const AVATAR_MAX_BYTES = 200 * 1024;
const COVER_MAX_BYTES = 400 * 1024; // الغلاف أعرض من الصورة الرمزية: حدّ أكبر بنفس خط المعالجة
app.patch('/api/me/profile', auth, async (req, res) => {
  const b = req.body || {};
  // قائمة بيضاء صارمة: حقول الملف فقط. أي حقل امتياز (is_platform_founder،
  // verified، pioneer، frozen...) يُتجاهل تماماً فلا طريق لتفعيل شكل المؤسس.
  const sets = [], args = [];
  const setStr = (col, val, max = 300) => { if (val !== undefined) { sets.push(`${col}=?`); args.push(String(val).slice(0, max)); } };
  if (b.name !== undefined) {
    if (!String(b.name).trim()) return res.status(400).json({ error: 'الاسم لا يمكن أن يكون فارغاً' });
    setStr('name', String(b.name).trim(), 120);
  }
  setStr('niche', b.niche, 120);
  setStr('city', b.city, 120);
  setStr('bio', b.bio, 600);
  setStr('links', b.links, 600);
  if (b.followers !== undefined) {
    const f = +b.followers;
    if (!isFinite(f) || f < 0) return res.status(400).json({ error: 'عدد متابعين غير صحيح' });
    sets.push('followers=?'); args.push(Math.round(f));
  }
  if (b.price !== undefined) {
    const p = +b.price;
    if (!isFinite(p) || p < 0) return res.status(400).json({ error: 'سعر غير صحيح' });
    sets.push('price=?'); args.push(p);
  }
  if (b.phone !== undefined) {
    const ph = String(b.phone).trim();
    if (ph) {
      // الهاتف يُتحقق ويُطبَّع بقاعدة دولة صاحب الحساب نفسه (مصر بصيغتها
      // المحلية القائمة، وغيرها بالصيغة الدولية الكاملة).
      const norm = normalizePhoneForCountry(ph, req.user.country || 'EG');
      if (!norm) return res.status(400).json({ error: profilePhoneError(req.user.country || 'EG') });
      sets.push('phone=?'); args.push(norm);
    } else { sets.push('phone=?'); args.push(''); }
  }
  if (b.avatar !== undefined) {
    const av = String(b.avatar || '');
    if (av) {
      const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(av);
      if (!m) return res.status(400).json({ error: 'صورة غير صالحة — أرسل صورة JPEG/PNG كـ data URL' });
      const bytes = Buffer.from(m[2], 'base64').length;
      if (bytes > AVATAR_MAX_BYTES) return res.status(400).json({ error: 'الصورة أكبر من 200KB — صغّرها وحاول مجدداً' });
      sets.push('avatar=?'); args.push(av);
    } else { sets.push('avatar=?'); args.push(''); }
  }
  /* الغلاف الشخصي + لون التمييز: المؤسس بهوية فحمية/ذهبية ثابتة — لا غلاف
     ولا لون له إطلاقاً (نفس قاعدة منعه من الشورتس). الغلاف بنفس خط معالجة
     الصورة الرمزية (data URL مصغّرة من العميل) بحدّ أكبر لأنه أعرض. */
  if (b.cover !== undefined || b.accent !== undefined) {
    if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس بهوية ثابتة — لا غلاف ولا لون تمييز' });
  }
  if (b.cover !== undefined) {
    const cv = String(b.cover || '');
    if (cv) {
      const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(cv);
      if (!m) return res.status(400).json({ error: 'غلاف غير صالح — أرسل صورة JPEG/PNG كـ data URL' });
      const bytes = Buffer.from(m[2], 'base64').length;
      if (bytes > COVER_MAX_BYTES) return res.status(400).json({ error: 'الغلاف أكبر من 400KB — صغّره وحاول مجدداً' });
      sets.push('cover=?'); args.push(cv);
    } else { sets.push('cover=?'); args.push(''); }
  }
  if (b.accent !== undefined) {
    const ac = String(b.accent || '');
    if (ac && !ACCENT_KEYS.includes(ac)) return res.status(400).json({ error: 'لون تمييز غير معروف — اختر من لوحة الألوان' });
    sets.push('accent=?'); args.push(ac);
  }
  // لا حقول قابلة للتعديل في الطلب (مثلاً حقول امتياز متجاهَلة فقط): نعيد المستخدم
  // الحالي كما هو دون تغيير — فلا طريق أبداً لتفعيل أي امتياز عبر هذا المسار.
  if (!sets.length) {
    const cur = await publicUser(req.user, req.user.id);
    cur.contact = req.user.contact; cur.phone = req.user.phone || ''; cur.links = req.user.links || '';
    return res.json({ user: cur });
  }
  await db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...args, req.user.id);
  const fresh = await getUser(req.user.id);
  const user = await publicUser(fresh, fresh.id);
  user.contact = fresh.contact; user.phone = fresh.phone || ''; user.links = fresh.links || '';
  res.json({ user });
});

/* استخراج رابط التضمين الرسمي من رابط فيديو قصير — يوتيوب/تيك توك/إنستجرام/فيسبوك. */
function parseVideoEmbed(raw) {
  const url = String(raw || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  let m;
  if ((m = /(?:youtube\.com\/(?:shorts\/|watch\?v=|embed\/)|youtu\.be\/)([\w-]{6,})/.exec(url))) {
    return { platform: 'youtube', video_id: m[1], embed_url: `https://www.youtube.com/embed/${m[1]}` };
  }
  if ((m = /tiktok\.com\/(?:@[^/]+\/video\/|embed\/v2\/|v\/)(\d{6,})/.exec(url))) {
    return { platform: 'tiktok', video_id: m[1], embed_url: `https://www.tiktok.com/embed/v2/${m[1]}` };
  }
  if ((m = /instagram\.com\/(reel|reels|p)\/([\w-]{5,})/.exec(url))) {
    const kind = m[1] === 'p' ? 'p' : 'reel';
    return { platform: 'instagram', video_id: m[2], embed_url: `https://www.instagram.com/${kind}/${m[2]}/embed` };
  }
  if (/facebook\.com|fb\.watch/.test(url) && /(reel|watch|videos|share\/v)/.test(url)) {
    const idm = /(?:reel\/|videos\/|v=|watch\?v=)(\d{5,})/.exec(url);
    return { platform: 'facebook', video_id: idm ? idm[1] : '', embed_url: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false` };
  }
  return null;
}
const SHORTS_MAX = 3;
async function shortsOf(userId) {
  return await db.prepare('SELECT id,platform,embed_url,title,created_at FROM portfolio_items WHERE user_id=? ORDER BY created_at ASC, id ASC').all(userId);
}
app.get('/api/me/portfolio', auth, async (req, res) => {
  res.json({ items: await shortsOf(req.user.id) });
});
app.post('/api/me/portfolio', auth, async (req, res) => {
  if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس عرض فقط — لا نماذج شورتس' });
  if (req.user.role !== 'creator') return res.status(400).json({ error: 'نماذج الشورتس للصناع فقط' });
  const { url, title = '' } = req.body || {};
  const parsed = parseVideoEmbed(url);
  if (!parsed) return res.status(400).json({ error: 'رابط فيديو غير مدعوم — الصق رابط شورتس من يوتيوب أو فيسبوك أو إنستجرام أو تيك توك' });
  const count = (await db.prepare('SELECT COUNT(*) c FROM portfolio_items WHERE user_id=?').get(req.user.id)).c;
  if (count >= SHORTS_MAX) return res.status(400).json({ error: 'وصلت إلى الحد الأقصى: 3 فيديوهات شورتس — احذف واحداً أولاً' });
  const info = await db.prepare('INSERT INTO portfolio_items (user_id,platform,video_id,embed_url,source_url,title,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(req.user.id, parsed.platform, parsed.video_id, parsed.embed_url, String(url).trim(), String(title || '').slice(0, 120), now());
  res.json({ item: { id: info.lastInsertRowid, platform: parsed.platform, embed_url: parsed.embed_url, title: String(title || '').slice(0, 120) }, items: await shortsOf(req.user.id) });
});
app.delete('/api/me/portfolio/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM portfolio_items WHERE id=? AND user_id=?').run(+req.params.id, req.user.id);
  res.json({ items: await shortsOf(req.user.id) });
});

app.post('/api/me/prefs', auth, async (req, res) => {
  const { min_price_pref, notify_pref } = req.body || {};
  await db.prepare('UPDATE users SET min_price_pref=COALESCE(?,min_price_pref), notify_pref=COALESCE(?,notify_pref) WHERE id=?')
    .run(min_price_pref ?? null, notify_pref ?? null, req.user.id);
  res.json({ ok: true });
});

/* ---------------- توفّر اليوم + مهام اليوم (مهام متعددة بالتوازي) ----------------
   مقدم الخدمة/الصانع يعلن «متاح اليوم» وسعة يومية اختيارية من لوحته، وقائمة
   مهامه تعرض كل حجوزاته النشطة بالتوازي — لا حظر «مهمة نشطة واحدة» في أي
   مكان: السعة إعلان تنظيمي لليوم فقط، لا تقفل قبول أي حجز. */
function nextActionFor(b) {
  if (b.status === 'disputed') return 'disputed';
  if (b.status === 'pending_agreement') return b.agreed_talent ? 'wait_client' : 'agree';
  if (b.status === 'awaiting_fee') return 'wait_fee';
  if (b.status === 'awaiting_deposit') return 'wait_deposit';
  if (b.status === 'in_progress') return 'submit_proof';
  if (b.status === 'proof_submitted') return 'wait_receipt';
  if (b.status === 'awaiting_rest') return 'wait_rest';
  if (b.status === 'awaiting_final_delivery') return 'deliver_final';
  if (b.status === 'final_delivered') return 'wait_final_confirm';
  if (b.status === 'rest_overdue') return 'rest_overdue';
  if (b.status === 'completed') return 'done';
  return 'wait_client';
}
app.post('/api/me/availability', auth, async (req, res) => {
  if (!['creator', 'provider'].includes(req.user.role)) return res.status(400).json({ error: 'إعدادات اليوم للصناع ومقدمي الخدمة فقط' });
  const { available_today, daily_capacity } = req.body || {};
  let cap = req.user.daily_capacity || 0;
  if (daily_capacity !== undefined) {
    cap = Math.floor(+daily_capacity);
    if (!Number.isFinite(cap) || cap < 0 || cap > 50) return res.status(400).json({ error: 'سعة يومية صحيحة مطلوبة (0 = بلا حد، حتى 50)' });
  }
  const avail = available_today === undefined ? (req.user.available_today || 0) : (available_today ? 1 : 0);
  await db.prepare('UPDATE users SET available_today=?, daily_capacity=? WHERE id=?').run(avail, cap, req.user.id);
  res.json({ ok: true, available_today: !!avail, daily_capacity: cap });
});
app.get('/api/me/tasks', auth, async (req, res) => {
  await sweepStepExpiry();
  const u = req.user;
  const rows = await db.prepare(`SELECT * FROM bookings WHERE talent_id=? AND status NOT IN ('cancelled','completed') ORDER BY created_at DESC`).all(u.id);
  const items = [];
  for (const b of rows) {
    items.push({ ...(await bookingView(b, u)), next_action: nextActionFor(b) });
  }
  items.sort((a, b2) => ((b2.urgent ? 1 : 0) - (a.urgent ? 1 : 0)) || (a.created_at - b2.created_at));
  const cap = u.daily_capacity || 0;
  res.json({
    available_today: !!u.available_today,
    daily_capacity: cap,
    active_count: rows.length,
    capacity_left: cap > 0 ? Math.max(0, cap - rows.length) : null,
    items,
  });
});

/* ---------------- المتابعة: متابعة/إلغاء + ملخصي الاجتماعي ----------------
   المتابعة هي الاستثناء الوحيد المسموح على حساب المؤسس (عرض + متابعة فقط):
   زرها يظهر على بطاقته وملفه، وعدّاد متابِعيه يظهر عنده — بينما الحجز والمراسلة
   والتواصل والسعر والشورتس تبقى محظورة عليه كما هي. */
app.post('/api/users/:id/follow', auth, async (req, res) => {
  const target = await getUser(+req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });
  if (target.banned || target.frozen) return res.status(400).json({ error: 'هذا الحساب غير متاح للمتابعة حالياً' });
  // idempotent: التكرار لا يخطئ ولا يضاعف الصف ولا يكرر الإشعار.
  const info = await db.prepare('INSERT INTO follows (follower_id,followee_id,created_at) VALUES (?,?,?) ON CONFLICT(follower_id,followee_id) DO NOTHING')
    .run(req.user.id, target.id, now());
  if (info.changes > 0) await notify(target.id, 'follow', `بدأ ${req.user.name} متابعتك على Deal`, `user:${req.user.id}`);
  res.json({ ok: true, is_following: true, followers_count: await followersCount(target.id) });
});
async function unfollow(req, res) {
  const target = await getUser(+req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  await db.prepare('DELETE FROM follows WHERE follower_id=? AND followee_id=?').run(req.user.id, target.id);
  res.json({ ok: true, is_following: false, followers_count: await followersCount(target.id) });
}
app.post('/api/users/:id/unfollow', auth, unfollow);
app.delete('/api/users/:id/unfollow', auth, unfollow);

app.get('/api/me/social', auth, async (req, res) => {
  const me = req.user.id;
  const followerRows = await db.prepare('SELECT u.* FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followee_id=? ORDER BY f.created_at DESC').all(me);
  const followingRows = await db.prepare('SELECT u.* FROM follows f JOIN users u ON u.id=f.followee_id WHERE f.follower_id=? ORDER BY f.created_at DESC').all(me);
  /* حالة الصداقة تُرفق بكل صف: زر المراسلة في الواجهة يظهر للأصدقاء فقط،
     والخادم يفرض القاعدة نفسها عند الإرسال. */
  const withFriendState = async (rows) => Promise.all(rows.map(async (x) => ({ ...socialSummary(x), friend_state: await friendState(req.user.id, x.id) })));
  res.json({
    followers_count: followerRows.length,
    following_count: followingRows.length,
    followers: await withFriendState(followerRows),
    following: await withFriendState(followingRows),
  });
});

/* ---------------- طلبات الصداقة: إرسال/قبول/رفض/إلغاء + قائمتي ----------------
   الصداقة المقبولة هي بوابة المراسلة عضو↔عضو الوحيدة (قرار المالك). المؤسس
   خارج الصداقة تماماً من الطرفين — طريقه الاجتماعي الوحيد هو المتابعة. */
function friendTargetGuard(req, target) {
  if (!target) return [404, 'غير موجود'];
  if (target.id === req.user.id) return [400, 'لا يمكنك إرسال طلب صداقة لنفسك'];
  if (target.is_platform_founder || req.user.is_platform_founder) {
    return [400, 'حساب المؤسس خارج الصداقة تماماً — متابعته هي طريقه الاجتماعي الوحيد'];
  }
  if (target.banned || target.frozen) return [400, 'هذا الحساب غير متاح حالياً'];
  return null;
}
app.post('/api/users/:id/friend-request', auth, async (req, res) => {
  const target = await getUser(+req.params.id);
  const guard = friendTargetGuard(req, target);
  if (guard) return res.status(guard[0]).json({ error: guard[1] });
  const me = req.user.id;
  const row = await friendshipRow(me, target.id);
  if (row && row.status === 'accepted') return res.json({ ok: true, friend_state: 'friends' });
  if (row && row.status === 'pending' && row.requester_id === me) return res.json({ ok: true, friend_state: 'pending_out' });
  if (row && row.status === 'pending' && row.addressee_id === me) {
    // وصلني طلب منه أصلاً: إرسالي المضاد = قبول مباشر (لا طلبان متقاطعان).
    await db.prepare('UPDATE friendships SET status=?, decided_at=? WHERE id=?').run('accepted', now(), row.id);
    await notify(target.id, 'friend_accepted', `قبل ${req.user.name} طلب صداقتك — بقيتوا أصدقاء على Deal`, `user:${me}`);
    return res.json({ ok: true, friend_state: 'friends' });
  }
  if (row) { // طلب مرفوض سابقاً: إعادة الإرسال مسموحة وتعيد فتح الصف كطلب جديد مني
    await db.prepare('UPDATE friendships SET requester_id=?, addressee_id=?, status=?, created_at=?, decided_at=0 WHERE id=?')
      .run(me, target.id, 'pending', now(), row.id);
  } else {
    await db.prepare('INSERT INTO friendships (requester_id,addressee_id,status,created_at) VALUES (?,?,?,?)')
      .run(me, target.id, 'pending', now());
  }
  await notify(target.id, 'friend_request', `أرسل ${req.user.name} طلب صداقة إليك على Deal`, `user:${me}`);
  res.json({ ok: true, friend_state: 'pending_out' });
});
app.post('/api/users/:id/friend-accept', auth, async (req, res) => {
  const target = await getUser(+req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  if (target.is_platform_founder || req.user.is_platform_founder) {
    return res.status(400).json({ error: 'حساب المؤسس خارج الصداقة تماماً — متابعته هي طريقه الاجتماعي الوحيد' });
  }
  const row = await db.prepare('SELECT * FROM friendships WHERE requester_id=? AND addressee_id=? AND status=?').get(target.id, req.user.id, 'pending');
  if (!row) return res.status(404).json({ error: 'لا يوجد طلب صداقة معلّق من هذا العضو' });
  await db.prepare('UPDATE friendships SET status=?, decided_at=? WHERE id=?').run('accepted', now(), row.id);
  await notify(target.id, 'friend_accepted', `قبل ${req.user.name} طلب صداقتك — بقيتوا أصدقاء على Deal`, `user:${req.user.id}`);
  res.json({ ok: true, friend_state: 'friends' });
});
app.post('/api/users/:id/friend-decline', auth, async (req, res) => {
  const target = await getUser(+req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  const row = await db.prepare('SELECT * FROM friendships WHERE requester_id=? AND addressee_id=? AND status=?').get(target.id, req.user.id, 'pending');
  if (!row) return res.status(404).json({ error: 'لا يوجد طلب صداقة معلّق من هذا العضو' });
  await db.prepare('UPDATE friendships SET status=?, decided_at=? WHERE id=?').run('declined', now(), row.id);
  res.json({ ok: true, friend_state: 'declined' });
});
async function friendRemove(req, res) {
  const target = await getUser(+req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  // إلغاء طلبي المعلّق أو إنهاء صداقة قائمة أو سحب طلب مرفوض — حذف الصف كله.
  await db.prepare('DELETE FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)')
    .run(req.user.id, target.id, target.id, req.user.id);
  res.json({ ok: true, friend_state: 'none' });
}
app.post('/api/users/:id/friend-cancel', auth, friendRemove);
app.delete('/api/users/:id/friend', auth, friendRemove);
app.post('/api/users/:id/unfriend', auth, friendRemove);
app.get('/api/me/friends', auth, async (req, res) => {
  const me = req.user.id;
  const accRows = await db.prepare(`SELECT u.* FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id=? THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id=? OR f.addressee_id=?) AND f.status='accepted' ORDER BY f.decided_at DESC`).all(me, me, me);
  const inRows = await db.prepare(`SELECT u.* FROM friendships f JOIN users u ON u.id=f.requester_id WHERE f.addressee_id=? AND f.status='pending' ORDER BY f.created_at DESC`).all(me);
  const outRows = await db.prepare(`SELECT u.* FROM friendships f JOIN users u ON u.id=f.addressee_id WHERE f.requester_id=? AND f.status='pending' ORDER BY f.created_at DESC`).all(me);
  res.json({
    friends_count: accRows.length,
    friends: accRows.map(socialSummary),
    incoming: inRows.map(socialSummary),
    outgoing: outRows.map(socialSummary),
  });
});

/* ---------------- منشورات البروفايل + التفاعلات ----------------
   منشور: نص + رابط عمل اختياري، على البروفايل العام لصاحبه. التفاعل نوعان
   فقط (❤️/👏)، ضغطة لكل عضو لكل نوع، والإلغاء بضغطة ثانية. الزوار يقرأون
   فقط. المؤسس عرض فقط — لا منشورات له (كقاعدة الشورتس نفسها). */
const POST_MAX = 1000;
const REACTION_KINDS = ['love', 'clap'];
async function postView(p, viewerId) {
  const counts = { love: 0, clap: 0 };
  const rows = await db.prepare('SELECT kind, COUNT(*) c FROM post_reactions WHERE post_id=? GROUP BY kind').all(p.id);
  for (const r of rows) counts[r.kind] = r.c;
  let mine = [];
  if (viewerId) {
    mine = (await db.prepare('SELECT kind FROM post_reactions WHERE post_id=? AND user_id=?').all(p.id, viewerId)).map((r) => r.kind);
  }
  return {
    id: p.id, user_id: p.user_id, body: p.body, link: p.link || '',
    pinned: !!p.pinned, created_at: p.created_at, updated_at: p.updated_at || 0,
    reactions: counts, my_reactions: mine,
  };
}
app.get('/api/users/:id/posts', async (req, res) => {
  const u = await getUser(+req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  const viewer = await optionalViewer(req);
  if (u.is_platform_founder && (!viewer || (viewer.id !== u.id && !canSeeFounder(viewer)))) {
    return res.status(404).json({ error: 'غير موجود' });
  }
  const rows = await db.prepare('SELECT * FROM profile_posts WHERE user_id=? ORDER BY pinned DESC, created_at DESC, id DESC').all(u.id);
  res.json({ items: await Promise.all(rows.map((p) => postView(p, viewer ? viewer.id : null))) });
});
app.post('/api/users/:id/posts', auth, async (req, res) => {
  if (+req.params.id !== req.user.id) return res.status(403).json({ error: 'تنشر على بروفايلك فقط' });
  if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس عرض فقط — لا منشورات' });
  const body = String((req.body || {}).body || '').trim();
  const link = String((req.body || {}).link || '').trim();
  if (!body) return res.status(400).json({ error: 'اكتب نص المنشور أولاً' });
  if (body.length > POST_MAX) return res.status(400).json({ error: `المنشور أطول من الحد الأقصى (${POST_MAX} حرف)` });
  if (link && !/^https?:\/\/\S+$/i.test(link)) return res.status(400).json({ error: 'رابط العمل غير صحيح' });
  if (link.length > 600) return res.status(400).json({ error: 'الرابط أطول من اللازم' });
  const info = await db.prepare('INSERT INTO profile_posts (user_id,body,link,created_at) VALUES (?,?,?,?)')
    .run(req.user.id, body, link, now());
  const p = await db.prepare('SELECT * FROM profile_posts WHERE id=?').get(info.lastInsertRowid);
  res.json({ ok: true, post: await postView(p, req.user.id) });
});
async function ownPost(req, res) {
  const p = await db.prepare('SELECT * FROM profile_posts WHERE id=?').get(+req.params.id);
  if (!p) { res.status(404).json({ error: 'المنشور غير موجود' }); return null; }
  if (p.user_id !== req.user.id) { res.status(403).json({ error: 'المنشور ليس منشورك' }); return null; }
  return p;
}
app.patch('/api/posts/:id', auth, async (req, res) => {
  const p = await ownPost(req, res); if (!p) return;
  const body = String((req.body || {}).body ?? p.body).trim();
  const link = String((req.body || {}).link ?? p.link ?? '').trim();
  if (!body) return res.status(400).json({ error: 'اكتب نص المنشور أولاً' });
  if (body.length > POST_MAX) return res.status(400).json({ error: `المنشور أطول من الحد الأقصى (${POST_MAX} حرف)` });
  if (link && !/^https?:\/\/\S+$/i.test(link)) return res.status(400).json({ error: 'رابط العمل غير صحيح' });
  await db.prepare('UPDATE profile_posts SET body=?, link=?, updated_at=? WHERE id=?').run(body, link, now(), p.id);
  const fresh = await db.prepare('SELECT * FROM profile_posts WHERE id=?').get(p.id);
  res.json({ ok: true, post: await postView(fresh, req.user.id) });
});
app.delete('/api/posts/:id', auth, async (req, res) => {
  const p = await ownPost(req, res); if (!p) return;
  await db.prepare('DELETE FROM post_reactions WHERE post_id=?').run(p.id);
  await db.prepare('DELETE FROM profile_posts WHERE id=?').run(p.id);
  res.json({ ok: true });
});
app.post('/api/posts/:id/pin', auth, async (req, res) => {
  const p = await ownPost(req, res); if (!p) return;
  // منشور مثبّت واحد فقط لكل بروفايل: تثبيت الجديد يفكّ القديم تلقائياً.
  await db.prepare('UPDATE profile_posts SET pinned=0 WHERE user_id=?').run(req.user.id);
  await db.prepare('UPDATE profile_posts SET pinned=1 WHERE id=?').run(p.id);
  const fresh = await db.prepare('SELECT * FROM profile_posts WHERE id=?').get(p.id);
  res.json({ ok: true, post: await postView(fresh, req.user.id) });
});
app.post('/api/posts/:id/unpin', auth, async (req, res) => {
  const p = await ownPost(req, res); if (!p) return;
  await db.prepare('UPDATE profile_posts SET pinned=0 WHERE id=?').run(p.id);
  const fresh = await db.prepare('SELECT * FROM profile_posts WHERE id=?').get(p.id);
  res.json({ ok: true, post: await postView(fresh, req.user.id) });
});
app.post('/api/posts/:id/react', auth, async (req, res) => {
  const kind = String((req.body || {}).kind || '');
  if (!REACTION_KINDS.includes(kind)) return res.status(400).json({ error: 'نوع تفاعل غير معروف' });
  const p = await db.prepare('SELECT * FROM profile_posts WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({ error: 'المنشور غير موجود' });
  const me = req.user.id;
  const existing = await db.prepare('SELECT 1 x FROM post_reactions WHERE post_id=? AND user_id=? AND kind=?').get(p.id, me, kind);
  if (existing) {
    await db.prepare('DELETE FROM post_reactions WHERE post_id=? AND user_id=? AND kind=?').run(p.id, me, kind);
  } else {
    // «أول تفاعل من كل شخص» على هذا المنشور (بأي نوع) يُشعر صاحبه — مرة واحدة فقط.
    const anyBefore = await db.prepare('SELECT 1 x FROM post_reactions WHERE post_id=? AND user_id=?').get(p.id, me);
    await db.prepare('INSERT INTO post_reactions (post_id,user_id,kind,created_at) VALUES (?,?,?,?)').run(p.id, me, kind, now());
    if (!anyBefore && p.user_id !== me) {
      await notify(p.user_id, 'post_reaction', `تفاعل ${req.user.name} مع منشورك على بروفايلك`, `post:${p.id}`);
    }
  }
  res.json({ ok: true, post: await postView(p, me) });
});

/* ---------------- جدار المؤسسين: المقاعد ١–١٠٠ كما هي في السجلات ----------------
   المشغولة بالعضو (اسم/مدينة/دولة/مجال) والشاغرة «مقعد متاح» — والفئة مغلقة
   نهائياً عند اكتمال المئة (closed=true) ولا تُفتح ثانية أبداً. */
app.get('/api/founders-wall', async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM users WHERE founder_seat IS NOT NULL AND founder_seat BETWEEN 1 AND 100 ORDER BY founder_seat ASC`).all();
  const bySeat = new Map(rows.map((u) => [u.founder_seat, u]));
  const seats = [];
  for (let n = 1; n <= 100; n++) {
    const u = bySeat.get(n);
    seats.push(u ? {
      seat: n, taken: true, user_id: u.id, name: u.name, role: u.role,
      niche: u.niche || '', provider_category: u.provider_category || '', provider_custom: u.provider_custom || '',
      city: u.city || '', country: u.country || '', avatar: u.avatar || '', verified: !!u.verified,
    } : { seat: n, taken: false });
  }
  res.json({ seats, taken: rows.length, closed: rows.length >= 100 });
});

/* ---------------- بطاقة «صفقة موثقة عبر Deal» (#/d/<bookingId>) ----------------
   صفحة عامة لصفقة مكتملة فقط (غير ذلك 404): قائمة بيضاء صارمة للحقول —
   اسم الصانع ومجاله ومدينته، الاسم الأول من اسم نشاط العميل، وتاريخ الإتمام.
   بلا مبلغ وبلا هاتف وبلا أي وسيلة تواصل إطلاقاً. */
app.get('/api/deals/:bookingId', async (req, res) => {
  const b = await getBooking(+req.params.bookingId);
  if (!b || b.status !== 'completed') return res.status(404).json({ error: 'غير موجود' });
  const talent = await getUser(b.talent_id);
  if (!talent) return res.status(404).json({ error: 'غير موجود' });
  let clientName = '';
  if (b.client_id) { const c = await getUser(b.client_id); clientName = c ? c.name : ''; }
  else clientName = b.guest_name || '';
  const firstName = String(clientName || '').trim().split(/\s+/)[0] || '';
  res.json({
    booking_id: b.id,
    verified_deal: true,
    completed_at: b.completed_at || 0,
    talent: {
      id: talent.id, name: talent.name, role: talent.role,
      niche: talent.niche || '', provider_category: talent.provider_category || '', provider_custom: talent.provider_custom || '',
      city: talent.city || '', country: talent.country || '',
      founder_seat: talent.founder_seat ?? null, verified: !!talent.verified,
    },
    client_first_name: firstName,
  });
});

/* ---------------- المراسلة الداخلية 1:1 (حسابات مسجلة فقط) ----------------
   المؤسس خارج المراسلة تماماً من الطرفين: لا رسائل إليه ولا منه عبر هذا المسار. */
const MSG_MAX = 1000;
/* رسائل ضيف غير مقروءة لحجوزات هذا المنفذ (محادثات عميل↔مقدم داخل المنصة). */
async function guestUnreadForTalent(userId) {
  return +(await db.prepare(`SELECT COUNT(*) c FROM guest_messages gm JOIN bookings b ON b.id=gm.booking_id
    WHERE b.talent_id=? AND gm.sender='guest' AND gm.is_read=0`).get(userId)).c || 0;
}
app.get('/api/messages', auth, async (req, res) => {
  const me = req.user.id;
  const rows = await db.prepare(`SELECT *, CASE WHEN sender_id=? THEN recipient_id ELSE sender_id END AS other_id
    FROM messages WHERE sender_id=? OR recipient_id=? ORDER BY created_at DESC, id DESC`).all(me, me, me);
  const convs = new Map();
  for (const m of rows) {
    let c = convs.get(m.other_id);
    if (!c) { c = { other_id: m.other_id, last: m, unread: 0 }; convs.set(m.other_id, c); }
    if (m.recipient_id === me && !m.is_read) c.unread++;
  }
  const items = [];
  let unread_total = 0;
  for (const c of convs.values()) {
    unread_total += c.unread;
    items.push({
      user: socialSummary(await getUser(c.other_id)),
      last: { body: c.last.body, created_at: c.last.created_at, mine: c.last.sender_id === me },
      unread: c.unread,
      // محادثة مع غير صديق = للقراءة فقط (تظهر في القائمة بحالتها الصادقة).
      can_message: await areFriends(me, c.other_id),
    });
  }
  res.json({ items, unread_total, guest_unread_total: await guestUnreadForTalent(me) });
});
app.get('/api/messages/:userId', auth, async (req, res) => {
  const other = await getUser(+req.params.userId);
  if (!other) return res.status(404).json({ error: 'غير موجود' });
  // فتح المحادثة يعلّم رسائل الطرف الآخر كمقروءة.
  await db.prepare('UPDATE messages SET is_read=1 WHERE sender_id=? AND recipient_id=? AND is_read=0').run(other.id, req.user.id);
  const rows = await db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)
    ORDER BY created_at DESC, id DESC LIMIT 200) recent ORDER BY created_at ASC, id ASC`)
    .all(req.user.id, other.id, other.id, req.user.id);
  const fstate = await friendState(req.user.id, other.id);
  res.json({
    user: socialSummary(other),
    friend_state: fstate,
    can_message: fstate === 'friends',
    items: rows.map(m => ({ id: m.id, body: m.body, created_at: m.created_at, mine: m.sender_id === req.user.id, is_read: !!m.is_read })),
  });
});
app.post('/api/messages/:userId', auth, async (req, res) => {
  const other = await getUser(+req.params.userId);
  if (!other) return res.status(404).json({ error: 'غير موجود' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك مراسلة نفسك' });
  if (other.is_platform_founder || req.user.is_platform_founder) {
    return res.status(400).json({ error: 'حساب المؤسس خارج المراسلة — عرضه ومتابعته فقط' });
  }
  if (other.banned || other.frozen) return res.status(400).json({ error: 'هذا الحساب غير متاح للمراسلة حالياً' });
  /* بوابة الصداقة (قرار المالك): المراسلة عضو↔عضو للأصدقاء المقبولين فقط.
     المحادثات القائمة مع غير أصدقاء تبقى قابلة للقراءة، والإرسال وحده يُرفض. */
  if (!(await areFriends(req.user.id, other.id))) {
    return res.status(403).json({ error: 'المراسلة متاحة للأصدقاء المقبولين فقط — أرسل طلب صداقة أولاً · Messaging is for accepted friends only — send a friend request first' });
  }
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'اكتب رسالة أولاً' });
  if (body.length > MSG_MAX) return res.status(400).json({ error: `الرسالة أطول من الحد الأقصى (${MSG_MAX} حرف)` });
  const ts = now();
  const info = await db.prepare('INSERT INTO messages (sender_id,recipient_id,body,created_at) VALUES (?,?,?,?)')
    .run(req.user.id, other.id, body, ts);
  await notify(other.id, 'message', `رسالة جديدة من ${req.user.name}`, `messages:${req.user.id}`);
  res.json({ ok: true, message: { id: info.lastInsertRowid, body, created_at: ts, mine: true } });
});

/* ---------------- التصنيف الموحّد (مصدر واحد مشترك) ----------------
   مجالات صناع المحتوى وخدمات مقدمي الخدمة تُعرَّف هنا مرة واحدة وتُخدَم من
   /api/taxonomy؛ الواجهة تبني قوائمها منها (ونسختها الاحتياطية المدمجة يطابقها
   فحص آلي حرفياً حتى لا تنحرف النسختان أبداً). «أخرى» ليست قيمة مخزّنة:
   للمجال تُخزَّن كتابة المستخدم نفسها، وللخدمة تُخزَّن provider_category='other'
   ونصّها الحر في provider_custom ويظهر كما كتبه صاحبه. */
const TAXONOMY = {
  "niches": ["كوميديا", "طبخ", "رياضة", "جمال", "مراجعات وتقنية", "تعليم", "ألعاب", "سفر", "أطفال", "ديني", "أخبار وتريند", "حرف وDIY", "سيارات", "عقارات", "صحة ولياقة", "موسيقى", "تصوير", "عام"],
  "services": [
    { "key": "videoproduction", "ar": "إنتاج فيديوهات وإعلانات", "en": "Video & ad production" },
    { "key": "editing", "ar": "مونتاج فيديو", "en": "Video editing" },
    { "key": "design", "ar": "تصميم وموشن جرافيك", "en": "Design & motion graphics" },
    { "key": "filming", "ar": "تصوير", "en": "Filming & photography" },
    { "key": "voiceover", "ar": "تعليق صوتي", "en": "Voice-over" },
    { "key": "script", "ar": "كتابة سكربت", "en": "Script writing" },
    { "key": "accounts", "ar": "إدارة حسابات سوشيال", "en": "Social account management" },
    { "key": "ads", "ar": "إدارة إعلانات ممولة", "en": "Sponsored ads management" },
    { "key": "support", "ar": "دعم وحل مشاكل الحسابات", "en": "Account support & troubleshooting" },
    { "key": "translation", "ar": "ترجمة", "en": "Translation" },
    { "key": "dev", "ar": "تطوير مواقع وتطبيقات", "en": "Web & app development" },
    { "key": "marketing", "ar": "تسويق وصناعة محتوى", "en": "Marketing & content" }
  ],
  "countries": [
    { "code": "EG", "ar": "مصر", "en": "Egypt", "dial": "20", "currency": "EGP", "curAr": "جنيه", "curEn": "EGP", "payAr": "فودافون كاش / إنستاباي", "payEn": "Vodafone Cash / InstaPay", "nsn": "^1[0125][0-9]{8}$" },
    { "code": "SA", "ar": "السعودية", "en": "Saudi Arabia", "dial": "966", "currency": "SAR", "curAr": "ريال", "curEn": "SAR", "payAr": "STC Pay / مدى", "payEn": "STC Pay / mada", "nsn": "^5[0-9]{8}$" },
    { "code": "AE", "ar": "الإمارات", "en": "UAE", "dial": "971", "currency": "AED", "curAr": "درهم", "curEn": "AED", "payAr": "تحويل بنكي", "payEn": "Bank transfer", "nsn": "^5[0-9]{8}$" },
    { "code": "KW", "ar": "الكويت", "en": "Kuwait", "dial": "965", "currency": "KWD", "curAr": "دينار", "curEn": "KWD", "payAr": "KNET / تحويل بنكي", "payEn": "KNET / bank transfer", "nsn": "^[569][0-9]{7}$" },
    { "code": "QA", "ar": "قطر", "en": "Qatar", "dial": "974", "currency": "QAR", "curAr": "ريال", "curEn": "QAR", "payAr": "تحويل بنكي", "payEn": "Bank transfer", "nsn": "^[3567][0-9]{7}$" },
    { "code": "JO", "ar": "الأردن", "en": "Jordan", "dial": "962", "currency": "JOD", "curAr": "دينار", "curEn": "JOD", "payAr": "CliQ", "payEn": "CliQ", "nsn": "^7[789][0-9]{7}$" },
    { "code": "MA", "ar": "المغرب", "en": "Morocco", "dial": "212", "currency": "MAD", "curAr": "درهم", "curEn": "MAD", "payAr": "تحويل بنكي", "payEn": "Bank transfer", "nsn": "^[67][0-9]{8}$" },
    { "code": "BH", "ar": "البحرين", "en": "Bahrain", "dial": "973", "currency": "BHD", "curAr": "دينار", "curEn": "BHD", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^[36][0-9]{7}$" },
    { "code": "OM", "ar": "عُمان", "en": "Oman", "dial": "968", "currency": "OMR", "curAr": "ريال", "curEn": "OMR", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^[79][0-9]{7}$" },
    { "code": "IQ", "ar": "العراق", "en": "Iraq", "dial": "964", "currency": "IQD", "curAr": "دينار", "curEn": "IQD", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^7[0-9]{9}$" },
    { "code": "DZ", "ar": "الجزائر", "en": "Algeria", "dial": "213", "currency": "DZD", "curAr": "دينار", "curEn": "DZD", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^[567][0-9]{8}$" },
    { "code": "TN", "ar": "تونس", "en": "Tunisia", "dial": "216", "currency": "TND", "curAr": "دينار", "curEn": "TND", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^[24579][0-9]{7}$" },
    { "code": "LB", "ar": "لبنان", "en": "Lebanon", "dial": "961", "currency": "LBP", "curAr": "ليرة", "curEn": "LBP", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^[3478][0-9]{6,7}$" },
    { "code": "PS", "ar": "فلسطين", "en": "Palestine", "dial": "970", "currency": "ILS", "curAr": "شيكل", "curEn": "ILS", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^5[69][0-9]{7}$" },
    { "code": "LY", "ar": "ليبيا", "en": "Libya", "dial": "218", "currency": "LYD", "curAr": "دينار", "curEn": "LYD", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^9[1245][0-9]{7}$" },
    { "code": "SD", "ar": "السودان", "en": "Sudan", "dial": "249", "currency": "SDG", "curAr": "جنيه", "curEn": "SDG", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^[19][0-9]{8}$" },
    { "code": "YE", "ar": "اليمن", "en": "Yemen", "dial": "967", "currency": "YER", "curAr": "ريال", "curEn": "YER", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^7[0-9]{8}$" },
    { "code": "SY", "ar": "سوريا", "en": "Syria", "dial": "963", "currency": "SYP", "curAr": "ليرة", "curEn": "SYP", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^9[0-9]{8}$" },
    { "code": "MR", "ar": "موريتانيا", "en": "Mauritania", "dial": "222", "currency": "MRU", "curAr": "أوقية", "curEn": "MRU", "payAr": "تحويل محلي", "payEn": "Local transfer", "nsn": "^[234][0-9]{7}$" }
  ],
  "link_platforms": ["facebook.com", "instagram.com", "youtube.com", "tiktok.com", "x.com", "twitter.com", "snapchat.com"],
  "accents": { "gold": "#c9a227", "emerald": "#0e9f6e", "sapphire": "#2b5fd9", "ruby": "#c2255c", "violet": "#7048c9", "teal": "#1098ad", "copper": "#e8720c", "rose": "#d6336c" }
};
const SERVICE_KEYS = TAXONOMY.services.map((s) => s.key);
app.get('/api/taxonomy', (req, res) => res.json(TAXONOMY));

/* ---------------- الدول العربية: هواتف وعملات ودفع محلي ----------------
   مصدر الحقيقة الوحيد هو TAXONOMY.countries أعلاه (تُبث عبر /api/taxonomy
   وتطابقها نسخة الواجهة الاحتياطية حرفياً بالفحص البنيوي). كل دولة: مفتاح
   اتصال، عملة مشتقة (لا يختارها المستخدم)، وقاعدة تحقق للرقم الوطني (nsn —
   الأرقام بعد مفتاح الدولة وبلا صفر البادئة المحلي) كنمط regex نصي.
   الصيغة القانونية الموحّدة للتخزين (canonical) — موثقة هنا:
   • مصر: الصيغة المحلية القائمة تاريخياً 0xxxxxxxxxx (حتى يبقى منع التكرار
     الحالي والصفوف القائمة كما هي بلا أي كسر).
   • كل دولة أخرى: الصيغة الدولية الكاملة +<dial><nsn> (مثل +9665xxxxxxxx).
   التطبيع يقبل: الصيغة الدولية (+ أو 00 أو مفتاح الدولة مباشرة)، أو المحلية
   بصفر بادئ، أو الرقم الوطني مجرداً — وكلها تؤول لنفس الصيغة القانونية،
   فمنع التسجيل المكرر يعمل عبر كل صيغ نفس الرقم داخل الدولة الواحدة. */
const COUNTRIES = TAXONOMY.countries;
const COUNTRY_MAP = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));
function countryOf(code) {
  const c = COUNTRY_MAP[String(code || 'EG').toUpperCase()];
  return c || null;
}
function normalizePhoneForCountry(raw, code) {
  const c = countryOf(code);
  if (!c) return null;
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  let nsn;
  if (d.startsWith(c.dial) && new RegExp(c.nsn).test(d.slice(c.dial.length))) nsn = d.slice(c.dial.length);
  else if (d.startsWith('0')) nsn = d.slice(1);
  else nsn = d;
  if (!new RegExp(c.nsn).test(nsn)) return null;
  return c.code === 'EG' ? '0' + nsn : '+' + c.dial + nsn;
}
/* رسالة خطأ رقم غير صحيح حسب الدولة (رسالة مصر القائمة تبقى حرفياً كما هي). */
function phoneErrorFor(c) {
  return c.code === 'EG'
    ? 'رقم موبايل مصري صحيح مطلوب (01xxxxxxxxx)'
    : `رقم هاتف صحيح مطلوب في ${c.ar} (مثال: +${c.dial}xxxxxxxxx)`;
}
/* نفس الرسالة بصياغة «هاتف» لمسار تعديل الملف (رسالته القائمة حرفياً لمصر). */
function profilePhoneError(code) {
  const c = countryOf(code) || COUNTRY_MAP.EG;
  return c.code === 'EG'
    ? 'رقم هاتف مصري صحيح مطلوب (01xxxxxxxxx)'
    : `رقم هاتف صحيح مطلوب في ${c.ar} (مثال: +${c.dial}xxxxxxxxx)`;
}

/* ---------------- directory / market ---------------- */
/* جلسة اختيارية من الترويسة (للمسارات العامة التي يتغير ردها حسب المشاهد). */
async function optionalViewer(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const s = await db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  return s ? await getUser(s.user_id) : null;
}
/* حساب المؤسس يظهر للصناع ومقدمي الخدمة المسجلين فقط — لا يراه زائر ولا ضيف ولا محل. */
function canSeeFounder(viewer) {
  return !!viewer && ['creator', 'provider'].includes(viewer.role);
}

app.get('/api/directory', async (req, res) => {
  const viewer = await optionalViewer(req);
  const { role, niche, city, q, country } = req.query;
  let sql = `SELECT * FROM users WHERE role IN ('creator','provider') AND banned=0`;
  const args = [];
  if (!canSeeFounder(viewer)) sql += ' AND is_platform_founder=0';
  if (role) { sql += ' AND role=?'; args.push(role); }
  // فلتر الدولة يعمل خادمياً مع باقي الفلاتر — ودولة المؤسس ليست علنية،
  // فلا يجوز أن يكشفها فلتر دولة (يُستبعد المؤسس من أي نتيجة مفلترة بالدولة
  // تماماً كما يُستبعد عند فلترة المدينة).
  if (country) { sql += ' AND country=?'; args.push(String(country).toUpperCase()); }
  // فلتر «المجال/الخدمة» موحّد: يطابق مجال الصانع أو مفتاح خدمة المقدم أو نص خدمته الحر.
  if (niche) { sql += ' AND (niche=? OR provider_category=? OR provider_custom=?)'; args.push(niche, niche, niche); }
  if (city) { sql += ' AND city=?'; args.push(city); }
  if (q) { sql += ' AND (name LIKE ? OR niche LIKE ? OR city LIKE ? OR provider_custom LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  let rows = await db.prepare(sql).all(...args);
  // مدينة المؤسس ليست علنية (طلب المالك): لا يجوز أن يطابقها فلتر مدينة، ولا
  // أن يصل إليها بحث نصي عبر حقل المدينة — يبقى المؤسس قابلاً للإيجاد باسمه
  // أو مجاله العلنيين فقط، فلا تتسرب مدينته من أي باب خلفي في الدليل.
  if (city || country) rows = rows.filter((u) => !u.is_platform_founder);
  else if (q) rows = rows.filter((u) => !u.is_platform_founder || String(u.name).includes(q) || String(u.niche || '').includes(q));
  const dealsMap = {};
  await Promise.all(rows.map(async (u) => { dealsMap[u.id] = (await talentStats(u.id)).completed_deals; }));
  // مجموعة النجوم النشطين مرة واحدة للفرز (اشتراك مؤكد وغير منتهٍ فقط).
  const starSet = new Set((await db.prepare(`SELECT user_id FROM star_subscriptions WHERE status='active' AND expires_at>?`).all(now())).map((r) => r.user_id));
  const t = now();
  rows.sort((a, b) => {
    const boost = (x) => (x.boost_until > t && x.penalty_level !== 'suspended') ? 1 : 0;
    // الظهور المميز (مكافأة الإحالات الموثقة) يتقدّم ضمن نفس معايير الترتيب القائمة:
    // بعد التوثيق وقبل دفعة التوثيق المؤقتة — وبكاسر تعادل أخير بالمعرّف كالعادة.
    const feat = (x) => ((x.featured_until || 0) > t) ? 1 : 0;
    // ترتيب الدليل الموثق (باقة نجم Deal): موثّق أولاً (ثقة المنصة)، ثم نجم Deal
    // نشط (أولوية الباقة)، ثم الظهور المميز بالإحالات، ثم دفعة التوثيق المؤقتة،
    // ثم الصفقات المكتملة، ثم الأقدم. المؤسس لا يدخل الفرز كميزة — يظهر بعلمه فقط.
    const star = (x) => starSet.has(x.id) ? 1 : 0;
    return (b.verified - a.verified) || (star(b) - star(a)) || (feat(b) - feat(a)) || (boost(b) - boost(a)) || ((dealsMap[b.id] || 0) - (dealsMap[a.id] || 0)) || (a.id - b.id);
  });
  res.json({ items: await Promise.all(rows.map(u => publicUser(u, viewer ? viewer.id : null))) });
});

app.get('/api/talent/:id', async (req, res) => {
  const u = await getUser(+req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  const viewer = await optionalViewer(req);
  const viewerId = viewer ? viewer.id : null;
  // ملف المؤسس: للصناع/المقدمين المسجلين وللمؤسس نفسه فقط — غيرهم كأنه غير موجود.
  if (u.is_platform_founder && viewerId !== u.id && !canSeeFounder(viewer)) {
    return res.status(404).json({ error: 'غير موجود' });
  }
  if (viewerId !== u.id) await db.prepare('INSERT INTO profile_views (talent_id,viewer_id,created_at) VALUES (?,?,?)').run(u.id, viewerId, now());
  const reviews = await db.prepare(`SELECT r.*, COALESCE(u2.name, 'عميل') reviewer_name FROM reviews r LEFT JOIN users u2 ON u2.id=r.reviewer_id WHERE r.reviewee_id=? ORDER BY r.created_at DESC LIMIT 10`).all(u.id);
  res.json({
    user: await publicUser(u, viewerId),
    stats: await talentStats(u.id),
    badges: await computeBadges(u.id),
    reviews,
    // نماذج الشورتس المضمّنة (حد أقصى 3) — المؤسس بلا نماذج إطلاقاً بمواصفة المالك.
    shorts: u.is_platform_founder ? [] : await shortsOf(u.id),
  });
});

/* ---------------- automatic verification ---------------- */
app.post('/api/verify/request', auth, async (req, res) => {
  if (req.user.role !== 'creator') return res.status(400).json({ error: 'التوثيق للصناع فقط' });
  const code = `DEAL-${req.user.id}-${rnd(3).toUpperCase()}`;
  await db.prepare(`UPDATE users SET verify_code=?, verify_status='pending', verify_reason='' WHERE id=?`).run(code, req.user.id);
  res.json({ code, instructions: 'ضع هذا الكود في بايو أحد حساباتك العلنية أو منشور مثبت، ثم أرسل رابط الحساب للفحص. الحسابات المقبولة: فيسبوك، إنستجرام، يوتيوب، تيك توك، X (x.com)، وسناب شات.' });
});

app.post('/api/verify/check', auth, async (req, res) => {
  const { url } = req.body || {};
  const u = req.user;
  if (!u.verify_code) return res.status(400).json({ error: 'اطلب كود التوثيق أولاً' });
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'رابط غير صحيح' });
  let html = null, fetchErr = '';
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (DealVerify)' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!r.ok) fetchErr = `HTTP ${r.status}`;
    else html = await r.text();
  } catch (e) { fetchErr = e.message; }

  if (html === null) {
    await db.prepare(`UPDATE users SET verify_status='exceptional', verify_url=?, verify_reason=? WHERE id=?`)
      .run(url, `تعذرت قراءة الصفحة آلياً (${fetchErr}) — تحتاج مراجعة استثنائية`, u.id);
    const founder = await db.prepare('SELECT id FROM users WHERE is_platform_founder=1').get();
    if (founder) await notify(founder.id, 'verify_exceptional', `طلب توثيق استثنائي من ${u.name}`, `user:${u.id}`);
    await notify(u.id, 'verification', 'توثيقك في «مراجعة استثنائية» — تعذرت القراءة الآلية لصفحتك', '');
    return res.json({ status: 'exceptional' });
  }
  const hasCode = html.includes(u.verify_code);
  const nameMatch = html.toLowerCase().includes(u.name.toLowerCase()) || html.toLowerCase().includes(u.name.split(' ')[0].toLowerCase());
  if (hasCode && nameMatch) {
    const wasVerified = !!u.verified;
    const pioneer = await db.prepare(`SELECT id FROM users WHERE verified=1 AND pioneer=1 AND city=? AND niche=?`).get(u.city, u.niche) ? 0 : 1;
    await db.prepare(`UPDATE users SET verified=1, verify_status='verified', verify_reason='', pioneer=?, boost_until=? WHERE id=?`)
      .run(pioneer, now() + 7 * 24 * 3600 * 1000, u.id);
    await notify(u.id, 'verification', 'مبروك! حسابك بقى «موثّق Deal»' + (pioneer ? ' وأنت «رائد المدينة» في مجالك' : ''), '');
    if (!wasVerified) await onReferralVerified(await getUser(u.id));
    return res.json({ status: 'verified', pioneer: !!pioneer });
  }
  const reason = !hasCode ? 'كود الملكية غير موجود في الصفحة' : 'اسم الحساب لا يطابق اسم التسجيل';
  await db.prepare(`UPDATE users SET verify_status='rejected', verify_url=?, verify_reason=? WHERE id=?`).run(url, reason, u.id);
  res.json({ status: 'rejected', reason });
});

/* ---------------- bookings (commission-first P2P) ---------------- */
/* حالة الطلب الصريحة بنظام باينانس P2P — تُشتق من حالة الحجز والاحتجاز فقط،
   فلا توجد حالة موازية مخزّنة قد تنحرف عن الحقيقة:
   awaiting_payment ← paid_awaiting_confirmation ← confirmed_awaiting_release
   ← completed، وفرعيتان: cancelled وunder_arbitration. */
function orderStateFor(b) {
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'disputed') return 'under_arbitration';
  if (b.status === 'rest_overdue') return 'rest_overdue';
  if (b.status === 'proof_submitted') return 'paid_awaiting_confirmation';
  if (['awaiting_rest', 'awaiting_final_delivery', 'final_delivered'].includes(b.status)) return 'confirmed_awaiting_release';
  if (b.status === 'completed') return 'completed';
  return 'awaiting_payment'; // pending_agreement / awaiting_fee / awaiting_deposit / in_progress
}
/* إلغاء تلقائي نظيف بنظام باينانس وبصرامته: مهلة الدفع ٣ ساعات حاسمة (حد باينانس الأقصى — قرار المستخدم 2026-11-23) — بلا
   تمديد وبلا استثناءات. انتهاؤها بلا أي إعلان دفع → يُلغى الطلب في تلك الخطوة
   نهائياً ويُختم الالتزام «منتهياً» في السجل — لا مبلغ يتحرك إطلاقاً. أما لو
   وُجد إعلان دفع/مطالبة (الالتزام «مُدّعى» أو أبعد) فلا إلغاء تلقائياً أبداً:
   المسار تأكيد أو تحكيم. هذا الإلغاء ليس «تأكيداً تلقائياً» — لا يحرّك مبلغاً. */
const STEP_OBLIGATION_KIND = { awaiting_fee: 'booking_commission', awaiting_deposit: 'booking_deposit', awaiting_rest: 'booking_final', proof_submitted: 'booking_final' };
async function sweepStepExpiry() {
  const rows = await db.prepare(`SELECT * FROM bookings WHERE status IN ('awaiting_fee','awaiting_deposit','awaiting_rest','proof_submitted')`).all();
  for (const b of rows) {
    const ob = await db.prepare('SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND is_difference=0 ORDER BY id DESC LIMIT 1').get(STEP_OBLIGATION_KIND[b.status], b.id);
    if (!ob || ob.status !== 'open' || !ob.expires_at || ob.expires_at > now()) continue;
    if (b.status === 'awaiting_rest') {
      /* استثناء جوهري (نموذج بلا احتجاز): الباقي بعد قبول الاستلام ليس خطوة
         إلغاء نظيف — عدم دفعه «مستحق متأخر»: يُختم الالتزام منتهياً، والحجز
         يدخل حالة rest_overdue بخطأ العميل (تضرب نسبة إتمامه كعميل)، والمالك
         يُنبَّه للتحكيم (عقوبات/حزمة أدلة) — والعميل يقدر يدفع بعدها فيرجع
         الحجز لمساره. لا مال عند المنصة أصلاً فلا شيء يُردّ أو يُفرَج. */
      await setObligationStatus(ob, 'expired', 'system', 'انتهت مهلة دفع الباقي (٣ ساعات) بعد قبول الاستلام بلا إعلان دفع — مستحق متأخر');
      await db.prepare(`UPDATE bookings SET prev_status=status, status='rest_overdue', cancel_fault='client' WHERE id=?`).run(b.id);
      await addBookingEvent(b.id, 'rest_overdue', 'انتهت مهلة دفع الباقي بعد قبول الاستلام — صار «مستحقاً متأخراً» على العميل');
      await notify(b.talent_id, 'rest_overdue', `حجز #${b.id}: ⚠️ العميل قبل الاستلام وما دفعش الباقي في مهلته (٣ ساعات) — صار مستحقاً متأخراً عليه واتفتح للمالك ملف تحكيم`, `booking:${b.id}`);
      if (b.client_id) await notify(b.client_id, 'rest_overdue', `حجز #${b.id}: ⚠️ انتهت مهلة دفع الباقي بعد ما أكدت الاستلام — الباقي صار «مستحقاً متأخراً» بيأثر على نسبة إتمامك وبيعرضك لعقوبات. ادفع الباقي للمنفذ دلوقتي من صفحة الحجز فيرجع لمساره`, `booking:${b.id}`);
      await notifyOwner('rest_overdue', `حجز #${b.id}: ⚠️ باقٍ مستحق متأخر بعد قبول الاستلام — راجع «مستحقات قيد المتابعة» للتحكيم/العقوبات`, `booking:${b.id}`);
      continue;
    }
    await setObligationStatus(ob, 'expired', 'system', 'انتهت مهلة الدفع (٣ ساعات) بلا أي إعلان دفع — إلغاء تلقائي نهائي للطلب (نظام باينانس)');
    await db.prepare(`UPDATE bookings SET prev_status=status, cancel_fault='client', status='cancelled', escrow_status=CASE WHEN escrow_status='awaiting_transfer' THEN '' ELSE escrow_status END WHERE id=?`).run(b.id);
    await addBookingEvent(b.id, 'cancelled', 'أُلغي الطلب تلقائياً — انتهت مهلة الدفع (٣ ساعات) بلا إعلان دفع');
    await notify(b.talent_id, 'order_cancelled', `حجز #${b.id}: اتلغى الطلب نهائياً — انتهت مهلة دفع الخطوة الحالية (٣ ساعات) من غير أي إعلان دفع`, `booking:${b.id}`);
    if (b.client_id) await notify(b.client_id, 'order_cancelled', `حجز #${b.id}: اتلغى الطلب نهائياً — انتهت مهلة الدفع (٣ ساعات) من غير إعلان دفع. لو كنت حوّلت فعلاً قدّم «بلاغ دفع متأخر» من صفحة الحجز، أو ابدأ طلباً جديداً`, `booking:${b.id}`);
    await notifyOwner('order_cancelled', `حجز #${b.id}: إلغاء تلقائي نهائي بانتهاء مهلة الدفع (الالتزام ${ob.code}) — لا مبالغ تحركت`, `booking:${b.id}`);
  }
}
async function getBooking(id) { return await db.prepare('SELECT * FROM bookings WHERE id=?').get(id); }
async function bookingView(b, viewer) {
  const fee = Math.round(b.price * COMMISSION_RATE * 100) / 100;
  const net = b.price - fee;
  const myReview = viewer ? await db.prepare('SELECT * FROM reviews WHERE booking_id=? AND reviewer_id=?').get(b.id, viewer.id) : null;
  const view = { ...b };
  delete view.guest_token; // رمز وصول الضيف لا يخرج في أي رد أبداً
  delete view.escrow_prev_status; // حالة احتجاز سابقة — تفصيلة داخلية لاستعادة النزاع فقط
  view.has_dispute = !!(await db.prepare('SELECT id FROM disputes WHERE booking_id=? LIMIT 1').get(b.id));
  view.appeal = appealView(await openAppealFor(b.id)); // طلب مراجعة إفراج قائم (نموذج باينانس) أو null
  view.terms = await termsStateFor(b); // بوابة «شروط المعاملات»: قبول الطرفين قبل أول خطوة دفع
  if (viewer) view.terms.mine_accepted = viewer.id === b.client_id ? view.terms.client_accepted : viewer.id === b.talent_id ? view.terms.talent_accepted : false;
  view.events = await bookingEvents(b.id); // رسائل نظام محادثة الطلب (أسلوب باينانس)
  view.deemed_at = b.deemed_at || 0;
  const finOb = await finalObligation(b.id);
  view.final_obligation_status = finOb ? finOb.status : null; // حالة التزام الباقي لعرض زرار «وصلني»/التسليم في الواجهة
  // رقم هاتف الضيف لا يظهر لأي صانع/مقدم خدمة — التواصل داخل المنصة فقط؛ المالك المؤسس وحده يراه
  if (!(viewer && viewer.is_platform_founder)) delete view.guest_phone;
  return {
    ...view,
    is_guest: !!b.guest_token,
    order_state: orderStateFor(b),
    urgent: !!b.urgent,
    fee, net, deposit: Math.round(net / 2 * 100) / 100, rest: Math.round(net / 2 * 100) / 100,
    client: b.client_id ? await publicUser(await getUser(b.client_id)) : null, talent: await publicUser(await getUser(b.talent_id)),
    my_review: myReview || null,
    can_review: b.status === 'completed' && viewer && !myReview && (viewer.id === b.client_id || viewer.id === b.talent_id),
    alternatives: b.status === 'disputed' ? await verifiedAlternatives(b) : [],
  };
}
async function verifiedAlternatives(b) {
  const t = await getUser(b.talent_id);
  const rows = await db.prepare(`SELECT * FROM users WHERE role=? AND niche=? AND city=? AND verified=1 AND id!=? AND banned=0 LIMIT 10`)
    .all(t.role, t.niche, t.city, t.id);
  // «ترشيح أول» للعملاء: بدائل النزاع تُرتَّب بنجم Deal النشط أولاً ثم الباقي كما هو.
  const starSet = new Set((await db.prepare(`SELECT user_id FROM star_subscriptions WHERE status='active' AND expires_at>?`).all(now())).map((r) => r.user_id));
  rows.sort((a, c) => ((starSet.has(c.id) ? 1 : 0) - (starSet.has(a.id) ? 1 : 0)) || (a.id - c.id));
  return Promise.all(rows.slice(0, 3).map(u => publicUser(u)));
}
/* ---------------- طلبات مراجعة الإفراج (نموذج باينانس P2P) ----------------
   لا يوجد أي مسح زمني يؤكد الاستلام: الاستلام يتأكد من العميل نفسه فقط، أو
   بقرار مراجعة موثّق من المالك بعد طلب المقدم. طلب المراجعة المفتوح لحجز ما
   يُقرأ من جدوله مباشرة في كل عرض — فلا حالة مخزنة تنفصل عن الحقيقة. */
async function openAppealFor(bookingId) {
  return await db.prepare(`SELECT * FROM release_appeals WHERE booking_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(bookingId);
}
function appealView(a) {
  if (!a) return null;
  return { id: a.id, booking_id: a.booking_id, status: a.status, client_note: a.client_note || '', created_at: a.created_at, decided_at: a.decided_at || 0, decision: a.decision || '',
    phase: a.phase || 'owner_review', phase_deadline: a.phase_deadline || 0, escalated_at: a.escalated_at || 0 };
}
/* إغلاق أي طلب مراجعة مفتوح على الحجز بسبب حدث حاسم (تأكيد عميل/فتح نزاع). */
async function closeOpenAppeal(bookingId, status) {
  await db.prepare(`UPDATE release_appeals SET status=? WHERE booking_id=? AND status='open'`).run(status, bookingId);
}

/* ================= جولة «المحاذاة الحرفية مع Binance P2P» + الحزمة القانونية + Push =================
   كل ما يلي مبني فوق البنية القائمة حرفياً (نفس الجداول والسجل والعقوبات)
   وموثّق في TESTING-BINANCE-ALIGN.md. المسوحات الزمنية كلها lazy: تُستدعى من
   مسارات القراءة القائمة، وتجميعها runAllSweeps قابل للاستدعاء من cron خارجي
   لاحقاً عبر مسار المالك — فلا مؤقّتات خادم ولا عمليات خلفية. */

/* ---- أحداث النظام في محادثة الطلب (أسلوب باينانس): انتقالات جوهرية مختومة
   بوقت الخادم، تظهر داخل محادثة الحجز وصفحة الضيف وتدخل حزمة الأدلة كما هي. */
async function addBookingEvent(bookingId, kind, body = '') {
  try { await db.prepare('INSERT INTO booking_events (booking_id,kind,body,created_at) VALUES (?,?,?,?)').run(bookingId, kind, String(body || '').slice(0, 300), now()); }
  catch (e) { /* توثيق الحدث لا يعطّل الحركة نفسها أبداً */ }
}
async function bookingEvents(bookingId, limit = 100) {
  const rows = await db.prepare('SELECT kind,body,created_at FROM booking_events WHERE booking_id=? ORDER BY created_at ASC, id ASC LIMIT ?').all(bookingId, limit);
  return rows.map((e) => ({ sender: 'system', kind: e.kind, body: e.body, created_at: e.created_at }));
}

/* ---- «شروط المعاملات» (deal-tx-terms-v2): الوثيقة التي يقبلها الطرفان قبل
   أول خطوة دفع في أي حجز — قبول مسجّل خادمياً (من + متى + إصدار) ويدخل
   حزمة الأدلة. إصدار جديد يطلب قبولاً جديداً للحجوزات الجديدة فقط. */
const TX_TERMS = {
  version: TX_TERMS_VERSION,
  ar: [
    'مهلة الدفع ٣ ساعات لكل خطوة دفع، بعدّاد حي ظاهر — انتهاؤها بلا إعلان دفع يُلغي الطلب تلقائياً بلا أي حركة مال.',
    'زر «حوّلت» يُضغط فقط بعد خروج التحويل من محفظتك فعلياً — لا يمكن إلغاء الخطوة بعد إعلان الدفع، والإعلان الكاذب يعرّض حسابك للإيقاف (٣ مطالبات كاذبة مثبتة = إيقاف وظائف الحجز).',
    'حوّل من حساب/محفظة بنفس اسمك المسجل فقط — التحويل من حساب شخص آخر يوقف العملية ويعرّض حسابك للإيقاف.',
    'Deal لا تستلم ولا تحتجز أموال المعاملات بين الأطراف في أي مرحلة — كل التحويلات بين محافظ الطرفين مباشرة، وعمولة Deal واشتراكاتها فقط هي إيراد المنصة.',
    'الدفعة الأخيرة (الباقي) تتحوّل من العميل إلى المنفذ مباشرة بعد تأكيد استلام المعاينة أو اعتماد الاستلام بقاعدة السكوت أو قرار تحكيم — والنسخة النهائية من الشغل لا تُسلَّم إلا بعد تأكيد قبض الباقي.',
    'عدم دفع الباقي بعد تأكيد الاستلام يجعل الحجز «مستحقاً متأخراً» يضرب نسبة إتمام العميل ويفتح تحكيم المالك (عقوبات وحزمة أدلة).',
    'إن سكت العميل ٣ ساعات بعد وصول إثبات التنفيذ (المعاينة)، يُعتبَر الاستلام مؤكداً وتتفتح خطوة دفع الباقي — نفس قاعدة باينانس — وللمالك حق عكس الاعتماد عند ثبوت احتيال أو خطأ.',
    'التحكيم بنظام باينانس: طور تفاوض ١٠ دقائق بين الطرفين أولاً، ثم حسم المالك من الأدلة — وقراره نهائي داخل المنصة ومسجّل.',
    'محادثة الطلب داخل Deal هي قناة الأدلة الوحيدة — أي اتفاق خارجها لا يُقبل دليلاً في التحكيم.',
    'المعاملات P2P: الفلوس تتحرك بين المحافظ الشخصية مباشرة، وDeal ينظّم ويوثّق ويحمي — Deal ليس بنكاً ولا جهة مالية.',
  ],
  en: [
    'Every payment step has a 3-hour deadline with a live countdown — expiry with no payment declared cancels the order automatically, with no money moving at all.',
    'Tap "I transferred" only after the transfer has actually left your wallet — the step cannot be undone once declared, and a false declaration risks suspension (3 proven false claims = booking functions suspended).',
    'Transfer only from an account/wallet in your own registered name — payment from someone else\u2019s account halts the process and risks suspending your account.',
    'Deal never receives or holds transaction money between the parties at any stage — all transfers move directly between the two parties\' wallets; only Deal\'s fee and subscriptions are platform revenue.',
    'The final instalment (the rest) moves from the client directly to the provider after preview receipt is confirmed, deemed confirmed by the silence rule, or decided by arbitration — and the final copy of the work is delivered only after receipt of the rest is confirmed.',
    'Not paying the rest after confirming receipt makes the booking an \'overdue rest\' that hurts the client\'s completion rate and opens owner arbitration (penalties and an evidence bundle).',
    'If the client stays silent for 3 hours after valid proof of delivery and the rest being held, receipt is deemed confirmed — the Binance rule — and the owner may reverse a deemed confirmation on proven fraud or error.',
    'Arbitration follows Binance: a 10-minute negotiation phase between the parties first, then the owner decides from the evidence — the decision is final inside the platform and recorded.',
    'The in-app order chat is the only evidence channel — agreements made outside it are not accepted as arbitration evidence.',
    'Transactions are P2P: money moves directly between personal wallets, and Deal organizes, documents and protects — Deal is not a bank or a financial institution.',
  ],
};
async function termsStateFor(b) {
  const rows = await db.prepare('SELECT side, user_id, accepted_at FROM booking_terms_acceptances WHERE booking_id=? AND version=?').all(b.id, TX_TERMS_VERSION);
  const by = {};
  for (const r of rows) by[r.side] = r;
  return {
    version: TX_TERMS_VERSION,
    client_accepted: !!by.client, talent_accepted: !!by.talent,
    client_accepted_at: by.client ? by.client.accepted_at : 0,
    talent_accepted_at: by.talent ? by.talent.accepted_at : 0,
  };
}
async function termsGateOpen(b) {
  const st = await termsStateFor(b);
  return st.client_accepted && st.talent_accepted;
}
async function acceptTerms(b, side, userId, guestToken) {
  await db.prepare('INSERT INTO booking_terms_acceptances (booking_id,side,user_id,guest_token,version,accepted_at) VALUES (?,?,?,?,?,?) ON CONFLICT(booking_id,side,version) DO NOTHING')
    .run(b.id, side, userId ?? null, guestToken || '', TX_TERMS_VERSION, now());
  return await termsStateFor(b);
}

/* ---- قاعدة «سكوت العميل = استلام مُعتبَر» (قرار المستخدم الصريح 2026-11-23
   «بدّلهم»): إثبات سليم + باقٍ محتجَز فعلياً عند Deal + سكوت كامل ٣ ساعات من
   اكتمال الشرطين (الأحدث منهما) بلا تأكيد ولا نزاع = اعتماد استلام تلقائي:
   يكتمل الحجز ويصبح المبلغ «جاهزاً للإفراج» (لا يتحرك المال نفسه أبداً —
   الإفراج يبقى فعل المالك اليدوي الموثّق). تفاعل العميل يوقف القاعدة:
   ملاحظة تحكيم/رسالة محادثة بعد الإثبات أو تحكيم مفتوح = العميل ليس ساكتاً
   فالمسار هو التحكيم وقرار المالك. للمالك حق العكس من لوحته (مسار مستقل). */
async function deemedBlocked(b) {
  if (await db.prepare('SELECT id FROM disputes WHERE booking_id=? AND status=? LIMIT 1').get(b.id, 'open')) return true;
  if (await openAppealFor(b.id)) return true;
  const noted = await db.prepare(`SELECT id FROM release_appeals WHERE booking_id=? AND client_note<>'' LIMIT 1`).get(b.id);
  if (noted) return true;
  if (b.proof_at) {
    const msg = await db.prepare(`SELECT id FROM guest_messages WHERE booking_id=? AND sender='guest' AND created_at>=? LIMIT 1`).get(b.id, b.proof_at);
    if (msg) return true;
  }
  return false;
}
async function deemedBaseAt(b) {
  // أساس عدّاد السكوت = وقت الإثبات السليم نفسه (النموذج بلا احتجاز: لا شرط مال).
  return b.proof_at || 0;
}
async function sweepDeemedReceipt() {
  const rows = await db.prepare(`SELECT * FROM bookings WHERE status='proof_submitted' AND receipt_confirmed_at=0 AND proof_check='verified' AND proof_at>0`).all();
  let fired = 0;
  for (const b of rows) {
    const base = await deemedBaseAt(b);
    if (!base || now() - base < DEEMED_AFTER_MS) continue;
    if (await deemedBlocked(b)) continue;
    const ob = await finalObligation(b.id);
    await db.prepare(`UPDATE bookings SET receipt_confirmed_at=?, receipt_auto=1, deemed_at=?, status='awaiting_rest' WHERE id=?`).run(now(), now(), b.id);
    if (ob) await moneyLedger(ob.id, ob.status, ob.status, 'system', 'اعتماد استلام مُعتبَر بقاعدة باينانس: سكوت العميل ٣ ساعات بعد إثبات سليم — اتفتحت خطوة دفع الباقي للمنفذ مباشرة (للمالك حق العكس عند ثبوت احتيال/خطأ)');
    await addBookingEvent(b.id, 'deemed_confirmed', 'يُعتبَر استلام المعاينة مؤكداً بقاعدة سكوت ٣ ساعات (نظام باينانس) — اتفتحت خطوة دفع الباقي للمنفذ');
    await notify(b.talent_id, 'deemed', `حجز #${b.id}: ⏱️ سكت العميل ٣ ساعات بعد إثباتك — يُعتبَر الاستلام مؤكداً بقاعدة باينانس، واتفتحت خطوة دفع الباقي لك مباشرة`, `booking:${b.id}`);
    if (b.client_id) await notify(b.client_id, 'deemed', `حجز #${b.id}: ⏱️ لم تؤكد الاستلام خلال ٣ ساعات من وصول الشغل — اعتُبر الاستلام مؤكداً بقاعدة باينانس واتفتحت خطوة دفع الباقي للمنفذ (مهلتها ٣ ساعات)`, `booking:${b.id}`);
    await notifyOwner('deemed', `حجز #${b.id}: ⏱️ اعتماد استلام مُعتبَر بقاعدة سكوت ٣ ساعات — اتفتحت خطوة الباقي (تستطيع عكس الاعتماد من لوحتك عند ثبوت خطأ/احتيال)`, `booking:${b.id}`);
    fired++;
  }
  return fired;
}

/* ---- اكتمال مُعتبَر: سكوت العميل ٣ ساعات بعد تسليم النسخة النهائية = تأكيد
   استلامها ضمنياً فيكتمل الحجز (القبض مؤكد قبلها أصلاً بشرط الاكتمال). */
async function sweepFinalDeemed() {
  const rows = await db.prepare(`SELECT * FROM bookings WHERE status='final_delivered' AND final_delivered_at>0 AND final_delivered_at<=?`).all(now() - DEEMED_AFTER_MS);
  let n = 0;
  for (const b of rows) {
    if (await db.prepare('SELECT id FROM disputes WHERE booking_id=? AND status=? LIMIT 1').get(b.id, 'open')) continue;
    await db.prepare(`UPDATE bookings SET final_confirmed_at=?, final_auto=1 WHERE id=?`).run(now(), b.id);
    await addBookingEvent(b.id, 'final_deemed', 'سكت العميل ٣ ساعات بعد تسليم النسخة النهائية — يُعتبَر استلامها مؤكداً واكتملت الصفقة');
    await notify(b.talent_id, 'deemed', `حجز #${b.id}: ⏱️ سكت العميل ٣ ساعات بعد تسليم النسخة النهائية — اعتُبر استلامها مؤكداً واكتملت الصفقة`, `booking:${b.id}`);
    if (b.client_id) await notify(b.client_id, 'deemed', `حجز #${b.id}: ⏱️ لم تؤكد استلام النسخة النهائية خلال ٣ ساعات من تسليمها — اعتُبر الاستلام مؤكداً بقاعدة باينانس واكتملت الصفقة`, `booking:${b.id}`);
    await tryCompleteFinal(await getBooking(b.id));
    n++;
  }
  return n;
}

/* ---- تصعيد طور التفاوض: ١٠ دقائق بلا حسم = انتقال تلقائي لقائمة مراجعة المالك. */
async function sweepAppealPhases() {
  const rows = await db.prepare(`SELECT * FROM release_appeals WHERE status='open' AND phase='negotiation' AND phase_deadline>0 AND phase_deadline<=?`).all(now());
  for (const a of rows) {
    await db.prepare(`UPDATE release_appeals SET phase='owner_review', escalated_at=? WHERE id=?`).run(now(), a.id);
    await addBookingEvent(a.booking_id, 'appeal_escalated', 'انتهت ١٠ دقائق التفاوض بلا حسم — صعّد التحكيم لمراجعة المالك');
    await notifyOwner('appeal_escalated', `⚖️ تحكيم #${a.id} على حجز #${a.booking_id}: انتهى طور التفاوض (١٠ دقائق) بلا حسم — صار في قائمة مراجعتك للقرار من الأدلة`, `booking:${a.booking_id}`);
    const b = await getBooking(a.booking_id);
    if (b) {
      await notify(b.talent_id, 'appeal', `حجز #${b.id}: ⚖️ انتهى طور التفاوض في التحكيم — المالك بيحسم دلوقتي من الأدلة`, `booking:${b.id}`);
      if (b.client_id) await notify(b.client_id, 'appeal', `حجز #${b.id}: ⚖️ انتهى طور التفاوض في التحكيم — المالك بيحسم دلوقتي من الأدلة`, `booking:${b.id}`);
    }
  }
  return rows.length;
}

/* ---- تنبيه بواقٍ عالقة (تحوّل تنبيه باينانس ١٥ دقيقة للنموذج المباشر): باقٍ
   قُبل استلام معاينته من أكثر من ١٥ دقيقة ولسه ما اتدفعش/ما اتأكدش قبضه =
   تنبيه واحد للمالك لكل حجز في «مستحقات قيد المتابعة». تنبيه فقط دائماً. */
async function sweepReleaseAlerts() {
  const rows = await db.prepare(`SELECT * FROM bookings WHERE status IN ('awaiting_rest','awaiting_final_delivery') AND escrow_alert_sent=0 AND receipt_confirmed_at>0 AND receipt_confirmed_at<=?`).all(now() - RELEASE_ALERT_MS);
  for (const b of rows) {
    await db.prepare('UPDATE bookings SET escrow_alert_sent=1 WHERE id=?').run(b.id);
    const rest = bookingLegAmounts(b).rest;
    await notifyOwner('rest_stuck', `🚨 حجز #${b.id}: باقٍ ${rest} ${b.currency} عالق من أكثر من ١٥ دقيقة بعد قبول الاستلام (لسه ما اتدفعش/ما اتأكدش قبضه) — تابع من «مستحقات قيد المتابعة»`, `booking:${b.id}`);
  }
  return rows.length;
}

/* ---- تنبيهات ما قبل الفوات (عدالة المهلات): قبل انتهاء مهلة خطوة دفع بـ٦٠
   دقيقة إشعار للدافع العضو (الضيف يرى العدّاد الحي في صفحته)، وقبل اعتماد
   الاستلام المُعتبَر بـ٦٠ دقيقة تحذير أخير للعميل. علم لكل التزام/حجز فلا تكرار. */
const WARN_BEFORE_MS = 60 * 60 * 1000;
async function sweepDeadlineWarnings() {
  let sent = 0;
  const obs = await db.prepare(`SELECT * FROM money_obligations WHERE status='open' AND warn_sent=0 AND expires_at>0 AND expires_at<=? AND expires_at>?`).all(now() + WARN_BEFORE_MS, now());
  for (const ob of obs) {
    await db.prepare('UPDATE money_obligations SET warn_sent=1 WHERE id=?').run(ob.id);
    if (ob.payer_user_id) {
      await notify(ob.payer_user_id, 'deadline_warn', `⏰ فاضل أقل من ساعة على انتهاء مهلة دفع معاملة ${ob.code}${ob.booking_id ? ` (حجز #${ob.booking_id})` : ''} — لو ما أعلنتش الدفع في المهلة هيتلغي الطلب تلقائياً`, ob.booking_id ? `booking:${ob.booking_id}` : `money:${ob.code}`);
      sent++;
    }
  }
  const rows = await db.prepare(`SELECT * FROM bookings WHERE status='proof_submitted' AND receipt_confirmed_at=0 AND proof_check='verified' AND proof_at>0 AND deemed_warn_sent=0`).all();
  for (const b of rows) {
    const base = await deemedBaseAt(b);
    if (!base) continue;
    const due = base + DEEMED_AFTER_MS;
    if (now() < due - WARN_BEFORE_MS || now() >= due) continue;
    if (await deemedBlocked(b)) continue;
    await db.prepare('UPDATE bookings SET deemed_warn_sent=1 WHERE id=?').run(b.id);
    if (b.client_id) {
      await notify(b.client_id, 'deemed_warn', `حجز #${b.id}: ⚠️ تحذير أخير — لو ما ردّيتش خلال ساعة (تأكيد استلام أو نزاع) هيُعتبَر استلام المعاينة مؤكداً تلقائياً بقاعدة باينانس وهتتفتح خطوة دفع الباقي للمنفذ`, `booking:${b.id}`);
      sent++;
    }
  }
  return sent;
}

/* تجميع كل المسوحات الزمنية — يُستدعى lazy من مسارات القراءة، ومن مسار مالك
   صريح (POST /api/owner/run-sweeps) ليستطيع cron خارجي لاحقاً تشغيله. */
async function runAllSweeps() {
  const out = {};
  try { out.step_expiry = await sweepStepExpiryCount(); } catch (e) { out.step_expiry = -1; }
  try { out.deemed = await sweepDeemedReceipt(); } catch (e) { out.deemed = -1; }
  try { out.final_deemed = await sweepFinalDeemed(); } catch (e) { out.final_deemed = -1; }
  try { out.appeal_phases = await sweepAppealPhases(); } catch (e) { out.appeal_phases = -1; }
  try { out.release_alerts = await sweepReleaseAlerts(); } catch (e) { out.release_alerts = -1; }
  try { out.deadline_warnings = await sweepDeadlineWarnings(); } catch (e) { out.deadline_warnings = -1; }
  return out;
}
async function sweepStepExpiryCount() {
  const before = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='cancelled'`).get()).c;
  await sweepStepExpiry();
  const after = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='cancelled'`).get()).c;
  return after - before;
}

/* ---- أعلام السلوك (إساءة/عدم تعاون في التحكيم): علمان مثبتان بقرار مالك =
   دخول سلم العقوبات القائم (تحذير ثم إيقاف عند ٤) — فوق البنية القائمة نفسها. */
async function applyBehaviorPenalty(userId) {
  if (!userId) return 0;
  const u = await getUser(userId);
  if (!u || u.banned) return 0;
  const n = (await db.prepare('SELECT COUNT(*) c FROM behavior_flags WHERE user_id=?').get(userId)).c;
  if (n >= 4 && u.penalty_level !== 'suspended') {
    await db.prepare('UPDATE users SET penalty_level=?, frozen=1 WHERE id=?').run('suspended', userId);
    await notify(userId, 'penalty', 'تم تعليق حسابك وتجميد رصيدك داخل المنصة: تكرار سلوك مسيء/غير متعاون في التحكيمات (٤ أعلام موثّقة بقرارات مالك)', '');
    await notifyOwner('penalty', `⛔ تعليق بسلم العقوبات: المستخدم #${userId} وصل ٤ أعلام سلوك في التحكيمات`, `user:${userId}`);
  } else if (n >= 2 && u.penalty_level === 'none') {
    await db.prepare('UPDATE users SET penalty_level=? WHERE id=?').run('warning', userId);
    await notify(userId, 'penalty', 'تنبيه رسمي: سُجّل عليك علما سلوك (إساءة/عدم تعاون) في تحكيمات بقرار مالك — تكراره يعلّق حسابك', '');
    await notifyOwner('penalty', `⚠️ تنبيه بسلم العقوبات: المستخدم #${userId} عنده علما سلوك في التحكيمات`, `user:${userId}`);
  }
  return n;
}

/* ---- Web Push (حزمة الإشعارات): اشتراك اختياري؛ المفاتيح من بيئة الخادم
   (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT) — بلا مفاتيح يتعطل
   Push بهدوء ويبقى الجرس الداخلي وحده. الإرسال مرآة لأحداث notify الجوهرية. */
let webPush = null, pushReady = false;
try {
  webPush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@deal.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    pushReady = true;
  }
} catch (e) { webPush = null; pushReady = false; }
const PUSH_TYPES = new Set(['booking', 'booking_new', 'appeal', 'appeal_closed', 'appeal_decided', 'appeal_escalated', 'dispute', 'escrow', 'escrow_ready', 'escrow_frozen', 'escrow_seen', 'escrow_missing', 'order_cancelled', 'money_auto', 'deemed', 'rest_overdue', 'rest_stuck', 'deemed_warn', 'deadline_warn', 'penalty', 'late_payment']);
async function pushMirror(userId, type, text, ref) {
  if (!pushReady || !webPush || !PUSH_TYPES.has(type)) return;
  const subs = await db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId);
  if (!subs.length) return;
  const payload = JSON.stringify({ title: 'Deal', body: String(text || '').slice(0, 180), ref: ref || '', type });
  for (const sub of subs) {
    try {
      await webPush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600 });
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
      }
    }
  }
}

app.post('/api/bookings', auth, async (req, res) => {
  const { talent_id, title = '', price, source = 'direct', ref_id = null, deadline_days = 7, urgent = 0 } = req.body || {};
  const talent = await getUser(+talent_id);
  if (!talent || !['creator', 'provider'].includes(talent.role)) return res.status(400).json({ error: 'المنفذ غير صحيح' });
  if (talent.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس — عرض فقط ولا يقبل حجوزات أو تواصلاً' });
  if (talent.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حجز نفسك' });
  if (talent.penalty_level === 'suspended' || talent.frozen) return res.status(403).json({ error: 'هذا الحساب معلّق حالياً ولا يستقبل حجوزات' });
  const p = price != null ? +price : talent.price;
  if (!p || p <= 0) return res.status(400).json({ error: 'حدد سعراً صحيحاً' });
  const info = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,urgent,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, talent.id, source, ref_id, title || `حجز مع ${talent.name}`, p, talent.currency, now() + deadline_days * 24 * 3600 * 1000, urgent ? 1 : 0, now());
  await addBookingEvent(info.lastInsertRowid, 'created', 'أُنشئ الحجز — الضمان والمراحل موثّقة داخل Deal');
  await notify(talent.id, 'booking_new', `طلب حجز جديد #${info.lastInsertRowid} بقيمة ${p} ${talent.currency}${urgent ? ' · 🔥 مستعجل — تنفيذ اليوم' : ''}`, `booking:${info.lastInsertRowid}`);
  res.json({ booking: await bookingView(await getBooking(info.lastInsertRowid), req.user) });
});

app.get('/api/bookings', auth, async (req, res) => {
  await runAllSweeps();
  const rows = await db.prepare('SELECT * FROM bookings WHERE client_id=? OR talent_id=? ORDER BY created_at DESC').all(req.user.id, req.user.id);
  res.json({ items: await Promise.all(rows.map(b => bookingView(b, req.user))) });
});

app.get('/api/bookings/:id', auth, async (req, res) => {
  await runAllSweeps();
  const b = await getBooking(+req.params.id);
  if (!b || (b.client_id !== req.user.id && b.talent_id !== req.user.id && !req.user.is_platform_founder)) return res.status(404).json({ error: 'غير موجود' });
  res.json({ booking: await bookingView(b, req.user) });
});

/* إجراءات طرف العميل في آلة حالات الحجز — مشتركة بين العميل المسجل وعميل الضيف
   (صفحة الرمز) حتى لا تتكرر آلة الحالات. كل دالة تعيد {error} أو {booking}. */
async function applyAgree(b, side) {
  if (b.status !== 'pending_agreement') return { error: 'الحجز تجاوز مرحلة الاتفاق' };
  if (side === 'client') await db.prepare('UPDATE bookings SET agreed_client=1 WHERE id=?').run(b.id);
  else await db.prepare('UPDATE bookings SET agreed_talent=1 WHERE id=?').run(b.id);
  let nb = await getBooking(b.id);
  if (nb.agreed_client && nb.agreed_talent) {
    await db.prepare(`UPDATE bookings SET status='awaiting_fee' WHERE id=?`).run(b.id);
    await notify(nb.client_id, 'booking', `حجز #${b.id}: اتفق الطرفان — خطوة العمولة أولاً`, `booking:${b.id}`);
    await notify(nb.talent_id, 'booking', `حجز #${b.id}: اتفق الطرفان — في انتظار تأكيد عمولة Deal`, `booking:${b.id}`);
    nb = await getBooking(b.id);
  }
  return { booking: nb };
}

async function applyClientPayment(b, kind, ref) {
  const fee = Math.round(b.price * COMMISSION_RATE * 100) / 100;
  const net = b.price - fee, half = Math.round(net / 2 * 100) / 100;
  if (kind === 'fee') {
    if (b.status !== 'awaiting_fee') return { error: 'خطوة العمولة ليست مفتوحة' };
    await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at) VALUES (?,?,?,?,?,?)').run(b.id, 'fee', fee, ref, 'confirmed', now());
    await db.prepare(`UPDATE bookings SET fee_status='confirmed', fee_ref=?, fee_confirmed_at=?, status='awaiting_deposit' WHERE id=?`).run(ref, now(), b.id);
    await notify(b.talent_id, 'booking', `حجز #${b.id}: تأكدت عمولة Deal — العربون اتفتح`, `booking:${b.id}`);
  } else if (kind === 'deposit') {
    if (b.status !== 'awaiting_deposit') return { error: 'العربون غير مفتوح الآن' };
    await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at) VALUES (?,?,?,?,?,?)').run(b.id, 'deposit', half, ref, 'confirmed', now());
    await db.prepare(`UPDATE bookings SET status='in_progress' WHERE id=?`).run(b.id);
    await notify(b.talent_id, 'booking', `حجز #${b.id}: وصلك العربون ${half} — ابدأ التنفيذ`, `booking:${b.id}`);
  } else if (kind === 'rest') {
    /* الباقي مباشرة للمنفذ (لا احتجاز عند Deal): تسجيل المرجع «ادعاء» فقط —
       القبض يتأكد بمطابقة إيصال صارمة على رقم المنفذ أو بـ«وصلني» من المنفذ
       نفسه، وبعدها تُسلَّم النسخة النهائية ويكتمل الحجز بتأكيد استلامها أو
       بسكوت العميل ٣ ساعات. الخطوة تُفتح فقط بعد قبول استلام المعاينة. */
    if (!['awaiting_rest', 'rest_overdue'].includes(b.status)) return { error: 'الباقي غير مفتوح الآن — بيفتح بعد تأكيد استلام المعاينة' };
    const prev = await restPaymentRow(b.id);
    if (prev && ['claimed', 'confirmed'].includes(prev.status)) return { error: 'سجّلت تحويل الباقي من قبل — التحويلة عند المنفذ للتحقق من قبضها' };
    await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at) VALUES (?,?,?,?,?,?)').run(b.id, 'rest', half, ref, 'claimed', now());
    if (b.status === 'rest_overdue') await db.prepare(`UPDATE bookings SET status='awaiting_rest' WHERE id=?`).run(b.id);
    await notify(b.talent_id, 'booking', `حجز #${b.id}: العميل سجّل تحويل الباقي لك مباشرة — أكّد قبضه من محفظتك بـ«وصلني» بعد ما يوصلك فعلياً، وبعدها سلّم النسخة النهائية`, `booking:${b.id}`);
  } else return { error: 'نوع دفعة غير صحيح' };
  const legAr = { fee: 'عمولة Deal', deposit: 'العربون', rest: 'الدفعة الأخيرة' }[kind] || kind;
  await addBookingEvent(b.id, 'paid_claimed', `أعلن العميل دفع ${legAr} وسجّل مرجع التحويلة`);
  return { booking: await getBooking(b.id) };
}

async function applyConfirmReceipt(b) {
  if (b.status !== 'proof_submitted') return { error: 'لا يوجد إثبات بانتظار التأكيد' };
  await db.prepare(`UPDATE bookings SET receipt_confirmed_at=?, receipt_auto=0 WHERE id=?`).run(now(), b.id);
  /* تأكيد العميل أثناء مراجعة قائمة: الحجز يكمل مساره الطبيعي فوراً وطلب
     المراجعة يُغلق تلقائياً (لم يعد له موضوع) ويُعلَم المالك. */
  const openAp = await openAppealFor(b.id);
  if (openAp) {
    await closeOpenAppeal(b.id, 'closed_confirmed');
    await notifyOwner('appeal_closed', `✅ حجز #${b.id}: العميل أكد الاستلام بنفسه — أُغلق طلب مراجعة الإفراج #${openAp.id} تلقائياً`, `booking:${b.id}`);
    await notify(b.talent_id, 'appeal', `حجز #${b.id}: العميل أكد الاستلام — أُغلق طلب المراجعة بتاعك تلقائياً`, `booking:${b.id}`);
  }
  await addBookingEvent(b.id, 'receipt_confirmed', 'أكّد العميل استلام الشغل (المعاينة) بنفسه — اتفتحت خطوة دفع الباقي');
  await db.prepare(`UPDATE bookings SET status='awaiting_rest' WHERE id=?`).run(b.id);
  const ob = await finalObligation(b.id);
  if (ob && ['confirmed', 'auto_confirmed'].includes(ob.status)) {
    // قبض الباقي تأكد أصلاً (إيصال سبق التأكيد) → خطوة التسليم النهائي مباشرة.
    await syncFinalLeg(b.id);
  } else {
    await notify(b.talent_id, 'booking', `حجز #${b.id}: العميل أكد الاستلام — الباقي بيتحوّل لك مباشرة من العميل، والنسخة النهائية ما تتسلّمش إلا بعد تأكيد قبضه`, `booking:${b.id}`);
  }
  return { booking: await getBooking(b.id) };
}

/* علم «مستعجل — تنفيذ اليوم» على حجز قائم: من العميل المسجل صاحب الحجز فقط. */
app.post('/api/bookings/:id/urgent', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b) return res.status(404).json({ error: 'غير موجود' });
  if (b.client_id !== req.user.id) return res.status(403).json({ error: 'علم المستعجل من العميل صاحب الحجز فقط' });
  if (['completed', 'cancelled'].includes(b.status)) return res.status(400).json({ error: 'الحجز انتهى' });
  await db.prepare('UPDATE bookings SET urgent=? WHERE id=?').run((req.body || {}).urgent ? 1 : 0, b.id);
  res.json({ booking: await bookingView(await getBooking(b.id), req.user) });
});

app.post('/api/bookings/:id/agree', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b) return res.status(404).json({ error: 'غير موجود' });
  const side = req.user.id === b.client_id ? 'client' : req.user.id === b.talent_id ? 'talent' : null;
  if (!side) return res.status(403).json({ error: 'لست طرفاً في الحجز' });
  const r = await applyAgree(b, side);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await bookingView(r.booking, req.user) });
});

/** Commission number: ONLY to the paying client, ONLY at the fee step of a confirmed booking. */
app.get('/api/bookings/:id/fee-info', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.client_id !== req.user.id) return res.status(403).json({ error: 'غير متاح' });
  if (b.status !== 'awaiting_fee' || b.fee_status === 'confirmed') return res.status(400).json({ error: 'خطوة العمولة غير مفتوحة الآن' });
  // خطوة الدفع بدأت: يُنشأ/يُجلب التزام العمولة بمرجعه المالي الموحد (كود + مبلغ ببصمة).
  const ob = await getOrCreateObligation({
    kind: 'booking_commission', booking_id: b.id, user_id: b.talent_id,
    base_amount: bookingLegAmounts(b).fee, currency: b.currency,
    payer_user_id: req.user.id, payee: 'owner',
  });
  const colFee = await collectorForObligation(ob);
  res.json({ label: 'Deal — حساب عمولات المنصة', phone: colFee.phone, collector_via: colFee.via, methods: ['Vodafone Cash', 'InstaPay'], amount: Math.round(b.price * COMMISSION_RATE * 100) / 100, currency: b.currency, obligation: await payerObligationView(ob, req.user.country) });
});

/* قبول «شروط المعاملات» من طرف عضو (عميل/منفذ) — مسجّل خادمياً بالإصدار والوقت. */
app.post('/api/bookings/:id/terms-accept', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b) return res.status(404).json({ error: 'غير موجود' });
  const side = req.user.id === b.client_id ? 'client' : req.user.id === b.talent_id ? 'talent' : null;
  if (!side) return res.status(403).json({ error: 'لست طرفاً في الحجز' });
  const st = await acceptTerms(b, side, req.user.id, '');
  res.json({ terms: st, booking: await bookingView(await getBooking(b.id), req.user) });
});
/* وثيقة «شروط المعاملات» الحالية بنصها الكامل (للحوار والروابط الدائمة). */
app.get('/api/terms/transactions', (req, res) => {
  res.json({ version: TX_TERMS.version, items_ar: TX_TERMS.ar, items_en: TX_TERMS.en });
});

app.post('/api/bookings/:id/pay', auth, async (req, res) => {
  const { kind, ref } = req.body || {};
  const b = await getBooking(+req.params.id);
  if (!b || b.client_id !== req.user.id) return res.status(403).json({ error: 'الدفع من العميل فقط' });
  if (!ref) return res.status(400).json({ error: 'مرجع العملية مطلوب' });
  if (!(await termsGateOpen(b))) return res.status(403).json({ error: 'خطوات الدفع مقفلة حتى يقبل الطرفان «شروط المعاملات» — اقرأها ووافق عليها أولاً من صفحة الحجز', terms_required: true, terms: await termsStateFor(b) });
  const r = await applyClientPayment(b, kind, ref);
  if (r.error) return res.status(400).json({ error: r.error });
  // ربط الدفعة بالتزامها المالي (ادعاء بمرجع — التأكيد بعوامل أخرى كما هو موثق).
  try { await claimObligationForPayment(r.booking, kind, ref, 'user'); } catch (e) { /* الربط لا يعطّل الدفع */ }
  res.json({ booking: await bookingView(r.booking, req.user) });
});

app.post('/api/bookings/:id/proof', auth, async (req, res) => {
  const { url } = req.body || {};
  const b = await getBooking(+req.params.id);
  if (!b || b.talent_id !== req.user.id) return res.status(403).json({ error: 'الإثبات من المنفذ فقط' });
  if (b.status !== 'in_progress') return res.status(400).json({ error: 'الحجز ليس في مرحلة التنفيذ' });
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'رابط غير صحيح' });
  let ok = false;
  try {
    const r = await fetch(url, { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 (DealProof)' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    ok = r.status === 200;
  } catch (e) { ok = false; }
  if (!ok) return res.status(400).json({ error: 'تعذر التحقق: الرابط لا يعمل أو غير علني (لازم HTTP 200)' });
  await db.prepare(`UPDATE bookings SET proof_url=?, proof_at=?, proof_check='verified', status='proof_submitted' WHERE id=?`).run(url, now(), b.id);
  // تقديم الإثبات بعد استلام العربون والعمل عليه = عامل تأكيد التزام العربون.
  try { await settleLegObligation(b.id, 'booking_deposit', 'قدّم المنفذ إثبات التنفيذ'); } catch (e) { /* لا يعطّل الإثبات */ }
  await notify(b.client_id, 'booking', `حجز #${b.id}: المنفذ قدم إثبات التنفيذ — أكد الاستلام`, `booking:${b.id}`);
  res.json({ booking: await bookingView(await getBooking(b.id), req.user) });
});

app.post('/api/bookings/:id/confirm-receipt', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.client_id !== req.user.id) return res.status(403).json({ error: 'التأكيد من العميل فقط' });
  const r = await applyConfirmReceipt(b);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await bookingView(r.booking, req.user) });
});

/* فتح نزاع — آلة مشتركة بين العميل العضو والعميل الضيف (من صفحة رمزه):
   تجميد فوري للمحتجَز + حزمة أدلة + إغلاق أي طلب مراجعة إفراج قائم لصالح
   مسار النزاع (المراجعة تُعلَّق/تُغلق والنزاع هو المسار الحاكم). */
async function applyOpenDispute(b, openedBy, reason) {
  if (['cancelled', 'disputed', 'completed'].includes(b.status)) return { error: 'لا يمكن فتح نزاع الآن' };
  const info = await db.prepare('INSERT INTO disputes (booking_id,opened_by,reason,created_at) VALUES (?,?,?,?)').run(b.id, openedBy, reason, now());
  await addBookingEvent(b.id, 'dispute_opened', 'فُتح نزاع على الحجز — تجمّد تقدم الحجز فوراً لحد قرار المالك');
  await db.prepare(`UPDATE bookings SET prev_status=status, status='disputed' WHERE id=?`).run(b.id);
  await closeOpenAppeal(b.id, 'closed_dispute');
  /* لا مال عند المنصة يتجمد (النموذج بلا احتجاز): التجميد على تقدم الحجز
     نفسه — لا خطوات دفع ولا تسليم ولا اكتمال حتى قرار المالك. و«حزمة الأدلة»
     تُولَّد تلقائياً من سجل الحجز وتُحفظ مع النزاع. */
  const nb = await getBooking(b.id);
  try {
    const bundle = await buildEvidenceBundle(nb);
    await db.prepare('UPDATE disputes SET evidence=? WHERE id=?').run(JSON.stringify(bundle), info.lastInsertRowid);
  } catch (e) { /* توليد الحزمة لا يعطّل فتح النزاع أبداً */ }
  const founder = await db.prepare('SELECT id FROM users WHERE is_platform_founder=1').get();
  if (founder) await notify(founder.id, 'dispute', `نزاع جديد على حجز #${b.id}`, `booking:${b.id}`);
  return { dispute_id: info.lastInsertRowid, alternatives: await verifiedAlternatives(b) };
}

app.post('/api/bookings/:id/dispute', auth, async (req, res) => {
  const { reason = '' } = req.body || {};
  const b = await getBooking(+req.params.id);
  if (!b || (b.client_id !== req.user.id && b.talent_id !== req.user.id)) return res.status(403).json({ error: 'لست طرفاً' });
  /* النزاع مفتوح في كل المراحل النشطة حتى الاكتمال؛ بعد الاكتمال تنتهي
     مراحل الحجز فتُقفل بوابة النزاع (يبقى التقييم والبلاغات عبر الدعم). */
  const r = await applyOpenDispute(b, req.user.id, reason);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

/* ---------------- طلب مراجعة الإفراج (نموذج باينانس) ----------------
   المقدم يطلب، والعميل يُنبَّه فوراً ويقدر قبل قرار المالك: يؤكد الاستلام
   (اكتمال طبيعي فوري + إغلاق المراجعة)، أو يفتح نزاعاً (تجميد فوري + إغلاق
   المراجعة لصالح النزاع)، أو يرد بملاحظة تظهر للمالك داخل المراجعة. قرار
   المالك نهائي داخل المنصة وموثّق: «إفراج» = تأكيد استلام موثّق بقرار
   مراجعة يُسجَّل في money_ledger برقم المراجعة، و«رد» = مسار رد المحتجَز. */
app.post('/api/bookings/:id/appeal', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.talent_id !== req.user.id) return res.status(403).json({ error: 'طلب المراجعة من المنفذ صاحب الحجز فقط' });
  if (b.status !== 'proof_submitted' || b.proof_check !== 'verified' || !(b.proof_at > 0)) return res.status(400).json({ error: 'طلب المراجعة يحتاج إثبات تنفيذ مُسلَّماً وصحيحاً وعميلاً لم يؤكد الاستلام بعد' });
  if (await db.prepare('SELECT id FROM disputes WHERE booking_id=? AND status=? LIMIT 1').get(b.id, 'open')) return res.status(400).json({ error: 'يوجد نزاع مفتوح على الحجز — المراجعة متوقفة لمسار النزاع' });
  if (await openAppealFor(b.id)) return res.status(400).json({ error: 'عندك طلب مراجعة قائم على الحجز ده — بانتظار قرار المالك' });
  /* مهلة إعادة التحكيم (باينانس): من ألغى تحكيمه بنفسه لا يفتح آخر على نفس
     الحجز قبل ٥ دقائق من إلغائه. */
  const lastCancelled = await db.prepare(`SELECT * FROM release_appeals WHERE booking_id=? AND status='cancelled_by_talent' ORDER BY id DESC LIMIT 1`).get(b.id);
  if (lastCancelled && lastCancelled.decided_at && now() - lastCancelled.decided_at < REAPPEAL_COOLDOWN_MS) {
    const leftMin = Math.ceil((REAPPEAL_COOLDOWN_MS - (now() - lastCancelled.decided_at)) / 60000);
    return res.status(400).json({ error: `ألغيت تحكيمك بنفسك من شوية — تقدر تفتح تحكيماً جديداً بعد ${leftMin} دقيقة (مهلة باينانس ٥ دقائق)`, reappeal_in_ms: REAPPEAL_COOLDOWN_MS - (now() - lastCancelled.decided_at) });
  }
  const waited = now() - b.proof_at;
  if (waited < APPEAL_AFTER_MS) {
    const leftMin = Math.ceil((APPEAL_AFTER_MS - waited) / 60000);
    return res.status(400).json({ error: `طلب المراجعة يفتح بعد ٣ ساعات من تسليم الإثبات — باقي ${leftMin} دقيقة`, appeal_in_ms: APPEAL_AFTER_MS - waited });
  }
  const info = await db.prepare('INSERT INTO release_appeals (booking_id,talent_id,phase,phase_deadline,created_at) VALUES (?,?,?,?,?)').run(b.id, req.user.id, 'negotiation', now() + NEGOTIATION_MS, now());
  const appeal = await db.prepare('SELECT * FROM release_appeals WHERE id=?').get(info.lastInsertRowid);
  await addBookingEvent(b.id, 'appeal_opened', 'فُتح تحكيم (طلب مراجعة إفراج) — طور تفاوض ١٠ دقائق بين الطرفين أولاً (نظام باينانس)');
  if (b.client_id) await notify(b.client_id, 'appeal', `حجز #${b.id}: ⚖️ المنفذ طلب مراجعة لاعتماد الاستلام — عندك ١٠ دقائق تفاوض: لو الشغل وصلك أكد الاستلام دلوقتي فتتفتح خطوة دفع الباقي فوراً، ولو عندك اعتراض افتح نزاعاً أو سيب ملاحظة للمالك من صفحة الحجز`, `booking:${b.id}`);
  await notifyOwner('appeal', `⚖️ طلب مراجعة اعتماد استلام #${appeal.id} على حجز #${b.id} — راجع حزمة الأدلة واحسم: لصالح المنفذ أو لصالح العميل`, `booking:${b.id}`);
  res.json({ appeal: appealView(appeal), booking: await bookingView(await getBooking(b.id), req.user) });
});

/* إلغاء المنفذ لتحكيمه بنفسه: يُقفل الطلب بحالة موثّقة ويبدأ عدّاد مهلة
   إعادة التحكيم (٥ دقائق) من لحظة الإلغاء. */
app.post('/api/bookings/:id/appeal-cancel', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.talent_id !== req.user.id) return res.status(403).json({ error: 'إلغاء التحكيم من المنفذ صاحب الطلب فقط' });
  const ap = await openAppealFor(b.id);
  if (!ap) return res.status(400).json({ error: 'لا يوجد طلب مراجعة قائم على الحجز' });
  await db.prepare(`UPDATE release_appeals SET status='cancelled_by_talent', decided_at=?, decision=? WHERE id=?`)
    .run(now(), 'ألغى المنفذ طلبه بنفسه أثناء التفاوض/المراجعة', ap.id);
  await addBookingEvent(b.id, 'appeal_cancelled', 'ألغى المنفذ تحكيمه بنفسه — إعادة التحكيم متاحة بعد ٥ دقائق');
  if (b.client_id) await notify(b.client_id, 'appeal_closed', `حجز #${b.id}: المنفذ ألغى طلب مراجعة الإفراج بنفسه`, `booking:${b.id}`);
  await notifyOwner('appeal_closed', `حجز #${b.id}: المنفذ ألغى طلب مراجعة الإفراج #${ap.id} بنفسه`, `booking:${b.id}`);
  res.json({ ok: true, booking: await bookingView(await getBooking(b.id), req.user) });
});

/* ملاحظة العميل داخل طلب مراجعة قائم — مشتركة بين العضو والضيف. */
async function applyAppealNote(b, note) {
  const ap = await openAppealFor(b.id);
  if (!ap) return { error: 'لا يوجد طلب مراجعة قائم على الحجز' };
  const txt = String(note || '').trim().slice(0, 1000);
  if (!txt) return { error: 'اكتب ملاحظتك أولاً' };
  await db.prepare('UPDATE release_appeals SET client_note=? WHERE id=?').run(txt, ap.id);
  await notifyOwner('appeal_note', `💬 حجز #${b.id}: العميل سيب ملاحظة في طلب مراجعة الإفراج #${ap.id} — شوفها من لوحتك قبل القرار`, `booking:${b.id}`);
  return { appeal: appealView(await db.prepare('SELECT * FROM release_appeals WHERE id=?').get(ap.id)) };
}
app.post('/api/bookings/:id/appeal-note', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.client_id !== req.user.id) return res.status(403).json({ error: 'الملاحظة من عميل الحجز فقط' });
  const r = await applyAppealNote(b, (req.body || {}).note);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

/* ---------------- reviews ---------------- */
app.post('/api/bookings/:id/review', auth, async (req, res) => {
  const { sentiment, stars = 5, comment = '' } = req.body || {};
  const b = await getBooking(+req.params.id);
  if (!b) return res.status(404).json({ error: 'غير موجود' });
  if (b.status !== 'completed') return res.status(400).json({ error: 'التقييم بعد اكتمال القبض فقط' });
  if (req.user.id !== b.client_id && req.user.id !== b.talent_id) return res.status(403).json({ error: 'لست طرفاً' });
  if (!['positive', 'negative'].includes(sentiment)) return res.status(400).json({ error: 'اختر إيجابي أو سلبي' });
  const reviewee = req.user.id === b.client_id ? b.talent_id : b.client_id;
  try {
    await db.prepare('INSERT INTO reviews (booking_id,reviewer_id,reviewee_id,sentiment,stars,comment,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(b.id, req.user.id, reviewee, sentiment, Math.min(5, Math.max(1, stars)), comment, now());
  } catch (e) { return res.status(409).json({ error: 'قيّمت هذا الحجز من قبل — التقييم لا يُعدّل' }); }
  await applyPenalties(reviewee);
  await syncBadges(reviewee);
  res.json({ ok: true });
});

/* ---------------- shop requests + opportunities ---------------- */
app.post('/api/requests', auth, async (req, res) => {
  const { title, niche = '', city = '', budget = 0, details = '', urgent = 0 } = req.body || {};
  if (!title) return res.status(400).json({ error: 'عنوان الطلب مطلوب' });
  // دولة الطلب وعملته من حساب الناشر نفسه (مشتقة من دولته) — لا من العميل.
  const info = await db.prepare('INSERT INTO shop_requests (shop_user_id,title,niche,city,budget,currency,details,country,urgent,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, title, niche, city || req.user.city, budget, req.user.currency || 'EGP', details, req.user.country || 'EG', urgent ? 1 : 0, now());
  res.json({ id: info.lastInsertRowid });
});
app.get('/api/requests', async (req, res) => {
  // رقم هاتف الضيف لا يظهر لأي صانع/مقدم خدمة (التواصل داخل المنصة فقط) — المالك المؤسس وحده يراه
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = token && await db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  const sUser = s ? await db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id) : null;
  const rows = await db.prepare(`SELECT r.id, r.shop_user_id, r.title, r.niche, r.city, r.budget, r.currency, r.details, r.status, r.created_at, r.is_guest, r.guest_phone, r.country, r.urgent, COALESCE(u.name, r.guest_name) AS shop_name FROM shop_requests r LEFT JOIN users u ON u.id=r.shop_user_id WHERE r.status='open' AND r.target_talent_id IS NULL ORDER BY r.urgent DESC, r.created_at DESC`).all();
  const items = rows.map(r => {
    const it = { ...r, is_guest: !!r.is_guest, urgent: !!r.urgent };
    if (!(sUser && sUser.is_platform_founder)) delete it.guest_phone;
    return it;
  });
  res.json({ items });
});

function matchScore(creator, item) {
  let score = 0; const reasons = [];
  if (item.city && creator.city && item.city === creator.city) { score += 40; reasons.push('نفس المدينة'); }
  if (item.niche && creator.niche && item.niche === creator.niche) { score += 40; reasons.push('نفس المجال'); }
  const minOk = !creator.min_price_pref || (item.budget || 0) >= creator.min_price_pref;
  if (minOk && item.budget > 0) { score += 20; reasons.push('الميزانية مناسبة'); }
  return { score, reasons };
}
app.get('/api/opportunities', auth, async (req, res) => {
  if (!['creator', 'provider'].includes(req.user.role)) return res.json({ items: [] });
  // الطلب الموجّه (target_talent_id) لا يظهر إلا لمستهدَفه وحده — لا في القائمة
  // العامة ولا في فرص غيره — ويُقدَّم له بمطابقة كاملة وسبب صريح.
  const reqs = (await db.prepare(`SELECT * FROM shop_requests WHERE status='open' AND (target_talent_id IS NULL OR target_talent_id=?)`).all(req.user.id))
    .map(r => {
      const { guest_token, guest_phone, ...rest } = r;
      const targeted = r.target_talent_id === req.user.id;
      const it = { kind: 'request', ...rest, is_guest: !!r.is_guest, targeted, ...matchScore(req.user, r) };
      if (targeted) { it.score = 100; it.reasons = ['طلب موجّه ليك مباشرة', ...it.reasons.filter((x) => x !== 'الميزانية مناسبة')]; }
      return it;
    });
  const camps = req.user.role === 'creator'
    ? (await db.prepare(`SELECT * FROM campaigns WHERE status='open'`).all())
      .map(c => ({ kind: 'campaign', ...c, ...matchScore(req.user, c) }))
    : [];
  // مقدم الخدمة يرى في «فرص ليك» ما وُجّه إليه فقط؛ الصانع يرى كل ما يطابقه كالمعتاد.
  // «مستعجل — تنفيذ اليوم» أولوية عرض صريحة: يتصدّر القائمة قبل فرز المطابقة.
  const items = [...reqs, ...camps]
    .filter(x => req.user.role === 'provider' ? x.targeted : x.score > 0)
    .sort((a, b) => ((b.urgent ? 1 : 0) - (a.urgent ? 1 : 0)) || b.score - a.score);
  // باقة نجم Deal — «ترشيح أول» داخل فرص المشترك نفسه: المطابقات القوية (80%+)
  // تُعلَّم كترشيحات أولى ذهبية للمشترك النشط فقط، والفرز بالمطابقة كما هو.
  if (await isStar(req.user.id)) {
    for (const it of items) if (it.score >= 80) it.star_pick = true;
  }
  res.json({ items });
});

/* ---------------- guest client requests (طلب عميل بدون تسجيل) ----------------
   العميل (محل/براند) ينشر طلبه كضيف: بلا حساب وبلا كلمة سر. هويته في المتابعة
   هي رمز وصول عشوائي طويل (token) يُحفظ على الطلب ثم على الحجز عند التحويل،
   وخطواته في الحجز تتم من صفحة الرمز بنفس آلة الحالات المشتركة أعلاه. */
const GUEST_OPEN_LIMIT = 3; // أقصى طلبات ضيف مفتوحة لنفس البصمة — حد خفيف ضد الإغراق
/* جولة التصميم السينمائي (قرار المستخدم): حقل هاتف الضيف أُزيل نهائياً من
   النموذج — فالمحادثة والمتابعة داخل المنصة أصلاً، ولا لزوم لرقم الموبايل.
   الخادم لا يطلب هاتفاً ولا يتحقق منه ولا يفحص «رقم عضو» في هذه القناة؛ أي
   حقل phone مرسل يُتجاهل ولا يُخزَّن (عمود guest_phone يبقى للصفوف القديمة
   فقط ويُكتب '' للجديد). حدّ الطلبات المفتوحة انتقل لبصمة جهاز/متصفح + IP:
   بصمة = SHA-256(IP + معرّف جهاز يرسله العميل + وكيل المستخدم) — لا تُعرَض
   ولا تُشارَك، ووظيفتها حدّ الإغراق فقط. مفتاح الضيف الوحيد هو رمز المتابعة. */
const GUEST_SESSION_ERR = 'أنت مسجل الدخول بحساب عضو — قناة الضيف للعملاء من غير حسابات فقط، اطلب من داخل حسابك · You are logged in as a member — the guest channel is for clients without accounts; please order from your account';
function guestFingerprint(req) {
  const device = String((req.body || {}).device_id || '').slice(0, 80);
  const ip = (req.ip || (req.connection && req.connection.remoteAddress) || '');
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  return crypto.createHash('sha256').update(`${ip}|${device}|${ua}`).digest('hex');
}

app.post('/api/guest-requests', async (req, res) => {
  const { business_name, city, niche, budget, details = '', title, target_talent_id } = req.body || {};
  // جلسة عضو قائمة = القناة مغلقة لهذا الطلب أصلاً (الرفض على الخادم، والواجهة
  // تعطّل النموذج للمسجلين أيضاً) — التصفح العام وحده يبقى مفتوحاً للجميع.
  if (await optionalViewer(req)) return res.status(403).json({ error: GUEST_SESSION_ERR });
  if (!business_name || !String(business_name).trim()) return res.status(400).json({ error: 'اسم النشاط مطلوب' });
  // دولة العميل الضيف (افتراضي مصر): عملة الطلب تُشتق من الدولة. لا هاتف في
  // هذه القناة إطلاقاً (أُزيل الحقل بقرار المستخدم) — التواصل والمتابعة من
  // صفحة الرمز داخل المنصة فقط.
  const guestCountry = countryOf((req.body || {}).country || 'EG');
  if (!guestCountry) return res.status(400).json({ error: 'دولة غير مدعومة حالياً' });
  if (!city || !String(city).trim()) return res.status(400).json({ error: 'المدينة مطلوبة' });
  if (!niche || !String(niche).trim()) return res.status(400).json({ error: 'نوع الإعلان / المجال مطلوب' });
  if (budget == null || budget === '' || !isFinite(+budget) || +budget < 0) return res.status(400).json({ error: 'ميزانية تقريبية صحيحة مطلوبة' });
  if (!details || !String(details).trim()) return res.status(400).json({ error: 'اوصف الخدمة المطلوبة' });
  // استهداف اختياري: الطلب يوجَّه لصانع/مقدم خدمة بعينه — يُتحقق أنه موجود فعلاً
  // وأنه عضو قابل للطلب (صانع أو مقدم خدمة، غير محظور)، والمؤسس مرفوض صراحة
  // لأنه حساب عرض فقط لا يقبل طلبات إطلاقاً.
  let targetId = null;
  if (target_talent_id != null && target_talent_id !== '') {
    targetId = +target_talent_id;
    const target = Number.isInteger(targetId) && targetId > 0 ? await getUser(targetId) : null;
    if (!target || target.banned || !['creator', 'provider'].includes(target.role)) {
      return res.status(400).json({ error: 'الصانع المستهدف غير موجود' });
    }
    if (target.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس — عرض فقط ولا يقبل طلبات' });
  }
  const fp = guestFingerprint(req);
  const openCount = (await db.prepare(`SELECT COUNT(*) c FROM shop_requests WHERE is_guest=1 AND guest_fp=? AND status='open'`).get(fp)).c;
  if (openCount >= GUEST_OPEN_LIMIT) return res.status(429).json({ error: 'عندك طلبات مفتوحة كتير — استنى لما طلب يتقفل الأول · Too many open requests — please wait until one of them closes' });
  const token = rnd(24);
  const urgent = (req.body || {}).urgent ? 1 : 0;
  const info = await db.prepare(`INSERT INTO shop_requests (shop_user_id,title,niche,city,budget,currency,details,status,is_guest,guest_name,guest_phone,guest_fp,guest_token,target_talent_id,country,urgent,created_at) VALUES (NULL,?,?,?,?,?,?,'open',1,?,?,?,?,?,?,?,?)`)
    .run(title && String(title).trim() ? String(title).trim() : `طلب إعلان — ${String(business_name).trim()}`, niche, city, +budget, guestCountry.currency, details, String(business_name).trim(), '', fp, token, targetId, guestCountry.code, urgent, now());
  if (targetId) {
    await notify(targetId, 'guest_targeted',
      `🎯 طلب موجّه ليك مباشرة من عميل «${String(business_name).trim()}» — ${niche} · ${city} · ميزانية ${+budget}${urgent ? ' · 🔥 مستعجل — تنفيذ اليوم' : ''} — افتح «فرص ليك» لتحويله لحجز بضمان Deal`,
      `request:${info.lastInsertRowid}`);
  }
  res.json({ id: info.lastInsertRowid, token, follow: `/#/g/${token}` });
});

/* صانع مسجل يحوّل طلب الضيف إلى حجز رسمي بنفس آلة الحالات — العميل طرفه الضيف.
   التحويل معاملة واحدة ذرّية: قفل صف الطلب، إدراج الحجز، تحديث حالة الطلب،
   وإشعار الصانع — كلها تنجح معاً أو تتراجع معاً، فلا «إشعار نجاح» بلا حجز فعلي،
   ولا تحويل مكرر لنفس الطلب أبداً. */
app.post('/api/guest-requests/:id/book', auth, async (req, res) => {
  if (!['creator', 'provider'].includes(req.user.role)) return res.status(400).json({ error: 'تحويل الطلبات للصناع ومقدمي الخدمة فقط' });
  if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس — عرض فقط ولا يقبل حجوزات أو تواصلاً' });
  if (req.user.penalty_level === 'suspended' || req.user.frozen) return res.status(403).json({ error: 'حسابك معلّق حالياً ولا يستقبل حجوزات' });
  const { price, deadline_days = 7 } = req.body || {};
  const client = await pool.connect();
  let bookingId = null, guestToken = '';
  try {
    await client.query('BEGIN');
    const rqRes = await client.query('SELECT * FROM shop_requests WHERE id=$1 AND is_guest=1 FOR UPDATE', [+req.params.id]);
    const rq = rqRes.rows[0];
    if (!rq) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'طلب ضيف غير موجود' }); }
    if (rq.status !== 'open') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'هذا الطلب اتحجز خلاص — لا يمكن تحويله مرتين' }); }
    // الطلب الموجّه لا يحوّله إلا مستهدَفه وحده — هو وحده من يراه أصلاً.
    if (rq.target_talent_id && rq.target_talent_id !== req.user.id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'هذا الطلب موجّه لصانع آخر' }); }
    const p = price != null ? +price : (rq.budget || req.user.price);
    if (!p || p <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'حدد سعراً صحيحاً' }); }
    const ins = await client.query(
      `INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,guest_name,guest_phone,guest_token,urgent,created_at)
       VALUES (NULL,$1,'guest_request',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.user.id, rq.id, rq.title, p, rq.currency, now() + deadline_days * 24 * 3600 * 1000, rq.guest_name, rq.guest_phone, rq.guest_token, rq.urgent ? 1 : 0, now()]);
    bookingId = ins.rows[0].id;
    guestToken = rq.guest_token;
    await client.query(`UPDATE shop_requests SET status='booked' WHERE id=$1`, [rq.id]);
    // الإشعار داخل نفس المعاملة: لا يُحفظ إلا إذا حُفظ الحجز نفسه.
    await client.query('INSERT INTO notifications (user_id,type,text,ref,created_at) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, 'booking_new', `حوّلت طلب عميل «${rq.guest_name}» إلى حجز #${bookingId} — العميل هيكمل خطواته من رابط متابعته`, `booking:${bookingId}`, now()]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* تجاهل */ }
    throw e;
  } finally {
    client.release();
  }
  await addBookingEvent(bookingId, 'created', 'أُنشئ الحجز من طلب ضيف — الضمان والمراحل موثّقة داخل Deal');
  res.json({ booking: await bookingView(await getBooking(bookingId), req.user), follow: `/#/g/${guestToken}` });
});

async function guestBookingByToken(token) {
  if (!token) return null;
  return await db.prepare('SELECT * FROM bookings WHERE guest_token=?').get(token);
}
async function guestBookingView(b) {
  const fee = Math.round(b.price * COMMISSION_RATE * 100) / 100;
  const net = b.price - fee, half = Math.round(net / 2 * 100) / 100;
  const myReview = await db.prepare('SELECT * FROM reviews WHERE booking_id=? AND reviewer_id IS NULL').get(b.id);
  return {
    id: b.id, title: b.title, price: b.price, currency: b.currency, status: b.status,
    order_state: orderStateFor(b),
    fee_status: b.fee_status, agreed_client: !!b.agreed_client, agreed_talent: !!b.agreed_talent,
    fee, net, deposit: half, rest: half,
    proof_url: b.proof_url, proof_check: b.proof_check, proof_at: b.proof_at || 0, created_at: b.created_at,
    receipt_confirmed_at: b.receipt_confirmed_at || 0, receipt_auto: !!b.receipt_auto,
    urgent: !!b.urgent,
    chat_unread: (await db.prepare(`SELECT COUNT(*) c FROM guest_messages WHERE booking_id=? AND sender='talent' AND is_read=0`).get(b.id)).c,
    final_delivered_at: b.final_delivered_at || 0, final_confirmed_at: b.final_confirmed_at || 0, final_auto: !!b.final_auto,
    appeal: appealView(await openAppealFor(b.id)),
    terms: await termsStateFor(b),
    events: await bookingEvents(b.id),
    deemed_at: b.deemed_at || 0,
    final_obligation_status: await (async () => { const o = await finalObligation(b.id); return o ? o.status : null; })(),
    has_dispute: !!(await db.prepare('SELECT id FROM disputes WHERE booking_id=? LIMIT 1').get(b.id)),
    talent: await publicUser(await getUser(b.talent_id)),
    reviewed: !!myReview,
  };
}

app.get('/api/guest/:token', async (req, res) => {
  await runAllSweeps();
  const bk = await guestBookingByToken(req.params.token);
  if (bk) return res.json({ type: 'booking', booking: await guestBookingView(bk) });
  const rq = await db.prepare('SELECT id,title,niche,city,budget,currency,details,status,created_at FROM shop_requests WHERE guest_token=? AND is_guest=1').get(req.params.token);
  if (rq) return res.json({ type: 'request', request: rq, booking: null });
  return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
});

/** Commission number: ONLY to the guest client, ONLY at the fee step (نفس قاعدة الحجز المسجل). */
app.get('/api/guest/:token/fee-info', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  if (b.status !== 'awaiting_fee' || b.fee_status === 'confirmed') return res.status(400).json({ error: 'خطوة العمولة غير مفتوحة الآن' });
  const ob = await getOrCreateObligation({
    kind: 'booking_commission', booking_id: b.id, user_id: b.talent_id,
    base_amount: bookingLegAmounts(b).fee, currency: b.currency,
    guest_token: b.guest_token, payee: 'owner',
  });
  const colGFee = await collectorForObligation(ob);
  res.json({ label: 'Deal — حساب عمولات المنصة', phone: colGFee.phone, collector_via: colGFee.via, methods: ['Vodafone Cash', 'InstaPay'], amount: Math.round(b.price * COMMISSION_RATE * 100) / 100, currency: b.currency, obligation: await payerObligationView(ob, await guestCountryByToken(req.params.token)) });
});

/* التزام خطوة دفع الضيف (عربون/أخيرة): يُعرض للدافع الضيف برمز متابعته فقط. */
app.get('/api/guest/:token/obligation', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const kind = String(req.query.kind || '');
  const stageFor = { booking_deposit: ['awaiting_deposit'], booking_final: ['awaiting_rest', 'proof_submitted'] };
  if (!stageFor[kind]) return res.status(400).json({ error: 'نوع التزام غير صحيح' });
  const existing = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND status IN ('open','claimed','confirmed','auto_confirmed') AND is_difference=0 ORDER BY id DESC LIMIT 1`).get(kind, b.id);
  if (!existing && !stageFor[kind].includes(b.status)) return res.status(400).json({ error: 'خطوة الدفع ليست مفتوحة الآن' });
  const amounts = bookingLegAmounts(b);
  const ob = existing || await getOrCreateObligation({
    kind, booking_id: b.id, user_id: b.talent_id,
    base_amount: kind === 'booking_deposit' ? amounts.deposit : amounts.rest, currency: b.currency,
    guest_token: b.guest_token,
    // العربون والدفعة الأخيرة للمقدم مباشرة (لا احتجاز عند Deal في أي مرحلة).
    payee: `user:${b.talent_id}`,
    payee_user_id: b.talent_id,
  });
  const gView = await payerObligationView(ob, await guestCountryByToken(req.params.token));
  const gDiff = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND is_difference=1 AND status IN ('open','claimed') ORDER BY id DESC LIMIT 1`).get(kind, b.id);
  if (gDiff) gView.difference_obligation = await payerObligationView(gDiff, await guestCountryByToken(req.params.token));
  res.json({ obligation: gView });
});

app.post('/api/guest/:token/agree', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const r = await applyAgree(b, 'client');
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await guestBookingView(r.booking) });
});

app.post('/api/guest/:token/terms-accept', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const st = await acceptTerms(b, 'client', null, req.params.token);
  res.json({ terms: st, booking: await guestBookingView(await getBooking(b.id)) });
});

app.post('/api/guest/:token/pay', async (req, res) => {
  const { kind, ref } = req.body || {};
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  if (!ref) return res.status(400).json({ error: 'مرجع العملية مطلوب' });
  if (!(await termsGateOpen(b))) return res.status(403).json({ error: 'خطوات الدفع مقفلة حتى يقبل الطرفان «شروط المعاملات» — اقرأها ووافق عليها أولاً من صفحة متابعتك', terms_required: true, terms: await termsStateFor(b) });
  const r = await applyClientPayment(b, kind, ref);
  if (r.error) return res.status(400).json({ error: r.error });
  try { await claimObligationForPayment(r.booking, kind, ref, 'guest'); } catch (e) { /* الربط لا يعطّل الدفع */ }
  res.json({ booking: await guestBookingView(r.booking) });
});

app.post('/api/guest/:token/confirm-receipt', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const r = await applyConfirmReceipt(b);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await guestBookingView(r.booking) });
});

/* نزاع الضيف من صفحة رمزه — نفس آلة النزاع المشتركة (تجميد فوري + حزمة
   أدلة + إغلاق أي طلب مراجعة قائم لصالح النزاع). opened_by=0 لأنه بلا حساب. */
app.post('/api/guest/:token/dispute', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const r = await applyOpenDispute(b, 0, String((req.body || {}).reason || ''));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ...r, booking: await guestBookingView(await getBooking(b.id)) });
});

/* ملاحظة الضيف داخل طلب مراجعة قائم — من صفحة رمزه، تظهر للمالك في المراجعة. */
app.post('/api/guest/:token/appeal-note', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const r = await applyAppealNote(b, (req.body || {}).note);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ...r, booking: await guestBookingView(await getBooking(b.id)) });
});

app.post('/api/guest/:token/review', async (req, res) => {
  const { sentiment, stars = 5, comment = '' } = req.body || {};
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  if (b.status !== 'completed') return res.status(400).json({ error: 'التقييم بعد اكتمال القبض فقط' });
  if (!['positive', 'negative'].includes(sentiment)) return res.status(400).json({ error: 'اختر إيجابي أو سلبي' });
  const existing = await db.prepare('SELECT id FROM reviews WHERE booking_id=? AND reviewer_id IS NULL').get(b.id);
  if (existing) return res.status(409).json({ error: 'قيّمت هذا الحجز من قبل — التقييم لا يُعدّل' });
  await db.prepare('INSERT INTO reviews (booking_id,reviewer_id,reviewee_id,sentiment,stars,comment,created_at) VALUES (?,NULL,?,?,?,?,?)')
    .run(b.id, b.talent_id, sentiment, Math.min(5, Math.max(1, stars)), comment, now());
  await applyPenalties(b.talent_id);
  await syncBadges(b.talent_id);
  res.json({ ok: true });
});

/* ---------------- محادثة عميل ضيف ↔ مقدم الخدمة (داخل المنصة) ----------------
   محادثة واحدة لكل حجز ضيف، مربوطة بالحجز نفسه وموثقة في سجلاته (تظهر في
   حزمة أدلة أي نزاع عليه). العميل طرفه رمز متابعته (بلا حساب)، والمقدم طرفه
   حسابه من قسم «الرسائل». المؤسس خارجها تماماً: لا حجز له أصلاً، وأي محاولة
   إشراكه (طرفاً أو مرسِلاً في حجز غيره) تُرفض. */
async function guestChatItems(bookingId) {
  const rows = await db.prepare('SELECT * FROM guest_messages WHERE booking_id=? ORDER BY created_at ASC, id ASC LIMIT 500').all(bookingId);
  const msgs = rows.map((m) => ({ id: m.id, sender: m.sender, body: m.body, created_at: m.created_at, is_read: !!m.is_read }));
  const evs = (await bookingEvents(bookingId, 500)).map((e, i) => ({ id: `sys-${i}`, sender: 'system', kind: e.kind, body: e.body, created_at: e.created_at, is_read: true }));
  return [...msgs, ...evs].sort((a, c) => (a.created_at - c.created_at) || (String(a.id).startsWith('sys') ? 1 : -1));
}
function guestChatBody(req) {
  const body = String((req.body || {}).body || '').trim();
  if (!body) return { error: 'اكتب رسالة أولاً' };
  if (body.length > MSG_MAX) return { error: `الرسالة أطول من الحد الأقصى (${MSG_MAX} حرف)` };
  return { body };
}

/* طرف العميل: يقرأ (فتح الصفحة يعلّم ردود المنفذ مقروءة) ويكتب من صفحة رمزه. */
app.get('/api/guest/:token/messages', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  await db.prepare(`UPDATE guest_messages SET is_read=1 WHERE booking_id=? AND sender='talent' AND is_read=0`).run(b.id);
  const talent = await getUser(b.talent_id);
  res.json({ items: await guestChatItems(b.id), talent: talent ? { id: talent.id, name: talent.name } : null, booking_id: b.id });
});
app.post('/api/guest/:token/messages', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const v = guestChatBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = now();
  const info = await db.prepare(`INSERT INTO guest_messages (booking_id,sender,body,created_at) VALUES (?,'guest',?,?)`).run(b.id, v.body, ts);
  await notify(b.talent_id, 'guest_message', `💬 رسالة جديدة من عميل حجز #${b.id} جوه المنصة — افتح الحجز للرد`, `booking:${b.id}`);
  res.json({ ok: true, message: { id: info.lastInsertRowid, sender: 'guest', body: v.body, created_at: ts } });
});
/* علم «مستعجل — تنفيذ اليوم» من صفحة متابعة الضيف على حجزه. */
app.post('/api/guest/:token/urgent', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  if (['completed', 'cancelled'].includes(b.status)) return res.status(400).json({ error: 'الحجز انتهى' });
  await db.prepare('UPDATE bookings SET urgent=? WHERE id=?').run((req.body || {}).urgent ? 1 : 0, b.id);
  res.json({ booking: await guestBookingView(await getBooking(b.id)) });
});

/* طرف المقدم (وكل طرف مسجل في الحجز): قائمة محادثات الضيوف لحجوزاته. */
app.get('/api/guest-conversations', auth, async (req, res) => {
  if (req.user.is_platform_founder) return res.json({ items: [], unread_total: 0 });
  const rows = await db.prepare(`SELECT * FROM (SELECT b.id, b.title, b.guest_name, b.status, b.urgent, b.created_at,
      (SELECT COUNT(*) FROM guest_messages gm WHERE gm.booking_id=b.id AND gm.sender='guest' AND gm.is_read=0) AS unread,
      (SELECT gm2.body FROM guest_messages gm2 WHERE gm2.booking_id=b.id ORDER BY gm2.created_at DESC, gm2.id DESC LIMIT 1) AS last_body,
      (SELECT gm3.created_at FROM guest_messages gm3 WHERE gm3.booking_id=b.id ORDER BY gm3.created_at DESC, gm3.id DESC LIMIT 1) AS last_at,
      (SELECT gm4.sender FROM guest_messages gm4 WHERE gm4.booking_id=b.id ORDER BY gm4.created_at DESC, gm4.id DESC LIMIT 1) AS last_sender
    FROM bookings b WHERE b.talent_id=? AND b.guest_token<>'') s ORDER BY COALESCE(s.last_at, s.created_at) DESC`).all(req.user.id);
  let unread_total = 0;
  const items = rows.map((x) => { const un = +(x.unread || 0); unread_total += un; return { booking_id: x.id, title: x.title, guest_name: x.guest_name || '', status: x.status, urgent: !!x.urgent, unread: un, last: x.last_body ? { body: x.last_body, created_at: x.last_at, sender: x.last_sender } : null }; });
  res.json({ items, unread_total });
});
/* قراءة/كتابة المقدم داخل محادثة حجز ضيف — فتحها يعلّم رسائل العميل مقروءة. */
app.get('/api/bookings/:id/guest-messages', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || !b.guest_token) return res.status(404).json({ error: 'غير موجود' });
  if (b.talent_id !== req.user.id && !req.user.is_platform_founder) return res.status(403).json({ error: 'لست طرفاً في الحجز' });
  if (b.talent_id === req.user.id) {
    await db.prepare(`UPDATE guest_messages SET is_read=1 WHERE booking_id=? AND sender='guest' AND is_read=0`).run(b.id);
  }
  res.json({ items: await guestChatItems(b.id), booking_id: b.id, guest_name: b.guest_name || '', guest_phone: '' });
});
app.post('/api/bookings/:id/guest-messages', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || !b.guest_token) return res.status(404).json({ error: 'غير موجود' });
  if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس خارج المراسلة — عرضه ومتابعته فقط' });
  if (b.talent_id !== req.user.id) return res.status(403).json({ error: 'الرد من مقدم الخدمة صاحب الحجز فقط' });
  const v = guestChatBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = now();
  const info = await db.prepare(`INSERT INTO guest_messages (booking_id,sender,body,created_at) VALUES (?,'talent',?,?)`).run(b.id, v.body, ts);
  res.json({ ok: true, message: { id: info.lastInsertRowid, sender: 'talent', body: v.body, created_at: ts } });
});

/* ---------------- campaigns ---------------- */
app.post('/api/campaigns', auth, async (req, res) => {
  const { title, brief = '', niche = '', city = '', budget = 0, currency = 'EGP' } = req.body || {};
  if (!title) return res.status(400).json({ error: 'عنوان الحملة مطلوب' });
  const info = await db.prepare('INSERT INTO campaigns (brand_user_id,title,brief,niche,city,budget,currency,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, title, brief, niche, city || req.user.city, budget, currency, now());
  res.json({ id: info.lastInsertRowid });
});
app.get('/api/campaigns', async (req, res) => {
  const rows = await db.prepare(`SELECT c.*, u.name brand_name FROM campaigns c JOIN users u ON u.id=c.brand_user_id WHERE c.status='open' ORDER BY c.created_at DESC`).all();
  res.json({ items: rows });
});
app.post('/api/campaigns/:id/apply', auth, async (req, res) => {
  if (req.user.role !== 'creator') return res.status(400).json({ error: 'التقديم للصناع فقط' });
  const { pitch = '' } = req.body || {};
  try {
    const info = await db.prepare('INSERT INTO campaign_applications (campaign_id,creator_id,pitch,created_at) VALUES (?,?,?,?)')
      .run(+req.params.id, req.user.id, pitch, now());
    const c = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(+req.params.id);
    if (c) await notify(c.brand_user_id, 'campaign', `صانع جديد قدم على حملتك «${c.title}»`, `campaign:${c.id}`);
    res.json({ id: info.lastInsertRowid });
  } catch (e) { return res.status(409).json({ error: 'قدمت على هذه الحملة من قبل' }); }
});
app.get('/api/campaigns/:id/applications', auth, async (req, res) => {
  const c = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(+req.params.id);
  if (!c || c.brand_user_id !== req.user.id) return res.status(403).json({ error: 'ليست حملتك' });
  const rows = await db.prepare('SELECT * FROM campaign_applications WHERE campaign_id=? ORDER BY created_at DESC').all(c.id);
  const items = await Promise.all(rows.map(async a => ({ ...a, creator: await publicUser(await getUser(a.creator_id)) })));
  // «ترشيح أول» للبراند: المتقدم المشترك في «نجم Deal» (نشط) يتصدّر قائمة
  // المتقدمين، وداخل كل مجموعة يبقى الأحدث أولاً كما كان.
  items.sort((a, b) => ((b.creator && b.creator.is_star ? 1 : 0) - (a.creator && a.creator.is_star ? 1 : 0)));
  res.json({ items });
});
app.post('/api/applications/:id/accept', auth, async (req, res) => {
  const a = await db.prepare('SELECT * FROM campaign_applications WHERE id=?').get(+req.params.id);
  if (!a) return res.status(404).json({ error: 'غير موجود' });
  const c = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(a.campaign_id);
  if (!c || c.brand_user_id !== req.user.id) return res.status(403).json({ error: 'ليست حملتك' });
  if (a.status !== 'pending') return res.status(400).json({ error: 'تم البت في هذا التقديم' });
  const applicant = await getUser(a.creator_id);
  if (applicant && applicant.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس — عرض فقط ولا يقبل حجوزات أو تواصلاً' });
  const info = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, a.creator_id, 'campaign', c.id, c.title, c.budget || (await getUser(a.creator_id)).price, c.currency, now() + 7 * 24 * 3600 * 1000, now());
  await db.prepare(`UPDATE campaign_applications SET status='accepted', booking_id=? WHERE id=?`).run(info.lastInsertRowid, a.id);
  await notify(a.creator_id, 'booking_new', `براند «${req.user.name}» قبل تقديمك — حجز #${info.lastInsertRowid} اتفتح`, `booking:${info.lastInsertRowid}`);
  res.json({ booking_id: info.lastInsertRowid });
});

/* ---------------- notifications ---------------- */
app.get('/api/notifications', auth, async (req, res) => {
  const items = await db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  const unread = (await db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id)).c;
  res.json({ items, unread });
});
app.post('/api/notifications/read', auth, async (req, res) => {
  await db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

/* ---------------- الدعم بالرد التلقائي (قاعدة أسئلة شائعة منسّقة) ----------------
   مطابقة بكلمات مفتاحية بعد تطبيع النص العربي/الإنجليزي. سؤال معروف → إجابته
   فوراً. سؤال خارج القاعدة → رد احتياطي مهذب + حفظ السؤال في support_messages
   ليطّلع عليه المالك من لوحته. */
const SUPPORT_KB = [
  { id: 'what', q_ar: 'ما هو Deal وكيف يعمل؟', q_en: 'What is Deal and how does it work?',
    keys: ['ما هو', 'ازاي بيشتغل', 'كيف يعمل', 'يعني ايه', 'what is deal', 'how does it work', 'how it works', 'about deal'],
    a_ar: 'Deal — منصة كل صناع المحتوى: الصانع يسجّل ملفه (مجال، مدينة، سعر)، والعميل يطلب خدمة أو يحجز صانعاً مباشرة، والدفع يتم على مراحل بحماية «ضمان Deal»: عمولة أولاً، ثم عربون للصانع، والباقي يتحوّل للصانع مباشرة بعد تأكيد استلام المعاينة — والنسخة النهائية لا تُسلَّم إلا بعد تأكيد قبض الباقي. Deal لا تحتجز أموال المعاملات أبداً — وكل خطوة موثّقة بسجل رسمي.',
    a_en: 'Deal — the platform for all content creators: creators register a profile (niche, city, price), clients request a service or book a creator directly, and payment happens in protected stages under the Deal Guarantee: fee first, then a deposit to the creator, and the rest moves directly to the creator after preview receipt is confirmed — with the final copy delivered only after receipt of the rest is confirmed. Deal never holds transaction money — every step documented in an official ledger.' },
  { id: 'register', q_ar: 'كيف أسجّل كصانع محتوى؟', q_en: 'How do I register as a creator?',
    keys: ['تسجيل', 'اسجل', 'حساب جديد', 'انشاء حساب', 'register', 'sign up', 'create account', 'join as creator'],
    a_ar: 'من زر «دخول / تسجيل» اختر «صانع محتوى» واملأ الاسم والمجال والمدينة وعدد المتابعين وسعرك ووسيلة تواصل واحدة (رقم هاتف أو إيميل) — التسجيل مجاني ووسيلة التواصل هي وسيلة دخولك بعد ذلك.',
    a_en: 'Tap "Login / Register", choose "Content creator" and fill in your name, niche, city, follower count, price and one contact (phone or email) — registration is free, and that contact becomes your login afterwards.' },
  { id: 'one_account', q_ar: 'لماذا لا أستطيع التسجيل مرتين؟', q_en: 'Why can\'t I register twice?',
    keys: ['مرتين', 'حسابين', 'ملفين', 'مسجلة من قبل', 'تسجيل مكرر', 'two accounts', 'register twice', 'duplicate', 'already registered'],
    a_ar: 'كل شخص له حساب واحد فقط على Deal — وسيلة التواصل الواحدة = ملف واحد، حتى تبقى التقييمات والسمعة مرتبطة بشخص حقيقي واحد ولا تتشتت. لو سجلت من قبل، استخدم «دخول» بنفس الرقم أو الإيميل (بأي صيغة: +20 أو 0 — النظام يوحّدها).',
    a_en: 'Each person gets exactly one Deal account — one contact = one profile, so ratings and reputation stay tied to a single real person. If you registered before, just log in with the same number or email (any format: +20 or 0 — the system normalizes it).' },
  { id: 'guest_post', q_ar: 'كيف أطلب خدمة كعميل دون تسجيل؟', q_en: 'How do I request a service as a client without registering?',
    keys: ['ضيف', 'دون تسجيل', 'بدون تسجيل', 'بدون حساب', 'طلب خدمة', 'اطلب خدمة', 'نشر طلب', 'عندي محل', 'guest', 'without registering', 'without account', 'request a service', 'request service'],
    a_ar: 'من زر «📣 طلب خدمة» في الواجهة: اكتب اسم نشاطك ورقم هاتفك والمدينة ونوع الإعلان والميزانية ووصف الخدمة — بدون أي حساب. طلبك يظهر للصناع فوراً، والتواصل مع مقدم الخدمة يتم داخل Deal من صفحة متابعة طلبك (محادثة الطلب)، وستحصل على رابط متابعة خاص تكمل منه خطوات الحجز والدفع والتقييم.',
    a_en: 'Use the "📣 Request a service" button on the home page: enter your business name, phone number, city, ad type, budget and a description — no account needed. Providers see your request instantly, and all communication with the provider happens inside Deal from your request follow-up page (the order chat); you also get a private follow-up link to complete booking, payment and rating steps.' },
  { id: 'fee_why', q_ar: 'ما هي عمولة Deal ولماذا تُدفع أولاً؟', q_en: 'What is the Deal fee and why is it paid first?',
    keys: ['عمولة', 'ليه العمولة', 'لماذا العمولة', '10%', '١٠', 'fee', 'commission', 'why fee first', '10 percent'],
    a_ar: 'عمولة Deal هي 10% من قيمة الطلب، وتُدفع أولاً قبل أي مبلغ للصانع: بها يتأكد جدية الحجز ويُفتح باقي خطوات الدفع المحمي، وهي مصدر تشغيل المنصة وخدمة الضمان والتوثيق. العميل يدفع السعر المعلن بالضبط — العمولة جزء منه وتُخصم من حصة الصانع (صافي الصانع 90%).',
    a_en: 'The Deal fee is 10% of the order value, paid first before any money reaches the creator: it confirms the booking is serious and unlocks the protected payment stages, and it funds the platform, guarantee and verification services. The client pays exactly the listed price — the fee is part of it and comes out of the creator\'s share (the creator nets 90%).' },
  { id: 'fee_how', q_ar: 'كيف أدفع العمولة؟', q_en: 'How do I pay the fee?',
    keys: ['ادفع العمولة ازاي', 'كيف ادفع', 'فودافون كاش', 'انستاباي', 'مرجع التحويل', 'رقم التحويلة', 'how to pay', 'vodafone cash', 'instapay', 'transfer reference', 'payment reference'],
    a_ar: 'داخل خطوة «عمولة Deal أولاً» في حجزك اضغط «إظهار حساب عمولات Deal» وسيظهر رقم حساب العمولات (يظهر فقط للعميل الدافع وداخل هذه الخطوة فقط). حوّل مبلغ العمولة إليه من محفظتك (فودافون كاش أو إنستاباي)، ثم اكتب مرجع عملية التحويل في الحجز واضغط تأكيد — التأكيد تلقائي.',
    a_en: 'Inside the "Deal fee first" step of your booking, tap "Show Deal fee account" — the fee account number appears only to the paying client and only at this step. Transfer the fee amount from your wallet (Vodafone Cash or InstaPay), then enter the transfer reference in the booking and confirm — confirmation is automatic.' },
  { id: 'stages', q_ar: 'كيف يتم الدفع على مراحل (45/45)؟', q_en: 'How does the staged payment (45/45) work?',
    keys: ['مراحل', '45', '٤٥', 'عربون', 'الباقي', 'دفعتين', 'staged', 'deposit', 'stages', 'two payments', 'installments'],
    a_ar: 'كل خطوة دفع لها مهلة ٣ ساعات بعدّاد حي (نظام باينانس) وانتهاؤها بلا إعلان دفع يلغي الطلب تلقائياً بلا حركة مال. بعد العمولة (10%)، يدفع العميل 45% من السعر عربوناً للصانع مباشرة فيبدأ التنفيذ، وبعد تأكيد استلام المعاينة (أو اعتماد الاستلام بقاعدة سكوت ٣ ساعات أو قرار تحكيم) يحوّل العميل الـ45% الأخيرة للصانع مباشرة، ولا تُسلَّم النسخة النهائية إلا بعد تأكيد قبض الباقي — فيصل للصانع صافيه كاملاً (90%): العميل لا يخسر باقيه قبل ما يستلم، والصانع ضامن باقيه قبل ما يسلّم النهائية.',
    a_en: 'Every payment step has a 3-hour deadline with a live countdown (the Binance system); expiry with no payment declared cancels the order automatically with no money moving. After the 10% fee, the client pays 45% of the price directly to the creator as a deposit so work starts, and after preview receipt is confirmed (or deemed confirmed by the 3-hour silence rule, or decided by arbitration) the client transfers the final 45% directly to the creator — with the final copy delivered only after receipt of the rest is confirmed — so the creator receives the full net (90%): the client never loses the rest before delivery, and the creator\'s rest is guaranteed before final delivery.' },
  { id: 'guarantee', q_ar: 'ما هو ضمان Deal؟', q_en: 'What is the Deal Guarantee?',
    keys: ['ضمان', 'حماية', 'امان', 'أمان', 'guarantee', 'protection', 'safe', 'trust'],
    a_ar: '«حجز محمي بضمان Deal» يعني: دفع مرحلي موثّق داخل الحجز، عمولة مؤكدة أولاً، إثبات تنفيذ (معاينة) تتحقق منه المنصة ويُختم بوقته، الباقي يتحوّل للمنفذ مباشرة بعد تأكيد الاستلام — والضمان في الشغل نفسه: النسخة النهائية لا تُسلَّم إلا بعد تأكيد قبض الباقي، إمكانية فتح نزاع يجمّد تقدم الحجز فوراً حتى تراجعه الإدارة (قرار لصالح طرف + عقوبات موثّقة)، وعند إخلال المنفذ تقترح المنصة بدائل موثّقة من نفس مدينتك ومجالك. Deal لا تحتجز أموال المعاملات في أي مرحلة.',
    a_en: 'A "Deal-Guaranteed booking" means: staged payments documented inside the booking, the fee confirmed first, a proof of delivery (preview) that the platform verifies and timestamps, the rest moving directly to the creator after receipt confirmation — the guarantee is in the work itself: the final copy is delivered only after receipt of the rest is confirmed — the ability to open a dispute that freezes the booking\'s progress instantly until admin review (a decision for one side plus documented penalties), and — if the creator defaults — verified alternatives from your own city and niche suggested by the platform. Deal never holds transaction money at any stage.' },
  { id: 'p2p', q_ar: 'هل المعاملات P2P؟ كيف تتحرك الفلوس فعلياً؟', q_en: 'Are transactions P2P? How does money actually move?',
    keys: ['p2p', 'بي تو بي', 'محافظ شخصية', 'محفظة شخصية', 'بين المحافظ', 'مش بنك', 'لست بنك', 'peer to peer', 'personal wallets', 'not a bank'],
    a_ar: 'المعاملات P2P — فلوسك بتتحرك بين المحافظ الشخصية مباشرة (فودافون كاش/إنستاباي)، وDeal بينظّم ويوثّق ويحمي ومش بنك. كل تحويلة بمرجع مالي موحّد (كود معاملة + مبلغ بكسور بصمة) ومتسجلة في سجل رسمي، وDeal لا يستلم ولا يحتجز أموال المعاملات بين الأطراف في أي مرحلة — عمولته واشتراكاته فقط هي إيراده.',
    a_en: 'Transactions are P2P — your money moves directly between personal wallets (Vodafone Cash/InstaPay), and Deal organizes, documents and protects — it is not a bank. Every transfer carries a unified money reference (a transaction code + a fingerprinted amount) recorded in an official ledger, and Deal never receives or holds transaction money between the parties at any stage — only its fee and subscriptions are its revenue.' },
  { id: 'proof', q_ar: 'ما هو إثبات التنفيذ وكيف يعمل؟', q_en: 'What is proof of delivery and how does it work?',
    keys: ['اثبات', 'إثبات', 'رابط العمل', 'proof', 'delivery proof', 'published work link'],
    a_ar: 'بعد التنفيذ يرسل الصانع رابط العمل المنشور علناً (الفيديو/المنشور) داخل الحجز؛ المنصة تتحقق آلياً أن الرابط يعمل وعلني ويختمه بوقت الإرسال. الدفعة الأخيرة لا تُفتح إلا بإثبات سليم، والإثبات يُحفظ تلقائياً في معرض أعمال الصانع.',
    a_en: 'After delivery, the creator submits the publicly published work link inside the booking; the platform automatically verifies the link is live and public and timestamps it. The final payment only unlocks with a valid proof, and the proof is automatically saved to the creator\'s portfolio.' },
  { id: 'auto_confirm', q_ar: 'ماذا يحدث لو لم يؤكد العميل الاستلام؟', q_en: 'What happens if the client does not confirm receipt?',
    keys: ['تأكيد تلقائي', 'التأكيد التلقائي', 'استلام معتبر', 'الاستلام المعتبر', 'اعتماد الاستلام', 'طلب مراجعة', 'مراجعة الإفراج', 'طلب تحكيم', 'تحكيم', 'لم يؤكد', 'ما اكدش', 'سكوت', 'ما رديتش', 'auto confirm', 'automatic confirmation', 'deemed', 'appeal', 'arbitration', 'release review', 'no response', 'did not confirm'],
    a_ar: 'بنظام باينانس نفسه: إن سكت العميل ٣ ساعات بعد وصول إثبات تنفيذ سليم، يُعتبَر الاستلام مؤكداً تلقائياً (استلام مُعتبَر) وتتفتح خطوة دفع الباقي للمنفذ مباشرة — وقبل الاعتماد بساعة يصلك تحذير أخير. في أي لحظة قبل الاعتماد: تأكيدك بنفسك يغلق فوراً، ونزاعك يجمّد كل شيء ويوقف القاعدة نهائياً، وردّك بملاحظة أو رسالة يعني أنك لست ساكتاً فالمسار يبقى التحكيم: الصانع يقدر بعد ٣ ساعات من الإثبات يطلب تحكيماً يبدأ بطور تفاوض ١٠ دقائق بينكما ثم يحسم المالك من حزمة الأدلة (إفراج أو رد) — وللمالك حق عكس أي اعتماد استلام مُعتبَر عند ثبوت احتيال أو خطأ.',
    a_en: 'Exactly the Binance rule: if the client stays silent for 3 hours after a valid proof of delivery, receipt is deemed confirmed automatically and the rest-payment step to the provider opens — with a final warning one hour before. At any moment before that: confirming yourself closes it instantly, a dispute freezes everything and stops the rule permanently, and replying with a note or a message means you are not silent, so the path stays arbitration: 3 hours after the proof the creator can request arbitration, which starts with a 10-minute negotiation phase between you, then the owner decides from the evidence bundle (release or refund) — and the owner may reverse any deemed confirmation on proven fraud or error.' },
  { id: 'ip_report', q_ar: 'كيف أبلّغ عن انتهاك ملكية فكرية؟', q_en: 'How do I report an intellectual-property violation?',
    keys: ['ملكية فكرية', 'انتهاك ملكية', 'حقوق نشر', 'سرقة شغل', 'سرقة فيديو', 'شغلي اتسرق', 'ابلاغ عن انتهاك', 'copyright', 'intellectual property', 'stolen work', 'stolen video', 'ip violation', 'report infringement'],
    a_ar: 'من نفس قناة الدعم هنا: اكتب بلاغك مع رابط شغلك الأصلي ورابط النسخة المنتهكة وبيانات حجزك على Deal إن وجد — وستجد داخل أي حجز «حزمة أدلة» مولّدة تلقائياً من سجلات المنصة (إثبات التنفيذ مختوم بوقت الخادم + مراحل الدفع) صالحة للاستخدام في بلاغات حقوق النشر على المنصات. Deal لا يحذف محتوى من منصات أخرى بنفسه، لكنه يراجع البلاغ ويتخذ إجراءاته داخل المنصة (تنبيه/تعليق/حظر) عند ثبوت الانتهاك. التواصل القانوني يتم عبر نظام الدعم هذا نفسه ويصل لإدارة المنصة.',
    a_en: 'Through this same support channel: write your report with a link to your original work, a link to the infringing copy, and your Deal booking details if any — inside every booking you will find an auto-generated "evidence bundle" from the platform records (server-timestamped proof of delivery + payment stages) valid for copyright reports on other platforms. Deal cannot delete content from other platforms itself, but it reviews reports and acts inside the platform (warning/suspension/ban) when a violation is proven. Legal contact happens through this same support system and reaches platform management.' },
  { id: 'reviews', q_ar: 'متى أستطيع تقييم الطرف الآخر؟', q_en: 'When can I rate the other side?',
    keys: ['تقييم', 'نجوم', 'رأيي', 'review', 'rating', 'rate', 'stars'],
    a_ar: 'التقييم يفتح فقط بعد «اكتمال القبض» (انتهاء كل مراحل الدفع)، مرة واحدة لكل طرف ولكل حجز، ولا يمكن تعديله بعد إرساله — هكذا تبقى التقييمات مرتبطة بصفقات حقيقية مكتملة فعلاً.',
    a_en: 'Rating unlocks only after "full payment completion" (all payment stages done), once per side per booking, and cannot be edited after submission — keeping ratings tied to real, completed deals.' },
  { id: 'verification', q_ar: 'كيف أوثّق حسابي وما هي الشارات؟', q_en: 'How do I verify my account and what are the badges?',
    keys: ['توثيق', 'موثق', 'شارة', 'شارات', 'كود الملكية', 'verify', 'verified', 'badge', 'badges', 'verification'],
    a_ar: 'من لوحتك اطلب «كود الملكية» وضعه في بايو أحد حساباتك العلنية أو منشور مثبت، ثم أرسل رابط الحساب للفحص: التطابق يعني توثيقاً فورياً بشارة «موثّق Deal»، وأول موثّق في كل مدينة+مجال يأخذ لقب «رائد المدينة». توجد أيضاً شارات إنجاز تُمنح وتُسحب تلقائياً من سجلك (إتمام مثالي، الأعلى تقييماً، تنفيذ سريع، صانع صاعد، سفير Deal، مخضرم).',
    a_en: 'From your dashboard, request an "ownership code", place it in the bio of one of your public accounts or a pinned post, then submit the account link for checking: a match means instant verification with the "Deal Verified" badge, and the first verified creator in each city+niche earns "City Pioneer". Achievement badges (Perfect Completion, Top Rated, Fast Delivery, Rising Creator, Deal Ambassador, Veteran) are granted and revoked automatically from your record.' },
  { id: 'founder_member', q_ar: 'ما هي شارة «عضو مؤسس»؟', q_en: 'What is the "Founding Member" badge?',
    keys: ['عضو مؤسس', 'مؤسس', 'اول 100', 'أول ١٠٠', 'founding member', 'first 100', 'founder member'],
    a_ar: 'أول 100 صانع محتوى يسجلون على Deal يحصلون على شارة «عضو مؤسس» الدائمة في ملفهم — تمييز مبكر لا يُمنح لمن يسجل بعد اكتمال العدد.',
    a_en: 'The first 100 creators to register on Deal receive a permanent "Founding Member" badge on their profile — an early distinction that is not granted once the first hundred is complete.' },
  { id: 'disputes', q_ar: 'كيف أفتح نزاعاً على حجز؟', q_en: 'How do I open a dispute on a booking?',
    keys: ['نزاع', 'مشكلة في حجز', 'اشتكي', 'شكوى', 'dispute', 'complaint', 'problem with booking'],
    a_ar: 'من داخل الحجز اضغط «فتح نزاع» واكتب السبب: يتجمّد تقدم الحجز فوراً في مرحلته الحالية (لا دفعات جديدة ولا تسليم ولا اكتمال) لحد قرار الإدارة (لصالح طرف + عقوبات موثّقة)، وبتتولّد «حزمة أدلة» تلقائياً من سجل الحجز تقدر تستخدمها في بلاغات حقوق النشر على المنصات. ثم يُحل النزاع إما بإرجاع الحجز لمساره أو إلغائه — وكل ذلك موثّق داخل الحجز نفسه. تنبيه مهم: محادثة الطلب داخل Deal هي قناة الأدلة الوحيدة — أي اتفاق خارجها لا يُقبل دليلاً في التحكيم.',
    a_en: 'From inside the booking, tap "Open dispute" and state the reason: the booking\'s progress freezes immediately at its current stage (no new payments, delivery or completion) until the admin decides (for one side, with documented penalties), and an "evidence bundle" is auto-generated from the booking record for use in platform copyright reports. The dispute is then resolved either by restoring the booking to its track or cancelling it — all documented inside the booking itself. Important: the in-app order chat is the only evidence channel — agreements made outside it are not accepted as arbitration evidence.' },
  { id: 'penalties', q_ar: 'ما هي العقوبات والتجميد؟', q_en: 'What are the penalties and freezing rules?',
    keys: ['عقوبات', 'تجميد', 'تعليق', 'حظر', 'تقييمات سلبية', 'penalties', 'penalty', 'frozen', 'suspended', 'banned', 'negative reviews'],
    a_ar: 'العقوبات متدرجة وتلقائية من التقييمات السلبية: عند 3 تقييمات سلبية تنبيه رسمي، وعند 5 يُعلَّق الحساب ويُجمَّد رصيده داخل المنصة ولا يستقبل حجوزات جديدة، والاحتيال يؤدي للحظر بعد مراجعة الإدارة. أموالك في محفظتك الخارجية لا تستطيع المنصة تجميدها — التجميد داخل نظام Deal فقط.',
    a_en: 'Penalties are graduated and automatic from negative ratings: at 3 negative ratings an official warning, at 5 the account is suspended and its balance inside the platform frozen and it receives no new bookings, and fraud leads to a ban after admin review. Money in your external wallet cannot be frozen by the platform — freezing applies inside the Deal system only.' },
  { id: 'edit_profile', q_ar: 'كيف أعدّل ملفي أو أضيف صورة شخصية؟', q_en: 'How do I edit my profile or add a profile photo?',
    keys: ['تعديل الملف', 'اعدل', 'صورة شخصية', 'اضيف صورة', 'تغيير السعر', 'edit profile', 'profile photo', 'avatar', 'change price', 'update profile'],
    a_ar: 'من «لوحتي» افتح «ملفي الشخصي» ثم «تعديل الملف»: يمكنك تعديل الاسم والمجال والمدينة وعدد المتابعين والسعر والنبذة ورقم الهاتف، ورفع صورة شخصية (تُصغَّر تلقائياً لمربع صغير) تظهر في بطاقتك بالسوق وفي ملفك وفي الهيدر.',
    a_en: 'From "My dashboard" open "My profile" then "Edit profile": you can edit your name, niche, city, follower count, price, bio and phone number, and upload a profile photo (auto-cropped to a small square) that appears on your market card, your profile and the header.' },
  { id: 'shorts', q_ar: 'كيف أضيف نماذج شورتس لملفي؟', q_en: 'How do I add shorts samples to my profile?',
    keys: ['شورتس', 'نماذج', 'نماذج شغل', 'اضيف فيديو', 'معرض اعمال', 'shorts', 'samples', 'portfolio videos', 'add video', 'work samples'],
    a_ar: 'من «تعديل الملف» في قسم «نماذج الشورتس»: الصق رابط فيديو قصير (يوتيوب Shorts أو Facebook Reel أو Instagram Reel أو TikTok) مع عنوان اختياري — بحد أقصى 3 فيديوهات، وتظهر في ملفك العام كمقاطع مضمّنة شغالة داخل الملف نفسه لا كروابط. (روابط إثباتات التنفيذ من حجوزاتك المكتملة تظهر أيضاً أسفلها تلقائياً.)',
    a_en: 'From "Edit profile", in the "Shorts samples" section: paste a short video link (YouTube Shorts, Facebook Reel, Instagram Reel or TikTok) with an optional title — a maximum of 3 videos, shown on your public profile as embedded playable videos inside the profile, not as links. (Proof links from your completed bookings also appear below them automatically.)' },
  { id: 'founder_account', q_ar: 'ما هو حساب المؤسس ولماذا هو «عرض فقط»؟', q_en: 'What is the founder account and why is it "display only"?',
    keys: ['حساب المؤسس', 'مؤسس Deal', 'عرض فقط', 'founder account', 'display only', 'platform founder'],
    a_ar: 'حساب «مؤسس Deal» هو حساب مالك المنصة بهويته الرسمية الفريدة (ختم داكن وتاج ذهبي): يظهر للصناع المسجلين فقط كنموذج ومعرض هوية، وهو «عرض فقط» — بلا سعر وبلا تواصل وبلا حجوزات وبلا نماذج شورتس، ولا يمكن لأي حساب عادي الحصول على شكله.',
    a_en: 'The "Deal Founder" account is the platform owner\'s official unique identity (dark seal and gold crown): it is visible to registered creators only as an identity showcase, and it is "display only" — no price, no contact, no bookings and no shorts samples, and no regular account can obtain its design.' },
  { id: 'language', q_ar: 'كيف أبدّل لغة المنصة؟', q_en: 'How do I switch the platform language?',
    keys: ['لغة', 'انجليزي', 'english', 'language', 'switch language', 'عربي'],
    a_ar: 'من زر EN / عربي في الهيدر أو من «القائمة الرئيسية»: يتبدل كل نص في الواجهة بين العربية والإنجليزية مع اتجاه الصفحة، ويُحفظ اختيارك لزيارتك القادمة. المحتوى الذي يكتبه المستخدمون (أسماء، عناوين طلبات) يبقى كما هو بلغته الأصلية.',
    a_en: 'Use the EN / عربي button in the header or the main menu: every interface text switches between Arabic and English along with the page direction, and your choice is saved for your next visit. User-written content (names, request titles) stays in its original language.' },
  { id: 'booking_how', q_ar: 'كيف أحجز صانعاً أو يصلني شغل؟', q_en: 'How do I book a creator, or get work as a creator?',
    keys: ['احجز', 'حجز صانع', 'يصلني شغل', 'فرص ليك', 'شغل يجيلي', 'book a creator', 'how to book', 'get work', 'opportunities'],
    a_ar: 'العميل: من بطاقة الصانع في السوق اضغط «احجز» فيُفتح حجز محمي بضمان Deal بسعره المعلن. الصانع: الشغل يصلك من قسم «فرص ليك» الذي يطابق طلبات المحلات والحملات مع مدينتك ومجالك تلقائياً، ومن طلبات الضيوف التي تحوّلها لحجوزات بنفسك من السوق.',
    a_en: 'Clients: tap "Book" on a creator\'s market card to open a Deal-Guaranteed booking at the listed price. Creators: work reaches you through "Opportunities for you", which automatically matches shop requests and campaigns to your city and niche, and through guest requests you can convert into bookings yourself from the market.' },
  { id: 'star', q_ar: 'ما هي باقة «نجم Deal» وكيف أشترك؟', q_en: 'What is the Deal Star package and how do I subscribe?',
    keys: ['باقة نجم', 'نجم Deal', 'اشتراك النجم', 'باقة النجوم', 'star package', 'deal star', 'star subscription', '199'],
    a_ar: 'باقة «نجم Deal» (199 جنيهاً لمدة 30 يوماً) معمولة عشان تكبّر وتميّزك: شارة وإطار ذهبي في السوق، أولوية ترتيب وترشيح أول للعملاء، فرصتك في «نجم الأسبوع» مع بطاقة مشاركة، «وقود نمو» شهري بإحصاءاتك وأفكار محتوى لمجالك، وأولوية دعم. الاشتراك من صفحة الباقة في القائمة: بتحوّل المبلغ لحساب عمولات Deal وبتسجل مرجع التحويلة وبتوافق على الشروط — والباقة لا تتفعّل إلا بعد ما المالك يؤكد وصول الفلوس فعلياً، وساعتها تبدأ الـ30 يوماً وتوصلك رسالة التفعيل.',
    a_en: 'The "Deal Star" package (EGP 199 for 30 days) is built to grow and distinguish you: a gold badge and frame in the market, ranking priority and first recommendation to clients, your shot at "Star of the Week" with a shareable card, monthly "growth fuel" with your own stats and content ideas for your niche, and priority support. Subscribe from the package page in the menu: transfer the amount to the Deal fee account, enter the transfer reference and accept the terms — the package activates only after the owner confirms the money actually arrived, and your 30 days start at that moment with an activation message.' },
  { id: 'campaigns', q_ar: 'ما هي الحملات وكيف أقدّم عليها؟', q_en: 'What are campaigns and how do I apply?',
    keys: ['حملات', 'حملة', 'اقدم على', 'براند', 'campaign', 'campaigns', 'apply', 'brand'],
    a_ar: 'الحملات طلبات خدمة تنشرها البراندات من قسم «الحملات» ببريف وميزانية: الصانع يقدّم عليها من بطاقتها، وإذا قبل البراند تقديمه يُفتح حجز عادي تلقائياً بنفس حماية Deal ومراحل دفعها.',
    a_en: 'Campaigns are service requests posted by brands in the "Campaigns" section with a brief and budget: creators apply from the campaign card, and if the brand accepts, a normal booking opens automatically with the same Deal protection and payment stages.' },
  { id: 'countries', q_ar: 'هل Deal متاح في بلدي؟ ما هي الدول المتاحة؟', q_en: 'Is Deal available in my country? Which countries are supported?',
    keys: ['الدول المتاحه', 'دول متاحه', 'متاح في بلدي', 'في بلدي', 'بلدي متاح', 'دول عربية', 'available countries', 'which countries', 'supported countries', 'my country'],
    a_ar: 'Deal متاح الآن في 19 دولة عربية: مصر، السعودية، الإمارات، الكويت، قطر، الأردن، المغرب، البحرين، عُمان، العراق، الجزائر، تونس، لبنان، فلسطين، ليبيا، السودان، اليمن، سوريا، وموريتانيا. اختر دولتك عند التسجيل (أو في نموذج «طلب خدمة» كضيف) وسيظهر سعرك بعملة بلدك، ورقم هاتفك يُتحقق منه بقاعدة بلدك، والدفع المحلي عندك هو وسيلة التحويل المعروفة في بلدك (مثل فودافون كاش/إنستاباي في مصر، وSTC Pay/مدى في السعودية، وCliQ في الأردن).',
    a_en: 'Deal is now available in 19 Arab countries: Egypt, Saudi Arabia, UAE, Kuwait, Qatar, Jordan, Morocco, Bahrain, Oman, Iraq, Algeria, Tunisia, Lebanon, Palestine, Libya, Sudan, Yemen, Syria and Mauritania. Pick your country when you register (or in the guest "Request a service" form) and your price shows in your country\'s currency, your phone is validated by your country\'s rules, and payments use your local method (e.g. Vodafone Cash/InstaPay in Egypt, STC Pay/mada in Saudi Arabia, CliQ in Jordan).' },
];
function normSupportText(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}% ]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function supportMatch(q) {
  const nq = ' ' + normSupportText(q) + ' ';
  let best = null, bestScore = 0; const scored = [];
  for (const item of SUPPORT_KB) {
    let score = 0;
    for (const k of item.keys) {
      const nk = normSupportText(k);
      if (nk && nq.includes(nk)) score += Math.max(2, nk.length >= 6 ? 3 : 2);
    }
    scored.push({ item, score });
    if (score > bestScore) { bestScore = score; best = item; }
  }
  scored.sort((a, b) => b.score - a.score);
  return { best: bestScore >= 2 ? best : null, closest: scored.filter(s => s.score > 0).slice(0, 3).map(s => s.item) };
}
app.get('/api/support/topics', (req, res) => {
  const lang = req.query.lang === 'en' ? 'en' : 'ar';
  res.json({ items: SUPPORT_KB.map(x => ({ id: x.id, q: lang === 'en' ? x.q_en : x.q_ar })) });
});
app.post('/api/support/ask', async (req, res) => {
  const { q, contact = '' } = req.body || {};
  const lang = (req.body && req.body.lang) === 'en' ? 'en' : 'ar';
  if (!q || !String(q).trim()) return res.status(400).json({ error: lang === 'en' ? 'Write your question first' : 'اكتب سؤالك أولاً' });
  const { best, closest } = supportMatch(String(q));
  if (best) {
    return res.json({ fallback: false, topic: best.id, answer: lang === 'en' ? best.a_en : best.a_ar });
  }
  // سؤال خارج القاعدة: يُحفظ للمالك (مع حساب السائل إن كان مسجلاً) ويُرد باحتياط مهذب.
  // مشترك «نجم Deal» النشط تُعلَّم رسالته «أولوية» في لوحة المالك تلقائياً.
  const viewer = await optionalViewer(req);
  const priority = viewer && !viewer.is_platform_founder && (await isStar(viewer.id)) ? 1 : 0;
  await db.prepare('INSERT INTO support_messages (user_id,question,contact,lang,priority,created_at) VALUES (?,?,?,?,?,?)')
    .run(viewer ? viewer.id : null, String(q).slice(0, 1000), String(contact || '').slice(0, 120), lang, priority, now());
  const topics = (closest.length ? closest : SUPPORT_KB.slice(0, 3)).map(x => lang === 'en' ? x.q_en : x.q_ar);
  res.json({
    fallback: true,
    topics,
    answer: lang === 'en'
      ? 'Thanks for your question — I don\'t have a ready answer for it yet, so I saved it for the Deal team to review. You can leave a contact (optional) in the box below, or try one of the closest topics:'
      : 'شكراً لسؤالك — لا توجد لديّ إجابة جاهزة عنه بعد، فحفظته لفريق Deal للمراجعة. يمكنك ترك وسيلة تواصل (اختياري) في الخانة بالأسفل، أو جرّب أحد أقرب المواضيع:',
  });
});

/* ---------------- دعواتي: إحالات رابط ملفي + مكافآتها ---------------- */
app.get('/api/me/referrals', auth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM users WHERE referred_by=? ORDER BY created_at DESC').all(req.user.id);
  // بيانات آمنة فقط: اسم/صورة/مدينة/مجال/تاريخ/حالة توثيق — بلا أي وسيلة تواصل.
  const items = rows.map((u) => ({
    id: u.id, name: u.name, city: u.city, niche: u.niche, created_at: u.created_at,
    avatar: u.is_platform_founder ? '' : (u.avatar || ''),
    verified: !!u.verified && !u.banned && !u.frozen, // «موثقة» بنفس قاعدة الاحتساب
    is_platform_founder: !!u.is_platform_founder,
  }));
  res.json({
    items,
    total: items.length,
    verified_count: items.filter((i) => i.verified).length,
    ambassador_target: REFERRAL_AMBASSADOR_TARGET,
    featured_min: REFERRAL_FEATURED_MIN,
    featured: (req.user.featured_until || 0) > now(),
    featured_until: req.user.featured_until || 0,
  });
});

/* ---------------- شريط «كله في مكان واحد»: ملخص لوحتي في استدعاء واحد ---------------- */
app.get('/api/me/overview', auth, async (req, res) => {
  const u = req.user;
  let opportunities = 0;
  if (u.role === 'creator') {
    const reqs = await db.prepare(`SELECT * FROM shop_requests WHERE status='open' AND (target_talent_id IS NULL OR target_talent_id=?)`).all(u.id);
    const camps = await db.prepare(`SELECT * FROM campaigns WHERE status='open'`).all();
    opportunities = [...reqs, ...camps].filter((x) => x.target_talent_id === u.id || matchScore(u, x).score > 0).length;
  } else if (u.role === 'provider') {
    opportunities = (await db.prepare(`SELECT COUNT(*) c FROM shop_requests WHERE status='open' AND target_talent_id=?`).get(u.id)).c;
  }
  const active_bookings = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE (client_id=? OR talent_id=?) AND status NOT IN ('completed','cancelled')`).get(u.id, u.id)).c;
  const unread_messages = (await db.prepare('SELECT COUNT(*) c FROM messages WHERE recipient_id=? AND is_read=0').get(u.id)).c
    + await guestUnreadForTalent(u.id);
  res.json({
    opportunities,
    active_bookings,
    unread_messages,
    followers: await followersCount(u.id),
    verified_referrals: await verifiedReferralCount(u.id),
  });
});

/* ---------------- تقدّم الشارات: مستويات الصانع نحو كل شارة ----------------
   لكل شارة في محرك الشارات القائم: قيمتها الحالية والهدف ونسبة التقدم وعلم
   التحصيل — وكلها من badgeMetrics نفسها التي يقرر بها computeBadges التحصيل
   (لا قواعد موازية). تعريف «التقدم» لكل شارة موثّق في TESTING-DESIGN-FOUNDER.md:
   للشارات العدّية النسبة = الحالي/الهدف؛ وللشارتين ذواتَي الشرط النوعي الإضافي
   (إتمام مثالي: نسبة إتمام 100%، الأعلى تقييماً: إيجابية 95%+) تُعرَض القيمة
   الحالية للشرط في detail بصدق وتُحجَب النسبة عند 99 حتى يتحقق الشرطان معاً؛
   و«مخضرم» بوابتها المزدوجة (عمر + صفقات) نسبتُها نسبةُ البوابة الأبطأ. */
app.get('/api/me/badges-progress', auth, async (req, res) => {
  const badges = await computeBadges(req.user.id);
  const m = await badgeMetrics(req.user.id);
  const s = m.s;
  const byKey = {
    perfect:    { current: Math.min(s.completed_deals, 10), target: 10,
                  detail: { completed_deals: s.completed_deals, completion_rate: s.completion_rate, required_rate: 100 } },
    top_rated:  { current: Math.min(s.reviews_count, 10), target: 10,
                  detail: { reviews_count: s.reviews_count, positive_pct: s.positive_pct, required_positive: 95 } },
    fast:       { current: m.onTimeCount, target: 5,
                  detail: { proofs_considered: m.lastProofs.length, on_time: m.onTimeCount } },
    rising:     { current: Math.min(s.completed_deals, 5), target: 5,
                  detail: { completed_deals: s.completed_deals } },
    ambassador: { current: Math.min(m.invitedDone, REFERRAL_AMBASSADOR_TARGET), target: REFERRAL_AMBASSADOR_TARGET,
                  detail: { verified_referrals: m.invitedDone } },
    veteran:    { current: Math.min(s.completed_deals, 20), target: 20,
                  detail: { completed_deals: s.completed_deals, age_days: Math.floor(m.ageMs / (24 * 3600 * 1000)), required_age_days: 180 } },
  };
  const items = badges.map((b) => {
    const d = byKey[b.key] || { current: 0, target: 0, detail: {} };
    let pct = b.earned ? 100 : (d.target ? Math.round((100 * Math.min(d.current, d.target)) / d.target) : 0);
    if (!b.earned) {
      // شرط نوعي إضافي غير متحقّق رغم اكتمال العدد: النسبة لا تدّعي الاكتمال.
      if (b.key === 'perfect' && s.completed_deals >= 10 && s.completion_rate < 100) pct = Math.min(pct, 99);
      if (b.key === 'top_rated' && s.reviews_count >= 10 && (s.positive_pct ?? 0) < 95) pct = Math.min(pct, 99);
      // مخضرم: النسبة هي نسبة البوابة الأبطأ (العمر أو الصفقات) — لا متوسط مختلق.
      if (b.key === 'veteran') pct = Math.round(100 * Math.min(Math.min(m.ageMs / (180 * 24 * 3600 * 1000), 1), Math.min(s.completed_deals / 20, 1)));
    }
    return {
      key: b.key, name: b.name, color: b.color, earned: b.earned,
      current: d.current, target: d.target, remaining: Math.max(0, d.target - d.current),
      pct, detail: d.detail,
    };
  });
  res.json({ items });
});

/* ---------------- وقود النمو الشهري (باقة نجم Deal) ----------------
   بنك محتوى دوّار مُعدّ داخل الكود: لكل مجال صانع ولكل خدمة مقدم أفكار محتوى
   رائجة مكتوبة بعناية بالعربية + خطوات نمو. الاختيار حتمي برقم الشهر: نافذة
   دوّارة من ٣ أفكار وخطوة واحدة — فيتجدد الوقود شهرياً مع الاشتراك دون تكرار
   فوري، ونفس الشهر يعيد نفس المحتوى لأي مشترك في نفس المجال. */
const STAR_FUEL = {
  'كوميديا': { ideas: ['سكتش «الزبون اللي بيجرّب كل حاجة ومبيشتريش» في محل من مدينتك — شخصيات ثابتة ونهاية مفاجئة في آخر ٣ ثوانٍ.', 'سلسلة «لو الإعلانات اتكلمت»: منتج محلي مشهور بيشتكي من صاحبه بصوت مضحك — قابلة للرعاية من محلات حقيقية.', 'تحدي «أرخص إعلان في مصر»: اعمل إعلاناً كاملاً لمنتج بـ١٠ جنيهات وخلي الجمهور يقيّم النتيجة.'], steps: ['ثبّت شخصيتين متكررتين في كل سكتشاتك هذا الشهر — التكرار بيبني جمهوراً بيستنى الحلقة.', 'انشر ٤ مرات أسبوعياً في نفس المواعيد وخلي أول ثانيتين سؤالاً أو موقفاً صادماً.'] },
  'طبخ': { ideas: ['«أكلة الشارع بـ٥٠ جنيه»: نفس الطبق من مطعم مشهور ومحلي شعبي — مقارنة سعر وطعم قدّام الكاميرا.', 'وصفة «من غير فرن ومن غير تعقيد» بمكونات من أي بقالة — محتوى بيتحفظ ويتشارك كتير.', 'تحدي طبخ أكلة تراثية من محافظتك بلمسة عصرية وخلي المتابعين يختاروا التقييم.'], steps: ['صوّر الإضاءة الطبيعية جنب شباك وخلي لقطة «الجبنة بتسحب» أو «القرمشة» في أول ثانيتين.', 'حوّل أنجح وصفة عندك لسلسلة أجزاء (الجزء ٢ و٣) بدل فيديو واحد وخلاص.'] },
  'رياضة': { ideas: ['تحليل تكتيكي في ٦٠ ثانية لأهم لقطة في ماتش الأسبوع — رأي جريء ومدعوم بلقطة مرسومة.', '«توقّع واكسب»: توقعاتك قبل الجولة ومراجعة صريحة لنتائجك بعدها — مصداقية بتتبني قدام الناس.', 'تحدي لياقة ٧ أيام للمبتدئين بتمارين في البيت من غير أدوات — حلقة كل يوم.'], steps: ['انشر تحليلك في أول ساعة بعد الماتش — التوقيت أهم من الإنتاج في محتوى الرياضة.', 'اعمل جدول توقعات أسبوعي ثابت وخلي جمهورك يشارك بتوقعاته في التعليقات.'] },
  'جمال': { ideas: ['«روتين الصيدلية»: بدائل اقتصادية لمنتجات غالية بنفس النتيجة — مقارنة قبل/بعد صادقة.', 'تحدي مكياج بـ١٠٠ جنيه من منتجات محلية بس — النتيجة قدّام الكاميرا من غير فلاتر.', 'أخطاء شائعة في العناية بالبشرة بتصححيها واحدة واحدة في سلسلة قصيرة.'], steps: ['صوّري النتيجة النهائية في أول لقطة وبعدين ارجعي للخطوات — الفضول بيكمّل المشاهدة.', 'ثبّتي يوماً أسبوعياً لأسئلة المتابعين وردي عليها بفيديوهات قصيرة بأسمائهم.'] },
  'مراجعات وتقنية': { ideas: ['مراجعة «بعد شهر استخدام» بدل مراجعة فتح العلبة — عيوب حقيقية محدش بيقولها.', 'مقارنة هاتفين في نفس الفئة السعرية باختبارات واقعية: كاميرا في إضاءة ضعيفة وبطارية يوم كامل.', '«يستاهل ولا لأ؟» — حكم نهائي في أول ٥ ثوانٍ وبعدين الأدلة.'], steps: ['اكتب حكمك النهائي في عنوان الفيديو نفسه — المراجعات الصريحة بتتشارك أكتر.', 'اعمل قائمة «أفضل ٥ في فئة سعرية» شهرية وخليها مرجع جمهورك قبل الشراء.'] },
  'تعليم': { ideas: ['«قاعدة في دقيقة»: أصعب قاعدة في منهجك بشرح مثال واحد من الحياة اليومية.', 'تصحيح أشهر خطأ بيقع فيه الطلبة في الامتحان — بصيغة «لو شفت ده اعمل كده».', 'سلسلة مراجعة ليلة الامتحان: ٥ فيديوهات قصيرة بأهم الأسئلة المتوقعة.'], steps: ['ابدأ كل فيديو بالسؤال نفسه اللي بيكتبه الطالب في بحث جوجل — ده عنوانك الحقيقي.', 'حوّل تعليقات الطلبة لخطة محتوى الشهر الجاي واذكر أسماءهم في الردود.'] },
  'ألعاب': { ideas: ['تحديات غريبة داخل لعبتك المشهورة: «أكمل المهمة من غير سلاح» مع تعليق كوميدي مصري.', 'أخبار وتسريبات الأسبوع في ٩٠ ثانية بصيغة سريعة ومركزة.', 'مقارنة «زمان ودلوقتي»: نفس اللعبة بأجزائها القديمة والجديدة — الحنين بيشد جمهوراً كبيراً.'], steps: ['قصّ اللحظات الميتة بلا رحمة — إيقاع سريع يعني احتفاظ أعلى في محتوى الجيمنج.', 'اعمل بثاً مباشراً أسبوعياً ثابتاً وخلي مقاطع البث وقود ريلز الأسبوع كله.'] },
  'سفر': { ideas: ['«يوم كامل في مدينة مصرية بـ٣٠٠ جنيه»: خطة حقيقية بأسعار وأماكن محددة — محتوى بيتحفظ فوراً.', 'أماكن مخفية في محافظتك لا يعرفها حتى أهلها — سلسلة «كنز جنبك».', 'أخطاء بتضيّع فلوسك في السفر وازاي تتجنبها — من تجربة حقيقية موثقة بالأسعار.'], steps: ['اكتب الأسعار والعناوين على الشاشة في كل لقطة — المعلومة الدقيقة هي سبب الحفظ والمشاركة.', 'صوّر نسخة عمودية وأفقية من نفس الرحلة — محتوى واحد لمنصتين.'] },
  'أطفال': { ideas: ['تجربة علمية آمنة بمكونات المطبخ تدهش الأطفال — وتتشرح بخطوات بسيطة للأهل.', 'قصة قبل النوم بصوتك وشخصيات ثابتة — سلسلة ليلية ينتظرها الأطفال والأمهات.', 'أغنية تعليمية قصيرة (ألوان/أرقام/حروف) بلحن بسيط وحركة يد سهلة التقليد.'], steps: ['خلي أول ٣ ثوانٍ سؤالاً للطفل مباشرة («تفتكر هيحصل إيه؟») — التفاعل بيبدأ من هنا.', 'انشر في مواعيد ما بعد المدرسة وقبل النوم — توقيت جمهور الأطفال ثابت ومعروف.'] },
  'ديني': { ideas: ['«آية ومعنى»: آية واحدة بتفسير مبسط وتطبيق عملي في يومنا — في أقل من دقيقة.', 'قصص الأنبياء والسيرة بحلقات قصيرة متسلسلة — حلقة كل يومين في نفس الموعد.', 'تصحيح مفاهيم شائعة بأسلوب هادئ وموثّق بالمصادر على الشاشة.'], steps: ['ثبّت موعداً يومياً أو أسبوعياً لا يتغير — جمهور المحتوى الديني بيبني عادة حوالين موعدك.', 'اكتب المصدر على الشاشة دائماً — التوثيق الظاهر بيبني ثقة طويلة المدى.'] },
  'أخبار وتريند': { ideas: ['«التريند في ٦٠ ثانية»: ملخص أسبوعي سريع لأهم ما شغل الناس — بصوتك ورأيك.', 'تحقق من خبر منتشر: «الحقيقة فين؟» — بحث موثق بالمصادر قدّام الكاميرا.', 'رأيك الصريح في قضية الأسبوع مع استطلاع للجمهور — وبعده فيديو بنتائج الاستطلاع.'], steps: ['السرعة نصف النجاح في التريند: انشر في أول ساعات الصعود لا بعد ذروته.', 'خلي عندك قالب عنوان ثابت يتعرف من أول نظرة («التريند في ٦٠ ثانية» مثلاً).'] },
  'حرف وDIY': { ideas: ['«قبل وبعد»: تحويل قطعة قديمة مهملة لتحفة في ٦٠ ثانية — لقطة النتيجة أولاً.', 'مشروع بميزانية محددة (٥٠ جنيه) من الخردة لأداة مفيدة في البيت.', 'أخطاء المبتدئين في حرفتك وازاي تتجنبها — سلسلة بتوفر على الناس فلوس وتعب.'], steps: ['صوّر النتيجة النهائية من ٣ زوايا في أول الفيديو — «إزاي وصل لكده؟» هو محرك المشاهدة.', 'اكتب قائمة الأدوات والخامات على الشاشة — الناس بتحفظ الفيديو عشان ترجع لها.'] },
  'سيارات': { ideas: ['«عيوب محدش بيقولها» عن سيارة منتشرة — مراجعة مالك حقيقي بعد سنة استخدام.', 'مقارنة تكلفة صيانة سيارتين منافستين بأرقام مراكز صيانة حقيقية.', 'فحص سيارة مستعملة قبل الشراء: ٧ نقاط تفحصها بنفسك في ٥ دقائق.'], steps: ['الأرقام الحقيقية (أسعار/استهلاك/صيانة) هي عملتك — وثّقها على الشاشة دائماً.', 'اعمل سلسلة «سيارة الأسبوع المستعملة» بسعر محدد ينتظرها الباحثون عن شراء.'] },
  'عقارات': { ideas: ['جولة حقيقية في شقة بسعر معلن — المميزات والعيوب بصوتك من غير تجميل.', '«بنفس الميزانية»: مقارنة منطقتين مختلفتين بنفس السعر — خدمات ومساحات ومستقبل.', 'أخطاء بتخسرك فلوس عند شراء أول شقة — من واقع صفقات حقيقية.'], steps: ['ابدأ بالسعر والمنطقة في أول ثانيتين — جمهور العقارات بيقرر بسرعة.', 'صوّر في ضوء النهار دائماً واذكر المساحة الصافية لا الإجمالية — الصدق بيبيع.'] },
  'صحة ولياقة': { ideas: ['تحدي ١٤ يوماً موثق بالقياسات والصور — بداية ونهاية صادقة من غير مبالغة.', '«أكلة صحية بسعر الشارع»: بدائل اقتصادية للدايت من مطاعم وسوبرماركت عادية.', 'تصحيح أشهر خرافات التخسيس والعضلات — واحدة في كل فيديو بدليل بسيط.'], steps: ['وثّق تقدمك أنت أولاً — الجمهور بيتابع رحلة حقيقية مش نصايح نظرية.', 'انشر جدولك الأسبوعي كاملاً في منشور مثبت وخلي الفيديوهات تفاصيل أيامه.'] },
  'موسيقى': { ideas: ['كوفر لأغنية تريند بأسلوبك الخاص (توزيع مختلف أو آلة واحدة) — بصمتك هي الفرق.', '«اتعملت إزاي؟»: تفكيك أغنية مشهورة لطبقاتها وبنائها من الصفر قدّام الجمهور.', 'تحدي ارتجال على لحن يختاره الجمهور من التعليقات — حلقة أسبوعية ثابتة.'], steps: ['أول ٥ ثوانٍ أقوى مقطع في الأغنية — لا تبدأ بالمقدمة أبداً في الفيديوهات القصيرة.', 'اطلب من الجمهور اختيار أغنية الحلقة الجاية — المشاركة في القرار بترفع الوصول.'] },
  'تصوير': { ideas: ['«نفس المكان — موبايل وكاميرا»: مقارنة صادقة بتوضح إمتى الموبايل يكفي.', 'تعديل صورة متابع خطوة بخطوة — ابعتهالك وخدها نسخة احترافية في فيديو.', '٣ زوايا بتخلي أي منتج شكله غالي — درس عملي لأصحاب المحلات.'], steps: ['انشر الصورة قبل التعديل وبعده كأول لقطتين — التباين هو إعلانك المجاني.', 'اعرض جلسة تصوير كاملة لعميل حقيقي (بإذنه) — الشغل الحقيقي بيبيع أكتر من النظري.'] },
  'عام': { ideas: ['«يوم في حياة…» مهنة أو شخصية من مدينتك — توثيق حقيقي قريب من الناس.', 'تجربة اجتماعية بسيطة: سؤال واحد لـ١٠ أشخاص من الشارع وإجابات غير متوقعة.', 'سلسلة «جربت عشانك»: بتجرب منتج/خدمة/مكان الناس بتسأل عنه وبتقول الحكم الصريح.'], steps: ['اختار فكرة واحدة وكررها ١٠ مرات بصيغ مختلفة قبل ما تحكم عليها — الاستمرارية قبل التنويع.', 'حوّل أنجح فيديو عندك لسلسلة ثابتة باسم معروف وخلي الجمهور يطلب أجزاءها.'] },
  'videoproduction': { ideas: ['«إعلان كامل في يوم واحد»: وثّق إنتاج إعلان لمحل محلي من الفكرة والسكربت للمشاهد والمونتاج — الكواليس نفسها أقوى إعلان لخدمتك.', 'إعلان بالذكاء الاصطناعي لمنتج حقيقي: مشاهد مولّدة بصوت ومونتاج احترافي — زاوية بتخلي أي براند صغير شكله كبير وميزانيته صغيرة.', 'تفكيك إعلان ناجح: الفكرة والهوك واللقطات اللي خلته يبيع — وبتعرض خبرتك في إنتاج الفيديوهات والإعلانات كاملة أثناء الشرح.'], steps: ['اعرض كل إعلان في ملفك بنتيجته (مشاهدات/طلبات/مبيعات) لا كرابط فقط — العميل بيشتري النتيجة لا الفيديو.', 'جهّز باقة «إعلان جاهز» بسعر واضح ومدة تنفيذ محددة — الوضوح في العرض بيقفل الصفقات أسرع من أي تفاوض.'] },
  'editing': { ideas: ['عرض «قبل/بعد» لمونتاجك: المادة الخام والنتيجة في شاشة واحدة — أقوى إعلان لخدمتك.', 'تفكيك إعلان مشهور: القطعات والانتقالات اللي خلته ينتشر — وبتعرض مهارتك أثناء الشرح.', 'تحدي مونتاج فيديو كامل في ساعة واحدة موثق بالوقت — سرعة وجودة معاً.'], steps: ['اعمل ٣ قوالب انتقالات جاهزة بأسلوبك وسمّها باسمك — القالب المميز بيخلي العميل يطلبك بالاسم.', 'انشر نموذجاً أسبوعياً قصيراً حتى في غياب العملاء — ملفك الحي هو مبيعاتك.'] },
  'design': { ideas: ['إعادة تصميم شعار/منشور محل محلي معروف (كمبادرة) — قبل/بعد بيكلم أصحاب المحلات مباشرة.', '«غلطة بتقتل التصميم» — سلسلة أخطاء شائعة في منشورات المحلات وتصحيحها.', 'تحدي تصميم منشور كامل في ١٠ دقائق من الصفر — سرعة التنفيذ جزء من عرضك.'], steps: ['اعرض كل تصميم في سياقه الحقيقي (ماكيت موبايل/واجهة محل) لا كصورة عائمة.', 'جهّز باقة «قبل/بعد» لثلاثة محلات مختلفة المجالات — التنوع بيوسّع سوقك.'] },
  'filming': { ideas: ['كواليس جلسة تصوير منتج: الإضاءة البسيطة اللي طلعت نتيجة فاخرة.', '«بمعدات بسيطة»: نفس اللقطة بإضاءة احترافية وبديلة اقتصادية — الفرق والحل.', 'جولة تصوير لمكان/محل من مدينتك كعينة مجانية من أسلوبك.'], steps: ['انشر لقطة «الإعداد» قبل «النتيجة» دائماً — الكواليس بتبني ثقة العميل في احترافك.', 'اعرض أسعار باقاتك بمقاطع نتائج حقيقية لا بقوائم نصية.'] },
  'voiceover': { ideas: ['نفس النص بثلاثة أساليب (حماسي/هادئ/وثائقي) — عينة واحدة بتوري مدى صوتك كله.', 'تعليقك على إعلان صامت مشهور — قبل (صامت) وبعد (بصوتك).', 'تحدي «اقرأ أي حاجة كإعلان»: نص عشوائي من الجمهور بأداء إعلاني كامل.'], steps: ['سجّل عينات قصيرة لكل مجال (عقارات/مطاعم/تطبيقات) وخليها جاهزة للإرسال فور أي طلب.', 'انشر بمعدل عينة أسبوعياً — الصوت بيتنسى بسرعة لو غاب.'] },
  'script': { ideas: ['إعادة كتابة إعلان ضعيف منتشر: النص الأصلي ونسختك — الفرق بيشرح قيمتك.', '«هوك في ٣ ثوانٍ»: ٥ بدايات مختلفة لنفس المنتج والجمهور يختار الأقوى.', 'تفكيك سكربت فيديو وصل لملايين المشاهدات: البنية خطوة بخطوة.'], steps: ['اكتب لكل عميل محتمل «هوك» مجانياً واحداً في رسالتك الأولى — العينة بتفتح الباب.', 'ابنِ مكتبة هوكات مصنفة بالمجالات وحدّثها شهرياً من التريندات.'] },
  'accounts': { ideas: ['دراسة حالة: حساب نميته بأرقام حقيقية (قبل/بعد) — بإذن صاحبه وبالأدلة.', '«٣ أخطاء بتقتل وصول حسابك» — سلسلة تدقيق سريع لحسابات حقيقية.', 'خطة محتوى شهر كامل لنيش واحد قدّام الكاميرا — بتوري طريقة شغلك كاملة.'], steps: ['وثّق نتائجك بالأرقام والسكرين شوت دائماً — إدارة الحسابات بتتباع بالأدلة لا بالوعود.', 'اعرض باقة «تدقيق مجاني مصغر» كمدخل — ٣ ملاحظات سريعة على حساب العميل المحتمل.'] },
  'ads': { ideas: ['تفكيك إعلان ناجح: الاستهداف والرسالة والميزانية التقديرية — تحليل بيوري خبرتك.', '«نفس الإعلان بميزانيتين»: إزاي توزع ٥٠٠ جنيه مقابل ٥٠٠٠ على حملة واحدة.', 'أخطاء بتحرق ميزانية الإعلانات عند المحلات الصغيرة — وتصحيحها خطوة بخطوة.'], steps: ['انشر نتيجة حملة حقيقية واحدة شهرياً (بإذن العميل) — رقم واحد موثق أقوى من ألف وعد.', 'جهّز حاسبة ميزانية بسيطة تشاركها مع العملاء المحتملين كأداة مجانية باسمك.'] },
  'support': { ideas: ['شرح حل مشكلة حساب شائعة خطوة بخطوة (استرجاع/تقييد/توثيق) — محتوى بيتبحث عنه يومياً.', '«احمي حسابك»: إعدادات أمان أساسية أغلب الناس مش مفعّلاها — سلسلة وقائية.', 'أسئلة العملاء المتكررة وإجاباتها في فيديوهات قصيرة — بتوفر عليك وعليهم وقتاً.'], steps: ['وثّق كل حالة حلّيتها (من غير بيانات خاصة) في ملف نتائج — سجلّك هو إعلانك.', 'رد على أسئلة التعليقات بفيديوهات — كل سؤال متكرر هو خدمة مطلوبة.'] },
  'translation': { ideas: ['«بتتقال إزاي؟» — تعبيرات يومية بلغة عملك بترجمة طبيعية لا حرفية.', 'أخطاء ترجمة مضحكة/خطيرة في إعلانات منتشرة وتصحيحها — محتوى بيتنشر بسرعة.', 'ترجمة مقطع تريند عالمي بتعليقك — وبتعرض دقتك وأسلوبك معاً.'], steps: ['اعرض عينات ثنائية الاتجاه (من/إلى) في ملفك — أغلب العملاء بيدوروا على اتجاه محدد.', 'تخصص في مجال ترجمة واحد ظاهر في عنوانك (طبي/قانوني/تسويقي) — التخصص بيرفع سعرك.'] },
  'dev': { ideas: ['«موقع في أسبوع»: توثيق بناء مشروع حقيقي من الصفر للنشر — حلقات قصيرة.', 'تفكيك ميزة في تطبيق مشهور وإعادة بنائها — بتعرض عمقك التقني بأسلوب مبسط.', 'أخطاء بتخلي موقع المحل يخسر عملاء (سرعة/موبايل/طلب) وتصحيحها عملياً.'], steps: ['انشر مشروعاً تجريبياً حياً واحداً شهرياً برابط شغال — الرابط الحي أقوى من أي سيرة ذاتية.', 'اعرض نتائج سرعة/أداء قبل وبعد لأي موقع لمسته — الأرقام بتقنع أصحاب الأعمال.'] },
  'marketing': { ideas: ['خطة تسويق كاملة لمحل وهمي في ٥ دقائق — بتوري طريقة تفكيرك من الصفر.', 'تفكيك حملة براند ناجحة: الفكرة والتنفيذ والنتائج التقديرية.', '«لو كنت مكانهم»: إزاي تسوّق لمنتج صعب/ممل — تحدي بيظهر إبداعك.'], steps: ['اعرض خططك بقوالب بصرية ثابتة تحمل هويتك — القالب المعروف بيخلي المحتوى «بتاعك».', 'اربط كل فكرة بنتيجة قابلة للقياس (مبيعات/حجوزات/رسائل) — العملاء بيشتروا النتائج.'] },
  'other': { ideas: ['عرض «قبل/بعد» من شغلك الحقيقي — أقوى إعلان لأي خدمة هو نتيجتها.', '«بتتعمل إزاي؟» — كواليس تنفيذ خدمتك خطوة بخطوة بتبني ثقة فورية.', 'إجابة أعمق سؤال بيتسأل في مجالك — فيديو واحد يخليك مرجعاً.'], steps: ['وثّق نتائج عملائك (بإذنهم) وانشر نتيجة واحدة أسبوعياً — الانتظام بيبني سوقك.', 'اعرض خدمتك داخل قصة عميل حقيقي لا كقائمة مميزات.'] },
};
function starFuelFor(u) {
  const key = u.role === 'provider' ? (u.provider_category || 'other') : (u.niche || 'عام');
  const bank = STAR_FUEL[key] || (u.role === 'provider' ? STAR_FUEL.other : STAR_FUEL['عام']);
  const d = new Date();
  const monthIndex = d.getFullYear() * 12 + d.getMonth();
  const ideas = [];
  for (let i = 0; i < Math.min(3, bank.ideas.length); i++) ideas.push(bank.ideas[(monthIndex + i) % bank.ideas.length]);
  return { key, ideas, step: bank.steps[monthIndex % bank.steps.length], month_index: monthIndex };
}

/* ---------------- باقة «نجم Deal»: المسارات ----------------
   قاعدة المال الصارمة: الاشتراك يولد «قيد التحقق» بلا أي ميزة، ولا يتحول
   «نشطاً» إلا بتأكيد المالك من لوحته أن التحويلة وصلت فعلياً — وعند التأكيد
   تبدأ الـ30 يوماً من تلك اللحظة. رقم العمولة لا يظهر إلا داخل خطوة دفع
   الباقة لعضو مؤهل (نفس قاعدة رقم عمولة الحجز). */
app.get('/api/star/info', async (req, res) => {
  await sweepStar();
  const activeCount = (await db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM star_subscriptions WHERE status='active' AND expires_at>?`).get(now())).c;
  res.json({ price: STAR_PRICE, currency: STAR_CURRENCY, days: 30, terms_version: STAR_TERMS_VERSION, active_stars: activeCount });
});
app.get('/api/star/me', auth, async (req, res) => {
  res.json(await myStarState(req.user.id));
});
/** رقم دفع الباقة: فقط لعضو مؤهل للاشتراك، وفقط داخل خطوة الدفع. */
app.get('/api/star/payment-info', auth, async (req, res) => {
  if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس لا يشترك في الباقات' });
  if (!['creator', 'provider'].includes(req.user.role)) return res.status(400).json({ error: 'باقة نجم Deal للصناع ومقدمي الخدمة فقط' });
  const st = await myStarState(req.user.id);
  if (st.state === 'active') return res.status(400).json({ error: 'اشتراكك في نجم Deal نشط بالفعل' });
  if (st.state === 'pending') return res.status(400).json({ error: 'عندك اشتراك قيد التحقق بالفعل — استنى تأكيد الاستلام' });
  // فتح خطوة الدفع ينشئ/يجلب التزام الاشتراك بمرجعه المالي (كود + مبلغ ببصمة).
  const ob = await getOrCreateObligation({
    kind: 'star_subscription', user_id: req.user.id, base_amount: STAR_PRICE,
    currency: STAR_CURRENCY, payer_user_id: req.user.id, payee: 'owner',
  });
  const colStar = await collectorForObligation(ob);
  res.json({ label: 'Deal — حساب عمولات المنصة', phone: colStar.phone, collector_via: colStar.via, methods: ['Vodafone Cash', 'InstaPay'], amount: STAR_PRICE, currency: STAR_CURRENCY, obligation: await payerObligationView(ob, req.user.country) });
});
app.post('/api/star/subscribe', auth, async (req, res) => {
  const u = req.user;
  if (u.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس لا يشترك في الباقات' });
  if (!['creator', 'provider'].includes(u.role)) return res.status(400).json({ error: 'باقة نجم Deal للصناع ومقدمي الخدمة فقط' });
  if (u.frozen || u.penalty_level === 'suspended') return res.status(400).json({ error: 'حسابك مجمّد حالياً — لا يمكنك الاشتراك في الباقة' });
  const { ref, terms_accepted, terms_version } = req.body || {};
  if (terms_accepted !== true || terms_version !== STAR_TERMS_VERSION) {
    return res.status(400).json({ error: 'لازم توافق على شروط الباقة أولاً' });
  }
  if (!ref || !String(ref).trim()) return res.status(400).json({ error: 'مرجع التحويلة مطلوب' });
  const st = await myStarState(u.id);
  if (st.state === 'active') return res.status(400).json({ error: 'اشتراكك في نجم Deal نشط بالفعل', state: 'active', subscription: st.subscription });
  if (st.state === 'pending') return res.status(400).json({ error: 'عندك اشتراك قيد التحقق بالفعل — استنى تأكيد الاستلام', state: 'pending', subscription: st.subscription });
  const cleanRef = String(ref).trim().slice(0, 120);
  /* التزام الاشتراك بمرجعه المالي: يُجلب/يُنشأ الآن ويُدّعى بمرجع الدافع. */
  const ob = await getOrCreateObligation({
    kind: 'star_subscription', user_id: u.id, base_amount: STAR_PRICE,
    currency: STAR_CURRENCY, payer_user_id: u.id, payee: 'owner',
  });
  /* تحويلة مؤكدة تلقائياً بالإيصال قبل إرسال النموذج؟ الاشتراك يولد «نشطاً»
     فوراً (قبول الشروط سُجّل في هذا الطلب نفسه) — لا انتظار ولا تأكيد يدوي. */
  if (ob.status === 'auto_confirmed') {
    const t = now();
    const info = await db.prepare(`INSERT INTO star_subscriptions (user_id,amount,currency,ref,status,terms_version,terms_accepted_at,created_at,decided_at,activated_at,expires_at,obligation_id)
      VALUES (?,?,?,?, 'active', ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.id, STAR_PRICE, STAR_CURRENCY, cleanRef, STAR_TERMS_VERSION, t, t, t, t, t + STAR_DURATION_MS, ob.id);
    await moneyLedger(ob.id, 'auto_confirmed', 'auto_confirmed', 'system', 'رُبط باشتراك فُعّل فوراً عند قبول الشروط');
    await notifyOwner('star_pending', `⭐ اشتراك «نجم Deal» فُعّل تلقائياً بالإيصال من ${u.name} — ${ob.code}`, `star:${info.lastInsertRowid}`);
    const sub = await db.prepare('SELECT * FROM star_subscriptions WHERE id=?').get(info.lastInsertRowid);
    return res.json({ state: 'active', subscription: starSubView(sub) });
  }
  const info = await db.prepare(`INSERT INTO star_subscriptions (user_id,amount,currency,ref,status,terms_version,terms_accepted_at,created_at,obligation_id)
    VALUES (?,?,?,?, 'pending', ?, ?, ?, ?)`)
    .run(u.id, STAR_PRICE, STAR_CURRENCY, cleanRef, STAR_TERMS_VERSION, now(), now(), ob.id);
  if (ob.status === 'open') {
    await setObligationStatus(ob, 'claimed', 'user', 'سجّل المشترك مرجع التحويلة مع قبول الشروط', { transfer_ref: cleanRef });
  }
  const founder = await db.prepare('SELECT id FROM users WHERE is_platform_founder=1').get();
  if (founder) await notify(founder.id, 'star_pending', `⭐ اشتراك «نجم Deal» قيد التحقق من ${u.name} — مرجع ${cleanRef.slice(0, 60)}`, `star:${info.lastInsertRowid}`);
  const sub = await db.prepare('SELECT * FROM star_subscriptions WHERE id=?').get(info.lastInsertRowid);
  res.json({ state: 'pending', subscription: starSubView(sub) });
});
/* نجم الأسبوع الحالي (عام): بيانات علنية آمنة فقط عبر publicUser. */
app.get('/api/star/week', async (req, res) => {
  await sweepStar();
  const wid = await weekStarUserId();
  if (!wid) return res.json({ star: null, stats: null });
  const u = await getUser(wid);
  if (!u) return res.json({ star: null, stats: null });
  res.json({ star: await publicUser(u), stats: await talentStats(wid) });
});
/* وقود النمو الشهري: للمشترك النشط فقط — إحصاءاته الحقيقية + بنك مجاله الدوّار. */
app.get('/api/star/fuel', auth, async (req, res) => {
  if (req.user.is_platform_founder || !(await isStar(req.user.id))) {
    return res.status(403).json({ error: 'وقود النمو لمشتركي نجم Deal النشطين فقط' });
  }
  const uid = req.user.id;
  const views = (await db.prepare('SELECT COUNT(*) c FROM profile_views WHERE talent_id=?').get(uid)).c;
  // الأرباح: العربون المؤكد + الباقي المؤكد قبضه (مباشرة بين الطرفين)
  // فقط — ادعاء التحويل وحده (claimed) أو المرفوض/المردود لا يُحتسب قبضاً.
  const earnings = await db.prepare(`SELECT p.kind, p.amount, p.created_at FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.talent_id=? AND ((p.kind='deposit' AND p.status='confirmed') OR (p.kind='rest' AND p.status='confirmed'))`).all(uid);
  const d = new Date();
  const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const monthEarnings = earnings.filter((e) => { const ed = new Date(e.created_at); return `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, '0')}` === monthKey; })
    .reduce((s, e) => s + e.amount, 0);
  const myBookings = (await db.prepare('SELECT COUNT(*) c FROM bookings WHERE talent_id=?').get(uid)).c;
  const done = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND status='completed'`).get(uid)).c;
  const fuel = starFuelFor(req.user);
  res.json({
    stats: {
      views,
      earnings_total: earnings.reduce((s, e) => s + e.amount, 0),
      earnings_month: monthEarnings,
      bookings: myBookings,
      conversion: myBookings ? Math.round(done / myBookings * 100) : 0,
      record: await talentStats(uid),
    },
    fuel,
  });
});
/* لوحة المالك — سجل الباقة الرسمي: كل اشتراك بخط حالاته الزمني + عدّادات + إيراد.
   الإيراد = مجموع مبالغ الاشتراكات المؤكدة فقط (نشطة + منتهية) — «قيد التحقق»
   والمر rejected لا تُحتسب إيراداً لأن الفلوس لم تُؤكَّد. */
app.get('/api/owner/star', auth, ownerOnly, async (req, res) => {
  await sweepStar();
  const rows = await db.prepare('SELECT * FROM star_subscriptions ORDER BY created_at DESC, id DESC LIMIT 200').all();
  const items = [];
  for (const s of rows) {
    const u = await getUser(s.user_id);
    items.push({
      ...starSubView(s),
      user: u ? { id: u.id, name: u.name, role: u.role, niche: u.niche, provider_category: u.provider_category, provider_custom: u.provider_custom || '', city: u.city } : null,
    });
  }
  const counts = { pending: 0, active: 0, expired: 0, rejected: 0 };
  let revenue = 0;
  for (const s of rows) {
    if (s.status === 'pending') counts.pending++;
    else if (s.status === 'active') { if (s.expires_at > now()) counts.active++; else counts.expired++; revenue += s.amount; }
    else if (s.status === 'expired') { counts.expired++; revenue += s.amount; }
    else if (s.status === 'rejected') counts.rejected++;
  }
  res.json({ items, counts, revenue, price: STAR_PRICE, currency: STAR_CURRENCY });
});
app.post('/api/owner/star/:id/confirm', auth, ownerOnly, async (req, res) => {
  const s = await db.prepare('SELECT * FROM star_subscriptions WHERE id=?').get(+req.params.id);
  if (!s || s.status !== 'pending') return res.status(400).json({ error: 'اشتراك غير موجود أو تم البت فيه' });
  const t = now();
  await db.prepare(`UPDATE star_subscriptions SET status='active', decided_at=?, decided_by=?, activated_at=?, expires_at=? WHERE id=?`)
    .run(t, req.user.id, t, t + STAR_DURATION_MS, s.id);
  // التزام الاشتراك المالي يتحرك مع قرار المالك نفسه (سجل واحد متّسق).
  if (s.obligation_id) {
    const ob = await getObligation(s.obligation_id);
    if (ob && ['open', 'claimed'].includes(ob.status)) {
      await setObligationStatus(ob, 'confirmed', 'owner', 'أكّد المالك وصول تحويلة الاشتراك من سجل الباقة', { decided_by: req.user.id, decided_at: t });
    }
  }
  await notify(s.user_id, 'star_active', `⭐ مبروك! اتفعّل اشتراكك في «نجم Deal» — مزاياك شغالة من دلوقتي ولمدة 30 يوم`, 'star');
  res.json({ ok: true, subscription: starSubView(await db.prepare('SELECT * FROM star_subscriptions WHERE id=?').get(s.id)) });
});
app.post('/api/owner/star/:id/reject', auth, ownerOnly, async (req, res) => {
  const s = await db.prepare('SELECT * FROM star_subscriptions WHERE id=?').get(+req.params.id);
  if (!s || s.status !== 'pending') return res.status(400).json({ error: 'اشتراك غير موجود أو تم البت فيه' });
  const reason = String((req.body || {}).reason || 'مرجع التحويلة غير صحيح').slice(0, 300);
  await db.prepare(`UPDATE star_subscriptions SET status='rejected', decided_at=?, decided_by=?, reject_reason=? WHERE id=?`)
    .run(now(), req.user.id, reason, s.id);
  if (s.obligation_id) {
    const ob = await getObligation(s.obligation_id);
    if (ob && ['open', 'claimed'].includes(ob.status)) {
      await setObligationStatus(ob, 'rejected', 'owner', `رفض المالك اشتراك الباقة: ${reason}`, { decided_by: req.user.id, decided_at: now() });
    }
  }
  await notify(s.user_id, 'star_rejected', `اشتراك «نجم Deal» لم يُفعَّل: ${reason} — راجع مرجع التحويلة واشترك من جديد`, 'star');
  res.json({ ok: true });
});

/* ---------------- المرجع المالي: عرض الالتزام للدافع وحده ----------------
   الدافع المصرح له فقط يرى التزامه: صاحب الاشتراك نفسه، أو عميل الحجز المسجل،
   أو ضيف الحجز برمز متابعته. التزام غيرك لا يُكشف أبداً (403/404). */
app.get('/api/money/obligation', async (req, res) => {
  const kind = String(req.query.kind || '');
  const viewer = await optionalViewer(req);
  if (kind === 'star_subscription') {
    if (!viewer) return res.status(401).json({ error: 'سجل الدخول أولاً' });
    if (viewer.is_platform_founder || !['creator', 'provider'].includes(viewer.role)) {
      return res.status(400).json({ error: 'باقة نجم Deal للصناع ومقدمي الخدمة فقط' });
    }
    if (await activeStarSub(viewer.id)) return res.status(400).json({ error: 'اشتراكك في نجم Deal نشط بالفعل' });
    const ob = await getOrCreateObligation({
      kind, user_id: viewer.id, base_amount: STAR_PRICE, currency: STAR_CURRENCY,
      payer_user_id: viewer.id, payee: 'owner',
    });
    return res.json({ obligation: await payerObligationView(ob, viewer.country) });
  }
  if (['booking_commission', 'booking_deposit', 'booking_final'].includes(kind)) {
    const b = await getBooking(+req.query.booking_id || 0);
    if (!b) return res.status(404).json({ error: 'غير موجود' });
    const guestTok = String(req.query.guest_token || '');
    const isPayer = (viewer && b.client_id && viewer.id === b.client_id) || (guestTok && b.guest_token && guestTok === b.guest_token);
    if (!isPayer) return res.status(403).json({ error: 'الالتزام يظهر للدافع وحده' });
    const stageFor = { booking_commission: ['awaiting_fee'], booking_deposit: ['awaiting_deposit'], booking_final: ['awaiting_rest', 'proof_submitted'] };
    const existing = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND status IN ('open','claimed','confirmed','auto_confirmed') AND is_difference=0 ORDER BY id DESC LIMIT 1`).get(kind, b.id);
    if (!existing && !stageFor[kind].includes(b.status)) return res.status(400).json({ error: 'خطوة الدفع ليست مفتوحة الآن' });
    const amounts = bookingLegAmounts(b);
    const base = kind === 'booking_commission' ? amounts.fee : kind === 'booking_deposit' ? amounts.deposit : amounts.rest;
    const ob = existing || await getOrCreateObligation({
      kind, booking_id: b.id, user_id: b.talent_id, base_amount: base, currency: b.currency,
      payer_user_id: b.client_id || null, guest_token: b.guest_token || '',
      // العمولة للمنصة فقط؛ العربون والدفعة الأخيرة للمقدم مباشرة (لا احتجاز).
      payee: kind === 'booking_commission' ? 'owner' : `user:${b.talent_id}`,
      payee_user_id: kind === 'booking_commission' ? null : b.talent_id,
    });
    const view = await payerObligationView(ob, viewer ? viewer.country : await guestCountryByToken(guestTok));
    const diff = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND is_difference=1 AND status IN ('open','claimed') ORDER BY id DESC LIMIT 1`).get(kind, b.id);
    if (diff) view.difference_obligation = await payerObligationView(diff, viewer ? viewer.country : await guestCountryByToken(guestTok));
    return res.json({ obligation: view });
  }
  return res.status(400).json({ error: 'نوع التزام غير صحيح' });
});

/* ---------------- التأكيد التلقائي بالإيصال (مدفوعات المالك فقط) ----------------
   قواعد صارمة — كلها معاً وإلا «مراجعة مالك» (لا تأكيد جزئي ولا رفض آلي):
   (أ) المبلغ المستخرج == المبلغ بالبصمة حرفياً، (ب) أرقام المستلم تطابق رقم
   عمولات المالك (آخر 4 أرقام على الأقل)، (ج) مرجع التحويلة غير مستخدم في أي
   التزام/إيصال آخر، (د) بصمة الصورة غير مكررة إطلاقاً، (هـ) التاريخ خلال 48
   ساعة، (و) بصمة العميل المرسلة تطابق بصمة الخادم المحسوبة من الصورة نفسها. */
function parseReceiptDate(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  const dm = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (dm) return new Date(+dm[3], +dm[2] - 1, +dm[1], 12).getTime();
  const p = Date.parse(s);
  return isNaN(p) ? 0 : p;
}
function phoneMatches(phone, extractedDigits) {
  const p = String(phone || '').replace(/\D/g, '');
  const rec = String(extractedDigits || '').replace(/\D/g, '');
  if (!p || rec.length < 4) return false;
  if (!p.endsWith(rec.slice(-4))) return false;
  if (rec.length <= p.length) return p.endsWith(rec) || rec.length === 4;
  return rec.endsWith(p);
}
function recipientMatches(extractedDigits) {
  return phoneMatches(COMMISSION_PHONE, extractedDigits);
}
/* مستلم الإيصال لالتزام بعينه: رقم المالك الافتراضي، أو رقم السفير النشط
   لنطاق هذا الالتزام تحديداً (جولة السفير) — لا رقم سفير آخر ولا أي رقم
   ثالث: نفس الصرامة، بمستلمَين مشروعَين فقط لهذا النطاق. */
async function recipientMatchesForObligation(ob, extractedDigits) {
  if (ob.payee_user_id) {
    // دفعة مباشرة للمنفذ: المستلم المشروع الوحيد هو رقم المنفذ المسجل نفسه.
    const pu = await getUser(ob.payee_user_id);
    return pu ? phoneMatches(pu.contact, extractedDigits) : false;
  }
  if (recipientMatches(extractedDigits)) return true;
  const amb = await ambassadorForObligation(ob);
  if (amb && amb.collection_phone) return phoneMatches(amb.collection_phone, extractedDigits);
  return false;
}
app.post('/api/money/verify-receipt', async (req, res) => {
  const { obligation_code, image, image_hash, extracted = {}, guest_token } = req.body || {};
  const ob0 = obligation_code ? await db.prepare('SELECT * FROM money_obligations WHERE code=?').get(String(obligation_code)) : null;
  if (!ob0) return res.status(404).json({ error: 'كود معاملة غير موجود' });
  /* التأكيد بالإيصال متاح لمدفوعات المنصة (مستلمها المالك/السفير) وللدفعات
     المباشرة للمنفذ (عربون/باقٍ — مستلمها المنفذ نفسه برقمه المسجل): نفس
     الشروط الصارمة الستة في الحالتين، والمستلم المشروع واحد بعينه لكل التزام. */
  if (ob0.payee !== 'owner' && !ob0.payee_user_id) return res.status(400).json({ error: 'التأكيد بالإيصال غير متاح لهذا النوع من المعاملات' });
  // تفويض الرافع: صاحب الالتزام بجلسة، أو ضيف الحجز برمز متابعته.
  const viewer = await optionalViewer(req);
  const asUser = viewer && ob0.payer_user_id && viewer.id === ob0.payer_user_id;
  const asGuest = guest_token && ob0.guest_token && String(guest_token) === ob0.guest_token;
  if (!asUser && !asGuest) return res.status(403).json({ error: 'الإيصال يُرفع من الدافع وحده' });
  let ob = ob0;
  if (ob.receipt_locked) return res.status(400).json({ error: 'قُفل رفع الإيصالات على هذه المعاملة — هي عند المالك للمراجعة اليدوية' });
  if (!['open', 'claimed'].includes(ob.status)) return res.status(400).json({ error: 'هذه المعاملة تم البت فيها' });
  // حد معدل: إيصالات الرافع الواحد في آخر ساعة.
  const hourAgo = now() - 3600 * 1000;
  const recentCount = asUser
    ? (await db.prepare('SELECT COUNT(*) c FROM money_receipts WHERE uploader_user_id=? AND created_at>?').get(viewer.id, hourAgo)).c
    : (await db.prepare('SELECT COUNT(*) c FROM money_receipts WHERE guest_token=? AND created_at>?').get(String(guest_token), hourAgo)).c;
  if (recentCount >= RECEIPT_HOURLY_CAP) return res.status(429).json({ error: 'محاولات كثيرة — حاول بعد قليل' });
  // الصورة: data URL بحجم ≤2MB، وبصمتها تُحسب خادمياً من البايتات نفسها.
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(image || ''));
  if (!m) return res.status(400).json({ error: 'صورة إيصال غير صالحة' });
  const imgBytes = Buffer.from(m[2], 'base64');
  if (!imgBytes.length || imgBytes.length > RECEIPT_MAX_BYTES) return res.status(400).json({ error: 'صورة الإيصال أكبر من 2MB' });
  const serverHash = crypto.createHash('sha256').update(imgBytes).digest('hex');
  const exAmount = extracted && extracted.amount != null && extracted.amount !== '' ? +extracted.amount : null;
  const exRecipient = String((extracted && extracted.recipient_digits) || '');
  const exRef = String((extracted && extracted.transfer_ref) || '').trim().slice(0, 120);
  const exDate = parseReceiptDate(extracted && extracted.date);
  /* كشف الاحتيال أولاً: صورة مكررة إطلاقاً، أو مرجع تحويلة مستخدم في التزام
     آخر — علم احتيال يصل المالك، ولا يُحفظ إيصال ولا يتقدم أي تأكيد. */
  const dupImage = await db.prepare('SELECT id, obligation_id FROM money_receipts WHERE image_hash=?').get(serverHash);
  const dupRef = exRef ? (await db.prepare(`SELECT id FROM money_obligations WHERE transfer_ref=? AND id!=?`).get(exRef, ob.id)
    || await db.prepare(`SELECT id FROM money_receipts WHERE extracted_ref=? AND obligation_id!=?`).get(exRef, ob.id)) : null;
  if (dupImage || dupRef) {
    await setObligationStatus(ob, ob.status, asUser ? 'user' : 'guest', `اشتباه احتيال: ${dupImage ? 'صورة إيصال مكررة' : 'مرجع تحويلة مستخدم من قبل'}`, { fraud_flag: 1 });
    await notifyOwner('money_fraud', `🚨 اشتباه احتيال على معاملة ${ob.code}: ${dupImage ? 'نفس صورة الإيصال قُدّمت من قبل' : 'مرجع تحويلة مستخدم في معاملة أخرى'}`, `money:${ob.code}`);
    if (ob.payer_user_id) await applyFraudPenalty(ob.payer_user_id);
    return res.status(409).json({ error: 'الإيصال أو مرجع التحويلة مستخدم من قبل — تم إبلاغ الإدارة وستُراجع المعاملة يدوياً', fraud: true });
  }
  // حفظ الإيصال (صورته للمالك فقط عند المراجعة) ثم تقييم القواعد الصارمة.
  const rcInfo = await db.prepare(`INSERT INTO money_receipts (obligation_id,uploader_user_id,guest_token,image,image_hash,extracted_amount,extracted_recipient,extracted_ref,extracted_date,verdict,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'review',?)`)
    .run(ob.id, asUser ? viewer.id : null, asGuest ? String(guest_token) : '', String(image), serverHash,
      exAmount, exRecipient.slice(0, 40), exRef, exDate, now());
  const failed = [];
  if (exAmount == null || !isFinite(exAmount) || mround(exAmount) !== mround(ob.exact_amount)) failed.push('amount');
  if (!(await recipientMatchesForObligation(ob, exRecipient))) failed.push('recipient');
  if (!exRef) failed.push('ref');
  if (!exDate || now() - exDate > RECEIPT_DATE_WINDOW_MS || exDate > now() + 3600 * 1000) failed.push('date');
  if (image_hash && String(image_hash).toLowerCase() !== serverHash) failed.push('hash');
  const attempts = (ob.receipt_attempts || 0) + 1;
  if (!failed.length) {
    ob = await setObligationStatus(ob, 'auto_confirmed', 'system', 'تأكيد تلقائي: إيصال مطابق لكل الشروط الصارمة', {
      transfer_ref: ob.transfer_ref || exRef, receipt_hash: serverHash,
      receipt_attempts: attempts, decided_at: now(),
    });
    await db.prepare(`UPDATE money_receipts SET verdict='auto_confirmed' WHERE id=?`).run(rcInfo.lastInsertRowid);
    await applyObligationEffect(ob, 'system');
    const amtTxt = `${mround(ob.exact_amount).toFixed(2)} ${ob.currency}`;
    if (ob.kind === 'star_subscription') {
      await notifyOwner('money_auto', `⚡ تفعيل تلقائي — اشتراك ${ob.code} بمبلغ ${amtTxt}`, `money:${ob.code}`);
    } else if (ob.kind === 'booking_final') {
      await notifyOwner('money_auto', `⚡ تأكيد قبض تلقائي — باقي حجز #${ob.booking_id} (${ob.code}) بمبلغ ${amtTxt} وصل المنفذ مباشرة`, `money:${ob.code}`);
      if (ob.payee_user_id) await notify(ob.payee_user_id, 'money_auto', `⚡ اتأكد قبض باقي حجزك #${ob.booking_id} تلقائياً من إيصال العميل — سلّم النسخة النهائية`, `booking:${ob.booking_id}`);
    } else {
      await notifyOwner('money_auto', `⚡ تأكيد تلقائي — عمولة حجز #${ob.booking_id} (${ob.code}) بمبلغ ${amtTxt}`, `money:${ob.code}`);
      if (ob.payer_user_id) await notify(ob.payer_user_id, 'money_auto', `⚡ اتأكدت عمولة حجزك #${ob.booking_id} تلقائياً من الإيصال`, `booking:${ob.booking_id}`);
    }
    return res.json({ verdict: 'auto_confirmed', obligation: obligationView(ob) });
  }
  /* أي شرط ناقص/مشكوك: لا تأكيد — المعاملة «مُدّعاة» عند المالك للمراجعة. */
  const patch = { receipt_attempts: attempts, transfer_ref: ob.transfer_ref || exRef, receipt_hash: serverHash };
  if (attempts >= RECEIPT_MAX_ATTEMPTS) patch.receipt_locked = 1;
  ob = await setObligationStatus(ob, 'claimed', asUser ? 'user' : 'guest',
    `إيصال يحتاج مراجعة المالك (شروط ناقصة: ${failed.join(', ')})${patch.receipt_locked ? ' — قُفل الرفع بعد 5 محاولات' : ''}`, patch);
  await notifyOwner('money_review', `🧾 إيصال على معاملة ${ob.code} يحتاج مراجعتك (شروط غير مكتملة)`, `money:${ob.code}`);
  return res.json({ verdict: 'review', failed_checks: failed, locked: !!patch.receipt_locked, obligation: obligationView(ob) });
});

/* ---------------- لوحة المالك: المعاملات المالية ---------------- */
async function moneyItemView(ob) {
  const payer = ob.payer_user_id ? await getUser(ob.payer_user_id) : null;
  const payeeUser = ob.payee_user_id ? await getUser(ob.payee_user_id) : null;
  const bk = ob.booking_id ? await getBooking(ob.booking_id) : null;
  const subUser = ob.user_id ? await getUser(ob.user_id) : null;
  const receiptCount = (await db.prepare('SELECT COUNT(*) c FROM money_receipts WHERE obligation_id=?').get(ob.id)).c;
  return {
    ...obligationView(ob), id: ob.id,
    base_amount: ob.base_amount, fingerprint_cents: ob.fingerprint_cents,
    transfer_ref: ob.transfer_ref, fraud_flag: !!ob.fraud_flag,
    receipt_attempts: ob.receipt_attempts || 0, receipt_locked: !!ob.receipt_locked,
    receipts: receiptCount, created_at: ob.created_at, decided_at: ob.decided_at,
    payer_name: payer ? payer.name : (bk ? (bk.guest_name || 'عميل ضيف') : (subUser ? subUser.name : '—')),
    payee_name: ob.payee === 'owner' ? 'مالك المنصة (عمولات Deal)' : (payeeUser ? payeeUser.name : '—'),
    subject_name: subUser ? subUser.name : '',
    reject_kind: ob.reject_kind || '', is_difference: !!ob.is_difference, parent_obligation_id: ob.parent_obligation_id || null,
    // نطاق الالتزام ومُحصّله المختوم (للمالك وحده هنا): أين وقع التحصيل فعلاً.
    scope_city: ob.scope_city || '', scope_country: ob.scope_country || '',
    collector_user_id: ob.collector_user_id || null, collector_phone: ob.collector_phone || '',
  };
}
app.get('/api/owner/money', auth, ownerOnly, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM money_obligations ORDER BY created_at DESC, id DESC LIMIT 200').all();
  res.json({ items: await Promise.all(rows.map(moneyItemView)) });
});
/* «وصلني مبلغ…»: المالك يكتب المبلغ بكسوره فيُعرف التزامه فوراً. */
app.get('/api/owner/money/lookup', auth, ownerOnly, async (req, res) => {
  const amt = +req.query.amount;
  if (!isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'اكتب المبلغ برقمين عشريين كما وصلك (مثال 199.43)' });
  const rows = await db.prepare('SELECT * FROM money_obligations WHERE ABS(exact_amount - ?) < 0.001 ORDER BY created_at DESC LIMIT 10').all(mround(amt));
  res.json({ items: await Promise.all(rows.map(moneyItemView)) });
});
app.get('/api/owner/money/:id', auth, ownerOnly, async (req, res) => {
  const ob = await getObligation(+req.params.id);
  if (!ob) return res.status(404).json({ error: 'معاملة غير موجودة' });
  const ledger = await db.prepare('SELECT * FROM money_ledger WHERE obligation_id=? ORDER BY id ASC').all(ob.id);
  const receipts = (await db.prepare('SELECT id,extracted_amount,extracted_recipient,extracted_ref,extracted_date,verdict,created_at FROM money_receipts WHERE obligation_id=? ORDER BY id ASC').all(ob.id));
  res.json({ obligation: await moneyItemView(ob), ledger, receipts });
});
/* صورة الإيصال: للمالك فقط لغرض المراجعة — لا تخرج لأي طرف آخر أبداً. */
app.get('/api/owner/money/:id/receipt', auth, ownerOnly, async (req, res) => {
  const ob = await getObligation(+req.params.id);
  if (!ob) return res.status(404).json({ error: 'معاملة غير موجودة' });
  const rc = await db.prepare('SELECT * FROM money_receipts WHERE obligation_id=? ORDER BY id DESC LIMIT 1').get(ob.id);
  if (!rc) return res.status(404).json({ error: 'لا إيصال محفوظ لهذه المعاملة' });
  res.json({ image: rc.image, extracted: { amount: rc.extracted_amount, recipient: rc.extracted_recipient, ref: rc.extracted_ref, date: rc.extracted_date }, verdict: rc.verdict, created_at: rc.created_at });
});
app.post('/api/owner/money/:id/confirm', auth, ownerOnly, async (req, res) => {
  let ob = await getObligation(+req.params.id);
  if (!ob) return res.status(404).json({ error: 'معاملة غير موجودة' });
  if (!['open', 'claimed'].includes(ob.status)) return res.status(400).json({ error: 'هذه المعاملة تم البت فيها' });
  ob = await setObligationStatus(ob, 'confirmed', 'owner', 'أكّد المالك وصول التحويلة من لوحته', { decided_by: req.user.id, decided_at: now() });
  await applyObligationEffect(ob, 'owner');
  res.json({ ok: true, obligation: await moneyItemView(ob) });
});
app.post('/api/owner/money/:id/reject', auth, ownerOnly, async (req, res) => {
  let ob = await getObligation(+req.params.id);
  if (!ob) return res.status(404).json({ error: 'معاملة غير موجودة' });
  if (!['open', 'claimed'].includes(ob.status)) return res.status(400).json({ error: 'هذه المعاملة تم البت فيها' });
  const thirdParty = !!(req.body || {}).third_party;
  const reason = String((req.body || {}).reason || (thirdParty ? 'الدفع من حساب طرف ثالث — الاسم لا يطابق اسم الدافع المسجل' : 'التحويلة لم تصل فعلياً')).slice(0, 300);
  /* رفض مطالبة قائمة (الدافع أعلن «حوّلت» والمالك قرر أن التحويل لم يصل فعلاً)
     = إعلان دفع كاذب مثبت بمراجعة المالك: يُوسم بعلم الاحتيال ويُسجَّل في
     السجل ويدخل سلم العقوبات المتدرج القائم. رفض التزام بلا مطالبة ليس احتيالاً.
     استثناء باينانس الصريح — «الدفع من طرف ثالث»: الفلوس وصلت فعلاً لكن من حساب
     باسم غير اسم الدافع: يُرفض الالتزام ويُلغى بمسار الرد القائم ويُسجَّل السبب
     (reject_kind='third_party') بلا علم احتيال — المخالفة إجرائية لا كذب دفع. */
  const falseClaim = ob.status === 'claimed' && !thirdParty;
  ob = await setObligationStatus(ob, 'rejected', 'owner', `رفض المالك: ${reason}${thirdParty ? ' — قاعدة الطرف الثالث (باينانس): لا إفراج ولا اعتماد لدفع من حساب غير حساب الدافع' : falseClaim ? ' — إعلان دفع كاذب موثّق بمراجعة المالك' : ''}`, { decided_by: req.user.id, decided_at: now(), reject_kind: thirdParty ? 'third_party' : (falseClaim ? 'false_claim' : 'other'), ...(falseClaim ? { fraud_flag: 1 } : {}) });
  if (falseClaim) await applyFraudPenalty(ob.payer_user_id);
  if (ob.kind === 'star_subscription') {
    const sub = await db.prepare(`SELECT * FROM star_subscriptions WHERE obligation_id=? AND status='pending' ORDER BY id DESC LIMIT 1`).get(ob.id);
    if (sub) {
      await db.prepare(`UPDATE star_subscriptions SET status='rejected', decided_at=?, decided_by=?, reject_reason=? WHERE id=?`).run(now(), req.user.id, reason, sub.id);
      await notify(sub.user_id, 'star_rejected', `اشتراك «نجم Deal» لم يُفعَّل: ${reason} — راجع مرجع التحويلة واشترك من جديد`, 'star');
    }
  }
  if (ob.kind === 'booking_final') await syncFinalLeg(ob.booking_id); // رفض تحويلة الباقي: الدفعة «مرفوضة» والخطوة ترجع لانتظار تحويل جديد للمنفذ
  res.json({ ok: true, obligation: await moneyItemView(ob) });
});
/* «طلب إكمال الفرق» (نتيجة باينانس للمبلغ الناقص): المالك راجع مطالبة ووصلَه
   مبلغ أقل من مبلغ البصمة — يُنشأ التزام جديد بالمبلغ الناقص وحده (كود DL +
   بصمة خاصة به) لنفس الدافع والمستلم، ويبقى الأصل «مُدّعى» بانتظاره؛ تأكيد
   الفرق يُكمل الأصل تلقائياً (applyObligationEffect). كلها قيود money_ledger. */
app.post('/api/owner/money/:id/request-difference', auth, ownerOnly, async (req, res) => {
  const ob = await getObligation(+req.params.id);
  if (!ob) return res.status(404).json({ error: 'معاملة غير موجودة' });
  if (ob.status !== 'claimed') return res.status(400).json({ error: 'طلب إكمال الفرق على مطالبة قائمة قيد المراجعة فقط' });
  if (ob.is_difference) return res.status(400).json({ error: 'هذا التزام فرق أصلاً — لا فرق على فرق' });
  const received = +(req.body || {}).received_amount;
  if (!isFinite(received) || received < 0) return res.status(400).json({ error: 'اكتب المبلغ الذي وصلك فعلياً' });
  const diff = mround(ob.exact_amount - received);
  if (diff <= 0) return res.status(400).json({ error: 'المبلغ الواصل ليس ناقصاً عن مبلغ المعاملة — للزائد استخدم «رد الفرق»' });
  const dup = await db.prepare(`SELECT id FROM money_obligations WHERE parent_obligation_id=? AND is_difference=1 AND status IN ('open','claimed') LIMIT 1`).get(ob.id);
  if (dup) return res.status(409).json({ error: 'يوجد طلب إكمال فرق قائم لهذه المعاملة' });
  const dob = await createObligation({
    kind: ob.kind, booking_id: ob.booking_id, user_id: ob.user_id, base_amount: diff, currency: ob.currency,
    payer_user_id: ob.payer_user_id, guest_token: ob.guest_token || '', payee: ob.payee, payee_user_id: ob.payee_user_id,
  });
  await db.prepare('UPDATE money_obligations SET is_difference=1, parent_obligation_id=? WHERE id=?').run(ob.id, dob.id);
  await moneyLedger(ob.id, ob.status, ob.status, 'owner', `طلب إكمال فرق: وصل ${mround(received).toFixed(2)} من ${mround(ob.exact_amount).toFixed(2)} — أُنشئ التزام فرق ${dob.code} بالمبلغ الناقص ${diff.toFixed(2)}`);
  await moneyLedger(dob.id, 'open', 'open', 'owner', `التزام إكمال فرق للمعاملة ${ob.code} (بقرار مراجعة المالك — نتيجة باينانس للمبلغ الناقص)`);
  if (ob.payer_user_id) await notify(ob.payer_user_id, 'money', `معاملة ${ob.code}: وصلك طلب إكمال فرق ${diff.toFixed(2)} ${ob.currency} — المبلغ الذي حوّلته كان ناقصاً عن مبلغ المعاملة بالبصمة. أكمل الفرق من نفس خطوة الدفع بالمرجع الجديد ${dob.code}`, ob.booking_id ? `booking:${ob.booking_id}` : `money:${dob.code}`);
  await notifyOwner('money', `طُلب إكمال فرق للمعاملة ${ob.code}: التزام جديد ${dob.code} بمبلغ ${diff.toFixed(2)} ${ob.currency}`, `money:${dob.code}`);
  res.json({ ok: true, difference: await moneyItemView(await getObligation(dob.id)) });
});
/* «رد الفرق الزائد» (نتيجة باينانس للمبلغ الزائد): يُوثَّق في السجل أن المالك
   يردّ الفرق للدافع من محفظته يدوياً — الالتزام نفسه يبقى «مُدّعى» ليُبتّ فيه
   بقرار التأكيد الطبيعي بعد رد الفرق. لا حركة مال آلية. */
app.post('/api/owner/money/:id/refund-excess', auth, ownerOnly, async (req, res) => {
  const ob = await getObligation(+req.params.id);
  if (!ob) return res.status(404).json({ error: 'معاملة غير موجودة' });
  if (!['open', 'claimed'].includes(ob.status)) return res.status(400).json({ error: 'هذه المعاملة تم البت فيها' });
  const received = +(req.body || {}).received_amount;
  if (!isFinite(received)) return res.status(400).json({ error: 'اكتب المبلغ الذي وصلك فعلياً' });
  const excess = mround(received - ob.exact_amount);
  if (excess <= 0) return res.status(400).json({ error: 'المبلغ الواصل ليس زائداً عن مبلغ المعاملة — للناقص استخدم «طلب إكمال الفرق»' });
  await moneyLedger(ob.id, ob.status, ob.status, 'owner', `مبلغ زائد: وصل ${mround(received).toFixed(2)} بدل ${mround(ob.exact_amount).toFixed(2)} — الفرق ${excess.toFixed(2)} ${ob.currency} يردّه المالك للدافع من محفظته يدوياً (نتيجة باينانس للمبلغ الزائد)`);
  if (ob.payer_user_id) await notify(ob.payer_user_id, 'money', `معاملة ${ob.code}: حوّلت مبلغاً زائداً — الفرق ${excess.toFixed(2)} ${ob.currency} هيرجع لك من إدارة Deal`, ob.booking_id ? `booking:${ob.booking_id}` : `money:${ob.code}`);
  res.json({ ok: true, excess });
});

/* إلغاء تأكيد (تلقائي أو يدوي): تُسحب المزايا/تتراجع الخطوة + تجميد اختياري للدافع. */
app.post('/api/owner/money/:id/revoke', auth, ownerOnly, async (req, res) => {
  let ob = await getObligation(+req.params.id);
  if (!ob) return res.status(404).json({ error: 'معاملة غير موجودة' });
  if (!['auto_confirmed', 'confirmed'].includes(ob.status)) return res.status(400).json({ error: 'لا يوجد تأكيد قابل للإلغاء' });
  const freezePayer = !!(req.body || {}).freeze_payer;
  if (ob.kind === 'star_subscription') {
    const sub = await db.prepare(`SELECT * FROM star_subscriptions WHERE obligation_id=? AND status='active' ORDER BY id DESC LIMIT 1`).get(ob.id);
    if (sub) {
      await db.prepare(`UPDATE star_subscriptions SET status='rejected', decided_at=?, decided_by=?, reject_reason=? WHERE id=?`)
        .run(now(), req.user.id, 'أُلغي التأكيد — التحويلة لم تصل فعلياً', sub.id);
      await notify(sub.user_id, 'star_rejected', 'أُلغي تفعيل اشتراك «نجم Deal» — التحويلة لم تصل فعلياً. لو حوّلت فعلاً تواصل مع الدعم بإيصالك', 'star');
    }
  } else if (ob.kind === 'booking_commission') {
    const b = await getBooking(ob.booking_id);
    if (b && b.fee_status === 'confirmed' && b.status === 'awaiting_deposit') {
      await db.prepare(`UPDATE payments SET status='revoked' WHERE booking_id=? AND kind='fee'`).run(b.id);
      await db.prepare(`UPDATE bookings SET fee_status='none', fee_ref='', fee_confirmed_at=0, status='awaiting_fee' WHERE id=?`).run(b.id);
      await notify(b.talent_id, 'booking', `حجز #${b.id}: أُلغي تأكيد العمولة — رجعت خطوة العمولة`, `booking:${b.id}`);
      if (b.client_id) await notify(b.client_id, 'booking', `حجز #${b.id}: أُلغي تأكيد العمولة — أعد خطوة العمولة`, `booking:${b.id}`);
    }
  } else if (ob.kind === 'booking_final') {
    // إلغاء تأكيد قبض الباقي: خطوة القبض تتراجع لانتظار تحويل جديد للمنفذ،
    // وأي تقدم بُني على هذا التأكيد (تسليم نهائي/اكتمال) يتراجع معه.
    const b = await getBooking(ob.booking_id);
    if (b) {
      const pay = await restPaymentRow(b.id);
      if (pay && pay.status === 'confirmed') await db.prepare(`UPDATE payments SET status='revoked' WHERE id=?`).run(pay.id);
      if (['awaiting_final_delivery', 'final_delivered'].includes(b.status)) await db.prepare(`UPDATE bookings SET status='awaiting_rest', final_delivered_at=0 WHERE id=?`).run(b.id);
      if (b.status === 'completed') await db.prepare(`UPDATE bookings SET status='awaiting_rest', completed_at=0, final_delivered_at=0, final_confirmed_at=0, final_auto=0 WHERE id=?`).run(b.id);
      await notify(b.talent_id, 'booking', `حجز #${b.id}: أُلغي تأكيد قبض الباقي — رجعت خطوة دفع الباقي`, `booking:${b.id}`);
      if (b.client_id) await notify(b.client_id, 'booking', `حجز #${b.id}: أُلغي تأكيد قبض الباقي — أعد تحويل الباقي للمنفذ مباشرة`, `booking:${b.id}`);
    }
  }
  ob = await setObligationStatus(ob, 'revoked', 'owner', 'ألغى المالك التأكيد — التحويلة لم تصل فعلياً', { decided_by: req.user.id, decided_at: now() });
  if (freezePayer && ob.payer_user_id) {
    await db.prepare('UPDATE users SET frozen=1 WHERE id=?').run(ob.payer_user_id);
    await notify(ob.payer_user_id, 'penalty', 'تم تجميد حسابك بعد إلغاء تأكيد تحويلة — تواصل مع الدعم لو فيه خطأ', '');
  }
  res.json({ ok: true, obligation: await moneyItemView(ob) });
});

/* ---------------- لوحة المالك: مستحقات قيد المتابعة (لا احتجاز) ----------------
   تحوّل قسم «مبالغ محتجزة» القديم بقرار إلغاء الاحتجاز (2026-11-23): لا مال
   عند المنصة أصلاً فلا إفراج ولا رد من لوحة المالك — القسم يعرض البواقي
   المستحقة التي لم تُدفع أو لم يُؤكَّد قبضها (بانتظار دفع الباقي/تأكيد قبضه/
   تسليم النسخة النهائية/مستحق متأخر) بأدوات المتابعة والتحكيم والعقوبات
   وحزمة الأدلة فقط. مسارا release/refund القديمين أُبقيا كرفض صريح موثّق
   حتى لا يصمت أي عميل قديم. */
async function escrowItemView(b) {
  const ob = await finalObligation(b.id);
  const talent = await getUser(b.talent_id);
  const client = b.client_id ? await getUser(b.client_id) : null;
  const dispute = await db.prepare(`SELECT id FROM disputes WHERE booking_id=? AND status='open' LIMIT 1`).get(b.id);
  const sinceAccept = b.receipt_confirmed_at || 0;
  return {
    booking_id: b.id, title: b.title, price: b.price, currency: b.currency,
    booking_status: b.status,
    amount: bookingLegAmounts(b).rest,
    client_name: client ? client.name : (b.guest_name || 'عميل ضيف'),
    talent_name: talent ? talent.name : '—', talent_id: b.talent_id,
    obligation_code: ob ? ob.code : null, obligation_status: ob ? ob.status : null,
    dispute_open: !!dispute,
    created_at: b.created_at,
    receipt_confirmed_at: sinceAccept, receipt_auto: !!b.receipt_auto,
    final_delivered_at: b.final_delivered_at || 0,
    // عالق: قُبل الاستلام من أكثر من ١٥ دقيقة والباقي لسه ما خلصش (تنبيه باينانس المتحوّل).
    stuck: ['awaiting_rest', 'awaiting_final_delivery'].includes(b.status) && !!sinceAccept && (now() - sinceAccept) > RELEASE_ALERT_MS,
    wait_ms: sinceAccept ? Math.max(0, now() - sinceAccept) : 0,
    deemed: !!b.deemed_at,
  };
}
app.get('/api/owner/escrow', auth, ownerOnly, async (req, res) => {
  await sweepReleaseAlerts();
  const rows = await db.prepare(`SELECT * FROM bookings WHERE status IN ('awaiting_rest','awaiting_final_delivery','final_delivered','rest_overdue') OR (status='disputed' AND receipt_confirmed_at>0) ORDER BY created_at DESC, id DESC LIMIT 100`).all();
  res.json({ items: await Promise.all(rows.map(escrowItemView)) });
});
app.post('/api/owner/escrow/:bookingId/release', auth, ownerOnly, async (req, res) => {
  return res.status(400).json({ error: 'Deal لا تحتجز أموالاً فلا يوجد إفراج مالك — الباقي يتحوّل من العميل للمنفذ مباشرة ويُتابَع من «مستحقات قيد المتابعة»' });
});
app.post('/api/owner/escrow/:bookingId/refund', auth, ownerOnly, async (req, res) => {
  return res.status(400).json({ error: 'Deal لا تحتجز أموالاً فلا يوجد رد من المنصة — أي رد يتم بين الطرفين مباشرة، ودور المنصة التحكيم والعقوبات وحزمة الأدلة' });
});
/* ---------------- لوحة المالك: طلبات مراجعة الإفراج (نموذج باينانس) ----------------
   كل طلب مفتوح بحجزه وأطرافه وإثباته وملاحظة العميل إن وجدت، وحزمة الأدلة
   جاهزة من نفس مسارها. القرار نهائي داخل المنصة ويُسجَّل في سجل المراجعة
   (لا يُحذف) وفي money_ledger برقم المراجعة، والطرفان يُنبَّهان فوراً. */
app.get('/api/owner/appeals', auth, ownerOnly, async (req, res) => {
  await sweepAppealPhases();
  const rows = await db.prepare(`SELECT * FROM release_appeals WHERE status='open' ORDER BY created_at ASC`).all();
  const items = [];
  for (const a of rows) {
    const b = await getBooking(a.booking_id);
    if (!b) continue;
    const talent = await getUser(b.talent_id);
    const client = b.client_id ? await getUser(b.client_id) : null;
    items.push({
      ...appealView(a),
      title: b.title, price: b.price, currency: b.currency,
      amount: bookingLegAmounts(b).rest,
      booking_status: b.status, escrow_status: b.escrow_status || '',
      client_name: client ? client.name : (b.guest_name || 'عميل ضيف'),
      talent_name: talent ? talent.name : '—', talent_id: b.talent_id,
      proof_url: b.proof_url || '', proof_at: b.proof_at || 0,
    });
  }
  res.json({ items });
});
app.post('/api/owner/appeals/:id/decide', auth, ownerOnly, async (req, res) => {
  const a = await db.prepare('SELECT * FROM release_appeals WHERE id=?').get(+req.params.id);
  if (!a || a.status !== 'open') return res.status(404).json({ error: 'طلب مراجعة غير قائم' });
  const b = await getBooking(a.booking_id);
  if (!b) return res.status(404).json({ error: 'الحجز غير موجود' });
  const action = String((req.body || {}).action || '');
  if (action === 'release') {
    /* «لصالح المقدم» = تأكيد استلام موثّق بقرار مراجعة من الأدلة: الحجز يمشي
       مساره الطبيعي — تُفتح خطوة دفع الباقي للمنفذ مباشرة (لا مال عند المنصة). */
    if (b.status !== 'proof_submitted') return res.status(400).json({ error: 'الحجز لم يعد بانتظار تأكيد الاستلام' });
    await db.prepare(`UPDATE release_appeals SET status='decided_release', decided_at=?, decided_by=?, decision=? WHERE id=?`)
      .run(now(), req.user.id, 'لصالح المقدم — تأكيد استلام موثّق بقرار مراجعة من حزمة الأدلة', a.id);
    await db.prepare(`UPDATE bookings SET receipt_confirmed_at=?, receipt_auto=0, status='awaiting_rest' WHERE id=?`).run(now(), b.id);
    const ob = await finalObligation(b.id);
    if (ob) await moneyLedger(ob.id, ob.status, ob.status, 'owner', `قرار مراجعة #${a.id}: تأكيد استلام موثّق بقرار مالك — اتفتحت خطوة دفع الباقي للمنفذ`);
    if (ob && ['confirmed', 'auto_confirmed'].includes(ob.status)) await syncFinalLeg(b.id);
    const nb = await getBooking(b.id);
    await notify(nb.talent_id, 'appeal_decided', `حجز #${nb.id}: ⚖️ حسم المالك طلب المراجعة #${a.id} من الأدلة لصالحك: تأكيد الاستلام — خطوة دفع الباقي اتفتحت`, `booking:${nb.id}`);
    if (nb.client_id) await notify(nb.client_id, 'appeal_decided', `حجز #${nb.id}: ⚖️ حسم المالك طلب المراجعة #${a.id} من الأدلة: تأكيد الاستلام — ادفع الباقي للمنفذ من صفحة الحجز`, `booking:${nb.id}`);
    return res.json({ ok: true, booking: await bookingView(nb, req.user) });
  }
  if (action === 'refund') {
    /* «رد للعميل» = مسار رد المحتجَز القائم نفسه حين يوجد مبلغ محتجَز فعلياً؛
       وإن لم يكن الباقي قد احتُجز بعد يُقفل الحجز ملغياً بقرار المراجعة. */
    await db.prepare(`UPDATE release_appeals SET status='decided_refund', decided_at=?, decided_by=?, decision=? WHERE id=?`)
      .run(now(), req.user.id, 'لصالح العميل بقرار مراجعة من حزمة الأدلة — إلغاء الحجز', a.id);
    await db.prepare(`UPDATE bookings SET cancel_fault='talent' WHERE id=?`).run(b.id);
    const bfUserA = +(req.body || {}).behavior_flag_user_id || 0;
    if (bfUserA && (bfUserA === b.client_id || bfUserA === b.talent_id)) {
      await db.prepare('INSERT INTO behavior_flags (booking_id,user_id,kind,created_by,created_at) VALUES (?,?,?,?,?)')
        .run(b.id, bfUserA, String((req.body || {}).behavior_kind || 'uncooperative').slice(0, 40), req.user.id, now());
      await applyBehaviorPenalty(bfUserA);
    }
    const ob = await finalObligation(b.id);
    /* «لصالح العميل» في النموذج المباشر: لا مال عند المنصة يُردّ — القرار يُلغي
       الحجز بخطأ المنفذ (يضرب نسبة إتمامه) ويُوثَّق؛ وأي مبالغ بين الطرفين
       (عربون عند المنفذ) تبقى بينهما ويحسمها قرار المنصة كمرجع للأطراف. */
    await db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).run(b.id);
    await addBookingEvent(b.id, 'cancelled', 'أُلغي الحجز بقرار تحكيم: لصالح العميل');
    const pay = await restPaymentRow(b.id);
    if (pay && pay.status === 'claimed') await db.prepare(`UPDATE payments SET status='rejected' WHERE id=?`).run(pay.id);
    if (ob) await moneyLedger(ob.id, ob.status, ob.status, 'owner', `قرار مراجعة #${a.id}: لصالح العميل — أُقفل الحجز ملغياً بخطأ المنفذ (لا مال عند المنصة يُردّ)`);
    await notify(b.talent_id, 'appeal_decided', `حجز #${b.id}: ⚖️ حسم المالك طلب المراجعة #${a.id} من الأدلة لصالح العميل — الحجز اتلغى`, `booking:${b.id}`);
    if (b.client_id) await notify(b.client_id, 'appeal_decided', `حجز #${b.id}: ⚖️ حسم المالك طلب المراجعة #${a.id} من الأدلة لصالحك — الحجز اتلغى`, `booking:${b.id}`);
    return res.json({ ok: true, booking: await bookingView(await getBooking(b.id), req.user) });
  }
  return res.status(400).json({ error: 'قرار غير صحيح — اختر لصالح المقدم أو لصالح العميل' });
});

/* عكس اعتماد استلام مُعتبَر (حق المالك المحفوظ بقرار المستخدم): اعتماد تم
   بقاعدة السكوت ثم ثبت احتيال/خطأ — يُعكَس بقيد سجل وسبب، ويرجع الحجز لانتظار
   التأكيد والمبلغ لحالة «محتجَز». مستحيل بعد إفراج فعلي (المال تحرك خلاص). */
app.post('/api/owner/bookings/:id/reverse-deemed', auth, ownerOnly, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b) return res.status(404).json({ error: 'غير موجود' });
  if (!b.deemed_at || !b.receipt_auto) return res.status(400).json({ error: 'الحجز لم يُعتمد استلامه بقاعدة السكوت' });
  if (b.status !== 'awaiting_rest') return res.status(400).json({ error: 'لا يمكن العكس الآن — الحجز تجاوز خطوة فتح الباقي' });
  const finOb = await finalObligation(b.id);
  if (finOb && ['confirmed', 'auto_confirmed'].includes(finOb.status)) return res.status(400).json({ error: 'لا يمكن العكس — قبض الباقي اتأكد خلاص بين الطرفين' });
  const reason = String((req.body || {}).reason || 'ثبت خطأ/احتيال بعد الاعتماد').slice(0, 300);
  await db.prepare(`UPDATE bookings SET receipt_confirmed_at=0, receipt_auto=0, deemed_at=0, deemed_warn_sent=0, status='proof_submitted' WHERE id=?`).run(b.id);
  const ob = await finalObligation(b.id);
  if (ob) await moneyLedger(ob.id, ob.status, ob.status, 'owner', `عكس اعتماد استلام مُعتبَر (قاعدة سكوت): ${reason}`);
  await addBookingEvent(b.id, 'deemed_reversed', `عكس المالك اعتماد الاستلام المُعتبَر: ${reason}`);
  await notify(b.talent_id, 'deemed', `حجز #${b.id}: عكس المالك اعتماد الاستلام المُعتبَر (${reason}) — الحجز رجع لانتظار تأكيد الاستلام`, `booking:${b.id}`);
  if (b.client_id) await notify(b.client_id, 'deemed', `حجز #${b.id}: عكس المالك اعتماد الاستلام المُعتبَر (${reason}) — أكّد الاستلام بنفسك أو افتح نزاعاً من صفحة الحجز`, `booking:${b.id}`);
  res.json({ ok: true, booking: await bookingView(await getBooking(b.id), req.user) });
});

/* ---------------- بلاغات الدفع المتأخر (قاعدة باينانس) ----------------
   حجز أُلغي تلقائياً لانتهاء مهلة خطوة، والدافع يدّعي أنه حوّل فعلاً: يقدّم
   بلاغاً (مرجع/ملاحظة) من صفحة الحجز/الرمز فيصل قائمة المالك ليقرر: استئناف
   الحجز من خطوته، أو ردّ ما وصل (قرار يدوي موثّق — المال عند المستلم أصلاً)،
   أو رفض البلاغ. لا حركة مال آلية في أي مسار. */
async function applyLatePaymentReport(b, reporter, userId, ref, note) {
  if (b.status !== 'cancelled') return { error: 'بلاغ الدفع المتأخر على حجز ملغي تلقائياً فقط' };
  const open = await db.prepare(`SELECT id FROM late_payment_reports WHERE booking_id=? AND status='open' LIMIT 1`).get(b.id);
  if (open) return { error: 'عندك بلاغ دفع متأخر قائم على الحجز ده — بانتظار قرار المالك' };
  const r = String(ref || '').trim().slice(0, 120);
  if (!r) return { error: 'اكتب مرجع التحويلة التي نفّذتها فعلاً' };
  const info = await db.prepare('INSERT INTO late_payment_reports (booking_id,reporter,user_id,ref,note,created_at) VALUES (?,?,?,?,?,?)')
    .run(b.id, reporter, userId ?? null, r, String(note || '').slice(0, 500), now());
  await addBookingEvent(b.id, 'late_payment_report', `قدّم الدافع بلاغ دفع متأخر (مرجع: ${r}) — بانتظار قرار المالك`);
  await notifyOwner('late_payment', `🧾 بلاغ دفع متأخر على حجز #${b.id} الملغي تلقائياً — مرجع التحويلة: ${r}. قرّر من لوحتك: استئناف الحجز أو ردّ ما وصل أو رفض البلاغ`, `booking:${b.id}`);
  await notify(b.talent_id, 'late_payment', `حجز #${b.id}: العميل قدّم بلاغ دفع متأخر بعد الإلغاء التلقائي — المالك بيراجعه`, `booking:${b.id}`);
  return { report_id: info.lastInsertRowid };
}
app.post('/api/bookings/:id/late-payment', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.client_id !== req.user.id) return res.status(403).json({ error: 'البلاغ من عميل الحجز فقط' });
  const r = await applyLatePaymentReport(b, 'member', req.user.id, (req.body || {}).ref, (req.body || {}).note);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, ...r });
});
app.post('/api/guest/:token/late-payment', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const r = await applyLatePaymentReport(b, 'guest', null, (req.body || {}).ref, (req.body || {}).note);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, ...r });
});
app.get('/api/owner/late-payments', auth, ownerOnly, async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM late_payment_reports ORDER BY (status='open') DESC, created_at DESC LIMIT 100`).all();
  const items = [];
  for (const r of rows) {
    const b = await getBooking(r.booking_id);
    if (!b) continue;
    const talent = await getUser(b.talent_id);
    const client = b.client_id ? await getUser(b.client_id) : null;
    items.push({ ...r, booking_title: b.title, booking_status: b.status, prev_status: b.prev_status || '', price: b.price, currency: b.currency, talent_name: talent ? talent.name : '—', client_name: client ? client.name : (b.guest_name || 'عميل ضيف') });
  }
  res.json({ items });
});
app.post('/api/owner/late-payments/:id/decide', auth, ownerOnly, async (req, res) => {
  const r = await db.prepare('SELECT * FROM late_payment_reports WHERE id=?').get(+req.params.id);
  if (!r || r.status !== 'open') return res.status(404).json({ error: 'بلاغ غير قائم' });
  const b = await getBooking(r.booking_id);
  if (!b) return res.status(404).json({ error: 'الحجز غير موجود' });
  const action = String((req.body || {}).action || '');
  const note = String((req.body || {}).note || '').slice(0, 300);
  if (action === 'resume') {
    const step = ['awaiting_fee', 'awaiting_deposit', 'awaiting_rest', 'proof_submitted'].includes(b.prev_status) ? b.prev_status : 'awaiting_fee';
    await db.prepare(`UPDATE bookings SET status=?, cancel_fault='' WHERE id=?`).run(step, b.id);
    await db.prepare(`UPDATE late_payment_reports SET status='resumed', decided_at=?, decided_by=?, decision_note=? WHERE id=?`).run(now(), req.user.id, note || 'استئناف الحجز — ثبت الدفع المتأخر', r.id);
    await addBookingEvent(b.id, 'late_payment_resumed', 'استأنف المالك الحجز بعد بلاغ الدفع المتأخر — رجع لخطوته');
    await notify(b.talent_id, 'late_payment', `حجز #${b.id}: استأنف المالك الحجز بعد بلاغ الدفع المتأخر — رجع لمساره`, `booking:${b.id}`);
    if (b.client_id) await notify(b.client_id, 'late_payment', `حجز #${b.id}: قبل المالك بلاغ الدفع المتأخر واستأنف الحجز — أكمل خطواتك من صفحة الحجز`, `booking:${b.id}`);
  } else if (action === 'refund' || action === 'reject') {
    await db.prepare(`UPDATE late_payment_reports SET status=?, decided_at=?, decided_by=?, decision_note=? WHERE id=?`)
      .run(action === 'refund' ? 'refunded' : 'rejected', now(), req.user.id, note || (action === 'refund' ? 'ردّ ما وصل للدافع (يُنفّذ يدوياً من المستلم/المالك)' : 'رُفض البلاغ — لم يثبت الدفع'), r.id);
    await addBookingEvent(b.id, action === 'refund' ? 'late_payment_refund' : 'late_payment_rejected', action === 'refund' ? 'قرر المالك ردّ ما وصل في بلاغ الدفع المتأخر' : 'رفض المالك بلاغ الدفع المتأخر');
    if (b.client_id) await notify(b.client_id, 'late_payment', `حجز #${b.id}: قرار المالك في بلاغ الدفع المتأخر: ${action === 'refund' ? 'ردّ ما وصل إليك' : 'رُفض البلاغ'}`, `booking:${b.id}`);
  } else return res.status(400).json({ error: 'قرار غير صحيح — استئناف أو رد أو رفض' });
  res.json({ ok: true });
});

/* علم سلوك مستقل (إساءة/عدم تعاون) على طرف في حجز — يُستخدم أيضاً من قرارات
   التحكيم/النزاع عبر نفس الجدول والدالة. */
app.post('/api/owner/bookings/:id/behavior-flag', auth, ownerOnly, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b) return res.status(404).json({ error: 'غير موجود' });
  const userId = +(req.body || {}).user_id || 0;
  if (!userId || (userId !== b.client_id && userId !== b.talent_id)) return res.status(400).json({ error: 'العلم على طرف في الحجز فقط' });
  const kind = String((req.body || {}).kind || 'uncooperative').slice(0, 40);
  await db.prepare('INSERT INTO behavior_flags (booking_id,user_id,kind,created_by,created_at) VALUES (?,?,?,?,?)').run(b.id, userId, kind, req.user.id, now());
  const count = await applyBehaviorPenalty(userId);
  res.json({ ok: true, flags: count });
});

/* تشغيل كل المسوحات الزمنية يدوياً (لـ cron خارجي لاحقاً بجلوس المالك). */
app.post('/api/owner/run-sweeps', auth, ownerOnly, async (req, res) => {
  res.json({ ok: true, result: await runAllSweeps() });
});

/* ---------------- سفراء المدن = نقاط التحصيل المحلية (اقتراح ٤) ----------------
   تعيين المالك وحده: عضو موثّق (غير موثّق → 400)، لا مؤسس أبداً، برقم تحصيل
   محلي صالح لدولة النطاق، وسفير فعّال واحد لكل (دولة، مدينة) — تعيين بديل
   يُلغي السابق مع بقاء سجله التاريخي. المقابل حقل حر يضبطه المالك ويُحفظ
   للعرض فقط. التسوية يعلّمها المالك («تمت») فتنقسم محصّلات السفير عندها. */
app.get('/api/owner/ambassadors', auth, ownerOnly, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM ambassadors ORDER BY active DESC, id DESC').all();
  const items = await Promise.all(rows.map(ambassadorView));
  const candidates = (await db.prepare(`SELECT id, name, role, niche, provider_category, city, country FROM users WHERE verified=1 AND is_platform_founder=0 AND banned=0 AND role IN ('creator','provider') ORDER BY id ASC`).all())
    .map((u) => ({ id: u.id, name: u.name, role: u.role, niche: u.niche, provider_category: u.provider_category, city: u.city, country: u.country }));
  res.json({ items, candidates });
});
app.post('/api/owner/ambassadors', auth, ownerOnly, async (req, res) => {
  const { user_id, city, country, collection_phone, compensation, settlement_method } = req.body || {};
  const target = await getUser(+user_id || 0);
  if (!target) return res.status(404).json({ error: 'العضو غير موجود' });
  if (target.is_platform_founder) return res.status(400).json({ error: 'المؤسس لا يُعيَّن سفيراً أبداً' });
  if (!target.verified) return res.status(400).json({ error: 'تعيين السفير لعضو موثّق فقط — العضو غير موثّق' });
  if (target.banned) return res.status(400).json({ error: 'العضو محظور — لا يمكن تعيينه سفيراً' });
  const ctry = countryOf(country);
  if (!ctry) return res.status(400).json({ error: 'دولة غير صحيحة' });
  const cityN = normCity(city);
  if (!cityN) return res.status(400).json({ error: 'مدينة السفير مطلوبة' });
  const phone = normalizePhoneForCountry(collection_phone, ctry.code);
  if (!phone) return res.status(400).json({ error: 'رقم التحصيل غير صالح لدولة النطاق' });
  // بديل لنفس النطاق: السابق يُلغى (يبقى تاريخه) قبل تفعيل الجديد.
  const prev = await activeAmbassadorFor(cityN, ctry.code);
  if (prev) {
    await db.prepare('UPDATE ambassadors SET active=0, removed_at=?, removed_by=? WHERE id=?').run(now(), req.user.id, prev.id);
    await notify(prev.user_id, 'ambassador_removed', `انتهى تعيينك سفيراً لـDeal في ${prev.city} — شكراً لخدمتك`, 'ambassador');
  }
  /* وسيلة التسوية لهذا النطاق: اختيار المالك من سجلّ الوسائل؛ الافتراضي
     بايونير لأي نطاق خارج مصر ومباشر (بلا وسيلة) داخل مصر. قيمة غير
     مسجّلة أو غير مفعّلة بعد → رفض صريح. */
  let settleMethod = String(settlement_method || '').trim();
  if (settleMethod) {
    const reg = SETTLEMENT_METHODS[settleMethod];
    if (!reg) return res.status(400).json({ error: 'وسيلة تسوية غير معروفة' });
    if (!reg.enabled) return res.status(400).json({ error: 'وسيلة التسوية دي مش مفعّلة لسه' });
  } else settleMethod = ctry.code === 'EG' ? '' : 'payoneer';
  const info = await db.prepare(`INSERT INTO ambassadors (user_id,city,country,collection_phone,compensation,settlement_method,active,created_at) VALUES (?,?,?,?,?,?,1,?)`)
    .run(target.id, cityN, ctry.code, phone, String(compensation || '').slice(0, 200), settleMethod, now());
  const appt = await db.prepare('SELECT * FROM ambassadors WHERE id=?').get(info.lastInsertRowid);
  await notify(target.id, 'ambassador_appointed', `🏛️ عيّنك مالك Deal سفيراً للمنصة في ${cityN} — رقم تحصيلك المحلي بقى يظهر في خطوات دفع مدينتك`, 'ambassador');
  res.json({ ok: true, appointment: await ambassadorView(appt) });
});
app.post('/api/owner/ambassadors/:id/remove', auth, ownerOnly, async (req, res) => {
  const appt = await db.prepare('SELECT * FROM ambassadors WHERE id=?').get(+req.params.id);
  if (!appt) return res.status(404).json({ error: 'التعيين غير موجود' });
  if (!appt.active) return res.status(400).json({ error: 'التعيين ملغي أصلاً' });
  await db.prepare('UPDATE ambassadors SET active=0, removed_at=?, removed_by=? WHERE id=?').run(now(), req.user.id, appt.id);
  await notify(appt.user_id, 'ambassador_removed', `انتهى تعيينك سفيراً لـDeal في ${appt.city} — شكراً لخدمتك`, 'ambassador');
  res.json({ ok: true, appointment: await ambassadorView(await db.prepare('SELECT * FROM ambassadors WHERE id=?').get(appt.id)) });
});
app.post('/api/owner/ambassadors/:id/settle', auth, ownerOnly, async (req, res) => {
  const appt = await db.prepare('SELECT * FROM ambassadors WHERE id=?').get(+req.params.id);
  if (!appt) return res.status(404).json({ error: 'التعيين غير موجود' });
  await db.prepare('UPDATE ambassadors SET settled_at=? WHERE id=?').run(now(), appt.id);
  const fresh = await db.prepare('SELECT * FROM ambassadors WHERE id=?').get(appt.id);
  await notify(appt.user_id, 'ambassador_settled', `💰 سوّى مالك Deal معاك تحصيلات ${appt.city} حتى الآن — الحالة عندك بقت «تمت التسوية»`, 'ambassador');
  res.json({ ok: true, appointment: await ambassadorView(fresh) });
});
/* إعدادات المالك: معرّف استلام بايونير (إيميل/معرّف حسابه) — يضبطه المالك
   بنفسه من لوحته، افتراضياً فارغ، ولا يُكشف إلا للسفير المعيَّن داخل قسم
   تسويته (عبر /api/ambassador/me) وللمالك نفسه هنا. */
app.get('/api/owner/settings', auth, ownerOnly, async (req, res) => {
  res.json({ payoneer_id: await getSetting('payoneer_id'), settlement_methods: Object.entries(SETTLEMENT_METHODS).map(([k, v]) => ({ key: k, enabled: v.enabled, ar: v.ar, en: v.en })) });
});
app.post('/api/owner/settings', auth, ownerOnly, async (req, res) => {
  const { payoneer_id } = req.body || {};
  if (payoneer_id !== undefined) await setSetting('payoneer_id', String(payoneer_id || '').trim().slice(0, 200));
  res.json({ ok: true, payoneer_id: await getSetting('payoneer_id') });
});
/* تسويات السفراء صفقةً بصفقة (قرار المستخدم 2026-11-23): السفير يعلّم كل
   التزام استلمه بأنه «سُوّي» بوسيلة تعيينه + مرجع التحويل، فتصل المالك
   هنا للتأكيد أو الرفض التزاماً التزاماً — لا تجميع أسبوعي ولا تحويل
   بنكي دولي في نصوص الخارج بعد اليوم. */
app.get('/api/owner/settlements', auth, ownerOnly, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM obligation_settlements ORDER BY id DESC LIMIT 200').all();
  const items = [];
  for (const s of rows) {
    const ob = await db.prepare('SELECT * FROM money_obligations WHERE id=?').get(s.obligation_id);
    const amb = await getUser(s.user_id);
    items.push({
      id: s.id, obligation_id: s.obligation_id, obligation_code: ob ? ob.code : '', kind: ob ? ob.kind : '',
      amount: ob ? mround(ob.exact_amount) : 0, currency: ob ? ob.currency : '',
      ambassador_id: s.ambassador_id, ambassador_name: amb ? amb.name : '—',
      method: s.method, transfer_ref: s.transfer_ref, status: s.status,
      declared_at: s.declared_at, confirmed_at: s.confirmed_at || 0,
    });
  }
  res.json({ items });
});
app.post('/api/owner/settlements/:id/confirm', auth, ownerOnly, async (req, res) => {
  const s = await db.prepare('SELECT * FROM obligation_settlements WHERE id=?').get(+req.params.id);
  if (!s) return res.status(404).json({ error: 'التسوية غير موجودة' });
  if (s.status !== 'declared') return res.status(400).json({ error: 'التسوية محسومة خلاص' });
  await db.prepare('UPDATE obligation_settlements SET status=?, confirmed_at=?, confirmed_by=? WHERE id=?').run('confirmed', now(), req.user.id, s.id);
  const ob = await db.prepare('SELECT * FROM money_obligations WHERE id=?').get(s.obligation_id);
  await notify(s.user_id, 'ambassador_settled', `💰 أكّد مالك Deal استلام تسويتك للالتزام ${ob ? ob.code : ''} (${s.method === 'payoneer' ? 'Payoneer' : s.method}) — بقت «تمت التسوية»`, 'ambassador');
  res.json({ ok: true });
});
app.post('/api/owner/settlements/:id/reject', auth, ownerOnly, async (req, res) => {
  const s = await db.prepare('SELECT * FROM obligation_settlements WHERE id=?').get(+req.params.id);
  if (!s) return res.status(404).json({ error: 'التسوية غير موجودة' });
  if (s.status !== 'declared') return res.status(400).json({ error: 'التسوية محسومة خلاص' });
  await db.prepare('UPDATE obligation_settlements SET status=? WHERE id=?').run('rejected', s.id);
  await notify(s.user_id, 'ambassador_settled', `↩️ مالك Deal لم يؤكد تسوية الالتزام #${s.obligation_id} — راجع مرجع التحويل وعلّمها من جديد`, 'ambassador');
  res.json({ ok: true });
});
/* إعلان السفير تسوية التزام واحد: الالتزام لازم يكون محصّلاً فعلاً
   (confirmed/auto_confirmed) ومختوماً باسمه في نطاق تعيين فعّال له وسيلة
   تسوية، والمرجع مطلوب، وتسوية حية واحدة لكل التزام. */
app.post('/api/ambassador/settlements', auth, async (req, res) => {
  const { obligation_id, transfer_ref } = req.body || {};
  const ref = String(transfer_ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'مرجع تحويل التسوية مطلوب' });
  const ob = await db.prepare('SELECT * FROM money_obligations WHERE id=?').get(+obligation_id || 0);
  if (!ob) return res.status(404).json({ error: 'الالتزام غير موجود' });
  if (!['confirmed', 'auto_confirmed'].includes(ob.status)) return res.status(400).json({ error: 'الالتزام لسه مش محصّل — التسوية بعد التحصيل فقط' });
  if (ob.collector_user_id !== req.user.id) return res.status(403).json({ error: 'الالتزام ده مش من تحصيلاتك' });
  const appts = await db.prepare('SELECT * FROM ambassadors WHERE user_id=? AND active=1 ORDER BY id ASC').all(req.user.id);
  const appt = appts.find((a) => (ob.scope_country || '') === a.country && normCity(ob.scope_city || '') === normCity(a.city));
  if (!appt) return res.status(403).json({ error: 'لا تعيين سفير فعّال لك في نطاق الالتزام' });
  const method = settlementMethodOf(appt);
  if (!method) return res.status(400).json({ error: 'نطاقك بلا وسيلة تسوية صفقةً بصفقة — التسوية عندك مباشرة مع المالك' });
  const dup = await db.prepare(`SELECT id FROM obligation_settlements WHERE obligation_id=? AND status IN ('declared','confirmed')`).get(ob.id);
  if (dup) return res.status(409).json({ error: 'الالتزام ده متعلّم التسوية خلاص' });
  const info = await db.prepare('INSERT INTO obligation_settlements (obligation_id, ambassador_id, user_id, method, transfer_ref, status, declared_at) VALUES (?,?,?,?,?,?,?)')
    .run(ob.id, appt.id, req.user.id, method, ref.slice(0, 200), 'declared', now());
  await notifyOwner('ambassador_settled', `💸 السفير ${req.user.name} علّم تسوية الالتزام ${ob.code} (${mround(ob.exact_amount)} ${ob.currency}) عبر ${method === 'payoneer' ? 'Payoneer' : method} — مرجع ${ref} — أكّد الاستلام من لوحتك`, 'ambassador');
  res.json({ ok: true, settlement: { id: info.lastInsertRowid, obligation_id: ob.id, method, transfer_ref: ref, status: 'declared' } });
});
/* قسم السفير في لوحته: نطاقه هو فقط — أعضاء مدينته/دولته (بلا أي وسيلة
   تواصل)، والالتزامات الواقعة في نطاقه بحالاتها، ومحصّلاته وحالة تسويته.
   عضو بلا تعيين فعّال يرى قائمة فارغة (القسم لا يظهر له أصلاً في الواجهة). */
app.get('/api/ambassador/me', auth, async (req, res) => {
  if (req.user.is_platform_founder) return res.json({ appointments: [] });
  const appts = await db.prepare('SELECT * FROM ambassadors WHERE user_id=? AND active=1 ORDER BY id ASC').all(req.user.id);
  const out = [];
  for (const appt of appts) {
    const memberRows = await db.prepare(`SELECT * FROM users WHERE role IN ('creator','provider') AND banned=0 AND is_platform_founder=0 AND country=? ORDER BY id ASC`).all(appt.country);
    const members = memberRows
      .filter((u) => normCity(u.city) === normCity(appt.city))
      .map((u) => ({ id: u.id, name: u.name, role: u.role, niche: u.niche, provider_category: u.provider_category, city: u.city, country: u.country, verified: !!u.verified, founder_seat: u.founder_seat ?? null, is_founder_member: !!u.is_founder_member }));
    const obRows = await db.prepare(`SELECT * FROM money_obligations WHERE payee='owner' AND scope_country=? ORDER BY id DESC LIMIT 200`).all(appt.country);
    const scopedObs = obRows.filter((o) => normCity(o.scope_city || '') === normCity(appt.city)).slice(0, 50);
    const settleMap = await confirmedSettlementByObligation(scopedObs.map((o) => o.id));
    const obligations = scopedObs
      .map((o) => {
        const st = settleMap.get(o.id);
        return { id: o.id, code: o.code, kind: o.kind, booking_id: o.booking_id, exact_amount: mround(o.exact_amount), currency: o.currency, status: o.status, created_at: o.created_at, decided_at: o.decided_at || 0, collected: ['confirmed', 'auto_confirmed'].includes(o.status), mine: o.collector_user_id === req.user.id, settlement: st ? { status: st.status, method: st.method, transfer_ref: st.transfer_ref } : null };
      });
    const method = settlementMethodOf(appt);
    out.push({
      id: appt.id, city: appt.city, country: appt.country, collection_phone: appt.collection_phone,
      compensation: appt.compensation || '', created_at: appt.created_at, settled_at: appt.settled_at || 0,
      settlement_method: method,
      /* معرّف استلام بايونير الخاص بالمالك: للسفير المعيَّن فقط، وفقط حين
         وسيلة نطاقه بايونير — لا يظهر في أي رد عام آخر. */
      payoneer_id: method === 'payoneer' ? await getSetting('payoneer_id') : '',
      collected: await ambassadorCollected(appt),
      members, obligations,
    });
  }
  res.json({ appointments: out });
});

/* رد المقدم على الإفراج: وصلني ✓ أو ماوصلش ⚠ (تنبيه فوري للمالك عند الثاني). */
/* «وصلني» — تأكيد المنفذ اليدوي لقبض الباقي من محفظته بنفسه (المسار اليدوي
   البديل لمطابقة الإيصال الصارمة): يختم التزام الباقي «confirmed» بعامل ثانٍ
   هو المستلم نفسه — نموذج باينانس حرفياً (المستلم يتحقق من حسابه هو). */
app.post('/api/bookings/:id/rest-received', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.talent_id !== req.user.id) return res.status(403).json({ error: 'تأكيد القبض من المنفذ صاحب الحجز فقط' });
  const ob = await finalObligation(b.id);
  if (!ob) return res.status(400).json({ error: 'لا يوجد التزام باقٍ على الحجز' });
  if (['confirmed', 'auto_confirmed'].includes(ob.status)) return res.status(400).json({ error: 'قبض الباقي متأكد خلاص' });
  if (ob.status !== 'claimed') return res.status(400).json({ error: 'العميل لم يعلن دفع الباقي بعد' });
  await setObligationStatus(ob, 'confirmed', 'talent', 'أكّد المنفذ قبض الباقي بنفسه من محفظته (وصلني)');
  await addBookingEvent(b.id, 'rest_received', 'أكّد المنفذ قبض الباقي بنفسه (وصلني)');
  await syncFinalLeg(b.id);
  res.json({ ok: true, booking: await bookingView(await getBooking(b.id), req.user) });
});
/* «تم تسليم النسخة النهائية» — ضغط المنفذ بعد تأكيد قبض الباقي: النسخة
   النهائية هي «المحتجَز» الحقيقي في هذا النموذج، ولا تُسلَّم إلا بعد القبض. */
app.post('/api/bookings/:id/final-deliver', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.talent_id !== req.user.id) return res.status(403).json({ error: 'التسليم النهائي من المنفذ صاحب الحجز فقط' });
  if (b.status !== 'awaiting_final_delivery') return res.status(400).json({ error: 'التسليم النهائي يفتح بعد تأكيد قبض الباقي' });
  await db.prepare(`UPDATE bookings SET final_delivered_at=?, status='final_delivered' WHERE id=?`).run(now(), b.id);
  await addBookingEvent(b.id, 'final_delivered', 'سلّم المنفذ النسخة النهائية بعد تأكيد قبض الباقي');
  if (b.client_id) await notify(b.client_id, 'booking', `حجز #${b.id}: 📦 المنفذ سلّم النسخة النهائية — أكّد استلامها من صفحة الحجز (سكوت ٣ ساعات = استلام مُعتبَر واكتمال)`, `booking:${b.id}`);
  else await notifyOwner('booking', `حجز #${b.id}: سُلّمت النسخة النهائية (حجز ضيف — التأكيد من صفحة الرمز)`, `booking:${b.id}`);
  res.json({ ok: true, booking: await bookingView(await getBooking(b.id), req.user) });
});
/* تأكيد العميل استلام النسخة النهائية — مشترك بين العضو والضيف. */
async function applyConfirmFinal(b) {
  if (b.status !== 'final_delivered') return { error: 'لا توجد نسخة نهائية بانتظار تأكيد استلامها' };
  await db.prepare(`UPDATE bookings SET final_confirmed_at=? WHERE id=?`).run(now(), b.id);
  await addBookingEvent(b.id, 'final_confirmed', 'أكّد العميل استلام النسخة النهائية بنفسه');
  const nb = await tryCompleteFinal(await getBooking(b.id));
  return { booking: nb };
}
app.post('/api/bookings/:id/confirm-final', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.client_id !== req.user.id) return res.status(403).json({ error: 'التأكيد من العميل فقط' });
  const r = await applyConfirmFinal(b);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await bookingView(r.booking, req.user) });
});
app.post('/api/guest/:token/confirm-final', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const r = await applyConfirmFinal(b);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await guestBookingView(r.booking) });
});
/* حزمة الأدلة: لأطراف الحجز والمالك فقط — تُبنى حياً من السجلات (ونسختها
   محفوظة مع النزاع منذ لحظة فتحه). */
app.get('/api/bookings/:id/evidence', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || (b.client_id !== req.user.id && b.talent_id !== req.user.id && !req.user.is_platform_founder)) return res.status(404).json({ error: 'غير موجود' });
  res.json({ evidence: await buildEvidenceBundle(b) });
});
app.get('/api/guest/:token/evidence', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  res.json({ evidence: await buildEvidenceBundle(b) });
});

/* ---------------- حذف الحساب ذاتياً (الحزمة القانونية) ----------------
   لا يوجد نظام كلمات سر في Deal (الدخول بوسيلة التواصل نفسها) — فالتأكيد هنا
   بإعادة كتابة وسيلة تواصل الحساب حرفياً + تأكيد صريح. يُمنع الحذف مع حجوزات
   مفتوحة أو مبالغ محتجزة/قيد الحركة ويُشرح السبب. الحذف «ناعم» وموثّق:
   تُمسح البيانات الشخصية وتُبطل الجلسات، وتبقى سجلات المعاملات المالية كما
   هي (سجل رسمي لا يُمحى) باسم «حساب محذوف» — وفق حقوق البيانات في سياسة
   الخصوصية (قانون حماية البيانات المصري ١٥١/٢٠٢٠). */
app.delete('/api/me/account', auth, async (req, res) => {
  const u = req.user;
  if (u.is_platform_founder) return res.status(400).json({ error: 'حساب مؤسس المنصة لا يُحذف من هنا' });
  const confirmContact = String((req.body || {}).confirm_contact || '').trim();
  const mine = u.contact && u.contact.includes('@') ? u.contact.toLowerCase() : normalizeContact(u.contact || '');
  const given = confirmContact.includes('@') ? confirmContact.toLowerCase() : normalizeContact(confirmContact);
  if (!given || given !== mine) return res.status(400).json({ error: 'للتأكيد اكتب وسيلة تواصل حسابك (رقم الهاتف أو الإيميل) كما هي بالضبط' });
  if ((req.body || {}).confirm !== true) return res.status(400).json({ error: 'أكّد رغبتك في حذف الحساب نهائياً أولاً' });
  const openBookings = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE (client_id=? OR talent_id=?) AND status NOT IN ('completed','cancelled')`).get(u.id, u.id)).c;
  if (openBookings > 0) return res.status(400).json({ error: `لا يمكن الحذف الآن: عندك ${openBookings} حجز مفتوح — أغلق حجوزاتك المفتوحة أولاً (أكملها أو ألغها) ثم احذف حسابك` });
  const openObs = (await db.prepare(`SELECT COUNT(*) c FROM money_obligations WHERE payer_user_id=? AND status IN ('open','claimed')`).get(u.id)).c;
  if (openObs > 0) return res.status(400).json({ error: 'لا يمكن الحذف الآن: عندك التزامات مالية مفتوحة/قيد المراجعة — تُحسم أولاً' });
  const t = now();
  await db.prepare(`UPDATE users SET deleted_at=?, name='حساب محذوف', contact=?, phone='', bio='', links='', avatar='', cover='', verify_url='', frozen=1 WHERE id=?`)
    .run(t, `deleted-${u.id}@deleted.deal`, u.id);
  await db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  await db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(u.id);
  res.json({ ok: true, deleted_at: t });
});

/* ---------------- Web Push: اشتراك/إلغاء اختياري ---------------- */
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ enabled: pushReady, public_key: pushReady ? process.env.VAPID_PUBLIC_KEY : null });
});
app.post('/api/push/subscribe', auth, async (req, res) => {
  if (!pushReady) return res.status(400).json({ error: 'إشعارات Push غير مفعّلة على المنصة حالياً — الجرس الداخلي شغال', push_disabled: true });
  const sub = (req.body || {}).subscription || req.body || {};
  const endpoint = String(sub.endpoint || '');
  const keys = sub.keys || {};
  if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) return res.status(400).json({ error: 'اشتراك Push غير صالح' });
  await db.prepare('INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth')
    .run(req.user.id, endpoint.slice(0, 500), String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 100), now());
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, async (req, res) => {
  const endpoint = String(((req.body || {}).subscription || {}).endpoint || (req.body || {}).endpoint || '');
  if (endpoint) await db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(req.user.id, endpoint.slice(0, 500));
  else await db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

/* ---------------- creator stats ---------------- */
app.get('/api/my/stats', auth, async (req, res) => {
  const uid = req.user.id;
  const views = (await db.prepare('SELECT COUNT(*) c FROM profile_views WHERE talent_id=?').get(uid)).c;
  const opps = (await db.prepare(`SELECT COUNT(*) c FROM shop_requests WHERE status='open' AND (target_talent_id IS NULL OR target_talent_id=?)`).get(uid)).c +
               (await db.prepare(`SELECT COUNT(*) c FROM campaigns WHERE status='open'`).get()).c;
  const myBookings = (await db.prepare('SELECT COUNT(*) c FROM bookings WHERE talent_id=?').get(uid)).c;
  const done = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND status='completed'`).get(uid)).c;
  // نفس قاعدة وقود النجم: الباقي يُحتسب محتجَزاً/مُفرَجاً فقط، لا بمجرد الادعاء.
  const earnings = await db.prepare(`SELECT p.kind, p.amount, p.created_at FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.talent_id=? AND ((p.kind='deposit' AND p.status='confirmed') OR (p.kind='rest' AND p.status='confirmed'))`).all(uid);
  const byMonth = {};
  for (const e of earnings) {
    const d = new Date(e.created_at); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth[k] = (byMonth[k] || 0) + e.amount;
  }
  res.json({ views, opportunities_open: opps, bookings: myBookings, conversion: myBookings ? Math.round(done / myBookings * 100) : 0, earnings_total: earnings.reduce((s, e) => s + e.amount, 0), earnings_by_month: byMonth, record: await talentStats(uid) });
});

/* ---------------- owner dashboard (platform founder only) ---------------- */
function ownerOnly(req, res, next) {
  if (!req.user.is_platform_founder) return res.status(403).json({ error: 'لوحة المالك للمؤسس فقط' });
  next();
}
app.get('/api/owner/dashboard', auth, ownerOnly, async (req, res) => {
  const fees = await db.prepare(`SELECT amount, created_at FROM payments WHERE kind='fee' AND status='confirmed'`).all();
  const dayAgo = now() - 24 * 3600 * 1000;
  const monthAgo = now() - 30 * 24 * 3600 * 1000;
  const commissions = {
    today: fees.filter(f => f.created_at >= dayAgo).reduce((s, f) => s + f.amount, 0),
    month: fees.filter(f => f.created_at >= monthAgo).reduce((s, f) => s + f.amount, 0),
    total: fees.reduce((s, f) => s + f.amount, 0),
  };
  const disputes = await db.prepare(`SELECT d.*, b.price, b.currency FROM disputes d JOIN bookings b ON b.id=d.booking_id WHERE d.status='open'`).all();
  const exceptional = await db.prepare(`SELECT id,name,city,niche,verify_url,verify_reason FROM users WHERE verify_status='exceptional'`).all();
  const penalized = await db.prepare(`SELECT id,name,penalty_level,frozen,banned FROM users WHERE penalty_level!='none' OR frozen=1 OR banned=1`).all();
  const platform = {
    users: (await db.prepare('SELECT COUNT(*) c FROM users').get()).c,
    creators: (await db.prepare(`SELECT COUNT(*) c FROM users WHERE role='creator'`).get()).c,
    verified: (await db.prepare('SELECT COUNT(*) c FROM users WHERE verified=1').get()).c,
    founders: (await db.prepare('SELECT COUNT(*) c FROM users WHERE is_founder_member=1').get()).c,
    bookings: (await db.prepare('SELECT COUNT(*) c FROM bookings').get()).c,
    completed: (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='completed'`).get()).c,
  };
  res.json({ commissions, disputes, exceptional, penalized, platform });
});
/* رسائل الدعم المحفوظة (أسئلة خارج قاعدة الرد التلقائي) — قراءة للمالك فقط. */
app.get('/api/owner/support-messages', auth, ownerOnly, async (req, res) => {
  // رسائل مشتركي «نجم Deal» (أولوية) تتصدّر القائمة، وداخل كل مجموعة الأحدث أولاً.
  const items = await db.prepare(`SELECT s.*, u.name AS user_name FROM support_messages s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.priority DESC, s.created_at DESC LIMIT 100`).all();
  const unread = (await db.prepare('SELECT COUNT(*) c FROM support_messages WHERE is_read=0').get()).c;
  res.json({ items, unread });
});
app.post('/api/owner/support-messages/read', auth, ownerOnly, async (req, res) => {
  await db.prepare('UPDATE support_messages SET is_read=1').run();
  res.json({ ok: true });
});
app.post('/api/owner/disputes/:id/resolve', auth, ownerOnly, async (req, res) => {
  const d = await db.prepare('SELECT * FROM disputes WHERE id=?').get(+req.params.id);
  if (!d || d.status !== 'open') return res.status(404).json({ error: 'نزاع غير مفتوح' });
  const { action = 'restore', note = '' } = req.body || {};
  const b = await getBooking(d.booking_id);
  const target = action === 'cancel' ? 'cancelled' : (b.prev_status || 'pending_agreement');
  if (action === 'cancel') {
    /* إلغاء بحسم نزاع: الخطأ على الطرف المقابل لفاتح النزاع (نزاع العميل/الضيف
       المحسوم بالإلغاء = خطأ المنفذ؛ نزاع المنفذ المحسوم بالإلغاء = خطأ العميل؛
       نزاع فتحه المالك نفسه = بلا خطأ طرف). */
    const fault = d.opened_by === b.talent_id ? 'client' : (d.opened_by === (b.client_id || -1) || d.opened_by === 0) ? 'talent' : '';
    await db.prepare('UPDATE bookings SET status=?, cancel_fault=? WHERE id=?').run(target, fault, b.id);
  } else {
    await db.prepare('UPDATE bookings SET status=? WHERE id=?').run(target, b.id);
  }
  const bfUser = +(req.body || {}).behavior_flag_user_id || 0;
  if (bfUser && (bfUser === b.client_id || bfUser === b.talent_id)) {
    await db.prepare('INSERT INTO behavior_flags (booking_id,user_id,kind,created_by,created_at) VALUES (?,?,?,?,?)')
      .run(b.id, bfUser, String((req.body || {}).behavior_kind || 'uncooperative').slice(0, 40), req.user.id, now());
    await applyBehaviorPenalty(bfUser);
  }
  await db.prepare(`UPDATE disputes SET status='resolved', resolution=?, resolved_at=? WHERE id=?`).run(note || action, now(), d.id);
  await notify(b.client_id, 'dispute', `اتحل نزاع حجز #${b.id}`, `booking:${b.id}`);
  await notify(b.talent_id, 'dispute', `اتحل نزاع حجز #${b.id}`, `booking:${b.id}`);
  res.json({ ok: true });
});
app.post('/api/owner/verify-exceptional/:userId', auth, ownerOnly, async (req, res) => {
  const { approve } = req.body || {};
  const u = await getUser(+req.params.userId);
  if (!u || u.verify_status !== 'exceptional') return res.status(404).json({ error: 'طلب غير موجود' });
  if (approve) {
    const pioneer = await db.prepare(`SELECT id FROM users WHERE verified=1 AND pioneer=1 AND city=? AND niche=?`).get(u.city, u.niche) ? 0 : 1;
    await db.prepare(`UPDATE users SET verified=1, verify_status='verified', pioneer=?, boost_until=? WHERE id=?`).run(pioneer, now() + 7 * 24 * 3600 * 1000, u.id);
    await notify(u.id, 'verification', 'مبروك! اتوافق على توثيقك في المراجعة الاستثنائية', '');
    await onReferralVerified(await getUser(u.id));
  } else {
    await db.prepare(`UPDATE users SET verify_status='rejected', verify_reason='رفضته المراجعة الاستثنائية' WHERE id=?`).run(u.id);
    await notify(u.id, 'verification', 'توثيقك الاستثنائي اترفض — راجع الكود وحاول تاني', '');
  }
  res.json({ ok: true });
});
app.post('/api/owner/users/:id/penalty', auth, ownerOnly, async (req, res) => {
  const { level, frozen, banned } = req.body || {};
  const u = await getUser(+req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  await db.prepare('UPDATE users SET penalty_level=COALESCE(?,penalty_level), frozen=COALESCE(?,frozen), banned=COALESCE(?,banned) WHERE id=?')
    .run(level ?? null, frozen != null ? (frozen ? 1 : 0) : null, banned != null ? (banned ? 1 : 0) : null, u.id);
  res.json({ ok: true });
});
/** Reject a false fee reference inside the 24h review window: reopens fee step + opens a dispute. */
app.post('/api/owner/bookings/:id/reject-fee', auth, ownerOnly, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.fee_status !== 'confirmed') return res.status(400).json({ error: 'لا توجد عمولة مؤكدة' });
  if (now() - b.fee_confirmed_at > FEE_REVIEW_WINDOW_MS) return res.status(400).json({ error: 'انتهت نافذة مراجعة الـ٢٤ ساعة' });
  await db.prepare(`UPDATE payments SET status='rejected' WHERE booking_id=? AND kind='fee'`).run(b.id);
  await db.prepare(`UPDATE bookings SET fee_status='rejected', prev_status=status, status='disputed' WHERE id=?`).run(b.id);
  await db.prepare('INSERT INTO disputes (booking_id,opened_by,reason,created_at) VALUES (?,?,?,?)').run(b.id, req.user.id, 'مرجع عمولة خاطئ', now());
  await notify(b.client_id, 'dispute', `حجز #${b.id}: اترفض مرجع العمولة واتفتح نزاع`, `booking:${b.id}`);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'Deal — Vercel + Supabase' }));

/* معالج أخطاء أخير: أي خطأ من قاعدة البيانات أو المنطق يرجع 500 بدل تعليق الطلب. */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Deal server error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'خطأ في الخادم' });
});

module.exports = app;

/* التشغيل المحلي العادي فقط (npm start) — على Vercel يُستورَد التطبيق من api/index.js دون listen. */
if (require.main === module) {
  init()
    .then(() => app.listen(PORT, () => console.log(`Deal running on http://localhost:${PORT}`)))
    .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
}
