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
const mailer = require('./mailer');
const aiSupport = require('./ai');

const PORT = process.env.PORT || 3000;
const COMMISSION_RATE = 0.10;
const COMMISSION_PHONE = process.env.COMMISSION_PHONE || ''; // server-side only — من متغير البيئة فقط، بلا أي قيمة افتراضية في الكود
const FEE_REVIEW_WINDOW_MS = 24 * 3600 * 1000;   // نافذة رفض المالك لمرجع عمولة خاطئ: ٢٤ ساعة (قرار المالك)
/* نموذج Deal النهائي (قرار المستخدم 2026-11-23): المنصة لا تحتجز أموال
   المعاملات أبداً — الدفع بين العميل والمقدم مباشرة، وإثبات التنفيذ
   معاينة، والنسخة النهائية لا تُسلَّم إلا بعد تأكيد قبض الباقي. سكوت
   العميل ٢٤ ساعة بعد إثبات سليم = استلام مُعتبَر يفتح خطوة الباقي،
   وللمقدم «طلب مراجعة» (Appeal) عند تعنّت العميل — والتحكيم بأدلة
   التطبيق وحدها وقراره موثّق. */
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
/* تضييق CORS (٩-هـ): الواجهة تُخدَم من نفس الأصل، فلا حاجة لأي وصول عابر
   للأصول — لا ترويسة access-control-allow-origin:* إطلاقاً. تُعكَس الترويسة
   فقط لطلبات أصلها هو نفس مضيف الطلب (أو دومين المنصة الرسمي)، وأي أصل
   غريب لا يحصل على أي ترويسة CORS فيُحجَب من المتصفح. */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    let okOrigin = false;
    try { const u = new URL(origin); okOrigin = u.host === req.headers.host || u.hostname === 'dealplatform.vercel.app'; } catch (_) { okOrigin = false; }
    if (okOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).end();
      }
    }
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
// إنشاء الجداول عند أول طلب API (مرة واحدة لكل نسخة serverless — init() آمن للتكرار).
app.use('/api', async (req, res, next) => {
  try { await init(); next(); } catch (e) { next(e); }
});

/* ---------------- وضع الصيانة (الجولة الأخيرة الشاملة — TESTING-FINAL.md) ----------------
   مفتاح مالك في platform_settings ('maintenance_mode'). عند التفعيل: كل
   مسارات API لغير المالك ترجع 503 MAINTENANCE فترسم الواجهة شاشة صيانة
   واحدة موسومة. استثناءات مقصودة: /api/health (فحص الحياة)، /api/config
   (سطح الإعداد العام نفسه — منه تعرف الواجهة الحالة)، ومسارات /api/auth/*
   كلها (لازم المالك يقدر يسجّل دخوله)، وخطّافات الاختبار. المؤسس يتجاوز
   بالكامل: جلسته تعمل طبيعياً وهو وحده من يفعّل/يوقف من لوحته. */
async function maintenanceEnabled() {
  try { return (await getSetting('maintenance_mode')) === '1'; } catch (e) { return false; }
}
app.use('/api', async (req, res, next) => {
  // originalUrl: المسار الكامل دائماً (req.path داخل وسيط مُركَّب على /api يُجرَّد من البادئة).
  const p = String(req.originalUrl || req.url || '').split('?')[0];
  if (p === '/api/health' || p === '/api/config' || p.startsWith('/api/auth/') || p.includes('/_test/')) return next();
  let on = false;
  try { on = await maintenanceEnabled(); } catch (e) { on = false; }
  if (!on) return next();
  // تجاوز المؤسس: حلّ الجلسة اختيارياً هنا (نفس منطق auth بلا رفض).
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (token) {
      const s = await db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
      if (s) { const u = await getUser(s.user_id); if (u && u.is_platform_founder && !u.banned && !u.deleted_at) return next(); }
    }
  } catch (e) { /* أي عطل في الحلّ = لا تجاوز */ }
  return res.status(503).json({ error: 'بنعمل صيانة سريعة — راجعين قريباً', code: 'MAINTENANCE', maintenance: true });
});
/* سطح الإعداد العام: مفتاح Turnstile العلني (يظهر فقط عند ضبط متغير
   البيئة — انضباط البوابات البيئية نفسه كبريد/ذكاء اصطناعي) + حالة
   الصيانة الحالية لترسم الواجهة شاشتها من أول إقلاع. */
app.get('/api/config', async (req, res) => {
  res.json({
    turnstile_site_key: process.env.TURNSTILE_SITE_KEY || null,
    maintenance: await maintenanceEnabled(),
  });
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
    fin_identity_verified: founder ? false : !!u.fin_declared_at,
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
    /* اشتراك لاحق ما زال نشطاً لنفس العضو (مثال: شهر ترحيب مُلحق بعد اشتراك
       مدفوع) = المزايا مستمرة — فلا إشعار «انتهى اشتراكك» المضلّل. */
    const later = await db.prepare(`SELECT id FROM star_subscriptions WHERE user_id=? AND status='active' AND expires_at>? LIMIT 1`).get(s.user_id, t);
    if (later) continue;
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

/* ---------------- مهام الترحيب (جولة مهام الترحيب والانتشار) ----------------
   أربع مهام للصانع/مقدم الخدمة الجديد (المؤسس مستثنى)، كل واحدة تُقرأ من
   حالة منصة حقيقية فقط — لا إعلان ذاتي ولا زر «أنجزت»: (١) تأكيد الإيميل
   من عمود email_verified نفسه، (٢) نموذج شغل = صف فعلي في portfolio_items،
   (٣) أول درس أكاديمية = صف فعلي في academy_progress، (٤) أول عرض سعر =
   صف فعلي في request_quotes باسم الصانع. اكتمال الأربع = شهر مجاني من
   «نجم Deal» (٣٠ يوماً) يُفعَّل عبر آلية الاشتراكات نفسها: صف star_subscriptions
   نشط بسعر صفر ووسم source='welcome' وبلا أي التزام مالي أو قيد في سجل
   الأموال (لا obligation إطلاقاً). المنح مرة واحدة أبداً لكل حساب: ختم
   welcome_star_granted_at بشرط أنه صفر (ذرياً، مثل ختم ترحيب المؤسس).
   سلوك الإلحاق الموثّق: إن كان للعضو اشتراك مدفوع نشط لحظة المنح، يبدأ
   شهر الترحيب من نهاية الاشتراك النشط (activated_at = نهايته) وينتهي بعد
   ٣٠ يوماً منها — فالمزايا مستمرة بلا فجوة وبلا تداخل مهدر، وحارس sweepStar
   يمنع إشعار انتهاء مضلّلاً عند انقضاء المدفوع أولاً. */
async function welcomeMissionsState(u) {
  const email = !!u.email_verified;
  const sample = (await db.prepare('SELECT COUNT(*) c FROM portfolio_items WHERE user_id=?').get(u.id)).c > 0;
  const academy = (await db.prepare('SELECT COUNT(*) c FROM academy_progress WHERE user_id=?').get(u.id)).c > 0;
  const quote = (await db.prepare('SELECT COUNT(*) c FROM request_quotes WHERE talent_id=?').get(u.id)).c > 0;
  const missions = { email, sample, academy, quote };
  return { missions, done_count: Object.values(missions).filter(Boolean).length };
}
async function maybeGrantWelcomeStar(u) {
  if (!u || u.is_platform_founder || !['creator', 'provider'].includes(u.role)) return null;
  if (u.welcome_star_granted_at) return null;
  const st = await welcomeMissionsState(u);
  if (st.done_count < 4) return null;
  const t = now();
  const claim = await db.prepare('UPDATE users SET welcome_star_granted_at=? WHERE id=? AND welcome_star_granted_at=0').run(t, u.id);
  if (!claim.changes) return null; // خُتمت من قبل — لا منح ثانٍ أبداً
  const active = await activeStarSub(u.id);
  const startAt = active && active.expires_at > t ? active.expires_at : t;
  const info = await db.prepare(`INSERT INTO star_subscriptions (user_id,amount,currency,ref,status,terms_version,terms_accepted_at,created_at,decided_at,decided_by,activated_at,expires_at,obligation_id,source)
    VALUES (?,?,?, '', 'active', '', ?, ?, ?, NULL, ?, ?, NULL, 'welcome')`)
    .run(u.id, 0, STAR_CURRENCY, t, t, t, startAt, startAt + STAR_DURATION_MS);
  await notify(u.id, 'welcome_star', '🎉 مبروك! أكملت مهام الترحيب الأربع — هديتك: شهر كامل من باقة «نجم Deal» اتفعّل لحسابك (٣٠ يوماً من المزايا: شارة ذهبية وأولوية ظهور وترشيح أول). بالتوفيق!', 'star');
  return await db.prepare('SELECT * FROM star_subscriptions WHERE id=?').get(info.lastInsertRowid);
}
app.get('/api/me/welcome-missions', auth, async (req, res) => {
  const u = req.user;
  if (u.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس عرض فقط — لا مهام ترحيب له', code: 'FOUNDER_EXCLUDED' });
  if (!['creator', 'provider'].includes(u.role)) return res.status(400).json({ error: 'مهام الترحيب للصناع ومقدمي الخدمة فقط' });
  const grant = await maybeGrantWelcomeStar(u);
  const fresh = grant ? await getUser(u.id) : u;
  const st = await welcomeMissionsState(fresh);
  let sub = grant;
  if (!sub && fresh.welcome_star_granted_at) {
    sub = await db.prepare(`SELECT * FROM star_subscriptions WHERE user_id=? AND source='welcome' ORDER BY id DESC LIMIT 1`).get(u.id);
  }
  res.json({
    missions: st.missions, done_count: st.done_count, total: 4,
    granted: !!fresh.welcome_star_granted_at, granted_at: fresh.welcome_star_granted_at || 0,
    just_granted: !!grant,
    subscription: sub ? { ...starSubView(sub), source: 'welcome' } : null,
  });
});

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
const MONEY_OB_TTL_MS = 3 * 3600 * 1000;       // مهلة الدفع الموحّدة (٣ ساعات — حد Deal الأقصى؛ قرار المستخدم «بدّلهم» 2026-11-23) — عمر الالتزام المفتوح قبل انتهائه
const NEGOTIATION_MS = 10 * 60 * 1000;         // طور التفاوض في التحكيم قبل التصعيد للمالك (قاعدة Deal)
const REAPPEAL_COOLDOWN_MS = 5 * 60 * 1000;    // مهلة من يلغي تحكيمه بنفسه قبل فتح آخر (قاعدة Deal)
const DEEMED_AFTER_MS = 24 * 3600 * 1000;      // سكوت العميل بعد إثبات تنفيذ سليم (معاينة) = استلام مُعتبَر (قرار المستخدم الصريح 2026-11-23: مهلة المعاينة ٢٤ ساعة — أطول من مهلات الدفع قصداً حتى لا يُحتسب سكوت نائم/مشغول موافقة)
const FINAL_DEEMED_AFTER_MS = 3 * 3600 * 1000; // سكوت العميل بعد تسليم النسخة النهائية = اكتمال مُعتبَر — يبقى ٣ ساعات (قرار المستخدم: التمييز موثّق — المعاينة ٢٤ والدفع ٣ وما بعد النهائي ٣)
const RELEASE_ALERT_MS = 15 * 60 * 1000;       // تنبيه المالك العاجل: مبلغ جاهز للإفراج ينتظر أكثر من ١٥ دقيقة (قاعدة Deal)
const FRAUD_SUSPEND_AT = 3;                    // ٣ مطالبات دفع كاذبة مثبتة = الحد الثالث في سلّم الردع (حظر نهائي للشخص — توحيد 2026-11-23)
const TX_TERMS_VERSION = 'deal-tx-terms-v6';   // إصدار «شروط المعاملات» الحالي (v6: مهلة تأكيد المعاينة ٢٤ ساعة بدل ٣ بقرار المستخدم الصريح 2026-11-23 مع بقاء كل مهلات الدفع ٣ ساعات وسكوت ما بعد النهائي ٣ ساعات؛ v5: تعميم بند «الردع والقانون» بثلاث طبقات لكل الدول — عقد ملزم بقانون الشروط الحاكم، عقوبات داخلية موحّدة، والاحتيال جريمة في كل دولة، ومواد مصر مثالاً موثقاً وحيداً؛ v4: قسم «ضمان الاستبدال والردع» المعتمَد 2026-11-23 + توحيد سلّم «حوّلت» الكاذبة: تحذير/تجميد/حظر نهائي للشخص) — إصدار جديد يطلب قبولاً جديداً للحجوزات الجديدة فقط، والمفتوحة تكمل على إصدارها
const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;     // أقصى حجم لصورة الإيصال
const RECEIPT_MAX_ATTEMPTS = 5;                // بعدها يُقفل الرفع على الالتزام
const RECEIPT_DATE_WINDOW_MS = 48 * 3600 * 1000; // حداثة تاريخ الإيصال المطلوبة
const RECEIPT_HOURLY_CAP = 20;                 // حد إيصالات الرافع الواحد في الساعة
const mround = (x) => Math.round(x * 100) / 100; // نفس تقريب آلة الحجز القائمة حرفياً

async function moneyLedger(obligationId, from, to, actor, note = '') {
  /* هوية الدافع (القسم ٨-ج): تُنسخ من الالتزام نفسه إلى كل صف سجل مالي،
     فتبقى الهوية مع المرجع والإيصال وبصمة الجهاز في حزمة الأدلة. */
  let pn = '', pw = '', fp = '';
  try { const ob = await db.prepare('SELECT payer_name,payer_wallet,payer_device_fp FROM money_obligations WHERE id=?').get(obligationId); if (ob) { pn = ob.payer_name || ''; pw = ob.payer_wallet || ''; fp = ob.payer_device_fp || ''; } } catch (e) { /* السجل لا يتعطل */ }
  await db.prepare('INSERT INTO money_ledger (obligation_id,from_status,to_status,actor,note,created_at,payer_name,payer_wallet,device_fp) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(obligationId, from || '', to, actor, String(note || '').slice(0, 300), now(), pn, pw, fp);
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
  v.id = ob.id; // الدافع يحتاج معرّف التزامه ليعلن دفعه من خطوة السداد
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
    if (pu) {
      /* «هوية مالية مؤكدة»: الرقم المُصرَّح به من المنفذ (بإقرار مسجل) هو رقم
         الاستلام داخل خطوات الدفع — ولا يظهر إلا هنا، للدافع وحده، وداخل
         خطوة الدفع فقط. بلا تصريح يبقى رقم التواصل المسجل كما كان. */
      const num = (pu.fin_declared_at && pu.fin_wallet_number) ? pu.fin_wallet_number : pu.contact;
      if (num) v.payee_phone = num;
      v.payee_fin_verified = !!pu.fin_declared_at;
    }
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
    is_refund: !!ob.is_refund,
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
    existing = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND status IN ('open','claimed') AND is_difference=0 AND is_refund=0 ORDER BY id DESC LIMIT 1`).get(f.kind, f.booking_id);
  }
  if (existing) {
    if (!existing.expires_at || existing.expires_at > now()) return await stampObligationScope(existing);
    await setObligationStatus(existing, 'expired', 'system', 'انتهت صلاحية الالتزام المفتوح');
  }
  return await stampObligationScope(await createObligation(f));
}
/* عتبة الصفقة الكبيرة (حزمة الثقة المجانية — قرار المستخدم 2026-11-23):
   حجز قيمته أكبر من ١٠٠٠ (بعملة الحجز) يُقسَّم عربونه ٤٥٪ إلى دفعتين
   متسلسلتين: ٢٠٪ بداية تنفيذ + ٢٥٪ بعد معاينة أولية مؤكدة من العميل —
   فينخفض تعرّض العميل قبل رؤية أي شغل من ٤٥٪ إلى ٢٠٪. ما دون العتبة
   (≤ ١٠٠٠) عربون واحد ٤٥٪ كما هو بلا أي تغيير. */
const LARGE_DEAL_SPLIT_THRESHOLD = 1000;
function isSplitDeposit(b) { return !!b && +b.price > LARGE_DEAL_SPLIT_THRESHOLD; }
/* مبالغ أرجل الحجز بنفس صيغ آلة الحالات القائمة حرفياً (عمولة/نصف الصافي). */
function bookingLegAmounts(b) {
  const fee = mround(b.price * COMMISSION_RATE);
  const net = b.price - fee;
  const half = mround(net / 2);
  const split = isSplitDeposit(b);
  return { fee, deposit: half, rest: half, split, dep1: split ? mround(b.price * 0.20) : half, dep2: split ? mround(b.price * 0.25) : 0 };
}
/* ---------- بناء تصحيحات المراجعة: اتفاق مهيكل + هوية مالية + سجل علني ---------- */
const FIN_IDENTITY_VERSION = 'fin-identity-v1';
const FIN_DECLARATION_AR = 'أقرّ أنا صاحب هذا الحساب أن رقم محفظة التحويل المُدخَل هو رقمي الشخصي المسجّل باسمي القانوني الكامل كما في بطاقة الهوية، وأن الاسم القانوني واسم صاحب المحفظة المُدخَلين صحيحان، وأتحمّل مسؤولية أي تحويل يُستلم على هذا الرقم داخل صفقات Deal.';
const FIN_DECLARATION_EN = 'I declare that the transfer wallet number entered is my personal wallet registered under my full legal name as on my ID card, that the legal name and wallet-owner name entered are correct, and that I am responsible for any transfer received on this number within Deal bookings.';
function agreementFromBody(body) {
  const b = body || {};
  let revisions = null;
  const rv = b.agreed_revisions !== undefined ? b.agreed_revisions : b.revisions;
  if (rv !== undefined && rv !== null && rv !== '') {
    if (rv === 'chat' || rv === -1 || rv === '-1') revisions = -1;
    else { const n = Number(rv); if (!Number.isInteger(n) || n < 0 || n > 10) return { error: 'عدد التعديلات المشمولة يجب أن يكون بين ٠ و١٠ أو «حسب الاتفاق في المحادثة»' }; revisions = n; }
  }
  let deliveryAt = 0;
  const dv = b.agreed_delivery_at !== undefined ? b.agreed_delivery_at : b.delivery_at;
  if (dv !== undefined && dv !== null && dv !== '') {
    deliveryAt = typeof dv === 'number' ? dv : Date.parse(String(dv));
    if (!Number.isFinite(deliveryAt) || deliveryAt <= 0) return { error: 'ميعاد التسليم المتفق عليه غير صالح' };
    /* نطاق الميعاد (٤-د): من بداية اليوم الحالي حتى سنة من الآن. قُبل حياً
       تاريخ بسنة ٦ أرقام (202612) فلا بد من حدّين صريحين — والميعاد يبقى
       دليلاً موثقاً بلا عدّاد منصة كما هو مقرر. */
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    if (deliveryAt < dayStart.getTime() || deliveryAt > Date.now() + 366 * 24 * 3600 * 1000) return { error: 'ميعاد التسليم المتفق عليه خارج النطاق المسموح (من اليوم وحتى سنة من الآن)' };
  }
  return { revisions, deliveryAt };
}
function agreementOf(b) { return { revisions_included: b && b.agreed_revisions !== undefined ? b.agreed_revisions : null, agreed_delivery_at: b && b.agreed_delivery_at ? new Date(b.agreed_delivery_at).toISOString() : null, note: 'اتفاق موثق بين الطرفين ودليل تحكيم — بلا عدّاد منصة وبلا أي تفعيل تلقائي عند تجاوز الميعاد' }; }
function normPersonName(x) { return String(x || '').trim().replace(/\s+/g, ' ').replace(/[ً-ٰٟ]/g, '').replace(/إ|أ|آ/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase(); }
function maskTail(v) { const x = String(v || ''); return x ? '••••' + x.slice(-4) : ''; }
async function talentRecordFor(userId) { const st = await talentStats(userId); return { completion_rate: st.completion_rate, completed_deals: st.completed_deals, avg_stars: st.avg_stars, is_new: st.completion_rate === null && st.completed_deals === 0 }; }
async function bookingCityAmbassador(b) {
  try {
    const scope = await obligationScope({ payer_user_id: b.client_id || null, guest_token: b.guest_token || '', user_id: b.talent_id, scope_city: '', scope_country: '' });
    return !!(await activeAmbassadorFor(scope.city, scope.country));
  } catch (e) { return false; }
}
function arbitrationDecidedFor(b) { return false; } // يُستبدل بعد تعريف الاستعلامات أدناه عند الحاجة — انظر guestArbitrationDecided
async function guestArbitrationDecided(b) {
  const d = await db.prepare(`SELECT id FROM disputes WHERE booking_id=? AND status='resolved' LIMIT 1`).get(b.id);
  if (d) return true;
  const a = await db.prepare(`SELECT id FROM release_appeals WHERE booking_id=? AND status LIKE 'decided%' LIMIT 1`).get(b.id);
  return !!a;
}
/* تحقق الإيميل (٨-أ): كود ٦ أرقام مُجزّأ، صلاحية ١٠ دقائق، ٥ محاولات،
   إعادة إرسال بمهلة ٦٠ ثانية وبحد ٥ في الساعة — بلا طريق مسدود. */
const EMAIL_VERIFY_TTL_MS = 10 * 60 * 1000;
async function issueEmailVerification(user, req) {
  const email = String(user.recovery_email || (user.contact && user.contact.includes('@') ? user.contact : '') || '').trim().toLowerCase();
  if (!email) return { sent: false, email: '', reason: 'no_email' };
  const last = await db.prepare('SELECT * FROM email_verification_codes WHERE user_id=? ORDER BY id DESC LIMIT 1').get(user.id);
  if (last && now() - last.created_at < 60 * 1000) return { sent: false, email, reason: 'cooldown', retry_after_sec: Math.ceil((60 * 1000 - (now() - last.created_at)) / 1000) };
  const hourCount = (await db.prepare('SELECT COUNT(*) c FROM email_verification_codes WHERE user_id=? AND created_at>?').get(user.id, now() - 3600 * 1000)).c;
  if (hourCount >= 5) return { sent: false, email, reason: 'hourly_cap' };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.prepare('INSERT INTO email_verification_codes (user_id,email,code_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run(user.id, email, sha256hex('verify:' + user.id + ':' + code), now(), now() + EMAIL_VERIFY_TTL_MS);
  let sent = false;
  if (mailer.configured()) {
    try { await mailer.sendMail({ to: email, subject: 'Deal — كود تأكيد الإيميل', text: `كود تأكيد إيميلك على Deal هو: ${code}\nالكود صالح ١٠ دقائق. لو ما طلبتش الكود تجاهل الرسالة.` }); sent = true; } catch (e) { sent = false; }
  }
  return { sent, email, reason: sent ? 'sent' : 'stored_not_sent' };
}
async function requireVerifiedEmail(req, res) {
  if (req.user && req.user.email_verified) return true;
  res.status(403).json({ error: 'أكّد إيميلك الأول عشان تقدر تقبل حجوزات أو تقدّم عروض سعر — حسابك شغال وبتتصفح عادي، والتأكيد من إعدادات حسابك بكود ٦ أرقام', code: 'EMAIL_NOT_VERIFIED', email_verified: false });
  return false;
}
const OBLIGATION_KIND_FOR_LEG = { fee: 'booking_commission', deposit: 'booking_deposit', deposit2: 'booking_deposit', rest: 'booking_final' };
/* ربط دفعة مسجلة في آلة الحجز بالتزامها: ادعاء الدافع بمرجعه (claimed) — لا
   تأكيد؛ التأكيد يأتي من مطابقة إيصال أو قرار مالك/مستلم أو اكتمال الحجز. */
async function claimObligationForPayment(b, kind, ref, actor, payer = null) {
  const legKind = OBLIGATION_KIND_FOR_LEG[kind];
  if (!legKind) return null;
  const amounts = bookingLegAmounts(b);
  /* العربون المُقسَّم: دفعة البداية تُبنى على dep1 والدفعة الثانية على dep2 —
     وكلتاهما التزام booking_deposit متسلسل (الأولى تُسوّى عند المعاينة
     الأولية فتتحرر بصمة إنشاء الثانية). */
  const base = kind === 'fee' ? amounts.fee : kind === 'deposit2' ? amounts.dep2 : kind === 'deposit' && amounts.split ? amounts.dep1 : amounts[kind];
  /* المستلم: العمولة وحدها → المنصة (إيراد Deal الخاص). العربون والدفعة
     الأخيرة → المقدم مباشرة بين المحافظ — Deal لا تستلم ولا تحتجز أموال
     المعاملات بين الأطراف في أي مرحلة (قرار المستخدم 2026-11-23: الضمان في
     الشغل لا في الفلوس — النسخة النهائية لا تُسلَّم إلا بعد تأكيد قبض الباقي). */
  const toOwner = kind === 'fee';
  let ob = await getOrCreateObligation({
    kind: legKind, booking_id: b.id, user_id: b.talent_id, base_amount: base, currency: b.currency,
    payer_user_id: b.client_id || null, guest_token: b.guest_token || '',
    payee: toOwner ? 'owner' : `user:${b.talent_id}`,
    payee_user_id: toOwner ? null : b.talent_id,
  });
  if (payer && (payer.name || payer.wallet)) {
    try { await db.prepare('UPDATE money_obligations SET payer_name=?, payer_wallet=?, payer_device_fp=? WHERE id=?').run(String(payer.name || '').slice(0, 120), String(payer.wallet || '').slice(0, 60), String(payer.fp || '').slice(0, 80), ob.id); ob = await getObligation(ob.id); } catch (e) { /* هوية الدافع لا تعطّل الربط */ }
  }
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
/* ربط إعلان الدفع بالتزامه المالي — بلا ابتلاع صامت أبداً (إصلاح حي ٢،
   TESTING-LIVE-FIXES.md): النسخة السابقة كانت تلتفّ بـtry/catch فارغ
   («الربط لا يعطّل الدفع») فأي فشل في الربط كان يختفي تماماً — يبقى
   الالتزام «open» بلا مرجع وبلا أي أثر، والدافع بلا تأكيد. الآن: محاولة
   + إعادة واحدة، والفشل النهائي يُسجَّل في سجل الخادم ويُوثَّق في سجل
   أحداث الحجز ويُبلَّغ للمالك فوراً، ويُعاد علمه في رد الدفع نفسه
   (obligation_linked) لتراه الواجهة — فلا فشل مالي صامت بعد اليوم.
   الدفع نفسه لا يتعطّل بفشل الربط (قاعدة مرونة المنصة)، لكنه لا يمر
   بصمت أبداً. */
async function linkObligationClaim(booking, kind, ref, actor, payer = null) {
  try { await claimObligationForPayment(booking, kind, ref, actor, payer); return true; }
  catch (e) { console.error(`[deal-money] obligation link failed booking=${booking && booking.id} kind=${kind}:`, (e && e.message) || e); }
  try { await claimObligationForPayment(booking, kind, ref, actor, payer); return true; }
  catch (e) { console.error(`[deal-money] obligation link retry failed booking=${booking && booking.id} kind=${kind}:`, (e && e.message) || e); }
  try {
    await addBookingEvent(booking.id, 'obligation_link_failed', `تعذّر ربط إعلان دفع (${kind}) بالتزامه المالي تلقائياً — الدفعة مسجلة في الحجز والربط عند المالك للمراجعة`);
    await notifyOwner('money_link_failed', `حجز #${booking.id}: إعلان دفع (${kind}) سُجّل لكن ربطه بالتزام المرجع المالي تعذّر — راجع الالتزام من لوحة المال`, `booking:${booking.id}`);
  } catch (e) { /* التوثيق نفسه لا يعطّل الرد */ }
  return false;
}
/* تسوية التزام رجل (عربون/أخيرة) إلى «confirmed» عندما يثبت اكتمال الحجز —
   اكتمال القبض نفسه هو عامل التأكيد الثاني بعد ادعاء الدافع. */
async function settleLegObligation(bookingId, legKind, note) {
  const ob = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND status='claimed' AND is_refund=0 ORDER BY id DESC LIMIT 1`).get(legKind, bookingId);
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
/* ---------------- سجلا الجولة الأخيرة: أخطاء الخادم + تدقيق المالك ----------------
   logServerError: يُستدعى من معالج الأخطاء الأخير (وكل 500 ملتقط) فيسجّل
   المسار والرسالة ومعرّف المستخدم إن وُجد — بلا أي حمولة طلب إطلاقاً
   (لا كلمات سر ولا رموز ولا أجساد طلبات). فشله لا يعطّل الاستجابة أبداً.
   logOwnerAction: تدقيق إجراءات المالك — يُخطَف في نهايات مسارات المالك
   القائمة دون تغيير سلوكها (actor/action/target/timestamp). */
async function logServerError(req, err) {
  try {
    const route = req ? `${req.method || ''} ${String(req.originalUrl || req.url || '').split('?')[0]}`.slice(0, 200) : '';
    const message = String((err && err.message) || err || '').slice(0, 500);
    const userId = req && req.user && req.user.id ? req.user.id : null;
    await db.prepare('INSERT INTO error_log (route,message,user_id,created_at) VALUES (?,?,?,?)').run(route, message, userId, now());
  } catch (e) { /* التسجيل نفسه لا يعطّل شيئاً أبداً */ }
}
async function logOwnerAction(req, action, target = '', detail = '') {
  try {
    await db.prepare('INSERT INTO owner_audit_log (actor_id,action,target,detail,created_at) VALUES (?,?,?,?,?)')
      .run(req.user.id, String(action).slice(0, 60), String(target || '').slice(0, 120), String(detail || '').slice(0, 300), now());
  } catch (e) { /* التدقيق لا يعطّل الإجراء نفسه أبداً */ }
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
   العميل أو الاستلام المُعتبَر بسكوت ٢٤ ساعة) تُفتح خطوة دفع الباقي بعدّاد
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
      const wasOverdue = b.status === 'rest_overdue';
      await db.prepare(`UPDATE bookings SET status='awaiting_final_delivery' WHERE id=?`).run(b.id);
      await addBookingEvent(b.id, 'rest_received', 'تأكد قبض المنفذ للباقي — الخطوة الجاية: تسليم النسخة النهائية');
      // سداد باقٍ كان «مستحقاً متأخراً» = سدّ الالتزام الأصلي — فحص فكّ التجميد.
      if (wasOverdue && b.client_id) await maybeUnfreezeDues(b.client_id);
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
  const pays = await db.prepare('SELECT kind,amount,ref,status,created_at,payer_name,payer_wallet FROM payments WHERE booking_id=? ORDER BY id ASC').all(b.id);
  const obs = await db.prepare('SELECT code,kind,base_amount,exact_amount,currency,status,transfer_ref,created_at,payer_name,payer_wallet,payer_device_fp FROM money_obligations WHERE booking_id=? ORDER BY id ASC').all(b.id);
  const finalOb = await finalObligation(b.id);
  const ledger = finalOb ? await db.prepare('SELECT from_status,to_status,actor,note,created_at FROM money_ledger WHERE obligation_id=? ORDER BY id ASC').all(finalOb.id) : [];
  const dispute = await db.prepare('SELECT id,opened_by,reason,status,created_at FROM disputes WHERE booking_id=? ORDER BY id DESC LIMIT 1').get(b.id);
  const appeals = await db.prepare('SELECT id,status,client_note,created_at,decided_at,decision FROM release_appeals WHERE booking_id=? ORDER BY id ASC').all(b.id);
  const chat = await db.prepare('SELECT sender,body,created_at,kind,media_url,duration_sec FROM guest_messages WHERE booking_id=? ORDER BY created_at ASC, id ASC').all(b.id);
  const sysEvents = await bookingEvents(b.id, 500);
  const termsAcc = await db.prepare('SELECT side,user_id,version,accepted_at FROM booking_terms_acceptances WHERE booking_id=? ORDER BY accepted_at ASC').all(b.id);
  const fmt = (ts) => (ts ? new Date(ts).toISOString() : null);
  const amounts = bookingLegAmounts(b);
  return {
    bundle: 'Deal — حزمة أدلة حجز (Evidence Bundle)',
    generated_at: fmt(now()),
    booking: { id: b.id, title: b.title, price: b.price, currency: b.currency, status: b.status, source: b.source, created_at: fmt(b.created_at), completed_at: fmt(b.completed_at), protection_voided: !!b.protection_voided, protection_voided_at: fmt(b.protection_voided_at || 0) },
    parties: {
      client: client ? { id: client.id, name: client.name } : { guest_name: b.guest_name || '' },
      talent: talent ? { id: talent.id, name: talent.name, role: talent.role, niche: talent.niche, city: talent.city } : null,
    },
    amounts: { fee: amounts.fee, deposit: amounts.deposit, final: amounts.rest, net_to_talent: b.price - amounts.fee, deposit_split: amounts.split, dep1: amounts.dep1, dep2: amounts.dep2 },
    agreement: agreementOf(b),
    financial_identity: talent ? { talent_declared: !!talent.fin_declared_at, declared_at: talent.fin_declared_at ? fmt(talent.fin_declared_at) : null, version: talent.fin_declared_version || '', wallet_masked: talent.fin_declared_at ? maskTail(talent.fin_wallet_number) : '' } : null,
    initial_preview: b.initial_proof_url ? { url: b.initial_proof_url, at: fmt(b.initial_proof_at), check: b.initial_proof_check || '', confirmed_at: fmt(b.initial_confirmed_at || 0) } : null,
    timeline: [
      { step: 'booking_created', at: fmt(b.created_at) },
      ...(b.fee_confirmed_at ? [{ step: 'fee_confirmed', at: fmt(b.fee_confirmed_at), ref: b.fee_ref }] : []),
      ...(b.proof_at ? [{ step: 'proof_submitted_verified', at: fmt(b.proof_at), url: b.proof_url, check: b.proof_check }] : []),
      ...(b.receipt_confirmed_at ? [{ step: appeals.some((x) => x.status === 'decided_release') ? 'receipt_confirmed_by_owner_appeal_decision' : 'receipt_confirmed_by_client', at: fmt(b.receipt_confirmed_at) }] : []),
      ...appeals.map((x) => ({ step: `release_appeal_${x.status}`, at: fmt(x.decided_at || x.created_at), appeal_id: x.id })),
      ...(b.final_delivered_at ? [{ step: 'final_copy_delivered', at: fmt(b.final_delivered_at) }] : []),
      ...(b.final_confirmed_at ? [{ step: b.final_auto ? 'final_receipt_deemed_confirmed' : 'final_receipt_confirmed_by_client', at: fmt(b.final_confirmed_at) }] : []),
    ],
    payments: pays.map((p) => ({ kind: p.kind, amount: p.amount, ref: p.ref, status: p.status, at: fmt(p.created_at), payer_name: p.payer_name || '', payer_wallet: p.payer_wallet || '' })),
    obligations: obs.map((o) => ({ code: o.code, kind: o.kind, base_amount: o.base_amount, exact_amount: o.exact_amount, currency: o.currency, status: o.status, transfer_ref: o.transfer_ref, at: fmt(o.created_at), payer_name: o.payer_name || '', payer_wallet: o.payer_wallet || '', payer_device_fp: o.payer_device_fp || '' })),
    final_leg: { obligation_code: finalOb ? finalOb.code : null, obligation_status: finalOb ? finalOb.status : null, payee: 'talent_direct', note: 'الباقي يتحوّل من العميل للمنفذ مباشرة — Deal لا تستلم ولا تحتجز أموال المعاملات', final_delivered_at: fmt(b.final_delivered_at), final_confirmed_at: fmt(b.final_confirmed_at), final_auto: !!b.final_auto, ledger: ledger.map((e) => ({ from: e.from_status, to: e.to_status, actor: e.actor, note: e.note, at: fmt(e.created_at) })) },
    proof: b.proof_url ? { url: b.proof_url, server_timestamp: fmt(b.proof_at), check: b.proof_check } : null,
    dispute: dispute ? { id: dispute.id, reason: dispute.reason, status: dispute.status, opened_at: fmt(dispute.created_at) } : null,
    appeals: appeals.map((x) => ({ id: x.id, status: x.status, client_note: x.client_note || '', created_at: fmt(x.created_at), decided_at: fmt(x.decided_at), decision: x.decision || '' })),
    chat: [...chat.map((m) => ({ sender: m.sender, body: m.body, at: fmt(m.created_at), kind: m.kind || 'text', ...(m.kind === 'voice' ? { media_url: m.media_url || '', duration_sec: m.duration_sec || 0 } : {}) })),
      ...sysEvents.map((e) => ({ sender: 'system', kind: e.kind, body: e.body, at: fmt(e.created_at) }))].sort((x, y) => String(x.at || '').localeCompare(String(y.at || ''))),
    terms_acceptances: termsAcc.map((x) => ({ side: x.side, user_id: x.user_id, version: x.version, accepted_at: fmt(x.accepted_at) })),
    deemed: b.deemed_at ? { deemed_confirmed_at: fmt(b.deemed_at), rule: 'سكوت العميل ٢٤ ساعة بعد إثبات تنفيذ سليم (معاينة) = استلام مُعتبَر (قاعدة Deal)' } : null,
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
  if (ob.kind === 'breach_penalty') {
    // سداد غرامة إخلال: قد يكون آخر مستحقّات الدافع — فحص فكّ التجميد الآلي.
    if (ob.payer_user_id) await maybeUnfreezeDues(ob.payer_user_id);
    return;
  }
  if (ob.is_refund) {
    // تأكيد وصول ردّ العربون للعميل: التزام المنفذ الأصلي اتسدّد — فحص فكّ تجميده.
    if (ob.payer_user_id) await maybeUnfreezeDues(ob.payer_user_id);
    if (ob.payee_user_id) await notify(ob.payee_user_id, 'booking', `حجز #${ob.booking_id}: ✅ اتأكد وصول ردّ العربون ليك — اتقفل التزام الردّ الموثّق`, `booking:${ob.booking_id}`);
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
    // اسم الدولة النصي للمسار الدولي العام فقط — وللمؤسس يُحجب كسائر بيانات موقعه.
    country_name: founder ? '' : (u.country_name || ''),
    currency: u.currency, followers: u.followers,
    price: founder ? null : u.price,
    bio: u.bio,
    avatar: u.avatar || '',
    is_platform_founder: founder,
    is_founder_member: !!u.is_founder_member,
    // مقعد المؤسس المرقّم (١–٥٠ بالأسبقية العالمية): المؤسس صاحب المنصة بلا
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
    // «مستحقات متأخرة» (جولة الردع): وسم علني في الملف ما دام على العضو مستحق
    // مفتوح (غرامة إخلال/ردّ عربون مقرّر) أو باقٍ في حالة «مستحق متأخر».
    late_dues: !founder && (await openDuesFor(u.id)).length > 0,
    reply_speed: founder ? null : await replySpeedFor(u.id),
    // متابِعو Deal (من جدول follows) — مختلف عن followers (متابعو حساباته الخارجية).
    // يظهر للمؤسس أيضاً (عدّاد متابِعيه جزء من ملفه)، وis_following خاص بالمشاهد المسجل.
    followers_count: await followersCount(u.id),
    is_following: await isFollowing(viewerId, u.id),
    // «متاح اليوم» لمقدمي الخدمة/الصناع (يضبطه صاحبه من لوحته) — المؤسس عرضه فقط.
    available_today: founder ? false : !!u.available_today,
    // التوسعة: عرض سريع نشط (٤٨ ساعة) + وضع إجازة + شارات أكاديمية + بطل الأسبوع.
    flash: founder ? null : flashView(u),
    vacation_until: founder ? 0 : (onVacation(u) ? u.vacation_until : 0),
    academy_badges: founder ? [] : (await db.prepare('SELECT track_key FROM academy_badges WHERE user_id=?').all(u.id)).map((r) => r.track_key),
    week_champion: founder ? false : (await (async () => { const w = await db.prepare('SELECT winner_id FROM challenge_weeks ORDER BY crowned_at DESC LIMIT 1').get(); return !!w && w.winner_id === u.id; })()),
    // «هوية مالية مؤكدة» (٦-ب): شارة علنية فقط — رقم المحفظة والاسم القانوني
    // لا يخرجان من أي رد عام إطلاقاً (يبقيان للدافع داخل خطوة الدفع وللأدلة).
    fin_identity_verified: founder ? false : !!u.fin_declared_at,
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
  /* «نسبة إتمام الصفقات» بأسلوب ملفات متداولي Deal (جولة المحاذاة الحرفية):
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

/* إعلان «حوّلت» كاذب (مطالبة بلا تحويل فعلي — يثبت بمطابقة الإيصال/المرجع
   آلياً أو بقرار رفض المالك) يدخل سلّم الردع المعتمَد (2026-11-23، موحّداً
   بقرار جولة الردع — TESTING-DETERRENCE-APPLY.md): الأولى تحذير مسجّل،
   والثانية تجميد الحساب، والثالثة حظر نهائي للشخص نفسه (هاتف + إيميل +
   بصمة جهاز). العدد يُحتسب من الالتزامات الموسومة بعلم الاحتيال للمستخدم
   نفسه — فلا سجل موازٍ جديد، وكل خطوة في money_ledger. (كان السلّم قبل
   التوحيد: ٣ = تعليق suspended — وُثّق التغيير في وثيقة الجولة.) */
async function applyFraudPenalty(userId) {
  if (!userId) return; // ضيف بلا حساب — الرفض الموثّق يكفي
  const u = await getUser(userId);
  if (!u || u.banned) return;
  const n = (await db.prepare(`SELECT COUNT(*) c FROM money_obligations WHERE payer_user_id=? AND fraud_flag=1`).get(userId)).c;
  if (n >= FRAUD_SUSPEND_AT) {
    await banPerson(userId, `${n} إعلانات دفع كاذبة مثبتة (مطالبات بلا تحويل فعلي) — الحد الثالث في سلّم الردع`, null);
  } else if (n === FRAUD_SUSPEND_AT - 1) {
    if (!u.frozen) {
      await db.prepare('UPDATE users SET frozen=1 WHERE id=?').run(userId);
      await notify(userId, 'penalty', '🧊 جمّدت المنصة حسابك: سُجّلت عليك مطالبة دفع كاذبة ثانية مثبتة (إعلان «حوّلت» بلا تحويل فعلي) — سلّم الردع: الأولى تحذير، والثانية تجميد، والثالثة حظر نهائي للشخص نفسه. تواصل مع الدعم لو فيه خطأ', '');
    }
    if (u.penalty_level === 'none') await db.prepare('UPDATE users SET penalty_level=? WHERE id=?').run('warning', userId);
    await notifyOwner('penalty', `🧊 تجميد بسلم الردع: المستخدم #${userId} وصل لمطالبة دفع كاذبة ثانية مثبتة — الثالثة حظر نهائي للشخص`, `user:${userId}`);
  } else if (n >= 1 && u.penalty_level === 'none') {
    await db.prepare('UPDATE users SET penalty_level=? WHERE id=?').run('warning', userId);
    await notify(userId, 'penalty', 'تنبيه رسمي: سُجّل عليك إعلان دفع كاذب (مطالبة بلا تحويل فعلي). سلّم الردع المعتمد: الأولى تحذير مسجّل، والثانية تجميد الحساب، والثالثة حظر نهائي للشخص نفسه (هاتف + إيميل + جهاز)', '');
    await notifyOwner('penalty', `⚠️ تنبيه بسلم الردع: المستخدم #${userId} أعلن دفعاً كاذباً (مرة ${n} من ${FRAUD_SUSPEND_AT})`, `user:${userId}`);
  }
}

/* ---------------- كلمات السر والاسترجاع (جولة «زي التطبيقات الكبرى») ----------------
   التجزئة: scrypt مدمج في Node (لا اعتماديات خارجية) بملح عشوائي لكل كلمة
   سر، والصيغة المخزنة تحمل بارامتراتها: scrypt$N$r$p$salt$hash.
   password_hash = NULL يعني حساباً قديماً قبل هذه الجولة (مسار الترحيل:
   دخول بالمعرّف وحده مرة، ثم تعيين كلمة سر إجباري قبل أي إجراء حساس،
   وبعد التعيين لا دخول إلا بها أبداً). */
function scryptAsync(password, salt, keylen, params) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password), salt, keylen, params, (e, k) => (e ? reject(e) : resolve(k))));
}
const PW_PARAMS = { N: 16384, r: 8, p: 1 };
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt, 64, PW_PARAMS);
  return `scrypt$${PW_PARAMS.N}$${PW_PARAMS.r}$${PW_PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  try {
    if (typeof pw !== 'string' || !pw) return false;
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const key = await scryptAsync(pw, salt, expected.length, { N: +parts[1], r: +parts[2], p: +parts[3] });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch (e) { return false; }
}
function validPassword(pw) { return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200; }
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* خانق محاولات (دخول/استرجاع): نافذة ١٥ دقيقة — بعد ٥ إخفاقات قفل
   بتصعيد أُسّي (دقيقة، دقيقتان، ٤…) بسقف ساعة. المفتاح يجمع القناة
   والمعرّف وعنوان IP حتى لا يُقفل حساب بفعل فشل حساب آخر. */
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX_FAILS = 5;
function clientIp(req) {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return xff || (req.ip || '') || 'local';
}
async function throttleLockedMs(key) {
  const row = await db.prepare('SELECT * FROM auth_throttle WHERE key=?').get(key);
  if (!row) return 0;
  return row.locked_until > now() ? row.locked_until - now() : 0;
}
async function throttleFail(key) {
  const t = now();
  let row = await db.prepare('SELECT * FROM auth_throttle WHERE key=?').get(key);
  if (!row || t - (row.window_start || 0) > THROTTLE_WINDOW_MS) row = { fails: 0, window_start: t };
  const fails = (row.fails || 0) + 1;
  let lockedUntil = 0;
  if (fails >= THROTTLE_MAX_FAILS) {
    lockedUntil = t + Math.min(60 * 60 * 1000, 60 * 1000 * Math.pow(2, fails - THROTTLE_MAX_FAILS));
  }
  await db.prepare(`INSERT INTO auth_throttle (key,fails,window_start,locked_until) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET fails=EXCLUDED.fails, window_start=EXCLUDED.window_start, locked_until=EXCLUDED.locked_until`)
    .run(key, fails, row.window_start, lockedUntil);
}
async function throttleClear(key) {
  await db.prepare('DELETE FROM auth_throttle WHERE key=?').run(key);
}

/* ملخص جهاز مقروء من وكيل المستخدم — لقسم «أجهزتي وجلساتي» وإشعارات
   الأمان. لا يُخزَّن منه إلا النص الخام للوكيل (مقصوصاً) في صف الجلسة. */
function deviceSummary(ua) {
  const s = String(ua || '');
  let os = 'جهاز غير معروف';
  if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Mac OS|Macintosh/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';
  let br = 'متصفح';
  if (/Edg\//.test(s)) br = 'Edge';
  else if (/OPR\/|Opera/.test(s)) br = 'Opera';
  else if (/Chrome\//.test(s)) br = 'Chrome';
  else if (/Firefox\//.test(s)) br = 'Firefox';
  else if (/Safari\//.test(s)) br = 'Safari';
  return `${os} · ${br}`;
}
async function notifySecurity(userId, text) {
  await notify(userId, 'security', text, '');
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
  req.sessionToken = token;
  recordActivity(req.user.id); // نافذة نشاط المستخدم لتوقيت الإشعارات (مخنوقة داخلياً)
  if (!s.last_seen_at || now() - s.last_seen_at > 60 * 1000) {
    await db.prepare('UPDATE sessions SET last_seen_at=? WHERE token=?').run(now(), token);
  }
  /* بوابة الترحيل — نطاق جلسة مقيّد خادمياً (إصلاح حي ١، TESTING-LIVE-FIXES.md):
     أي جلسة لحساب بلا كلمة سر — سواء خُتمت scope='setup' عند إصدارها أو
     سابقة لها (تُشتق التقييدة من غياب password_hash نفسه فتُغطَّى كل
     الجلسات القائمة تلقائياً) — لا تصل إلا لثلاثة مسارات: قراءة الهوية
     (GET /api/me — تحتاجها شاشة التعيين لتعرف الحساب)، تعيين كلمة السر،
     وتسجيل الخروج. كل مسار آخر (بيانات/حجوزات/مالك/قراءات) يُرفض بـ403
     PASSWORD_SETUP_REQUIRED حتى يُعيَّن كلمة السر — فلا اعتماد على
     الواجهة في الفرض أبداً، ولا يُقفل أحد خارج حسابه. */
  req.sessionScope = s.scope || 'full';
  const restricted = req.sessionScope === 'setup' || !req.user.password_hash;
  req.sessionRestricted = restricted;
  if (restricted) {
    const p = req.path || '';
    const allowed =
      (req.method === 'GET' && p === '/api/me') ||
      p === '/api/me/set-password' ||
      p === '/api/auth/logout';
    if (!allowed) {
      return res.status(403).json({ error: 'عيّن كلمة سر لحسابك أولاً لإتمام هذا الإجراء', code: 'PASSWORD_SETUP_REQUIRED' });
    }
  }
  next();
}
async function makeSession(userId, req, scope = 'full') {
  const token = rnd(24);
  const ua = req ? String((req.headers && req.headers['user-agent']) || '').slice(0, 300) : '';
  await db.prepare('INSERT INTO sessions (token,user_id,created_at,user_agent,last_seen_at,scope) VALUES (?,?,?,?,?,?)')
    .run(token, userId, now(), ua, now(), scope === 'setup' ? 'setup' : 'full');
  return token;
}
/* تنبيه «جهاز جديد»: عند دخول من وكيل مستخدم لم يظهر في جلسات الحساب
   السابقة أبداً (والحساب له جلسات سابقة فعلاً — فلا تنبيه عند أول دخول). */
async function notifyIfNewDevice(userId, req) {
  if (!req) return;
  const ua = String((req.headers && req.headers['user-agent']) || '').slice(0, 300);
  if (!ua) return;
  const prev = await db.prepare('SELECT user_agent FROM sessions WHERE user_id=?').all(userId);
  if (!prev.length) return;
  if (prev.some((s) => s.user_agent === ua)) return;
  await notifySecurity(userId, `تنبيه أمان: دخول إلى حسابك من جهاز جديد (${deviceSummary(ua)}) — لو مش انت، غيّر كلمة السر وأنهِ الجلسات من إعدادات الأمان`);
}


const TOS_VERSION = 'deal-tos-v2'; // إصدار «شروط الاستخدام» — يُسجَّل قبولها عند التسجيل (v2: قسم «حدود المسؤولية» المراجَع — مراجعة المسؤولية 2026-11-23؛ قبولات v1 المسجلة تبقى كما هي بلا أثر رجعي)
app.post('/api/auth/register', async (req, res) => {
  /* قبول الشروط شرط تسجيل (الحزمة القانونية): بلا قبول صريح لشروط الاستخدام
     وتأكيد سن ١٨+ يُرفض التسجيل خادمياً؛ القبول يُسجَّل بالإصدار والوقت. */
  if ((req.body || {}).tos_accepted !== true) return res.status(400).json({ error: 'لازم توافق على شروط الاستخدام الأول عشان تسجل', tos_required: true, tos_version: TOS_VERSION });
  if ((req.body || {}).age_confirmed !== true) return res.status(400).json({ error: 'التسجيل لمن هم ١٨ سنة أو أكثر فقط — أكّد سنك', age_required: true });
  /* تحقق Cloudflare Turnstile عند التسجيل (الجولة الأخيرة — بوابة بيئية):
     لا يعمل إطلاقاً إلا عند ضبط TURNSTILE_SECRET_KEY؛ بلا المتغير سلوك
     التسجيل هو سلوك اليوم حرفياً. في بيئة الاختبار (DEAL_TEST_HOOKS=1)
     يُحاكى التحقق محلياً برمز ثابت بدل نداء Cloudflare الحقيقي. */
  if (process.env.TURNSTILE_SECRET_KEY) {
    const tsToken = String((req.body || {}).turnstile_token || '');
    let tsOk = false;
    if (process.env.DEAL_TEST_HOOKS === '1') {
      tsOk = tsToken === 'test-good-token';
    } else if (tsToken) {
      try {
        const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 5000);
        const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: tsToken }),
        });
        clearTimeout(tm);
        const vj = await vr.json().catch(() => null);
        tsOk = !!(vj && vj.success);
      } catch (e) { tsOk = false; }
    }
    if (!tsOk) return res.status(400).json({ error: 'أكمل تحقق الأمان أولاً ثم حاول تاني', code: 'TURNSTILE_FAILED' });
  }
  const { name, role, niche = '', provider_category = null, provider_custom = '', city = '', followers = 0, price = 0, bio = '', links = '' } = req.body || {};
  // الدولة من القائمة المدعومة (افتراضي مصر)، والعملة تُشتق منها خادمياً
  // — لا تُقبل عملة من العميل أبداً حتى لا ينفصل السعر عن بلد صاحبه.
  // الاستثناء الوحيد هو المسار الدولي العام (OTHER): الدولة غير مدرجة،
  // فيُطلب اسمها نصياً وعملتها من قائمة ISO المدمجة (قائمة مغلقة خادمياً،
  // لا نصاً حراً) — وكل ما عداه يبقى مشتقاً من الدولة.
  const countryDef = countryOf((req.body || {}).country || 'EG');
  if (!countryDef) return res.status(400).json({ error: 'دولة غير مدعومة حالياً' });
  const country = countryDef.code;
  let currency = countryDef.currency, countryName = '';
  if (country === 'OTHER') {
    countryName = String((req.body || {}).country_name || '').trim().slice(0, 60);
    if (!countryName) return res.status(400).json({ error: 'اكتب اسم دولتك', country_name_required: true });
    const reqCur = String((req.body || {}).currency || '').toUpperCase();
    if (!isIntlCurrency(reqCur)) return res.status(400).json({ error: 'اختر عملة حسابك من القائمة', currency_required: true });
    currency = reqCur;
  }
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
  /* كلمة سر حقيقية شرط تسجيل (جولة «زي التطبيقات الكبرى»): لا حساب جديد
     بلا كلمة سر من أول لحظة — بجانب علمَي الشروط والسن أعلاه. */
  const password = (req.body || {}).password;
  if (!validPassword(password)) return res.status(400).json({ error: 'كلمة السر مطلوبة — ٨ أحرف على الأقل' });
  if (!['creator', 'provider', 'shop', 'brand'].includes(role)) return res.status(400).json({ error: 'دور غير صحيح' });
  if (role === 'provider') {
    // أي خدمة يحتاجها السوق: من القائمة الموحّدة، أو «أخرى» بنص حر إلزامي يظهر كما كتبه.
    if (![...SERVICE_KEYS, 'other'].includes(provider_category)) return res.status(400).json({ error: 'اختر خدمتك من القائمة' });
    if (provider_category === 'other' && !String(provider_custom || '').trim()) return res.status(400).json({ error: 'اكتب خدمتك كما تريد أن تظهر في ملفك' });
  }
  /* حظر الشخص (جولة الردع): هاتف/إيميل/بصمة جهاز في قائمة الحظر الدائمة =
     لا حساب جديد أبداً — الفحص قبل فحص التكرار حتى لا يُرشَد المحظور للدخول. */
  if (await personBlockHit({ contact, phone, req })) return res.status(403).json({ error: PERSON_BANNED_ERROR, person_banned: true });
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
  const passwordHash = await hashPassword(password);
  /* إيميل التواصل هو قناة الاسترجاع تلقائياً؛ حساب الموبايل يضيف إيميل
     استرجاع لاحقاً من إعدادات الأمان (تنبيه لطيف لا حظر). */
  const recoveryEmail = contact.includes('@') ? contact : '';
  const info = await db.prepare(`INSERT INTO users (name,role,niche,provider_category,provider_custom,city,country,country_name,currency,contact,phone,followers,price,bio,links,is_platform_founder,is_founder_member,referred_by,created_at,tos_version,tos_accepted_at,password_hash,password_set_at,recovery_email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, role, niche, provider_category, role === 'provider' ? String(provider_custom || '').trim() : '', city, country, countryName, currency, contact, phone, followers, price, bio, links, isFounder, isFounderMember, referredBy, now(), TOS_VERSION, now(), passwordHash, now(), recoveryEmail);
  /* مقعد المؤسس المرقّم: يُسنَد فوراً عند التسجيل برقم = ترتيب هذا العضو بين
     المؤهلين (صناع/مقدمون، بلا صاحب المنصة) — أول ٥٠ فقط، والرقم لا يتغير
     أبداً بعد إسناده (نفس قاعدة الإسناد الرجعي في ترحيلات db.js). */
  if (!isFounder && ['creator', 'provider'].includes(role)) {
    const newId = info.lastInsertRowid;
    const rank = (await db.prepare(`SELECT COUNT(*) c FROM users WHERE role IN ('creator','provider') AND is_platform_founder=0 AND id<=?`).get(newId)).c;
    if (rank >= 1 && rank <= 50) {
      await db.prepare('UPDATE users SET founder_seat=? WHERE id=? AND founder_seat IS NULL').run(rank, newId);
    }
  }
  const user = await getUser(info.lastInsertRowid);
  /* تحقق الإيميل (٨-أ): يُولَّد كود ويُرسل بأفضل جهد عند التسجيل — التسجيل
     لا يفشل أبداً بسبب البريد؛ الحساب يعمل ويتصفح، والبوابة على قبول
     الحجوزات وتقديم العروض فقط. الحساب الأول (المؤسس) ومن سبقه يُعلَّمون
     موثّقين بترحيل القاعدة (email_verify_cutoff_ms). */
  try { if (!user.email_verified) await issueEmailVerification(user, req); } catch (e) { /* البريد لا يعطّل التسجيل */ }
  await recordUserFingerprint(user.id, req);
  if (referredBy) await notify(referredBy, 'referral', `سجّل ${user.name} من رابط ملفك على Deal`, `user:${user.id}`);
  res.json({ token: await makeSession(user.id, req), user: await publicUser(user), needs_password: false });
});

/* رسالة فشل دخول عامة واحدة (قرار «زي التطبيقات الكبرى»): لا تكشف إن
   كان الحساب موجوداً أصلاً ولا أي جزء من البيانات خطأ. */
const LOGIN_FAIL_ERROR = 'بيانات الدخول غير صحيحة — راجع وسيلة التواصل وكلمة السر';
app.post('/api/auth/login', async (req, res) => {
  const rawLogin = String((req.body && req.body.contact) || '').trim();
  const password = (req.body && req.body.password) || '';
  const contact = normalizeContact(rawLogin);
  const tKey = `login:${contact || rawLogin.toLowerCase()}|${clientIp(req)}`;
  const lockedMs = await throttleLockedMs(tKey);
  if (lockedMs > 0) {
    return res.status(429).json({ error: 'محاولات دخول كثيرة — استنى شوية وحاول تاني', retry_after_sec: Math.ceil(lockedMs / 1000) });
  }
  /* توحيد معرّفات الدخول (٩-ج): أي معرّف — إيميل أو هاتف — يجد الحساب بنفس
     السلوك. البحث يشمل عمودَي contact وphone معاً (من سجّل بإيميل وله رقم
     هاتف مسجل يدخل برقمه أيضاً)، وبكل صيغ التطبيع (محلي/دولي/لكل دولة)،
     فلا يرد «بيانات غير صحيحة» لحساب موجود بسبب اختلاف العمود أو الصيغة. */
  let user = null;
  {
    const candidates = new Set();
    if (contact) candidates.add(contact);
    if (rawLogin && !rawLogin.includes('@')) {
      for (const c of COUNTRIES) { const cand = normalizePhoneForCountry(rawLogin, c.code); if (cand) candidates.add(cand); }
      const intl = normalizeIntlPhone(rawLogin); if (intl) candidates.add(intl);
    }
    for (const cand of candidates) {
      user = await db.prepare('SELECT * FROM users WHERE contact=? OR phone=?').get(cand, cand);
      if (user) break;
    }
  }
  if (!user) {
    await throttleFail(tKey);
    return res.status(401).json({ error: LOGIN_FAIL_ERROR });
  }
  if (user.banned) return res.status(403).json({ error: 'هذا الحساب محظور' });
  /* حظر الشخص (جولة الردع): وسيلة التواصل أو بصمة الجهاز في قائمة الحظر
     باسم شخص محظور آخر = نفس الشخص يحاول الدخول بهوية ثانية — يُرفض. */
  const loginBlock = await personBlockHit({ contact: user.contact, phone: user.phone, req });
  if (loginBlock && loginBlock.user_id !== user.id) return res.status(403).json({ error: PERSON_BANNED_ERROR, person_banned: true });
  if (user.password_hash) {
    /* حساب له كلمة سر: لا دخول إلا بها — الدخول بالمعرّف وحده معطّل
       نهائياً من لحظة تعيين أول كلمة سر (قاعدة الترحيل). */
    if (!password || !(await verifyPassword(password, user.password_hash))) {
      await throttleFail(tKey);
      return res.status(401).json({ error: LOGIN_FAIL_ERROR });
    }
  }
  /* حساب قديم بلا كلمة سر (password_hash NULL): دخول بالمعرّف وحده في
     فترة الترحيل فقط — لكن الجلسة الصادرة مقيّدة النطاق خادمياً
     (scope='setup': تعيين كلمة السر + الهوية + الخروج فقط) حتى يُعيَّن
     كلمة السر؛ وبحساب له كلمة سر الجلسة كاملة من البداية. */
  await throttleClear(tKey);
  await recordUserFingerprint(user.id, req);
  await notifyIfNewDevice(user.id, req);
  const needsPw = !user.password_hash;
  res.json({ token: await makeSession(user.id, req, needsPw ? 'setup' : 'full'), user: await publicUser(user), needs_password: needsPw, session_scope: needsPw ? 'setup' : 'full' });
});

/* تسجيل الخروج الخادمي: حذف جلسة الرمز الحالي نفسه (المقيّدة أو الكاملة)
   فلا يبقى الرمز صالحاً بعدها — متاح للجلستين بنفس المسار. */
app.post('/api/auth/logout', auth, async (req, res) => {
  await db.prepare('DELETE FROM sessions WHERE token=?').run(req.sessionToken);
  res.json({ ok: true });
});

/* ---------------- إعدادات الأمان: كلمة السر والاسترجاع والجلسات ---------------- */
/* تعيين أول كلمة سر لحساب قديم (مسار الترحيل) — بعدها يُعطَّل الدخول
   بالمعرّف وحده نهائياً لأن password_hash صار موجوداً. */
app.post('/api/me/set-password', auth, async (req, res) => {
  if (req.user.password_hash) return res.status(400).json({ error: 'عندك كلمة سر بالفعل — استخدم «تغيير كلمة السر»' });
  const password = (req.body || {}).password;
  if (!validPassword(password)) return res.status(400).json({ error: 'كلمة السر مطلوبة — ٨ أحرف على الأقل' });
  await db.prepare('UPDATE users SET password_hash=?, password_set_at=? WHERE id=?')
    .run(await hashPassword(password), now(), req.user.id);
  /* ترقية الجلسة الحالية نفسها لنطاق كامل فور التعيين — صاحب الحساب
     يكمل من نفس الجلسة بلا إعادة دخول. */
  await db.prepare("UPDATE sessions SET scope='full' WHERE token=?").run(req.sessionToken);
  await notifySecurity(req.user.id, 'تم تعيين كلمة سر لحسابك — حسابك صار محمياً بكلمة سر');
  res.json({ ok: true, has_password: true, session_scope: 'full' });
});

/* تغيير كلمة السر: يتحقق من الحالية (بخانق محاولات)، ويُبطل كل الجلسات
   الأخرى فوراً، ويُشعر صاحب الحساب — خطوات التطبيقات الكبرى نفسها. */
app.post('/api/me/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!req.user.password_hash) return res.status(400).json({ error: 'لا كلمة سر بعد — استخدم «تعيين كلمة سر»' });
  if (!validPassword(new_password)) return res.status(400).json({ error: 'كلمة السر الجديدة مطلوبة — ٨ أحرف على الأقل' });
  const tKey = `chpw:${req.user.id}|${clientIp(req)}`;
  if ((await throttleLockedMs(tKey)) > 0) return res.status(429).json({ error: 'محاولات كثيرة — استنى شوية وحاول تاني' });
  if (!current_password || !(await verifyPassword(current_password, req.user.password_hash))) {
    await throttleFail(tKey);
    return res.status(401).json({ error: 'كلمة السر الحالية غير صحيحة' });
  }
  await throttleClear(tKey);
  await db.prepare('UPDATE users SET password_hash=?, password_set_at=? WHERE id=?')
    .run(await hashPassword(new_password), now(), req.user.id);
  await db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(req.user.id, req.sessionToken);
  await notifySecurity(req.user.id, 'تم تغيير كلمة سر حسابك — لو مش انت اللي غيّرتها، استرجع حسابك فوراً وكلّم الدعم');
  res.json({ ok: true });
});

/* إيميل الاسترجاع: قناة «نسيت كلمة السر» لحسابات الموبايل. لا يُقبل
   إيميل مسجل وسيلةَ تواصل لحساب آخر حتى لا تختلط قنوات الاسترجاع. */
app.post('/api/me/recovery-email', auth, async (req, res) => {
  const email = normalizeContact(String((req.body || {}).email || ''));
  if (!email || !email.includes('@') || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'اكتب إيميلاً صحيحاً' });
  }
  const other = await db.prepare('SELECT id FROM users WHERE (contact=? OR recovery_email=?) AND id<>?').get(email, email, req.user.id);
  if (other) return res.status(409).json({ error: 'الإيميل ده مربوط بحساب آخر' });
  await db.prepare('UPDATE users SET recovery_email=? WHERE id=?').run(email, req.user.id);
  await notifySecurity(req.user.id, 'تم تحديث إيميل استرجاع حسابك');
  res.json({ ok: true, recovery_email: email });
});

/* ---------------- الأكواد الاحتياطية ----------------
   ١٠ أكواد تُعرض مرة واحدة فقط، تُخزَّن مُجزّأة (SHA-256 مع معرّف
   المستخدم)، كل كود لمرة واحدة، وإعادة التوليد تُلغي القديمة كلها —
   وهي قناة الاسترجاع البديلة لمن لا يصله بريد. */
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genBackupCode() {
  const pick = () => BACKUP_ALPHABET[crypto.randomInt(0, BACKUP_ALPHABET.length)];
  const raw = Array.from({ length: 8 }, pick).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
const backupCodeHash = (userId, code) =>
  sha256hex(`backup:${userId}:${String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}`);
app.get('/api/me/backup-codes', auth, async (req, res) => {
  const row = await db.prepare('SELECT COUNT(*) c FROM backup_codes WHERE user_id=? AND used_at=0').get(req.user.id);
  res.json({ remaining: row.c });
});
app.post('/api/me/backup-codes', auth, async (req, res) => {
  if (!req.user.password_hash) return res.status(400).json({ error: 'عيّن كلمة سر أولاً قبل توليد أكواد احتياطية' });
  const tKey = `bcgen:${req.user.id}|${clientIp(req)}`;
  if ((await throttleLockedMs(tKey)) > 0) return res.status(429).json({ error: 'محاولات كثيرة — استنى شوية وحاول تاني' });
  const current = (req.body || {}).current_password || '';
  if (!current || !(await verifyPassword(current, req.user.password_hash))) {
    await throttleFail(tKey);
    return res.status(401).json({ error: 'كلمة السر الحالية غير صحيحة' });
  }
  await throttleClear(tKey);
  await db.prepare('DELETE FROM backup_codes WHERE user_id=?').run(req.user.id);
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const code = genBackupCode();
    codes.push(code);
    await db.prepare('INSERT INTO backup_codes (user_id,code_hash,created_at) VALUES (?,?,?)')
      .run(req.user.id, backupCodeHash(req.user.id, code), now());
  }
  await notifySecurity(req.user.id, 'تم توليد أكواد احتياطية جديدة لحسابك — الأكواد القديمة أُلغيت');
  res.json({ codes, remaining: codes.length });
});

/* ---------------- أجهزتي وجلساتي ----------------
   لا يخرج أي توكن خام: معرّف الجلسة العام بصمة SHA-256 مقصوصة منه. */
const sessionPublicId = (token) => sha256hex(token).slice(0, 16);
app.get('/api/me/sessions', auth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({
    items: rows.map((s) => ({
      sid: sessionPublicId(s.token),
      device: deviceSummary(s.user_agent),
      created_at: s.created_at,
      last_seen_at: s.last_seen_at || s.created_at,
      current: s.token === req.sessionToken,
    })),
  });
});
app.delete('/api/me/sessions/:sid', auth, async (req, res) => {
  const rows = await db.prepare('SELECT token FROM sessions WHERE user_id=?').all(req.user.id);
  const target = rows.find((s) => sessionPublicId(s.token) === String(req.params.sid));
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  if (target.token === req.sessionToken) {
    return res.status(400).json({ error: 'دي جلستك الحالية — استخدم «خروج» لإنهائها' });
  }
  await db.prepare('DELETE FROM sessions WHERE token=?').run(target.token);
  await notifySecurity(req.user.id, 'تم إنهاء جلسة على جهاز آخر من إعدادات الأمان');
  res.json({ ok: true });
});
app.post('/api/me/sessions/revoke-others', auth, async (req, res) => {
  const r = await db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(req.user.id, req.sessionToken);
  if (r.changes) await notifySecurity(req.user.id, 'تم إنهاء كل جلسات حسابك على الأجهزة الأخرى');
  res.json({ ok: true, revoked: r.changes });
});

/* ---------------- نسيت كلمة السر (تدفق التطبيقات الكبرى) ----------------
   إيميل الحساب (وسيلة التواصل أو إيميل الاسترجاع) ← كود ٦ أرقام
   (صلاحية ١٠ دقائق، مُجزّأ، ٥ محاولات كحد أقصى، تهدئة إعادة إرسال
   ٦٠ ثانية) ← كلمة سر جديدة ← إبطال كل الجلسات + إشعار أمان.
   الرد على طلب الكود عام دائماً (لا يكشف وجود الحساب) — إلا حين لا
   يكون أي مزوّد بريد مُعدّاً أصلاً: عندها تتعطل الخطوة برسالة واضحة
   وتُوجَّه للأكواد الاحتياطية. */
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
async function findUserByEmail(email) {
  if (!email || !email.includes('@')) return null;
  return (await db.prepare('SELECT * FROM users WHERE contact=? OR recovery_email=?').get(email, email)) || null;
}
app.post('/api/auth/forgot', async (req, res) => {
  const email = normalizeContact(String((req.body || {}).email || ''));
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'اكتب إيميل الحساب' });
  if (!mailer.configured()) {
    return res.status(503).json({
      error: 'استرجاع كلمة السر بالإيميل غير مفعّل حالياً — استخدم الأكواد الاحتياطية أو تواصل مع الدعم',
      code: 'EMAIL_NOT_CONFIGURED',
    });
  }
  const user = await findUserByEmail(email);
  if (user && !user.banned) {
    const last = await db.prepare('SELECT * FROM password_resets WHERE user_id=? ORDER BY id DESC').get(user.id);
    const cooling = last && now() - last.created_at < RESET_RESEND_COOLDOWN_MS;
    if (!cooling) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await db.prepare('DELETE FROM password_resets WHERE user_id=?').run(user.id);
      const info = await db.prepare('INSERT INTO password_resets (user_id,code_hash,created_at,expires_at) VALUES (?,?,?,?)')
        .run(user.id, sha256hex(`reset:${user.id}:${code}`), now(), now() + RESET_CODE_TTL_MS);
      try {
        await mailer.sendMail({
          to: email,
          subject: 'Deal — كود استرجاع كلمة السر',
          text: `كود استرجاع كلمة سر حسابك على Deal هو: ${code}\nالكود صالح ١٠ دقائق فقط. لو ما طلبتش الاسترجاع، تجاهل الرسالة دي — حسابك آمن.`,
        });
      } catch (e) {
        await db.prepare('DELETE FROM password_resets WHERE id=?').run(info.lastInsertRowid);
        return res.status(503).json({ error: 'تعذّر إرسال الإيميل حالياً — حاول بعد قليل أو استخدم الأكواد الاحتياطية', code: 'EMAIL_SEND_FAILED' });
      }
    }
  }
  res.json({ ok: true, message: 'لو الإيميل مسجل عندنا، هيوصلك كود تحقق خلال دقائق' });
});

async function applyNewPasswordAndRevoke(userId, text) {
  await db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  await notifySecurity(userId, text);
}
app.post('/api/auth/reset', async (req, res) => {
  const email = normalizeContact(String((req.body || {}).email || ''));
  const code = String((req.body || {}).code || '').trim();
  const newPassword = (req.body || {}).new_password;
  if (!validPassword(newPassword)) return res.status(400).json({ error: 'كلمة السر الجديدة مطلوبة — ٨ أحرف على الأقل' });
  const user = await findUserByEmail(email);
  const fail = async () => res.status(400).json({ error: 'الكود غير صحيح أو منتهي — اطلب كوداً جديداً' });
  if (!user || user.banned) return fail();
  const row = await db.prepare('SELECT * FROM password_resets WHERE user_id=? AND used_at=0 ORDER BY id DESC').get(user.id);
  if (!row || row.expires_at <= now() || row.attempts >= RESET_MAX_ATTEMPTS) return fail();
  if (sha256hex(`reset:${user.id}:${code}`) !== row.code_hash) {
    const attempts = row.attempts + 1;
    if (attempts >= RESET_MAX_ATTEMPTS) await db.prepare('DELETE FROM password_resets WHERE id=?').run(row.id);
    else await db.prepare('UPDATE password_resets SET attempts=? WHERE id=?').run(attempts, row.id);
    return fail();
  }
  await db.prepare('UPDATE password_resets SET used_at=? WHERE id=?').run(now(), row.id);
  await db.prepare('UPDATE users SET password_hash=?, password_set_at=? WHERE id=?')
    .run(await hashPassword(newPassword), now(), user.id);
  await db.prepare('DELETE FROM password_resets WHERE user_id=?').run(user.id);
  await applyNewPasswordAndRevoke(user.id, 'تمت إعادة تعيين كلمة سر حسابك من قناة الاسترجاع — وسُجّل خروج كل الأجهزة');
  res.json({ ok: true });
});

/* الاسترجاع بكود احتياطي: بديل قناة البريد — معرّف الحساب + كود واحد
   من أكواد الإعدادات + كلمة سر جديدة. الكود يُستهلك فوراً ولا يعمل
   ثانية، والفشل المتكرر مخنوق كالدخول. */
app.post('/api/auth/reset-backup', async (req, res) => {
  const rawId = String((req.body || {}).contact || '').trim();
  const code = String((req.body || {}).code || '');
  const newPassword = (req.body || {}).new_password;
  if (!validPassword(newPassword)) return res.status(400).json({ error: 'كلمة السر الجديدة مطلوبة — ٨ أحرف على الأقل' });
  const contact = normalizeContact(rawId);
  const tKey = `backup:${contact || rawId.toLowerCase()}|${clientIp(req)}`;
  if ((await throttleLockedMs(tKey)) > 0) return res.status(429).json({ error: 'محاولات كثيرة — استنى شوية وحاول تاني' });
  let user = contact && await db.prepare('SELECT * FROM users WHERE contact=?').get(contact);
  if (!user && rawId && !rawId.includes('@')) {
    for (const c of COUNTRIES) {
      const cand = normalizePhoneForCountry(rawId, c.code);
      if (cand && cand !== contact) {
        user = await db.prepare('SELECT * FROM users WHERE contact=?').get(cand);
        if (user) break;
      }
    }
  }
  const fail = async () => { await throttleFail(tKey); return res.status(400).json({ error: 'الكود الاحتياطي غير صحيح أو مستخدم من قبل' }); };
  if (!user || user.banned) return fail();
  const row = await db.prepare('SELECT * FROM backup_codes WHERE user_id=? AND code_hash=? AND used_at=0')
    .get(user.id, backupCodeHash(user.id, code));
  if (!row) return fail();
  await throttleClear(tKey);
  await db.prepare('UPDATE backup_codes SET used_at=? WHERE id=?').run(now(), row.id);
  await db.prepare('UPDATE users SET password_hash=?, password_set_at=? WHERE id=?')
    .run(await hashPassword(newPassword), now(), user.id);
  await applyNewPasswordAndRevoke(user.id, 'تمت إعادة تعيين كلمة سر حسابك بكود احتياطي — وسُجّل خروج كل الأجهزة');
  res.json({ ok: true });
});

/* خطّاف اختبار داخلي: لا يُسجَّل إلا بمتغير DEAL_TEST_HOOKS=1 (بيئة
   الاختبار فقط — غير موجود في الإنتاج إطلاقاً). يعيد آخر كود استرجاع
   أُرسل لإيميل من صندوق الصادر الاختباري لمزوّد test. */
if (process.env.DEAL_TEST_HOOKS === '1') {
  app.get('/api/auth/_test/code', async (req, res) => {
    const email = normalizeContact(String(req.query.email || ''));
    const outbox = (global.__dealOutbox || []).filter((m) => m.to === email);
    const last = outbox[outbox.length - 1];
    const m = last && /(\d{6})/.exec(String(last.text || ''));
    if (!m) return res.status(404).json({ error: 'no code' });
    res.json({ code: m[1] });
  });
  /* خطّاف الرد الذكي: كتابة سيناريو مزوّد test وقراءة عدّاد نداءاته —
     بنفس قاعدة الخطّاف أعلاه (بيئة الاختبار فقط، غائب من الإنتاج). */
  app.post('/api/support/_test/ai-script', (req, res) => {
    const { mode = 'off', text = '' } = req.body || {};
    global.__dealAiScript = { mode: String(mode), text: String(text || '') };
    res.json({ ok: true });
  });
  app.get('/api/support/_test/ai-calls', (req, res) => {
    res.json({ calls: global.__dealAiCalls || [], configured: aiSupport.configured(), provider: aiSupport.provider, model: aiSupport.MODEL });
  });
  /* خطّاف سجل الأخطاء (الجولة الأخيرة — بند ٢): خطأ مُستحدَث عمداً للتحقق
     أن المعالج الأخير يرد رداً نظيفاً ويكتب صف سجل في آن واحد. */
  app.post('/api/_test/boom', (req, res) => { throw new Error('induced test error (FIN)'); });
}

/* ---------------- البلاغات (محتوى وملفات) ----------------
   إبلاغ قصير بسبب، يهبط في قائمة إشراف المالك. بلاغ مفتوح واحد لكل
   مُبلِّغ وهدف (الفهرس الفريد الجزئي) — التكرار يُرفض برسالة واضحة. */
const REPORT_REASONS = ['spam', 'abuse', 'fake', 'scam', 'inappropriate', 'off_platform', 'other'];
app.post('/api/reports', auth, async (req, res) => {
  const { target_type, target_id, reason, details } = req.body || {};
  if (!['post', 'profile', 'daily_video', 'question'].includes(target_type)) return res.status(400).json({ error: 'هدف إبلاغ غير صحيح' });
  if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: 'اختر سبب الإبلاغ' });
  let targetUserId = null;
  if (target_type === 'post') {
    const post = await db.prepare('SELECT * FROM profile_posts WHERE id=?').get(+target_id || 0);
    if (!post) return res.status(404).json({ error: 'غير موجود' });
    targetUserId = post.user_id;
  } else if (target_type === 'daily_video') {
    const v = await db.prepare('SELECT * FROM daily_videos WHERE id=?').get(+target_id || 0);
    if (!v) return res.status(404).json({ error: 'غير موجود' });
    targetUserId = v.user_id;
  } else if (target_type === 'question') {
    const q = await db.prepare('SELECT * FROM profile_questions WHERE id=?').get(+target_id || 0);
    if (!q) return res.status(404).json({ error: 'غير موجود' });
    targetUserId = q.asker_id || q.talent_id;
  } else {
    const target = await getUser(+target_id || 0);
    if (!target) return res.status(404).json({ error: 'غير موجود' });
    targetUserId = target.id;
  }
  if (targetUserId === req.user.id) {
    return res.status(400).json({ error: target_type === 'post' ? 'لا يمكنك الإبلاغ عن منشورك' : 'لا يمكنك الإبلاغ عن ملفك' });
  }
  try {
    const info = await db.prepare(`INSERT INTO reports (reporter_id,target_type,target_id,target_user_id,reason,details,created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(req.user.id, target_type, +target_id, targetUserId, reason, String(details || '').slice(0, 1000), now());
    await notifyOwner('report', `🚩 بلاغ جديد (${target_type === 'post' ? 'منشور' : 'ملف'} #${+target_id}) — السبب: ${reason}`, `report:${info.lastInsertRowid}`);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    return res.status(409).json({ error: 'أبلغت عن هذا من قبل وهو قيد المراجعة' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  await syncBadges(req.user.id);
  const user = await publicUser(req.user, req.user.id);
  // بيانات التواصل الخاصة تظهر لصاحب الحساب نفسه فقط (لتعبئة نموذج تعديل ملفه) —
  // ولا تخرج في الدليل أو ملف أي مستخدم آخر، والمؤسس تحديداً لا يراها أحد غيره.
  user.contact = req.user.contact;
  user.phone = req.user.phone || '';
  user.links = req.user.links || '';
  /* حالة الأمان لصاحب الحساب فقط: هل له كلمة سر؟ وما إيميل استرجاعه؟
     (الواجهة تبني عليها بطاقة الأمان وتنبيه «أضف إيميل استرجاع»). */
  user.has_password = !!req.user.password_hash;
  user.needs_password = !req.user.password_hash;
  user.recovery_email = req.user.recovery_email || '';
  user.email_verified = !!req.user.email_verified;
  user.verify_email = (req.user.recovery_email || (req.user.contact && req.user.contact.includes('@') ? req.user.contact : '')) || '';
  user.fin_identity = req.user.fin_declared_at ? { declared: true, declared_at: req.user.fin_declared_at, version: req.user.fin_declared_version || '', wallet_masked: maskTail(req.user.fin_wallet_number), has_legal_name: !!req.user.legal_name } : { declared: false };
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
/* ---- تحقق الإيميل (٨-أ): بدء/إعادة إرسال + تأكيد ---- */
app.post('/api/me/verify-email/start', auth, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already_verified: true });
  let u = req.user;
  const bodyEmail = String((req.body || {}).email || '').trim().toLowerCase();
  if (bodyEmail && !u.recovery_email && !(u.contact && u.contact.includes('@'))) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(bodyEmail)) return res.status(400).json({ error: 'إيميل غير صحيح' });
    /* مسار «أضف إيميلك وأكّده» لحسابات الهاتف (إصلاح حي ٢-١): الإيميل
       المُدخَل يصير قناة تأكيد واسترجاع لهذا الحساب، فلا يُقبل إن كان
       وسيلة تواصل أو إيميل استرجاع لحساب آخر — نفس قاعدة /api/me/recovery-email. */
    const dup = await db.prepare('SELECT id FROM users WHERE (contact=? OR recovery_email=?) AND id<>?').get(bodyEmail, bodyEmail, u.id);
    if (dup) return res.status(409).json({ error: 'الإيميل ده مربوط بحساب آخر', code: 'EMAIL_TAKEN' });
    await db.prepare('UPDATE users SET recovery_email=? WHERE id=?').run(bodyEmail, u.id);
    u = await getUser(u.id);
  }
  const out = await issueEmailVerification(u, req);
  if (out.reason === 'no_email') return res.status(400).json({ error: 'أضف إيميلك الأول عشان يوصلك كود التأكيد', email_required: true });
  if (out.reason === 'cooldown') return res.status(429).json({ error: 'استنى دقيقة قبل إعادة إرسال الكود', retry_after_sec: out.retry_after_sec });
  if (out.reason === 'hourly_cap') return res.status(429).json({ error: 'وصلت لحد إعادة الإرسال في الساعة — حاول بعد شوية' });
  res.json({ ok: true, sent: out.sent, email_masked: out.email ? out.email.replace(/^(.).*(@.*)$/, '$1•••$2') : '' });
});
app.post('/api/me/verify-email/confirm', auth, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already_verified: true });
  const code = String((req.body || {}).code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'كود التأكيد ٦ أرقام' });
  const row = await db.prepare('SELECT * FROM email_verification_codes WHERE user_id=? AND used_at=0 ORDER BY id DESC LIMIT 1').get(req.user.id);
  if (!row) return res.status(400).json({ error: 'لا يوجد كود قائم — اطلب كوداً جديداً' });
  if (row.expires_at <= now()) return res.status(400).json({ error: 'انتهت صلاحية الكود — اطلب كوداً جديداً' });
  if ((row.attempts || 0) >= 5) return res.status(429).json({ error: 'محاولات كتير على الكود ده — اطلب كوداً جديداً' });
  if (sha256hex('verify:' + req.user.id + ':' + code) !== row.code_hash) {
    await db.prepare('UPDATE email_verification_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
    return res.status(400).json({ error: 'الكود غير صحيح' });
  }
  await db.prepare('UPDATE email_verification_codes SET used_at=? WHERE id=?').run(now(), row.id);
  await db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(req.user.id);
  /* رسالة ترحيب المؤسس (جولة التلميع والنمو): أول إكمال لتحقق الإيميل فقط —
     أفضل جهد، لا تعطّل التأكيد أبداً. */
  try { await maybeSendFounderWelcome(await getUser(req.user.id), (req.body || {}).lang); } catch (e) { /* الترحيب لا يعطّل التأكيد */ }
  res.json({ ok: true, email_verified: true });
});
/* ---- الهوية المالية المؤكدة (٦-ب + ٨-ب): إقرار مسجل + اسم قانوني ---- */
app.get('/api/me/financial-identity', auth, async (req, res) => {
  const u = req.user;
  res.json({ declared: !!u.fin_declared_at, declared_at: u.fin_declared_at || 0, version: u.fin_declared_version || '', wallet_masked: u.fin_declared_at ? maskTail(u.fin_wallet_number) : '', has_legal_name: !!u.legal_name, declaration_ar: FIN_DECLARATION_AR, declaration_en: FIN_DECLARATION_EN, version_current: FIN_IDENTITY_VERSION });
});
app.post('/api/me/financial-identity', auth, async (req, res) => {
  const u = req.user;
  if (u.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس عرض فقط' });
  /* الإقرار متاح لكل حساب مسجل (صانع/مقدم/عميل): الإقرار عن محفظة التحويل
     التي يتعامل بها الحساب نفسه، وبوابة المخاطر الحية (محركات النمو والأمان)
     قد تطلبه من أي طرف في حجز كبير — فلا بد أن يقدر كل طرف على إكماله. */
  const { wallet_number, legal_name, wallet_owner_name, declaration_accepted } = req.body || {};
  const wallet = String(wallet_number || '').trim();
  if (!/^\+?[\d\s-]{8,24}$/.test(wallet) || wallet.replace(/\D/g, '').length < 8 || wallet.replace(/\D/g, '').length > 20) return res.status(400).json({ error: 'رقم محفظة تحويل صحيح مطلوب (أرقام فقط، ٨–٢٠ رقماً)' });
  const legal = String(legal_name || '').trim().replace(/\s+/g, ' ');
  if (legal.split(' ').filter(Boolean).length < 3) return res.status(400).json({ error: 'الاسم القانوني الكامل كما في البطاقة مطلوب (ثلاثي على الأقل)' });
  const owner = String(wallet_owner_name || '').trim().replace(/\s+/g, ' ');
  if (!owner) return res.status(400).json({ error: 'اسم صاحب المحفظة كما هو مسجل عليها مطلوب' });
  if (normPersonName(owner) !== normPersonName(legal)) return res.status(400).json({ error: 'اسم صاحب المحفظة لا يطابق الاسم القانوني — المحفظة لازم تكون باسمك المسجل لقبول الإقرار', name_mismatch: true });
  if (declaration_accepted !== true) return res.status(400).json({ error: 'لازم توافق على نص الإقرار لتسجيل هويتك المالية', declaration_required: true });
  await db.prepare('UPDATE users SET fin_wallet_number=?, fin_declared_at=?, fin_declared_version=?, legal_name=?, fin_wallet_owner=? WHERE id=?')
    .run(wallet.replace(/[\s-]/g, ''), now(), FIN_IDENTITY_VERSION, legal, owner, u.id);
  res.json({ ok: true, declared: true, version: FIN_IDENTITY_VERSION, wallet_masked: maskTail(wallet) });
});

app.get('/api/me/portfolio', auth, async (req, res) => {
  res.json({ items: await shortsOf(req.user.id) });
});
app.post('/api/me/portfolio', auth, async (req, res) => {
  if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس عرض فقط — لا نماذج شورتس' });
  if (!['creator', 'provider'].includes(req.user.role)) return res.status(400).json({ error: 'نماذج الأعمال للصناع ومقدمي الخدمة فقط' });
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

/* ---------------- جدار المؤسسين: المقاعد ١–٥٠ كما هي في السجلات ----------------
   المشغولة بالعضو (اسم/مدينة/دولة/مجال) والشاغرة «مقعد متاح» — والفئة مغلقة
   نهائياً عند اكتمال الخمسين (closed=true) ولا تُفتح ثانية أبداً. */
app.get('/api/founders-wall', async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM users WHERE founder_seat IS NOT NULL AND founder_seat BETWEEN 1 AND 50 ORDER BY founder_seat ASC`).all();
  const bySeat = new Map(rows.map((u) => [u.founder_seat, u]));
  const seats = [];
  for (let n = 1; n <= 50; n++) {
    const u = bySeat.get(n);
    seats.push(u ? {
      seat: n, taken: true, user_id: u.id, name: u.name, role: u.role,
      niche: u.niche || '', provider_category: u.provider_category || '', provider_custom: u.provider_custom || '',
      city: u.city || '', country: u.country || '', avatar: u.avatar || '', verified: !!u.verified,
    } : { seat: n, taken: false });
  }
  res.json({ seats, taken: rows.length, closed: rows.length >= 50 });
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

/* ---------------- بطاقات إنجاز الصانع (جولة مهام الترحيب والانتشار) ----------------
   قائمة بطاقات إنجاز العضو نفسه كمقدم/صانع: حجز مكتمل واحد = بطاقة واحدة.
   حقائق علنية فقط من ملف المقدم نفسه (المجال/فئة الخدمة + المدينة) + تاريخ
   الإتمام + رابط الصفقة الموثقة القائم نفسه (#/d/<id>) — بلا أي مبلغ وبلا
   هوية عميل إطلاقاً (لا يُختار عمود السعر أصلاً). العميل/الضيف لا يحصل
   على بطاقات هنا: الاستعلام مقيد بـ talent_id = صاحب الجلسة نفسه. */
app.get('/api/me/achievements', auth, async (req, res) => {
  const u = req.user;
  if (u.is_platform_founder || !['creator', 'provider'].includes(u.role)) return res.json({ items: [] });
  const rows = await db.prepare(`SELECT id, completed_at FROM bookings WHERE talent_id=? AND status='completed' ORDER BY completed_at DESC, id DESC`).all(u.id);
  res.json({
    items: rows.map((b) => ({
      booking_id: b.id,
      niche: u.niche || '', provider_category: u.provider_category || '', provider_custom: u.provider_custom || '',
      city: u.city || '', country: u.country || '',
      completed_at: b.completed_at || 0,
      deal_path: `#/d/${b.id}`,
    })),
  });
});

/* ---------------- المراسلة الداخلية 1:1 (حسابات مسجلة فقط) ----------------
   القاعدة العامة: عضو↔عضو للأصدقاء المقبولين فقط. امتياز المؤسس الموثّق
   (قرار المالك — «تواصل المؤسس الصادر»): المؤسس يبدأ التواصل مع أي عضو
   مسجل بلا شرط صداقة ويرسل/يستقبل في محادثاته، والعضو يرد فقط داخل
   محادثة بدأها المؤسس — بدء محادثة جديدة منه إلى المؤسس مرفوض. */
/* رسالة ترحيب المؤسس التلقائية (جولة التلميع والنمو — بند ٤): عند إكمال
   صانع/مقدم خدمة تحقق إيميله لأول مرة، يفتح المؤسس محادثة ١:١ معه برسالة
   ترحيب واحدة ثابتة (بآلية بدء المؤسس للتواصل نفسها — رسالة عادية في جدول
   messages من المؤسس، فيرد العضو داخلها بحكم قاعدة المراسلة القائمة).
   «مرة واحدة أبداً» محقّقة ذرّياً: ختم founder_welcomed_at بشرط أنه صفر —
   فلا إعادة تحقق ولا إعادة إرسال أكواد ولا سباق متزامن يكررها. المؤسس
   نفسه مستثنى، وغياب حساب مؤسس = تخطٍّ صامت. */
const FOUNDER_WELCOME_AR = (name) => `أهلاً بيك في Deal يا ${name} 👑 أنا مؤسس المنصة وبرحّب بيك بنفسي.
عشان تبدأ صح، خطواتك الجاية:
١) ضيف نماذج من شغلك في ملفك — هي أول حاجة العميل بيشوفها.
٢) اتعرّف على أكاديمية Deal — دروس قصيرة بتكبّر شغلك وسعرك.
٣) انسخ رابطك الشخصي من لوحتك وحطه في بايو حساباتك — كل عميل وكل صانع يسجّل منه بيوصلك.
أي سؤال؟ رد عليّ هنا على طول — بالتوفيق 🚀`;
const FOUNDER_WELCOME_EN = (name) => `Welcome to Deal, ${name} 👑 I am the platform founder, welcoming you personally.
To start right, your next steps:
1) Add work samples to your profile — they are the first thing a client sees.
2) Check out the Deal Academy — short lessons that grow your work and your price.
3) Copy your personal link from your dashboard into your social bios — every client and every creator who registers through it reaches you.
Any question? Just reply right here — good luck 🚀`;
async function maybeSendFounderWelcome(user, lang) {
  if (!user || user.is_platform_founder) return false;
  if (!['creator', 'provider'].includes(user.role)) return false;
  const founder = await db.prepare('SELECT * FROM users WHERE is_platform_founder=1 ORDER BY id ASC LIMIT 1').get();
  if (!founder || founder.id === user.id) return false;
  const claim = await db.prepare('UPDATE users SET founder_welcomed_at=? WHERE id=? AND founder_welcomed_at=0').run(now(), user.id);
  if (!claim.changes) return false; // خُتمت من قبل — لا تكرار أبداً
  const body = (lang === 'en' ? FOUNDER_WELCOME_EN : FOUNDER_WELCOME_AR)(user.name);
  await db.prepare('INSERT INTO messages (sender_id,recipient_id,body,created_at) VALUES (?,?,?,?)')
    .run(founder.id, user.id, body, now());
  await notify(user.id, 'message', `رسالة جديدة من ${founder.name}`, `messages:${founder.id}`);
  return true;
}
async function founderStartedThread(founderId, memberId) {
  const r = await db.prepare('SELECT 1 FROM messages WHERE sender_id=? AND recipient_id=? LIMIT 1').get(founderId, memberId);
  return !!r;
}
async function canMessagePair(me, other) {
  if (!me || !other || me.id === other.id) return false;
  if (me.is_platform_founder) return true;
  if (other.is_platform_founder) return founderStartedThread(other.id, me.id);
  return areFriends(me.id, other.id);
}
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
    const otherU = await getUser(c.other_id);
    items.push({
      user: socialSummary(otherU),
      last: { body: c.last.body, created_at: c.last.created_at, mine: c.last.sender_id === me },
      unread: c.unread,
      // محادثة لا تسمح قاعدة المراسلة بالإرسال فيها = للقراءة فقط (تظهر
      // في القائمة بحالتها الصادقة): غير صديق، أو عضو أمام مؤسس لم يبدأ.
      can_message: await canMessagePair(req.user, otherU),
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
    can_message: await canMessagePair(req.user, other),
    items: rows.map(m => ({ id: m.id, body: m.body, created_at: m.created_at, mine: m.sender_id === req.user.id, is_read: !!m.is_read })),
  });
});
app.post('/api/messages/:userId', auth, async (req, res) => {
  const other = await getUser(+req.params.userId);
  if (!other) return res.status(404).json({ error: 'غير موجود' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك مراسلة نفسك' });
  /* حظر عضو↔عضو (الجولة الأخيرة — بند ٩): حظر من أي جهة يمنع بدء/متابعة
     المراسلة المباشرة بين الطرفين. محادثة الحجز داخل حجز قائم مسار منفصل
     تماماً ولا يمسّه الحظر (أدلة وسلامة). */
  if (await blockBetween(req.user.id, other.id)) return res.status(403).json({ error: BLOCKED_ERROR, code: 'BLOCKED' });
  if (other.banned || other.frozen) return res.status(400).json({ error: 'هذا الحساب غير متاح للمراسلة حالياً' });
  /* بوابة المراسلة (قرار المالك): عضو↔عضو للأصدقاء المقبولين فقط (المحادثات
     القائمة مع غير أصدقاء تبقى قابلة للقراءة، والإرسال وحده يُرفض). واستثناء
     المؤسس الموثّق: المؤسس يبدأ التواصل مع أي عضو بلا شرط صداقة، والعضو
     يرد فقط داخل محادثة بدأها المؤسس — بدء محادثة جديدة منه إليه مرفوض. */
  if (req.user.is_platform_founder) {
    // امتياز المؤسس: بدء التواصل ومتابعته مع أي عضو مسجل.
  } else if (other.is_platform_founder) {
    if (!(await founderStartedThread(other.id, req.user.id))) {
      return res.status(400).json({ error: 'لا يمكنك بدء محادثة مع المؤسس — المؤسس هو من يبدأ التواصل، وتقدر ترد داخل أي محادثة بدأها معك' });
    }
  } else if (!(await areFriends(req.user.id, other.id))) {
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
    { "key": "videoproduction", "ar": "إنتاج ومونتاج الفيديو", "en": "Video production & editing" },
    { "key": "design", "ar": "تصميم وموشن جرافيك", "en": "Design & motion graphics" },
    { "key": "filming", "ar": "تصوير احترافي", "en": "Professional filming & photography" },
    { "key": "voiceover", "ar": "تعليق صوتي", "en": "Voice-over" },
    { "key": "script", "ar": "كتابة محتوى وإعلانات", "en": "Content & ad copywriting" },
    { "key": "ads", "ar": "إدارة إعلانات ممولة", "en": "Sponsored ads management" },
    { "key": "support", "ar": "دعم وحل مشاكل الحسابات", "en": "Account support & troubleshooting" },
    { "key": "translation", "ar": "ترجمة", "en": "Translation" },
    { "key": "dev", "ar": "تطوير مواقع وتطبيقات", "en": "Web & app development" },
    { "key": "marketing", "ar": "تسويق وإدارة حسابات", "en": "Marketing & account management" }
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
  "accents": { "gold": "#c9a227", "emerald": "#0e9f6e", "sapphire": "#2b5fd9", "ruby": "#c2255c", "violet": "#7048c9", "teal": "#1098ad", "copper": "#e8720c", "rose": "#d6336c" },
  "intl_currencies": ["USD", "EUR", "GBP", "EGP", "SAR", "AED", "KWD", "QAR", "BHD", "OMR", "JOD", "MAD", "DZD", "TND", "IQD", "LBP", "ILS", "LYD", "SDG", "YER", "SYP", "MRU", "TRY", "CAD", "AUD", "CHF", "CNY", "INR", "PKR", "BDT", "NGN", "KES", "ZAR", "BRL", "MXN", "RUB", "JPY", "KRW", "SEK", "NOK"]
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
/* المسار الدولي العام (قرار المستخدم 2026-11-23: الانطلاق مفتوح للجميع من
   أي دولة): أي دولة غير مدرجة في الـ١٩ تُسجَّل بالكود 'OTHER' مع اسم دولة
   نصي (users.country_name) وعملة يختارها المستخدم من قائمة ISO المدمجة
   (TAXONOMY.intl_currencies) وهاتف دولي عام بأي كود دولة. التعريف الاصطناعي
   التالي لا يدخل TAXONOMY.countries (تبقى الـ١٩ كما هي في الواجهة)، لكنه
   يُسجَّل في COUNTRY_MAP حتى تعمل كل المسارات المعتمدة على countryOf —
   وسيلة الدفع المعروضة له: وسيلة محلية/دولية يتفق عليها الطرفان داخل
   المحادثة الموثقة، والسفير يُعيَّن مع أول طلب فعلي كما هو مقرر. */
const OTHER_COUNTRY = { code: 'OTHER', ar: 'دولة أخرى', en: 'Other country', dial: '', currency: 'USD', curAr: '', curEn: '', payAr: 'وسيلة دفع محلية/دولية — تُتفق داخل محادثة الحجز', payEn: 'A local/international method — agreed inside the booking chat', nsn: null };
COUNTRY_MAP.OTHER = OTHER_COUNTRY;
const INTL_CURRENCIES = TAXONOMY.intl_currencies || [];
function isIntlCurrency(cur) { return INTL_CURRENCIES.includes(String(cur || '').toUpperCase()); }
/* تطبيع هاتف دولي عام: يقبل + أو 00 أو أرقاماً تبدأ بكود دولة، ويطلب
   ٧–١٥ رقماً إجمالاً (معيار E.164) — الصيغة القانونية: +<digits>. */
function normalizeIntlPhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (!d.startsWith('+')) d = '+' + d.replace(/\D/g, '');
  const digits = d.slice(1);
  if (!/^\d{7,15}$/.test(digits) || digits.startsWith('0')) return null;
  return '+' + digits;
}
function countryOf(code) {
  const c = COUNTRY_MAP[String(code || 'EG').toUpperCase()];
  return c || null;
}
function normalizePhoneForCountry(raw, code) {
  const c = countryOf(code);
  if (!c) return null;
  if (!c.nsn) return normalizeIntlPhone(raw); // المسار الدولي العام: أي كود دولة
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
  if (c.code === 'EG') return 'رقم موبايل مصري صحيح مطلوب (01xxxxxxxxx)';
  if (!c.nsn) return 'رقم هاتف دولي صحيح مطلوب بصيغة +كود الدولة ثم الرقم (مثال: +33612345678)';
  return `رقم هاتف صحيح مطلوب في ${c.ar} (مثال: +${c.dial}xxxxxxxxx)`;
}
/* نفس الرسالة بصياغة «هاتف» لمسار تعديل الملف (رسالته القائمة حرفياً لمصر). */
function profilePhoneError(code) {
  const c = countryOf(code) || COUNTRY_MAP.EG;
  if (c.code === 'EG') return 'رقم هاتف مصري صحيح مطلوب (01xxxxxxxxx)';
  if (!c.nsn) return 'رقم هاتف دولي صحيح مطلوب بصيغة +كود الدولة ثم الرقم (مثال: +33612345678)';
  return `رقم هاتف صحيح مطلوب في ${c.ar} (مثال: +${c.dial}xxxxxxxxx)`;
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
  // ترتيب السوق بدرجة الظهور (محرك الترتيب الصامت — حلّ محل الفرز الطبقي
  // القديم بقرار «محرك الترتيب والمطابقة» 2026-11-23): الدرجة تجمع التوثيق
  // وسرعة الرد ونسبة الإتمام واكتمال الملف والنشاط والنجم (أولوية مدفوعة
  // معلنة داخل الدرجة) ودفعة الصانع الجديد، مع عقوبة دوران عادل لظهور نفس
  // الاسم متكرراً لنفس المشاهِد في نفس المدينة/المجال خلال ٢٤ ساعة.
  const viewerKey = viewer ? `u${viewer.id}` : `ip:${guestFingerprint(req)}`;
  const scoreCtx = { city: city || '', niche: niche || '', viewerKey };
  const scored = await Promise.all(rows.map(async (u) => ({ u, v: await visibilityScore(u, scoreCtx) })));
  scored.sort((a, b) => (b.v.score - a.v.score) || (a.u.id - b.u.id));
  rows = scored.map((x) => x.u);
  const day = new Date().toISOString().slice(0, 10);
  for (const u of rows) {
    await db.prepare('INSERT INTO directory_impressions (talent_id,viewer_key,city,niche,day,hits) VALUES (?,?,?,?,?,1) ON CONFLICT(talent_id,viewer_key,city,niche,day) DO UPDATE SET hits=directory_impressions.hits+1')
      .run(u.id, viewerKey, city || '', niche || '', day);
  }
  res.json({ items: await Promise.all(rows.map(u => publicUser(u, viewer ? viewer.id : null))) });
});

app.get('/api/talent/:id', async (req, res) => {
  const u = await getUser(+req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  const viewer = await optionalViewer(req);
  const viewerId = viewer ? viewer.id : null;
  // ملف المؤسس مفتوح للجميع (قرار المالك — «فتح ملف المؤسس»): أي زائر أو
  // عضو يراه بحمولة publicUser العامة نفسها (مجردة من المدينة/الدولة/
  // العملة، وبلا سعر/شورتس/تواصل للمؤسس)، والمتابعة للمسجلين كالمعتاد.
  // الحجز عليه وبدء المراسلة إليه يبقيان مرفوضين في مساراتهما كما هما.
  if (viewerId !== u.id) await db.prepare('INSERT INTO profile_views (talent_id,viewer_id,created_at) VALUES (?,?,?)').run(u.id, viewerId, now());
  const reviews = await db.prepare(`SELECT r.*, COALESCE(u2.name, 'عميل') reviewer_name FROM reviews r LEFT JOIN users u2 ON u2.id=r.reviewer_id WHERE r.reviewee_id=? ORDER BY r.created_at DESC LIMIT 10`).all(u.id);
  res.json({
    user: await publicUser(u, viewerId),
    stats: await talentStats(u.id),
    badges: await computeBadges(u.id),
    reviews,
    // نماذج الشورتس المضمّنة (حد أقصى 3) — المؤسس بلا نماذج إطلاقاً بمواصفة المالك.
    shorts: u.is_platform_founder ? [] : await shortsOf(u.id),
    // التوسعة: باقات الأسعار + فيديوهات الشغل اليومية في الملف العام.
    packages: u.is_platform_founder ? [] : await packagesOf(u.id),
    daily_videos: u.is_platform_founder ? [] : await dailyVideosOf(u.id, 12),
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
    await db.prepare(`UPDATE users SET verified=1, verify_status='verified', verify_reason='', pioneer=?, boost_until=?, verified_at=? WHERE id=?`)
      .run(pioneer, now() + 7 * 24 * 3600 * 1000, now(), u.id);
    await notify(u.id, 'verification', 'مبروك! حسابك بقى «موثّق Deal»' + (pioneer ? ' وأنت «رائد المدينة» في مجالك' : ''), '');
    if (!wasVerified) await onReferralVerified(await getUser(u.id));
    return res.json({ status: 'verified', pioneer: !!pioneer });
  }
  const reason = !hasCode ? 'كود الملكية غير موجود في الصفحة' : 'اسم الحساب لا يطابق اسم التسجيل';
  await db.prepare(`UPDATE users SET verify_status='rejected', verify_url=?, verify_reason=? WHERE id=?`).run(url, reason, u.id);
  res.json({ status: 'rejected', reason });
});

/* ---------------- bookings (commission-first P2P) ---------------- */
/* حالة الطلب الصريحة بنظام Deal P2P — تُشتق من حالة الحجز والاحتجاز فقط،
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
/* إلغاء تلقائي نظيف بنظام Deal وبصرامته: مهلة الدفع ٣ ساعات حاسمة (حد Deal الأقصى — قرار المستخدم 2026-11-23) — بلا
   تمديد وبلا استثناءات. انتهاؤها بلا أي إعلان دفع → يُلغى الطلب في تلك الخطوة
   نهائياً ويُختم الالتزام «منتهياً» في السجل — لا مبلغ يتحرك إطلاقاً. أما لو
   وُجد إعلان دفع/مطالبة (الالتزام «مُدّعى» أو أبعد) فلا إلغاء تلقائياً أبداً:
   المسار تأكيد أو تحكيم. هذا الإلغاء ليس «تأكيداً تلقائياً» — لا يحرّك مبلغاً. */
const STEP_OBLIGATION_KIND = { awaiting_fee: 'booking_commission', awaiting_deposit: 'booking_deposit', awaiting_deposit2: 'booking_deposit', awaiting_rest: 'booking_final', proof_submitted: 'booking_final' };
async function sweepStepExpiry() {
  const rows = await db.prepare(`SELECT * FROM bookings WHERE status IN ('awaiting_fee','awaiting_deposit','awaiting_deposit2','awaiting_rest','proof_submitted')`).all();
  for (const b of rows) {
    const ob = await db.prepare('SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND is_difference=0 AND is_refund=0 ORDER BY id DESC LIMIT 1').get(STEP_OBLIGATION_KIND[b.status], b.id);
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
      /* إخلال مثبت آلياً (جولة الردع): عميل عضو قبل الاستلام ولم يدفع الباقي
         في مهلته = تجميد فوري + غرامة إخلال موثّقة، وفكّ التجميد بسداد الباقي
         والغرامة. العميل الضيف بلا حساب — يبقى المسار تحكيم المالك كما هو. */
      if (b.client_id) await establishBreach(b.client_id, await getBooking(b.id), 'باقٍ مستحق متأخر: قُبل الاستلام ولم يُدفع الباقي في مهلته (٣ ساعات)');
      await notify(b.talent_id, 'rest_overdue', `حجز #${b.id}: ⚠️ العميل قبل الاستلام وما دفعش الباقي في مهلته (٣ ساعات) — صار مستحقاً متأخراً عليه واتفتح للمالك ملف تحكيم`, `booking:${b.id}`);
      if (b.client_id) await notify(b.client_id, 'rest_overdue', `حجز #${b.id}: ⚠️ انتهت مهلة دفع الباقي بعد ما أكدت الاستلام — الباقي صار «مستحقاً متأخراً» بيأثر على نسبة إتمامك وبيعرضك لعقوبات. ادفع الباقي للمنفذ دلوقتي من صفحة الحجز فيرجع لمساره`, `booking:${b.id}`);
      await notifyOwner('rest_overdue', `حجز #${b.id}: ⚠️ باقٍ مستحق متأخر بعد قبول الاستلام — راجع «مستحقات قيد المتابعة» للتحكيم/العقوبات`, `booking:${b.id}`);
      continue;
    }
    await setObligationStatus(ob, 'expired', 'system', 'انتهت مهلة الدفع (٣ ساعات) بلا أي إعلان دفع — إلغاء تلقائي نهائي للطلب (نظام Deal)');
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
  view.protection_voided = !!b.protection_voided;
  view.appeal = appealView(await openAppealFor(b.id)); // طلب مراجعة إفراج قائم (نموذج Deal) أو null
  view.terms = await termsStateFor(b); // بوابة «شروط المعاملات»: قبول الطرفين قبل أول خطوة دفع
  if (viewer) view.terms.mine_accepted = viewer.id === b.client_id ? view.terms.client_accepted : viewer.id === b.talent_id ? view.terms.talent_accepted : false;
  view.events = await bookingEvents(b.id); // رسائل نظام محادثة الطلب
  /* الخط الزمني الموحّد (الجولة الأخيرة — ١٣أ): نفس مصفوفة الأحداث نفسها
     تُبنى مرة واحدة هنا وتُسلَّم للطرفين حرفياً — لا نسخة عميل ونسخة مقدم،
     فما يراه الطرفان في أي لحظة متطابق حدثاً بحدث. */
  view.timeline = view.events;
  /* قرار التحكيم المسبّب (١٣ب): آخر نزاع محسوم على هذا الحجز — سببه ومراجع
     أدلته ظاهرة للطرفين في عرض الحجز نفسه. */
  { const rd = await db.prepare(`SELECT decision_reason, evidence_refs, decided_by, resolved_at FROM disputes WHERE booking_id=? AND status='resolved' ORDER BY id DESC LIMIT 1`).get(b.id);
    view.arbitration = rd && rd.decision_reason ? { reason: rd.decision_reason, evidence_refs: (() => { try { return JSON.parse(rd.evidence_refs || '[]'); } catch (e) { return []; } })(), decided_by: rd.decided_by || null, decided_at: rd.resolved_at || 0 } : null; }
  view.official_report_available = viewer ? !!(await officialReportEligibility(b, viewer.id)) : false; // زر «تقرير أدلة رسمي» بعد ثبوت احتيال/إخلال
  /* نموذج التسليم (قرار المستخدم 2026-11-23): لا موعد تسليم منظّماً ولا عدّاد
     تسليم في Deal — التوقيت اتفاق بين الطرفين داخل محادثة الحجز (دليل تحكيم)،
     والاستعجال علامة «مستعجل» فقط. الحقول صفر دائماً توافقاً مع الواجهات القديمة. */
  view.delivery_due_at = 0; view.delivery_accepted = false;
  view.replacement_available = !!b.replacement_available; view.replacement_activated = !!b.replacement_activated;
  view.deemed_at = b.deemed_at || 0;
  view.tips = await tipsOf(b.id); // إكراميات الصفقة (التزامات tip في السجل — بلا عمولة)
  /* تصحيحات المراجعة: تقسيم العربون + سجل علني + سفير المدينة + الاتفاق المهيكل */
  { const am = bookingLegAmounts(b); view.deposit_split = am.split; view.dep1 = am.dep1; view.dep2 = am.dep2; }
  view.initial_proof_url = b.initial_proof_url || ''; view.initial_proof_at = b.initial_proof_at || 0; view.initial_confirmed_at = b.initial_confirmed_at || 0;
  view.talent_record = await talentRecordFor(b.talent_id);
  view.city_ambassador = await bookingCityAmbassador(b);
  view.agreement = agreementOf(b);
  const finOb = await finalObligation(b.id);
  view.final_obligation_status = finOb ? finOb.status : null; // حالة التزام الباقي لعرض زرار «وصلني»/التسليم في الواجهة
  /* ملخص التزام العمولة الآمن للطرف غير الدافع (إصلاح حي ٣): خطوة العمولة
     عند المنفّذ تُعرض بقراءة فقط من حمولة الحجز نفسها — حالة الالتزام
     ومهلته فقط. الكود ورقم التحويل والمبلغ بالبصمة بيانات الدافع حصراً
     (feeInfo للعميل وحده) ولا تخرج في هذا الملخص إطلاقاً. */
  const feeOb = await db.prepare(`SELECT status, expires_at FROM money_obligations WHERE kind='booking_commission' AND booking_id=? ORDER BY id DESC LIMIT 1`).get(b.id);
  view.fee_obligation = feeOb ? { status: feeOb.status, expires_at: feeOb.expires_at || 0 } : null;
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
/* ---------------- طلبات مراجعة الإفراج (نموذج Deal P2P) ----------------
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

/* ================= جولة «المحاذاة الحرفية مع Deal P2P» + الحزمة القانونية + Push =================
   كل ما يلي مبني فوق البنية القائمة حرفياً (نفس الجداول والسجل والعقوبات)
   وموثّق في TESTING-P2P-ALIGN.md. المسوحات الزمنية كلها lazy: تُستدعى من
   مسارات القراءة القائمة، وتجميعها runAllSweeps قابل للاستدعاء من cron خارجي
   لاحقاً عبر مسار المالك — فلا مؤقّتات خادم ولا عمليات خلفية. */

/* ---- أحداث النظام في محادثة الطلب (أسلوب Deal): انتقالات جوهرية مختومة
   بوقت الخادم، تظهر داخل محادثة الحجز وصفحة الضيف وتدخل حزمة الأدلة كما هي. */
async function addBookingEvent(bookingId, kind, body = '') {
  /* حدّ ٢٠٠٠ حرف (كان ٣٠٠ فيبتر رسائل النظام الطويلة — منها سلّم ردع
     التعامل الخارجي الذي يجب أن يصل كاملاً بقرار المراجعة الشاملة AU) */
  try { await db.prepare('INSERT INTO booking_events (booking_id,kind,body,created_at) VALUES (?,?,?,?)').run(bookingId, kind, String(body || '').slice(0, 2000), now()); }
  catch (e) { /* توثيق الحدث لا يعطّل الحركة نفسها أبداً */ }
}
async function bookingEvents(bookingId, limit = 100) {
  const rows = await db.prepare('SELECT id,kind,body,created_at FROM booking_events WHERE booking_id=? ORDER BY created_at ASC, id ASC LIMIT ?').all(bookingId, limit);
  return rows.map((e) => ({ id: e.id, sender: 'system', kind: e.kind, body: e.body, created_at: e.created_at }));
}

/* ---- «شروط المعاملات» (deal-tx-terms-v6): الوثيقة التي يقبلها الطرفان قبل
   أول خطوة دفع في أي حجز — قبول مسجّل خادمياً (من + متى + إصدار) ويدخل
   حزمة الأدلة. إصدار جديد يطلب قبولاً جديداً للحجوزات الجديدة فقط. */
const TX_TERMS = {
  version: TX_TERMS_VERSION,
  ar: [
    'مهلة الدفع ٣ ساعات لكل خطوة دفع، بعدّاد حي ظاهر — انتهاؤها بلا إعلان دفع يُلغي الطلب تلقائياً بلا أي حركة مال.',
    'زر «حوّلت» يُضغط فقط بعد خروج التحويل من محفظتك فعلياً — لا يمكن إلغاء الخطوة بعد إعلان الدفع، والإعلان الكاذب يدخل سلّماً صارماً: أول مرة تحذير مسجّل، والثانية تجميد الحساب، والثالثة حظر نهائي للشخص نفسه (هاتف + إيميل + بصمة جهاز — لا حساب جديد).',
    'حوّل من حساب/محفظة بنفس اسمك المسجل فقط — التحويل من حساب شخص آخر يوقف العملية ويعرّض حسابك للإيقاف.',
    'Deal لا تستلم ولا تحتجز أموال المعاملات بين الأطراف في أي مرحلة — كل التحويلات بين محافظ الطرفين مباشرة، وعمولة Deal واشتراكاتها فقط هي إيراد المنصة.',
    'الدفعة الأخيرة (الباقي) تتحوّل من العميل إلى المنفذ مباشرة بعد تأكيد استلام المعاينة أو اعتماد الاستلام بقاعدة السكوت أو قرار تحكيم — والنسخة النهائية من الشغل لا تُسلَّم إلا بعد تأكيد قبض الباقي.',
    'عدم دفع الباقي بعد تأكيد الاستلام يجعل الحجز «مستحقاً متأخراً» يضرب نسبة إتمام العميل ويفتح تحكيم المالك (عقوبات وحزمة أدلة).',
    'إن سكت العميل ٢٤ ساعة بعد وصول إثبات التنفيذ (المعاينة)، يُعتبَر الاستلام مؤكداً وتتفتح خطوة دفع الباقي — قاعدة Deal — مع تنبيهات متدرجة أثناء المهلة (عند وصول الإثبات، وفي منتصفها، وقبل انتهائها بساعة)، وللمالك حق عكس الاعتماد عند ثبوت احتيال أو خطأ. مهلة المعاينة ٢٤ ساعة وحدها؛ كل مهلات الدفع ٣ ساعات، وسكوت العميل بعد تسليم النسخة النهائية ٣ ساعات.',
    'التحكيم بنظام Deal: طور تفاوض ١٠ دقائق بين الطرفين أولاً، ثم حسم المالك من الأدلة — وقراره نهائي داخل المنصة ومسجّل.',
    'محادثة الطلب داخل Deal هي قناة الأدلة الوحيدة — أي اتفاق خارجها لا يُقبل دليلاً في التحكيم.',
    'المعاملات P2P: الفلوس تتحرك بين المحافظ الشخصية مباشرة، وDeal ينظّم ويوثّق ويحمي — Deal ليس بنكاً ولا جهة مالية.',
    'ضمان الاستبدال الصارم: يتفعّل فقط لو أعلن المنفذ عدم قدرته، أو سكت في محادثة الحجز ٢٤ ساعة بعد قبض العربون رغم تنبيهين آليين. Deal لا تفرض موعد تسليم ولا تدير عدّاد تسليم: توقيت التنفيذ اتفاق بين الطرفين داخل محادثة الحجز، وعلامة «مستعجل» اتفاقية بلا أي التزام زمني مفروض من المنصة، وأي خلاف على تأخير التسليم يُحسم تحكيماً بأدلة المحادثة. ترشّح Deal بديلاً واحداً موثّقاً من نفس المدينة والمجال بنفس السعر والشروط حرفياً خلال ٢٤ ساعة، ويقرر العميل القبول أو الرفض خلال ٣ ساعات؛ وإن لم يوجد بديل مناسب يُردّ العربون كاملاً بقرار تحكيم خلال ٧٢ ساعة. ردّ العربون إجباري على المنفذ المتخلّف خلال ٣ ساعات من قرار الاستبدال أو التحكيم، ولا استبدال أبداً بعد اعتماد المعاينة.',
    'الردع والقانون — للطرفين في كل الدول: (١) قبولك هذه الشروط قبول مسجّل بهويتك ووقته، وهو عقد إلكتروني ملزم يخضع لقانون الشروط الحاكم المنصوص عليه في شروط استخدام Deal، وسجلات Deal ومحادثات الحجز وإيصالاتها أدلّة موثّقة تُسلَّم للطرف المتضرر في حزمة أدلة رسمية عند ثبوت احتيال. (٢) عقوبات المنصة الداخلية تسرى على كل المستخدمين بالتساوي في أي دولة: أي التزام مالي يتجاوز مهلته يجمّد الحساب فوراً مع علامة «مستحقات متأخرة» في ملفه، وفكّ التجميد بسداد الالتزام وغرامة إخلال ١٠٪ من قيمة الصفقة (تتضاعف في الإخلال الثاني)، والاحتيال المثبت = حظر نهائي للشخص نفسه (هاتف + إيميل + بصمة جهاز). (٣) الاحتيال جريمة في قوانين كل دولة تعمل فيها المنصة، ومسؤولية المحتال كاملة بلا أي سقف. مثال موثّق من مصر — القانون الحاكم للمنصة: قبول الشروط عقد ملزم (المادة ١٤٧ من القانون المدني: العقد شريعة المتعاقدين)، وقبض العربون والاستيلاء عليه أو رفض ردّه عند الإخلال يدخل في نطاق خيانة الأمانة (المادة ٣٤١ عقوبات) والنصب (المادة ٣٣٦ عقوبات)، والاحتيال عبر الشبكات يغلّظه قانون مكافحة جرائم تقنية المعلومات ١٧٥ لسنة ٢٠١٨، وللمتضرر المطالبة بتعويض كامل (المادة ١٦٣ مدني).',
    'أي اتفاق خارج المنصة لا يتم، والمنصة غير ملزمة بيه — لا ضمان ولا تحكيم ولا تقييم ولا حزمة أدلة لأي اتفاق لم يُفتح ويُوثَّق كحجز داخل Deal. أي ترتيب جانبي (مكالمة أو محادثة خارجية أو اتفاق شفهي) لا يُستند إليه في أي تحكيم ولا يُلزم المنصة بشيء، ومحاولة نقل التعامل لخارج المنصة تُرصد في محادثة الحجز وتدخل سلّم العقوبات. خدمات Deal — الضمان والتحكيم وحزمة الأدلة والتقييمات ودعم النزاعات — متاحة فقط للصفقات المفتوحة والموثّقة داخل المنصة من أول خطوة؛ أي اتفاق خارجي لا يمنح أي حق في أي خدمة من خدمات المنصة، ومحاولة استخدام أي خدمة لتغطية اتفاق خارجي مخالفة تستوجب علامة سلوك وتصعيد العقوبة عند التكرار.',
  ],
  en: [
    'Every payment step has a 3-hour deadline with a live countdown — expiry with no payment declared cancels the order automatically, with no money moving at all.',
    'Tap "I transferred" only after the transfer has actually left your wallet — the step cannot be undone once declared, and a false declaration enters a strict ladder: first time a recorded warning, second time the account is frozen, third time a permanent ban of the person (phone + email + device fingerprint — no new account).',
    'Transfer only from an account/wallet in your own registered name — payment from someone else\u2019s account halts the process and risks suspending your account.',
    'Deal never receives or holds transaction money between the parties at any stage — all transfers move directly between the two parties\' wallets; only Deal\'s fee and subscriptions are platform revenue.',
    'The final instalment (the rest) moves from the client directly to the provider after preview receipt is confirmed, deemed confirmed by the silence rule, or decided by arbitration — and the final copy of the work is delivered only after receipt of the rest is confirmed.',
    'Not paying the rest after confirming receipt makes the booking an \'overdue rest\' that hurts the client\'s completion rate and opens owner arbitration (penalties and an evidence bundle).',
    'If the client stays silent for 24 hours after the execution proof (the preview) arrives, receipt is deemed confirmed and the rest-payment step opens — Deal\'s rule — with graduated reminders during the window (when the proof arrives, at its midpoint, and one hour before it ends), and the owner may reverse a deemed confirmation on proven fraud or error. The 24-hour window applies to the preview only; every payment deadline is 3 hours, and client silence after final-copy delivery is 3 hours.',
    'Arbitration follows Deal\'s own system: a 10-minute negotiation phase between the parties first, then the owner decides from the evidence — the decision is final inside the platform and recorded.',
    'The in-app order chat is the only evidence channel — agreements made outside it are not accepted as arbitration evidence.',
    'Transactions are P2P: money moves directly between personal wallets, and Deal organizes, documents and protects — Deal is not a bank or a financial institution.',
    'The strict replacement guarantee: it activates only if the provider declares inability, or the provider stays silent in the booking chat for a full 24 hours after receiving the deposit despite two automatic warnings. Deal imposes no delivery deadline and runs no delivery countdown: execution timing is agreed between the parties inside the booking chat, the \u201curgent\u201d marker is a mutual agreement with no platform-imposed time commitment, and any dispute over delivery delay is decided by arbitration on the chat evidence. Deal nominates exactly one verified alternative from the same city and niche at exactly the same price and terms within 24 hours, and the client decides to accept or refuse within 3 hours; if no suitable alternative exists, the deposit is refunded in full by an arbitration decision within 72 hours. Refunding the deposit is mandatory for the defaulting provider within 3 hours of the replacement or arbitration decision, and there is never a replacement after the preview has been confirmed.',
    'Deterrence and the law — for both parties, in every country: (1) Your acceptance of these terms is recorded with your identity and its time and is a binding electronic contract governed by the governing law stated in Deal\u2019s Terms of Use; Deal\u2019s records, booking chats and receipts are documented evidence handed to the harmed party in an official evidence bundle when fraud is proven. (2) The platform\u2019s internal penalties apply equally to every user in every country: any money obligation that passes its deadline freezes the account immediately with a \u201clate dues\u201d mark on the profile, unfreezing requires settling the obligation plus a breach penalty of 10% of the deal value (doubled on the second breach), and proven fraud means a permanent ban of the person (phone + email + device fingerprint). (3) Fraud is a crime under the laws of every country the platform operates in, and a fraudster\u2019s liability is full, with no cap. One documented example — Egypt, the platform\u2019s governing law: acceptance of the terms is a binding contract (Article 147 of the Civil Code: the contract is the law of the parties); taking a deposit and keeping it, or refusing to refund it on default, falls within breach of trust (Article 341 of the Penal Code) and fraud (Article 336 of the Penal Code); online fraud is aggravated by the Anti-IT-Crimes Law 175 of 2018; and the harmed party may claim full compensation (Article 163 of the Civil Code).',
    'Any agreement outside the platform does not happen, and the platform is not bound by it — no guarantee, no arbitration, no rating and no evidence bundle for any agreement that was not opened and documented as a booking inside Deal. Any side arrangement (a call, an external chat or a verbal deal) cannot be relied on in any arbitration and binds the platform to nothing, and attempting to move the dealing outside the platform is detected in the booking chat and enters the penalty ladder. Deal\u2019s services — the guarantee, arbitration, the evidence bundle, ratings and dispute support — are available only for deals opened and documented inside the platform from the very first step; an external agreement grants no right to any platform service, and attempting to use any service to cover an external agreement is a violation that earns a behavior flag and escalating penalties on repetition.',
  ],
};
/* إصدار شروط الحجز الفعّال: إصدار أول قبول مسجّل لهذا الحجز — فالحجوزات
   المفتوحة تُكمل على إصدارها حتى لو ارتفع إصدار الشروط العام بعدها
   («المفتوحة تكمل على إصدارها»)، والحجز بلا أي قبول بعدُ يخضع للإصدار
   الحالي. مصدر واحد للحالة والقبول والبوابة فلا تتناقض أبداً. */
async function bookingTermsVersion(b) {
  const r = await db.prepare('SELECT version FROM booking_terms_acceptances WHERE booking_id=? ORDER BY accepted_at ASC, id ASC LIMIT 1').get(b.id);
  return (r && r.version) || TX_TERMS_VERSION;
}
async function termsStateFor(b) {
  const ver = await bookingTermsVersion(b);
  const rows = await db.prepare('SELECT side, user_id, accepted_at FROM booking_terms_acceptances WHERE booking_id=? AND version=?').all(b.id, ver);
  const by = {};
  for (const r of rows) by[r.side] = r;
  return {
    version: ver,
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
    .run(b.id, side, userId ?? null, guestToken || '', await bookingTermsVersion(b), now());
  return await termsStateFor(b);
}

/* ---- قاعدة «سكوت العميل = استلام مُعتبَر» (قرار المستخدم الصريح 2026-11-23:
   مهلة المعاينة ٢٤ ساعة): إثبات سليم + سكوت كامل ٢٤ ساعة من وقت الإثبات بلا
   تأكيد ولا نزاع = اعتماد استلام تلقائي يفتح خطوة دفع الباقي للمنفذ مباشرة
   (لا مال يتحرك عند المنصة أصلاً — النموذج بلا احتجاز). تنبيهات متدرجة أثناء
   المهلة: عند الإثبات، وفي منتصفها (١٢ ساعة)، وقبل انتهائها بساعة. تفاعل
   العميل يوقف القاعدة: ملاحظة تحكيم/رسالة محادثة بعد الإثبات أو تحكيم مفتوح
   = العميل ليس ساكتاً فالمسار هو التحكيم وقرار المالك. للمالك حق العكس من
   لوحته (مسار مستقل). */
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
    if (ob) await moneyLedger(ob.id, ob.status, ob.status, 'system', 'اعتماد استلام مُعتبَر بقاعدة Deal: سكوت العميل ٢٤ ساعة بعد إثبات سليم — اتفتحت خطوة دفع الباقي للمنفذ مباشرة (للمالك حق العكس عند ثبوت احتيال/خطأ)');
    await addBookingEvent(b.id, 'deemed_confirmed', 'يُعتبَر استلام المعاينة مؤكداً بقاعدة سكوت ٢٤ ساعة (نظام Deal) — اتفتحت خطوة دفع الباقي للمنفذ');
    await notify(b.talent_id, 'deemed', `حجز #${b.id}: ⏱️ سكت العميل ٢٤ ساعة بعد إثباتك — يُعتبَر الاستلام مؤكداً بقاعدة Deal، واتفتحت خطوة دفع الباقي لك مباشرة`, `booking:${b.id}`);
    if (b.client_id) await notify(b.client_id, 'deemed', `حجز #${b.id}: ⏱️ لم تؤكد الاستلام خلال ٢٤ ساعة من وصول الشغل — اعتُبر الاستلام مؤكداً بقاعدة Deal واتفتحت خطوة دفع الباقي للمنفذ (مهلتها ٣ ساعات)`, `booking:${b.id}`);
    await notifyOwner('deemed', `حجز #${b.id}: ⏱️ اعتماد استلام مُعتبَر بقاعدة سكوت ٢٤ ساعة — اتفتحت خطوة الباقي (تستطيع عكس الاعتماد من لوحتك عند ثبوت خطأ/احتيال)`, `booking:${b.id}`);
    fired++;
  }
  return fired;
}

/* ---- اكتمال مُعتبَر: سكوت العميل ٣ ساعات بعد تسليم النسخة النهائية = تأكيد
   استلامها ضمنياً فيكتمل الحجز (القبض مؤكد قبلها أصلاً بشرط الاكتمال). */
async function sweepFinalDeemed() {
  const rows = await db.prepare(`SELECT * FROM bookings WHERE status='final_delivered' AND final_delivered_at>0 AND final_delivered_at<=?`).all(now() - FINAL_DEEMED_AFTER_MS);
  let n = 0;
  for (const b of rows) {
    if (await db.prepare('SELECT id FROM disputes WHERE booking_id=? AND status=? LIMIT 1').get(b.id, 'open')) continue;
    await db.prepare(`UPDATE bookings SET final_confirmed_at=?, final_auto=1 WHERE id=?`).run(now(), b.id);
    await addBookingEvent(b.id, 'final_deemed', 'سكت العميل ٣ ساعات بعد تسليم النسخة النهائية — يُعتبَر استلامها مؤكداً واكتملت الصفقة');
    await notify(b.talent_id, 'deemed', `حجز #${b.id}: ⏱️ سكت العميل ٣ ساعات بعد تسليم النسخة النهائية — اعتُبر استلامها مؤكداً واكتملت الصفقة`, `booking:${b.id}`);
    if (b.client_id) await notify(b.client_id, 'deemed', `حجز #${b.id}: ⏱️ لم تؤكد استلام النسخة النهائية خلال ٣ ساعات من تسليمها — اعتُبر الاستلام مؤكداً بقاعدة Deal واكتملت الصفقة`, `booking:${b.id}`);
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

/* ---- تنبيه بواقٍ عالقة (تحوّل تنبيه Deal ١٥ دقيقة للنموذج المباشر): باقٍ
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
   دقيقة إشعار للدافع العضو (الضيف يرى العدّاد الحي في صفحته)، وتنبيهات
   متدرجة لمهلة المعاينة (٢٤ ساعة): تنبيه عند تقديم الإثبات نفسه، وتنبيه في
   منتصف المهلة (١٢ ساعة)، وتحذير أخير قبل الاعتماد المُعتبَر بـ٦٠ دقيقة.
   علم لكل التزام/حجز ولكل مرحلة تنبيه فلا تكرار. */
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
  const rows = await db.prepare(`SELECT * FROM bookings WHERE status='proof_submitted' AND receipt_confirmed_at=0 AND proof_check='verified' AND proof_at>0 AND (deemed_warn_sent=0 OR deemed_mid_warn_sent=0)`).all();
  for (const b of rows) {
    const base = await deemedBaseAt(b);
    if (!base) continue;
    if (await deemedBlocked(b)) continue;
    const due = base + DEEMED_AFTER_MS;
    /* تنبيه منتصف المهلة (١٢ ساعة من الإثبات): تذكير هادئ أن نصف مهلة
       المعاينة فات — بلا أي لهجة تحذير أخير. */
    if (!b.deemed_mid_warn_sent && now() >= base + DEEMED_AFTER_MS / 2 && now() < due) {
      await db.prepare('UPDATE bookings SET deemed_mid_warn_sent=1 WHERE id=?').run(b.id);
      if (b.client_id) {
        await notify(b.client_id, 'deemed_warn', `حجز #${b.id}: ⏰ فات نصف مهلة تأكيد المعاينة (١٢ ساعة من ٢٤) — الشغل وصلك من المنفذ، أكّد الاستلام أو افتح نزاعاً من صفحة الحجز قبل ما تخلص المهلة فيُعتبَر الاستلام مؤكداً بقاعدة Deal`, `booking:${b.id}`);
        sent++;
      }
    }
    /* التحذير الأخير: قبل الاعتماد المُعتبَر بـ٦٠ دقيقة. */
    if (!b.deemed_warn_sent && now() >= due - WARN_BEFORE_MS && now() < due) {
      await db.prepare('UPDATE bookings SET deemed_warn_sent=1 WHERE id=?').run(b.id);
      if (b.client_id) {
        await notify(b.client_id, 'deemed_warn', `حجز #${b.id}: ⚠️ تحذير أخير — لو ما ردّيتش خلال ساعة (تأكيد استلام أو نزاع) هيُعتبَر استلام المعاينة مؤكداً تلقائياً بقاعدة Deal وهتتفتح خطوة دفع الباقي للمنفذ`, `booking:${b.id}`);
        sent++;
      }
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
  try { out.dues_enforcement = await sweepDuesEnforcement(); } catch (e) { out.dues_enforcement = -1; }
  try { out.weekly_summary = await sweepWeeklySummaries(); } catch (e) { out.weekly_summary = -1; }
  try { out.request_rescue = await sweepRequestRescue(); } catch (e) { out.request_rescue = -1; }
  try { out.due_pushes = await sweepDuePushes(); } catch (e) { out.due_pushes = -1; }
  try { out.waitlist = await sweepWaitlist(); } catch (e) { out.waitlist = -1; }
  try { out.contracts = await sweepContracts(); } catch (e) { out.contracts = -1; }
  try { out.challenge = await sweepChallenge() ? 1 : 0; } catch (e) { out.challenge = -1; }
  try { out.academy_reminders = await sweepAcademyReminders(); } catch (e) { out.academy_reminders = -1; }
  try { out.churn_prevention = await sweepChurnPrevention(); } catch (e) { out.churn_prevention = -1; }
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

/* ================= الردع بحكم القانون + ضمان الاستبدال الصارم =================
   (قرار المستخدم المعتمَد 2026-11-23 — TESTING-DETERRENCE-APPLY.md، والنص
   الملزم في deal-deterrence-and-replacement-rules.md.) كل الآليات فوق البنية
   القائمة نفسها: الالتزامات المالية الموثّقة (DL)، السجل، أعلام السلوك،
   التجميد/الحظر — لا نظام موازٍ. */

/* ---- بصمات أجهزة الأعضاء: تُسجَّل عند التسجيل والدخول الناجح حين يرسل
   العميل معرّف جهاز (نفس بصمة مكافحة إساءة الضيوف)، لتُنسخ إلى قائمة حظر
   الشخص عند الحظر النهائي. بلا معرّف جهاز في الطلب لا تسجيل ولا فحص جهاز. */
async function recordUserFingerprint(userId, req) {
  try {
    const device = String(((req && req.body) || {}).device_id || '').trim();
    if (!userId || !device) return;
    const fp = guestFingerprint(req);
    await db.prepare('INSERT INTO user_fingerprints (user_id,fp,last_seen) VALUES (?,?,?) ON CONFLICT(user_id,fp) DO UPDATE SET last_seen=excluded.last_seen')
      .run(userId, fp, now());
  } catch (e) { /* البصمة آلية ردع إضافية — لا تعطّل دخولاً ولا تسجيلاً أبداً */ }
}

/* ---- قائمة حظر الشخص: هاتف/إيميل/بصمة جهاز. الفحص عند التسجيل والدخول. */
async function blocklistRow(kind, value) {
  if (!value) return null;
  return await db.prepare('SELECT * FROM person_blocklist WHERE kind=? AND value=?').get(kind, String(value)) || null;
}
async function personBlockHit({ contact = '', phone = '', req = null } = {}) {
  const c = String(contact || '');
  if (c) {
    const hit = await blocklistRow(c.includes('@') ? 'email' : 'phone', c);
    if (hit) return hit;
  }
  const p = String(phone || '');
  if (p && p !== c) {
    const hit = await blocklistRow('phone', p);
    if (hit) return hit;
  }
  const device = String(((req && req.body) || {}).device_id || '').trim();
  if (req && device) {
    const hit = await blocklistRow('device', guestFingerprint(req));
    if (hit) return hit;
  }
  return null;
}
const PERSON_BANNED_ERROR = 'هذا الشخص محظور نهائياً من Deal بسبب احتيال أو إخلال مثبت — الحظر للشخص نفسه (هاتف + إيميل + جهاز) فلا يمكن إنشاء حساب جديد ولا الدخول بأي وسيلة تواصل أخرى';
/* حظر نهائي للشخص: يُعلَّم الحساب محظوراً ومجمّداً، تُقطع جلساته، وتُنسخ
   وسائل هويته المعروفة (التواصل + الهاتف + كل بصمات أجهزته المسجّلة) إلى
   قائمة الحظر الدائمة. يُستدعى من: سلّم «حوّلت» الكاذبة (الثالثة)، الإخلال
   الثالث، وقرار المالك اليدوي بالحظر من لوحته. */
async function banPerson(userId, reason = '', byUserId = null) {
  const u = await getUser(userId);
  if (!u) return false;
  await db.prepare('UPDATE users SET banned=1, frozen=1 WHERE id=?').run(userId);
  const add = async (kind, value) => {
    if (!value) return;
    await db.prepare('INSERT INTO person_blocklist (kind,value,user_id,reason,created_by,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(kind,value) DO NOTHING')
      .run(kind, String(value), userId, String(reason || '').slice(0, 200), byUserId ?? null, now());
  };
  await add(u.contact && u.contact.includes('@') ? 'email' : 'phone', u.contact);
  if (u.phone && u.phone !== u.contact) await add('phone', u.phone);
  const fps = await db.prepare('SELECT fp FROM user_fingerprints WHERE user_id=?').all(userId);
  for (const r of fps) await add('device', r.fp);
  await db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  await notifyOwner('penalty', `⛔ حظر نهائي للشخص: المستخدم #${userId} (${u.name}) — ${String(reason || 'قرار موثّق').slice(0, 120)}`, `user:${userId}`);
  return true;
}

/* ---- المستحقات المتجاوزة والتجميد الآلي: الالتزام الأصلي المفتوح على العضو
   (غرامة إخلال لم تُسدَّد، باقٍ في حالة «مستحق متأخر»، أو ردّ عربون مقرّر
   تحكيمياً لم يُنفَّذ). فكّ التجميد الآلي مشروط بانعدامها كلها. */
async function openDuesFor(userId) {
  const dues = [];
  const pens = await db.prepare(`SELECT id, code, booking_id FROM money_obligations WHERE kind='breach_penalty' AND payer_user_id=? AND status IN ('open','claimed')`).all(userId);
  for (const p of pens) dues.push({ type: 'breach_penalty', obligation_id: p.id, code: p.code, booking_id: p.booking_id });
  const refunds = await db.prepare(`SELECT id, code, booking_id FROM money_obligations WHERE kind='booking_deposit' AND is_refund=1 AND payer_user_id=? AND status IN ('open','claimed')`).all(userId);
  for (const p of refunds) dues.push({ type: 'deposit_refund', obligation_id: p.id, code: p.code, booking_id: p.booking_id });
  const overdue = await db.prepare(`SELECT id FROM bookings WHERE client_id=? AND status='rest_overdue'`).all(userId);
  for (const b of overdue) dues.push({ type: 'rest_overdue', booking_id: b.id });
  return dues;
}
async function freezeForDues(userId, reason = '') {
  const u = await getUser(userId);
  if (!u || u.banned) return false;
  if (u.dues_frozen && u.frozen) return false;
  await db.prepare('UPDATE users SET dues_frozen=1, frozen=1 WHERE id=?').run(userId);
  await notify(userId, 'penalty', `🧊 جمّدت المنصة حسابك آلياً: عندك مستحقات متأخرة موثّقة (${String(reason || 'التزام مالي تجاوز مهلته').slice(0, 120)}) — لا حجوزات ولا طلبات جديدة لحد ما تسدّد الالتزام الأصلي وغرامة الإخلال بإثبات داخل المنصة، وبيظهر في ملفك العام وسم «مستحقات متأخرة»`, '');
  await notifyOwner('penalty', `🧊 تجميد آلي لمستحقات متأخرة: المستخدم #${userId} — ${String(reason || '').slice(0, 120)}`, `user:${userId}`);
  return true;
}
/* فكّ التجميد الآلي: فقط إن كان التجميد تجميدَ مستحقات (dues_frozen) ولم يبقَ
   أي مستحق مفتوح ولا عقوبة تعليق قائمة — تجميد المالك اليدوي وتجميد سلّم
   العقوبات لا يمسّهما هذا المسار أبداً. */
async function maybeUnfreezeDues(userId) {
  const u = await getUser(userId);
  if (!u || !u.dues_frozen || u.banned) return false;
  if (u.penalty_level === 'suspended') return false;
  if ((await openDuesFor(userId)).length) return false;
  await db.prepare('UPDATE users SET dues_frozen=0, frozen=0 WHERE id=?').run(userId);
  await notify(userId, 'penalty', '✅ اتفكّ تجميد حسابك: سدّدت كل مستحقاتك الموثّقة — حسابك رجع يشتغل بالكامل', '');
  await notifyOwner('penalty', `✅ فكّ تجميد آلي: المستخدم #${userId} سدّد كل مستحقاته الموثّقة`, `user:${userId}`);
  return true;
}

/* ---- غرامة الإخلال: التزام مالي موثّق (DL) لصالح Deal = ١٠٪ من قيمة
   الصفقة، يتضاعف في الإخلال الثاني، والإخلال الثالث حظر نهائي للشخص.
   تُنشأ عند تثبيت إخلال: تجميد آلي (باقٍ متأخر) أو قرار تحكيم موثّق. */
async function establishedBreachCount(userId) {
  return (await db.prepare(`SELECT COUNT(*) c FROM money_obligations WHERE kind='breach_penalty' AND payer_user_id=? AND status<>'revoked'`).get(userId)).c;
}
async function createBreachPenalty(userId, booking, reason = '') {
  if (!userId || !booking) return null;
  const dup = await db.prepare(`SELECT * FROM money_obligations WHERE kind='breach_penalty' AND payer_user_id=? AND booking_id=? AND status IN ('open','claimed') LIMIT 1`).get(userId, booking.id);
  if (dup) return dup;
  const prior = await establishedBreachCount(userId);
  const mult = prior >= 1 ? 2 : 1;
  const base = mround((booking.price || 0) * 0.10 * mult);
  if (base <= 0) return null;
  const ob = await createObligation({
    kind: 'breach_penalty', booking_id: booking.id, user_id: userId, base_amount: base,
    currency: booking.currency || 'EGP', payer_user_id: userId, payee: 'owner',
  });
  // الغرامة ليست خطوة دفع بمهلة ٣ ساعات: أجلها الطويل يبقيها «مفتوحة» لحد
  // السداد أو قرار تحكيم — فلا تنتهي صلاحيتها كخطوات الحجز.
  await db.prepare('UPDATE money_obligations SET expires_at=? WHERE id=?').run(now() + 365 * 24 * 3600 * 1000, ob.id);
  await moneyLedger(ob.id, 'open', 'open', 'system', `غرامة إخلال موثّقة (${mult === 2 ? 'مضاعفة — إخلال ثانٍ' : '١٠٪ من قيمة الصفقة'}): ${String(reason || '').slice(0, 160)}`);
  await notify(userId, 'penalty', `⚖️ سُجّلت عليك غرامة إخلال ${base} ${ob.currency} لصالح Deal (المعاملة ${ob.code}) — ${String(reason || '').slice(0, 120)}. فكّ تجميد حسابك مشروط بسداد الالتزام الأصلي والغرامة بإثبات داخل المنصة`, booking ? `booking:${booking.id}` : '');
  await notifyOwner('penalty', `⚖️ غرامة إخلال جديدة ${ob.code}: ${base} ${ob.currency} على المستخدم #${userId} (حجز #${booking.id}) — ${String(reason || '').slice(0, 100)}`, `money:${ob.code}`);
  if (prior + 1 >= 3) await banPerson(userId, 'الإخلال الثالث المثبت — حظر نهائي للشخص بقواعد الردع المعتمدة', null);
  return await getObligation(ob.id);
}
/* تثبيت إخلال كامل: تجميد آلي + غرامة (تُستخدم من المسح وقرارات التحكيم). */
async function establishBreach(userId, booking, reason = '') {
  if (!userId || !booking) return null;
  await freezeForDues(userId, reason);
  return await createBreachPenalty(userId, booking, reason);
}

/* ---- ردّ العربون المقرّر تحكيمياً: التزام موثّق باتجاه عكسي (المنفذ →
   العميل) بمهلة ٣ ساعات من القرار (قاعدة الاستبدال المعتمدة)، مميَّز بعلم
   is_refund حتى لا يلتبس بالتزام العربون الأصلي في أي بحث بالحجز. تأكيده
   بنفس آلية الإيصالات/قرار المالك القائمة (المستلم = العميل برقمه المسجل). */
async function createDepositRefundObligation(booking, reason = '') {
  if (!booking || !booking.client_id) return null; // عميل ضيف: الردّ يُتابَع من «مستحقات قيد المتابعة» بلا التزام آلي (لا حساب له)
  const amounts = bookingLegAmounts(booking);
  const dup = await db.prepare(`SELECT * FROM money_obligations WHERE kind='booking_deposit' AND is_refund=1 AND booking_id=? AND status IN ('open','claimed') LIMIT 1`).get(booking.id);
  if (dup) return dup;
  const ob = await createObligation({
    kind: 'booking_deposit', booking_id: booking.id, user_id: booking.client_id, base_amount: amounts.deposit,
    currency: booking.currency || 'EGP', payer_user_id: booking.talent_id,
    payee: `user:${booking.client_id}`, payee_user_id: booking.client_id,
  });
  await db.prepare('UPDATE money_obligations SET is_refund=1 WHERE id=?').run(ob.id);
  await moneyLedger(ob.id, 'open', 'open', 'owner', `التزام ردّ عربون مقرّر تحكيمياً: المنفذ يردّ ${amounts.deposit} ${ob.currency} للعميل مباشرة خلال ٣ ساعات من القرار — ${String(reason || '').slice(0, 140)}`);
  await notify(booking.talent_id, 'penalty', `⚖️ قرار تحكيم على حجز #${booking.id}: ردّ العربون ${amounts.deposit} ${ob.currency} للعميل خلال ٣ ساعات (المعاملة ${ob.code}) — التأخير تجميد وغرامة إخلال بقواعد الردع`, `booking:${booking.id}`);
  if (booking.client_id) await notify(booking.client_id, 'booking', `حجز #${booking.id}: ⚖️ تقرّر ردّ عربونك ${amounts.deposit} ${ob.currency} من المنفذ خلال ٣ ساعات — أكّد القبض من صفحة الحجز عند وصوله`, `booking:${booking.id}`);
  return await getObligation(ob.id);
}

/* ---- مسح إنفاذ المستحقات (يُدمج في runAllSweeps): ردّ عربون مقرّر تجاوز
   مهلته (٣ ساعات) بلا سداد = إخلال مثبت على المنفذ (تجميد + غرامة). الالتزام
   يبقى مفتوحاً (تُصفَّر مهلته فلا يُعاد تفعيل الإخلال) لحد السداد الفعلي. */
async function sweepDuesEnforcement() {
  let fired = 0;
  const refunds = await db.prepare(`SELECT * FROM money_obligations WHERE kind='booking_deposit' AND is_refund=1 AND status IN ('open','claimed') AND expires_at>0 AND expires_at<=?`).all(now());
  for (const ob of refunds) {
    const b = await getBooking(ob.booking_id);
    await db.prepare('UPDATE money_obligations SET expires_at=0 WHERE id=?').run(ob.id);
    await moneyLedger(ob.id, ob.status, ob.status, 'system', 'تجاوزت مهلة ردّ العربون المقرّر (٣ ساعات) بلا سداد — إخلال مثبت: تجميد وغرامة بقواعد الردع، والالتزام يبقى مفتوحاً لحد السداد');
    if (b) {
      await addBookingEvent(b.id, 'refund_overdue', 'تجاوز المنفذ مهلة ردّ العربون المقرّر تحكيمياً (٣ ساعات) — إخلال مثبت: تجميد آلي وغرامة إخلال');
      await establishBreach(ob.payer_user_id, b, 'تأخير ردّ عربون مقرّر تحكيمياً عن مهلته (٣ ساعات)');
    }
    fired++;
  }
  // فكّ تجميد من سدّد كل مستحقاته (فحص دوري آمن — maybeUnfreezeDues مشروطة).
  const frozen = await db.prepare('SELECT id FROM users WHERE dues_frozen=1 AND banned=0').all();
  for (const u of frozen) { if (await maybeUnfreezeDues(u.id)) fired++; }
  return fired;
}

/* ---- كشف تسرّب التعامل خارج المنصة في محادثات الحجز (قاعدة المستخدم
   المعتمدة 2026-11-23): أرقام هواتف (محلية/دولية)، روابط خارجية، ودعوات
   تواصل خارجي. الرصد لا يحذف الرسالة أبداً: رسالة نظام فورية بنص القاعدة +
   علامة سلوك على المرسل العضو (تدخل سلّم أعلام السلوك القائم) + توثيق في
   أحداث الحجز (سجل الأدلة). أرقام الطلبات والمبالغ القصيرة لا تُرصد: الهاتف
   يُشترط فيه طول وبادئة هاتفية حقيقية بعد تجريد الفواصل. */
const OFF_PLATFORM_RULE_TEXT = 'أي اتفاق خارج المنصة لا يتم، والمنصة غير ملزمة بيه — لا ضمان ولا تحكيم ولا تقييم ولا حزمة أدلة لأي اتفاق لم يُفتح ويُوثَّق كحجز داخل Deal';
/* سلّم ردع التعامل الخارجي الكامل (قرار المستخدم 2026-11-23 «تشديد الردع
   اللحظي»): نفس النص يظهر في تحذير ما قبل الإرسال بالواجهة وفي رسالة
   النظام بعد الإرسال هنا — مصدر واحد للصياغة فلا يتناقض الموضعان. */
const OFF_PLATFORM_LADDER_TEXT = 'العقوبات: المحاولة تُسجَّل في سجل أدلة الحجز وتُحسَب علامة سلوك على مرسلها — التكرار يجمّد الحساب، والإصرار حظر نهائي للشخص نفسه (هاتف + إيميل + بصمة جهاز — لا حساب جديد أبداً). وأي اتفاق يتم خارج المنصة لا حماية له إطلاقاً: لا ضمان ولا تحكيم ولا تقييم ولا حزمة أدلة ولا أي خدمة من خدمات Deal';
const OFF_PLATFORM_KEYWORDS = ['واتساب', 'واتس اب', 'whatsapp', 'wa.me', 'تيليجرام', 'telegram', 't.me', 'بره المنصة', 'برا المنصة', 'خارج المنصة', 'بره التطبيق', 'نتعامل بره', 'كلمني على رقمي', 'ده رقمي', 'دا رقمي', 'ابعتلي رقمك', 'هات رقمك'];
function detectOffPlatformLeak(text) {
  const s = String(text || '');
  if (/https?:\/\//i.test(s) || /wa\.me\//i.test(s) || /t\.me\//i.test(s) || /\b[a-z0-9-]+\.(com|net|org|io|me|co|app|xyz|info)\b/i.test(s)) return 'link';
  const low = s.toLowerCase();
  for (const k of OFF_PLATFORM_KEYWORDS) if (low.includes(k)) return 'keyword';
  const digits = s.replace(/[\s\-()]/g, '');
  const m = /\+?\d{10,15}/.exec(digits);
  if (m) {
    const d = m[0];
    if (/^\+?201[0-9]{9}$/.test(d) || /^01[0-9]{9}$/.test(d) || /^\+[0-9]{11,15}$/.test(d) || /^00[0-9]{11,15}$/.test(d)) return 'phone';
  }
  return null;
}
async function enforceOffPlatformLeak(booking, senderUserId, leakKind) {
  await addBookingEvent(booking.id, 'off_platform_warning', `⚠️ رُصدت محاولة تعامل خارج المنصة في المحادثة (${leakKind === 'phone' ? 'رقم هاتف' : leakKind === 'link' ? 'رابط خارجي' : 'دعوة تواصل خارجي'}): ${OFF_PLATFORM_RULE_TEXT}. ${OFF_PLATFORM_LADDER_TEXT}`);
  if (senderUserId) {
    await db.prepare('INSERT INTO behavior_flags (booking_id,user_id,kind,created_by,created_at) VALUES (?,?,?,?,?)')
      .run(booking.id, senderUserId, 'off_platform', null, now());
    await applyBehaviorPenalty(senderUserId);
    await notify(senderUserId, 'penalty', `⚠️ تنبيه من Deal على حجز #${booking.id}: رُصدت محاولة تعامل خارج المنصة في المحادثة — ${OFF_PLATFORM_RULE_TEXT}. ${OFF_PLATFORM_LADDER_TEXT}`, `booking:${booking.id}`);
  }
  await notifyOwner('penalty', `🚩 رصد تسرّب خارج المنصة في محادثة حجز #${booking.id} (${leakKind})${senderUserId ? ` — المرسل عضو #${senderUserId} واتسجّلت عليه علامة سلوك` : ' — المرسل ضيف (تحذير وتوثيق فقط)'}`, `booking:${booking.id}`);
}


/* =====================================================================
   باقة المزايا العشر + محرك الترتيب والمطابقة الصامت (2026-11-23):
   سرعة الرد، اطلب تاني، ملخص أسبوعي، تصدير الصفقات، موعد تسليم منظّم
   ومسار استبدال آلي، رسائل صوتية، قوالب رد سريعة، درجة ظهور ومطابقة
   طلبات وتوقيت إشعارات بنافذة نشاط المستخدم وإنقاذ الطلبات.
   ===================================================================== */

/* ---- توقيت الإشعارات: نافذة النشاط المعتادة لكل مستخدم ---- */
const COUNTRY_UTC_OFFSET = { EG: 2, SA: 3, AE: 4, KW: 3, QA: 3, JO: 3, MA: 1, BH: 3, OM: 4, IQ: 3, DZ: 1, TN: 1, LB: 3, PS: 3, LY: 2, SD: 2, YE: 3, SY: 3, MR: 0 };
const activityThrottle = new Map();
async function recordActivity(userId) {
  if (!userId) return;
  const last = activityThrottle.get(userId) || 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  activityThrottle.set(userId, Date.now());
  try {
    const u = await getUser(userId);
    if (!u) return;
    const off = COUNTRY_UTC_OFFSET[u.country || 'EG'] ?? 2;
    const hour = new Date(Date.now() + off * 3600 * 1000).getUTCHours();
    await db.prepare('INSERT INTO user_activity_hours (user_id,hour,hits) VALUES (?,?,1) ON CONFLICT(user_id,hour) DO UPDATE SET hits=user_activity_hours.hits+1').run(userId, hour);
  } catch (e) { /* تتبّع النشاط لا يعطّل أي طلب أبداً */ }
}
async function peakHourFor(u) {
  const row = await db.prepare('SELECT hour FROM user_activity_hours WHERE user_id=? ORDER BY hits DESC, hour ASC LIMIT 1').get(u.id);
  return row ? row.hour : 19; // افتراضياً مساءً بتوقيت دولة المستخدم
}
async function deliverAfterFor(userId) {
  const u = await getUser(userId);
  if (!u) return 0;
  const off = COUNTRY_UTC_OFFSET[u.country || 'EG'] ?? 2;
  const peak = await peakHourFor(u);
  const localNow = new Date(Date.now() + off * 3600 * 1000);
  const candidateLocal = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), peak, 0, 0);
  let candidateUtc = candidateLocal - off * 3600 * 1000;
  if (candidateUtc <= Date.now()) candidateUtc += 24 * 3600 * 1000;
  return candidateUtc;
}
/* إشعار مؤجَّل لنافذة النشاط (فرص + ملخصات): يُحفظ الآن ويظهر في الجرس
   ويُدفع Push عند حلول النافذة — وبلا تكرار لنفس المرجع ما دام غير مقروء. */
async function notifyDeferred(userId, type, text, ref = '') {
  if (!userId) return;
  const dup = await db.prepare('SELECT id FROM notifications WHERE user_id=? AND type=? AND ref=? AND is_read=0 LIMIT 1').get(userId, type, ref);
  if (dup) return;
  const deliverAfter = await deliverAfterFor(userId);
  await db.prepare('INSERT INTO notifications (user_id,type,text,ref,created_at,deliver_after,pushed) VALUES (?,?,?,?,?,?,0)')
    .run(userId, type, text, ref, now(), deliverAfter);
}
async function sweepDuePushes() {
  const rows = await db.prepare('SELECT * FROM notifications WHERE deliver_after>0 AND deliver_after<=? AND pushed=0 LIMIT 100').all(now());
  let sent = 0;
  for (const n of rows) {
    try { await pushMirror(n.user_id, n.type, n.text, n.ref); } catch (e) { /* Push اختياري */ }
    await db.prepare('UPDATE notifications SET pushed=1 WHERE id=?').run(n.id);
    sent++;
  }
  return sent;
}

/* ---- شارة سرعة الرد: وسيط أزمنة الرد الفعلية في محادثات الحجوزات ---- */
async function replySpeedFor(userId) {
  const rows = await db.prepare(`SELECT booking_id, sender, created_at FROM guest_messages WHERE kind='text' AND booking_id IN (SELECT id FROM bookings WHERE talent_id=?) AND sender IN ('guest','talent') ORDER BY booking_id ASC, created_at ASC, id ASC`).all(userId);
  const byBooking = new Map();
  for (const m of rows) { if (!byBooking.has(m.booking_id)) byBooking.set(m.booking_id, []); byBooking.get(m.booking_id).push(m); }
  const convs = [...byBooking.values()].slice(-20);
  const samples = [];
  for (const msgs of convs) {
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].sender !== 'guest') continue;
      const nx = msgs.slice(i + 1).find((x) => x.sender === 'talent');
      if (nx) { samples.push((nx.created_at - msgs[i].created_at) / 60000); break; }
    }
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(samples.length / 2)];
  return { median_minutes: Math.round(med), bucket: med < 60 ? 'hour' : med < 180 ? 'hours3' : med < 1440 ? 'day' : 'days', samples: samples.length };
}

/* ---- درجة الظهور (محرك الترتيب الصامت) — الصيغة كاملة في وثيقة البناء ---- */
async function visibilityScore(u, ctx = {}) {
  const parts = { verified: 0, reply: 0, completion: 0, profile: 0, activity: 0, star: 0, new_boost: 0, academy: 0, closing: 0, rotation_penalty: 0 };
  if (u.verified) parts.verified = 25;
  const rs = await replySpeedFor(u.id);
  if (rs) parts.reply = rs.median_minutes < 60 ? 20 : rs.median_minutes < 180 ? 14 : rs.median_minutes < 1440 ? 7 : 2;
  const st = await talentStats(u.id);
  if (st && st.completion_rate != null) parts.completion = Math.round((st.completion_rate / 100) * 20);
  // مكوّن توقع الإغلاق (محركات النمو والأمان): إشارة من سجل عروض/حجوزات حقيقي
  // فقط، محايدة تماماً (٠) عند غياب حد أدنى من السجل — فلا تمسّ دفعة الجديد.
  parts.closing = (await closingSignalFor(u.id)).points;
  let prof = 0;
  if (u.avatar) prof += 4;
  if (u.price > 0) prof += 3;
  if (u.bio && String(u.bio).trim().length >= 10) prof += 4;
  const shorts = (await db.prepare('SELECT COUNT(*) c FROM portfolio_items WHERE user_id=?').get(u.id)).c;
  if (shorts > 0) prof += 4;
  parts.profile = Math.min(15, prof);
  const recentActs = (await db.prepare('SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND created_at>=?').get(u.id, now() - 14 * 24 * 3600 * 1000)).c;
  const recentVids = (await db.prepare('SELECT COUNT(*) c FROM daily_videos WHERE user_id=? AND created_at>=?').get(u.id, now() - 14 * 24 * 3600 * 1000)).c;
  if (recentActs > 0 || recentVids > 0 || (u.created_at && u.created_at >= now() - 14 * 24 * 3600 * 1000)) parts.activity = 10;
  // شارة تأهيل أكاديمية Deal (إشارة موثقة في محرك الترتيب — بند الأكاديمية).
  const acadBadges = (await db.prepare('SELECT COUNT(*) c FROM academy_badges WHERE user_id=?').get(u.id)).c;
  if (acadBadges > 0) parts.academy = 6;
  if (await activeStarSub(u.id)) parts.star = 15;
  const anchor = u.verified_at || u.created_at || 0;
  if (u.verified && anchor && now() - anchor < 14 * 24 * 3600 * 1000) parts.new_boost = 12;
  if (ctx.viewerKey) {
    const day = new Date().toISOString().slice(0, 10);
    const imp = await db.prepare('SELECT hits FROM directory_impressions WHERE talent_id=? AND viewer_key=? AND city=? AND niche=? AND day=?')
      .get(u.id, ctx.viewerKey, ctx.city || '', ctx.niche || '', day);
    if (imp && imp.hits > 3) parts.rotation_penalty = -Math.min(20, (imp.hits - 3) * 4);
  }
  const score = parts.verified + parts.reply + parts.completion + parts.profile + parts.activity + parts.star + parts.new_boost + parts.academy + parts.closing + parts.rotation_penalty;
  return { score, parts };
}

/* ---- مطابقة الطلبات: درجة ملاءمة لكل صانع مؤهل ---- */
function matchScoreFor(u, reqFields, rs) {
  let score = 0;
  const niche = String(reqFields.niche || '');
  if (niche && (u.niche === niche || u.provider_category === niche || u.provider_custom === niche)) score += 40;
  else if (!niche || niche === 'أخرى') score += 15;
  if (reqFields.city && u.city && u.city === reqFields.city) score += 25;
  const budget = +(reqFields.budget || 0), price = +(u.price || 0);
  if (budget > 0 && price > 0) {
    const diff = Math.abs(price - budget) / budget;
    if (diff <= 0.3) score += 15; else if (diff <= 0.6) score += 8;
  }
  if (rs) score += rs.median_minutes < 60 ? 10 : rs.median_minutes < 180 ? 7 : rs.median_minutes < 1440 ? 4 : 1;
  if (u.verified) score += 5;
  return score;
}
async function matchRequest(reqRow) {
  if (!reqRow || reqRow.status !== 'open' || reqRow.managed) return [];
  const target = reqRow.target_talent_id || null;
  let candidates;
  if (target) {
    const t = await getUser(target);
    candidates = t ? [t] : [];
  } else {
    candidates = (await db.prepare(`SELECT * FROM users WHERE role IN ('creator','provider') AND banned=0 AND frozen=0 AND penalty_level<>'suspended' AND is_platform_founder=0`).all()).filter((u) => !onVacation(u));
  }
  const scored = [];
  for (const u of candidates) {
    if (reqRow.shop_user_id && u.id === reqRow.shop_user_id) continue;
    const rs = await replySpeedFor(u.id);
    const base = target ? 100 : matchScoreFor(u, reqRow, rs);
    if (!target && base <= 0) continue;
    // مكوّن توقع الإغلاق في المطابقة أيضاً (نفس إشارة الترتيب وبنفس الوزن
    // المحدود) — يُضاف فقط فوق ملاءمة موجبة أصلاً فلا يُدخل صانعاً غير ملائم.
    const score = target ? 100 : base + (await closingSignalFor(u.id)).points;
    scored.push({ user_id: u.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 12);
  for (const m of top) {
    await db.prepare('INSERT INTO request_matches (request_id,user_id,score,notified,created_at) VALUES (?,?,?,?,?) ON CONFLICT(request_id,user_id) DO NOTHING')
      .run(reqRow.id, m.user_id, m.score, 0, now());
  }
  // الأعلى ملاءمة يُنبَّه أولاً: أول خمسة فقط الآن، والباقي احتياط الإنقاذ.
  const fresh = await db.prepare('SELECT * FROM request_matches WHERE request_id=? AND notified=0 ORDER BY score DESC, id ASC LIMIT 5').all(reqRow.id);
  for (const m of fresh) {
    await notifyDeferred(m.user_id, 'opportunity', `🎯 فرصة جديدة تناسبك على Deal: «${String(reqRow.title || reqRow.details || 'طلب خدمة').slice(0, 60)}» — ${reqRow.city || ''} · ميزانية تقريبية ${reqRow.budget || 0} ${reqRow.currency || 'EGP'}. افتح «فرص ليك» وحوّلها لحجز`, `request:${reqRow.id}`);
    await db.prepare('UPDATE request_matches SET notified=1 WHERE id=?').run(m.id);
  }
  return top;
}
/* إنقاذ الطلب: طلب مفتوح بلا حجز بعد ٦ ساعات → تنبيه الدفعة التالية الأعلى ملاءمة */
async function sweepRequestRescue() {
  const rows = await db.prepare(`SELECT * FROM shop_requests WHERE status='open' AND managed=0 AND rescued_at=0 AND created_at<?`).all(now() - 6 * 3600 * 1000);
  let rescued = 0;
  for (const sr of rows) {
    const booked = await db.prepare(`SELECT id FROM bookings WHERE source='guest_request' AND ref_id=? LIMIT 1`).get(sr.id);
    const bookedMember = sr.shop_user_id ? await db.prepare(`SELECT id FROM bookings WHERE talent_id IS NOT NULL AND created_at>=? AND client_id=? LIMIT 1`).get(sr.created_at, sr.shop_user_id) : null;
    if (booked || bookedMember) { await db.prepare('UPDATE shop_requests SET rescued_at=? WHERE id=?').run(now(), sr.id); continue; }
    const next = await db.prepare('SELECT * FROM request_matches WHERE request_id=? AND notified=0 ORDER BY score DESC, id ASC LIMIT 5').all(sr.id);
    if (!next.length) { await matchRequest(sr); }
    const batch = next.length ? next : await db.prepare('SELECT * FROM request_matches WHERE request_id=? AND notified=0 ORDER BY score DESC, id ASC LIMIT 5').all(sr.id);
    for (const m of batch) {
      await notifyDeferred(m.user_id, 'opportunity', `🎯 فرصة لسه مفتوحة وتناسبك على Deal: «${String(sr.title || sr.details || 'طلب خدمة').slice(0, 60)}» — ${sr.city || ''} · ميزانية تقريبية ${sr.budget || 0} ${sr.currency || 'EGP'}. افتح «فرص ليك» وحوّلها لحجز`, `request:${sr.id}`);
      await db.prepare('UPDATE request_matches SET notified=1 WHERE id=?').run(m.id);
    }
    await db.prepare('UPDATE shop_requests SET rescued_at=? WHERE id=?').run(now(), sr.id);
    if (batch.length) rescued++;
  }
  return rescued;
}

/* =====================================================================
   محركات النمو والأمان (قرار المالك 2026-11-23 «الكل» — TESTING-ENGINES.md)
   خمسة محركات فوق إشارات حقيقية مسجلة فقط: لا رقم مُخترع يُعرض لأي مستخدم
   أبداً، وعند صفر بيانات يتصرف كل محرك بحياد/فراغ صادق. تقديرات المالك
   موسومة «إشارة/تقدير» في واجهته. الثوابت كلها موثقة في وثيقة الجولة.
   ===================================================================== */
const ENG_DAY_MS = 24 * 3600 * 1000;

/* ---- ١) إشارة توقع الإغلاق: عروض → حجوزات → مكتملة ----
   rate = ½×(حجوزات من عروض ÷ عروض مُرسلة) + ½×(مكتملة ÷ حجوزات من عروض).
   بلا حد أدنى من العروض (٣) الإشارة محايدة: rate=null ونقاط=٠ — فلا تُكافئ
   ولا تُعاقب، ودفعة الصانع الجديد (١٤ يوماً) لا تُمسّ. الوزن محدود: حتى
   +١٠ نقاط في درجة الظهور ونفسها في درجة المطابقة فوق ملاءمة موجبة فقط. */
const CLOSING_MIN_QUOTES = 3;
const CLOSING_MAX_POINTS = 10;
async function closingSignalFor(userId) {
  const quotes = (await db.prepare('SELECT COUNT(*) c FROM request_quotes WHERE talent_id=?').get(userId)).c || 0;
  if (quotes < CLOSING_MIN_QUOTES) return { quotes, bookings: 0, completed: 0, rate: null, points: 0 };
  const bookings = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND source='quote'`).get(userId)).c || 0;
  const completed = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND source='quote' AND status='completed'`).get(userId)).c || 0;
  const rate = 0.5 * (bookings / quotes) + 0.5 * (bookings ? completed / bookings : 0);
  return { quotes, bookings, completed, rate, points: Math.round(rate * CLOSING_MAX_POINTS) };
}

/* ---- ٤) نقاط مخاطر الحساب الحية + بوابة الهوية المالية للقيم الكبيرة ----
   إشارات حقيقية فقط (الأوزان موثقة في TESTING-ENGINES.md): إيميل غير مؤكد
   ٢٠، حساب أحدث من ٧ أيام ١٠، كل علامة سلوك ١٥ (بسقف ٣٠)، كل إعلان دفع
   كاذب موثّق برفض المالك (reject_kind='false_claim') ٢٥ (بسقف ٥٠)، كل
   نتيجة خطأ مسجلة على الطرف (cancel_fault) ٢٠ (بسقف ٤٠)، مستوى عقوبة
   قائم ١٠. الشريط العالي >= ٥٠. الدرجة نفسها لا تُعرض لأي مستخدم أبداً؛
   الإنفاذ الوحيد: الشريط العالي + حجز أعلى من العتبة (٢٠٠٠ بوحدات عملة
   الحجز — نفس اصطلاح عتبة تقسيم العربون المسطّحة) ⇒ إكمال خطوة «الهوية
   المالية المؤكدة» القائمة أولاً. تحت العتبة لا يتغير شيء (مرونة). */
const RISK_HIGH_BAND = 50;
const RISK_WATCH_BAND = 25;
const RISK_FIN_IDENTITY_THRESHOLD = 2000;
async function accountRiskFor(u) {
  const inputs = { email_unverified: 0, new_account: 0, behavior_flags: 0, false_claims: 0, fault_outcomes: 0, penalty_level: 0 };
  if (!u) return { score: 0, band: 'low', inputs };
  let score = 0;
  if (!u.is_platform_founder && !u.email_verified) { inputs.email_unverified = 20; score += 20; }
  if (now() - (u.created_at || 0) < 7 * ENG_DAY_MS) { inputs.new_account = 10; score += 10; }
  const flags = (await db.prepare('SELECT COUNT(*) c FROM behavior_flags WHERE user_id=?').get(u.id)).c || 0;
  inputs.behavior_flags = Math.min(30, flags * 15); score += inputs.behavior_flags;
  const fc = (await db.prepare(`SELECT COUNT(*) c FROM money_obligations WHERE payer_user_id=? AND reject_kind='false_claim'`).get(u.id)).c || 0;
  inputs.false_claims = Math.min(50, fc * 25); score += inputs.false_claims;
  const ft = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND cancel_fault='talent'`).get(u.id)).c || 0;
  const fl = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE client_id=? AND cancel_fault='client'`).get(u.id)).c || 0;
  inputs.fault_outcomes = Math.min(40, (ft + fl) * 20); score += inputs.fault_outcomes;
  if (u.penalty_level && u.penalty_level !== 'none') { inputs.penalty_level = 10; score += 10; }
  return { score, band: score >= RISK_HIGH_BAND ? 'high' : score >= RISK_WATCH_BAND ? 'watch' : 'low', inputs };
}
const FIN_GATE_SELF = 'لإتمام حجز بهذه القيمة، أكمل أولاً خطوة «الهوية المالية المؤكدة» من لوحتك (إقرار مسجّل مرة واحدة برقم محفظتك وباسمك القانوني) — الخطوة دي بتحميك وبتحمي الطرف الآخر في الصفقات الكبيرة، وبعد إكمالها كمّل الحجز عادي';
const FIN_GATE_OTHER = 'لإتمام حجز بهذه القيمة، الطرف الآخر محتاج يكمل خطوة «الهوية المالية المؤكدة» من لوحته أولاً (إقرار مسجّل مرة واحدة) — بلّغه يكملها من لوحته ثم حاولوا إتمام الحجز تاني';
/* يعيد رسالة المنع المناسبة (لنفسه/للطرف الآخر) أو null إن مرّ الحجز. */
async function riskGateError(self, other, price) {
  if (!(+price > RISK_FIN_IDENTITY_THRESHOLD)) return null;
  const parties = [{ u: self, who: 'self' }, { u: other, who: 'other' }];
  for (const p of parties) {
    if (!p.u || p.u.is_platform_founder || p.u.fin_declared_at) continue;
    const r = await accountRiskFor(p.u);
    if (r.band === 'high') return p.who === 'self' ? FIN_GATE_SELF : FIN_GATE_OTHER;
  }
  return null;
}

/* ---- ٣) منع تسرّب الصناع: خمول >= ٧ أيام ⇒ تدخل واحد لكل حلقة خمول ----
   آخر نشاط = أحدث إشارة مسجلة فعلاً (جلسة/حجز/عرض سعر/إنشاء الحساب).
   الخطوة المقترحة من حالة الصانع نفسه: بلا نماذج ⇒ «أضف نموذج شغل»؛
   ملف ناقص (صورة/بايو/سعر) ⇒ «كمّل ملفك»؛ غير ذلك ⇒ «فعّل متاح اليوم».
   الحلقة تنتهي بأي نشاط بعد التدخل — خمول جديد بعد عودة = تدخل جديد. */
const CHURN_INACTIVE_MS = 7 * ENG_DAY_MS;
const CHURN_TEXTS = {
  sample: '👋 وحشتنا على Deal — ملفك لسه من غير نماذج شغل. أضف نموذجاً واحداً على الأقل من لوحتك: النماذج جزء من قوة ملفك قدام العملاء ومن درجة ظهورك في السوق',
  profile: '👋 وحشتنا على Deal — كمّل ملفك من لوحتك (صورة شخصية + بايو واضح + سعرك المعلن)؛ الملف المكتمل جزء من درجة ظهورك في السوق وبيقدّمك للعميل بثقة أكبر',
  available_today: '👋 وحشتنا على Deal — فعّل «متاح اليوم» من لوحتك عشان تظهر في شريط المتاحين النهارده قدام العملاء اللي بيدوّروا في مجالك ومدينتك',
};
async function lastActivityFor(userId, u) {
  const s = await db.prepare('SELECT MAX(CASE WHEN last_seen_at>0 THEN last_seen_at ELSE created_at END) m FROM sessions WHERE user_id=?').get(userId);
  const b = await db.prepare('SELECT MAX(created_at) m FROM bookings WHERE talent_id=? OR client_id=?').get(userId, userId);
  const q = await db.prepare('SELECT MAX(created_at) m FROM request_quotes WHERE talent_id=?').get(userId);
  return Math.max((s && s.m) || 0, (b && b.m) || 0, (q && q.m) || 0, (u && u.created_at) || 0);
}
async function churnStepFor(u) {
  const samples = (await db.prepare('SELECT COUNT(*) c FROM portfolio_items WHERE user_id=?').get(u.id)).c || 0;
  if (!samples) return 'sample';
  if (!u.avatar || !String(u.bio || '').trim() || !(u.price > 0)) return 'profile';
  return 'available_today';
}
async function churnCandidates() {
  return await db.prepare(`SELECT * FROM users WHERE role IN ('creator','provider') AND banned=0 AND frozen=0 AND is_platform_founder=0 AND COALESCE(deleted_at,0)=0 AND created_at<=?`).all(now() - CHURN_INACTIVE_MS);
}
async function sweepChurnPrevention() {
  let fired = 0;
  for (const u of await churnCandidates()) {
    const last = await lastActivityFor(u.id, u);
    if (now() - last < CHURN_INACTIVE_MS) continue;
    const prev = await db.prepare('SELECT * FROM churn_interventions WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 1').get(u.id);
    if (prev && prev.created_at >= last) continue; // تدخل قائم في حلقة الخمول نفسها
    const step = await churnStepFor(u);
    await notify(u.id, 'churn_prevention', CHURN_TEXTS[step], 'churn');
    await db.prepare('INSERT INTO churn_interventions (user_id,step,last_activity_at,created_at) VALUES (?,?,?,?)').run(u.id, step, last, now());
    fired++;
  }
  return fired;
}
async function churnReport() {
  let atRisk = 0;
  for (const u of await churnCandidates()) {
    const last = await lastActivityFor(u.id, u);
    if (now() - last >= CHURN_INACTIVE_MS) atRisk++;
  }
  const fired7 = (await db.prepare('SELECT COUNT(*) c FROM churn_interventions WHERE created_at>=?').get(now() - 7 * ENG_DAY_MS)).c || 0;
  return { inactive_days: CHURN_INACTIVE_MS / ENG_DAY_MS, at_risk: atRisk, interventions_7d: fired7 };
}

/* ---- ٢) توازن العرض والطلب: تجميع حقيقي + تقويم المواسم الـ١٦ ----
   طلب آخر ٣٠ يوماً (طلبات مفتوحة/محجوزة) مقابل عرض فعّال (صناع/مقدمون
   غير مجمّدين/محظورين/في إجازة) لكل خلية مجال×مدينة. رايات موثقة:
   no_supply: طلب>=٢ بلا أي عرض · demand_pressure: طلب>=٤ وطلب>=ضعف العرض
   · seasonal: موسم نشط أو يبدأ خلال ٤٥ يوماً يغطي المجال وطلب>=٢ وطلب>=العرض.
   للمالك فقط — لا سطح مواجهاً للمستخدمين. */
async function upcomingSeasons(daysAhead = 45) {
  const byKey = new Map();
  for (let d = 0; d <= daysAhead; d++) {
    const act = await activeSeasons(now() + d * ENG_DAY_MS);
    for (const s of act) {
      const cur = byKey.get(s.key);
      if (!cur) byKey.set(s.key, { key: s.key, ar: s.ar, en: s.en, niches: s.niches || [], countries: s.countries || null, start: s.start, end: s.end, active_now: d === 0 });
      else if (s.start < cur.start) { cur.start = s.start; cur.end = s.end; }
    }
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start);
}
async function supplyDemandReport() {
  const since = now() - 30 * ENG_DAY_MS;
  const demRows = await db.prepare(`SELECT niche, city, COUNT(*) c FROM shop_requests WHERE created_at>=? AND status IN ('open','booked') GROUP BY niche, city`).all(since);
  const supRows = await db.prepare(`SELECT * FROM users WHERE role IN ('creator','provider') AND banned=0 AND frozen=0 AND is_platform_founder=0 AND COALESCE(deleted_at,0)=0`).all();
  const cells = new Map();
  const cellOf = (niche, city) => { const k = `${niche}||${city}`; if (!cells.has(k)) cells.set(k, { niche, city, demand: 0, supply: 0 }); return cells.get(k); };
  let totalDemand = 0;
  for (const r of demRows) { const n = String(r.niche || '').trim(); if (!n) continue; cellOf(n, String(r.city || '')).demand += r.c; totalDemand += r.c; }
  let totalSupply = 0;
  for (const u of supRows) {
    if (onVacation(u)) continue;
    totalSupply++;
    const keys = new Set();
    if (u.niche && String(u.niche).trim()) keys.add(String(u.niche).trim());
    if (u.provider_category && String(u.provider_category).trim()) keys.add(String(u.provider_category).trim());
    for (const n of keys) cellOf(n, String(u.city || '')).supply += 1;
  }
  const seasons = await upcomingSeasons(45);
  const flags = [];
  for (const c of cells.values()) {
    if (c.supply === 0 && c.demand >= 2) { flags.push({ ...c, reason: 'no_supply', level: 'high' }); continue; }
    if (c.supply > 0 && c.demand >= 4 && c.demand >= 2 * c.supply) { flags.push({ ...c, reason: 'demand_pressure', level: 'high' }); continue; }
    const season = seasons.find((s) => (!s.niches || !s.niches.length || s.niches.includes(c.niche)) && c.demand >= 2 && c.demand >= c.supply);
    if (season) flags.push({ ...c, reason: 'seasonal', level: 'watch', season: { key: season.key, ar: season.ar, en: season.en, start: season.start, active_now: season.active_now } });
  }
  return {
    window_days: 30, generated_at: now(),
    totals: { demand: totalDemand, supply: totalSupply },
    cells: [...cells.values()].sort((a, b) => (b.demand - a.demand) || (b.supply - a.supply)),
    flags,
    seasons: seasons.map((s) => ({ key: s.key, ar: s.ar, en: s.en, start: s.start, end: s.end, active_now: s.active_now })),
  };
}

/* ---- ٥) التحسين الذاتي: تجربة A/B واحدة آمنة على سطر الصانع في شريط
   المسارين (نصّان صادقان معتمدان بلا فرق وعود). التعيين ببصمة ثابتة من
   مفتاح الزائر (نفس المفتاح ⇒ نفس النسخة دائماً وغير ظاهر). المقياس
   الأساسي الوحيد: بدء تسجيل صانع من الشريط لكل مشاهدة شريط (زائر/يوم).
   تقرير فقط — لا تبديل تلقائياً للفائز في هذه الجولة. */
function expVariantFor(vid) {
  const h = crypto.createHash('sha256').update(`deal-exp:${String(vid || '')}`).digest();
  return h[0] % 2 === 0 ? 'A' : 'B';
}
async function experimentReport() {
  const rows = await db.prepare('SELECT variant, kind, COUNT(*) c FROM exp_events GROUP BY variant, kind').all();
  const out = { A: { views: 0, reg_starts: 0, rate_pct: null }, B: { views: 0, reg_starts: 0, rate_pct: null }, metric: 'reg_start_per_view', auto_switch: false };
  for (const r of rows) {
    if (!out[r.variant]) continue;
    if (r.kind === 'view') out[r.variant].views = r.c;
    if (r.kind === 'reg_start') out[r.variant].reg_starts = r.c;
  }
  for (const v of ['A', 'B']) { const x = out[v]; x.rate_pct = x.views ? Math.round((x.reg_starts / x.views) * 1000) / 10 : null; }
  return out;
}
app.get('/api/exp/assignment', (req, res) => {
  const vid = String((req.query || {}).vid || '').slice(0, 80);
  if (!vid) return res.status(400).json({ error: 'vid required' });
  res.json({ variant: expVariantFor(vid) });
});
app.post('/api/exp/event', async (req, res) => {
  const { vid, kind } = req.body || {};
  if (!vid || !['view', 'reg_start'].includes(kind)) return res.status(400).json({ error: 'بيانات غير صحيحة' });
  const vidHash = crypto.createHash('sha256').update(String(vid)).digest('hex');
  const day = new Date().toISOString().slice(0, 10);
  await db.prepare('INSERT INTO exp_events (vid_hash,variant,kind,day,created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
    .run(vidHash, expVariantFor(vid), kind, day, now());
  res.json({ ok: true });
});

/* لوحة محركات النمو والأمان للمالك: تجميعات حقيقية فقط + عدّ حسابات
   الشريط العالي (الدرجات نفسها لا تُعرض لأحد — ولا حتى هنا). */
app.get('/api/owner/engines', auth, ownerOnly, async (req, res) => {
  const supply_demand = await supplyDemandReport();
  const churn = await churnReport();
  const experiment = await experimentReport();
  let highAccounts = 0;
  const us = await db.prepare(`SELECT * FROM users WHERE banned=0 AND is_platform_founder=0 AND COALESCE(deleted_at,0)=0 LIMIT 500`).all();
  for (const u of us) { if ((await accountRiskFor(u)).band === 'high') highAccounts++; }
  res.json({ supply_demand, churn, experiment, risk: { threshold: RISK_FIN_IDENTITY_THRESHOLD, high_band: RISK_HIGH_BAND, high_accounts: highAccounts } });
});

/* ---- الملخص الأسبوعي الآلي لكل صانع ---- */
async function sweepWeeklySummaries() {
  const users = await db.prepare(`SELECT * FROM users WHERE role IN ('creator','provider') AND banned=0 AND is_platform_founder=0`).all();
  let sent = 0;
  for (const u of users) {
    if (u.last_summary_at && now() - u.last_summary_at < 7 * 24 * 3600 * 1000) continue;
    const since = now() - 7 * 24 * 3600 * 1000;
    const views = (await db.prepare('SELECT COUNT(*) c FROM profile_views WHERE talent_id=? AND created_at>=?').get(u.id, since)).c;
    const reqs = (await db.prepare('SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND created_at>=?').get(u.id, since)).c
      + (await db.prepare('SELECT COUNT(*) c FROM request_matches WHERE user_id=? AND created_at>=?').get(u.id, since)).c;
    if (!views && !reqs) continue; // لا يُرسل لمن لا نشاط ولا مشاهدات لديه إطلاقاً
    const st = await talentStats(u.id);
    const rate = st && st.completion_rate != null ? `${st.completion_rate}%` : '—';
    await notifyDeferred(u.id, 'weekly_summary', `📊 ملخصك الأسبوعي على Deal: ${views} مشاهدة لملفك و${reqs} طلب/فرصة وصلتك في آخر ٧ أيام، ونسبة إتمامك ${rate}. الرد السريع والملف الكامل يرفعوا ظهورك في السوق`, 'dashboard');
    await db.prepare('UPDATE users SET last_summary_at=? WHERE id=?').run(now(), u.id);
    sent++;
  }
  return sent;
}

/* موعد التسليم المنظّم أُلغي بقرار المستخدم 2026-11-23: لا عدّاد تسليم ولا فتح آلي لمسار الاستبدال بمرور وقت — محرّكا الاستبدال الباقيان (إعلان المنفذ عدم القدرة، وصمته ٢٤ ساعة بعد العربون رغم تنبيهين) يمضيان عبر التحكيم الموثّق كما كانا. */

/* ---- قوالب الرد السريعة ---- */
const DEFAULT_TEMPLATES = [
  'السعر يشمل التنفيذ والتسليم بالجودة المتفق عليها — أي تعديل إضافي بره الاتفاق بيتحسب لوحده',
  'مدة التنفيذ من يومين لثلاثة أيام من تأكيد العربون، والتسليم النهائي بعد تأكيد قبض الباقي',
  'محتاج منك التفاصيل دي قبل ما أبدأ: نص الإعلان، الشعار، أي روابط أو أمثلة يعجبك شغلها',
];
async function ownTemplates(userId) {
  return await db.prepare('SELECT * FROM user_templates WHERE user_id=? ORDER BY sort ASC, id ASC').all(userId);
}
app.get('/api/my/templates', auth, async (req, res) => {
  const rows = await ownTemplates(req.user.id);
  if (!rows.length) return res.json({ items: DEFAULT_TEMPLATES.map((text, i) => ({ id: null, text, sort: i })), using_defaults: true });
  res.json({ items: rows, using_defaults: false });
});
async function seedTemplatesIfEmpty(userId) {
  const rows = await ownTemplates(userId);
  if (rows.length) return rows;
  for (let i = 0; i < DEFAULT_TEMPLATES.length; i++) {
    await db.prepare('INSERT INTO user_templates (user_id,text,sort,created_at) VALUES (?,?,?,?)').run(userId, DEFAULT_TEMPLATES[i], i, now());
  }
  return await ownTemplates(userId);
}
app.post('/api/my/templates', auth, async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'اكتب نص القالب' });
  if (text.length > 300) return res.status(400).json({ error: 'القالب أطول من ٣٠٠ حرف' });
  const rows = await seedTemplatesIfEmpty(req.user.id);
  if (rows.length >= 20) return res.status(400).json({ error: 'وصلت لحد ٢٠ قالباً' });
  const info = await db.prepare('INSERT INTO user_templates (user_id,text,sort,created_at) VALUES (?,?,?,?)').run(req.user.id, text, rows.length, now());
  res.json({ ok: true, id: info.lastInsertRowid, items: await ownTemplates(req.user.id) });
});
app.put('/api/my/templates/:id', auth, async (req, res) => {
  const row = await db.prepare('SELECT * FROM user_templates WHERE id=? AND user_id=?').get(+req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'القالب غير موجود' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'اكتب نص القالب' });
  if (text.length > 300) return res.status(400).json({ error: 'القالب أطول من ٣٠٠ حرف' });
  await db.prepare('UPDATE user_templates SET text=? WHERE id=?').run(text, row.id);
  res.json({ ok: true, items: await ownTemplates(req.user.id) });
});
app.delete('/api/my/templates/:id', auth, async (req, res) => {
  const row = await db.prepare('SELECT * FROM user_templates WHERE id=? AND user_id=?').get(+req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'القالب غير موجود' });
  await db.prepare('DELETE FROM user_templates WHERE id=?').run(row.id);
  res.json({ ok: true, items: await ownTemplates(req.user.id) });
});

/* ---- «اطلب تاني»: إعادة طلب من نفس المنفّذ من صفقة مكتملة ---- */
app.post('/api/bookings/:id/order-again', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b) return res.status(404).json({ error: 'الحجز غير موجود' });
  if (b.client_id !== req.user.id) return res.status(403).json({ error: 'إعادة الطلب لعميل الصفقة فقط' });
  if (founderClientBlocked(req, res)) return;
  if (b.status !== 'completed') return res.status(400).json({ error: 'إعادة الطلب من صفقة مكتملة فقط' });
  if (req.user.frozen) return res.status(403).json({ error: 'حسابك مجمّد حالياً' });
  const talent = await getUser(b.talent_id);
  if (!talent || talent.banned) return res.status(400).json({ error: 'المنفّذ غير متاح حالياً' });
  const price = (req.body && +req.body.price > 0) ? +req.body.price : b.price;
  const gateOA = await riskGateError(req.user, talent, price);
  if (gateOA) return res.status(403).json({ error: gateOA, fin_identity_required: true });
  const title = (req.body && String(req.body.title || '').trim()) || b.title;
  const agrOA = (req.body && (req.body.agreed_revisions !== undefined || req.body.agreed_delivery_at !== undefined)) ? agreementFromBody(req.body) : { revisions: b.agreed_revisions !== undefined ? b.agreed_revisions : null, deliveryAt: b.agreed_delivery_at || 0 };
  if (agrOA.error) return res.status(400).json({ error: agrOA.error });
  const info = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,urgent,agreed_revisions,agreed_delivery_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, talent.id, 'order_again', b.id, title, price, b.currency, now() + 7 * 24 * 3600 * 1000, 0, agrOA.revisions, agrOA.deliveryAt, now());
  await addBookingEvent(info.lastInsertRowid, 'created', `أُنشئ الحجز كإعادة طلب من الصفقة المكتملة #${b.id} — نفس المنفّذ والبيانات الأساسية`);
  await notify(talent.id, 'booking_new', `🔁 طلب جديد من عميل سابق: حجز #${info.lastInsertRowid} بقيمة ${price} ${b.currency} (إعادة طلب من صفقة مكتملة)`, `booking:${info.lastInsertRowid}`);
  res.json({ booking: await bookingView(await getBooking(info.lastInsertRowid), req.user) });
});

/* ---- تصدير سجل صفقات الصانع (CSV) ---- */
app.get('/api/my/deals-export', auth, async (req, res) => {
  if (!['creator', 'provider'].includes(req.user.role)) return res.status(400).json({ error: 'التصدير للصناع ومقدمي الخدمة فقط' });
  const rows = await db.prepare('SELECT * FROM bookings WHERE talent_id=? ORDER BY created_at DESC').all(req.user.id);
  const escCsv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [['booking_id', 'date', 'client', 'amount', 'currency', 'status'].join(',')];
  for (const b of rows) {
    const client = b.client_id ? ((await getUser(b.client_id)) || {}).name || 'عميل' : (b.guest_name || 'عميل ضيف');
    lines.push([b.id, new Date(b.created_at).toISOString().slice(0, 10), escCsv(client), b.price, b.currency, b.status].join(','));
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="deal-my-deals.csv"');
  res.send('\ufeff' + lines.join('\n'));
});

/* ---- فرص ليك: طلبات مُطابَقة لي مرتبة بدرجة الملاءمة ---- */
app.get('/api/my/opportunities', auth, async (req, res) => {
  const rows = await db.prepare(`SELECT m.score AS match_score, r.* FROM request_matches m JOIN shop_requests r ON r.id=m.request_id WHERE m.user_id=? AND r.status='open' ORDER BY m.score DESC, m.id ASC`).all(req.user.id);
  res.json({ items: rows.map((r) => ({ id: r.id, title: r.title || '', niche: r.niche || '', city: r.city || '', budget: r.budget || 0, currency: r.currency || 'EGP', details: r.details || '', urgent: !!r.urgent, is_guest: !!r.is_guest, match_score: Math.round(r.match_score), created_at: r.created_at })) });
});

/* مسارات موعد التسليم المنظّم وتفعيل الاستبدال الآلي حُذفت بقرار المستخدم 2026-11-23 (لا موعد تسليم مفروضاً ولا مسار يفتح بساعة) — ضمان الاستبدال بمحرّكيه الباقيين يمضي عبر التحكيم الموثّق. */

/* ---- لوحة المالك: درجات الظهور بعناصرها (شفافية داخلية) ---- */
app.get('/api/owner/ranking', auth, ownerOnly, async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM users WHERE role IN ('creator','provider') AND banned=0 AND is_platform_founder=0`).all();
  const items = [];
  for (const u of rows) {
    const v = await visibilityScore(u, {});
    items.push({ user_id: u.id, name: u.name, city: u.city, niche: u.niche, verified: !!u.verified, score: v.score, parts: v.parts });
  }
  items.sort((a, b) => b.score - a.score);
  res.json({ items });
});


/* رسالة صوتية في محادثة الحجز: مرجع ملف صوتي (رابط https أو data:audio
   مضغّط من تسجيل المتصفح) بحد أقصى ١٨٠ ثانية و٢٫٥ ميجا تقريباً — تُحفظ
   كدليل بختم وقتها. كشف التسرّب النصي لا ينطبق على الصوت بطبيعته (موثّق). */
const VOICE_MAX_SEC = 180, VOICE_MAX_LEN = 2800000;
function voicePayload(req) {
  const body = req.body || {};
  if (body.kind !== 'voice') return null;
  const dur = Math.round(+body.duration_sec || 0);
  const media = String(body.media_url || '');
  if (!dur || dur < 1) return { error: 'مدة الرسالة الصوتية مطلوبة' };
  if (dur > VOICE_MAX_SEC) return { error: `الرسالة الصوتية أطول من الحد الأقصى (${VOICE_MAX_SEC} ثانية)` };
  if (!media || media.length > VOICE_MAX_LEN) return { error: 'ملف الصوت أكبر من الحد المسموح' };
  if (!(/^https:\/\//i.test(media) || /^data:audio\//i.test(media))) return { error: 'رابط/ملف صوت غير صالح' };
  return { duration_sec: dur, media_url: media, caption: String(body.body || '').slice(0, 300) };
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
const PUSH_TYPES = new Set(['booking', 'booking_new', 'appeal', 'appeal_closed', 'appeal_decided', 'appeal_escalated', 'dispute', 'escrow', 'escrow_ready', 'escrow_frozen', 'escrow_seen', 'escrow_missing', 'order_cancelled', 'money_auto', 'deemed', 'rest_overdue', 'rest_stuck', 'deemed_warn', 'deadline_warn', 'penalty', 'late_payment', 'opportunity', 'weekly_summary']);
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
  const { talent_id, title = '', price, source = 'direct', ref_id = null, deadline_days = 7, urgent = 0, package_tier = null } = req.body || {};
  const talent = await getUser(+talent_id);
  if (!talent || !['creator', 'provider'].includes(talent.role)) return res.status(400).json({ error: 'المنفذ غير صحيح' });
  if (talent.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس — عرض فقط ولا يقبل حجوزات أو تواصلاً' });
  if (founderClientBlocked(req, res)) return;
  if (talent.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حجز نفسك' });
  /* حظر عضو↔عضو (الجولة الأخيرة — بند ٩): لا حجز جديداً بين طرفين بينهما حظر. */
  if (await blockBetween(req.user.id, talent.id)) return res.status(403).json({ error: BLOCKED_ERROR, code: 'BLOCKED' });
  if (talent.penalty_level === 'suspended' || talent.frozen) return res.status(403).json({ error: 'هذا الحساب معلّق حالياً ولا يستقبل حجوزات' });
  if (onVacation(talent)) return res.status(400).json({ error: 'المنفذ في إجازة حالياً ولا يستقبل حجوزات جديدة حتى عودته' });
  if (req.user.frozen) return res.status(403).json({ error: 'حسابك مجمّد حالياً (مستحقات متأخرة أو عقوبة) — سدّد مستحقاتك الموثّقة أولاً فيُفكّ التجميد آلياً' });
  // اختيار باقة عند الطلب يملأ سعر الحجز منها (خادمياً — لا من العميل).
  let pkgTier = null;
  let p;
  if (package_tier != null && package_tier !== '') {
    const pkg = await packagePrice(talent.id, package_tier);
    if (!pkg) return res.status(400).json({ error: 'باقة غير متاحة عند هذا المنفذ' });
    p = pkg.price; pkgTier = pkg.tier;
  } else {
    p = price != null ? +price : effectivePrice(talent);
  }
  if (!p || p <= 0) return res.status(400).json({ error: 'حدد سعراً صحيحاً' });
  const agrD = agreementFromBody(req.body || {}); if (agrD.error) return res.status(400).json({ error: agrD.error });
  // بوابة الهوية المالية (محرك المخاطر الحي): شريط عالٍ + قيمة فوق العتبة فقط.
  const gateD = await riskGateError(req.user, talent, p);
  if (gateD) return res.status(403).json({ error: gateD, fin_identity_required: true });
  const info = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,urgent,package_tier,agreed_revisions,agreed_delivery_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, talent.id, source, ref_id, title || `حجز مع ${talent.name}`, p, talent.currency, now() + deadline_days * 24 * 3600 * 1000, urgent ? 1 : 0, pkgTier, agrD.revisions, agrD.deliveryAt, now());
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

/* الخط الزمني الموحّد للحجز (الجولة الأخيرة — ١٣أ): مسار قراءة واحد يعيد
   مصفوفة الأحداث نفسها لأي طرف — العميل والمقدم والمؤسس يرون البنية
   ذاتها حدثاً بحدث (لا تشكيل حسب الرائي إطلاقاً)، ومعها قرار التحكيم
   المسبّب إن وُجد. */
app.get('/api/bookings/:id/timeline', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || (b.client_id !== req.user.id && b.talent_id !== req.user.id && !req.user.is_platform_founder)) return res.status(404).json({ error: 'غير موجود' });
  const view = await bookingView(b, req.user);
  res.json({ booking_id: b.id, events: view.timeline, arbitration: view.arbitration });
});

/* إجراءات طرف العميل في آلة حالات الحجز — مشتركة بين العميل المسجل وعميل الضيف
   (صفحة الرمز) حتى لا تتكرر آلة الحالات. كل دالة تعيد {error} أو {booking}. */
/* التزام العمولة يُنشأ خادمياً لحظة اكتمال القبولين (٤-ب): لا يعتمد على
   فتح أي طرف لخطوة العمولة — عدّاد المهلة (٣ ساعات) يبدأ من لحظة الانتقال
   نفسه، وأي fee-info لاحق يجد الالتزام نفسه (getOrCreate يدير التكرار). */
async function ensureCommissionObligation(b) {
  if (!b || b.status !== 'awaiting_fee' || b.fee_status === 'confirmed') return null;
  return await getOrCreateObligation({
    kind: 'booking_commission', booking_id: b.id, user_id: b.talent_id,
    base_amount: bookingLegAmounts(b).fee, currency: b.currency,
    payer_user_id: b.client_id || null, guest_token: b.guest_token || '', payee: 'owner',
  });
}
/* انتقال ما بعد اكتمال القبولين — مسار واحد مشترك بين كل قنوات القبول. */
async function advanceAfterAgreement(b) {
  let nb = await getBooking(b.id);
  if (nb.agreed_client && nb.agreed_talent && nb.status === 'pending_agreement') {
    await db.prepare(`UPDATE bookings SET status='awaiting_fee' WHERE id=?`).run(b.id);
    await ensureCommissionObligation(await getBooking(b.id));
    await notify(nb.client_id, 'booking', `حجز #${b.id}: اتفق الطرفان — خطوة العمولة أولاً`, `booking:${b.id}`);
    await notify(nb.talent_id, 'booking', `حجز #${b.id}: اتفق الطرفان — في انتظار تأكيد عمولة Deal`, `booking:${b.id}`);
    nb = await getBooking(b.id);
  }
  return nb;
}
/* قبول واحد موحّد (٤-أ — السبب الجذري في TESTING-ENTRY-CLARITY.md): كان
   لمسار «أوافق على الحجز» (applyAgree: أعمدة agreed_*) ومسار «أوافق على
   الشروط» (acceptTerms: جدول booking_terms_acceptances) حقيقتان منفصلتان
   لا تكتب إحداهما في الأخرى، فاكتمل الاتفاق في القاعدة وبقي مربع الشروط
   وبوابة الدفع مقفلين في الواجهة. الآن فعل القبول الواحد من أي مسار
   يُسجَّل في المسارين معاً: قبول الشروط المُصدَّر (دليل قانوني) + علم
   الاتفاق، والانتقال وإنشاء التزام العمولة من الدالة المشتركة. */
async function applyAgree(b, side, actor = {}) {
  if (b.status !== 'pending_agreement') return { error: 'الحجز تجاوز مرحلة الاتفاق' };
  await acceptTerms(b, side, actor.userId ?? null, actor.guestToken || '');
  if (side === 'client') await db.prepare('UPDATE bookings SET agreed_client=1 WHERE id=?').run(b.id);
  else await db.prepare('UPDATE bookings SET agreed_talent=1 WHERE id=?').run(b.id);
  return { booking: await advanceAfterAgreement(b) };
}
/* قبول الشروط من زر/حوار الشروط يكمل جانب الاتفاق نفسه (نفس التوحيد). */
async function acceptTermsAndAgree(b, side, actor = {}) {
  const st = await acceptTerms(b, side, actor.userId ?? null, actor.guestToken || '');
  if (b.status === 'pending_agreement') {
    if (side === 'client') await db.prepare('UPDATE bookings SET agreed_client=1 WHERE id=?').run(b.id);
    else await db.prepare('UPDATE bookings SET agreed_talent=1 WHERE id=?').run(b.id);
    await advanceAfterAgreement(b);
  }
  return st;
}

async function applyClientPayment(b, kind, ref, payer = null) {
  const payerCols = payer ? { n: String(payer.name || '').slice(0, 120), w: String(payer.wallet || '').slice(0, 60), f: String(payer.fp || '').slice(0, 80) } : { n: '', w: '', f: '' };
  const fee = Math.round(b.price * COMMISSION_RATE * 100) / 100;
  const net = b.price - fee, half = Math.round(net / 2 * 100) / 100;
  if (kind === 'fee') {
    if (b.status !== 'awaiting_fee') return { error: 'خطوة العمولة ليست مفتوحة' };
    await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at,payer_name,payer_wallet,payer_device_fp) VALUES (?,?,?,?,?,?,?,?,?)').run(b.id, 'fee', fee, ref, 'confirmed', now(), payerCols.n, payerCols.w, payerCols.f);
    await db.prepare(`UPDATE bookings SET fee_status='confirmed', fee_ref=?, fee_confirmed_at=?, status='awaiting_deposit' WHERE id=?`).run(ref, now(), b.id);
    await notify(b.talent_id, 'booking', `حجز #${b.id}: تأكدت عمولة Deal — العربون اتفتح`, `booking:${b.id}`);
  } else if (kind === 'deposit') {
    if (b.status !== 'awaiting_deposit') return { error: 'العربون غير مفتوح الآن' };
    const amounts = bookingLegAmounts(b);
    if (amounts.split) {
      /* صفقة كبيرة: دفعة البداية ٢٠٪ فقط — التنفيذ يبدأ بها، ودفعة الـ٢٥٪
         لا تُفتح إلا بعد معاينة أولية يؤكدها العميل (حزمة الثقة المجانية). */
      await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at,payer_name,payer_wallet,payer_device_fp) VALUES (?,?,?,?,?,?,?,?,?)').run(b.id, 'deposit', amounts.dep1, ref, 'confirmed', now(), payerCols.n, payerCols.w, payerCols.f);
      await db.prepare(`UPDATE bookings SET status='in_progress' WHERE id=?`).run(b.id);
      await addBookingEvent(b.id, 'deposit_split_started', `صفقة كبيرة (أكبر من ${LARGE_DEAL_SPLIT_THRESHOLD}): العربون مُقسَّم — دفعة بداية ٢٠٪ (${amounts.dep1} ${b.currency}) ثم ٢٥٪ (${amounts.dep2} ${b.currency}) بعد معاينة أولية يؤكدها العميل`);
      await notify(b.talent_id, 'booking', `حجز #${b.id}: وصلتك دفعة بداية العربون ${amounts.dep1} ${b.currency} (٢٠٪ — صفقة كبيرة بعربون مُقسَّم) — ابدأ التنفيذ وقدّم معاينة أولية ليؤكدها العميل فتتفتح دفعة الـ٢٥٪`, `booking:${b.id}`);
    } else {
      await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at,payer_name,payer_wallet,payer_device_fp) VALUES (?,?,?,?,?,?,?,?,?)').run(b.id, 'deposit', half, ref, 'confirmed', now(), payerCols.n, payerCols.w, payerCols.f);
      await db.prepare(`UPDATE bookings SET status='in_progress' WHERE id=?`).run(b.id);
      await notify(b.talent_id, 'booking', `حجز #${b.id}: وصلك العربون ${half} — ابدأ التنفيذ`, `booking:${b.id}`);
    }
  } else if (kind === 'deposit2') {
    /* دفعة العربون الثانية (٢٥٪) للصفقات الكبيرة: لا تُفتح إلا بعد تأكيد
       العميل للمعاينة الأولية — ومهلتها ٣ ساعات ككل خطوة دفع. */
    const amounts = bookingLegAmounts(b);
    if (!amounts.split) return { error: 'حجزك بعربون واحد — لا دفعة ثانية' };
    if (b.status !== 'awaiting_deposit2') return { error: 'دفعة العربون الثانية غير مفتوحة الآن — بتفتح بعد تأكيد المعاينة الأولية' };
    const prev2 = await db.prepare(`SELECT id FROM payments WHERE booking_id=? AND kind='deposit2'`).get(b.id);
    if (prev2) return { error: 'سجّلت دفعة العربون الثانية من قبل' };
    await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at,payer_name,payer_wallet,payer_device_fp) VALUES (?,?,?,?,?,?,?,?,?)').run(b.id, 'deposit2', amounts.dep2, ref, 'confirmed', now(), payerCols.n, payerCols.w, payerCols.f);
    await db.prepare(`UPDATE bookings SET status='in_progress' WHERE id=?`).run(b.id);
    await notify(b.talent_id, 'booking', `حجز #${b.id}: وصلتك دفعة العربون الثانية ${amounts.dep2} ${b.currency} (٢٥٪) — كمّل التنفيذ وارفع إثبات التنفيذ النهائي`, `booking:${b.id}`);
  } else if (kind === 'rest') {
    /* الباقي مباشرة للمنفذ (لا احتجاز عند Deal): تسجيل المرجع «ادعاء» فقط —
       القبض يتأكد بمطابقة إيصال صارمة على رقم المنفذ أو بـ«وصلني» من المنفذ
       نفسه، وبعدها تُسلَّم النسخة النهائية ويكتمل الحجز بتأكيد استلامها أو
       بسكوت العميل ٣ ساعات. الخطوة تُفتح فقط بعد قبول استلام المعاينة. */
    if (!['awaiting_rest', 'rest_overdue'].includes(b.status)) return { error: 'الباقي غير مفتوح الآن — بيفتح بعد تأكيد استلام المعاينة' };
    const prev = await restPaymentRow(b.id);
    if (prev && ['claimed', 'confirmed'].includes(prev.status)) return { error: 'سجّلت تحويل الباقي من قبل — التحويلة عند المنفذ للتحقق من قبضها' };
    await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at,payer_name,payer_wallet,payer_device_fp) VALUES (?,?,?,?,?,?,?,?,?)').run(b.id, 'rest', half, ref, 'claimed', now(), payerCols.n, payerCols.w, payerCols.f);
    if (b.status === 'rest_overdue') await db.prepare(`UPDATE bookings SET status='awaiting_rest' WHERE id=?`).run(b.id);
    await notify(b.talent_id, 'booking', `حجز #${b.id}: العميل سجّل تحويل الباقي لك مباشرة — أكّد قبضه من محفظتك بـ«وصلني» بعد ما يوصلك فعلياً، وبعدها سلّم النسخة النهائية`, `booking:${b.id}`);
  } else return { error: 'نوع دفعة غير صحيح' };
  const legAr = { fee: 'عمولة Deal', deposit: 'العربون', deposit2: 'دفعة العربون الثانية', rest: 'الدفعة الأخيرة' }[kind] || kind;
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
  const r = await applyAgree(b, side, { userId: req.user.id });
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
  const st = await acceptTermsAndAgree(b, side, { userId: req.user.id });
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
  /* هوية الدافع العضو (٨-ج): من بيانات حسابه تلقائياً — تظهر له للتأكيد في الواجهة. */
  const memberPayer = { name: req.user.name || '', wallet: req.user.phone || req.user.contact || '', fp: sha256hex(clientIp(req) + '|' + String(req.headers['user-agent'] || '')).slice(0, 32) };
  const r = await applyClientPayment(b, kind, ref, memberPayer);
  if (r.error) return res.status(400).json({ error: r.error });
  // ربط الدفعة بالتزامها المالي (ادعاء بمرجع — التأكيد بعوامل أخرى كما هو
  // موثق) — عبر الرابط الموثّق: لا ابتلاع صامت لأي فشل (إصلاح حي ٢).
  const linked = await linkObligationClaim(r.booking, kind, ref, 'user', memberPayer);
  res.json({ booking: await bookingView(r.booking, req.user), obligation_linked: linked });
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
  await notify(b.client_id, 'booking', `حجز #${b.id}: المنفذ قدم إثبات التنفيذ (معاينة) — أكّد الاستلام أو افتح نزاعاً خلال ٢٤ ساعة؛ سكوتك الكامل ٢٤ ساعة يُعتبَر تأكيد استلام بقاعدة Deal وتتفتح خطوة دفع الباقي`, `booking:${b.id}`);
  res.json({ booking: await bookingView(await getBooking(b.id), req.user) });
});

/* معاينة أولية للصفقات الكبيرة (٦-أ): المنفذ يقدّمها بعد دفعة البداية،
   وتسويتها لالتزام العربون الأول تتم هنا (لا عند الإثبات النهائي). */
app.post('/api/bookings/:id/initial-proof', auth, async (req, res) => {
  const { url } = req.body || {};
  const b = await getBooking(+req.params.id);
  if (!b || b.talent_id !== req.user.id) return res.status(403).json({ error: 'المعاينة الأولية من المنفذ فقط' });
  if (!isSplitDeposit(b)) return res.status(400).json({ error: 'حجزك بعربون واحد — لا معاينة أولية' });
  if (b.status !== 'in_progress') return res.status(400).json({ error: 'الحجز ليس في مرحلة التنفيذ' });
  if (b.initial_proof_url) return res.status(400).json({ error: 'قدّمت المعاينة الأولية من قبل' });
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'رابط غير صحيح' });
  let ok = false;
  try { const r = await fetch(url, { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 (DealProof)' }, redirect: 'follow', signal: AbortSignal.timeout(8000) }); ok = r.status === 200; } catch (e) { ok = false; }
  if (!ok) return res.status(400).json({ error: 'تعذر التحقق: الرابط لا يعمل أو غير علني (لازم HTTP 200)' });
  await db.prepare(`UPDATE bookings SET initial_proof_url=?, initial_proof_at=?, initial_proof_check='verified' WHERE id=?`).run(url, now(), b.id);
  try { await settleLegObligation(b.id, 'booking_deposit', 'قدّم المنفذ المعاينة الأولية'); } catch (e) { /* لا يعطّل */ }
  await addBookingEvent(b.id, 'initial_proof', 'قدّم المنفذ معاينة أولية — بانتظار تأكيد العميل لتتفتح دفعة العربون الثانية (٢٥٪)');
  if (b.client_id) await notify(b.client_id, 'booking', `حجز #${b.id}: وصلتك معاينة أولية من المنفذ — أكّدها من صفحة الحجز لتتفتح دفعة العربون الثانية`, `booking:${b.id}`);
  res.json({ booking: await bookingView(await getBooking(b.id), req.user) });
});
async function applyConfirmInitial(b) {
  if (!isSplitDeposit(b)) return { error: 'حجز بعربون واحد — لا معاينة أولية' };
  if (b.status !== 'in_progress' || !b.initial_proof_url) return { error: 'لا توجد معاينة أولية بانتظار التأكيد' };
  if (b.initial_confirmed_at) return { error: 'أكّدت المعاينة الأولية من قبل' };
  await db.prepare(`UPDATE bookings SET initial_confirmed_at=?, status='awaiting_deposit2' WHERE id=?`).run(now(), b.id);
  await addBookingEvent(b.id, 'initial_confirmed', 'أكّد العميل المعاينة الأولية — اتفتحت دفعة العربون الثانية (٢٥٪) بمهلة دفع ٣ ساعات');
  await notify(b.talent_id, 'booking', `حجز #${b.id}: العميل أكد المعاينة الأولية — دفعة العربون الثانية (٢٥٪) اتفتحت وبانتظار دفعها`, `booking:${b.id}`);
  return { booking: await getBooking(b.id) };
}
app.post('/api/bookings/:id/confirm-initial', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.client_id !== req.user.id) return res.status(403).json({ error: 'التأكيد من العميل فقط' });
  const r = await applyConfirmInitial(b);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await bookingView(r.booking, req.user) });
});
app.post('/api/guest/:token/confirm-initial', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const r = await applyConfirmInitial(b);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await guestBookingView(r.booking) });
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
  await addBookingEvent(b.id, 'arbitration_scope', '⚖️ نطاق التحكيم: يُحسَم هذا النزاع من سجلات هذا الحجز داخل Deal فقط (المحادثة + الإيصالات + الأحداث الموقوتة). أي اتفاق خارج المنصة لا يتم، والمنصة غير ملزمة بيه — لا يُستند لأي اتفاق جانبي خارجي في التحكيم ولا يمنح أي حق في خدمات المنصة');
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

/* ---------------- طلب مراجعة الإفراج (نموذج Deal) ----------------
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
  /* مهلة إعادة التحكيم (Deal): من ألغى تحكيمه بنفسه لا يفتح آخر على نفس
     الحجز قبل ٥ دقائق من إلغائه. */
  const lastCancelled = await db.prepare(`SELECT * FROM release_appeals WHERE booking_id=? AND status='cancelled_by_talent' ORDER BY id DESC LIMIT 1`).get(b.id);
  if (lastCancelled && lastCancelled.decided_at && now() - lastCancelled.decided_at < REAPPEAL_COOLDOWN_MS) {
    const leftMin = Math.ceil((REAPPEAL_COOLDOWN_MS - (now() - lastCancelled.decided_at)) / 60000);
    return res.status(400).json({ error: `ألغيت تحكيمك بنفسك من شوية — تقدر تفتح تحكيماً جديداً بعد ${leftMin} دقيقة (مهلة Deal ٥ دقائق)`, reappeal_in_ms: REAPPEAL_COOLDOWN_MS - (now() - lastCancelled.decided_at) });
  }
  const waited = now() - b.proof_at;
  if (waited < APPEAL_AFTER_MS) {
    const leftMin = Math.ceil((APPEAL_AFTER_MS - waited) / 60000);
    return res.status(400).json({ error: `طلب المراجعة يفتح بعد ٣ ساعات من تسليم الإثبات — باقي ${leftMin} دقيقة`, appeal_in_ms: APPEAL_AFTER_MS - waited });
  }
  const info = await db.prepare('INSERT INTO release_appeals (booking_id,talent_id,phase,phase_deadline,created_at) VALUES (?,?,?,?,?)').run(b.id, req.user.id, 'negotiation', now() + NEGOTIATION_MS, now());
  const appeal = await db.prepare('SELECT * FROM release_appeals WHERE id=?').get(info.lastInsertRowid);
  await addBookingEvent(b.id, 'appeal_opened', 'فُتح تحكيم (طلب مراجعة إفراج) — طور تفاوض ١٠ دقائق بين الطرفين أولاً (نظام Deal)');
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
  if (String(comment).length > 200) return res.status(400).json({ error: 'نص التقييم أطول من ٢٠٠ حرف' });
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
  const managedReq = (req.body || {}).managed ? 1 : 0;
  const templateKey = String((req.body || {}).template_key || '').slice(0, 40);
  // دولة الطلب وعملته من حساب الناشر نفسه (مشتقة من دولته) — لا من العميل.
  const info = await db.prepare('INSERT INTO shop_requests (shop_user_id,title,niche,city,budget,currency,details,country,urgent,managed,template_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, title, niche, city || req.user.city, budget, req.user.currency || 'EGP', details, req.user.country || 'EG', urgent ? 1 : 0, managedReq, templateKey, now());
  if (managedReq) {
    await notifyOwner('managed_request', `🛎️ طلب «Deal بلس» مُدار جديد #${info.lastInsertRowid} من العضو ${req.user.name} — ${niche} · ميزانية ${budget} ${req.user.currency || 'EGP'} — في طابور الطلبات المُدارة بلوحتك`, `request:${info.lastInsertRowid}`);
    return res.json({ id: info.lastInsertRowid, managed: true, message: 'طلبك بقى «Deal بلس» — فريق Deal هيديره بالكامل' });
  }
  try { await matchRequest(await db.prepare('SELECT * FROM shop_requests WHERE id=?').get(info.lastInsertRowid)); } catch (e) { /* المطابقة لا تعطّل إنشاء الطلب أبداً */ }
  res.json({ id: info.lastInsertRowid });
});
app.get('/api/requests', async (req, res) => {
  // رقم هاتف الضيف لا يظهر لأي صانع/مقدم خدمة (التواصل داخل المنصة فقط) — المالك المؤسس وحده يراه
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = token && await db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  const sUser = s ? await db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id) : null;
  const rows = await db.prepare(`SELECT r.id, r.shop_user_id, r.title, r.niche, r.city, r.budget, r.currency, r.details, r.status, r.created_at, r.is_guest, r.guest_phone, r.country, r.urgent, COALESCE(u.name, r.guest_name) AS shop_name FROM shop_requests r LEFT JOIN users u ON u.id=r.shop_user_id WHERE r.status='open' AND r.target_talent_id IS NULL AND r.managed=0 ORDER BY r.urgent DESC, r.created_at DESC`).all();
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
  const reqs = (await db.prepare(`SELECT * FROM shop_requests WHERE status='open' AND managed=0 AND (target_talent_id IS NULL OR target_talent_id=?)`).all(req.user.id))
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
   العميل (أي شخص عاوز خدمة: فرد أو مناسبة أو محل أو براند) ينشر طلبه كضيف:
   بلا حساب وبلا كلمة سر. هويته في المتابعة
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
  const managedReq = (req.body || {}).managed ? 1 : 0; // مدخل «Deal بلس»: إدارة كاملة من المنصة
  const templateKey = String((req.body || {}).template_key || '').slice(0, 40);
  // جلسة عضو قائمة = القناة مغلقة لهذا الطلب أصلاً (الرفض على الخادم، والواجهة
  // تعطّل النموذج للمسجلين أيضاً) — التصفح العام وحده يبقى مفتوحاً للجميع.
  if (await optionalViewer(req)) return res.status(403).json({ error: GUEST_SESSION_ERR });
  if (!business_name || !String(business_name).trim()) return res.status(400).json({ error: 'اسمك أو اسم نشاطك مطلوب' });
  // دولة العميل الضيف (افتراضي مصر): عملة الطلب تُشتق من الدولة. لا هاتف في
  // هذه القناة إطلاقاً (أُزيل الحقل بقرار المستخدم) — التواصل والمتابعة من
  // صفحة الرمز داخل المنصة فقط. المسار الدولي العام (OTHER): عملة من قائمة
  // ISO المدمجة يختارها الضيف، وتُحفظ عملة الطلب بها.
  const guestCountry = countryOf((req.body || {}).country || 'EG');
  if (!guestCountry) return res.status(400).json({ error: 'دولة غير مدعومة حالياً' });
  let guestCurrency = guestCountry.currency;
  if (guestCountry.code === 'OTHER') {
    const reqCur = String((req.body || {}).currency || '').toUpperCase();
    if (reqCur && !isIntlCurrency(reqCur)) return res.status(400).json({ error: 'اختر عملة طلبك من القائمة', currency_required: true });
    guestCurrency = reqCur || 'USD';
  }
  /* بيانات الضيف الخفيفة (٨-د): رقم موبايل إلزامي يُطبَّع بقواعد دولة الضيف
     ويُحفظ خادمياً فقط — لا يظهر لأي صانع في أي رد (المسلسلات القائمة تحجبه). */
  const rawGuestPhone = String((req.body || {}).phone || '').trim();
  if (!rawGuestPhone) return res.status(400).json({ error: 'رقم الموبايل مطلوب لمتابعة طلبك والوصول إليك عند الحاجة', phone_required: true });
  const guestPhoneNorm = normalizePhoneForCountry(rawGuestPhone, guestCountry.code);
  if (!guestPhoneNorm) return res.status(400).json({ error: phoneErrorFor(guestCountry) });
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
    if (onVacation(target)) return res.status(400).json({ error: 'الصانع المستهدف في إجازة حالياً — الطلبات الموجهة له متوقفة مؤقتاً' });
  }
  const fp = guestFingerprint(req);
  const openCount = (await db.prepare(`SELECT COUNT(*) c FROM shop_requests WHERE is_guest=1 AND guest_fp=? AND status='open'`).get(fp)).c;
  if (openCount >= GUEST_OPEN_LIMIT) return res.status(429).json({ error: 'عندك طلبات مفتوحة كتير — استنى لما طلب يتقفل الأول · Too many open requests — please wait until one of them closes' });
  const token = rnd(24);
  const urgent = (req.body || {}).urgent ? 1 : 0;
  const info = await db.prepare(`INSERT INTO shop_requests (shop_user_id,title,niche,city,budget,currency,details,status,is_guest,guest_name,guest_phone,guest_fp,guest_token,target_talent_id,country,urgent,managed,template_key,created_at) VALUES (NULL,?,?,?,?,?,?,'open',1,?,?,?,?,?,?,?,?,?,?)`)
    .run(title && String(title).trim() ? String(title).trim() : `طلب إعلان — ${String(business_name).trim()}`, niche, city, +budget, guestCurrency, details, String(business_name).trim(), guestPhoneNorm, fp, token, targetId, guestCountry.code, urgent, managedReq, templateKey, now());
  if (managedReq) {
    // طلب «Deal بلس» المُدار: لا يُطرح في السوق ولا يدخل المطابقة — يروح
    // لطابور المالك مباشرة مع إشعار فوري، والعميل يعرف أن الفريق سيدير طلبه.
    await notifyOwner('managed_request', `🛎️ طلب «Deal بلس» مُدار جديد #${info.lastInsertRowid} من «${String(business_name).trim()}» — ${niche} · ${city} · ميزانية ${+budget} ${guestCurrency} — في طابور الطلبات المُدارة بلوحتك`, `request:${info.lastInsertRowid}`);
    return res.json({ id: info.lastInsertRowid, token, follow: `/#/g/${token}`, managed: true, message: 'طلبك بقى «Deal بلس» — فريق Deal هيديره بالكامل وهيتواصل معاك من صفحة متابعتك هنا' });
  }
  try { await matchRequest(await db.prepare('SELECT * FROM shop_requests WHERE id=?').get(info.lastInsertRowid)); } catch (e) { /* المطابقة لا تعطّل إنشاء الطلب أبداً */ }
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
  if (!(await requireVerifiedEmail(req, res))) return;
  if (!['creator', 'provider'].includes(req.user.role)) return res.status(400).json({ error: 'تحويل الطلبات للصناع ومقدمي الخدمة فقط' });
  if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس — عرض فقط ولا يقبل حجوزات أو تواصلاً' });
  if (req.user.penalty_level === 'suspended' || req.user.frozen) return res.status(403).json({ error: 'حسابك معلّق حالياً ولا يستقبل حجوزات' });
  if (onVacation(req.user)) return res.status(400).json({ error: 'أنت في وضع إجازة — أوقف الإجازة أولاً لتحويل طلبات' });
  const { price, deadline_days = 7, package_tier = null } = req.body || {};
  const agrGB = agreementFromBody(req.body || {}); if (agrGB.error) return res.status(400).json({ error: agrGB.error });
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
    let p = price != null ? +price : (rq.budget || effectivePrice(req.user));
    let pkgTier = null;
    if (package_tier != null && package_tier !== '') {
      const pkg = await packagePrice(req.user.id, package_tier);
      if (!pkg) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'باقة غير متاحة عندك' }); }
      p = pkg.price; pkgTier = pkg.tier;
    }
    if (!p || p <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'حدد سعراً صحيحاً' }); }
    // بوابة الهوية المالية (محرك المخاطر الحي): المنفذ هنا هو صاحب الحساب
    // الوحيد (العميل ضيف بلا حساب — هويته تُسجَّل عند كل إعلان دفع أصلاً).
    const gateGB = await riskGateError(req.user, null, p);
    if (gateGB) { await client.query('ROLLBACK'); return res.status(403).json({ error: gateGB, fin_identity_required: true }); }
    const ins = await client.query(
      `INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,guest_name,guest_phone,guest_token,urgent,package_tier,agreed_revisions,agreed_delivery_at,created_at)
       VALUES (NULL,$1,'guest_request',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [req.user.id, rq.id, rq.title, p, rq.currency, now() + deadline_days * 24 * 3600 * 1000, rq.guest_name, rq.guest_phone, rq.guest_token, rq.urgent ? 1 : 0, pkgTier, agrGB.revisions, agrGB.deliveryAt, now()]);
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
  // قائمة الانتظار: تحويل طلب منتظر عند هذا الصانع يختم دخوله «converted».
  try { await db.prepare(`UPDATE waitlist_entries SET status='converted' WHERE request_id=? AND talent_id=? AND status IN ('waiting','offered')`).run(+req.params.id, req.user.id); } catch (e) { /* لا يعطّل التحويل */ }
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
  /* حالة شروط المعاملات لعرض الضيف: مشاهِد صفحة الرمز هو جانب العميل نفسه،
     فيُرفَق علم قبوله هو (mine_accepted = client_accepted) تناظراً مع
     bookingView — بدونه كانت الصفحة عمياء عن قبول صاحبها: يبقى زر القبول
     ظاهراً بعد القبول فلا يعرف الضيف أن قبوله سُجّل ولا أيَّ جانبٍ ينقص
     (إصلاح منقول حرفياً من شجرة الإنتاج — TESTING-TERMS-GATE-FIX.md). */
  const gTerms = await termsStateFor(b);
  gTerms.mine_accepted = gTerms.client_accepted;
  const gAm = bookingLegAmounts(b);
  return {
    id: b.id, title: b.title, price: b.price, currency: b.currency, status: b.status,
    order_state: orderStateFor(b),
    fee_status: b.fee_status, agreed_client: !!b.agreed_client, agreed_talent: !!b.agreed_talent,
    fee, net, deposit: half, rest: half,
    deposit_split: gAm.split, dep1: gAm.dep1, dep2: gAm.dep2,
    initial_proof_url: b.initial_proof_url || '', initial_proof_at: b.initial_proof_at || 0, initial_confirmed_at: b.initial_confirmed_at || 0,
    agreed_revisions: b.agreed_revisions !== undefined ? b.agreed_revisions : null, agreed_delivery_at: b.agreed_delivery_at || 0,
    talent_record: await talentRecordFor(b.talent_id),
    city_ambassador: await bookingCityAmbassador(b),
    arbitration_decided: await guestArbitrationDecided(b),
    proof_url: b.proof_url, proof_check: b.proof_check, proof_at: b.proof_at || 0, created_at: b.created_at,
    receipt_confirmed_at: b.receipt_confirmed_at || 0, receipt_auto: !!b.receipt_auto,
    urgent: !!b.urgent,
    chat_unread: (await db.prepare(`SELECT COUNT(*) c FROM guest_messages WHERE booking_id=? AND sender='talent' AND is_read=0`).get(b.id)).c,
    final_delivered_at: b.final_delivered_at || 0, final_confirmed_at: b.final_confirmed_at || 0, final_auto: !!b.final_auto,
    appeal: appealView(await openAppealFor(b.id)),
    terms: gTerms,
    events: await bookingEvents(b.id),
    deemed_at: b.deemed_at || 0,
    final_obligation_status: await (async () => { const o = await finalObligation(b.id); return o ? o.status : null; })(),
    has_dispute: !!(await db.prepare('SELECT id FROM disputes WHERE booking_id=? LIMIT 1').get(b.id)),
    talent: await publicUser(await getUser(b.talent_id)),
    reviewed: !!myReview,
    tips: await tipsOf(b.id),
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
  const stageFor = { booking_deposit: ['awaiting_deposit', 'awaiting_deposit2'], booking_final: ['awaiting_rest', 'proof_submitted'] };
  if (!stageFor[kind]) return res.status(400).json({ error: 'نوع التزام غير صحيح' });
  const amounts = bookingLegAmounts(b);
  const stageBase = kind !== 'booking_deposit' ? amounts.rest : !amounts.split ? amounts.deposit : (b.status === 'awaiting_deposit2' ? amounts.dep2 : amounts.dep1);
  const existing = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND base_amount=? AND status IN ('open','claimed','confirmed','auto_confirmed') AND is_difference=0 AND is_refund=0 ORDER BY id DESC LIMIT 1`).get(kind, b.id, stageBase);
  if (!existing && !stageFor[kind].includes(b.status)) return res.status(400).json({ error: 'خطوة الدفع ليست مفتوحة الآن' });
  const ob = existing || await getOrCreateObligation({
    kind, booking_id: b.id, user_id: b.talent_id,
    base_amount: stageBase, currency: b.currency,
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
  const r = await applyAgree(b, 'client', { guestToken: req.params.token });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await guestBookingView(r.booking) });
});

app.post('/api/guest/:token/terms-accept', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const st = await acceptTermsAndAgree(b, 'client', { guestToken: req.params.token });
  res.json({ terms: st, booking: await guestBookingView(await getBooking(b.id)) });
});

app.post('/api/guest/:token/pay', async (req, res) => {
  const { kind, ref } = req.body || {};
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  if (!ref) return res.status(400).json({ error: 'مرجع العملية مطلوب' });
  /* هوية الدافع الضيف (٨-ج): اسم كامل + رقم المحفظة التي حوّل منها فعلياً —
     التحويل من محفظة باسمك شرط لقبول الإدعاء. */
  const payerName = String((req.body || {}).payer_name || '').trim();
  const payerWallet = String((req.body || {}).payer_wallet || '').trim();
  if (!payerName || payerName.split(/\s+/).filter(Boolean).length < 2) return res.status(400).json({ error: 'اسمك الكامل مطلوب عند إعلان الدفع', payer_identity_required: true });
  if (payerWallet.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'رقم المحفظة التي حوّلت منها مطلوب — التحويل من محفظة باسمك شرط لقبول الإدعاء', payer_identity_required: true });
  const guestPayer = { name: payerName, wallet: payerWallet, fp: guestFingerprint(req) };
  if (!(await termsGateOpen(b))) return res.status(403).json({ error: 'خطوات الدفع مقفلة حتى يقبل الطرفان «شروط المعاملات» — اقرأها ووافق عليها أولاً من صفحة متابعتك', terms_required: true, terms: await termsStateFor(b) });
  const r = await applyClientPayment(b, kind, ref, guestPayer);
  if (r.error) return res.status(400).json({ error: r.error });
  // ربط الدفعة بالتزامها المالي عبر الرابط الموثّق — لا ابتلاع صامت (إصلاح حي ٢).
  const linked = await linkObligationClaim(r.booking, kind, ref, 'guest', guestPayer);
  /* مطابقة لينة (٨-ج × ٨-د): محفظة مختلفة عن رقم الطلب لا تُرفض (مرونة) —
     تُوثَّق وتُبلَّغ للمالك كاحتمال دفع من طرف ثالث لمراجعته. */
  try {
    const reqDigits = String(b.guest_phone || '').replace(/\D/g, ''), walDigits = payerWallet.replace(/\D/g, '');
    if (reqDigits && walDigits && !reqDigits.endsWith(walDigits.slice(-9)) && !walDigits.endsWith(reqDigits.slice(-9))) {
      await addBookingEvent(b.id, 'payer_wallet_mismatch', 'محفظة الدافع المُعلنة تختلف عن رقم موبايل الطلب — وُثّقت للمراجعة (احتمال دفع من طرف ثالث)');
      await notifyOwner('payer_mismatch', `حجز #${b.id}: محفظة الدافع الضيف تختلف عن رقم الطلب — راجع هوية الدافع في حزمة الأدلة`, `booking:${b.id}`);
    }
  } catch (e) { /* التوثيق لا يعطّل الدفع */ }
  res.json({ booking: await guestBookingView(r.booking), obligation_linked: linked });
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
  if (String(comment).length > 200) return res.status(400).json({ error: 'نص التقييم أطول من ٢٠٠ حرف' });
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
  const msgs = rows.map((m) => ({ id: m.id, sender: m.sender, body: m.body, created_at: m.created_at, is_read: !!m.is_read, kind: m.kind || 'text', media_url: m.media_url || '', duration_sec: m.duration_sec || 0 }));
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
  const voice = voicePayload(req);
  if (voice) {
    if (voice.error) return res.status(400).json({ error: voice.error });
    const ts = now();
    const info = await db.prepare(`INSERT INTO guest_messages (booking_id,sender,body,created_at,kind,media_url,duration_sec) VALUES (?,'guest',?,?,?,?,?)`).run(b.id, voice.caption, ts, 'voice', voice.media_url, voice.duration_sec);
    await notify(b.talent_id, 'guest_message', `🎙️ رسالة صوتية جديدة من عميل حجز #${b.id} جوه المنصة — افتح الحجز للاستماع`, `booking:${b.id}`);
    return res.json({ ok: true, message: { id: info.lastInsertRowid, sender: 'guest', body: voice.caption, created_at: ts, kind: 'voice', media_url: voice.media_url, duration_sec: voice.duration_sec } });
  }
  const v = guestChatBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = now();
  const info = await db.prepare(`INSERT INTO guest_messages (booking_id,sender,body,created_at) VALUES (?,'guest',?,?)`).run(b.id, v.body, ts);
  // كشف تسرّب خارج المنصة: الرسالة تُحفظ كما هي (في سجل الأدلة) والرصد يضيف
  // تحذيراً وتوثيقاً فقط — الضيف بلا حساب فلا علامة سلوك له.
  const leak = detectOffPlatformLeak(v.body);
  if (leak) await enforceOffPlatformLeak(b, null, leak);
  await notify(b.talent_id, 'guest_message', `💬 رسالة جديدة من عميل حجز #${b.id} جوه المنصة — افتح الحجز للرد`, `booking:${b.id}`);
  res.json({ ok: true, message: { id: info.lastInsertRowid, sender: 'guest', body: v.body, created_at: ts }, ...(leak ? { off_platform_warning: OFF_PLATFORM_RULE_TEXT } : {}) });
});
/* «اطلب تاني» للضيف: من صفقة مكتملة يُفتح طلب جديد موجّه لنفس المنفّذ بنفس
   البيانات الأساسية (قابلة للتعديل في جسم الطلب) وبرمز متابعة جديد. */
app.post('/api/guest/:token/order-again', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  if (b.status !== 'completed') return res.status(400).json({ error: 'إعادة الطلب من صفقة مكتملة فقط' });
  const orig = b.ref_id ? await db.prepare('SELECT * FROM shop_requests WHERE id=?').get(b.ref_id) : null;
  const token = rnd(24);
  const budget = (req.body && +req.body.budget > 0) ? +req.body.budget : (orig ? orig.budget : b.price);
  const details = (req.body && String(req.body.details || '').trim()) || (orig ? orig.details : b.title);
  const info = await db.prepare(`INSERT INTO shop_requests (shop_user_id,title,niche,city,budget,currency,details,status,is_guest,guest_name,guest_phone,guest_fp,guest_token,target_talent_id,country,urgent,created_at) VALUES (NULL,?,?,?,?,?,?,'open',1,?,?,?,?,?,?,?,?)`)
    .run(`طلب إعلان — ${b.guest_name || 'عميل'}`, orig ? orig.niche : '', orig ? orig.city : '', budget, b.currency, details, b.guest_name || '', b.guest_phone || '', guestFingerprint(req), token, b.talent_id, orig ? orig.country : 'EG', 0, now());
  try { await matchRequest(await db.prepare('SELECT * FROM shop_requests WHERE id=?').get(info.lastInsertRowid)); } catch (e) { /* لا يعطّل */ }
  res.json({ id: info.lastInsertRowid, token, follow: `/#/g/${token}` });
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
  const voice = voicePayload(req);
  if (voice) {
    if (voice.error) return res.status(400).json({ error: voice.error });
    const ts = now();
    const info = await db.prepare(`INSERT INTO guest_messages (booking_id,sender,body,created_at,kind,media_url,duration_sec) VALUES (?,'talent',?,?,?,?,?)`).run(b.id, voice.caption, ts, 'voice', voice.media_url, voice.duration_sec);
    return res.json({ ok: true, message: { id: info.lastInsertRowid, sender: 'talent', body: voice.caption, created_at: ts, kind: 'voice', media_url: voice.media_url, duration_sec: voice.duration_sec } });
  }
  const v = guestChatBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = now();
  const info = await db.prepare(`INSERT INTO guest_messages (booking_id,sender,body,created_at) VALUES (?,'talent',?,?)`).run(b.id, v.body, ts);
  // كشف تسرّب خارج المنصة: تحذير نظامي فوري + علامة سلوك على العضو المرسل.
  const leak = detectOffPlatformLeak(v.body);
  if (leak) await enforceOffPlatformLeak(b, req.user.id, leak);
  res.json({ ok: true, message: { id: info.lastInsertRowid, sender: 'talent', body: v.body, created_at: ts }, ...(leak ? { off_platform_warning: OFF_PLATFORM_RULE_TEXT } : {}) });
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
  const agrC = agreementFromBody(req.body || {}); if (agrC.error) return res.status(400).json({ error: agrC.error });
  // بوابة الهوية المالية (محرك المخاطر الحي) على طرفي حجز الحملة.
  const gateC = await riskGateError(req.user, applicant, c.budget || (applicant ? applicant.price : 0));
  if (gateC) return res.status(403).json({ error: gateC, fin_identity_required: true });
  const info = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,agreed_revisions,agreed_delivery_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, a.creator_id, 'campaign', c.id, c.title, c.budget || (await getUser(a.creator_id)).price, c.currency, now() + 7 * 24 * 3600 * 1000, agrC.revisions, agrC.deliveryAt, now());
  await db.prepare(`UPDATE campaign_applications SET status='accepted', booking_id=? WHERE id=?`).run(info.lastInsertRowid, a.id);
  await notify(a.creator_id, 'booking_new', `براند «${req.user.name}» قبل تقديمك — حجز #${info.lastInsertRowid} اتفتح`, `booking:${info.lastInsertRowid}`);
  res.json({ booking_id: info.lastInsertRowid });
});

/* ---------------- notifications ---------------- */
app.get('/api/notifications', auth, async (req, res) => {
  const items = await db.prepare('SELECT * FROM notifications WHERE user_id=? AND (deliver_after=0 OR deliver_after<=?) ORDER BY created_at DESC LIMIT 50').all(req.user.id, now());
  const unread = (await db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0 AND (deliver_after=0 OR deliver_after<=?)').get(req.user.id, now())).c;
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
    a_ar: 'كل خطوة دفع لها مهلة ٣ ساعات بعدّاد حي (نظام Deal) وانتهاؤها بلا إعلان دفع يلغي الطلب تلقائياً بلا حركة مال. بعد العمولة (10%)، يدفع العميل 45% من السعر عربوناً للصانع مباشرة فيبدأ التنفيذ — وفي الصفقات الأكبر من 1000 يتقسم العربون دفعتين: 20% عند بدء التنفيذ ثم 25% بعد ما يقدّم المنفذ معاينة أولية ويؤكدها العميل. وبعد تأكيد استلام المعاينة (أو اعتماد الاستلام بقاعدة سكوت ٢٤ ساعة أو قرار تحكيم) يحوّل العميل الـ45% الأخيرة للصانع مباشرة، ولا تُسلَّم النسخة النهائية إلا بعد تأكيد قبض الباقي — فيصل للصانع صافيه كاملاً (90%): العميل لا يخسر باقيه قبل ما يستلم، والمنفذ لا يسلّم النسخة النهائية إلا بعد تأكيد قبض باقيه — الحماية في آلية الشغل نفسها.',
    a_en: 'Every payment step has a 3-hour deadline with a live countdown (Deal\'s system); expiry with no payment declared cancels the order automatically with no money moving. After the 10% fee, the client pays 45% of the price directly to the creator as a deposit so work starts — and on deals over 1000 the deposit splits into two instalments: 20% when execution starts, then 25% after the provider submits an initial preview and the client confirms it. After preview receipt is confirmed (or deemed confirmed by the 24-hour silence rule, or decided by arbitration) the client transfers the final 45% directly to the creator — with the final copy delivered only after receipt of the rest is confirmed — so the creator receives the full net (90%): the client never loses the rest before receiving, and the provider never hands over the final copy before confirming receipt of the rest — the protection is in the work mechanism itself.' },
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
    a_ar: 'بنظام Deal نفسه: إن سكت العميل ٢٤ ساعة بعد وصول إثبات تنفيذ سليم، يُعتبَر الاستلام مؤكداً تلقائياً (استلام مُعتبَر) وتتفتح خطوة دفع الباقي للمنفذ مباشرة — وأثناء المهلة تصلك تنبيهات متدرجة: عند وصول الإثبات، وفي منتصف المهلة (١٢ ساعة)، وقبل الاعتماد بساعة تحذير أخير. في أي لحظة قبل الاعتماد: تأكيدك بنفسك يغلق فوراً، ونزاعك يجمّد كل شيء ويوقف القاعدة نهائياً، وردّك بملاحظة أو رسالة يعني أنك لست ساكتاً فالمسار يبقى التحكيم: الصانع يقدر بعد ٣ ساعات من الإثبات يطلب تحكيماً يبدأ بطور تفاوض ١٠ دقائق بينكما ثم يحسم المالك من حزمة الأدلة (إفراج أو رد) — وللمالك حق عكس أي اعتماد استلام مُعتبَر عند ثبوت احتيال أو خطأ.',
    a_en: 'Exactly Deal\'s own rule: if the client stays silent for 24 hours after a valid proof of delivery, receipt is deemed confirmed automatically and the rest-payment step to the provider opens — with graduated reminders during the window: when the proof arrives, at its midpoint (12 hours), and a final warning one hour before. At any moment before that: confirming yourself closes it instantly, a dispute freezes everything and stops the rule permanently, and replying with a note or a message means you are not silent, so the path stays arbitration: 3 hours after the proof the creator can request arbitration, which starts with a 10-minute negotiation phase between you, then the owner decides from the evidence bundle (release or refund) — and the owner may reverse any deemed confirmation on proven fraud or error.' },
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
    keys: ['عضو مؤسس', 'مؤسس', 'اول 50', 'أول ٥٠', 'founding member', 'first 50', 'founder member'],
    a_ar: 'أول 50 صانع محتوى يسجلون على Deal يحصلون على شارة «عضو مؤسس» الدائمة في ملفهم — تمييز مبكر لا يُمنح لمن يسجل بعد اكتمال العدد.',
    a_en: 'The first 50 creators to register on Deal receive a permanent "Founding Member" badge on their profile — an early distinction that is not granted once the first fifty is complete.' },
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
    a_ar: 'Deal متاح الآن في 19 دولة عربية: مصر، السعودية، الإمارات، الكويت، قطر، الأردن، المغرب، البحرين، عُمان، العراق، الجزائر، تونس، لبنان، فلسطين، ليبيا، السودان، اليمن، سوريا، وموريتانيا. اختر دولتك عند التسجيل (أو في نموذج «طلب خدمة» كضيف) وسيظهر سعرك بعملة بلدك، ورقم هاتفك يُتحقق منه بقاعدة بلدك، والدفع المحلي عندك هو وسيلة التحويل المعروفة في بلدك (مثل فودافون كاش/إنستاباي في مصر، وSTC Pay/مدى في السعودية، وCliQ في الأردن). ولو دولتك مش في القائمة، التسجيل مفتوح من أي دولة في العالم: اختر «دولة أخرى» واكتب اسم دولتك واختر عملتك من القائمة وسجّل برقم هاتفك الدولي بأي كود دولة — ووسيلة الدفع عندها تُتفق داخل محادثة الحجز الموثقة.',
    a_en: 'Deal is now available in 19 Arab countries: Egypt, Saudi Arabia, UAE, Kuwait, Qatar, Jordan, Morocco, Bahrain, Oman, Iraq, Algeria, Tunisia, Lebanon, Palestine, Libya, Sudan, Yemen, Syria and Mauritania. Pick your country when you register (or in the guest "Request a service" form) and your price shows in your country\'s currency, your phone is validated by your country\'s rules, and payments use your local method (e.g. Vodafone Cash/InstaPay in Egypt, STC Pay/mada in Saudi Arabia, CliQ in Jordan). If your country is not listed, registration is open from anywhere in the world: choose "Other country", write your country\'s name, pick your currency from the list and register with your international phone number with any country code — the payment method is then agreed inside the documented booking chat.' },
  { id: 'password_recovery', q_ar: 'نسيت كلمة السر — كيف أستعيد حسابي؟', q_en: 'I forgot my password — how do I recover my account?',
    keys: ['نسيت كلمه السر', 'نسيت كلمة السر', 'استعاده الحساب', 'استرجاع الحساب', 'اكواد احتياطيه', 'كود التحقق', 'تغيير كلمه السر', 'forgot password', 'recover my account', 'backup codes', 'reset password', 'verification code'],
    a_ar: 'من شاشة الدخول اضغط «نسيت كلمة السر؟»: هيوصلك كود تحقق من ٦ أرقام على إيميلك (صالح ١٠ دقائق)، وبيه تعيّن كلمة سر جديدة — وبتتلغي جلساتك التانية تلقائياً وبيوصلك تنبيه أمني. ولو الإيميل مش متاح، استخدم واحداً من الأكواد الاحتياطية العشرة اللي ولّدتها من «أجهزتي وجلساتي» — كل كود بيشتغل مرة واحدة بس. ومن نفس القسم تقدر تشوف أجهزتك وجلساتك وتلغي أي جلسة غريبة.',
    a_en: 'From the sign-in screen tap "Forgot password?": a 6-digit verification code is emailed to you (valid 10 minutes) and with it you set a new password — your other sessions are revoked automatically and you get a security alert. If email is unavailable, use one of the ten backup codes you generated under "My devices & sessions" — each code works once only. From the same section you can review your devices and sessions and revoke any unfamiliar session.' },
  { id: 'off_platform', q_ar: 'هل أقدر أتفق مع الطرف التاني خارج المنصة؟', q_en: 'Can I agree with the other party outside the platform?',
    keys: ['اتفاق خارج', 'خارج المنصه', 'خارج المنصة', 'نتعامل بره', 'بره المنصه', 'واتساب بره', 'outside the platform', 'off-platform', 'deal outside', 'whatsapp outside'],
    a_ar: 'لأ — أي اتفاق خارج المنصة لا يتم، والمنصة غير ملزمة بيه: لا ضمان ولا تحكيم ولا حزمة أدلة ولا تقييم لأي اتفاق لم يُفتح ويُوثَّق كحجز داخل Deal. الحاجة الوحيدة اللي بتتم برّه هي تنفيذ التحويل نفسه من محفظتك؛ الاتفاق والإثبات والتأكيد والتسليم والتقييم والتحكيم كلها جوه المنصة إجبارياً. ومحاولة جرّ الطرف التاني لتعامل خارجي مخالفة بتتصعّد لحد الحظر.',
    a_en: 'No — any agreement outside the platform does not happen and the platform is not bound by it: no guarantee, arbitration, evidence bundle or rating for anything not opened and documented as a booking inside Deal. The only step that happens outside is executing the transfer itself from your wallet; the agreement, proof, confirmation, delivery, rating and arbitration are all mandatorily inside the platform. Trying to pull the other party into an outside deal is a violation that escalates up to a ban.' },
  { id: 'replacement_deterrence', q_ar: 'ما هو ضمان الاستبدال؟ وما عقوبات الإخلال؟', q_en: 'What is the replacement guarantee? What are the breach penalties?',
    keys: ['ضمان الاستبدال', 'الاستبدال', 'بديل', 'المنفذ اخلف', 'المنفذ ما سلمش', 'عقوبات', 'غرامه اخلال', 'تجميد الحساب', 'حظر نهائي', 'replacement guarantee', 'substitute', 'breach penalty', 'account frozen', 'lifetime ban'],
    a_ar: 'ضمان الاستبدال بيتفعّل في حالتين بس: المنفذ أعلن عدم قدرته، أو المنفذ سكت في محادثة الحجز يوماً كاملاً بعد قبض العربون رغم تنبيهين آليين. ومفيش موعد تسليم بتفرضه المنصة ولا عدّاد تسليم: التوقيت بتتفقوا عليه في محادثة الحجز، ولو حصل خلاف على التأخير فالتحكيم بيحسمه من أدلة المحادثة. ساعتها المنصة بتوفّر بديلاً واحداً موثّقاً من نفس مدينتك ومجالك بنفس السعر والشروط خلال يوم، وانت تقرر خلال ٣ ساعات؛ ولو مفيش بديل مناسب بيُردّ العربون كاملاً بقرار تحكيم خلال ٧٢ ساعة. والإخلال المالي بيجمّد الحساب آلياً مع علامة «مستحقات متأخرة» وغرامة إخلال ١٠٪ من قيمة الصفقة (تتضاعف عند التكرار)، والاحتيال = حظر نهائي للشخص نفسه. ولا استبدال بعد اعتماد المعاينة.',
    a_en: 'The replacement guarantee activates in only 2 cases: the provider declares inability, or the provider stays silent in the booking chat for a full day after receiving the deposit despite two automatic warnings. The platform imposes no delivery date and runs no delivery countdown: timing is agreed between you in the booking chat, and any dispute over delay is decided by arbitration on the chat evidence. The platform then offers exactly one verified substitute from your city and niche at the identical price and terms within a day, and you decide within 3 hours; with no suitable substitute, the deposit is refunded in full by an arbitration decision within 72 hours. Money breaches freeze the account automatically with a public "late dues" marker and a breach penalty of 10% of the deal value (doubling on repetition), and fraud means a lifetime ban of the person. No replacement after the preview is approved.' },
  { id: 'quotes', q_ar: 'كيف تعمل عروض الأسعار على طلبي؟', q_en: 'How do price quotes on my request work?',
    keys: ['عروض الاسعار', 'عرض سعر', 'عروض أسعار', 'اقارن العروض', 'اختار عرض', 'quotes', 'price quote', 'compare quotes', 'accept a quote'],
    a_ar: 'لما تنشر «طلب خدمة»، الصناع بيقدّموا عروض أسعار مكتوبة على طلبك نفسه: سعر + مدة تسليم + ملحوظة. العروض بتوصلك في صفحة متابعة طلبك (أو «طلباتي» لو عضو) وبتقارنها جنب بعض وتختار عرضاً واحداً — فيتحول لحجز عادي بضمان Deal وكل قواعده، وبقية العروض بتترفض آلياً برسالة مهذبة. وفيه حد أقصى لعدد العروض على الطلب الواحد ضد الإغراق.',
    a_en: 'When you post a "Request a service", creators submit written quotes on your request itself: price + delivery time + a note. Quotes reach you on your request follow-up page (or "My requests" if you are a member); you compare them side by side and pick one — it becomes a normal booking under the Deal Guarantee with all its rules, and the other quotes are auto-rejected with a polite message. There is a cap on quotes per request against spam.' },
  { id: 'packages_flash', q_ar: 'ما هي باقات الأسعار والعروض السريعة؟', q_en: 'What are pricing packages and flash offers?',
    keys: ['باقات الاسعار', 'باقات أسعار', 'باقه اساسيه', 'عرض سريع', 'خصم ٤٨', 'عروض سريعه', 'packages', 'pricing packages', 'flash offer', 'flash discount'],
    a_ar: 'الصانع يقدر يعرض ٣ باقات أسعار في ملفه (أساسية/متوسطة/شاملة — لكل واحدة اسم وسعر ووصف ومزايا)، واختيارك باقة عند الطلب بيملأ سعر الحجز منها تلقائياً. و«العرض السريع» خصم (نسبة أو سعر خاص) بيعلنه الصانع على خدمته لمدة يومين بعدّاد حي وشارة «عرض سريع» في السوق والملف — وسعر العرض هو اللي بيتبني عليه أي حجز أثناء سريانه، وبينتهي تلقائياً.',
    a_en: 'A creator can show 3 pricing packages on their profile (Basic/Standard/Premium — each with a name, price, description and features), and choosing a package when ordering fills the booking price from it automatically. A "flash offer" is a discount (percentage or special price) the creator runs on their service for 2 days with a live countdown and a "Flash offer" badge in the market and profile — the offer price is what bookings are built on while it runs, and it expires automatically.' },
  { id: 'waitlist_videos', q_ar: 'ما هي قائمة الانتظار وفيديوهات الشغل اليومية؟', q_en: 'What are the waitlist and daily work videos?',
    keys: ['قائمه الانتظار', 'قائمة الانتظار', 'الصانع مشغول', 'سعه الصانع', 'فيديوهات الشغل', 'فيديو يومي', 'شغل جديد', 'اطلب زي دي', 'waitlist', 'creator is busy', 'daily videos', 'new work', 'order like this'],
    a_ar: 'لو سعة الصانع اليومية كاملة، تقدر تنضم لقائمة انتظاره على طلبك: أول ما تتوفر سعة (إتمام/إلغاء حجز أو يوم جديد) بيتم تنبيه أول منتظر بالترتيب وتتحول فرصته لحجز عادي بمهلة قبول معقولة، وبعدها اللي بعده. وفيديوهات الشغل اليومية منشورات تضمين (يوتيوب/تيك توك فقط) بينشرها الصانع من شغله — بتظهر في ملفه وفي قسم «شغل جديد» بالسوق، وكل فيديو عليه زرار «اطلب زي دي» بيفتح طلباً موجهاً لصاحبه، ونشاط النشر بيرفع ظهور الصانع.',
    a_en: 'If a creator\'s daily capacity is full, you can join their waitlist on your request: as soon as capacity frees (a booking completes/cancels or a new day starts) the first waiter is notified in order and their slot becomes a normal booking with a reasonable acceptance window, then the next. Daily work videos are embeds (YouTube/TikTok only) creators post from their work — they appear on their profile and in the market\'s "New work" section, every video has an "Order like this" button opening a request targeted to its owner, and posting activity raises the creator\'s visibility.' },
  { id: 'contracts_challenge', q_ar: 'ما هو التعاقد الشهري وتحدي الأسبوع؟', q_en: 'What are monthly contracts and the weekly challenge?',
    keys: ['تعاقد شهري', 'عقد شهري', 'تجديد شهري', 'تحدي الاسبوع', 'صانع الأسبوع', 'صانع الاسبوع', 'monthly contract', 'recurring', 'weekly challenge', 'creator of the week'],
    a_ar: 'التعاقد الشهري اتفاق بينك وبين صانع (خدمة + عدد مرات في الشهر + سعر الدورة) بيقبله الطرفان بقبول شروط مسجل، وكل دورة شهرية بتتولد تلقائياً كحجز عادي بكل حماية Deal وقواعدها — وأي طرف يقدر يوقف التجديد بإشعار مسبق فتكتمل الدورة الجارية بس. و«تحدي الأسبوع» لوحة آلية من بيانات حقيقية (صفقات مكتملة + فيديوهات منشورة)، ومتصدّر الأسبوع بيُتوَّج «صانع الأسبوع» بشارة في ملفه وظهور مميز في السوق أسبوعاً كاملاً.',
    a_en: 'A monthly contract is an agreement between you and a creator (service + times per month + cycle price) both parties accept with recorded terms acceptance, and every monthly cycle auto-generates as a normal booking with all of Deal\'s protection and rules — either party can stop renewal with advance notice and only the current cycle completes. The "Weekly Challenge" is an automatic board from real data (completed deals + published videos), and the week\'s leader is crowned "Creator of the Week" with a profile badge and featured market placement for a week.' },
  { id: 'tips_vacation_qa', q_ar: 'ما هي الإكرامية ووضع الإجازة وأسئلة الملف؟', q_en: 'What are tips, vacation mode and profile questions?',
    keys: ['اكراميه', 'إكرامية', 'بقشيش', 'وضع اجازه', 'في اجازه', 'اسئله الملف', 'اسال الصانع', 'tip', 'tipping', 'vacation mode', 'on vacation', 'profile questions', 'ask the creator'],
    a_ar: 'الإكرامية مبلغ تقدير اختياري بتقترحه بعد اكتمال الصفقة وبيوصل للمنفذ مباشرة بنفس آلية الدفع ومرجع فريد — بلا أي عمولة، وبيتسجل في السجل كإكرامية، ومش جزء من سعر الصفقة ولا بيأثر في أي نزاع. ووضع الإجازة بيوقّفه الصانع لفترة اختيارية: ملفه بيظهر «في إجازة حتى…»، والطلبات الموجهة له بتتوقف مؤقتاً، وحجوزاته الجارية ما بتتأثرش، وفترة الإجازة ما بتضرش نسبة إتمامه ولا شارة سرعة رده. وأسئلة الملف أسئلة علنية بيجاوب عليها الصانع علناً مرة واحدة في قسم بملفه.',
    a_en: 'A tip is an optional appreciation amount you offer after a deal completes; it reaches the provider directly with the same payment mechanism and a unique reference — with NO commission — recorded in the ledger as a tip; it is not part of the deal price and does not affect disputes. Vacation mode is set by the creator for a chosen period: their profile shows "On vacation until…", targeted requests pause, ongoing bookings are unaffected, and the vacation never hurts their completion rate or reply-speed badge. Profile questions are public questions the creator answers publicly once, in a section on their profile.' },
  { id: 'academy_plus', q_ar: 'ما هي أكاديمية Deal وخدمة Deal بلس؟', q_en: 'What are the Deal Academy and Deal Plus?',
    keys: ['اكاديميه', 'أكاديمية', 'مسارات تعليميه', 'شاره تاهيل', 'ديل بلس', 'اداره كامله', 'طلبات مداره', 'academy', 'learning tracks', 'qualification badge', 'deal plus', 'fully managed'],
    a_ar: 'أكاديمية Deal قسم تعليمي داخل المنصة للجميع ولكل الخدمات: مسارات قصيرة (عرض الشغل، التسعير والباقات، كسب العميل، التسليم وتجنب النزاعات، ومسارات بحسب فئات الخدمات، ومسار للعملاء لطلب أي خدمة بنجاح). كل مسار دروس قصيرة + مهمة «طبّق على ملفك» بتتحقق آلياً من فعل حقيقي، وعند الإكمال بتاخد شارة تأهيل بتظهر في ملفك وبتدخل في درجة ظهورك — وتقدمك بيتحفظ وتقدر تكمّل أي وقت. و«Deal بلس» اختيار في نموذج «طلب خدمة» (إدارة كاملة من Deal) بيحوّل طلبك لطابور الطلبات المُدارة عند فريق Deal بدل طرحه في السوق، وعند القبول بيُدار كحجز عادي بكل القواعد.',
    a_en: 'The Deal Academy is an in-platform learning section for everyone and all services: short tracks (showcasing work, pricing & packages, winning clients, delivery & avoiding disputes, tracks per service category, and a client track for ordering any service successfully). Each track has short lessons plus an "Apply it on your profile" task auto-verified from a real action, and on completion you earn a qualification badge that shows on your profile and feeds your visibility score — your progress is saved and resumable anytime. "Deal Plus" is an option in the "Request a service" form (full management by Deal) that routes your request to the Deal team\'s managed queue instead of the market, and once accepted it is run as a normal booking with all the rules.' },
  { id: 'summary_wall_seasons', q_ar: 'ما هو ملخص الصفقة وجدار الصفقات والأقسام الموسمية؟', q_en: 'What are the deal summary, deals wall and seasonal sections?',
    keys: ['ملخص صفقه', 'ملخص الصفقة', 'جدار الصفقات', 'صفقات تمت', 'اقسام موسميه', 'موسم رمضان', 'موسم العيد', 'deal summary', 'deals wall', 'completed deals', 'seasonal sections', 'ramadan season'],
    a_ar: 'بعد اكتمال أي صفقة، أي طرف يقدر يولّد «ملخص صفقة» — مستند بصري نظيف فيه الأطراف بأدوارهم والبنود والمبالغ بمراحلها والتواريخ والحالة (وهو ملخص من سجل المنصة، مش فاتورة). و«جدار صفقات تمت» قسم عام بيعرض آخر الصفقات المكتملة فعلياً مجهّلة الهوية (نوع الخدمة + المدينة + قيمة الصفقة) من قاعدة البيانات مباشرة، وبيختفي تلقائياً لو مفيش صفقات مكتملة لسه. والأقسام الموسمية بتظهر في السوق تلقائياً في مواعيدها (رمضان، عيد الفطر، عيد الأضحى بالتقويم الهجري، دخول المدارس، الجمعة البيضاء، الصيف، رأس السنة) وبتختفي بنهايتها.',
    a_en: 'After any deal completes, either party can generate a "Deal Summary" — a clean visual document with the parties by role, the terms, the amounts by stage, dates and status (it is a summary from the platform record, not an invoice). The "Completed Deals Wall" is a public section showing the latest actually-completed deals anonymized (service type + city + deal value) straight from the database, and it auto-hides when no deals have completed yet. Seasonal sections appear in the market automatically in their windows (Ramadan, Eid al-Fitr, Eid al-Adha on the Hijri calendar, back-to-school, White Friday, summer, New Year) and disappear when they end.' },
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
/* ---------------- الرد الذكي على الدعم (جولة رد الدعم الذكي) ----------------
   الترتيب الصارم داخل /api/support/ask: بوابة الخدمات ← مطابقة الأسئلة
   الشائعة ← الرد الذكي ← احتياط اليوم (حفظ لطابور المالك). الرد الذكي
   لا يُستدعى إلا بعد فشل المطابقة الجاهزة، وأي فشل منه (تصعيد ESCALATE،
   حصة 429، مهلة، انهيار، بلا إعداد) يسقط بصمت لنفس احتياط اليوم حرفياً.
   سقف الاستخدام: 10 ردود ذكية ناجحة لكل مستخدم (أو IP للضيف) في الساعة —
   بعده يسقط للاحتياط بصمت أيضاً. محادثات الحجوزات لا تمر من هنا أبداً:
   هذا المسار الوحيد في الخادم كله الذي ينادي aiSupportReply. */
const AI_SUPPORT_HOURLY_CAP = 10;
const aiSupportReplyLog = new Map();
async function tryAiSupportReply(req, viewer, question, lang) {
  if (!aiSupport.configured()) return null;
  const key = viewer ? `u:${viewer.id}` : `ip:${req.ip || ''}`;
  const nowMs = Date.now();
  const recent = (aiSupportReplyLog.get(key) || []).filter((t) => nowMs - t < 3600 * 1000);
  if (recent.length >= AI_SUPPORT_HOURLY_CAP) { aiSupportReplyLog.set(key, recent); return null; }
  let r = null;
  try { r = await aiSupport.aiSupportReply({ question, lang }); } catch (e) { return null; }
  if (!r || !r.ok || !r.text) return null;
  recent.push(nowMs);
  aiSupportReplyLog.set(key, recent);
  return r.text;
}
/* ---------------- الأسئلة الشائعة العامة للزوار (جولة الترحيب والانتشار) ----------------
   صفحة علنية بلا أي دخول: مختارات من قاعدة معرفة الدعم نفسها (SUPPORT_KB)
   حرفياً — مصدر واحد للحقائق فلا تناقض بين ما يقرأه الزائر وما يجيب به
   الدعم. لا وعود مضافة ولا أي عبارة أوسع من الحماية الحقيقية (مختبرة). */
const PUBLIC_FAQ_IDS = ['what', 'guest_post', 'fee_why', 'stages', 'guarantee', 'p2p', 'auto_confirm', 'off_platform', 'replacement_deterrence', 'star', 'founder_member', 'countries'];
app.get('/api/faq', (req, res) => {
  const items = PUBLIC_FAQ_IDS
    .map((id) => SUPPORT_KB.find((x) => x.id === id))
    .filter(Boolean)
    .map((x) => ({ id: x.id, q_ar: x.q_ar, q_en: x.q_en, a_ar: x.a_ar, a_en: x.a_en }));
  res.json({ items });
});
app.get('/api/support/topics', (req, res) => {
  const lang = req.query.lang === 'en' ? 'en' : 'ar';
  res.json({ items: SUPPORT_KB.map(x => ({ id: x.id, q: lang === 'en' ? x.q_en : x.q_ar })) });
});
app.post('/api/support/ask', async (req, res) => {
  const { q, contact = '' } = req.body || {};
  const lang = (req.body && req.body.lang) === 'en' ? 'en' : 'ar';
  if (!q || !String(q).trim()) return res.status(400).json({ error: lang === 'en' ? 'Write your question first' : 'اكتب سؤالك أولاً' });
  // بوابة خدمات المنصة (قاعدة الاتفاق الخارجي المعتمدة 2026-11-23) — تسبق
  // مطابقة قاعدة المعرفة: طلب التحكيم/النزاع «خدمة» لا معلومة، فلا يمر لأي
  // مسار (معرفي أو محفوظ) قبل إثبات ارتباطه بحجز داخلي: أي طلب
  // تحكيم/دعم نزاع لازم يرتبط برقم حجز داخل المنصة يكون السائل طرفاً فيه —
  // طلب نزاع بلا حجز داخلي موثّق يُرفض آلياً برسالة تستشهد بالقاعدة ولا
  // يُحفظ أصلاً (خدمات المنصة ممنوعة على أي اتفاق خارجي).
  const DISPUTE_INTENT = ['نزاع', 'تحكيم', 'dispute', 'arbitration', 'نصب علي', 'احتيال', 'خدعني', 'ما دفعش', 'مدفعش', 'لم يدفع', 'سرق فلوسي'];
  const qLow = String(q).toLowerCase();
  if (DISPUTE_INTENT.some((k) => qLow.includes(k))) {
    const viewer0 = await optionalViewer(req);
    const refMatch = /#(\d{1,9})|حجز\s*(?:رقم)?\s*(\d{1,9})/.exec(String(q));
    const refId = refMatch ? +(refMatch[1] || refMatch[2]) : 0;
    let linked = null;
    if (refId && viewer0) {
      const bk = await getBooking(refId);
      if (bk && (bk.client_id === viewer0.id || bk.talent_id === viewer0.id)) linked = bk;
    }
    if (!linked) {
      return res.status(400).json({
        error: lang === 'en'
          ? 'Platform services gate: arbitration and dispute support require an in-platform booking number that you are a party to. Any agreement outside the platform does not happen, and the platform is not bound by it — no guarantee, arbitration, rating or evidence bundle for any deal that was not opened and documented as a booking inside Deal.'
          : 'بوابة خدمات المنصة: طلبات التحكيم ودعم النزاعات لازم ترتبط برقم حجز داخل المنصة تكون طرفاً فيه. أي اتفاق خارج المنصة لا يتم، والمنصة غير ملزمة بيه — لا ضمان ولا تحكيم ولا تقييم ولا حزمة أدلة لأي اتفاق لم يُفتح ويُوثَّق كحجز داخل Deal. افتح نزاعك من صفحة الحجز نفسه.',
        services_gate: true,
      });
    }
  }
  const { best, closest } = supportMatch(String(q));
  if (best) {
    return res.json({ fallback: false, topic: best.id, answer: lang === 'en' ? best.a_en : best.a_ar });
  }
  // سؤال خارج القاعدة: يُحفظ للمالك (مع حساب السائل إن كان مسجلاً) ويُرد باحتياط مهذب.
  // مشترك «نجم Deal» النشط تُعلَّم رسالته «أولوية» في لوحة المالك تلقائياً.
  const viewer = await optionalViewer(req);
  const priority = viewer && !viewer.is_platform_founder && (await isStar(viewer.id)) ? 1 : 0;
  // الرد الذكي (بعد فشل المطابقة الجاهزة فقط): نجاحه يُحفظ مع السؤال
  // موسوماً في ai_answer ليراه المالك في قائمة الدعم بشارة «رد ذكي»،
  // وفشله/تصعيده يكمل لنفس الاحتياط أسفله بلا أي اختلاف مرئي.
  const aiText = await tryAiSupportReply(req, viewer, String(q), lang);
  if (aiText) {
    await db.prepare('INSERT INTO support_messages (user_id,question,contact,lang,priority,ai_answer,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(viewer ? viewer.id : null, String(q).slice(0, 1000), String(contact || '').slice(0, 120), lang, priority, aiText, now());
    return res.json({ fallback: false, ai: true, answer: aiText });
  }
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
/* دمج المهارات المعتمد (المراجعة الشاملة): وقود «المونتاج» صار جزءاً من
   بنك «إنتاج ومونتاج الفيديو»، ووقود «إدارة الحسابات» جزءاً من بنك
   «تسويق وإدارة حسابات» — تُدمج الأفكار والخطوات وتُحذف المفاتيح القديمة
   حتى لا يخرج وقود بمفتاح خدمة لم تعد موجودة في التصنيف. */
if (STAR_FUEL.editing) { STAR_FUEL.videoproduction.ideas.push(...STAR_FUEL.editing.ideas); STAR_FUEL.videoproduction.steps.push(...STAR_FUEL.editing.steps); delete STAR_FUEL.editing; }
if (STAR_FUEL.accounts) { STAR_FUEL.marketing.ideas.push(...STAR_FUEL.accounts.ideas); STAR_FUEL.marketing.steps.push(...STAR_FUEL.accounts.steps); delete STAR_FUEL.accounts; }
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
/* إحصاء نماذج الأعمال من منظور المالك (وضع المؤسس — قسم ٥): صناع/مقدمو
   خدمة بنماذج معروضة مقابل بلا نماذج، لعرضها في لوحة المؤسس بدل تذكيره
   الشخصي بإضافة نماذج (وهو حساب عرض بلا نماذج أصلاً). */
app.get('/api/owner/samples-stats', auth, ownerOnly, async (req, res) => {
  const withRow = await db.prepare(`SELECT COUNT(DISTINCT p.user_id) AS c FROM portfolio_items p JOIN users u ON u.id = p.user_id WHERE u.role IN ('creator','provider') AND u.is_platform_founder = 0`).get();
  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role IN ('creator','provider') AND is_platform_founder = 0 AND banned = 0`).get();
  const withS = (withRow && withRow.c) || 0, total = (totalRow && totalRow.c) || 0;
  res.json({ with_samples: withS, without_samples: Math.max(0, total - withS), total });
});
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
    const stageFor = { booking_commission: ['awaiting_fee'], booking_deposit: ['awaiting_deposit', 'awaiting_deposit2'], booking_final: ['awaiting_rest', 'proof_submitted'] };
    const amounts = bookingLegAmounts(b);
    const base = kind === 'booking_commission' ? amounts.fee : kind === 'booking_deposit' ? (!amounts.split ? amounts.deposit : (b.status === 'awaiting_deposit2' ? amounts.dep2 : amounts.dep1)) : amounts.rest;
    const existing = await db.prepare(`SELECT * FROM money_obligations WHERE kind=? AND booking_id=? AND base_amount=? AND status IN ('open','claimed','confirmed','auto_confirmed') AND is_difference=0 AND is_refund=0 ORDER BY id DESC LIMIT 1`).get(kind, b.id, base);
    if (!existing && !stageFor[kind].includes(b.status)) return res.status(400).json({ error: 'خطوة الدفع ليست مفتوحة الآن' });
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
  if (kind === 'breach_penalty') {
    /* غرامات الإخلال المستحقة على العضو نفسه: قائمة التزاماته المفتوحة ليدفعها
       بنفس آلية الإيصال/قرار المالك (مستلمها المنصة) — فكّ تجميده مشروط بها. */
    if (!viewer) return res.status(401).json({ error: 'سجل الدخول أولاً' });
    const rows = await db.prepare(`SELECT * FROM money_obligations WHERE kind='breach_penalty' AND payer_user_id=? AND status IN ('open','claimed') ORDER BY id ASC`).all(viewer.id);
    const items = [];
    for (const ob of rows) items.push(await payerObligationView(ob, viewer.country));
    return res.json({ obligations: items });
  }
  if (kind === 'deposit_refund') {
    /* التزام ردّ عربون مقرّر تحكيمياً على حجز بعينه: يظهر لدافعه (المنفذ)
       ليدفعه للعميل مباشرة، أو للعميل المستلم لمتابعة حالته. */
    if (!viewer) return res.status(401).json({ error: 'سجل الدخول أولاً' });
    const b = await getBooking(+req.query.booking_id || 0);
    if (!b) return res.status(404).json({ error: 'غير موجود' });
    if (viewer.id !== b.talent_id && viewer.id !== b.client_id && !viewer.is_platform_founder) return res.status(403).json({ error: 'الالتزام يظهر لطرفي الحجز فقط' });
    const ob = await db.prepare(`SELECT * FROM money_obligations WHERE kind='booking_deposit' AND is_refund=1 AND booking_id=? ORDER BY id DESC LIMIT 1`).get(b.id);
    if (!ob) return res.status(404).json({ error: 'لا يوجد التزام ردّ على هذا الحجز' });
    return res.json({ obligation: await payerObligationView(ob, viewer.country) });
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
/* مطالبة دفع التزام عام لا يمر بخطوات حجز (غرامة إخلال breach_penalty أو
   رد عربون is_refund): الدافع يعلن «حوّلت» بمرجع داخل المنصة، والتأكيد
   بمسار المالك الحالي (POST /api/owner/money/:id/confirm) — نفس آلية
   تأكيد الالتزامات القائمة، وعندها يعمل فكّ التجميد المشروط. */
app.post('/api/money/obligation/:id/claim', auth, async (req, res) => {
  const ob = await db.prepare('SELECT * FROM money_obligations WHERE id=?').get(req.params.id);
  if (!ob) return res.status(404).json({ error: 'الالتزام غير موجود' });
  const claimable = ob.kind === 'breach_penalty' || Number(ob.is_refund) === 1;
  if (!claimable) return res.status(400).json({ error: 'هذا الالتزام يُدفع من خطوة الحجز نفسها' });
  if (ob.payer_user_id !== req.user.id) return res.status(403).json({ error: 'هذا الالتزام ليس عليك' });
  if (ob.status !== 'open') return res.status(400).json({ error: 'الالتزام ليس مفتوحاً للدفع' });
  const ref = String((req.body || {}).ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'مرجع التحويل مطلوب' });
  const claimed = await setObligationStatus(ob, 'claimed', `user:${req.user.id}`, 'أعلن الدافع تحويل الالتزام داخل المنصة', { transfer_ref: ref });
  res.json({ ok: true, obligation: obligationView(claimed) });
});
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
     استثناء Deal الصريح — «الدفع من طرف ثالث»: الفلوس وصلت فعلاً لكن من حساب
     باسم غير اسم الدافع: يُرفض الالتزام ويُلغى بمسار الرد القائم ويُسجَّل السبب
     (reject_kind='third_party') بلا علم احتيال — المخالفة إجرائية لا كذب دفع. */
  const falseClaim = ob.status === 'claimed' && !thirdParty;
  ob = await setObligationStatus(ob, 'rejected', 'owner', `رفض المالك: ${reason}${thirdParty ? ' — قاعدة الطرف الثالث (Deal): لا إفراج ولا اعتماد لدفع من حساب غير حساب الدافع' : falseClaim ? ' — إعلان دفع كاذب موثّق بمراجعة المالك' : ''}`, { decided_by: req.user.id, decided_at: now(), reject_kind: thirdParty ? 'third_party' : (falseClaim ? 'false_claim' : 'other'), ...(falseClaim ? { fraud_flag: 1 } : {}) });
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
/* «طلب إكمال الفرق» (نتيجة Deal للمبلغ الناقص): المالك راجع مطالبة ووصلَه
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
  await moneyLedger(dob.id, 'open', 'open', 'owner', `التزام إكمال فرق للمعاملة ${ob.code} (بقرار مراجعة المالك — نتيجة Deal للمبلغ الناقص)`);
  if (ob.payer_user_id) await notify(ob.payer_user_id, 'money', `معاملة ${ob.code}: وصلك طلب إكمال فرق ${diff.toFixed(2)} ${ob.currency} — المبلغ الذي حوّلته كان ناقصاً عن مبلغ المعاملة بالبصمة. أكمل الفرق من نفس خطوة الدفع بالمرجع الجديد ${dob.code}`, ob.booking_id ? `booking:${ob.booking_id}` : `money:${dob.code}`);
  await notifyOwner('money', `طُلب إكمال فرق للمعاملة ${ob.code}: التزام جديد ${dob.code} بمبلغ ${diff.toFixed(2)} ${ob.currency}`, `money:${dob.code}`);
  res.json({ ok: true, difference: await moneyItemView(await getObligation(dob.id)) });
});
/* «رد الفرق الزائد» (نتيجة Deal للمبلغ الزائد): يُوثَّق في السجل أن المالك
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
  await moneyLedger(ob.id, ob.status, ob.status, 'owner', `مبلغ زائد: وصل ${mround(received).toFixed(2)} بدل ${mround(ob.exact_amount).toFixed(2)} — الفرق ${excess.toFixed(2)} ${ob.currency} يردّه المالك للدافع من محفظته يدوياً (نتيجة Deal للمبلغ الزائد)`);
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
    // عالق: قُبل الاستلام من أكثر من ١٥ دقيقة والباقي لسه ما خلصش (تنبيه Deal المتحوّل).
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
/* ---------------- لوحة المالك: طلبات مراجعة الإفراج (نموذج Deal) ----------------
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
  await db.prepare(`UPDATE bookings SET receipt_confirmed_at=0, receipt_auto=0, deemed_at=0, deemed_warn_sent=0, deemed_mid_warn_sent=0, status='proof_submitted' WHERE id=?`).run(b.id);
  const ob = await finalObligation(b.id);
  if (ob) await moneyLedger(ob.id, ob.status, ob.status, 'owner', `عكس اعتماد استلام مُعتبَر (قاعدة سكوت): ${reason}`);
  await addBookingEvent(b.id, 'deemed_reversed', `عكس المالك اعتماد الاستلام المُعتبَر: ${reason}`);
  await notify(b.talent_id, 'deemed', `حجز #${b.id}: عكس المالك اعتماد الاستلام المُعتبَر (${reason}) — الحجز رجع لانتظار تأكيد الاستلام`, `booking:${b.id}`);
  if (b.client_id) await notify(b.client_id, 'deemed', `حجز #${b.id}: عكس المالك اعتماد الاستلام المُعتبَر (${reason}) — أكّد الاستلام بنفسك أو افتح نزاعاً من صفحة الحجز`, `booking:${b.id}`);
  res.json({ ok: true, booking: await bookingView(await getBooking(b.id), req.user) });
});

/* ---------------- بلاغات الدفع المتأخر (قاعدة Deal) ----------------
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
/* نواة التعيين الواحدة (جولة التلميع والنمو): تُستخدم من تعيين المالك
   المباشر ومن اعتماد طلب سفير معاً — نفس قواعد النطاق حرفياً: سفير فعّال
   واحد لكل (دولة، مدينة) بالفهرس الفريد، والبديل يُلغي السابق مع بقاء
   سجله التاريخي، ووسيلة التسوية من سجلّ الوسائل (افتراضياً بايونير خارج
   مصر ومباشر داخلها)، وإشعار التعيين للمُعيَّن. */
async function appointAmbassadorCore({ target, city, country, collection_phone, compensation, settlement_method, byUserId }) {
  const ctry = countryOf(country);
  if (!ctry) return { error: 'دولة غير صحيحة' };
  const cityN = normCity(city);
  if (!cityN) return { error: 'مدينة السفير مطلوبة' };
  const phone = normalizePhoneForCountry(collection_phone, ctry.code);
  if (!phone) return { error: 'رقم التحصيل غير صالح لدولة النطاق' };
  // بديل لنفس النطاق: السابق يُلغى (يبقى تاريخه) قبل تفعيل الجديد.
  const prev = await activeAmbassadorFor(cityN, ctry.code);
  if (prev) {
    await db.prepare('UPDATE ambassadors SET active=0, removed_at=?, removed_by=? WHERE id=?').run(now(), byUserId, prev.id);
    await notify(prev.user_id, 'ambassador_removed', `انتهى تعيينك سفيراً لـDeal في ${prev.city} — شكراً لخدمتك`, 'ambassador');
  }
  /* وسيلة التسوية لهذا النطاق: اختيار المالك من سجلّ الوسائل؛ الافتراضي
     بايونير لأي نطاق خارج مصر ومباشر (بلا وسيلة) داخل مصر. قيمة غير
     مسجّلة أو غير مفعّلة بعد → رفض صريح. */
  let settleMethod = String(settlement_method || '').trim();
  if (settleMethod) {
    const reg = SETTLEMENT_METHODS[settleMethod];
    if (!reg) return { error: 'وسيلة تسوية غير معروفة' };
    if (!reg.enabled) return { error: 'وسيلة التسوية دي مش مفعّلة لسه' };
  } else settleMethod = ctry.code === 'EG' ? '' : 'payoneer';
  const info = await db.prepare(`INSERT INTO ambassadors (user_id,city,country,collection_phone,compensation,settlement_method,active,created_at) VALUES (?,?,?,?,?,?,1,?)`)
    .run(target.id, cityN, ctry.code, phone, String(compensation || '').slice(0, 200), settleMethod, now());
  const appt = await db.prepare('SELECT * FROM ambassadors WHERE id=?').get(info.lastInsertRowid);
  await notify(target.id, 'ambassador_appointed', `🏛️ عيّنك مالك Deal سفيراً للمنصة في ${cityN} — رقم تحصيلك المحلي بقى يظهر في خطوات دفع مدينتك`, 'ambassador');
  return { appointment: appt };
}
app.post('/api/owner/ambassadors', auth, ownerOnly, async (req, res) => {
  const { user_id, city, country, collection_phone, compensation, settlement_method } = req.body || {};
  const target = await getUser(+user_id || 0);
  if (!target) return res.status(404).json({ error: 'العضو غير موجود' });
  if (target.is_platform_founder) return res.status(400).json({ error: 'المؤسس لا يُعيَّن سفيراً أبداً' });
  if (!target.verified) return res.status(400).json({ error: 'تعيين السفير لعضو موثّق فقط — العضو غير موثّق' });
  if (target.banned) return res.status(400).json({ error: 'العضو محظور — لا يمكن تعيينه سفيراً' });
  const out = await appointAmbassadorCore({ target, city, country, collection_phone, compensation, settlement_method, byUserId: req.user.id });
  if (out.error) return res.status(400).json({ error: out.error });
  await logOwnerAction(req, 'ambassador_appoint', `user:${target.id}`, `${country}/${city}`);
  res.json({ ok: true, appointment: await ambassadorView(out.appointment) });
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
/* ---------------- طلبات السفير (جولة التلميع والنمو — بند ٩) ----------------
   عضو أكمل تحقق إيميله يرشّح نفسه سفيراً لدولته ومدينته هو فقط (النطاق
   يُختم من حسابه لا من إدخاله)، وطلب مفتوح واحد لكل عضو (فهرس فريد جزئي).
   الاعتماد يمرّ بنواة التعيين الواحدة appointAmbassadorCore بقواعد النطاق
   نفسها، والرفض يُختم على السجل. المتقدم يرى حالة طلبه من لوحته. */
function ambassadorApplicationView(a, applicant) {
  return {
    id: a.id, user_id: a.user_id, city: a.city, country: a.country, note: a.note || '',
    status: a.status, created_at: a.created_at, decided_at: a.decided_at || 0,
    ambassador_id: a.ambassador_id || null,
    applicant: applicant ? { id: applicant.id, name: applicant.name, role: applicant.role, city: applicant.city, country: applicant.country, verified: !!applicant.verified, email_verified: !!applicant.email_verified, phone: applicant.phone || '' } : null,
  };
}
app.post('/api/me/ambassador-application', auth, async (req, res) => {
  const u = req.user;
  if (u.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس يدير المنصة — لا يرشّح نفسه سفيراً · The founder runs the platform and does not apply as ambassador' });
  if (!u.email_verified) return res.status(403).json({ error: 'أكّد إيميلك أولاً قبل التقديم كسفير · Verify your email first before applying as an ambassador', code: 'EMAIL_NOT_VERIFIED' });
  if (u.banned) return res.status(403).json({ error: 'حسابك محظور حالياً' });
  const active = await db.prepare('SELECT id FROM ambassadors WHERE user_id=? AND active=1 LIMIT 1').get(u.id);
  if (active) return res.status(409).json({ error: 'أنت سفير معيّن بالفعل · You are already an appointed ambassador' });
  const open = await db.prepare(`SELECT id FROM ambassador_applications WHERE user_id=? AND status='open' LIMIT 1`).get(u.id);
  if (open) return res.status(409).json({ error: 'عندك طلب سفير مفتوح بالفعل — استنى قرار المالك · You already have an open ambassador application' });
  const city = normCity((req.body || {}).city || u.city);
  if (!city) return res.status(400).json({ error: 'مدينتك مطلوبة للتقديم · Your city is required to apply' });
  const ctry = countryOf(u.country);
  if (!ctry) return res.status(400).json({ error: 'دولة حسابك غير مدعومة لنطاق سفير · Your account country is not supported for an ambassador scope' });
  const note = String((req.body || {}).note || '').trim().slice(0, 300);
  const info = await db.prepare(`INSERT INTO ambassador_applications (user_id,city,country,note,status,created_at) VALUES (?,?,?,?,'open',?)`)
    .run(u.id, city, ctry.code, note, now());
  const row = await db.prepare('SELECT * FROM ambassador_applications WHERE id=?').get(info.lastInsertRowid);
  await notifyOwner('ambassador_application', `📍 طلب سفير جديد: ${u.name} — ${city} · ${ctry.code}${note ? ` — ${note}` : ''}`, 'ambassador');
  res.json({ ok: true, application: ambassadorApplicationView(row, u) });
});
app.get('/api/me/ambassador-application', auth, async (req, res) => {
  const row = await db.prepare('SELECT * FROM ambassador_applications WHERE user_id=? ORDER BY id DESC LIMIT 1').get(req.user.id);
  const active = await db.prepare('SELECT id FROM ambassadors WHERE user_id=? AND active=1 LIMIT 1').get(req.user.id);
  res.json({ application: row ? ambassadorApplicationView(row, req.user) : null, is_ambassador: !!active });
});
app.get('/api/owner/ambassador-applications', auth, ownerOnly, async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM ambassador_applications ORDER BY (status='open') DESC, id DESC LIMIT 100`).all();
  const items = [];
  for (const a of rows) items.push(ambassadorApplicationView(a, await getUser(a.user_id)));
  res.json({ items, open_count: rows.filter((a) => a.status === 'open').length });
});
app.post('/api/owner/ambassador-applications/:id/approve', auth, ownerOnly, async (req, res) => {
  const a = await db.prepare('SELECT * FROM ambassador_applications WHERE id=?').get(+req.params.id);
  if (!a || a.status !== 'open') return res.status(404).json({ error: 'الطلب غير موجود أو تم البت فيه' });
  const target = await getUser(a.user_id);
  if (!target) return res.status(404).json({ error: 'العضو غير موجود' });
  if (target.is_platform_founder) return res.status(400).json({ error: 'المؤسس لا يُعيَّن سفيراً أبداً' });
  if (target.banned) return res.status(400).json({ error: 'العضو محظور — لا يمكن تعيينه سفيراً' });
  const phone = (req.body || {}).collection_phone || target.phone || target.contact;
  const out = await appointAmbassadorCore({ target, city: a.city, country: a.country, collection_phone: phone, compensation: (req.body || {}).compensation || '', settlement_method: (req.body || {}).settlement_method || '', byUserId: req.user.id });
  if (out.error) return res.status(400).json({ error: out.error });
  await db.prepare(`UPDATE ambassador_applications SET status='approved', decided_at=?, decided_by=?, ambassador_id=? WHERE id=?`)
    .run(now(), req.user.id, out.appointment.id, a.id);
  await logOwnerAction(req, 'ambassador_approve', `application:${a.id}`, `user:${a.user_id} ${a.country}/${a.city}`);
  const fresh = await db.prepare('SELECT * FROM ambassador_applications WHERE id=?').get(a.id);
  res.json({ ok: true, application: ambassadorApplicationView(fresh, target), appointment: await ambassadorView(out.appointment) });
});
app.post('/api/owner/ambassador-applications/:id/reject', auth, ownerOnly, async (req, res) => {
  const a = await db.prepare('SELECT * FROM ambassador_applications WHERE id=?').get(+req.params.id);
  if (!a || a.status !== 'open') return res.status(404).json({ error: 'الطلب غير موجود أو تم البت فيه' });
  await db.prepare(`UPDATE ambassador_applications SET status='rejected', decided_at=?, decided_by=? WHERE id=?`)
    .run(now(), req.user.id, a.id);
  await logOwnerAction(req, 'ambassador_reject', `application:${a.id}`, `user:${a.user_id} ${a.country}/${a.city}`);
  await notify(a.user_id, 'ambassador_application', 'وصل قرار طلبك كسفير — لم يتم الاعتماد هذه المرة، وتقدر تتقدم تاني بعد تطوير ملفك', 'ambassador');
  const fresh = await db.prepare('SELECT * FROM ambassador_applications WHERE id=?').get(a.id);
  res.json({ ok: true, application: ambassadorApplicationView(fresh, await getUser(a.user_id)) });
});

/* ---------------- ملخص المالك الأسبوعي بالبريد (بند ١٠) ----------------
   يُركَّب من أرقام القاعدة الحقيقية فقط، ويُرسَل عبر طبقة البريد القائمة.
   التشغيل يدوي الآن من لوحة المالك، ونداء مجدوَل خارجي لاحقاً يضرب نفس
   المسار. بلا بريد مُعدّ: تخطٍّ صامت بلا أي خطأ (نفس انضباط طبقة البريد). */
async function composeOwnerDigest() {
  const weekAgo = now() - 7 * 24 * 3600 * 1000;
  const cnt = async (sql, ...args) => +(await db.prepare(sql).get(...args)).c || 0;
  const sum = async (sql, ...args) => { const r = await db.prepare(sql).get(...args); return (r && r.s) || 0; };
  const newRegs = await cnt('SELECT COUNT(*) c FROM users WHERE is_platform_founder=0 AND created_at>=?', weekAgo);
  const newVerified = await cnt('SELECT COUNT(*) c FROM users WHERE is_platform_founder=0 AND created_at>=? AND email_verified=1', weekAgo);
  const bookingsCreated = await cnt('SELECT COUNT(*) c FROM bookings WHERE created_at>=?', weekAgo);
  const bookingsCompleted = await cnt('SELECT COUNT(*) c FROM bookings WHERE completed_at>=?', weekAgo);
  const commissionWeek = await sum(`SELECT COALESCE(SUM(exact_amount),0) s FROM money_obligations WHERE kind='booking_commission' AND status IN ('confirmed','auto_confirmed') AND COALESCE(NULLIF(decided_at,0),created_at)>=?`, weekAgo);
  const commissionTotal = await sum(`SELECT COALESCE(SUM(exact_amount),0) s FROM money_obligations WHERE kind='booking_commission' AND status IN ('confirmed','auto_confirmed')`);
  const starWeek = await sum(`SELECT COALESCE(SUM(exact_amount),0) s FROM money_obligations WHERE kind='star_subscription' AND status IN ('confirmed','auto_confirmed') AND COALESCE(NULLIF(decided_at,0),created_at)>=?`, weekAgo);
  const openDisputes = await cnt(`SELECT COUNT(*) c FROM disputes WHERE status='open'`);
  const seatsTaken = await cnt('SELECT COUNT(*) c FROM users WHERE founder_seat BETWEEN 1 AND 50');
  const stats = {
    new_registrations: newRegs, new_email_verified: newVerified,
    bookings_created: bookingsCreated, bookings_completed: bookingsCompleted,
    commission_week: Math.round(commissionWeek * 100) / 100, commission_total: Math.round(commissionTotal * 100) / 100,
    star_week: Math.round(starWeek * 100) / 100,
    open_disputes: openDisputes, seats_taken: seatsTaken, seats_remaining: 50 - seatsTaken,
  };
  const day = new Date(now()).toLocaleDateString('ar-EG');
  const subject = `ملخص Deal الأسبوعي — ${day}`;
  const text = [
    'ملخص Deal الأسبوعي (آخر ٧ أيام) — أرقام حقيقية من قاعدة المنصة:',
    '',
    `• تسجيلات جديدة: ${stats.new_registrations} (منها ${stats.new_email_verified} أكملت تحقق الإيميل)`,
    `• حجوزات أُنشئت: ${stats.bookings_created} · حجوزات اكتملت: ${stats.bookings_completed}`,
    `• عمولات صفقات مؤكدة هذا الأسبوع: ${stats.commission_week} (الإجمالي المؤكد: ${stats.commission_total})`,
    `• اشتراكات نجم Deal مؤكدة هذا الأسبوع: ${stats.star_week}`,
    `• نزاعات مفتوحة الآن: ${stats.open_disputes}`,
    `• مقاعد المؤسسين: ${stats.seats_taken} مشغولاً من ٥٠ — باقي ${stats.seats_remaining}`,
    '',
    '— Deal',
  ].join('\n');
  return { subject, text, stats };
}
app.post('/api/owner/send-digest', auth, ownerOnly, async (req, res) => {
  const { subject, text, stats } = await composeOwnerDigest();
  if (!mailer.configured()) { await logOwnerAction(req, 'digest_send', 'owner', 'sent:false reason:email_not_configured'); return res.json({ ok: true, sent: false, reason: 'email_not_configured', stats }); }
  const founder = req.user;
  const to = [founder.recovery_email, founder.contact].find((x) => x && String(x).includes('@'));
  if (!to) { await logOwnerAction(req, 'digest_send', 'owner', 'sent:false reason:no_owner_email'); return res.json({ ok: true, sent: false, reason: 'no_owner_email', stats }); }
  try {
    await mailer.sendMail({ to, subject, text });
    await logOwnerAction(req, 'digest_send', 'owner', 'sent:true');
    res.json({ ok: true, sent: true, stats });
  } catch (e) {
    await logOwnerAction(req, 'digest_send', 'owner', 'sent:false reason:send_failed');
    res.json({ ok: true, sent: false, reason: 'send_failed', stats });
  }
});

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
   هو المستلم نفسه — نموذج Deal حرفياً (المستلم يتحقق من حسابه هو). */
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
/* ---- حزمة الأدلة الرسمية (جولة الردع): تقرير رسمي قابل للتنزيل/الطباعة
   يولّده الطرف المتضرر بعد قرار تحكيم باحتيال/إخلال مثبت على هذا الحجز —
   بوابته: التزام موسوم بعلم احتيال على الحجز، أو غرامة إخلال على الطرف
   الآخر من هذا الحجز، أو حماية ملغاة. يحمل هوية الطرف الآخر الموثّقة
   (الاسم + وسيلة التواصل المسجلة + المدينة/الدولة + حالة التوثيق) والسجل
   الموقوت والإيصالات وقرار التحكيم، بصيغة جاهزة لبلاغ رسمي، ويُسلَّم داخل
   المنصة فوراً (وسقف الـ٧٢ ساعة في الشروط هو الحد الأقصى لا المعتاد). */
async function officialReportEligibility(b, viewerId) {
  const otherId = viewerId === b.client_id ? b.talent_id : viewerId === b.talent_id ? b.client_id : null;
  if (!otherId) return null;
  const fraudOb = await db.prepare(`SELECT id FROM money_obligations WHERE booking_id=? AND fraud_flag=1 LIMIT 1`).get(b.id);
  const penOb = await db.prepare(`SELECT id FROM money_obligations WHERE booking_id=? AND kind='breach_penalty' AND payer_user_id=? LIMIT 1`).get(b.id, otherId);
  if (!fraudOb && !penOb && !b.protection_voided) return null;
  return await getUser(otherId);
}
async function buildOfficialReport(b, viewer) {
  const bundle = await buildEvidenceBundle(b);
  const other = viewer.id === b.client_id ? await getUser(b.talent_id) : await getUser(b.client_id);
  const dispute = await db.prepare('SELECT id,status,resolution,resolved_at,created_at FROM disputes WHERE booking_id=? ORDER BY id DESC LIMIT 1').get(b.id);
  const fmt = (ts) => (ts ? new Date(ts).toISOString() : '—');
  const lines = [
    'تقرير أدلة رسمي — منصة Deal',
    `رقم الحجز: #${b.id} | قيمة الصفقة: ${b.price} ${b.currency} | تاريخ التقرير: ${fmt(now())}`,
    `الطرف المتضرر (مقدّم التقرير): ${viewer.name} — وسيلة التواصل المسجلة: ${viewer.contact}`,
    other ? `الطرف الآخر (ثبت عليه الإخلال/الاحتيال بقرار تحكيم): ${other.name} — وسيلة التواصل المسجلة: ${other.contact} — الهاتف المسجل: ${other.phone || '—'} — المدينة/الدولة: ${other.city || '—'}/${other.country || '—'} — موثّق بكود ملكية: ${other.verified ? 'نعم' : 'لا'}` : 'الطرف الآخر: عميل ضيف (بلا حساب — هويته محفوظة بسجل الحجز)',
    dispute ? `قرار التحكيم: نزاع #${dispute.id} — الحالة: ${dispute.status} — القرار: ${dispute.resolution || '—'} — بتاريخ: ${fmt(dispute.resolved_at || dispute.created_at)}` : 'قرار التحكيم: موثّق في سجل أحداث الحجز أدناه',
    'الإطار القانوني (القانون الحاكم للمنصة — مصر، مثال موثّق وحيد؛ والاحتيال جريمة في قوانين كل دولة تعمل فيها المنصة): قبول الطرفين لشروط معاملات Deal عقد إلكتروني ملزم (المادة ١٤٧ مدني)، وللمتضرر المطالبة بتعويض كامل (المادة ١٦٣ مدني)، وقبض العربون والاستيلاء عليه يدخل في نطاق خيانة الأمانة (٣٤١ عقوبات) والنصب (٣٣٦ عقوبات)، والاحتيال عبر الشبكات يغلّظه قانون مكافحة جرائم تقنية المعلومات ١٧٥ لسنة ٢٠١٨.',
    'السجل الموقوت والإيصالات والالتزامات المالية كاملة في حزمة الأدلة المرفقة بهذا التقرير (تُستخرج من صفحة الحجز — «حزمة الأدلة»).',
  ];
  return {
    report: 'Deal — تقرير أدلة رسمي (Official Evidence Report)',
    generated_at: fmt(now()),
    booking_id: b.id,
    harmed_party: { id: viewer.id, name: viewer.name, contact: viewer.contact },
    counterparty: other ? { id: other.id, name: other.name, contact: other.contact, phone: other.phone || '', city: other.city || '', country: other.country || '', verified: !!other.verified } : { guest: true },
    arbitration: dispute ? { dispute_id: dispute.id, status: dispute.status, resolution: dispute.resolution || '', decided_at: fmt(dispute.resolved_at || dispute.created_at) } : null,
    legal_frame: 'القانون الحاكم للمنصة (مصر — مثال موثّق وحيد): عقد إلكتروني ملزم (١٤٧ مدني) — تعويض كامل (١٦٣ مدني) — خيانة أمانة (٣٤١ عقوبات) — نصب (٣٣٦ عقوبات) — قانون مكافحة جرائم تقنية المعلومات ١٧٥ لسنة ٢٠١٨',
    evidence_bundle: bundle,
    report_text: lines.join('\n'),
  };
}
app.get('/api/bookings/:id/evidence-report', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || (b.client_id !== req.user.id && b.talent_id !== req.user.id)) return res.status(403).json({ error: 'التقرير الرسمي لطرفي الحجز فقط' });
  const eligible = await officialReportEligibility(b, req.user.id);
  if (!eligible) return res.status(400).json({ error: 'التقرير الرسمي يتاح بعد قرار تحكيم باحتيال أو إخلال مثبت على هذا الحجز' });
  res.json({ report: await buildOfficialReport(b, req.user) });
});
app.get('/api/bookings/:id/evidence', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || (b.client_id !== req.user.id && b.talent_id !== req.user.id && !req.user.is_platform_founder)) return res.status(404).json({ error: 'غير موجود' });
  res.json({ evidence: await buildEvidenceBundle(b) });
});
/* نسخة «الطرف المتضرر» من حزمة الأدلة (٨-هـ): وحدها تحمل هوية الطرف الآخر
   (الاسم القانوني + المحفظة المصرّح بها + الإقرارات) — وتُبنى فقط بعد صدور
   قرار تحكيم على الحجز. النسخ العامة تبقى بلا أي بيانات خاصة. */
async function buildHarmedBundle(b, harmedSide) {
  const bundle = await buildEvidenceBundle(b);
  const talent = await getUser(b.talent_id);
  const client = b.client_id ? await getUser(b.client_id) : null;
  const other = harmedSide === 'client' ? talent : client;
  bundle.version = 'harmed_party';
  bundle.counterparty_identity = other ? {
    name: other.name, legal_name: other.legal_name || '', role: other.role,
    declared_wallet: other.fin_declared_at ? (other.fin_wallet_number || '') : '',
    wallet_owner_name: other.fin_wallet_owner || '',
    declarations: other.fin_declared_at ? [{ type: 'financial_identity', version: other.fin_declared_version || '', declared_at: other.fin_declared_at ? new Date(other.fin_declared_at).toISOString() : null, text_ar: FIN_DECLARATION_AR }] : [],
    contact: other.contact || '',
  } : { guest_name: b.guest_name || '', note: 'الطرف الآخر ضيف — هويته من سجل الطلب والدفع داخل هذه الحزمة' };
  if (harmedSide === 'talent' && !client) {
    bundle.counterparty_identity = { guest_name: b.guest_name || '', guest_phone: b.guest_phone || '', note: 'هوية العميل الضيف كما سُجلت في الطلب وخطوات الدفع' };
  }
  return bundle;
}
app.get('/api/bookings/:id/evidence-harmed', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || (b.client_id !== req.user.id && b.talent_id !== req.user.id)) return res.status(403).json({ error: 'نسخة المتضرر لطرفي الحجز فقط' });
  if (!(await guestArbitrationDecided(b))) return res.status(403).json({ error: 'نسخة الطرف المتضرر تتاح بعد صدور قرار التحكيم على هذا الحجز', arbitration_required: true });
  const side = req.user.id === b.client_id ? 'client' : 'talent';
  res.json({ evidence: await buildHarmedBundle(b, side) });
});
app.get('/api/guest/:token/evidence-report', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  if (!(await guestArbitrationDecided(b))) return res.status(403).json({ error: 'حزمة الأدلة الرسمية بهوية الطرف الآخر تتاح بعد صدور قرار التحكيم', arbitration_required: true });
  res.json({ evidence: await buildHarmedBundle(b, 'client') });
});

app.get('/api/guest/:token/evidence', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  res.json({ evidence: await buildEvidenceBundle(b) });
});

/* ---------------- حذف الحساب ذاتياً (الحزمة القانونية) ----------------
   التأكيد هنا بإعادة كتابة وسيلة تواصل الحساب حرفياً + تأكيد صريح (والحسابات
   القديمة بلا كلمة سر تُكمل تعيين كلمة سرها أولاً عبر بوابة ترحيل جولة الاسترجاع). يُمنع الحذف مع حجوزات
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
  await db.prepare(`UPDATE users SET deleted_at=?, name='حساب محذوف', contact=?, phone='', bio='', links='', avatar='', cover='', verify_url='', frozen=1, recovery_email='', password_hash=NULL WHERE id=?`)
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

/* ================= جولة «التوسعة» (قرارات المستخدم 2026-11-23) =================
   ١٨ بنداً فوق البنية القائمة حرفياً (نفس الجداول والسجل والمسوحات lazy):
   عروض أسعار، باقات، لوحة أرقام، عروض سريعة، قوائم انتظار، ستوريز اليوم،
   فيديوهات يومية، قوالب طلب، تعاقدات شهرية، تحدي الأسبوع، إكراميات، إجازة،
   أسئلة عامة، جدار صفقات، ملخص صفقة، مواسم تلقائية، أكاديمية، ومدخل
   «Deal بلس» — موثّقة في TESTING-EXPANSION.md. */

/* ---- مساعدات مشتركة: إجازة + سعر فعّال (عرض سريع) ---- */
function onVacation(u) { return !!(u && (u.vacation_until || 0) > now()); }
function flashActive(u) { return !!(u && (u.flash_until || 0) > now() && ((u.flash_pct || 0) > 0 || (u.flash_price || 0) > 0)); }
function effectivePrice(u) {
  if (!u) return 0;
  if (flashActive(u)) {
    if ((u.flash_price || 0) > 0) return mround(u.flash_price);
    if ((u.flash_pct || 0) > 0 && (u.price || 0) > 0) return mround(u.price * (1 - u.flash_pct / 100));
  }
  return u.price || 0;
}
function flashView(u) {
  if (!flashActive(u)) return null;
  return { pct: u.flash_pct || 0, price: effectivePrice(u), base_price: u.price || 0, until: u.flash_until };
}
async function packagesOf(userId) {
  return await db.prepare('SELECT id,tier,name,price,description,features FROM creator_packages WHERE user_id=? ORDER BY tier ASC').all(userId);
}
async function packagePrice(talentId, tier) {
  if (!tier) return null;
  const p = await db.prepare('SELECT * FROM creator_packages WHERE user_id=? AND tier=?').get(talentId, +tier);
  return p && p.price > 0 ? p : null;
}
async function activeBookingsCount(talentId) {
  return (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND status NOT IN ('cancelled','completed')`).get(talentId)).c;
}

/* ---- ٢) باقات أسعار ثلاثية في ملف الصانع ---- */
app.get('/api/me/packages', auth, async (req, res) => {
  res.json({ items: await packagesOf(req.user.id) });
});
app.put('/api/me/packages', auth, async (req, res) => {
  if (!['creator', 'provider'].includes(req.user.role) || req.user.is_platform_founder) {
    return res.status(400).json({ error: 'الباقات للصناع ومقدمي الخدمة فقط' });
  }
  const list = Array.isArray((req.body || {}).packages) ? req.body.packages : [];
  if (list.length > 3) return res.status(400).json({ error: '٣ باقات كحد أقصى' });
  const seen = new Set();
  for (const p of list) {
    const tier = +p.tier;
    if (![1, 2, 3].includes(tier) || seen.has(tier)) return res.status(400).json({ error: 'درجة باقة غير صحيحة أو مكررة' });
    seen.add(tier);
    const price = +p.price;
    if (!isFinite(price) || price < 0) return res.status(400).json({ error: 'سعر باقة غير صحيح' });
    await db.prepare(`INSERT INTO creator_packages (user_id,tier,name,price,description,features,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,tier) DO UPDATE SET name=excluded.name, price=excluded.price, description=excluded.description, features=excluded.features, updated_at=excluded.updated_at`)
      .run(req.user.id, tier, String(p.name || '').slice(0, 80), price, String(p.description || '').slice(0, 400), String(p.features || '').slice(0, 600), now(), now());
  }
  // باقات لم تُذكر في الحفظ تُحذف (القائمة المرسلة هي الحالة الكاملة).
  const keep = [...seen];
  if (keep.length) {
    await db.prepare(`DELETE FROM creator_packages WHERE user_id=? AND tier NOT IN (${keep.map(() => '?').join(',')})`).run(req.user.id, ...keep);
  } else {
    await db.prepare('DELETE FROM creator_packages WHERE user_id=?').run(req.user.id);
  }
  res.json({ items: await packagesOf(req.user.id) });
});

/* ---- ٤) عروض سريعة (٤٨ ساعة) ---- */
app.post('/api/me/flash', auth, async (req, res) => {
  if (!['creator', 'provider'].includes(req.user.role) || req.user.is_platform_founder) {
    return res.status(400).json({ error: 'العروض السريعة للصناع ومقدمي الخدمة فقط' });
  }
  const { pct, special_price } = req.body || {};
  let p = 0, sp = 0;
  if (special_price != null && +special_price > 0) {
    sp = +special_price;
    if (!(req.user.price > 0) || sp >= req.user.price) return res.status(400).json({ error: 'السعر الخاص لازم يكون أقل من سعرك المعلن' });
  } else if (pct != null) {
    p = +pct;
    if (!isFinite(p) || p < 5 || p > 90) return res.status(400).json({ error: 'نسبة خصم صحيحة مطلوبة (5٪ – 90٪)' });
  } else return res.status(400).json({ error: 'حدد نسبة خصم أو سعراً خاصاً' });
  const until = now() + 48 * 3600 * 1000;
  await db.prepare('UPDATE users SET flash_pct=?, flash_price=?, flash_until=? WHERE id=?').run(p, sp, until, req.user.id);
  const fresh = await getUser(req.user.id);
  res.json({ ok: true, flash: flashView(fresh) });
});
app.delete('/api/me/flash', auth, async (req, res) => {
  await db.prepare('UPDATE users SET flash_pct=0, flash_price=0, flash_until=0 WHERE id=?').run(req.user.id);
  res.json({ ok: true, flash: null });
});

/* ---- ١٢) وضع إجازة للصانع ---- */
app.post('/api/me/vacation', auth, async (req, res) => {
  if (!['creator', 'provider'].includes(req.user.role) || req.user.is_platform_founder) {
    return res.status(400).json({ error: 'وضع الإجازة للصناع ومقدمي الخدمة فقط' });
  }
  const days = Math.floor(+((req.body || {}).days || 0));
  if (!isFinite(days) || days < 1 || days > 90) return res.status(400).json({ error: 'مدة إجازة صحيحة مطلوبة (1 – 90 يوماً)' });
  const until = now() + days * 24 * 3600 * 1000;
  await db.prepare('UPDATE users SET vacation_until=? WHERE id=?').run(until, req.user.id);
  res.json({ ok: true, vacation_until: until });
});
app.delete('/api/me/vacation', auth, async (req, res) => {
  await db.prepare('UPDATE users SET vacation_until=0 WHERE id=?').run(req.user.id);
  res.json({ ok: true, vacation_until: 0 });
});

/* ---- ١) عروض أسعار منظمة على طلب العميل ---- */
const QUOTES_PER_REQUEST_CAP = 20;
async function requestOwnerCheck(reqRow, viewer) {
  if (!reqRow) return false;
  if (viewer && reqRow.shop_user_id && viewer.id === reqRow.shop_user_id) return true;
  return false;
}
async function quotesView(requestId) {
  const rows = await db.prepare('SELECT * FROM request_quotes WHERE request_id=? ORDER BY status ASC, price ASC, created_at ASC').all(requestId);
  const out = [];
  for (const q of rows) {
    const t = await getUser(q.talent_id);
    out.push({
      id: q.id, request_id: q.request_id, price: q.price, delivery_days: q.delivery_days || 0,
      note: q.note || '', status: q.status, created_at: q.created_at,
      talent: t ? await publicUser(t) : null,
    });
  }
  return out;
}
async function rejectOtherQuotes(requestId, acceptedId, talentWinnerName) {
  const others = await db.prepare(`SELECT * FROM request_quotes WHERE request_id=? AND status='pending' AND id!=?`).all(requestId, acceptedId);
  for (const q of others) {
    await db.prepare(`UPDATE request_quotes SET status='rejected', decided_at=? WHERE id=?`).run(now(), q.id);
    await notify(q.talent_id, 'quote_rejected', `شكراً لعرضك على الطلب #${requestId} — اختار العميل عرضاً آخر هذه المرة (${talentWinnerName}). عروضك الجاية لسه فرصتها كاملة على Deal`, `request:${requestId}`);
  }
}
app.post('/api/requests/:id/quotes', auth, async (req, res) => {
  if (!(await requireVerifiedEmail(req, res))) return;
  if (!['creator', 'provider'].includes(req.user.role)) return res.status(400).json({ error: 'تقديم العروض للصناع ومقدمي الخدمة فقط' });
  if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس — عرض فقط' });
  if (req.user.frozen || req.user.penalty_level === 'suspended') return res.status(403).json({ error: 'حسابك معلّق حالياً' });
  if (onVacation(req.user)) return res.status(400).json({ error: 'أنت في وضع إجازة — أوقف الإجازة أولاً لتقديم عروض' });
  const rq = await db.prepare('SELECT * FROM shop_requests WHERE id=?').get(+req.params.id);
  if (!rq || rq.status !== 'open' || rq.managed) return res.status(404).json({ error: 'طلب غير متاح للعروض' });
  if (rq.shop_user_id && rq.shop_user_id === req.user.id) return res.status(400).json({ error: 'لا يمكنك تقديم عرض على طلبك' });
  if (rq.target_talent_id && rq.target_talent_id !== req.user.id) return res.status(400).json({ error: 'هذا الطلب موجّه لصانع آخر' });
  const price = +((req.body || {}).price || 0);
  if (!isFinite(price) || price <= 0) return res.status(400).json({ error: 'حدد سعر عرض صحيح' });
  const pendingCount = (await db.prepare(`SELECT COUNT(*) c FROM request_quotes WHERE request_id=? AND status='pending'`).get(rq.id)).c;
  if (pendingCount >= QUOTES_PER_REQUEST_CAP) return res.status(429).json({ error: 'وصل الطلب لحد العروض القصوى' });
  try {
    const info = await db.prepare('INSERT INTO request_quotes (request_id,talent_id,price,delivery_days,note,created_at) VALUES (?,?,?,?,?,?)')
      .run(rq.id, req.user.id, price, Math.max(0, Math.floor(+((req.body || {}).delivery_days || 0))), String((req.body || {}).note || '').slice(0, 300), now());
    if (rq.shop_user_id) await notify(rq.shop_user_id, 'quote_new', `💬 عرض سعر جديد على طلبك «${String(rq.title).slice(0, 50)}»: ${price} ${rq.currency} من ${req.user.name} — قارن العروض واختر من صفحة طلباتي`, `request:${rq.id}`);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'عندك عرض قائم على هذا الطلب — اسحبه أولاً لتقديم غيره' });
    throw e;
  }
});
app.delete('/api/requests/:id/quotes/mine', auth, async (req, res) => {
  await db.prepare(`DELETE FROM request_quotes WHERE request_id=? AND talent_id=? AND status='pending'`).run(+req.params.id, req.user.id);
  res.json({ ok: true });
});
app.get('/api/my/requests', auth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM shop_requests WHERE shop_user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  const items = [];
  for (const r of rows) {
    const qc = (await db.prepare(`SELECT COUNT(*) c FROM request_quotes WHERE request_id=? AND status='pending'`).get(r.id)).c;
    items.push({ id: r.id, title: r.title, niche: r.niche, city: r.city, budget: r.budget, currency: r.currency, status: r.status, managed: !!r.managed, quotes_count: qc, created_at: r.created_at });
  }
  res.json({ items });
});
app.get('/api/my/requests/:id/quotes', auth, async (req, res) => {
  const rq = await db.prepare('SELECT * FROM shop_requests WHERE id=?').get(+req.params.id);
  if (!rq || !(await requestOwnerCheck(rq, req.user))) return res.status(404).json({ error: 'غير موجود' });
  res.json({ items: await quotesView(rq.id) });
});
async function acceptQuote(rq, quoteId, agr = { revisions: null, deliveryAt: 0 }, selfId = null) {
  const q = await db.prepare('SELECT * FROM request_quotes WHERE id=? AND request_id=?').get(quoteId, rq.id);
  if (!q || q.status !== 'pending') return { error: 'عرض غير متاح' };
  const talent = await getUser(q.talent_id);
  if (!talent || talent.banned) return { error: 'الصانع غير متاح' };
  const clientU = (!rq.is_guest && rq.shop_user_id) ? await getUser(rq.shop_user_id) : null;
  if (clientU && clientU.is_platform_founder) return { error: FOUNDER_NO_CLIENT_ERROR };
  /* حظر عضو↔عضو (الجولة الأخيرة — بند ٩): قبول عرض يفتح حجزاً = بدء تعامل
     جديد، فيُمنع بين طرفين بينهما حظر (مسار الضيف بلا حساب خارج الحظر). */
  if (clientU && await blockBetween(clientU.id, talent.id)) return { error: BLOCKED_ERROR, status: 403 };
  // بوابة الهوية المالية (محرك المخاطر الحي): تُفحص على طرفي الحجز الجديد
  // (المنفذ دائماً، والعميل العضو حين يوجد — الضيف بلا حساب خارج النقاط).
  if (+q.price > RISK_FIN_IDENTITY_THRESHOLD) {
    for (const u of [talent, clientU]) {
      if (!u || u.is_platform_founder || u.fin_declared_at) continue;
      if ((await accountRiskFor(u)).band === 'high') {
        return { error: (selfId && u.id === selfId) ? FIN_GATE_SELF : FIN_GATE_OTHER, status: 403, fin_identity_required: true };
      }
    }
  }
  if (onVacation(talent)) return { error: 'الصانع في إجازة حالياً — اختر عرضاً آخر أو انتظر عودته' };
  let bookingId;
  if (rq.is_guest) {
    const ins = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,guest_name,guest_phone,guest_token,urgent,agreed_revisions,agreed_delivery_at,created_at)
      VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(talent.id, 'quote', rq.id, rq.title, q.price, rq.currency, now() + Math.max(1, q.delivery_days || 7) * 24 * 3600 * 1000, rq.guest_name, rq.guest_phone, rq.guest_token, rq.urgent ? 1 : 0, agr.revisions, agr.deliveryAt, now());
    bookingId = ins.lastInsertRowid;
  } else {
    const ins = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,urgent,agreed_revisions,agreed_delivery_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rq.shop_user_id, talent.id, 'quote', rq.id, rq.title, q.price, rq.currency, now() + Math.max(1, q.delivery_days || 7) * 24 * 3600 * 1000, rq.urgent ? 1 : 0, agr.revisions, agr.deliveryAt, now());
    bookingId = ins.lastInsertRowid;
  }
  await db.prepare(`UPDATE request_quotes SET status='accepted', decided_at=? WHERE id=?`).run(now(), q.id);
  await db.prepare(`UPDATE shop_requests SET status='booked' WHERE id=?`).run(rq.id);
  await rejectOtherQuotes(rq.id, q.id, talent.name);
  await addBookingEvent(bookingId, 'created', 'أُنشئ الحجز من عرض سعر مختار — الضمان والمراحل موثّقة داخل Deal');
  await notify(talent.id, 'quote_accepted', `🎉 اختار العميل عرضك (${q.price} ${rq.currency}) على «${String(rq.title).slice(0, 50)}» — اتفتح حجز #${bookingId} بكل حماية Deal`, `booking:${bookingId}`);
  return { bookingId };
}
app.post('/api/my/requests/:id/quotes/:qid/accept', auth, async (req, res) => {
  if (founderClientBlocked(req, res)) return;
  const rq = await db.prepare('SELECT * FROM shop_requests WHERE id=?').get(+req.params.id);
  if (!rq || rq.status !== 'open' || !(await requestOwnerCheck(rq, req.user))) return res.status(404).json({ error: 'غير موجود' });
  const agrQ = agreementFromBody(req.body || {}); if (agrQ.error) return res.status(400).json({ error: agrQ.error });
  const out = await acceptQuote(rq, +req.params.qid, agrQ, req.user.id);
  if (out.error) return res.status(out.status || 400).json({ error: out.error, ...(out.fin_identity_required ? { fin_identity_required: true } : {}) });
  res.json({ ok: true, booking_id: out.bookingId });
});
app.get('/api/guest/:token/quotes', async (req, res) => {
  const rq = await db.prepare('SELECT * FROM shop_requests WHERE guest_token=? AND is_guest=1').get(req.params.token);
  if (!rq) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  res.json({ items: await quotesView(rq.id), request_status: rq.status });
});
app.post('/api/guest/:token/quotes/:qid/accept', async (req, res) => {
  const rq = await db.prepare('SELECT * FROM shop_requests WHERE guest_token=? AND is_guest=1').get(req.params.token);
  if (!rq || rq.status !== 'open') return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const agrQ2 = agreementFromBody(req.body || {}); if (agrQ2.error) return res.status(400).json({ error: agrQ2.error });
  const out = await acceptQuote(rq, +req.params.qid, agrQ2);
  if (out.error) return res.status(out.status || 400).json({ error: out.error, ...(out.fin_identity_required ? { fin_identity_required: true } : {}) });
  res.json({ ok: true, booking_id: out.bookingId });
});

/* ---- ٥) قائمة انتظار الصانع المشغول ---- */
const WAITLIST_OFFER_MS = 6 * 3600 * 1000; // مهلة قبول معقولة للمنتظر الأول ثم التالي
function capacityLeft(u, activeCount) {
  const cap = u.daily_capacity || 0;
  return cap > 0 ? Math.max(0, cap - activeCount) : null; // null = بلا سعة معلنة (لا انتظار)
}
async function sweepWaitlist() {
  let moved = 0;
  // عروض منتهية بلا قبول → تُختم وتُفتح للتالي في نفس المسح.
  const expired = await db.prepare(`SELECT * FROM waitlist_entries WHERE status='offered' AND expires_at>0 AND expires_at<=?`).all(now());
  for (const e of expired) {
    await db.prepare(`UPDATE waitlist_entries SET status='expired' WHERE id=?`).run(e.id);
    moved++;
  }
  const talents = await db.prepare(`SELECT DISTINCT talent_id FROM waitlist_entries WHERE status IN ('waiting','offered')`).all();
  for (const t of talents) {
    const talent = await getUser(t.talent_id);
    if (!talent || talent.banned || onVacation(talent)) continue;
    const active = await activeBookingsCount(talent.id);
    let left = capacityLeft(talent, active);
    if (left == null) continue;
    const offeredCount = (await db.prepare(`SELECT COUNT(*) c FROM waitlist_entries WHERE talent_id=? AND status='offered'`).get(talent.id)).c;
    left = Math.max(0, left - offeredCount);
    while (left > 0) {
      const next = await db.prepare(`SELECT * FROM waitlist_entries WHERE talent_id=? AND status='waiting' ORDER BY created_at ASC, id ASC LIMIT 1`).get(talent.id);
      if (!next) break;
      await db.prepare(`UPDATE waitlist_entries SET status='offered', offered_at=?, expires_at=? WHERE id=?`).run(now(), now() + WAITLIST_OFFER_MS, next.id);
      if (next.client_id) await notify(next.client_id, 'waitlist_offer', `🎉 اتفتحت خانة عند ${talent.name} — دورك وصل من قائمة الانتظار. اقبل خلال ٦ ساعات من «قائمة انتظاري» قبل ما يروح الدور للي بعدك`, `talent:${talent.id}`);
      await notify(talent.id, 'waitlist_offer', 'اتفتحت عندك خانة — أول منتظر في قائمة انتظارك اتنبّه دلوقتي', `talent:${talent.id}`);
      left--; moved++;
    }
  }
  return moved;
}
app.post('/api/talents/:id/waitlist', auth, async (req, res) => {
  const talent = await getUser(+req.params.id);
  if (!talent || !['creator', 'provider'].includes(talent.role) || talent.is_platform_founder) return res.status(404).json({ error: 'غير موجود' });
  if (talent.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك الانتظار عند نفسك' });
  const active = await activeBookingsCount(talent.id);
  if (capacityLeft(talent, active) !== 0) return res.status(400).json({ error: 'الصانع متاح حالياً — اطلب منه مباشرة بدل الانتظار' });
  const dup = await db.prepare(`SELECT id FROM waitlist_entries WHERE talent_id=? AND client_id=? AND status IN ('waiting','offered')`).get(talent.id, req.user.id);
  if (dup) return res.status(409).json({ error: 'أنت في قائمة انتظاره أصلاً' });
  const requestId = (req.body || {}).request_id ? +req.body.request_id : null;
  const info = await db.prepare('INSERT INTO waitlist_entries (talent_id,request_id,client_id,created_at) VALUES (?,?,?,?)')
    .run(talent.id, requestId, req.user.id, now());
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.post('/api/guest/:token/waitlist', async (req, res) => {
  const rq = await db.prepare('SELECT * FROM shop_requests WHERE guest_token=? AND is_guest=1').get(req.params.token);
  if (!rq) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const talent = await getUser(+((req.body || {}).talent_id || 0));
  if (!talent || !['creator', 'provider'].includes(talent.role) || talent.is_platform_founder) return res.status(404).json({ error: 'غير موجود' });
  const active = await activeBookingsCount(talent.id);
  if (capacityLeft(talent, active) !== 0) return res.status(400).json({ error: 'الصانع متاح حالياً — اطلب منه مباشرة بدل الانتظار' });
  const dup = await db.prepare(`SELECT id FROM waitlist_entries WHERE talent_id=? AND request_id=? AND status IN ('waiting','offered')`).get(talent.id, rq.id);
  if (dup) return res.status(409).json({ error: 'طلبك في قائمة الانتظار أصلاً' });
  const info = await db.prepare('INSERT INTO waitlist_entries (talent_id,request_id,guest_token,guest_name,created_at) VALUES (?,?,?,?,?)')
    .run(talent.id, rq.id, rq.guest_token, rq.guest_name, now());
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.get('/api/me/waitlist', auth, async (req, res) => {
  await sweepWaitlist();
  const mine = await db.prepare('SELECT * FROM waitlist_entries WHERE client_id=? ORDER BY created_at DESC').all(req.user.id);
  const forMe = await db.prepare('SELECT * FROM waitlist_entries WHERE talent_id=? ORDER BY created_at ASC').all(req.user.id);
  const enrich = async (e) => {
    const t = await getUser(e.talent_id);
    return { ...e, talent_name: t ? t.name : '', offered: e.status === 'offered' };
  };
  res.json({ mine: await Promise.all(mine.map(enrich)), for_me: await Promise.all(forMe.map(enrich)) });
});
app.post('/api/waitlist/:id/accept', auth, async (req, res) => {
  const e = await db.prepare('SELECT * FROM waitlist_entries WHERE id=?').get(+req.params.id);
  if (!e || e.client_id !== req.user.id) return res.status(404).json({ error: 'غير موجود' });
  if (e.status !== 'offered' || (e.expires_at && e.expires_at <= now())) return res.status(400).json({ error: 'انتهت مهلة دورك أو لم يحن بعد' });
  const talent = await getUser(e.talent_id);
  if (!talent || onVacation(talent)) return res.status(400).json({ error: 'الصانع غير متاح حالياً' });
  let title = `حجز مع ${talent.name}`, price = effectivePrice(talent);
  if (e.request_id) {
    const rq = await db.prepare('SELECT * FROM shop_requests WHERE id=?').get(e.request_id);
    if (rq && rq.status === 'open' && rq.shop_user_id === req.user.id) {
      title = rq.title; price = rq.budget && rq.budget > 0 ? rq.budget : price;
      await db.prepare(`UPDATE shop_requests SET status='booked' WHERE id=?`).run(rq.id);
    }
  }
  if (!price || price <= 0) return res.status(400).json({ error: 'لا سعر متاحاً لهذا الصانع حالياً' });
  const agrW = agreementFromBody(req.body || {}); if (agrW.error) return res.status(400).json({ error: agrW.error });
  // بوابة الهوية المالية (محرك المخاطر الحي) على طرفي حجز قائمة الانتظار.
  const gateW = await riskGateError(req.user, talent, price);
  if (gateW) return res.status(403).json({ error: gateW, fin_identity_required: true });
  const info = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,agreed_revisions,agreed_delivery_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, talent.id, 'waitlist', e.request_id || null, title, price, talent.currency, now() + 7 * 24 * 3600 * 1000, agrW.revisions, agrW.deliveryAt, now());
  await db.prepare(`UPDATE waitlist_entries SET status='converted' WHERE id=?`).run(e.id);
  await addBookingEvent(info.lastInsertRowid, 'created', 'أُنشئ الحجز من قائمة الانتظار — الضمان والمراحل موثّقة داخل Deal');
  await notify(talent.id, 'booking_new', `طلب حجز جديد #${info.lastInsertRowid} من قائمة الانتظار بقيمة ${price} ${talent.currency}`, `booking:${info.lastInsertRowid}`);
  res.json({ ok: true, booking_id: info.lastInsertRowid });
});
app.post('/api/waitlist/:id/leave', auth, async (req, res) => {
  await db.prepare(`UPDATE waitlist_entries SET status='left' WHERE id=? AND client_id=? AND status IN ('waiting','offered')`).run(+req.params.id, req.user.id);
  res.json({ ok: true });
});

/* ---- معرض أعمال العملاء (٧-ب): أحدث نماذج المسجلين من بيانات حقيقية فقط ---- */
app.get('/api/market/samples', async (req, res) => {
  const rows = await db.prepare(`SELECT pi.id, pi.platform, pi.embed_url, pi.title, pi.created_at, pi.user_id
    FROM portfolio_items pi JOIN users u ON u.id=pi.user_id
    WHERE u.banned=0 AND u.is_platform_founder=0 AND u.deleted_at=0 ORDER BY pi.created_at DESC, pi.id DESC LIMIT 60`).all();
  const byUser = new Map();
  const items = [];
  for (const r of rows) {
    if (!byUser.has(r.user_id)) { const u = await getUser(r.user_id); if (u) byUser.set(r.user_id, { u, score: await visibilityScore(u) }); }
    const e = byUser.get(r.user_id); if (!e) continue;
    items.push({ sample: { id: r.id, platform: r.platform, embed_url: r.embed_url, title: r.title || '', created_at: r.created_at }, creator: await publicUser(e.u), _score: e.score });
  }
  items.sort((a, b) => (b._score - a._score) || (b.sample.created_at - a.sample.created_at));
  res.json({ items: items.slice(0, 12).map(({ _score, ...x }) => x) });
});

/* ---- ٧) فيديوهات شغل يومية (تضمين يوتيوب/تيك توك فقط — لا تخزين) ---- */
const DAILY_VIDEO_CAP = 3;
async function dailyVideosOf(userId, limit = 30) {
  return await db.prepare('SELECT id,platform,embed_url,source_url,title,created_at FROM daily_videos WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT ?').all(userId, limit);
}
app.post('/api/me/daily-videos', auth, async (req, res) => {
  if (req.user.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس عرض فقط — لا فيديوهات' });
  if (!['creator', 'provider'].includes(req.user.role)) return res.status(400).json({ error: 'فيديوهات الشغل اليومية للصناع ومقدمي الخدمة فقط' });
  const { url, title = '' } = req.body || {};
  const parsed = parseVideoEmbed(url);
  if (!parsed || !['youtube', 'tiktok'].includes(parsed.platform)) {
    return res.status(400).json({ error: 'رابط غير مدعوم هنا — الصق رابط يوتيوب أو تيك توك (التضمين فقط، بلا رفع ملفات)' });
  }
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const todayCount = (await db.prepare('SELECT COUNT(*) c FROM daily_videos WHERE user_id=? AND created_at>=?').get(req.user.id, dayStart.getTime())).c;
  if (todayCount >= DAILY_VIDEO_CAP) return res.status(429).json({ error: `وصلت لحد اليوم: ${DAILY_VIDEO_CAP} فيديوهات شغل — كمّل بكرة` });
  const info = await db.prepare('INSERT INTO daily_videos (user_id,platform,video_id,embed_url,source_url,title,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(req.user.id, parsed.platform, parsed.video_id, parsed.embed_url, String(url).trim(), String(title || '').slice(0, 120), now());
  res.json({ item: { id: info.lastInsertRowid, platform: parsed.platform, embed_url: parsed.embed_url, title: String(title || '').slice(0, 120) }, items: await dailyVideosOf(req.user.id) });
});
app.get('/api/me/daily-videos', auth, async (req, res) => {
  res.json({ items: await dailyVideosOf(req.user.id) });
});
app.delete('/api/me/daily-videos/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM daily_videos WHERE id=? AND user_id=?').run(+req.params.id, req.user.id);
  res.json({ items: await dailyVideosOf(req.user.id) });
});
app.get('/api/daily-videos', async (req, res) => {
  const viewer = await optionalViewer(req);
  const rows = await db.prepare('SELECT * FROM daily_videos ORDER BY created_at DESC, id DESC LIMIT 30').all();
  const items = [];
  for (const v of rows) {
    const u = await getUser(v.user_id);
    if (!u || u.banned) continue;
    if (u.is_platform_founder) continue;
    items.push({
      id: v.id, platform: v.platform, embed_url: v.embed_url, title: v.title || '', created_at: v.created_at,
      author: await publicUser(u, viewer ? viewer.id : null),
    });
  }
  res.json({ items });
});

/* ---- ٦) ستوريز «متاح اليوم»: شريط من فعّلوا التوفر اليوم (يختفي بنهاية اليوم) ---- */
app.get('/api/stories/today', async (req, res) => {
  const viewer = await optionalViewer(req);
  let rows = await db.prepare(`SELECT * FROM users WHERE role IN ('creator','provider') AND available_today=1 AND banned=0 AND frozen=0`).all();
  if (!canSeeFounder(viewer)) rows = rows.filter((u) => !u.is_platform_founder);
  rows = rows.filter((u) => !onVacation(u));
  const items = [];
  for (const u of rows.slice(0, 30)) {
    const shorts = u.is_platform_founder ? [] : await shortsOf(u.id);
    items.push({ user: await publicUser(u, viewer ? viewer.id : null), short: shorts.length ? shorts[0] : null });
  }
  res.json({ items });
});

/* ---- ٨) قوالب طلب جاهزة للضيف/العميل (تعبئة نموذج فقط — لا حقول خادم جديدة) ---- */
const REQUEST_TEMPLATES = [
  { key: 'short_ad', ar: 'إعلان قصير', en: 'Short ad', niche: 'عام', title_ar: 'إعلان قصير لنشاطي', title_en: 'A short ad for my business',
    details_ar: 'محتاج إعلان قصير (٣٠–٦٠ ثانية) لنشاطي. المنتج/الخدمة: ___ | أهم رسالة في الإعلان: ___ | الأسلوب المفضل: ___', details_en: 'I need a short ad (30–60 seconds) for my business. Product/service: ___ | Key message: ___ | Preferred style: ___' },
  { key: 'opening', ar: 'تغطية افتتاح أو مناسبة', en: 'Opening / event coverage', niche: 'تصوير', title_ar: 'تغطية افتتاح أو مناسبة', title_en: 'Opening or event coverage',
    details_ar: 'محتاج تغطية افتتاح أو مناسبة (فيديو + صور). نوع المناسبة: ___ | التاريخ: ___ | العنوان: ___ | أهم لحظات لازم تتصور: ___', details_en: 'I need coverage of an opening or an event (video + photos). Event type: ___ | Date: ___ | Address: ___ | Must-capture moments: ___' },
  { key: 'products', ar: 'تصوير منتجات', en: 'Product photography', niche: 'تصوير', title_ar: 'تصوير منتجات', title_en: 'Product photography',
    details_ar: 'محتاج تصوير منتجات احترافي. عدد المنتجات: ___ | الاستخدام (سوشيال/متجر): ___ | أمثلة تعجبني: ___', details_en: 'I need professional product photography. Number of products: ___ | Usage (social/store): ___ | References I like: ___' },
  { key: 'monthly', ar: 'محتوى شهري', en: 'Monthly content', niche: 'عام', title_ar: 'محتوى شهري لصفحتي', title_en: 'Monthly content for my page',
    details_ar: 'محتاج محتوى شهري منتظم لصفحتي. عدد الفيديوهات شهرياً: ___ | نوع المحتوى: ___ | منصات النشر: ___', details_en: 'I need regular monthly content for my page. Videos per month: ___ | Content type: ___ | Platforms: ___' },
  ...TAXONOMY.services.map((s) => ({
    key: `svc_${s.key}`, ar: s.ar, en: s.en, niche: s.key, title_ar: `طلب خدمة: ${s.ar}`, title_en: `Service request: ${s.en}`,
    details_ar: `محتاج خدمة «${s.ar}». المطلوب بالظبط: ___ | الميعاد المطلوب: ___ | ملاحظات: ___`,
    details_en: `I need the "${s.en}" service. Exactly what I need: ___ | Deadline: ___ | Notes: ___`,
  })),
  { key: 'general', ar: 'طلب عام', en: 'General request', niche: '', title_ar: 'طلب خدمة', title_en: 'Service request',
    details_ar: 'المطلوب: ___ | تفاصيل إضافية: ___', details_en: 'What I need: ___ | Extra details: ___' },
];
app.get('/api/request-templates', (req, res) => res.json({ items: REQUEST_TEMPLATES }));

/* ---- ٩) تعاقد شهري متكرر ---- */
const CONTRACT_CYCLE_MS = 30 * 24 * 3600 * 1000;
async function generateContractCycle(c) {
  const ins = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,contract_id,title,price,currency,deadline,guest_name,guest_token,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(c.client_id || null, c.talent_id, 'contract', c.id, c.id, c.title || `تعاقد شهري #${c.id} — دورة ${c.cycles_done + 1}`, c.cycle_price, c.currency,
      now() + 30 * 24 * 3600 * 1000, c.guest_name || '', c.guest_token || '', now());
  await db.prepare('UPDATE contracts SET cycles_done=cycles_done+1, next_cycle_at=? WHERE id=?').run(now() + CONTRACT_CYCLE_MS, c.id);
  await addBookingEvent(ins.lastInsertRowid, 'created', 'أُنشئت دورة تعاقد شهري تلقائياً — الضمان والمراحل موثّقة داخل Deal');
  await notify(c.talent_id, 'contract_cycle', `🔁 دورة جديدة من التعاقد الشهري #${c.id}: حجز #${ins.lastInsertRowid} بقيمة ${c.cycle_price} ${c.currency}`, `booking:${ins.lastInsertRowid}`);
  if (c.client_id) await notify(c.client_id, 'contract_cycle', `🔁 بدأت دورة جديدة من تعاقدك الشهري #${c.id}: حجز #${ins.lastInsertRowid}`, `booking:${ins.lastInsertRowid}`);
  return ins.lastInsertRowid;
}
async function sweepContracts() {
  let made = 0;
  // إيقاف التجديد يُنهي التعاقد فوراً في المسح: الدورة المولّدة أصلاً حجز عادي
  // مستقل يكتمل بذاته، فلا دورات جديدة بعد طلب الإيقاف.
  const stopping = await db.prepare(`SELECT * FROM contracts WHERE status='active' AND stop_requested_by IS NOT NULL AND stop_requested_by<>''`).all();
  for (const c of stopping) {
    await db.prepare(`UPDATE contracts SET status='ended', next_cycle_at=0 WHERE id=?`).run(c.id);
    await notify(c.talent_id, 'contract_ended', `انتهى التعاقد الشهري #${c.id} — دورته الجارية المولّدة تكمل كحجز عادي مستقل`, `contract:${c.id}`);
    if (c.client_id) await notify(c.client_id, 'contract_ended', `انتهى تعاقدك الشهري #${c.id} — الدورة الجارية تكمل كحجز عادي`, `contract:${c.id}`);
  }
  const due = await db.prepare(`SELECT * FROM contracts WHERE status='active' AND next_cycle_at>0 AND next_cycle_at<=?`).all(now());
  for (const c of due) {
    if (c.stop_requested_by) {
      await db.prepare(`UPDATE contracts SET status='ended', next_cycle_at=0 WHERE id=?`).run(c.id);
      await notify(c.talent_id, 'contract_ended', `انتهى التعاقد الشهري #${c.id} بعد اكتمال دورته الجارية (طلب إيقاف مسجل)`, `contract:${c.id}`);
      if (c.client_id) await notify(c.client_id, 'contract_ended', `انتهى تعاقدك الشهري #${c.id} بعد اكتمال دورته الجارية`, `contract:${c.id}`);
      continue;
    }
    const talent = await getUser(c.talent_id);
    if (!talent || talent.banned) { await db.prepare(`UPDATE contracts SET status='ended', next_cycle_at=0 WHERE id=?`).run(c.id); continue; }
    await generateContractCycle(c);
    made++;
  }
  return made;
}
function contractView(c, viewerId) {
  return {
    id: c.id, talent_id: c.talent_id, client_id: c.client_id, is_guest: !!c.guest_token,
    title: c.title, service: c.service, times_per_month: c.times_per_month, cycle_price: c.cycle_price,
    currency: c.currency, status: c.status, client_accepted: !!c.client_accepted, talent_accepted: !!c.talent_accepted,
    terms_version: c.terms_version, cycles_done: c.cycles_done, next_cycle_at: c.next_cycle_at || 0,
    stop_requested_by: c.stop_requested_by || '', created_at: c.created_at,
    mine: viewerId ? (c.client_id === viewerId ? 'client' : c.talent_id === viewerId ? 'talent' : '') : (c.guest_token ? 'client' : ''),
  };
}
app.post('/api/contracts', auth, async (req, res) => {
  const { talent_id, title = '', service = '', times_per_month = 1, cycle_price } = req.body || {};
  const talent = await getUser(+talent_id);
  if (!talent || !['creator', 'provider'].includes(talent.role) || talent.is_platform_founder) return res.status(400).json({ error: 'المنفذ غير صحيح' });
  if (founderClientBlocked(req, res)) return;
  if (talent.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك التعاقد مع نفسك' });
  if (onVacation(talent)) return res.status(400).json({ error: 'المنفذ في إجازة حالياً' });
  const price = +cycle_price;
  if (!isFinite(price) || price <= 0) return res.status(400).json({ error: 'حدد سعر دورة صحيح' });
  const times = Math.min(30, Math.max(1, Math.floor(+times_per_month || 1)));
  const info = await db.prepare(`INSERT INTO contracts (client_id,talent_id,title,service,times_per_month,cycle_price,currency,status,client_accepted,terms_version,created_at)
    VALUES (?,?,?,?,?,?,?,'pending',1,?,?)`)
    .run(req.user.id, talent.id, String(title).slice(0, 120), String(service).slice(0, 120), times, price, talent.currency, TX_TERMS_VERSION, now());
  await notify(talent.id, 'contract_new', `📄 اقتراح تعاقد شهري من ${req.user.name}: ${times} مرة/شهر بسعر دورة ${price} ${talent.currency} — اقبله من «تعاقداتي» ليبدأ`, `contract:${info.lastInsertRowid}`);
  const c = await db.prepare('SELECT * FROM contracts WHERE id=?').get(info.lastInsertRowid);
  res.json({ contract: contractView(c, req.user.id) });
});
app.post('/api/guest/:token/contracts', async (req, res) => {
  const bk = await guestBookingByToken(req.params.token);
  if (!bk || bk.status !== 'completed') return res.status(400).json({ error: 'التعاقد الشهري للضيف يبدأ من صفقة مكتملة على نفس الرابط' });
  const { times_per_month = 1, cycle_price, service = '' } = req.body || {};
  const talent = await getUser(bk.talent_id);
  const price = +cycle_price;
  if (!isFinite(price) || price <= 0) return res.status(400).json({ error: 'حدد سعر دورة صحيح' });
  if (onVacation(talent)) return res.status(400).json({ error: 'المنفذ في إجازة حالياً' });
  const times = Math.min(30, Math.max(1, Math.floor(+times_per_month || 1)));
  const info = await db.prepare(`INSERT INTO contracts (guest_token,guest_name,talent_id,title,service,times_per_month,cycle_price,currency,status,client_accepted,terms_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,'pending',1,?,?)`)
    .run(bk.guest_token, bk.guest_name, talent.id, `تعاقد شهري — ${bk.title}`, String(service).slice(0, 120), times, price, bk.currency, TX_TERMS_VERSION, now());
  await notify(talent.id, 'contract_new', `📄 اقتراح تعاقد شهري من عميل ضيف (${bk.guest_name || 'عميل'}): ${times} مرة/شهر بسعر دورة ${price} ${bk.currency} — اقبله من «تعاقداتي» ليبدأ`, `contract:${info.lastInsertRowid}`);
  const c = await db.prepare('SELECT * FROM contracts WHERE id=?').get(info.lastInsertRowid);
  res.json({ contract: contractView(c, null) });
});
app.get('/api/contracts', auth, async (req, res) => {
  await sweepContracts();
  const rows = await db.prepare('SELECT * FROM contracts WHERE client_id=? OR talent_id=? ORDER BY created_at DESC').all(req.user.id, req.user.id);
  res.json({ items: rows.map((c) => contractView(c, req.user.id)) });
});
app.post('/api/contracts/:id/accept', auth, async (req, res) => {
  const c = await db.prepare('SELECT * FROM contracts WHERE id=?').get(+req.params.id);
  if (!c || c.talent_id !== req.user.id || c.status !== 'pending') return res.status(404).json({ error: 'غير موجود' });
  if (onVacation(req.user)) return res.status(400).json({ error: 'أنت في إجازة — أوقفها أولاً لقبول تعاقدات' });
  await db.prepare(`UPDATE contracts SET talent_accepted=1, status='active', next_cycle_at=? WHERE id=?`).run(now(), c.id);
  const fresh = await db.prepare('SELECT * FROM contracts WHERE id=?').get(c.id);
  const bookingId = await generateContractCycle(fresh);
  if (fresh.client_id) await notify(fresh.client_id, 'contract_active', `✅ قبل ${req.user.name} تعاقدك الشهري #${c.id} وبدأت أول دورة (حجز #${bookingId})`, `contract:${c.id}`);
  res.json({ ok: true, booking_id: bookingId, contract: contractView(await db.prepare('SELECT * FROM contracts WHERE id=?').get(c.id), req.user.id) });
});
app.post('/api/contracts/:id/stop', auth, async (req, res) => {
  const c = await db.prepare('SELECT * FROM contracts WHERE id=?').get(+req.params.id);
  if (!c || (c.client_id !== req.user.id && c.talent_id !== req.user.id)) return res.status(404).json({ error: 'غير موجود' });
  if (!['pending', 'active'].includes(c.status)) return res.status(400).json({ error: 'التعاقد منتهٍ أصلاً' });
  const side = c.client_id === req.user.id ? 'client' : 'talent';
  if (c.status === 'pending') {
    await db.prepare(`UPDATE contracts SET status='ended', stop_requested_by=? WHERE id=?`).run(side, c.id);
  } else {
    await db.prepare(`UPDATE contracts SET stop_requested_by=? WHERE id=?`).run(side, c.id);
  }
  const other = side === 'client' ? c.talent_id : c.client_id;
  if (other) await notify(other, 'contract_stop', `طلب الطرف الآخر إيقاف تجديد التعاقد الشهري #${c.id} — الدورة الجارية تكتمل فقط ولا تتجدد`, `contract:${c.id}`);
  res.json({ ok: true });
});
app.post('/api/guest/:token/contracts/:id/stop', async (req, res) => {
  const c = await db.prepare('SELECT * FROM contracts WHERE id=? AND guest_token=?').get(+req.params.id, req.params.token);
  if (!c) return res.status(404).json({ error: 'غير موجود' });
  if (c.status === 'pending') await db.prepare(`UPDATE contracts SET status='ended', stop_requested_by='client' WHERE id=?`).run(c.id);
  else if (c.status === 'active') await db.prepare(`UPDATE contracts SET stop_requested_by='client' WHERE id=?`).run(c.id);
  else return res.status(400).json({ error: 'التعاقد منتهٍ أصلاً' });
  await notify(c.talent_id, 'contract_stop', `طلب العميل إيقاف تجديد التعاقد الشهري #${c.id} — الدورة الجارية تكتمل فقط`, `contract:${c.id}`);
  res.json({ ok: true });
});

/* ---- ١٠) تحدي الأسبوع: لوحة آلية + تتويج أسبوعي ---- */
function weekStartMs(t) {
  const d = new Date(t); d.setUTCHours(0, 0, 0, 0);
  const dow = (d.getUTCDay() + 6) % 7; // الاثنين = 0
  return d.getTime() - dow * 24 * 3600 * 1000;
}
function weekKeyOf(t) {
  const s = new Date(weekStartMs(t));
  return `${s.getUTCFullYear()}-W${String(Math.floor((s.getTime() - Date.UTC(s.getUTCFullYear(), 0, 1)) / (7 * 24 * 3600 * 1000)) + 1).padStart(2, '0')}-${s.getTime()}`;
}
async function challengeLeaders(fromMs, toMs, limit = 10) {
  const rows = await db.prepare(`
    SELECT u.id,
      (SELECT COUNT(*) FROM bookings b WHERE b.talent_id=u.id AND b.status='completed' AND b.completed_at>=? AND b.completed_at<?) AS done,
      (SELECT COUNT(*) FROM daily_videos v WHERE v.user_id=u.id AND v.created_at>=? AND v.created_at<?) AS vids
    FROM users u WHERE u.role IN ('creator','provider') AND u.is_platform_founder=0 AND u.banned=0`).all(fromMs, toMs, fromMs, toMs);
  return rows.map((r) => ({ user_id: r.id, completed: r.done || 0, videos: r.vids || 0, score: (r.done || 0) * 5 + (r.vids || 0) * 2 }))
    .filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.user_id - b.user_id).slice(0, limit);
}
async function sweepChallenge() {
  const prevStart = weekStartMs(now()) - 7 * 24 * 3600 * 1000;
  const prevKey = weekKeyOf(prevStart);
  const existing = await db.prepare('SELECT * FROM challenge_weeks WHERE week_key=?').get(prevKey);
  if (existing) return existing;
  const leaders = await challengeLeaders(prevStart, prevStart + 7 * 24 * 3600 * 1000, 1);
  if (!leaders.length) return null;
  const w = leaders[0];
  await db.prepare('INSERT INTO challenge_weeks (week_key,winner_id,completed_count,videos_count,score,crowned_at) VALUES (?,?,?,?,?,?)')
    .run(prevKey, w.user_id, w.completed, w.videos, w.score, now());
  await notify(w.user_id, 'challenge_win', `🏆 أنت «صانع الأسبوع» على Deal — تصدّرت الأسبوع الماضي بـ${w.completed} صفقة مكتملة و${w.videos} فيديو شغل. شارتك ظاهرة في ملفك وظهورك مميز في السوق هذا الأسبوع`, 'challenge');
  return await db.prepare('SELECT * FROM challenge_weeks WHERE week_key=?').get(prevKey);
}
async function currentChampion() {
  await sweepChallenge();
  const row = await db.prepare('SELECT * FROM challenge_weeks ORDER BY crowned_at DESC LIMIT 1').get();
  if (!row) return null;
  // التتويج يخص الأسبوع السابق؛ البطل يُعرض خلال الأسبوع الجاري فقط.
  if (row.week_key !== weekKeyOf(weekStartMs(now()) - 7 * 24 * 3600 * 1000)) return null;
  const u = await getUser(row.winner_id);
  return u ? { user: await publicUser(u), completed: row.completed_count, videos: row.videos_count, score: row.score } : null;
}
app.get('/api/challenge', async (req, res) => {
  const start = weekStartMs(now());
  const leaders = await challengeLeaders(start, start + 7 * 24 * 3600 * 1000, 10);
  const items = [];
  for (const l of leaders) {
    const u = await getUser(l.user_id);
    if (u) items.push({ ...l, user: await publicUser(u) });
  }
  res.json({ week_start: start, leaders: items, champion: await currentChampion() });
});

/* ---- ١١) إكرامية بعد الإتمام (بلا عمولة — التزام tip مستقل في السجل) ---- */
async function tipsOf(bookingId) {
  const rows = await db.prepare(`SELECT * FROM money_obligations WHERE kind='tip' AND booking_id=? ORDER BY id ASC`).all(bookingId);
  return rows.map((o) => ({ id: o.id, code: o.code, amount: o.base_amount, exact_amount: mround(o.exact_amount), currency: o.currency, status: o.status, created_at: o.created_at }));
}
async function createTip(b, amount, payer) {
  if (b.status !== 'completed') return { error: 'الإكرامية بعد إتمام الصفقة فقط' };
  const amt = +amount;
  if (!isFinite(amt) || amt <= 0) return { error: 'حدد مبلغ إكرامية صحيح' };
  const ob = await createObligation({
    kind: 'tip', booking_id: b.id, user_id: b.talent_id, base_amount: mround(amt), currency: b.currency,
    payer_user_id: payer.userId || null, guest_token: payer.guestToken || '', payee: 'talent', payee_user_id: b.talent_id,
  });
  await moneyLedger(ob.id, '', 'open', 'system', 'إكرامية اختيارية بعد إتمام الصفقة — بلا عمولة Deal');
  await notify(b.talent_id, 'tip_new', `💛 عميل صفقة #${b.id} سايب لك إكرامية ${mround(amt)} ${b.currency} تقديراً لشغلك — بتوصلك مباشرة بنفس آلية الدفع (مرجع ${ob.code})`, `booking:${b.id}`);
  return { ob };
}
app.post('/api/bookings/:id/tip', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.client_id !== req.user.id) return res.status(404).json({ error: 'غير موجود' });
  const out = await createTip(b, (req.body || {}).amount, { userId: req.user.id });
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ ok: true, obligation: await payerObligationView(out.ob, req.user.country || 'EG') });
});
app.post('/api/guest/:token/tip', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const out = await createTip(b, (req.body || {}).amount, { guestToken: req.params.token });
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ ok: true, obligation: await payerObligationView(out.ob, await guestCountryByToken(req.params.token)) });
});
app.post('/api/guest/:token/tip/claim', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const ob = await getObligation(+((req.body || {}).obligation_id || 0));
  if (!ob || ob.kind !== 'tip' || ob.booking_id !== b.id || ob.status !== 'open') return res.status(400).json({ error: 'التزام إكرامية غير متاح' });
  const ref = String((req.body || {}).ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'مرجع التحويل مطلوب' });
  const fresh = await setObligationStatus(ob, 'claimed', 'guest', 'أعلن العميل تحويل الإكرامية', { transfer_ref: ref });
  res.json({ ok: true, obligation: obligationView(fresh) });
});
app.post('/api/bookings/:id/tip/confirm', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.talent_id !== req.user.id) return res.status(404).json({ error: 'غير موجود' });
  const ob = await getObligation(+((req.body || {}).obligation_id || 0));
  if (!ob || ob.kind !== 'tip' || ob.booking_id !== b.id || !['claimed', 'open'].includes(ob.status)) return res.status(400).json({ error: 'التزام إكرامية غير متاح للتأكيد' });
  const fresh = await setObligationStatus(ob, 'confirmed', 'talent', 'أكد المنفذ استلام الإكرامية');
  if (b.client_id) await notify(b.client_id, 'tip_confirmed', `💛 أكد المنفذ استلام إكراميتك على صفقة #${b.id} — شكراً لتقديرك`, `booking:${b.id}`);
  res.json({ ok: true, obligation: obligationView(fresh) });
});

/* ---- ١٣) أسئلة عامة على ملف الصانع ---- */
const QUESTIONS_DAILY_CAP = 10;
app.get('/api/talent/:id/questions', async (req, res) => {
  const u = await getUser(+req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  const rows = await db.prepare('SELECT * FROM profile_questions WHERE talent_id=? ORDER BY (answer=\'\') ASC, created_at DESC LIMIT 50').all(u.id);
  res.json({ items: rows.map((q) => ({ id: q.id, asker_name: q.asker_name || 'زائر', question: q.question, answer: q.answer || '', answered: !!q.answered_at, created_at: q.created_at, answered_at: q.answered_at || 0 })) });
});
app.post('/api/talent/:id/questions', async (req, res) => {
  const u = await getUser(+req.params.id);
  if (!u || !['creator', 'provider'].includes(u.role)) return res.status(404).json({ error: 'غير موجود' });
  if (u.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس عرض فقط — لا أسئلة عليه' });
  const viewer = await optionalViewer(req);
  const question = String((req.body || {}).question || '').trim();
  if (!question || question.length < 3) return res.status(400).json({ error: 'اكتب سؤالاً واضحاً' });
  if (question.length > 300) return res.status(400).json({ error: 'السؤال أطول من 300 حرف' });
  const askerName = viewer ? viewer.name : String((req.body || {}).asker_name || '').trim().slice(0, 60);
  if (!viewer && !askerName) return res.status(400).json({ error: 'اكتب اسمك مع السؤال' });
  if (viewer && viewer.id === u.id) return res.status(400).json({ error: 'لا يمكنك سؤال نفسك' });
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const cnt = viewer
    ? (await db.prepare('SELECT COUNT(*) c FROM profile_questions WHERE talent_id=? AND asker_id=? AND created_at>=?').get(u.id, viewer.id, dayStart.getTime())).c
    : (await db.prepare('SELECT COUNT(*) c FROM profile_questions WHERE talent_id=? AND asker_id IS NULL AND asker_name=? AND created_at>=?').get(u.id, askerName, dayStart.getTime())).c;
  if (cnt >= QUESTIONS_DAILY_CAP) return res.status(429).json({ error: 'وصلت لحد أسئلة اليوم لهذا الملف' });
  const info = await db.prepare('INSERT INTO profile_questions (talent_id,asker_id,asker_name,question,created_at) VALUES (?,?,?,?,?)')
    .run(u.id, viewer ? viewer.id : null, askerName, question, now());
  await notify(u.id, 'profile_question', `❓ سؤال عام جديد في ملفك من ${askerName}: «${question.slice(0, 80)}» — أجب علناً مرة واحدة من ملفك`, `talent:${u.id}`);
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.post('/api/questions/:id/answer', auth, async (req, res) => {
  const q = await db.prepare('SELECT * FROM profile_questions WHERE id=?').get(+req.params.id);
  if (!q || q.talent_id !== req.user.id) return res.status(404).json({ error: 'غير موجود' });
  if (q.answered_at) return res.status(400).json({ error: 'اتجاوب على السؤال ده خلاص — الإجابة العامة مرة واحدة' });
  const answer = String((req.body || {}).answer || '').trim();
  if (!answer || answer.length > 600) return res.status(400).json({ error: 'إجابة صحيحة مطلوبة (حتى 600 حرف)' });
  await db.prepare('UPDATE profile_questions SET answer=?, answered_at=? WHERE id=?').run(answer, now(), q.id);
  if (q.asker_id) await notify(q.asker_id, 'profile_answer', `💬 ${req.user.name} جاوب على سؤالك في ملفه: «${answer.slice(0, 80)}»`, `talent:${req.user.id}`);
  res.json({ ok: true });
});
app.delete('/api/questions/:id', auth, async (req, res) => {
  const q = await db.prepare('SELECT * FROM profile_questions WHERE id=?').get(+req.params.id);
  if (!q || (q.talent_id !== req.user.id && !req.user.is_platform_founder)) return res.status(404).json({ error: 'غير موجود' });
  await db.prepare('DELETE FROM profile_questions WHERE id=?').run(q.id);
  res.json({ ok: true });
});

/* ---- ١٤) جدار «صفقات تمت»: آخر صفقات مكتملة فعلياً، مجهّلة الهوية ---- */
function serviceLabelOf(u) {
  if (!u) return '';
  if (u.role === 'provider') {
    if (u.provider_category === 'other') return u.provider_custom || 'خدمة';
    const s = TAXONOMY.services.find((x) => x.key === u.provider_category);
    return s ? s.ar : (u.provider_custom || 'خدمة');
  }
  return u.niche || 'محتوى';
}
app.get('/api/deals-wall', async (req, res) => {
  const rows = await db.prepare(`SELECT b.price, b.currency, b.completed_at, b.talent_id FROM bookings b WHERE b.status='completed' AND b.completed_at>0 ORDER BY b.completed_at DESC LIMIT 12`).all();
  const items = [];
  for (const r of rows) {
    const t = await getUser(r.talent_id);
    if (!t || t.is_platform_founder) continue;
    items.push({ service: serviceLabelOf(t), city: t.city || '', price: r.price, currency: r.currency, completed_at: r.completed_at, done: true });
  }
  res.json({ items });
});

/* ---- ١٥) ملخص صفقة (صفحة طباعة نظيفة — «ملخص صفقة» فقط، بلا أي تسمية أخرى) ---- */
function escHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
async function dealSummaryHtml(b) {
  const talent = await getUser(b.talent_id);
  const clientName = b.client_id ? ((await getUser(b.client_id)) || {}).name || 'عميل' : (b.guest_name || 'عميل ضيف');
  const legs = bookingLegAmounts(b);
  const pays = await db.prepare('SELECT kind,amount,status,created_at FROM payments WHERE booking_id=? ORDER BY id ASC').all(b.id);
  const payRows = pays.map((p) => `<tr><td>${escHtml(p.kind)}</td><td>${p.amount} ${escHtml(b.currency)}</td><td>${escHtml(p.status)}</td><td>${new Date(p.created_at).toLocaleString('ar-EG')}</td></tr>`).join('');
  const statusAr = { completed: 'مكتملة', cancelled: 'ملغية', disputed: 'قيد التحكيم' }[b.status] || b.status;
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملخص صفقة #${b.id} — Deal</title>
<style>body{font-family:Tahoma,Arial,sans-serif;background:#0b0b0d;color:#f2e9d8;margin:0;padding:24px} .card{max-width:640px;margin:auto;background:#141416;border:1px solid #c9a227;border-radius:14px;padding:24px} h1{color:#c9a227;font-size:22px;margin:0 0 4px} .sub{color:#b8ab8d;font-size:13px;margin-bottom:16px} table{width:100%;border-collapse:collapse;margin:12px 0} td,th{border-bottom:1px solid #2a2a2e;padding:8px;text-align:right;font-size:14px} .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #2a2a2e;font-size:14px} .gold{color:#c9a227} button{background:#c9a227;border:0;padding:10px 18px;border-radius:10px;font-weight:bold;cursor:pointer} @media print{button{display:none} body{background:#fff;color:#111} .card{border-color:#999;background:#fff}}</style></head>
<body><div class="card">
<h1>ملخص صفقة #${b.id}</h1><div class="sub">Deal — منصة كل صناع المحتوى · ملخص موثّق من سجلات المنصة</div>
<div class="row"><span>العميل</span><b>${escHtml(clientName)}</b></div>
<div class="row"><span>المنفذ</span><b>${escHtml(talent ? talent.name : '')}</b></div>
<div class="row"><span>الخدمة</span><b>${escHtml(b.title || '')}</b></div>
<div class="row"><span>الحالة</span><b class="gold">${escHtml(statusAr)}</b></div>
<div class="row"><span>قيمة الصفقة</span><b>${b.price} ${escHtml(b.currency)}</b></div>
<div class="row"><span>عمولة Deal (١٠٪)</span><b>${legs.fee} ${escHtml(b.currency)}</b></div>
<div class="row"><span>العربون (مباشرة للمنفذ)</span><b>${legs.deposit} ${escHtml(b.currency)}</b></div>
<div class="row"><span>الباقي (مباشرة للمنفذ)</span><b>${legs.rest} ${escHtml(b.currency)}</b></div>
<div class="row"><span>تاريخ الإنشاء</span><b>${new Date(b.created_at).toLocaleString('ar-EG')}</b></div>
${b.completed_at ? `<div class="row"><span>تاريخ الإتمام</span><b>${new Date(b.completed_at).toLocaleString('ar-EG')}</b></div>` : ''}
${pays.length ? `<table><tr><th>المرحلة</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th></tr>${payRows}</table>` : ''}
<p class="sub">المدفوعات في Deal تتحرك بين الطرفين مباشرة — المنصة لا تستلم ولا تحتجز أموال المعاملات. هذا الملخص صادر آلياً من سجلات الصفقة داخل المنصة.</p>
<button onclick="window.print()">طباعة / حفظ PDF</button>
</div></body></html>`;
}
app.get('/api/bookings/:id/summary', auth, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.status !== 'completed') return res.status(404).json({ error: 'ملخص الصفقة متاح بعد الإتمام فقط' });
  if (b.client_id !== req.user.id && b.talent_id !== req.user.id && !req.user.is_platform_founder) return res.status(404).json({ error: 'غير موجود' });
  res.type('html').send(await dealSummaryHtml(b));
});
app.get('/api/guest/:token/summary', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b || b.status !== 'completed') return res.status(404).json({ error: 'ملخص الصفقة متاح بعد الإتمام فقط' });
  res.type('html').send(await dealSummaryHtml(b));
});

/* ---- ١٦) أقسام موسمية تلقائية (تقويم مدمج — هجري للمواسم الإسلامية) ---- */
function gregorianToJd(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 + Math.floor(y2 / 4) - Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045;
}
function islamicToJd(y, m, d) {
  return d + Math.ceil(29.5 * (m - 1)) + (y - 1) * 354 + Math.floor((3 + 11 * y) / 30) + 1948440 - 1;
}
function jdToIslamic(jd) {
  let y = Math.floor((30 * (jd - 1948440)) / 10631) + 1;
  while (islamicToJd(y + 1, 1, 1) <= jd) y++;
  while (islamicToJd(y, 1, 1) > jd) y--;
  let m = 1;
  while (m < 12 && islamicToJd(y, m + 1, 1) <= jd) m++;
  return { y, m, d: jd - islamicToJd(y, m, 1) + 1 };
}
function jdToGregorian(jd) {
  const a = jd + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d2 = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d2) / 4);
  const mm = Math.floor((5 * e + 2) / 153);
  return { y: 100 * b + d2 - 4800 + Math.floor(mm / 10), m: mm + 3 - 12 * Math.floor(mm / 10), d: e - Math.floor((153 * mm + 2) / 5) + 1 };
}
const jdToMs = (jd) => { const g = jdToGregorian(jd); return Date.UTC(g.y, g.m - 1, g.d); };
const SEASONS = [
  { key: 'ramadan', ar: 'رمضان', en: 'Ramadan', hijri: [9, 1, 10, 1], niches: ['طبخ', 'ديني', 'عام', 'videoproduction'] },
  { key: 'eid_fitr', ar: 'عيد الفطر', en: 'Eid al-Fitr', hijri: [10, 1, 10, 4], niches: ['عام', 'جمال', 'أطفال', 'videoproduction'] },
  { key: 'eid_adha', ar: 'عيد الأضحى', en: 'Eid al-Adha', hijri: [12, 9, 12, 14], niches: ['عام', 'سفر', 'طبخ', 'videoproduction'] },
  { key: 'school', ar: 'دخول المدارس', en: 'Back to school', md: ['08-25', '09-30'], niches: ['تعليم', 'أطفال', 'videoproduction'] },
  { key: 'white_friday', ar: 'الجمعة البيضاء', en: 'White Friday', special: 'white_friday', niches: [] },
  { key: 'summer', ar: 'موسم الصيف', en: 'Summer season', md: ['06-15', '08-31'], niches: ['سفر', 'رياضة', 'صحة ولياقة', 'videoproduction'] },
  { key: 'new_year', ar: 'رأس السنة', en: 'New Year', md: ['12-26', '01-02'], niches: ['عام', 'videoproduction'] },
  /* مواسم وطنية محلية (تكافؤ الدول): قسم الموسم يظهر لصناع دولته فقط —
     حقل countries يقصر قسم /api/seasons/active على مستخدمي هذه الدول.
     التواريخ هي الأعياد الوطنية الرسمية المعروفة لكل دولة. */
  { key: 'nd_eg', ar: 'اليوم الوطني المصري', en: 'Egypt National Day', md: ['07-21', '07-23'], niches: ['عام', 'videoproduction'], countries: ['EG'] },
  { key: 'nd_sa', ar: 'اليوم الوطني السعودي', en: 'Saudi National Day', md: ['09-20', '09-23'], niches: ['عام', 'videoproduction'], countries: ['SA'] },
  { key: 'nd_ae', ar: 'اليوم الوطني الإماراتي', en: 'UAE National Day', md: ['11-30', '12-03'], niches: ['عام', 'videoproduction'], countries: ['AE'] },
  { key: 'nd_kw', ar: 'اليوم الوطني الكويتي', en: 'Kuwait National Day', md: ['02-23', '02-26'], niches: ['عام', 'videoproduction'], countries: ['KW'] },
  { key: 'nd_qa', ar: 'اليوم الوطني القطري', en: 'Qatar National Day', md: ['12-16', '12-18'], niches: ['عام', 'videoproduction'], countries: ['QA'] },
  { key: 'nd_bh', ar: 'اليوم الوطني البحريني', en: 'Bahrain National Day', md: ['12-14', '12-17'], niches: ['عام', 'videoproduction'], countries: ['BH'] },
  { key: 'nd_om', ar: 'اليوم الوطني العُماني', en: 'Oman National Day', md: ['11-16', '11-18'], niches: ['عام', 'videoproduction'], countries: ['OM'] },
  { key: 'nd_jo', ar: 'عيد استقلال الأردن', en: 'Jordan Independence Day', md: ['05-23', '05-25'], niches: ['عام', 'videoproduction'], countries: ['JO'] },
  { key: 'nd_ma', ar: 'عيد استقلال المغرب', en: 'Morocco Independence Day', md: ['11-16', '11-18'], niches: ['عام', 'videoproduction'], countries: ['MA'] },
];
function mdToMs(y, md) { const [m, d] = md.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function seasonWindow(season, t) {
  const dNow = new Date(t);
  if (season.hijri) {
    const jd = gregorianToJd(dNow.getUTCFullYear(), dNow.getUTCMonth() + 1, dNow.getUTCDate());
    const hy = jdToIslamic(jd).y;
    const [sm, sd, em, ed] = season.hijri;
    for (const Y of [hy - 1, hy, hy + 1]) {
      const startJd = islamicToJd(Y, sm, sd);
      const endJd = islamicToJd(em <= sm && em < 12 ? Y + (em < sm ? 1 : 0) : Y, em, ed);
      const eJ = em < sm ? islamicToJd(Y + 1, em, ed) : islamicToJd(Y, em, ed);
      if (jd >= startJd && jd < eJ) return { start: jdToMs(startJd), end: jdToMs(eJ) };
      void endJd;
    }
    return null;
  }
  if (season.special === 'white_friday') {
    for (const Y of [dNow.getUTCFullYear() - 1, dNow.getUTCFullYear(), dNow.getUTCFullYear() + 1]) {
      let lastFri = Date.UTC(Y, 10, 30);
      while (new Date(lastFri).getUTCDay() !== 5) lastFri -= 24 * 3600 * 1000;
      const start = lastFri - 4 * 24 * 3600 * 1000, end = lastFri + 2 * 24 * 3600 * 1000;
      if (t >= start && t < end) return { start, end };
    }
    return null;
  }
  if (season.md) {
    const [s, e] = season.md;
    for (const Y of [dNow.getUTCFullYear() - 1, dNow.getUTCFullYear(), dNow.getUTCFullYear() + 1]) {
      const start = mdToMs(Y, s);
      let end = mdToMs(Y, e) + 24 * 3600 * 1000;
      if (e < s) end = mdToMs(Y + 1, e) + 24 * 3600 * 1000; // نافذة تعبر نهاية السنة
      if (t >= start && t < end) return { start, end };
    }
  }
  return null;
}
async function seasonOverrides() {
  const off = (await getSetting('season_disabled') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const winRaw = await getSetting('season_windows');
  let wins = {};
  try { wins = JSON.parse(winRaw || '{}'); } catch (e) { wins = {}; }
  return { off, wins };
}
async function activeSeasons(t = now()) {
  const { off, wins } = await seasonOverrides();
  const out = [];
  const all = [...SEASONS];
  const customs = await db.prepare('SELECT * FROM seasons_custom').all();
  for (const c of customs) all.push({ key: c.key, ar: c.name_ar, en: c.name_en, md: [c.start_md, c.end_md], niches: String(c.niches || '').split(',').map((s) => s.trim()).filter(Boolean), custom: true });
  for (const s of all) {
    if (off.includes(s.key)) continue;
    let win = null;
    if (wins[s.key] && wins[s.key].start && wins[s.key].end) {
      win = seasonWindow({ key: s.key, md: [wins[s.key].start, wins[s.key].end] }, t);
    } else {
      win = seasonWindow(s, t);
    }
    if (win) out.push({ key: s.key, ar: s.ar, en: s.en, niches: s.niches || [], countries: s.countries || null, start: win.start, end: win.end, custom: !!s.custom });
  }
  return out;
}
app.get('/api/seasons/active', async (req, res) => {
  const viewer = await optionalViewer(req);
  const seasons = await activeSeasons();
  const out = [];
  for (const s of seasons) {
    let sql = `SELECT * FROM users WHERE role IN ('creator','provider') AND banned=0 AND is_platform_founder=0`;
    const args = [];
    if (!canSeeFounder(viewer)) { /* المؤسس مستبعد أصلاً بشرط is_platform_founder=0 */ }
    if (s.niches && s.niches.length) {
      sql += ` AND (niche IN (${s.niches.map(() => '?').join(',')}) OR provider_category IN (${s.niches.map(() => '?').join(',')}))`;
      args.push(...s.niches, ...s.niches);
    }
    if (s.countries && s.countries.length) {
      sql += ` AND country IN (${s.countries.map(() => '?').join(',')})`;
      args.push(...s.countries);
    }
    sql += ' LIMIT 60';
    let rows = await db.prepare(sql).all(...args);
    rows = rows.filter((u) => !onVacation(u));
    const scored = await Promise.all(rows.map(async (u) => ({ u, v: await visibilityScore(u, {}) })));
    scored.sort((a, b) => b.v.score - a.v.score);
    out.push({ ...s, creators: await Promise.all(scored.slice(0, 12).map((x) => publicUser(x.u, viewer ? viewer.id : null))) });
  }
  res.json({ items: out });
});
app.get('/api/owner/seasons', auth, ownerOnly, async (req, res) => {
  const { off, wins } = await seasonOverrides();
  const customs = await db.prepare('SELECT * FROM seasons_custom ORDER BY id ASC').all();
  res.json({
    builtins: SEASONS.map((s) => ({ key: s.key, ar: s.ar, en: s.en, countries: s.countries || null, disabled: off.includes(s.key), window_override: wins[s.key] || null })),
    customs, disabled: off, active_now: (await activeSeasons()).map((s) => s.key),
  });
});
app.post('/api/owner/seasons', auth, ownerOnly, async (req, res) => {
  const { action, key } = req.body || {};
  const { off, wins } = await seasonOverrides();
  if (action === 'disable' || action === 'enable') {
    if (!key) return res.status(400).json({ error: 'مفتاح الموسم مطلوب' });
    const set = new Set(off);
    if (action === 'disable') set.add(String(key)); else set.delete(String(key));
    await setSetting('season_disabled', [...set].join(','));
    return res.json({ ok: true, disabled: [...set] });
  }
  if (action === 'window') {
    const { start, end } = req.body || {};
    if (!key || !/^\d{2}-\d{2}$/.test(start || '') || !/^\d{2}-\d{2}$/.test(end || '')) return res.status(400).json({ error: 'نافذة صحيحة مطلوبة بصيغة MM-DD' });
    wins[String(key)] = { start, end };
    await setSetting('season_windows', JSON.stringify(wins));
    return res.json({ ok: true, windows: wins });
  }
  if (action === 'add') {
    const { name_ar, name_en, start, end, niches } = req.body || {};
    if (!name_ar || !/^\d{2}-\d{2}$/.test(start || '') || !/^\d{2}-\d{2}$/.test(end || '')) return res.status(400).json({ error: 'اسم ونافذة صحيحة مطلوبة' });
    const cKey = 'custom_' + rnd(4);
    await db.prepare('INSERT INTO seasons_custom (key,name_ar,name_en,start_md,end_md,niches,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(cKey, String(name_ar).slice(0, 60), String(name_en || '').slice(0, 60), start, end, String(niches || '').slice(0, 300), now());
    return res.json({ ok: true, key: cKey });
  }
  if (action === 'delete_custom') {
    await db.prepare('DELETE FROM seasons_custom WHERE key=?').run(String(key || ''));
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: 'إجراء غير معروف' });
});

/* ---- ١٧) أكاديمية Deal: للجميع ولكل الخدمات ---- */
const L = (key, ar, en, body_ar, body_en, video = '') => ({ key, ar, en, body_ar, body_en, video });
const ACADEMY_TRACKS = [
  { key: 'showcase', ar: 'اعرض شغلك صح', en: 'Showcase your work', audience: 'talent', task: 'showcase_apply', task_ar: 'انشر نموذج شورت أو فيديو شغل يومي في ملفك', task_en: 'Publish a shorts sample or a daily work video on your profile',
    lessons: [
      L('photo_bio', 'صورة وبايو يبيعوا', 'A photo and bio that sell', 'الصورة الواضحة والبايو اللي بيقول بتقدّم إيه ولمين في سطرين هما أول ما العميل بيشوفه. اكتب نتيجتك للعميل مش أدواتك: «أعمل إعلانات تزوّد مبيعات محلك» أقوى من «أستخدم برامج كذا».', 'A clear photo and a two-line bio stating what you deliver and for whom are the first thing a client sees. Write your outcome, not your tools: "I make ads that grow your shop sales" beats "I use such-and-such software."'),
      L('samples', 'نماذج الشورتس', 'Shorts samples', 'حط أفضل ٣ نماذج شورتس في ملفك — أقوى شغل الأول. العميل بيقرر في ثواني من أول نموذج.', 'Put your best 3 shorts samples on your profile — strongest work first. Clients decide in seconds from the first sample.'),
      L('daily', 'فيديوهات الشغل اليومية', 'Daily work videos', 'انشر فيديو من شغلك كل يوم (تضمين يوتيوب/تيك توك) في قسم فيديوهاتك: النشاط اليومي بيرفع ظهورك في السوق وبيبني ثقة العميل قبل ما يطلب.', 'Post a work video daily (YouTube/TikTok embed) in your videos section: daily activity raises your market visibility and builds client trust before they order.'),
    ] },
  { key: 'pricing', ar: 'سعّر صح واعمل باقات', en: 'Price right & build packages', audience: 'talent', task: 'pricing_apply', task_ar: 'فعّل باقة أسعار واحدة على الأقل بسعر حقيقي في ملفك', task_en: 'Activate at least one priced package on your profile',
    lessons: [
      L('price_basics', 'أساسيات التسعير', 'Pricing basics', 'سعّرك = وقتك + خبرتك + قيمة النتيجة للعميل. ما تنافسش بالأرخص: نافس بالوضوح والضمان. راجع سعرك كل ١٠ صفقات ناجحة.', 'Your price = your time + expertise + the value of the outcome to the client. Do not compete on cheapest: compete on clarity and guarantee. Review your price every 10 successful deals.'),
      L('packages3', 'الباقات الثلاث', 'The three packages', '٣ باقات (أساسية/متوسطة/شاملة) بتخلي العميل يختار بدل ما يفاصل: الأساسية للتجربة، والمتوسطة هي اللي عايز تبيعها، والشاملة للي عايز كل حاجة.', 'Three packages (Basic/Standard/Premium) let the client choose instead of haggling: Basic for trial, Standard is the one you want to sell, Premium for everything included.'),
      L('raise', 'إمتى ترفع سعرك؟', 'When to raise your price', 'لما نسبة إتمامك عالية وطلباتك أكتر من سعتك، ارفع ١٠–٢٠٪ وجرب أسبوعين. العروض السريعة (يومان) أداة تنشيط مش تخفيض دائم.', 'When your completion rate is high and demand exceeds your capacity, raise 10–20% and test for two weeks. Flash offers (48h) are an activation tool, not a permanent discount.'),
    ] },
  { key: 'clients_care', ar: 'اكسب العميل', en: 'Win the client', audience: 'talent', task: 'care_apply', task_ar: 'احفظ قالب رد سريع واحد على الأقل من لوحتك', task_en: 'Save at least one quick-reply template from your dashboard',
    lessons: [
      L('fast_reply', 'الرد السريع بيكسب', 'Fast replies win', 'أغلب الصفقات بتروح لأول رد محترف. شارة سرعة الرد في ملفك بتتبني من ردودك الفعلية في محادثات الحجوزات — خليك في أول ساعة.', 'Most deals go to the first professional reply. Your reply-speed badge is built from your actual booking-chat replies — stay within the first hour.'),
      L('quotes_win', 'عروض أسعار بتقنع', 'Quotes that convince', 'في عرض السعر اكتب: السعر، مدة التسليم، وسطر واحد بيقول هتسلّم إيه بالظبط. الوضوح بيكسب أرخص عرض غامض.', 'In your quote write: the price, the delivery time, and one line saying exactly what you will deliver. Clarity beats a cheaper vague quote.'),
      L('reviews', 'التقييمات رأس مالك', 'Reviews are your capital', 'التقييم بيفتح بعد اكتمال الصفقة بس، فكل تسليم نضيف في معاده استثمار في ملفك. اطلب من العميل الراضي يقيّمك من صفحة الصفقة.', 'Ratings unlock only after deal completion, so every clean on-time delivery is an investment in your profile. Ask happy clients to rate you from the deal page.'),
    ] },
  { key: 'delivery', ar: 'سلّم واتحمى', en: 'Deliver & stay protected', audience: 'talent', task: 'delivery_apply', task_ar: 'أكمل صفقة واحدة على الأقل عبر Deal', task_en: 'Complete at least one deal through Deal',
    lessons: [
      L('deadlines', 'المواعيد والعدّادات', 'Deadlines & timers', 'كل خطوة دفع ليها مهلة ٣ ساعات بعدّاد حي. ومهلة تأكيد المعاينة ٢٤ ساعة من وصول الإثبات (سكوت العميل بعدها = استلام مُعتبَر) بتنبيهات متدرجة. مفيش عدّاد تسليم: توقيت التنفيذ بتتفق عليه مع العميل في محادثة الحجز، والاتفاق الموثّق بيحميك عند أي خلاف.', 'Every payment step has a 3-hour live-countdown deadline. The preview-confirmation window is 24 hours from the proof arriving (client silence after it = deemed receipt) with graduated reminders. There is no delivery countdown: execution timing is agreed with the client in the booking chat, and the documented agreement protects you in any dispute.'),
      L('proof', 'المعاينة قبل النسخة النهائية', 'Preview before the final file', 'ارفع إثبات التنفيذ كمعاينة أولاً؛ النسخة النهائية ما تتسلمش إلا بعد تأكيد قبض الباقي — ده ضمانك الحقيقي، والمنصة ما بتحتجز فلوس.', 'Upload the delivery proof as a preview first; the final version is delivered only after you confirm receiving the rest — that is your real guarantee, and the platform never holds money.'),
      L('disputes', 'تجنب النزاعات', 'Avoid disputes', 'كل اتفاقك جوه محادثة الحجز بس — هي دليل التحكيم الوحيد. أي اتفاق خارج المنصة المنصة غير ملزمة بيه ومش هيتحسب لصالحك.', 'Keep every agreement inside the booking chat only — it is the sole arbitration evidence. Any agreement outside the platform does not bind the platform and will not count in your favour.'),
    ] },
  ...TAXONOMY.services.map((s) => ({
    key: `svc_${s.key}`, ar: `احتراف خدمة: ${s.ar}`, en: `Mastering: ${s.en}`, audience: 'talent', task: 'delivery_apply', task_ar: 'أكمل صفقة واحدة على الأقل عبر Deal', task_en: 'Complete at least one deal through Deal',
    lessons: [
      L('intro', `تقديم «${s.ar}» باحتراف`, `Delivering "${s.en}" professionally`, `في خدمة «${s.ar}» العميل بيحكم من أول معاينة. اتفق على المخرجات بالظبط (عدد/صيغة/مدة) في محادثة الحجز قبل ما تبدأ، وسلّم معاينة أولاً دايماً.`, `In "${s.en}", the client judges from the first preview. Agree the exact deliverables (count/format/duration) in the booking chat before you start, and always deliver a preview first.`),
      L('quality', 'الجودة والتسليم', 'Quality & delivery', 'جودة ثابتة في المعاد أهم من سرعة مرة واحدة: اتفق على توقيت التنفيذ مع العميل داخل محادثة الحجز والتزم بيه، ولو هتتأخر بلّغه في المحادثة بدري — التوثيق بيحميك.', 'Consistent on-time quality beats one fast delivery: agree the execution timing with the client inside the booking chat and stick to it, and if you will be late, say so in the chat early — documentation protects you.'),
    ],
  })),
  { key: 'clients_general', ar: 'اطلب أي خدمة بنجاح', en: 'Order any service successfully', audience: 'client', task: 'client_apply', task_ar: 'انشر طلب خدمة واحد على الأقل', task_en: 'Post at least one service request',
    lessons: [
      L('write_request', 'اكتب طلب يجيب عروض', 'Write a request that gets quotes', 'طلب واضح = عروض أكتر وأرخص: اكتب المطلوب بالظبط وميزانيتك التقريبية وميعادك. جرّب قوالب الطلب الجاهزة — بتملأ الأسئلة المهمة عنك.', 'A clear request = more and better quotes: state exactly what you need, your approximate budget and your timing. Try the ready request templates — they fill in the key questions for you.'),
      L('compare', 'قارن واختر', 'Compare & choose', 'قارن عروض الأسعار جنب بعض: السعر ومدة التسليم ونسبة إتمام الصانع وتقييماته — مش الأرخص دايماً هو الأفضل.', 'Compare quotes side by side: price, delivery time, the provider\'s completion rate and ratings — cheapest is not always best.'),
      L('pay_safely', 'ادفع بأمان', 'Pay safely', 'العمولة أولاً لـDeal، وبعدين العربون والباقي للمنفذ مباشرة — المنصة ما بتحتجز فلوسك. حوّل بالمبلغ بالبصمة والمرجع الظاهرين في خطوة الدفع بس، وخليك جوه محادثة الحجز.', 'Commission first to Deal, then the deposit and the rest directly to the provider — the platform never holds your money. Transfer only the fingerprinted amount and reference shown in the payment step, and stay inside the booking chat.'),
      L('confirm_review', 'أكد وقيّم', 'Confirm & review', 'أكد استلام المعاينة لما توصلك (سكوت ٢٤ ساعة = استلام مُعتبَر)، وما تسلمش الباقي إلا وانت راضي — وبعد الإتمام قيّم المنفذ وسايب إكرامية لو حبيت.', 'Confirm receipt of the preview when it arrives (24 hours of silence = deemed receipt), pay the rest only when satisfied — and after completion, rate the provider and leave a tip if you like.'),
    ] },
];
const ACADEMY_TASK_CHECKS = {
  showcase_apply: async (u) => ((await db.prepare('SELECT COUNT(*) c FROM portfolio_items WHERE user_id=?').get(u.id)).c > 0) || ((await db.prepare('SELECT COUNT(*) c FROM daily_videos WHERE user_id=?').get(u.id)).c > 0),
  pricing_apply: async (u) => (await db.prepare('SELECT COUNT(*) c FROM creator_packages WHERE user_id=? AND price>0').get(u.id)).c > 0,
  care_apply: async (u) => (await db.prepare('SELECT COUNT(*) c FROM user_templates WHERE user_id=?').get(u.id)).c > 0,
  delivery_apply: async (u) => (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND status='completed'`).get(u.id)).c > 0,
  client_apply: async (u) => (await db.prepare('SELECT COUNT(*) c FROM shop_requests WHERE shop_user_id=?').get(u.id)).c > 0 || (await db.prepare('SELECT COUNT(*) c FROM bookings WHERE client_id=?').get(u.id)).c > 0,
};
async function academyState(userId) {
  const done = await db.prepare('SELECT track_key, lesson_key FROM academy_progress WHERE user_id=?').all(userId);
  const doneSet = new Set(done.map((r) => `${r.track_key}:${r.lesson_key}`));
  const badges = await db.prepare('SELECT track_key FROM academy_badges WHERE user_id=?').all(userId);
  const badgeSet = new Set(badges.map((r) => r.track_key));
  return { doneSet, badgeSet };
}
app.get('/api/academy', auth, async (req, res) => {
  const { doneSet, badgeSet } = await academyState(req.user.id);
  const tracks = [];
  for (const tr of ACADEMY_TRACKS) {
    const lessons = tr.lessons.map((l) => ({ key: l.key, ar: l.ar, en: l.en, body_ar: l.body_ar, body_en: l.body_en, video: l.video || '', done: doneSet.has(`${tr.key}:${l.key}`) }));
    const taskDone = tr.task ? await ACADEMY_TASK_CHECKS[tr.task](req.user) : false;
    tracks.push({
      key: tr.key, ar: tr.ar, en: tr.en, audience: tr.audience, lessons,
      lessons_done: lessons.filter((l) => l.done).length, lessons_total: lessons.length,
      task: tr.task ? { key: tr.task, ar: tr.task_ar, en: tr.task_en, done: !!taskDone } : null,
      badge: badgeSet.has(tr.key),
      complete: lessons.every((l) => l.done) && !!taskDone,
    });
  }
  res.json({ tracks });
});
app.post('/api/academy/:track/lessons/:lesson/complete', auth, async (req, res) => {
  const tr = ACADEMY_TRACKS.find((t) => t.key === req.params.track);
  if (!tr || !tr.lessons.some((l) => l.key === req.params.lesson)) return res.status(404).json({ error: 'غير موجود' });
  await db.prepare('INSERT INTO academy_progress (user_id,track_key,lesson_key,done_at) VALUES (?,?,?,?) ON CONFLICT(user_id,track_key,lesson_key) DO NOTHING')
    .run(req.user.id, tr.key, req.params.lesson, now());
  res.json({ ok: true });
});
app.post('/api/academy/:track/finish', auth, async (req, res) => {
  const tr = ACADEMY_TRACKS.find((t) => t.key === req.params.track);
  if (!tr) return res.status(404).json({ error: 'غير موجود' });
  const { doneSet, badgeSet } = await academyState(req.user.id);
  const lessonsDone = tr.lessons.every((l) => doneSet.has(`${tr.key}:${l.key}`));
  if (!lessonsDone) return res.status(400).json({ error: 'أكمل كل دروس المسار أولاً' });
  const taskDone = tr.task ? await ACADEMY_TASK_CHECKS[tr.task](req.user) : true;
  if (!taskDone) return res.status(400).json({ error: 'لسه مهمة «طبّق على ملفك» ما اتحققتش فعلياً — نفّذها من ملفك وارجع' });
  if (!badgeSet.has(tr.key)) {
    await db.prepare('INSERT INTO academy_badges (user_id,track_key,earned_at) VALUES (?,?,?) ON CONFLICT(user_id,track_key) DO NOTHING').run(req.user.id, tr.key, now());
    await notify(req.user.id, 'academy_badge', `🎓 شارة تأهيل أكاديمية Deal: أكملت مسار «${tr.ar}» وطبّقته على ملفك — الشارة ظاهرة في ملفك وبتدخل في درجة ظهورك`, `academy:${tr.key}`);
  }
  res.json({ ok: true, badge: true });
});
async function sweepAcademyReminders() {
  let sent = 0;
  const started = await db.prepare('SELECT DISTINCT user_id, track_key FROM academy_progress').all();
  for (const s of started) {
    const tr = ACADEMY_TRACKS.find((t) => t.key === s.track_key);
    if (!tr) continue;
    const badge = await db.prepare('SELECT 1 x FROM academy_badges WHERE user_id=? AND track_key=?').get(s.user_id, s.track_key);
    if (badge) continue;
    const doneCount = (await db.prepare('SELECT COUNT(*) c FROM academy_progress WHERE user_id=? AND track_key=?').get(s.user_id, s.track_key)).c;
    if (doneCount >= tr.lessons.length) continue;
    const last = await db.prepare('SELECT MAX(done_at) m FROM academy_progress WHERE user_id=? AND track_key=?').get(s.user_id, s.track_key);
    if (!last.m || now() - last.m < 3 * 24 * 3600 * 1000) continue;
    const recent = await db.prepare(`SELECT id FROM notifications WHERE user_id=? AND type='academy_reminder' AND ref=? AND created_at>?`).get(s.user_id, `academy:${s.track_key}`, now() - 7 * 24 * 3600 * 1000);
    if (recent) continue;
    await notify(s.user_id, 'academy_reminder', `🎓 كمّل مسار «${tr.ar}» في أكاديمية Deal — فاضلك ${tr.lessons.length - doneCount} دروس على شارة التأهيل`, `academy:${s.track_key}`);
    sent++;
  }
  return sent;
}

/* ---- ١٨) مدخل «Deal بلس»: طلبات مُدارة في طابور المالك ---- */
app.get('/api/owner/managed-requests', auth, ownerOnly, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM shop_requests WHERE managed=1 ORDER BY (status=\'open\') DESC, created_at DESC LIMIT 100').all();
  res.json({ items: rows.map((r) => ({ id: r.id, title: r.title, niche: r.niche, city: r.city, budget: r.budget, currency: r.currency, details: r.details, status: r.status, is_guest: !!r.is_guest, guest_name: r.guest_name || '', shop_user_id: r.shop_user_id, created_at: r.created_at })) });
});
app.post('/api/owner/managed-requests/:id/convert', auth, ownerOnly, async (req, res) => {
  const rq = await db.prepare('SELECT * FROM shop_requests WHERE id=? AND managed=1').get(+req.params.id);
  if (!rq || rq.status !== 'open') return res.status(404).json({ error: 'طلب مُدار غير متاح' });
  const talent = await getUser(+((req.body || {}).talent_id || 0));
  if (!talent || !['creator', 'provider'].includes(talent.role) || talent.is_platform_founder) return res.status(400).json({ error: 'منفذ غير صحيح' });
  if (onVacation(talent)) return res.status(400).json({ error: 'المنفذ في إجازة حالياً' });
  const price = +((req.body || {}).price || 0) || rq.budget || talent.price;
  if (!price || price <= 0) return res.status(400).json({ error: 'حدد سعراً صحيحاً' });
  let bookingId;
  if (rq.is_guest) {
    const agrM = agreementFromBody(req.body || {}); if (agrM.error) return res.status(400).json({ error: agrM.error });
    const ins = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,guest_name,guest_phone,guest_token,agreed_revisions,agreed_delivery_at,created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(talent.id, 'managed', rq.id, rq.title, price, rq.currency, now() + 7 * 24 * 3600 * 1000, rq.guest_name, rq.guest_phone, rq.guest_token, agrM.revisions, agrM.deliveryAt, now());
    bookingId = ins.lastInsertRowid;
  } else {
    const agrM2 = agreementFromBody(req.body || {}); if (agrM2.error) return res.status(400).json({ error: agrM2.error });
    const ins = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,agreed_revisions,agreed_delivery_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rq.shop_user_id, talent.id, 'managed', rq.id, rq.title, price, rq.currency, now() + 7 * 24 * 3600 * 1000, agrM2.revisions, agrM2.deliveryAt, now());
    bookingId = ins.lastInsertRowid;
  }
  await db.prepare(`UPDATE shop_requests SET status='booked' WHERE id=?`).run(rq.id);
  await addBookingEvent(bookingId, 'created', 'أُنشئ الحجز من طلب «Deal بلس» المُدار — الضمان والمراحل موثّقة داخل Deal');
  await notify(talent.id, 'booking_new', `طلب حجز جديد #${bookingId} عبر «Deal بلس» (إدارة كاملة من المنصة) بقيمة ${price} ${rq.currency}`, `booking:${bookingId}`);
  if (rq.shop_user_id) await notify(rq.shop_user_id, 'managed_update', `✅ فريق Deal بدأ إدارة طلبك «${String(rq.title).slice(0, 50)}» واتفتح حجز #${bookingId} — تابع من حجوزاتك`, `booking:${bookingId}`);
  res.json({ ok: true, booking_id: bookingId });
});

/* ---- ٣) لوحة أرقام للصانع: أرقام حقيقية بفترات ---- */
app.get('/api/me/insights', auth, async (req, res) => {
  const uid = req.user.id;
  const days = req.query.period === '30' ? 30 : 7;
  const since = now() - days * 24 * 3600 * 1000;
  const views = (await db.prepare('SELECT COUNT(*) c FROM profile_views WHERE talent_id=? AND created_at>=?').get(uid, since)).c;
  const incomingBookings = (await db.prepare('SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND created_at>=?').get(uid, since)).c;
  const matched = (await db.prepare('SELECT COUNT(*) c FROM request_matches WHERE user_id=? AND created_at>=?').get(uid, since)).c;
  const st = await talentStats(uid);
  const topRow = await db.prepare(`SELECT r.niche AS niche, COUNT(*) c FROM bookings b JOIN shop_requests r ON r.id=b.ref_id
    WHERE b.talent_id=? AND b.source IN ('guest_request','quote') AND b.created_at>=? AND r.niche!='' GROUP BY r.niche ORDER BY c DESC LIMIT 1`).get(uid, since);
  res.json({
    period_days: days,
    profile_views: views,
    incoming_requests: incomingBookings + matched,
    bookings_created: incomingBookings,
    matched_requests: matched,
    completion_rate: st.completion_rate,
    completed_deals: st.completed_deals,
    top_service: topRow ? topRow.niche : null,
  });
});

/* ---------------- owner dashboard (platform founder only) ---------------- */
function ownerOnly(req, res, next) {
  if (!req.user.is_platform_founder) return res.status(403).json({ error: 'لوحة المالك للمؤسس فقط' });
  next();
}
/* منع المؤسس من التعامل كعميل (قرار المالك 2026-11-23: «لا انا مش عاوز
   اعمل شغل انا مؤسس»): المؤسس يدير المنصة ولا يفتح صفقات من أي جهة —
   هذا المنع يكمل خادمياً منعَ جهة المقدم القائم أصلاً في نفس المسارات
   (لا سعر ولا حجوزات واردة للمؤسس)، فيُغلق باب العميل أيضاً: إنشاء حجز
   مباشر، قبول عرض سعر يفتح حجزاً، إعادة طلب، واقتراح تعاقد شهري. */
const FOUNDER_NO_CLIENT_ERROR = 'حساب المؤسس لا يتعامل كعميل — المؤسس يدير المنصة ولا يفتح صفقات · The founder account does not transact as a client — the founder runs the platform and opens no deals';
function founderClientBlocked(req, res) {
  if (req.user && req.user.is_platform_founder) {
    res.status(403).json({ error: FOUNDER_NO_CLIENT_ERROR, code: 'FOUNDER_NO_CLIENT' });
    return true;
  }
  return false;
}
/* قائمة إشراف البلاغات (جولة الاسترجاع): كل بلاغ بمُبلِّغه وهدفه وسببه،
   وإجراءات المالك: تجاهل / حذف المحتوى (منشورات فقط) / تجميد حساب
   صاحب الهدف. القرار يُختم على السجل ولا يُحذف البلاغ أبداً. */
app.get('/api/owner/reports', auth, ownerOnly, async (req, res) => {
  const status = String(req.query.status || 'open');
  const rows = await db.prepare('SELECT * FROM reports WHERE status=? ORDER BY id DESC LIMIT 200').all(status);
  const items = [];
  for (const r of rows) {
    const reporter = await getUser(r.reporter_id);
    const targetUser = await getUser(r.target_user_id);
    let post = null;
    if (r.target_type === 'post') {
      const p = await db.prepare('SELECT id, body, link FROM profile_posts WHERE id=?').get(r.target_id);
      post = p ? { id: p.id, body: String(p.body || '').slice(0, 300), link: p.link || '' } : null;
    }
    items.push({
      ...r,
      reporter: reporter ? { id: reporter.id, name: reporter.name } : null,
      target_user: targetUser ? { id: targetUser.id, name: targetUser.name, frozen: !!targetUser.frozen } : null,
      post,
    });
  }
  const openCount = (await db.prepare(`SELECT COUNT(*) c FROM reports WHERE status='open'`).get()).c;
  res.json({ items, open_count: openCount });
});
app.post('/api/owner/reports/:id/resolve', auth, ownerOnly, async (req, res) => {
  const r = await db.prepare('SELECT * FROM reports WHERE id=?').get(+req.params.id || 0);
  if (!r || r.status !== 'open') return res.status(404).json({ error: 'غير موجود' });
  const action = String((req.body || {}).action || '');
  if (!['ignore', 'delete_content', 'freeze_account'].includes(action)) {
    return res.status(400).json({ error: 'إجراء غير صحيح' });
  }
  if (action === 'delete_content') {
    if (r.target_type === 'post') {
      await db.prepare('DELETE FROM post_reactions WHERE post_id=?').run(r.target_id);
      await db.prepare('DELETE FROM profile_posts WHERE id=?').run(r.target_id);
    } else if (r.target_type === 'daily_video') {
      await db.prepare('DELETE FROM daily_videos WHERE id=?').run(r.target_id);
    } else if (r.target_type === 'question') {
      await db.prepare('DELETE FROM profile_questions WHERE id=?').run(r.target_id);
    } else {
      return res.status(400).json({ error: 'حذف المحتوى للمحتوى فقط — للملفات استخدم تجميد الحساب' });
    }
    await notify(r.target_user_id, 'moderation', 'حُذف محتوى لك بعد مراجعة بلاغ من إدارة Deal', `report:${r.id}`);
  }
  if (action === 'freeze_account') {
    await db.prepare('UPDATE users SET frozen=1 WHERE id=?').run(r.target_user_id);
    await notify(r.target_user_id, 'moderation', 'تم تجميد حسابك بعد مراجعة بلاغ من إدارة Deal — تواصل مع الدعم لو فيه خطأ', `report:${r.id}`);
  }
  await db.prepare(`UPDATE reports SET status=?, action=?, resolved_at=?, resolved_by=? WHERE id=?`)
    .run(action === 'ignore' ? 'ignored' : 'actioned', action, now(), req.user.id, r.id);
  await logOwnerAction(req, 'moderation', `report:${r.id}`, `action:${action} target_user:${r.target_user_id || ''}`);
  res.json({ ok: true });
});
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
  /* قرار تحكيم مسبّب (الجولة الأخيرة — ١٣ب): لا قرار بلا سبب مكتوب ومرجع
     دليل واحد على الأقل من سجل هذا الحجز نفسه (حدث خط زمني «event:<id>»
     أو التزام مالي «obligation:<id>») — السبب والمراجع تُحفظ على النزاع
     وتظهر للطرفين في عرض الحجز، فلا حسم صامتاً في Deal. */
  const reason = String((req.body || {}).reason || note || '').trim();
  if (!reason) return res.status(400).json({ error: 'قرار التحكيم لازم يكون مسبّباً — اكتب سبب القرار أولاً', code: 'REASON_REQUIRED' });
  const rawRefs = Array.isArray((req.body || {}).evidence_refs) ? (req.body || {}).evidence_refs : [];
  const evidenceRefs = rawRefs.map((x) => String(x || '').trim()).filter(Boolean);
  if (!evidenceRefs.length) return res.status(400).json({ error: 'قرار التحكيم لازم يستند لدليل واحد على الأقل من سجل الحجز', code: 'EVIDENCE_REQUIRED' });
  for (const ref of evidenceRefs) {
    const m = /^(event|obligation):(\d+)$/.exec(ref);
    if (!m) return res.status(400).json({ error: `مرجع دليل غير مفهوم: ${ref}`, code: 'EVIDENCE_INVALID' });
    const row = m[1] === 'event'
      ? await db.prepare('SELECT id FROM booking_events WHERE id=? AND booking_id=?').get(+m[2], d.booking_id)
      : await db.prepare('SELECT id FROM money_obligations WHERE id=? AND booking_id=?').get(+m[2], d.booking_id);
    if (!row) return res.status(400).json({ error: `مرجع الدليل ${ref} لا يخص هذا الحجز`, code: 'EVIDENCE_INVALID' });
  }
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
  /* تثبيت إخلال بقرار تحكيم (جولة الردع): المالك يسمّي الطرف المُخِلّ صراحة
     (breach_user_id) فيدخل آلياً: تجميد + غرامة إخلال موثّقة، وإن كان المُخِلّ
     هو المنفذ وكان العربون مدفوعاً فعلاً يُنشأ التزام ردّ العربون الإجباري
     (٣ ساعات) — قلب «ضمان الاستبدال» المعتمَد. */
  const breachUser = +(req.body || {}).breach_user_id || 0;
  if (breachUser && (breachUser === b.client_id || breachUser === b.talent_id)) {
    const fresh = await getBooking(b.id);
    await establishBreach(breachUser, fresh, `إخلال مثبت بقرار تحكيم المالك في نزاع #${d.id}${note ? `: ${String(note).slice(0, 80)}` : ''}`);
    if (breachUser === b.talent_id) {
      const dep = await db.prepare(`SELECT id FROM payments WHERE booking_id=? AND kind='deposit' AND status IN ('claimed','confirmed') LIMIT 1`).get(b.id);
      if (dep) await createDepositRefundObligation(fresh, `قرار تحكيم في نزاع #${d.id}: المنفذ مُخِلّ والعربون مدفوع`);
    }
    await addBookingEvent(b.id, 'breach_established', `⚖️ ثبّت التحكيم إخلال الطرف #${breachUser} — تجميد آلي وغرامة إخلال موثّقة بقواعد الردع`);
  }
  /* تماثل العميل (جولة الردع): قرار المالك أن ادعاء العميل بعدم الاستلام كان
     كاذباً (false_claim_client) = الصفقة تُحسب مكتملة بالأدلة متى كانت النسخة
     النهائية مُسلَّمة فعلاً، والباقي غير المدفوع يبقى التزاماً/مديونية مسجّلة
     على العميل + تجميد وغرامة — نفس شبكة المنفذ تماماً. */
  if ((req.body || {}).false_claim_client && b.client_id) {
    let fb = await getBooking(b.id);
    if (fb.final_delivered_at && !fb.final_confirmed_at) {
      await db.prepare('UPDATE bookings SET final_confirmed_at=? WHERE id=?').run(now(), b.id);
      await addBookingEvent(b.id, 'false_claim_decided', '⚖️ قرار تحكيم: ادعاء العميل بعدم استلام النسخة النهائية ثبت كذبه بالأدلة — يُحسب الاستلام مؤكداً بقرار المالك');
      fb = await tryCompleteFinal(await getBooking(b.id)) || await getBooking(b.id);
    }
    if (fb.status !== 'completed') {
      await addBookingEvent(b.id, 'false_claim_decided', '⚖️ قرار تحكيم: ادعاء العميل ثبت كذبه بالأدلة — الباقي المستحق يبقى مديونية مسجّلة عليه بقواعد الردع');
    }
    await establishBreach(b.client_id, await getBooking(b.id), `ادعاء عدم استلام كاذب ثبّته تحكيم المالك في نزاع #${d.id}`);
  }
  await db.prepare(`UPDATE disputes SET status='resolved', resolution=?, decision_reason=?, evidence_refs=?, decided_by=?, resolved_at=? WHERE id=?`).run(reason, reason, JSON.stringify(evidenceRefs), req.user.id, now(), d.id);
  await addBookingEvent(b.id, 'arbitration_decision', `⚖️ قرار تحكيم مسبّب (${action === 'cancel' ? 'إلغاء الحجز' : 'استئناف الحجز'}): ${reason} — مراجع الأدلة: ${evidenceRefs.join('، ')}`);
  await logOwnerAction(req, 'arbitration_decision', `dispute:${d.id}`, `booking:${b.id} action:${action} refs:${evidenceRefs.join(',')}`);
  await notify(b.client_id, 'dispute', `اتحل نزاع حجز #${b.id}`, `booking:${b.id}`);
  await notify(b.talent_id, 'dispute', `اتحل نزاع حجز #${b.id}`, `booking:${b.id}`);
  res.json({ ok: true });
});
/* إلغاء حماية الحجز (تغطية رجعية ممنوعة — قاعدة الاتفاق الخارجي المعتمدة
   2026-11-23): لو أظهرت محادثة الحجز/الأدلة أن الصفقة اتُّفق عليها أو نُفّذت
   خارجياً قبل فتح الحجز، يلغي المالك حماية هذا الحجز نهائياً: يُلغى الحجز
   ويُوسم «حماية ملغاة» في كل عرضه وحزمة أدلته، وتُسجَّل علامة سلوك على من
   يسمّيه المالك من الطرفين (المبادر/الطرفان)، وكل ذلك موثّق في سجل الأدلة.
   الالتزامات المالية بين الطرفين لا تُمسّ (فلوسهم بين محافظهم — لا احتجاز). */
app.post('/api/owner/bookings/:id/void-protection', auth, ownerOnly, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b) return res.status(404).json({ error: 'حجز غير موجود' });
  if (b.protection_voided) return res.status(400).json({ error: 'حماية هذا الحجز ملغاة من قبل' });
  if (['completed', 'cancelled'].includes(b.status)) return res.status(400).json({ error: 'الحجز منتهٍ — لا حماية قائمة لإلغائها' });
  const note = String((req.body || {}).note || 'الأدلة أظهرت أن الصفقة اتُّفق عليها/نُفّذت خارج المنصة قبل فتح الحجز').slice(0, 300);
  const flagIds = Array.isArray((req.body || {}).flag_user_ids) ? (req.body.flag_user_ids || []).map((x) => +x).filter((x) => x === b.client_id || x === b.talent_id) : [];
  await db.prepare('UPDATE bookings SET protection_voided=1, protection_voided_at=?, protection_voided_by=?, prev_status=status, status=? WHERE id=?')
    .run(now(), req.user.id, 'cancelled', b.id);
  await logOwnerAction(req, 'void_protection', `booking:${b.id}`, `flagged:${flagIds.join(',') || 'none'}`);
  await closeOpenAppeal(b.id, 'closed_dispute');
  await addBookingEvent(b.id, 'protection_voided', `🚫 أُلغيت حماية هذا الحجز بقرار المالك: ${note} — قاعدة Deal: خدمات المنصة (الضمان والتحكيم وحزمة الأدلة والتقييمات) للصفقات المفتوحة والموثّقة داخل المنصة فقط، ولا تغطية رجعية لأي اتفاق خارجي`);
  for (const uid of flagIds) {
    await db.prepare('INSERT INTO behavior_flags (booking_id,user_id,kind,created_by,created_at) VALUES (?,?,?,?,?)')
      .run(b.id, uid, 'retro_coverage', req.user.id, now());
    await applyBehaviorPenalty(uid);
  }
  await notify(b.talent_id, 'penalty', `حجز #${b.id}: 🚫 أُلغيت حماية هذا الحجز بقرار المالك — الأدلة أظهرت اتفاقاً/تنفيذاً خارج المنصة قبل فتح الحجز، وخدمات Deal لا تغطي الاتفاقات الخارجية رجعياً`, `booking:${b.id}`);
  if (b.client_id) await notify(b.client_id, 'penalty', `حجز #${b.id}: 🚫 أُلغيت حماية هذا الحجز بقرار المالك — الأدلة أظهرت اتفاقاً/تنفيذاً خارج المنصة قبل فتح الحجز، وخدمات Deal لا تغطي الاتفاقات الخارجية رجعياً`, `booking:${b.id}`);
  await notifyOwner('penalty', `🚫 أُلغيت حماية حجز #${b.id} (تغطية رجعية) — عُلّم على: ${flagIds.length ? flagIds.join(', ') : 'لا أحد'}`, `booking:${b.id}`);
  res.json({ ok: true, booking: await bookingView(await getBooking(b.id), req.user) });
});
app.post('/api/owner/verify-exceptional/:userId', auth, ownerOnly, async (req, res) => {
  const { approve } = req.body || {};
  const u = await getUser(+req.params.userId);
  if (!u || u.verify_status !== 'exceptional') return res.status(404).json({ error: 'طلب غير موجود' });
  if (approve) {
    const pioneer = await db.prepare(`SELECT id FROM users WHERE verified=1 AND pioneer=1 AND city=? AND niche=?`).get(u.city, u.niche) ? 0 : 1;
    await db.prepare(`UPDATE users SET verified=1, verify_status='verified', pioneer=?, boost_until=?, verified_at=? WHERE id=?`).run(pioneer, now() + 7 * 24 * 3600 * 1000, now(), u.id);
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
  /* حظر المالك اليدوي = حظر للشخص لا للحساب فقط (جولة الردع): تُنسخ هويته
     وبصمات أجهزته لقائمة الحظر الدائمة فلا يعود بحساب جديد. */
  if (banned) await banPerson(u.id, String((req.body || {}).reason || 'حظر بقرار المالك من لوحته').slice(0, 200), req.user.id);
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

/* ================= الجولة الأخيرة الشاملة (TESTING-FINAL.md) =================
   بنود ١–١٣: صيانة، سجل أخطاء، تدقيق مالك، نسخ احتياطي، قائمة إكمال
   الملف، قمع النمو، تنزيل البيانات، الحظر، إعلان المالك، تصدير مالي. */

/* ---- بند ٩: الحظر بين الأعضاء ---- */
const BLOCKED_ERROR = 'لا يمكن بدء تواصل أو تعامل جديد — يوجد حظر بينك وبين هذا العضو · Blocked — neither side can start new contact';
async function blockBetween(a, b) {
  if (!a || !b || a === b) return false;
  const r = await db.prepare('SELECT id FROM user_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1').get(a, b, b, a);
  return !!r;
}
app.post('/api/users/:id/block', auth, async (req, res) => {
  const other = await getUser(+req.params.id);
  if (!other) return res.status(404).json({ error: 'غير موجود' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حظر نفسك' });
  await db.prepare('INSERT INTO user_blocks (blocker_id,blocked_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(req.user.id, other.id, now());
  res.json({ ok: true, blocked: true });
});
app.delete('/api/users/:id/block', auth, async (req, res) => {
  await db.prepare('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?').run(req.user.id, +req.params.id);
  res.json({ ok: true, blocked: false });
});
app.get('/api/me/blocks', auth, async (req, res) => {
  const rows = await db.prepare('SELECT blocked_id, created_at FROM user_blocks WHERE blocker_id=? ORDER BY id DESC').all(req.user.id);
  const items = [];
  for (const r of rows) { const u = await getUser(r.blocked_id); if (u) items.push({ id: u.id, name: u.name, blocked_at: r.created_at }); }
  res.json({ items });
});

/* ---- بند ١: مفتاح وضع الصيانة بيد المالك ---- */
app.get('/api/owner/maintenance', auth, ownerOnly, async (req, res) => {
  res.json({ on: await maintenanceEnabled() });
});
app.post('/api/owner/maintenance', auth, ownerOnly, async (req, res) => {
  const on = !!(req.body || {}).on;
  await setSetting('maintenance_mode', on ? '1' : '0');
  await logOwnerAction(req, on ? 'maintenance_on' : 'maintenance_off', 'platform', '');
  res.json({ ok: true, on });
});

/* ---- بند ٢: سجل الأخطاء الداخلي (قراءة المالك فقط) ---- */
app.get('/api/owner/error-log', auth, ownerOnly, async (req, res) => {
  const items = await db.prepare('SELECT id,route,message,user_id,created_at FROM error_log ORDER BY id DESC LIMIT 100').all();
  res.json({ items });
});

/* ---- بند ٣: سجل تدقيق إجراءات المالك (قراءة فقط) ---- */
app.get('/api/owner/audit-log', auth, ownerOnly, async (req, res) => {
  const items = await db.prepare('SELECT id,actor_id,action,target,detail,created_at FROM owner_audit_log ORDER BY id DESC LIMIT 100').all();
  res.json({ items });
});

/* ---- بند ٤: النسخ الاحتياطي الأسبوعي ----
   تصدير JSON كامل لكل الجداول (عدا جدول النسخ نفسه حتى لا تتناسخ النسخ
   داخل بعضها) يُحفظ في جدول backups وتُبقى أحدث ٤ نسخ فقط. الاستعادة
   خارج النطاق في هذه الجولة (موثّق في TESTING-FINAL.md). نداء مجدوَل
   أسبوعي خارجي يضرب POST /api/owner/backup-now بنفس جلسة المالك — مثل
   الملخص الأسبوعي تماماً. */
async function createBackup() {
  const trows = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'backups' ORDER BY table_name`)).rows;
  const tables = {};
  for (const t of trows) {
    const name = t.table_name;
    tables[name] = (await pool.query(`SELECT * FROM "${name}"`)).rows;
  }
  const payload = JSON.stringify({ app: 'deal', created_at: now(), tables });
  const size = Buffer.byteLength(payload, 'utf8');
  const info = await db.prepare('INSERT INTO backups (created_at,size_bytes,tables_count,data) VALUES (?,?,?,?)').run(now(), size, trows.length, payload);
  await db.prepare('DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT 4)').run();
  return { id: info.lastInsertRowid, created_at: now(), size_bytes: size, tables_count: trows.length };
}
app.post('/api/owner/backup-now', auth, ownerOnly, async (req, res) => {
  const b = await createBackup();
  await logOwnerAction(req, 'backup_create', `backup:${b.id}`, `${b.tables_count} tables, ${b.size_bytes} bytes`);
  res.json({ ok: true, backup: b });
});
app.get('/api/owner/backups', auth, ownerOnly, async (req, res) => {
  const items = await db.prepare('SELECT id,created_at,size_bytes,tables_count FROM backups ORDER BY id DESC').all();
  res.json({ items, last_backup_at: items.length ? items[0].created_at : 0 });
});
app.get('/api/owner/backups/latest/download', auth, ownerOnly, async (req, res) => {
  const b = await db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get();
  if (!b) return res.status(404).json({ error: 'لا توجد نسخة احتياطية بعد' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="deal-backup-${b.id}.json"`);
  res.send(b.data);
});

/* ---- بند ٥: «أكمِل ملفك» + إشارة نسخ الرابط الشخصي ----
   الإشارة المختارة لنسخ الرابط (موثّقة في TESTING-FINAL.md): ختم خادمي
   users.link_copied_at يُكتب عند أول نداء POST /api/me/link-copied من
   أزرار نسخ الرابط الشخصي في الواجهة — إشارة حقيقية من فعل المستخدم
   نفسه، لا تخمين. القائمة تُبنى من حالة حقيقية فقط، والمؤسس مستثنى. */
app.post('/api/me/link-copied', auth, async (req, res) => {
  if (!req.user.link_copied_at) await db.prepare('UPDATE users SET link_copied_at=? WHERE id=?').run(now(), req.user.id);
  res.json({ ok: true, link_copied_at: req.user.link_copied_at || now() });
});
app.get('/api/me/profile-checklist', auth, async (req, res) => {
  const u = req.user;
  if (u.is_platform_founder || !['creator', 'provider'].includes(u.role)) return res.json({ applicable: false, items: [], progress_pct: 100 });
  const samples = (await db.prepare('SELECT COUNT(*) c FROM portfolio_items WHERE user_id=?').get(u.id)).c;
  const packages = (await db.prepare('SELECT COUNT(*) c FROM creator_packages WHERE user_id=?').get(u.id)).c;
  const items = [
    { key: 'photo', done: !!String(u.avatar || '').trim() },
    { key: 'bio', done: !!String(u.bio || '').trim() },
    { key: 'samples', done: samples > 0 },
    { key: 'packages', done: packages > 0 },
    { key: 'fin_identity', done: !!u.fin_declared_at },
    { key: 'link_copied', done: !!u.link_copied_at },
  ];
  const doneCount = items.filter((i) => i.done).length;
  res.json({ applicable: true, items, done: doneCount, total: items.length, progress_pct: Math.round((doneCount / items.length) * 100) });
});

/* ---- بند ٦: عدّاد مشاهدات أولي + قمع نمو المالك ----
   page_views: بصمة زائر مجهولة (نفس مفتاح الزائر المحلي) + يوم — بلا أي
   تحليلات خارجية وبلا بيانات شخصية. القمع من سجلات حقيقية فقط. */
app.post('/api/page-view', async (req, res) => {
  const vid = String((req.body || {}).vid || '').slice(0, 80);
  if (!vid) return res.status(400).json({ error: 'vid required' });
  const vidHash = crypto.createHash('sha256').update(`deal-pv:${vid}`).digest('hex');
  const day = new Date().toISOString().slice(0, 10);
  await db.prepare('INSERT INTO page_views (vid_hash,day,created_at) VALUES (?,?,?)').run(vidHash, day, now());
  res.json({ ok: true });
});
app.get('/api/owner/growth-funnel', auth, ownerOnly, async (req, res) => {
  const cnt = async (sql, ...args) => +(await db.prepare(sql).get(...args)).c || 0;
  const views = await cnt('SELECT COUNT(*) c FROM page_views');
  const visitors = await cnt('SELECT COUNT(DISTINCT vid_hash) c FROM page_views');
  const registrations = await cnt('SELECT COUNT(*) c FROM users WHERE is_platform_founder=0');
  const emailVerified = await cnt('SELECT COUNT(*) c FROM users WHERE is_platform_founder=0 AND email_verified=1');
  const firstBookingCreators = await cnt('SELECT COUNT(DISTINCT talent_id) c FROM bookings');
  const completedBookings = await cnt(`SELECT COUNT(*) c FROM bookings WHERE status='completed'`);
  res.json({ page_views: views, unique_visitors: visitors, registrations, email_verified: emailVerified, creators_with_first_booking: firstBookingCreators, completed_bookings: completedBookings });
});

/* ---- بند ٧: «نزّل بياناتي» ----
   القاعدة المختارة (موثّقة في TESTING-FINAL.md): قاعدة العضو نفسها تسرى
   على الجميع بمن فيهم المؤسس — كل حساب ينزّل بياناته هو فقط. الرسائل
   ببياناتها الوصفية فقط (من/إلى/متى — بلا نصوص)، والحجوزات بلا رمز
   الضيف، والملف بلا كلمة السر إطلاقاً. */
app.get('/api/me/export-data', auth, async (req, res) => {
  const u = req.user;
  const profile = { ...u };
  delete profile.password_hash; delete profile.guest_token;
  const stripBooking = (b) => { const x = { ...b }; delete x.guest_token; return x; };
  const bookingsAsClient = (await db.prepare('SELECT * FROM bookings WHERE client_id=? ORDER BY id DESC').all(u.id)).map(stripBooking);
  const bookingsAsTalent = (await db.prepare('SELECT * FROM bookings WHERE talent_id=? ORDER BY id DESC').all(u.id)).map(stripBooking);
  const messages = await db.prepare('SELECT id,sender_id,recipient_id,created_at FROM messages WHERE sender_id=? OR recipient_id=? ORDER BY id DESC LIMIT 1000').all(u.id, u.id);
  const obligations = await db.prepare('SELECT * FROM money_obligations WHERE user_id=? OR payer_user_id=? OR payee_user_id=? ORDER BY id DESC').all(u.id, u.id, u.id);
  const obIds = obligations.map((o) => o.id);
  const ledger = obIds.length ? await db.prepare(`SELECT * FROM money_ledger WHERE obligation_id IN (${obIds.map(() => '?').join(',')}) ORDER BY id DESC`).all(...obIds) : [];
  const notifications = await db.prepare('SELECT id,type,text,ref,is_read,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 1000').all(u.id);
  const payload = { app: 'deal', exported_at: now(), profile, bookings_as_client: bookingsAsClient, bookings_as_talent: bookingsAsTalent, messages_metadata: messages, money_obligations: obligations, money_ledger: ledger, notifications };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="deal-my-data.json"');
  res.send(JSON.stringify(payload, null, 2));
});

/* ---- بند ١٠: إعلان المالك (بثّ لكل الأعضاء) ----
   إشعار داخلي لكل عضو مسجل (notify يرآه Web Push تلقائياً عبر البنية
   القائمة) + سجل إرسال + تدقيق مالك. الضيوف بلا حسابات فلا يصلهم شيء. */
app.post('/api/owner/broadcast', auth, ownerOnly, async (req, res) => {
  const title = String((req.body || {}).title || '').trim().slice(0, 120);
  const body = String((req.body || {}).body || '').trim().slice(0, 1000);
  const bodyEn = String((req.body || {}).body_en || '').trim().slice(0, 1000);
  if (!title || !body) return res.status(400).json({ error: 'عنوان الإعلان ونصه مطلوبان' });
  const info = await db.prepare('INSERT INTO broadcasts (title,body,body_en,recipients,created_by,created_at) VALUES (?,?,?,?,?,?)').run(title, body, bodyEn, 0, req.user.id, now());
  const members = await db.prepare('SELECT id FROM users WHERE is_platform_founder=0 AND banned=0 AND COALESCE(deleted_at,0)=0').all();
  for (const m of members) { await notify(m.id, 'broadcast', `📣 ${title} — ${body}`, `broadcast:${info.lastInsertRowid}`); }
  await db.prepare('UPDATE broadcasts SET recipients=? WHERE id=?').run(members.length, info.lastInsertRowid);
  await logOwnerAction(req, 'broadcast', `broadcast:${info.lastInsertRowid}`, `recipients:${members.length}`);
  res.json({ ok: true, id: info.lastInsertRowid, recipients: members.length });
});
app.get('/api/owner/broadcasts', auth, ownerOnly, async (req, res) => {
  const items = await db.prepare('SELECT id,title,body,body_en,recipients,created_at FROM broadcasts ORDER BY id DESC LIMIT 50').all();
  res.json({ items });
});

/* ---- بند ١١: التصدير المالي للمالك (SpreadsheetML) ----
   الصيغة المختارة (موثّقة في TESTING-FINAL.md): SpreadsheetML 2003 XML
   بامتداد .xls — ملف جداول حقيقي يفتحه Excel وLibreOffice بلا أي مكتبة
   جديدة، بورقتي «السجل» و«الالتزامات» وسطر إجماليات في كل ورقة. */
function xmlEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function ssCell(v, num) { return `<Cell><Data ss:Type="${num ? 'Number' : 'String'}">${xmlEsc(v)}</Data></Cell>`; }
function ssRow(cells) { return `<Row>${cells.join('')}</Row>`; }
app.get('/api/owner/financial-export', auth, ownerOnly, async (req, res) => {
  const from = +req.query.from || 0;
  const to = +req.query.to || now();
  const ledger = await db.prepare(`SELECT l.id, l.created_at, l.from_status, l.to_status, l.actor, l.note, o.code, o.kind, o.exact_amount, o.currency FROM money_ledger l JOIN money_obligations o ON o.id=l.obligation_id WHERE l.created_at>=? AND l.created_at<=? ORDER BY l.id ASC`).all(from, to);
  const obligations = await db.prepare(`SELECT id, code, kind, booking_id, base_amount, exact_amount, currency, status, created_at FROM money_obligations WHERE created_at>=? AND created_at<=? ORDER BY id ASC`).all(from, to);
  const obTotal = obligations.reduce((s, o) => s + (+o.exact_amount || 0), 0);
  const ledgerRows = ledger.map((l) => ssRow([ssCell(l.id, 1), ssCell(new Date(l.created_at).toISOString()), ssCell(l.code), ssCell(l.kind), ssCell(l.from_status), ssCell(l.to_status), ssCell(l.actor), ssCell(l.exact_amount, 1), ssCell(l.currency), ssCell(l.note)]));
  ledgerRows.push(ssRow([ssCell('الإجمالي'), ssCell(''), ssCell(''), ssCell(''), ssCell(''), ssCell(''), ssCell(''), ssCell(Math.round(ledger.reduce((s, l) => s + (+l.exact_amount || 0), 0) * 100) / 100, 1), ssCell(''), ssCell(`صفوف السجل: ${ledger.length}`)]));
  const obRows = obligations.map((o) => ssRow([ssCell(o.id, 1), ssCell(o.code), ssCell(o.kind), ssCell(o.booking_id || '', 1), ssCell(o.base_amount, 1), ssCell(o.exact_amount, 1), ssCell(o.currency), ssCell(o.status), ssCell(new Date(o.created_at).toISOString())]));
  obRows.push(ssRow([ssCell('الإجمالي'), ssCell(''), ssCell(''), ssCell(''), ssCell(''), ssCell(Math.round(obTotal * 100) / 100, 1), ssCell(''), ssCell(`الالتزامات: ${obligations.length}`), ssCell('')]));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n<Worksheet ss:Name="Ledger"><Table>${ssRow(['ID', 'Date', 'Code', 'Kind', 'From', 'To', 'Actor', 'Amount', 'Currency', 'Note'].map((h) => ssCell(h)))}${ledgerRows.join('')}</Table></Worksheet>\n<Worksheet ss:Name="Obligations"><Table>${ssRow(['ID', 'Code', 'Kind', 'Booking', 'Base', 'Exact amount', 'Currency', 'Status', 'Date'].map((h) => ssCell(h)))}${obRows.join('')}</Table></Worksheet>\n</Workbook>`;
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="deal-financial-export.xls"');
  res.send(xml);
});

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'Deal — Vercel + Supabase' }));

/* معالج أخطاء أخير: أي خطأ من قاعدة البيانات أو المنطق يرجع 500 بدل تعليق الطلب.
   الجولة الأخيرة (بند ٢): كل خطأ يصل هنا يُسجَّل داخلياً في error_log
   (مسار + رسالة + مستخدم إن وُجد — بلا حمولات حساسة) قبل الرد النظيف،
   فلا يرى المستخدم أي أثر تقني أبداً. */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Deal server error:', err);
  logServerError(req, err);
  if (!res.headersSent) res.status(500).json({ error: 'خطأ في الخادم' });
});

module.exports = app;

/* التشغيل المحلي العادي فقط (npm start) — على Vercel يُستورَد التطبيق من api/index.js دون listen. */
if (require.main === module) {
  init()
    .then(() => app.listen(PORT, () => console.log(`Deal running on http://localhost:${PORT}`)))
    .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
}
