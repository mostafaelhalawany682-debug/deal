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
const FEE_REVIEW_WINDOW_MS = 48 * 3600 * 1000;
const RECEIPT_AUTO_CONFIRM_MS = 48 * 3600 * 1000;

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

async function publicUser(u, viewerId = null) {
  if (!u) return null;
  const stats = await talentStats(u.id);
  const founder = !!u.is_platform_founder;
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
    positive_pct: stats.positive_pct,
    avg_stars: stats.avg_stars,
    badges: (await computeBadges(u.id)).filter(b => b.earned).slice(0, 3).map(b => b.key),
    portfolio: founder ? [] : await portfolioOf(u.id),
    frozen: !!u.frozen, penalty_level: u.penalty_level,
    // متابِعو Deal (من جدول follows) — مختلف عن followers (متابعو حساباته الخارجية).
    // يظهر للمؤسس أيضاً (عدّاد متابِعيه جزء من ملفه)، وis_following خاص بالمشاهد المسجل.
    followers_count: await followersCount(u.id),
    is_following: await isFollowing(viewerId, u.id),
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
      (SELECT COUNT(*) FROM reviews WHERE reviewee_id=?) AS rc,
      (SELECT COALESCE(SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END),0) FROM reviews WHERE reviewee_id=?) AS pos,
      (SELECT AVG(stars) FROM reviews WHERE reviewee_id=?) AS avg_s
  `).get(userId, userId, userId, userId, userId);
  const total = r.total || 0, completed = r.completed || 0, rc = r.rc || 0;
  return {
    total_deals: total,
    completed_deals: completed,
    completion_rate: total ? Math.round((completed / total) * 100) : 100,
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
  const u = await getUser(userId);
  let level = 'none';
  if (neg >= 5) level = 'suspended'; else if (neg >= 3) level = 'warning';
  if (level !== u.penalty_level && !u.banned) {
    const frozen = level === 'suspended' ? 1 : u.frozen;
    await db.prepare('UPDATE users SET penalty_level=?, frozen=? WHERE id=?').run(level, frozen, userId);
    if (level === 'warning') await notify(userId, 'penalty', 'تنبيه: تراكمت لديك 3 تقييمات سلبية', '');
    if (level === 'suspended') await notify(userId, 'penalty', 'تم تعليق حسابك وتجميد رصيدك داخل المنصة بسبب 5 تقييمات سلبية', '');
  }
}

/* ---------------- auth ---------------- */
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = token && await db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s) return res.status(401).json({ error: 'سجل الدخول أولاً' });
  req.user = await getUser(s.user_id);
  if (!req.user) return res.status(401).json({ error: 'حساب غير موجود' });
  if (req.user.banned) return res.status(403).json({ error: 'هذا الحساب محظور' });
  next();
}
async function makeSession(userId) {
  const token = rnd(24);
  await db.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').run(token, userId, now());
  return token;
}

app.post('/api/auth/register', async (req, res) => {
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
  const info = await db.prepare(`INSERT INTO users (name,role,niche,provider_category,provider_custom,city,country,currency,contact,phone,followers,price,bio,links,is_platform_founder,is_founder_member,referred_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, role, niche, provider_category, role === 'provider' ? String(provider_custom || '').trim() : '', city, country, currency, contact, phone, followers, price, bio, links, isFounder, isFounderMember, referredBy, now());
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
  res.json({
    followers_count: followerRows.length,
    following_count: followingRows.length,
    followers: followerRows.map(socialSummary),
    following: followingRows.map(socialSummary),
  });
});

/* ---------------- المراسلة الداخلية 1:1 (حسابات مسجلة فقط) ----------------
   المؤسس خارج المراسلة تماماً من الطرفين: لا رسائل إليه ولا منه عبر هذا المسار. */
