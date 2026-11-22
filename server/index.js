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
const { db, init } = require('./db');

const PORT = process.env.PORT || 3000;
const COMMISSION_RATE = 0.10;
const COMMISSION_PHONE = process.env.COMMISSION_PHONE || ''; // server-side only — من متغير البيئة فقط، بلا أي قيمة افتراضية في الكود
const FEE_REVIEW_WINDOW_MS = 48 * 3600 * 1000;
const RECEIPT_AUTO_CONFIRM_MS = 48 * 3600 * 1000;

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

async function publicUser(u, viewerId = null) {
  if (!u) return null;
  const stats = await talentStats(u.id);
  return {
    id: u.id, name: u.name, role: u.role, niche: u.niche,
    provider_category: u.provider_category, city: u.city, country: u.country,
    currency: u.currency, followers: u.followers, price: u.price, bio: u.bio,
    is_platform_founder: !!u.is_platform_founder,
    is_founder_member: !!u.is_founder_member,
    verified: !!u.verified, pioneer: !!u.pioneer,
    boost_active: u.boost_until > now() && u.penalty_level !== 'suspended',
    member_since: u.created_at,
    completion_rate: stats.completion_rate,
    completed_deals: stats.completed_deals,
    positive_pct: stats.positive_pct,
    avg_stars: stats.avg_stars,
    badges: (await computeBadges(u.id)).filter(b => b.earned).slice(0, 3).map(b => b.key),
    portfolio: await portfolioOf(u.id),
    frozen: !!u.frozen, penalty_level: u.penalty_level,
  };
}

async function portfolioOf(userId) {
  return (await db.prepare(`SELECT proof_url FROM bookings WHERE talent_id=? AND status='completed' AND proof_url!='' ORDER BY completed_at DESC LIMIT 12`)
    .all(userId)).map(r => r.proof_url);
}

async function talentStats(userId) {
  const total = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND status NOT IN ('cancelled')`).get(userId)).c;
  const completed = (await db.prepare(`SELECT COUNT(*) c FROM bookings WHERE talent_id=? AND status='completed'`).get(userId)).c;
  const rev = await db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) pos, AVG(stars) avg FROM reviews WHERE reviewee_id=?`).get(userId);
  return {
    total_deals: total,
    completed_deals: completed,
    completion_rate: total ? Math.round((completed / total) * 100) : 100,
    positive_pct: rev.c ? Math.round((rev.pos / rev.c) * 100) : null,
    avg_stars: rev.avg ? Math.round(rev.avg * 10) / 10 : null,
    reviews_count: rev.c,
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
async function computeBadges(userId) {
  const u = await getUser(userId);
  const s = await talentStats(userId);
  const lastProofs = await db.prepare(`SELECT proof_at, deadline FROM bookings WHERE talent_id=? AND status='completed' AND proof_at>0 ORDER BY completed_at DESC LIMIT 5`).all(userId);
  const onTime = lastProofs.length === 5 && lastProofs.every(p => !p.deadline || p.proof_at <= p.deadline);
  const invitedDone = 0; // referrals tracked in Muse version via invite codes; standalone keeps hook (see README)
  const ageMs = now() - u.created_at;
  const defs = {
    perfect:    { earned: s.completed_deals >= 10 && s.completion_rate === 100, progress: `${Math.min(s.completed_deals,10)}/10 صفقات بإتمام 100%` },
    top_rated:  { earned: s.reviews_count >= 10 && s.positive_pct >= 95, progress: `${Math.min(s.reviews_count,10)}/10 تقييمات بإيجابية 95%+` },
    fast:       { earned: onTime, progress: `${lastProofs.filter(p => !p.deadline || p.proof_at <= p.deadline).length}/5 إثباتات قبل المهلة` },
    rising:     { earned: s.completed_deals >= 5, progress: `${Math.min(s.completed_deals,5)}/5 صفقات` },
    ambassador: { earned: invitedDone >= 5, progress: `${invitedDone}/5 مدعوين أكملوا صفقة` },
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
    if (level === 'suspended') await notify(userId, 'penalty', 'تم تعليق حسابك وتجميد رصيدك داخل التطبيق بسبب 5 تقييمات سلبية', '');
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
  const { name, role, niche = '', provider_category = null, city = '', country = 'EG', currency = 'EGP', contact, phone = '', followers = 0, price = 0, bio = '', links = '' } = req.body || {};
  if (!name || !role || !contact) return res.status(400).json({ error: 'الاسم والدور ووسيلة التواصل مطلوبة' });
  if (!['creator', 'provider', 'shop', 'brand'].includes(role)) return res.status(400).json({ error: 'دور غير صحيح' });
  if (role === 'provider' && !['ads', 'support'].includes(provider_category)) return res.status(400).json({ error: 'اختر فئة الخدمة: إعلانات ممولة أو حلول حسابات' });
  if (await db.prepare('SELECT id FROM users WHERE contact=?').get(contact)) return res.status(409).json({ error: 'وسيلة التواصل مسجلة من قبل — سجل الدخول' });

  const totalUsers = (await db.prepare('SELECT COUNT(*) c FROM users').get()).c;
  const creatorsCount = (await db.prepare(`SELECT COUNT(*) c FROM users WHERE role='creator'`).get()).c;
  const isFounder = totalUsers === 0 ? 1 : 0;
  const isFounderMember = role === 'creator' && creatorsCount < 100 ? 1 : 0;
  const info = await db.prepare(`INSERT INTO users (name,role,niche,provider_category,city,country,currency,contact,phone,followers,price,bio,links,is_platform_founder,is_founder_member,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, role, niche, provider_category, city, country, currency, contact, phone || contact, followers, price, bio, links, isFounder, isFounderMember, now());
  const user = await getUser(info.lastInsertRowid);
  res.json({ token: await makeSession(user.id), user: await publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { contact } = req.body || {};
  const user = contact && await db.prepare('SELECT * FROM users WHERE contact=?').get(contact);
  if (!user) return res.status(404).json({ error: 'لا يوجد حساب بهذه البيانات — سجل أولاً' });
  if (user.banned) return res.status(403).json({ error: 'هذا الحساب محظور' });
  res.json({ token: await makeSession(user.id), user: await publicUser(user) });
});

app.get('/api/me', auth, async (req, res) => {
  await syncBadges(req.user.id);
  res.json({ user: await publicUser(req.user, req.user.id), verify_status: req.user.verify_status, verify_code: req.user.verify_code });
});

app.post('/api/me/prefs', auth, async (req, res) => {
  const { min_price_pref, notify_pref } = req.body || {};
  await db.prepare('UPDATE users SET min_price_pref=COALESCE(?,min_price_pref), notify_pref=COALESCE(?,notify_pref) WHERE id=?')
    .run(min_price_pref ?? null, notify_pref ?? null, req.user.id);
  res.json({ ok: true });
});

/* ---------------- directory / market ---------------- */
app.get('/api/directory', async (req, res) => {
  const { role, niche, city, q } = req.query;
  let sql = `SELECT * FROM users WHERE role IN ('creator','provider') AND banned=0`;
  const args = [];
  if (role) { sql += ' AND role=?'; args.push(role); }
  if (niche) { sql += ' AND niche=?'; args.push(niche); }
  if (city) { sql += ' AND city=?'; args.push(city); }
  if (q) { sql += ' AND (name LIKE ? OR niche LIKE ? OR city LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await db.prepare(sql).all(...args);
  const dealsMap = {};
  await Promise.all(rows.map(async (u) => { dealsMap[u.id] = (await talentStats(u.id)).completed_deals; }));
  const t = now();
  rows.sort((a, b) => {
    const boost = (x) => (x.boost_until > t && x.penalty_level !== 'suspended') ? 1 : 0;
    return (b.verified - a.verified) || (boost(b) - boost(a)) || ((dealsMap[b.id] || 0) - (dealsMap[a.id] || 0));
  });
  res.json({ items: await Promise.all(rows.map(u => publicUser(u))) });
});

app.get('/api/talent/:id', async (req, res) => {
  const u = await getUser(+req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = token && await db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  const viewerId = s ? s.user_id : null;
  if (viewerId !== u.id) await db.prepare('INSERT INTO profile_views (talent_id,viewer_id,created_at) VALUES (?,?,?)').run(u.id, viewerId, now());
  const reviews = await db.prepare(`SELECT r.*, COALESCE(u2.name, 'عميل') reviewer_name FROM reviews r LEFT JOIN users u2 ON u2.id=r.reviewer_id WHERE r.reviewee_id=? ORDER BY r.created_at DESC LIMIT 10`).all(u.id);
  res.json({ user: await publicUser(u), stats: await talentStats(u.id), badges: await computeBadges(u.id), reviews });
});

/* ---------------- automatic verification ---------------- */
app.post('/api/verify/request', auth, async (req, res) => {
  if (req.user.role !== 'creator') return res.status(400).json({ error: 'التوثيق للصناع فقط' });
  const code = `DEAL-${req.user.id}-${rnd(3).toUpperCase()}`;
  await db.prepare(`UPDATE users SET verify_code=?, verify_status='pending', verify_reason='' WHERE id=?`).run(code, req.user.id);
  res.json({ code, instructions: 'ضع هذا الكود في بايو أحد حساباتك العلنية أو منشور مثبت، ثم أرسل رابط الحساب للفحص.' });
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
    const pioneer = await db.prepare(`SELECT id FROM users WHERE verified=1 AND pioneer=1 AND city=? AND niche=?`).get(u.city, u.niche) ? 0 : 1;
    await db.prepare(`UPDATE users SET verified=1, verify_status='verified', verify_reason='', pioneer=?, boost_until=? WHERE id=?`)
      .run(pioneer, now() + 7 * 24 * 3600 * 1000, u.id);
    await notify(u.id, 'verification', 'مبروك! حسابك بقى «موثّق Deal»' + (pioneer ? ' وأنت «رائد المدينة» في مجالك' : ''), '');
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
  return Promise.all((await db.prepare(`SELECT * FROM users WHERE role=? AND niche=? AND city=? AND verified=1 AND id!=? AND banned=0 LIMIT 3`)
    .all(t.role, t.niche, t.city, t.id)).map(u => publicUser(u)));
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
  res.json({ label: 'Deal — حساب عمولات التطبيق', phone: COMMISSION_PHONE, methods: ['Vodafone Cash', 'InstaPay'], amount: Math.round(b.price * COMMISSION_RATE * 100) / 100, currency: b.currency });
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
  const { title, niche = '', city = '', budget = 0, currency = 'EGP', details = '' } = req.body || {};
  if (!title) return res.status(400).json({ error: 'عنوان الطلب مطلوب' });
  const info = await db.prepare('INSERT INTO shop_requests (shop_user_id,title,niche,city,budget,currency,details,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, title, niche, city || req.user.city, budget, currency, details, now());
  res.json({ id: info.lastInsertRowid });
});
app.get('/api/requests', async (req, res) => {
  // رقم واتساب الضيف يظهر للمسجلين فقط — الزائر العام لا يراه أبداً
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = token && await db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  const rows = await db.prepare(`SELECT r.id, r.shop_user_id, r.title, r.niche, r.city, r.budget, r.currency, r.details, r.status, r.created_at, r.is_guest, r.guest_phone, COALESCE(u.name, r.guest_name) AS shop_name FROM shop_requests r LEFT JOIN users u ON u.id=r.shop_user_id WHERE r.status='open' ORDER BY r.created_at DESC`).all();
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
  if (req.user.role !== 'creator') return res.json({ items: [] });
  const reqs = (await db.prepare(`SELECT * FROM shop_requests WHERE status='open'`).all())
    .map(r => { const { guest_token, ...rest } = r; return { kind: 'request', ...rest, is_guest: !!r.is_guest, ...matchScore(req.user, r) }; });
  const camps = (await db.prepare(`SELECT * FROM campaigns WHERE status='open'`).all())
    .map(c => ({ kind: 'campaign', ...c, ...matchScore(req.user, c) }));
  const items = [...reqs, ...camps].filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  res.json({ items });
});

/* ---------------- guest client requests (طلب عميل بدون تسجيل) ----------------
   العميل (محل/براند) ينشر طلبه كضيف: بلا حساب وبلا كلمة سر. هويته في المتابعة
   هي رمز وصول عشوائي طويل (token) يُحفظ على الطلب ثم على الحجز عند التحويل،
   وخطواته في الحجز تتم من صفحة الرمز بنفس آلة الحالات المشتركة أعلاه. */
const GUEST_OPEN_LIMIT = 3; // أقصى طلبات ضيف مفتوحة لنفس الرقم — حد خفيف ضد الإغراق
const EG_MOBILE = /^01[0125][0-9]{8}$/;
function normEgPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('0020')) d = d.slice(4);
  else if (d.startsWith('20') && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith('1')) d = '0' + d;
  return EG_MOBILE.test(d) ? d : null;
}

app.post('/api/guest-requests', async (req, res) => {
  const { business_name, phone, city, niche, budget, details = '', title } = req.body || {};
  if (!business_name || !String(business_name).trim()) return res.status(400).json({ error: 'اسم النشاط مطلوب' });
  const ph = normEgPhone(phone);
  if (!ph) return res.status(400).json({ error: 'رقم موبايل مصري صحيح مطلوب (01xxxxxxxxx)' });
  if (!city || !String(city).trim()) return res.status(400).json({ error: 'المدينة مطلوبة' });
  if (!niche || !String(niche).trim()) return res.status(400).json({ error: 'نوع الإعلان / المجال مطلوب' });
  if (budget == null || budget === '' || !isFinite(+budget) || +budget < 0) return res.status(400).json({ error: 'ميزانية تقريبية صحيحة مطلوبة' });
  if (!details || !String(details).trim()) return res.status(400).json({ error: 'اوصف الشغلانة المطلوبة' });
  const openCount = (await db.prepare(`SELECT COUNT(*) c FROM shop_requests WHERE is_guest=1 AND guest_phone=? AND status='open'`).get(ph)).c;
  if (openCount >= GUEST_OPEN_LIMIT) return res.status(429).json({ error: 'عندك طلبات مفتوحة كتير بنفس الرقم — استنى لما طلب يتقفل الأول' });
  const token = rnd(24);
  const info = await db.prepare(`INSERT INTO shop_requests (shop_user_id,title,niche,city,budget,currency,details,status,is_guest,guest_name,guest_phone,guest_token,created_at) VALUES (NULL,?,?,?,?,'EGP',?,'open',1,?,?,?,?)`)
    .run(title && String(title).trim() ? String(title).trim() : `طلب إعلان — ${String(business_name).trim()}`, niche, city, +budget, details, String(business_name).trim(), ph, token, now());
  res.json({ id: info.lastInsertRowid, token, follow: `/#/g/${token}` });
});

/* صانع مسجل يحوّل طلب الضيف إلى حجز رسمي بنفس آلة الحالات — العميل طرفه الضيف. */
app.post('/api/guest-requests/:id/book', auth, async (req, res) => {
  if (!['creator', 'provider'].includes(req.user.role)) return res.status(400).json({ error: 'تحويل الطلبات للصناع ومقدمي الخدمة فقط' });
  const rq = await db.prepare('SELECT * FROM shop_requests WHERE id=? AND is_guest=1').get(+req.params.id);
  if (!rq) return res.status(404).json({ error: 'طلب ضيف غير موجود' });
  if (rq.status !== 'open') return res.status(400).json({ error: 'هذا الطلب اتحجز خلاص' });
  if (req.user.penalty_level === 'suspended' || req.user.frozen) return res.status(403).json({ error: 'حسابك معلّق حالياً ولا يستقبل حجوزات' });
  const { price, deadline_days = 7 } = req.body || {};
  const p = price != null ? +price : (rq.budget || req.user.price);
  if (!p || p <= 0) return res.status(400).json({ error: 'حدد سعراً صحيحاً' });
  const info = await db.prepare(`INSERT INTO bookings (client_id,talent_id,source,ref_id,title,price,currency,deadline,guest_name,guest_phone,guest_token,created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, 'guest_request', rq.id, rq.title, p, rq.currency, now() + deadline_days * 24 * 3600 * 1000, rq.guest_name, rq.guest_phone, rq.guest_token, now());
  await db.prepare(`UPDATE shop_requests SET status='booked' WHERE id=?`).run(rq.id);
  await notify(req.user.id, 'booking_new', `حوّلت طلب عميل «${rq.guest_name}» إلى حجز #${info.lastInsertRowid} — العميل هيكمل خطواته من رابط متابعته`, `booking:${info.lastInsertRowid}`);
  res.json({ booking: await bookingView(await getBooking(info.lastInsertRowid), req.user), follow: `/#/g/${rq.guest_token}` });
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
  res.json({ label: 'Deal — حساب عمولات التطبيق', phone: COMMISSION_PHONE, methods: ['Vodafone Cash', 'InstaPay'], amount: Math.round(b.price * COMMISSION_RATE * 100) / 100, currency: b.currency });
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
  res.json({ items: await Promise.all(rows.map(async a => ({ ...a, creator: await publicUser(await getUser(a.creator_id)) }))) });
});
app.post('/api/applications/:id/accept', auth, async (req, res) => {
  const a = await db.prepare('SELECT * FROM campaign_applications WHERE id=?').get(+req.params.id);
  if (!a) return res.status(404).json({ error: 'غير موجود' });
  const c = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(a.campaign_id);
  if (!c || c.brand_user_id !== req.user.id) return res.status(403).json({ error: 'ليست حملتك' });
  if (a.status !== 'pending') return res.status(400).json({ error: 'تم البت في هذا التقديم' });
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

/* ---------------- creator stats ---------------- */
app.get('/api/my/stats', auth, async (req, res) => {
  const uid = req.user.id;
  const views = (await db.prepare('SELECT COUNT(*) c FROM profile_views WHERE talent_id=?').get(uid)).c;
  const opps = (await db.prepare(`SELECT COUNT(*) c FROM shop_requests WHERE status='open'`).get()).c +
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