const MSG_MAX = 1000;
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
    });
  }
  res.json({ items, unread_total });
});
app.get('/api/messages/:userId', auth, async (req, res) => {
  const other = await getUser(+req.params.userId);
  if (!other) return res.status(404).json({ error: 'غير موجود' });
  // فتح المحادثة يعلّم رسائل الطرف الآخر كمقروءة.
  await db.prepare('UPDATE messages SET is_read=1 WHERE sender_id=? AND recipient_id=? AND is_read=0').run(other.id, req.user.id);
  const rows = await db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)
    ORDER BY created_at DESC, id DESC LIMIT 200) recent ORDER BY created_at ASC, id ASC`)
    .all(req.user.id, other.id, other.id, req.user.id);
  res.json({
    user: socialSummary(other),
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
  "link_platforms": ["facebook.com", "instagram.com", "youtube.com", "tiktok.com", "x.com", "twitter.com", "snapchat.com"]
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
async function getBooking(id) { return await db.prepare('SELECT * FROM bookings WHERE id=?').get(id); }
async function bookingView(b, viewer) {
  const fee = Math.round(b.price * COMMISSION_RATE * 100) / 100;
  const net = b.price - fee;
  const myReview = viewer ? await db.prepare('SELECT * FROM reviews WHERE booking_id=? AND reviewer_id=?').get(b.id, viewer.id) : null;
  const view = { ...b };
  delete view.guest_token; // رمز وصول الضيف لا يخرج في أي رد أبداً
  // رقم واتساب الضيف يظهر للمنفّذ المسجّل فقط (للتواصل)، ولا يظهر لأي شخص آخر
  if (!(viewer && viewer.id === b.talent_id)) delete view.guest_phone;
  return {
    ...view,
    is_guest: !!b.guest_token,
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
async function sweepAutoConfirm() {
  const due = await db.prepare(`SELECT * FROM bookings WHERE status='proof_submitted' AND proof_check='verified' AND proof_at>0 AND ? - proof_at >= ?`)
    .all(now(), RECEIPT_AUTO_CONFIRM_MS);
  for (const b of due) {
    await db.prepare(`UPDATE bookings SET status='awaiting_rest' WHERE id=?`).run(b.id);
    await notify(b.client_id, 'booking', `حجز #${b.id}: تأكد الاستلام تلقائياً بعد 48 ساعة — ادفع الباقي`, `booking:${b.id}`);
    await notify(b.talent_id, 'booking', `حجز #${b.id}: تأكد الاستلام تلقائياً — الباقي في الطريق`, `booking:${b.id}`);
  }
}

app.post('/api/bookings', auth, async (req, res) => {
  const { talent_id, title = '', price, source = 'direct', ref_id = null, deadline_days = 7 } = req.body || {};
  const talent = await getUser(+talent_id);
  if (!talent || !['creator', 'provider'].includes(talent.role)) return res.status(400).json({ error: 'المنفذ غير صحيح' });
  if (talent.is_platform_founder) return res.status(400).json({ error: 'حساب المؤسس — عرض فقط ولا يقبل حجوزات أو تواصلاً' });
  if (talent.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حجز نفسك' });
  if (talent.penalty_level === 'suspended' || talent.frozen) return res.status(403).json({ error: 'هذا الحساب معلّق حالياً ولا يستقبل حجوزات' });
  const p = price != null ? +price : talent.price;
  if (!p || p <= 0) return res.status(400).json({ error: 'حدد سعراً صحيحاً' });
  const info = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, talent.id, source, ref_id, title || `حجز مع ${talent.name}`, p, talent.currency, now() + deadline_days * 24 * 3600 * 1000, now());
  await notify(talent.id, 'booking_new', `طلب حجز جديد #${info.lastInsertRowid} بقيمة ${p} ${talent.currency}`, `booking:${info.lastInsertRowid}`);
  res.json({ booking: await bookingView(await getBooking(info.lastInsertRowid), req.user) });
});

app.get('/api/bookings', auth, async (req, res) => {
  await sweepAutoConfirm();
  const rows = await db.prepare('SELECT * FROM bookings WHERE client_id=? OR talent_id=? ORDER BY created_at DESC').all(req.user.id, req.user.id);
  res.json({ items: await Promise.all(rows.map(b => bookingView(b, req.user))) });
});

app.get('/api/bookings/:id', auth, async (req, res) => {
  await sweepAutoConfirm();
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
    if (b.status !== 'awaiting_rest') return { error: 'الباقي غير مفتوح الآن' };
    await db.prepare('INSERT INTO payments (booking_id,kind,amount,ref,status,created_at) VALUES (?,?,?,?,?,?)').run(b.id, 'rest', half, ref, 'confirmed', now());
    await db.prepare(`UPDATE bookings SET status='completed', completed_at=? WHERE id=?`).run(now(), b.id);
    await notify(b.talent_id, 'booking', `حجز #${b.id}: اكتمل القبض — قيّم تجربتك`, `booking:${b.id}`);
    await notify(b.client_id, 'booking', `حجز #${b.id}: اكتمل — قيّم المنفذ`, `booking:${b.id}`);
    await syncBadges(b.talent_id);
  } else return { error: 'نوع دفعة غير صحيح' };
  return { booking: await getBooking(b.id) };
}

async function applyConfirmReceipt(b) {
  if (b.status !== 'proof_submitted') return { error: 'لا يوجد إثبات بانتظار التأكيد' };
  await db.prepare(`UPDATE bookings SET status='awaiting_rest' WHERE id=?`).run(b.id);
  await notify(b.talent_id, 'booking', `حجز #${b.id}: العميل أكد الاستلام — الباقي اتفتح`, `booking:${b.id}`);
  return { booking: await getBooking(b.id) };
}

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
  res.json({ label: 'Deal — حساب عمولات المنصة', phone: COMMISSION_PHONE, methods: ['Vodafone Cash', 'InstaPay'], amount: Math.round(b.price * COMMISSION_RATE * 100) / 100, currency: b.currency });
});

app.post('/api/bookings/:id/pay', auth, async (req, res) => {
  const { kind, ref } = req.body || {};
  const b = await getBooking(+req.params.id);
  if (!b || b.client_id !== req.user.id) return res.status(403).json({ error: 'الدفع من العميل فقط' });
  if (!ref) return res.status(400).json({ error: 'مرجع العملية مطلوب' });
  const r = await applyClientPayment(b, kind, ref);
  if (r.error) return res.status(400).json({ error: r.error });
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

app.post('/api/bookings/:id/dispute', auth, async (req, res) => {
  const { reason = '' } = req.body || {};
  const b = await getBooking(+req.params.id);
  if (!b || (b.client_id !== req.user.id && b.talent_id !== req.user.id)) return res.status(403).json({ error: 'لست طرفاً' });
  if (['completed', 'cancelled', 'disputed'].includes(b.status)) return res.status(400).json({ error: 'لا يمكن فتح نزاع الآن' });
  const info = await db.prepare('INSERT INTO disputes (booking_id,opened_by,reason,created_at) VALUES (?,?,?,?)').run(b.id, req.user.id, reason, now());
  await db.prepare(`UPDATE bookings SET prev_status=status, status='disputed' WHERE id=?`).run(b.id);
  const founder = await db.prepare('SELECT id FROM users WHERE is_platform_founder=1').get();
  if (founder) await notify(founder.id, 'dispute', `نزاع جديد على حجز #${b.id}`, `booking:${b.id}`);
  res.json({ dispute_id: info.lastInsertRowid, alternatives: await verifiedAlternatives(b) });
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
  const { title, niche = '', city = '', budget = 0, details = '' } = req.body || {};
  if (!title) return res.status(400).json({ error: 'عنوان الطلب مطلوب' });
  // دولة الطلب وعملته من حساب الناشر نفسه (مشتقة من دولته) — لا من العميل.
  const info = await db.prepare('INSERT INTO shop_requests (shop_user_id,title,niche,city,budget,currency,details,country,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, title, niche, city || req.user.city, budget, req.user.currency || 'EGP', details, req.user.country || 'EG', now());
  res.json({ id: info.lastInsertRowid });
});
app.get('/api/requests', async (req, res) => {
  // رقم واتساب الضيف يظهر للمسجلين فقط — الزائر العام لا يراه أبداً
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = token && await db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  const rows = await db.prepare(`SELECT r.id, r.shop_user_id, r.title, r.niche, r.city, r.budget, r.currency, r.details, r.status, r.created_at, r.is_guest, r.guest_phone, r.country, COALESCE(u.name, r.guest_name) AS shop_name FROM shop_requests r LEFT JOIN users u ON u.id=r.shop_user_id WHERE r.status='open' AND r.target_talent_id IS NULL ORDER BY r.created_at DESC`).all();
  const items = rows.map(r => {
    const it = { ...r, is_guest: !!r.is_guest };
    if (!s) delete it.guest_phone;
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
      const { guest_token, ...rest } = r;
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
  const items = [...reqs, ...camps]
    .filter(x => req.user.role === 'provider' ? x.targeted : x.score > 0)
    .sort((a, b) => b.score - a.score);
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
const GUEST_OPEN_LIMIT = 3; // أقصى طلبات ضيف مفتوحة لنفس الرقم — حد خفيف ضد الإغراق
// تحقق/تطبيع هاتف الضيف يتم عبر normalizePhoneForCountry بقاعدة دولة الضيف
// (مصر بصيغتها المحلية القائمة، وغيرها دولياً) — انظر قسم الدول أعلاه.

app.post('/api/guest-requests', async (req, res) => {
  const { business_name, phone, city, niche, budget, details = '', title, target_talent_id } = req.body || {};
  if (!business_name || !String(business_name).trim()) return res.status(400).json({ error: 'اسم النشاط مطلوب' });
  // دولة العميل الضيف (افتراضي مصر): الرقم يُتحقق ويُطبَّع بقاعدة دولته،
  // ويُحفظ بصيغته القانونية (مصر محلياً، وغيرها دولياً كاملاً +dial) فتظهر
  // للصناع بصيغته الدولية، وعملة الطلب تُشتق من الدولة.
  const guestCountry = countryOf((req.body || {}).country || 'EG');
  if (!guestCountry) return res.status(400).json({ error: 'دولة غير مدعومة حالياً' });
  const ph = normalizePhoneForCountry(phone, guestCountry.code);
  if (!ph) return res.status(400).json({ error: phoneErrorFor(guestCountry) });
  if (!city || !String(city).trim()) return res.status(400).json({ error: 'المدينة مطلوبة' });
  if (!niche || !String(niche).trim()) return res.status(400).json({ error: 'نوع الإعلان / المجال مطلوب' });
  if (budget == null || budget === '' || !isFinite(+budget) || +budget < 0) return res.status(400).json({ error: 'ميزانية تقريبية صحيحة مطلوبة' });
  if (!details || !String(details).trim()) return res.status(400).json({ error: 'اوصف الشغلانة المطلوبة' });
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
  const openCount = (await db.prepare(`SELECT COUNT(*) c FROM shop_requests WHERE is_guest=1 AND guest_phone=? AND status='open'`).get(ph)).c;
  if (openCount >= GUEST_OPEN_LIMIT) return res.status(429).json({ error: 'عندك طلبات مفتوحة كتير بنفس الرقم — استنى لما طلب يتقفل الأول' });
  const token = rnd(24);
  const info = await db.prepare(`INSERT INTO shop_requests (shop_user_id,title,niche,city,budget,currency,details,status,is_guest,guest_name,guest_phone,guest_token,target_talent_id,country,created_at) VALUES (NULL,?,?,?,?,?,?,'open',1,?,?,?,?,?,?)`)
    .run(title && String(title).trim() ? String(title).trim() : `طلب إعلان — ${String(business_name).trim()}`, niche, city, +budget, guestCountry.currency, details, String(business_name).trim(), ph, token, targetId, guestCountry.code, now());
  if (targetId) {
    await notify(targetId, 'guest_targeted',
      `🎯 طلب موجّه ليك مباشرة من عميل «${String(business_name).trim()}» — ${niche} · ${city} · ميزانية ${+budget} — افتح «فرص ليك» لتحويله لحجز بضمان Deal`,
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
      `INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,guest_name,guest_phone,guest_token,created_at)
       VALUES (NULL,$1,'guest_request',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.user.id, rq.id, rq.title, p, rq.currency, now() + deadline_days * 24 * 3600 * 1000, rq.guest_name, rq.guest_phone, rq.guest_token, now()]);
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
    fee_status: b.fee_status, agreed_client: !!b.agreed_client, agreed_talent: !!b.agreed_talent,
    fee, net, deposit: half, rest: half,
    proof_url: b.proof_url, proof_check: b.proof_check, created_at: b.created_at,
    talent: await publicUser(await getUser(b.talent_id)),
    reviewed: !!myReview,
  };
}

app.get('/api/guest/:token', async (req, res) => {
  await sweepAutoConfirm();
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
  res.json({ label: 'Deal — حساب عمولات المنصة', phone: COMMISSION_PHONE, methods: ['Vodafone Cash', 'InstaPay'], amount: Math.round(b.price * COMMISSION_RATE * 100) / 100, currency: b.currency });
});

app.post('/api/guest/:token/agree', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const r = await applyAgree(b, 'client');
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await guestBookingView(r.booking) });
});

app.post('/api/guest/:token/pay', async (req, res) => {
  const { kind, ref } = req.body || {};
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  if (!ref) return res.status(400).json({ error: 'مرجع العملية مطلوب' });
  const r = await applyClientPayment(b, kind, ref);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await guestBookingView(r.booking) });
});

app.post('/api/guest/:token/confirm-receipt', async (req, res) => {
  const b = await guestBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'رابط متابعة غير صحيح' });
  const r = await applyConfirmReceipt(b);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ booking: await guestBookingView(r.booking) });
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
    a_ar: 'Deal — منصة كل صناع المحتوى: الصانع يسجّل ملفه (مجال، مدينة، سعر)، والعميل ينشر شغلانة أو يحجز صانعاً مباشرة، والدفع يتم بين الطرفين على مراحل بحماية «ضمان Deal» — المنصة تنظّم الخطوات وتوثّقها ولا تمسك فلوس حد.',
    a_en: 'Deal — the platform for all content creators: creators register a profile (niche, city, price), clients post a job or book a creator directly, and payment happens between the two sides in protected stages under the Deal Guarantee — the platform organizes and documents the steps and never holds anyone\'s money.' },
  { id: 'register', q_ar: 'كيف أسجّل كصانع محتوى؟', q_en: 'How do I register as a creator?',
    keys: ['تسجيل', 'اسجل', 'حساب جديد', 'انشاء حساب', 'register', 'sign up', 'create account', 'join as creator'],
    a_ar: 'من زر «دخول / تسجيل» اختر «صانع محتوى» واملأ الاسم والمجال والمدينة وعدد المتابعين وسعرك ووسيلة تواصل واحدة (رقم هاتف أو إيميل) — التسجيل مجاني ووسيلة التواصل هي وسيلة دخولك بعد ذلك.',
    a_en: 'Tap "Login / Register", choose "Content creator" and fill in your name, niche, city, follower count, price and one contact (phone or email) — registration is free, and that contact becomes your login afterwards.' },
  { id: 'one_account', q_ar: 'لماذا لا أستطيع التسجيل مرتين؟', q_en: 'Why can\'t I register twice?',
    keys: ['مرتين', 'حسابين', 'ملفين', 'مسجلة من قبل', 'تسجيل مكرر', 'two accounts', 'register twice', 'duplicate', 'already registered'],
    a_ar: 'كل شخص له حساب واحد فقط على Deal — وسيلة التواصل الواحدة = ملف واحد، حتى تبقى التقييمات والسمعة مرتبطة بشخص حقيقي واحد ولا تتشتت. لو سجلت من قبل، استخدم «دخول» بنفس الرقم أو الإيميل (بأي صيغة: +20 أو 0 — النظام يوحّدها).',
    a_en: 'Each person gets exactly one Deal account — one contact = one profile, so ratings and reputation stay tied to a single real person. If you registered before, just log in with the same number or email (any format: +20 or 0 — the system normalizes it).' },
  { id: 'guest_post', q_ar: 'كيف أنشر شغلانة كعميل دون تسجيل؟', q_en: 'How do I post a job as a client without registering?',
    keys: ['ضيف', 'دون تسجيل', 'بدون تسجيل', 'بدون حساب', 'انشر شغلانة', 'نشر طلب', 'عندي محل', 'guest', 'without registering', 'without account', 'post a job', 'post job'],
    a_ar: 'من زر «📣 انشر شغلانة» في الواجهة: اكتب اسم نشاطك ورقم واتسابك والمدينة ونوع الإعلان والميزانية ووصف الشغلانة — بدون أي حساب. طلبك يظهر للصناع فوراً ويتواصلون معك واتساب، وستحصل على رابط متابعة خاص تكمل منه خطوات الحجز والدفع والتقييم.',
    a_en: 'Use the "📣 Post a job" button on the home page: enter your business name, WhatsApp number, city, ad type, budget and a description — no account needed. Creators see your request instantly and contact you on WhatsApp, and you get a private follow-up link to complete booking, payment and rating steps.' },
  { id: 'fee_why', q_ar: 'ما هي عمولة Deal ولماذا تُدفع أولاً؟', q_en: 'What is the Deal fee and why is it paid first?',
    keys: ['عمولة', 'ليه العمولة', 'لماذا العمولة', '10%', '١٠', 'fee', 'commission', 'why fee first', '10 percent'],
    a_ar: 'عمولة Deal هي 10% من قيمة الشغلانة، وتُدفع أولاً قبل أي مبلغ للصانع: بها يتأكد جدية الحجز ويُفتح باقي خطوات الدفع المحمي، وهي مصدر تشغيل المنصة وخدمة الضمان والتوثيق. العميل يدفع السعر المعلن بالضبط — العمولة جزء منه وتُخصم من حصة الصانع (صافي الصانع 90%).',
    a_en: 'The Deal fee is 10% of the job value, paid first before any money reaches the creator: it confirms the booking is serious and unlocks the protected payment stages, and it funds the platform, guarantee and verification services. The client pays exactly the listed price — the fee is part of it and comes out of the creator\'s share (the creator nets 90%).' },
  { id: 'fee_how', q_ar: 'كيف أدفع العمولة؟', q_en: 'How do I pay the fee?',
    keys: ['ادفع العمولة ازاي', 'كيف ادفع', 'فودافون كاش', 'انستاباي', 'مرجع التحويل', 'رقم التحويلة', 'how to pay', 'vodafone cash', 'instapay', 'transfer reference', 'payment reference'],
    a_ar: 'داخل خطوة «عمولة Deal أولاً» في حجزك اضغط «إظهار حساب عمولات Deal» وسيظهر رقم حساب العمولات (يظهر فقط للعميل الدافع وداخل هذه الخطوة فقط). حوّل مبلغ العمولة إليه من محفظتك (فودافون كاش أو إنستاباي)، ثم اكتب مرجع عملية التحويل في الحجز واضغط تأكيد — التأكيد تلقائي.',
    a_en: 'Inside the "Deal fee first" step of your booking, tap "Show Deal fee account" — the fee account number appears only to the paying client and only at this step. Transfer the fee amount from your wallet (Vodafone Cash or InstaPay), then enter the transfer reference in the booking and confirm — confirmation is automatic.' },
  { id: 'stages', q_ar: 'كيف يتم الدفع على مراحل (45/45)؟', q_en: 'How does the staged payment (45/45) work?',
    keys: ['مراحل', '45', '٤٥', 'عربون', 'الباقي', 'دفعتين', 'staged', 'deposit', 'stages', 'two payments', 'installments'],
    a_ar: 'بعد العمولة (10%)، يدفع العميل 45% من السعر عربوناً للصانع مباشرة فيبدأ التنفيذ، وبعد تقديم إثبات التنفيذ وتأكيد الاستلام يدفع الـ45% الباقية — فيصل للصانع صافيه كاملاً (90%) ولا يخسر أي طرف: العميل لا يدفع الباقي قبل ما يستلم، والصانع لا يسلّم قبل العربون.',
    a_en: 'After the 10% fee, the client pays 45% of the price directly to the creator as a deposit so work starts, and after proof of delivery and receipt confirmation pays the remaining 45% — the creator receives the full net (90%) and neither side is exposed: the client never pays the rest before delivery, and the creator never delivers before the deposit.' },
  { id: 'guarantee', q_ar: 'ما هو ضمان Deal؟', q_en: 'What is the Deal Guarantee?',
    keys: ['ضمان', 'حماية', 'امان', 'أمان', 'guarantee', 'protection', 'safe', 'trust'],
    a_ar: '«حجز محمي بضمان Deal» يعني: دفع مرحلي موثّق داخل الحجز، عمولة مؤكدة أولاً، إثبات تنفيذ تتحقق منه المنصة ويُختم بوقته، إمكانية فتح نزاع يجمّد الحجز حتى تراجعه الإدارة، وعند إخلال المنفذ تقترح المنصة بدائل موثّقة من نفس مدينتك ومجالك.',
    a_en: 'A "Deal-Guaranteed booking" means: staged payments documented inside the booking, the fee confirmed first, a proof of delivery that the platform verifies and timestamps, the ability to open a dispute that freezes the booking until admin review, and — if the creator defaults — verified alternatives from your own city and niche suggested by the platform.' },
  { id: 'proof', q_ar: 'ما هو إثبات التنفيذ وكيف يعمل؟', q_en: 'What is proof of delivery and how does it work?',
    keys: ['اثبات', 'إثبات', 'رابط العمل', 'proof', 'delivery proof', 'published work link'],
    a_ar: 'بعد التنفيذ يرسل الصانع رابط العمل المنشور علناً (الفيديو/المنشور) داخل الحجز؛ المنصة تتحقق آلياً أن الرابط يعمل وعلني ويختمه بوقت الإرسال. الدفعة الأخيرة لا تُفتح إلا بإثبات سليم، والإثبات يُحفظ تلقائياً في معرض أعمال الصانع.',
    a_en: 'After delivery, the creator submits the publicly published work link inside the booking; the platform automatically verifies the link is live and public and timestamps it. The final payment only unlocks with a valid proof, and the proof is automatically saved to the creator\'s portfolio.' },
  { id: 'auto_confirm', q_ar: 'ما هو التأكيد التلقائي بعد 48 ساعة؟', q_en: 'What is the 48-hour auto-confirmation?',
    keys: ['48', '٤٨', 'تأكيد تلقائي', 'سكوت', 'ما رديتش', 'auto confirm', '48 hours', 'automatic confirmation', 'no response'],
    a_ar: 'لو قدّم الصانع إثبات تنفيذ سليماً ولم يؤكد العميل الاستلام يدوياً خلال 48 ساعة من الإثبات، يؤكَّد الاستلام تلقائياً وتُفتح الدفعة الأخيرة — حمايةً للصانع من التأخير، وحق العميل في النزاع يبقى قائماً عند وجود مشكلة حقيقية.',
    a_en: 'If the creator submits a valid proof of delivery and the client does not manually confirm receipt within 48 hours of the proof, receipt is auto-confirmed and the final payment unlocks — protecting the creator from delays, while the client\'s right to dispute a real problem remains.' },
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
    a_ar: 'من داخل الحجز اضغط «فتح نزاع» واكتب السبب: يتجمّد الحجز فوراً في مرحلته الحالية (لا دفعات جديدة) وتراجع الإدارة الحالة، ثم يُحل النزاع إما بإرجاع الحجز لمساره أو إلغائه — وكل ذلك موثّق داخل الحجز نفسه.',
    a_en: 'From inside the booking, tap "Open dispute" and state the reason: the booking freezes immediately at its current stage (no new payments) while the admin reviews it, then the dispute is resolved either by restoring the booking to its track or cancelling it — all documented inside the booking itself.' },
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
    a_ar: 'الحملات شغلانات تنشرها البراندات من قسم «الحملات» ببريف وميزانية: الصانع يقدّم عليها من بطاقتها، وإذا قبل البراند تقديمه يُفتح حجز عادي تلقائياً بنفس حماية Deal ومراحل دفعها.',
    a_en: 'Campaigns are jobs posted by brands in the "Campaigns" section with a brief and budget: creators apply from the campaign card, and if the brand accepts, a normal booking opens automatically with the same Deal protection and payment stages.' },
  { id: 'countries', q_ar: 'هل Deal متاح في بلدي؟ ما هي الدول المتاحة؟', q_en: 'Is Deal available in my country? Which countries are supported?',
    keys: ['الدول المتاحه', 'دول متاحه', 'متاح في بلدي', 'في بلدي', 'بلدي متاح', 'دول عربية', 'available countries', 'which countries', 'supported countries', 'my country'],
    a_ar: 'Deal متاح الآن في 19 دولة عربية: مصر، السعودية، الإمارات، الكويت، قطر، الأردن، المغرب، البحرين، عُمان، العراق، الجزائر، تونس، لبنان، فلسطين، ليبيا، السودان، اليمن، سوريا، وموريتانيا. اختر دولتك عند التسجيل (أو في نموذج «انشر شغلانة» كضيف) وسيظهر سعرك بعملة بلدك، ورقم هاتفك يُتحقق منه بقاعدة بلدك، والدفع المحلي عندك هو وسيلة التحويل المعروفة في بلدك (مثل فودافون كاش/إنستاباي في مصر، وSTC Pay/مدى في السعودية، وCliQ في الأردن).',
    a_en: 'Deal is now available in 19 Arab countries: Egypt, Saudi Arabia, UAE, Kuwait, Qatar, Jordan, Morocco, Bahrain, Oman, Iraq, Algeria, Tunisia, Lebanon, Palestine, Libya, Sudan, Yemen, Syria and Mauritania. Pick your country when you register (or in the guest "Post a job" form) and your price shows in your country\'s currency, your phone is validated by your country\'s rules, and payments use your local method (e.g. Vodafone Cash/InstaPay in Egypt, STC Pay/mada in Saudi Arabia, CliQ in Jordan).' },
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
  const unread_messages = (await db.prepare('SELECT COUNT(*) c FROM messages WHERE recipient_id=? AND is_read=0').get(u.id)).c;
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
  res.json({ label: 'Deal — حساب عمولات المنصة', phone: COMMISSION_PHONE, methods: ['Vodafone Cash', 'InstaPay'], amount: STAR_PRICE, currency: STAR_CURRENCY });
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
  const info = await db.prepare(`INSERT INTO star_subscriptions (user_id,amount,currency,ref,status,terms_version,terms_accepted_at,created_at)
    VALUES (?,?,?,?, 'pending', ?, ?, ?)`)
    .run(u.id, STAR_PRICE, STAR_CURRENCY, String(ref).trim().slice(0, 120), STAR_TERMS_VERSION, now(), now());
  const founder = await db.prepare('SELECT id FROM users WHERE is_platform_founder=1').get();
  if (founder) await notify(founder.id, 'star_pending', `⭐ اشتراك «نجم Deal» قيد التحقق من ${u.name} — مرجع ${String(ref).trim().slice(0, 60)}`, `star:${info.lastInsertRowid}`);
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
  const earnings = await db.prepare(`SELECT p.kind, p.amount, p.created_at FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.talent_id=? AND p.kind IN ('deposit','rest')`).all(uid);
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
  await notify(s.user_id, 'star_active', `⭐ مبروك! اتفعّل اشتراكك في «نجم Deal» — مزاياك شغالة من دلوقتي ولمدة 30 يوم`, 'star');
  res.json({ ok: true, subscription: starSubView(await db.prepare('SELECT * FROM star_subscriptions WHERE id=?').get(s.id)) });
});
app.post('/api/owner/star/:id/reject', auth, ownerOnly, async (req, res) => {
  const s = await db.prepare('SELECT * FROM star_subscriptions WHERE id=?').get(+req.params.id);
  if (!s || s.status !== 'pending') return res.status(400).json({ error: 'اشتراك غير موجود أو تم البت فيه' });
  const reason = String((req.body || {}).reason || 'مرجع التحويلة غير صحيح').slice(0, 300);
  await db.prepare(`UPDATE star_subscriptions SET status='rejected', decided_at=?, decided_by=?, reject_reason=? WHERE id=?`)
    .run(now(), req.user.id, reason, s.id);
  await notify(s.user_id, 'star_rejected', `اشتراك «نجم Deal» لم يُفعَّل: ${reason} — راجع مرجع التحويلة واشترك من جديد`, 'star');
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
  const earnings = await db.prepare(`SELECT p.kind, p.amount, p.created_at FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.talent_id=? AND p.kind IN ('deposit','rest')`).all(uid);
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
  await db.prepare('UPDATE bookings SET status=? WHERE id=?').run(target, b.id);
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
/** Reject a false fee reference inside the 48h review window: reopens fee step + opens a dispute. */
app.post('/api/owner/bookings/:id/reject-fee', auth, ownerOnly, async (req, res) => {
  const b = await getBooking(+req.params.id);
  if (!b || b.fee_status !== 'confirmed') return res.status(400).json({ error: 'لا توجد عمولة مؤكدة' });
  if (now() - b.fee_confirmed_at > FEE_REVIEW_WINDOW_MS) return res.status(400).json({ error: 'انتهت نافذة مراجعة الـ48 ساعة' });
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
