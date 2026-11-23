'use strict';
/**
 * اختبارات الطرف-للطرف لنسخة Deal (Vercel + Supabase/Postgres).
 * نفس فحوص TESTING.md الأصلية (35 فحصاً) لكن ضد PostgreSQL حقيقي
 * (embedded-postgres في بيئة الاختبار فقط) ومتغير COMMISSION_PHONE اختباري.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');

const PG_PORT = 5433;
const APP_PORT = 3210;
const AUX_PORT = 3457;
const TEST_PHONE = '01099999999'; // رقم اختباري — ليس الرقم الحقيقي
const DATABASE_URL = `postgresql://postgres:postgres@localhost:${PG_PORT}/deal_test`;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const AUX = `http://127.0.0.1:${AUX_PORT}`;
// حتى يستطيع فحص مدخل Vercel (require api/index) تحميل طبقة قاعدة البيانات داخل عملية الاختبار نفسها
process.env.DATABASE_URL = DATABASE_URL;
process.env.COMMISSION_PHONE = TEST_PHONE;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${passed + failed}. ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${passed + failed}. ${name} ${extra}`); }
}

let autoDevSeq = 0;
async function api(method, p, { token, body } = {}) {
  /* جولة التصميم: حدّ طلبات الضيف صار ببصمة (جهاز + IP) لا برقم هاتف. المحاكاة
     هنا تعطي كل سيناريو ضيف جهازاً مستقلاً تلقائياً (device_id فريد لكل طلب)
     حتى لا تتصادم السيناريوهات على بصمة واحدة — إلا حين يمرّر الاختبار نفسه
     device_id صريحاً (اختبار حدّ الإغراق) فتُحترم قيمته كما هي. العميل الحقيقي
     يرسل معرّف جهاز واحداً ثابتاً من متصفحه. */
  if (method === 'POST' && p === '/api/guest-requests' && body && body.device_id === undefined) {
    body = { ...body, device_id: 'suite-auto-' + (++autoDevSeq) };
  }
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* not json */ }
  return { status: r.status, body: j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) {}
    await sleep(500);
  }
  throw new Error('app did not start');
}

async function main() {
  /* ---------- Postgres اختباري ---------- */
  const pg = new EmbeddedPostgres({
    databaseDir: '/tmp/deal-vercel-test-pg',
    user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false,
    // Postgres يرفض التشغيل كـ root: عند التشغيل كـ root نطلب إنشاء مستخدم postgres،
    // وعند التشغيل كمستخدم postgres نفسه (كما في بيئة الاختبار هنا) لا حاجة لذلك.
    createPostgresUser: typeof process.getuid === 'function' && process.getuid() === 0,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('deal_test');

  /* ---------- خادم صفحات علنية (بايو/إثبات) ---------- */
  const aux = http.createServer((req, res) => {
    const u = new URL(req.url, AUX);
    if (u.pathname === '/bio') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body><h1>${u.searchParams.get('name') || ''}</h1><p>${u.searchParams.get('code') || ''}</p></body></html>`);
    } else if (u.pathname === '/plain') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>صفحة بلا كود</body></html>');
    } else if (u.pathname === '/proof-ok') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>العمل المنشور</body></html>');
    } else { res.writeHead(404); res.end('nope'); }
  });
  await new Promise((r) => aux.listen(AUX_PORT, r));

  /* ---------- تشغيل التطبيق ---------- */
  const app = spawn('node', ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(APP_PORT), DATABASE_URL, COMMISSION_PHONE: TEST_PHONE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));
  await waitHealth();

  try {
    /* ===== التسجيل والأدوار ===== */
    let r = await api('GET', '/api/directory');
    check('السوق يبدأ فارغاً تماماً', r.status === 200 && Array.isArray(r.body.items) && r.body.items.length === 0);

    r = await api('POST', '/api/auth/register', { body: { name: 'Founder One', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'founder@test', price: 300 } });
    const founder = r.body.user, founderTok = r.body.token;
    check('أول حساب = مؤسس منصة + عضو مؤسس', !!founder && founder.is_platform_founder === true && founder.is_founder_member === true);

    r = await api('POST', '/api/auth/register', { body: { name: 'Dup', role: 'shop', contact: 'founder@test' } });
    check('تسجيل مكرر مرفوض 409', r.status === 409);

    r = await api('POST', '/api/auth/register', { body: { name: 'Prov', role: 'provider', contact: 'prov@test' } });
    check('مقدم خدمة بلا فئة صحيحة مرفوض 400', r.status === 400);

    r = await api('POST', '/api/auth/register', { body: { name: 'Creator A', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'a@test', price: 500 } });
    const creatorA = r.body.user, tokA = r.body.token;
    r = await api('POST', '/api/auth/register', { body: { name: 'Shop S', role: 'shop', city: 'Cairo', contact: 'shop@test' } });
    const shopTok = r.body.token;
    r = await api('POST', '/api/auth/register', { body: { name: 'Brand B', role: 'brand', city: 'Cairo', contact: 'brand@test' } });
    const brandTok = r.body.token;
    r = await api('POST', '/api/auth/register', { body: { name: 'Creator B', role: 'creator', niche: 'Food', city: 'Giza', contact: 'b@test', price: 100 } });
    const creatorB = r.body.user, tokB = r.body.token;
    r = await api('POST', '/api/auth/register', { body: { name: 'Creator C', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'c@test', price: 100 } });
    const creatorC = r.body.user, tokC = r.body.token;

    /* ===== التوثيق الآلي ===== */
    r = await api('POST', '/api/verify/request', { token: tokA });
    const codeA = r.body.code;
    r = await api('POST', '/api/verify/check', { token: tokA, body: { url: `${AUX}/bio?code=${encodeURIComponent(codeA)}&name=${encodeURIComponent('Creator A')}` } });
    check('توثيق ناجح: كود في بايو علني + تطابق اسم → قبول فوري', r.body.status === 'verified');

    r = await api('GET', '/api/directory');
    const dirA = r.body.items.find((u) => u.id === creatorA.id);
    check('أول موثّق بمدينة+مجال يحصل على «رائد المدينة»', !!dirA && dirA.pioneer === true && dirA.verified === true);

    r = await api('POST', '/api/verify/request', { token: tokC });
    r = await api('POST', '/api/verify/check', { token: tokC, body: { url: `${AUX}/plain` } });
    check('توثيق فاشل: صفحة بلا كود → رفض مسبب', r.body.status === 'rejected' && /كود الملكية/.test(r.body.reason || ''));

    r = await api('POST', '/api/verify/check', { token: tokC, body: { url: 'http://127.0.0.1:9/dead' } });
    check('صفحة لا تُقرأ → حالة «مراجعة استثنائية»', r.body.status === 'exceptional');

    r = await api('GET', '/api/owner/dashboard', { token: founderTok });
    check('طلب المراجعة الاستثنائية ظاهر في لوحة المالك', r.status === 200 && r.body.exceptional.some((u) => u.id === creatorC.id));

    /* ===== مشاهدات الملف ===== */
    await api('GET', `/api/talent/${creatorA.id}`, { token: shopTok });
    await api('GET', `/api/talent/${creatorA.id}`, { token: shopTok });
    await api('GET', `/api/talent/${creatorA.id}`, { token: tokA }); // مشاهدة النفس لا تُحسب
    r = await api('GET', '/api/my/stats', { token: tokA });
    check('مشاهدات الملف: مشاهدتان من آخر سُجلتا والنفس مستبعدة (views=2)', r.body.views === 2, `views=${r.body.views}`);

    /* ===== حجز كامل 500 ===== */
    r = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: creatorA.id, price: 500 } });
    const b1 = r.body.booking.id;

    r = await api('GET', `/api/bookings/${b1}/fee-info`, { token: shopTok });
    check('رقم العمولة مرفوض قبل اتفاق الطرفين 400', r.status === 400);
    r = await api('GET', `/api/bookings/${b1}/fee-info`, { token: tokA });
    check('رقم العمولة ممنوع على غير العميل الدافع 403', r.status === 403);

    await api('POST', `/api/bookings/${b1}/agree`, { token: shopTok });
    await api('POST', `/api/bookings/${b1}/agree`, { token: tokA });
    r = await api('GET', `/api/bookings/${b1}/fee-info`, { token: shopTok });
    check('خطوة العمولة: مبلغ 50 لعميل حجز 500 والرقم للعميل فقط', r.status === 200 && r.body.amount === 50 && r.body.phone === TEST_PHONE);

    r = await api('POST', `/api/bookings/${b1}/pay`, { token: shopTok, body: { kind: 'fee', ref: 'FEE-1' } });
    check('عمولة 50 تأكدت تلقائياً بالمرجع → awaiting_deposit', r.body.booking.status === 'awaiting_deposit' && r.body.booking.fee_status === 'confirmed');

    r = await api('POST', `/api/bookings/${b1}/pay`, { token: shopTok, body: { kind: 'deposit', ref: 'DEP-1' } });
    check('عربون 225 (نصف الصافي) → in_progress', r.body.booking.status === 'in_progress' && r.body.booking.deposit === 225);

    r = await api('POST', `/api/bookings/${b1}/proof`, { token: tokA, body: { url: `${AUX}/missing` } });
    check('إثبات تنفيذ برابط 404 مرفوض 400', r.status === 400);
    r = await api('POST', `/api/bookings/${b1}/proof`, { token: tokA, body: { url: `${AUX}/proof-ok` } });
    check('إثبات تنفيذ برابط حي (200) يُقبل ويُختم', r.body.booking.status === 'proof_submitted' && r.body.booking.proof_check === 'verified');

    r = await api('POST', `/api/bookings/${b1}/review`, { token: shopTok, body: { sentiment: 'positive', stars: 5 } });
    check('تقييم قبل اكتمال القبض مرفوض 400', r.status === 400);

    r = await api('POST', `/api/bookings/${b1}/confirm-receipt`, { token: shopTok });
    check('تأكيد استلام العميل → awaiting_rest', r.body.booking.status === 'awaiting_rest');

    r = await api('POST', `/api/bookings/${b1}/pay`, { token: shopTok, body: { kind: 'rest', ref: 'REST-1' } });
    check('دفع الباقي لا يكمل الحجز — يُحتجَز عند Deal أولاً (بانتظار تأكيد التحويلة)', r.body.booking.status !== 'completed' && r.body.booking.escrow_status === 'awaiting_confirmation', `escrow=${r.body.booking.escrow_status}`);
    const finOb1 = (await api('GET', '/api/owner/money', { token: founderTok })).body.items.find((o) => o.kind === 'booking_final' && o.booking_id === b1);
    check('التزام الدفعة الأخيرة مستلمه المالك (احتجاز) لا المقدم', !!finOb1 && finOb1.payee === 'owner', `payee=${finOb1 && finOb1.payee}`);
    await api('POST', `/api/owner/money/${finOb1.id}/confirm`, { token: founderTok, body: {} });
    const b1done = (await api('GET', `/api/bookings/${b1}`, { token: shopTok })).body.booking;
    const statsA = (await api('GET', '/api/my/stats', { token: tokA })).body;
    check('تأكيد المالك لتحويلة الباقي يحتجزها ويكمل الحجز «جاهز للإفراج»؛ صافي الصانع 450', b1done.status === 'completed' && b1done.escrow_status === 'ready_release' && statsA.earnings_total === 450, `status=${b1done.status} escrow=${b1done.escrow_status} earn=${statsA.earnings_total}`);

    r = await api('GET', `/api/talent/${creatorA.id}`, { token: shopTok });
    check('رابط الإثبات ظهر تلقائياً في معرض أعمال الصانع', Array.isArray(r.body.user.portfolio) && r.body.user.portfolio.includes(`${AUX}/proof-ok`));

    r = await api('POST', `/api/bookings/${b1}/review`, { token: shopTok, body: { sentiment: 'positive', stars: 5, comment: 'ممتاز' } });
    check('تقييم بعد اكتمال القبض يُسجل', r.status === 200 && r.body.ok === true);
    r = await api('POST', `/api/bookings/${b1}/review`, { token: shopTok, body: { sentiment: 'negative', stars: 1 } });
    check('تقييم ثانٍ لنفس الحجز مرفوض 409 (بلا تعديل)', r.status === 409);

    /* ===== نموذج باينانس: لا تأكيد تلقائي أبداً — سكوت ثم تحكيم ثم تأكيد العميل ===== */
    r = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: creatorA.id, price: 200 } });
    const b2 = r.body.booking.id;
    await api('POST', `/api/bookings/${b2}/agree`, { token: shopTok });
    await api('POST', `/api/bookings/${b2}/agree`, { token: tokA });
    await api('POST', `/api/bookings/${b2}/pay`, { token: shopTok, body: { kind: 'fee', ref: 'FEE-2' } });
    await api('POST', `/api/bookings/${b2}/pay`, { token: shopTok, body: { kind: 'deposit', ref: 'DEP-2' } });
    await api('POST', `/api/bookings/${b2}/proof`, { token: tokA, body: { url: `${AUX}/proof-ok` } });
    const pgc = new Client({ connectionString: DATABASE_URL });
    await pgc.connect();
    await pgc.query('UPDATE bookings SET proof_at=$1 WHERE id=$2', [Date.now() - 25 * 3600 * 1000, b2]);
    await pgc.end();
    r = await api('GET', '/api/bookings', { token: shopTok });
    const b2now = r.body.items.find((x) => x.id === b2);
    check('سكوت العميل ٢٥ ساعة بعد إثبات سليم: لا تأكيد تلقائي أبداً — بانتظار التأكيد بحالة «تم الدفع»', !!b2now && b2now.status === 'proof_submitted' && !b2now.receipt_auto && !b2now.receipt_confirmed_at && b2now.order_state === 'paid_awaiting_confirmation', `status=${b2now && b2now.status} os=${b2now && b2now.order_state}`);
    r = await api('POST', `/api/bookings/${b2}/appeal`, { token: tokA });
    check('طلب تحكيم الصانع بعد سكوت العميل ينجح', r.status === 200 && !!r.body.booking && !!r.body.booking.appeal, `status=${r.status}`);
    r = await api('GET', '/api/owner/appeals', { token: founderTok });
    check('طلب التحكيم يظهر فوراً في لوحة المالك', (r.body.items || []).some((a) => a.booking_id === b2));
    r = await api('GET', '/api/notifications', { token: shopTok });
    check('العميل يُنبَّه فوراً بطلب التحكيم', (r.body.items || []).some((n) => n.type === 'appeal' && ((n.text || '').includes('#' + b2) || (n.ref || '') === `booking:${b2}`)));
    r = await api('POST', `/api/bookings/${b2}/confirm-receipt`, { token: shopTok });
    check('تأكيد العميل أثناء تحكيم قائم يكمل المسار ويغلق التحكيم تلقائياً', r.status === 200 && r.body.booking.status === 'awaiting_rest' && r.body.booking.escrow_status === 'awaiting_transfer' && !r.body.booking.appeal, `status=${r.body.booking && r.body.booking.status}`);
    r = await api('GET', '/api/owner/appeals', { token: founderTok });
    check('التحكيم المغلق بتأكيد العميل يختفي من قائمة المالك', !(r.body.items || []).some((a) => a.booking_id === b2));

    /* ===== العقوبات التلقائية ===== */
    for (let i = 0; i < 5; i++) {
      const rb = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: creatorB.id, price: 100 } });
      const id = rb.body.booking.id;
      await api('POST', `/api/bookings/${id}/agree`, { token: shopTok });
      await api('POST', `/api/bookings/${id}/agree`, { token: tokB });
      await api('POST', `/api/bookings/${id}/pay`, { token: shopTok, body: { kind: 'fee', ref: `FB-${i}` } });
      await api('POST', `/api/bookings/${id}/pay`, { token: shopTok, body: { kind: 'deposit', ref: `DB-${i}` } });
      await api('POST', `/api/bookings/${id}/proof`, { token: tokB, body: { url: `${AUX}/proof-ok` } });
      await api('POST', `/api/bookings/${id}/confirm-receipt`, { token: shopTok });
      await api('POST', `/api/bookings/${id}/pay`, { token: shopTok, body: { kind: 'rest', ref: `RB-${i}` } });
      const fobI = (await api('GET', '/api/owner/money', { token: founderTok })).body.items.find((o) => o.kind === 'booking_final' && o.booking_id === id);
      if (fobI) await api('POST', `/api/owner/money/${fobI.id}/confirm`, { token: founderTok, body: {} });
      await api('POST', `/api/bookings/${id}/review`, { token: shopTok, body: { sentiment: 'negative', stars: 1 } });
    }
    r = await api('GET', '/api/owner/dashboard', { token: founderTok });
    const penB = r.body.penalized.find((u) => u.id === creatorB.id);
    check('5 تقييمات سلبية → تعليق + تجميد تلقائي', !!penB && penB.penalty_level === 'suspended' && (penB.frozen === 1 || penB.frozen === true));

    r = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: creatorB.id, price: 100 } });
    check('حجز جديد لحساب معلّق مرفوض 403', r.status === 403);

    await api('POST', `/api/owner/users/${creatorB.id}/penalty`, { token: founderTok, body: { level: 'none', frozen: false } });
    r = await api('GET', `/api/talent/${creatorB.id}`, { token: shopTok });
    check('المالك يستطيع فك التجميد ورفع العقوبة', r.body.user.frozen === false && r.body.user.penalty_level === 'none');

    /* ===== لوحة المالك ===== */
    r = await api('GET', '/api/owner/dashboard', { token: founderTok });
    check('إجمالي عمولات المالك من السجلات الفعلية = 120 (50+20+5×10)', r.body.commissions.total === 120, `total=${r.body.commissions.total}`);

    r = await api('GET', '/api/owner/dashboard', { token: tokA });
    check('لوحة المالك ممنوعة على غير المؤسس 403', r.status === 403);

    /* ===== رفض مرجع عمولة خاطئ ===== */
    r = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: creatorA.id, price: 100 } });
    const b4 = r.body.booking.id;
    await api('POST', `/api/bookings/${b4}/agree`, { token: shopTok });
    await api('POST', `/api/bookings/${b4}/agree`, { token: tokA });
    await api('POST', `/api/bookings/${b4}/pay`, { token: shopTok, body: { kind: 'fee', ref: 'FAKE-FEE' } });
    r = await api('POST', `/api/owner/bookings/${b4}/reject-fee`, { token: founderTok });
    const b4now = (await api('GET', `/api/bookings/${b4}`, { token: shopTok })).body.booking;
    check('رفض مرجع عمولة خاطئ داخل نافذة الـ24 ساعة → الحجز «نزاع»', r.status === 200 && b4now.status === 'disputed');

    /* ===== فرص ليك + الحملات ===== */
    await api('POST', '/api/requests', { token: shopTok, body: { title: 'إعلان محل', niche: 'Tech', city: 'Cairo', budget: 600 } });
    r = await api('POST', '/api/campaigns', { token: brandTok, body: { title: 'حملة براند', niche: 'Tech', city: 'Cairo', budget: 600 } });
    const campId = r.body.id;
    r = await api('GET', '/api/opportunities', { token: tokA });
    const oppReq = r.body.items.find((x) => x.kind === 'request');
    const oppCamp = r.body.items.find((x) => x.kind === 'campaign');
    check('فرص ليك: طلب محل + حملة بنفس المدينة/المجال → مطابقة 100% بأسباب',
      !!oppReq && !!oppCamp && oppReq.score === 100 && oppCamp.score === 100 &&
      oppReq.reasons.includes('نفس المدينة') && oppReq.reasons.includes('نفس المجال') && oppReq.reasons.includes('الميزانية مناسبة'));

    r = await api('POST', `/api/campaigns/${campId}/apply`, { token: tokA, body: { pitch: 'أقدر أنفذ' } });
    const apps = (await api('GET', `/api/campaigns/${campId}/applications`, { token: brandTok })).body.items;
    r = await api('POST', `/api/applications/${apps[0].id}/accept`, { token: brandTok });
    const campBooking = r.body.booking_id ? (await api('GET', `/api/bookings/${r.body.booking_id}`, { token: brandTok })).body.booking : null;
    check('قبول البراند لتقديم صانع ينشئ حجزاً عادياً تلقائياً', !!campBooking && campBooking.source === 'campaign');

    /* ===== طلب العميل كضيف (بدون تسجيل) ===== */
    const GUEST_PHONE = '01012345678';
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل ضيف', phone: GUEST_PHONE, city: 'Cairo', niche: 'Tech', budget: 600, details: 'محتاج فيديو إعلاني' } });
    const guestReqId = r.body.id, guestToken = r.body.token;
    check('طلب ضيف يُنشأ بلا أي حساب ويعيد رمز متابعة طويلاً ورابطاً', r.status === 200 && !!guestReqId && typeof guestToken === 'string' && guestToken.length >= 32 && r.body.follow === `/#/g/${guestToken}`);

    r = await api('POST', '/api/guest-requests', { body: { business_name: 'ضيف بلا هاتف', city: 'Cairo', niche: 'Tech', budget: 100, details: 'طلب بلا أي هاتف' } });
    check('طلب ضيف بلا أي هاتف يُنشأ بنجاح (حقل الهاتف أُزيل نهائياً من القناة)', r.status === 200 && !!r.body.token);
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'س', phone: '12345', city: 'Cairo', niche: 'Tech', budget: 100, details: 'س' } });
    check('حقل phone مرسل في الجسم يُتجاهل تماماً — لا يرفض الطلب ولا يُخزَّن', r.status === 200 && !!r.body.id);
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'س', niche: 'Tech', budget: 100, details: 'س' } });
    check('طلب ضيف بلا مدينة مرفوض 400', r.status === 400);

    r = await api('GET', '/api/requests');
    const pubGuest = r.body.items.find((x) => x.id === guestReqId);
    check('طلب الضيف ظاهر في خلاصة الطلبات العامة موسوماً «بدون حساب» وبلا رقمه',
      !!pubGuest && !!pubGuest.is_guest && !('guest_phone' in pubGuest) && !JSON.stringify(r.body).includes(GUEST_PHONE));

    r = await api('GET', '/api/directory');
    check('رقم الضيف غائب تماماً عن رد الدليل العام', !JSON.stringify(r.body).includes(GUEST_PHONE));

    r = await api('GET', '/api/requests', { token: tokA });
    const authGuest = r.body.items.find((x) => x.id === guestReqId);
    check('رقم هاتف الضيف لا يظهر للصانع المسجل أيضاً (التواصل داخل المنصة فقط)', !!authGuest && !('guest_phone' in authGuest) && !JSON.stringify(r.body).includes(GUEST_PHONE));

    r = await api('GET', '/api/opportunities', { token: tokA });
    const oppGuest = r.body.items.find((x) => x.kind === 'request' && x.is_guest && x.id === guestReqId);
    check('طلب الضيف داخل «فرص ليك» بمطابقة 100% (نفس المدينة/المجال) ورقمه غائب تماماً', !!oppGuest && oppGuest.score === 100 && !('guest_phone' in oppGuest) && !JSON.stringify(r.body).includes(GUEST_PHONE));

    r = await api('GET', '/api/guest/000000000000000000000000deadbeef');
    check('رمز متابعة خاطئ مرفوض 404', r.status === 404);

    r = await api('GET', `/api/guest/${guestToken}`);
    check('صفحة الرمز قبل التحويل: حالة «طلب» ورقم العمولة غير مسرّب',
      r.body.type === 'request' && r.body.request.id === guestReqId && !JSON.stringify(r.body).includes(TEST_PHONE));

    r = await api('POST', `/api/guest-requests/${guestReqId}/book`, { token: tokA, body: {} });
    const gb = r.body.booking;
    check('صانع مسجل يحوّل طلب الضيف لحجز رسمي (source=guest_request وعميله ضيف بلا حساب)',
      r.status === 200 && !!gb && gb.source === 'guest_request' && gb.client === null && gb.is_guest === true && gb.price === 600);
    check('رمز وصول الضيف لا يتسرب أبداً في رد الحجز', !!gb && !JSON.stringify(gb).includes(guestToken));
    const guestBookingId = gb && gb.id;

    r = await api('GET', '/api/requests');
    check('طلب الضيف المحوّل يخرج من خلاصة الطلبات المفتوحة', !r.body.items.some((x) => x.id === guestReqId));

    r = await api('GET', `/api/guest/${guestToken}`);
    check('صفحة الرمز بعد التحويل تعرض الحجز وحالة «اتفاق الطرفين»', r.body.type === 'booking' && r.body.booking.id === guestBookingId && r.body.booking.status === 'pending_agreement');

    r = await api('POST', `/api/guest/${guestToken}/agree`, { body: {} });
    check('الضيف يوافق من صفحة الرمز', r.status === 200 && r.body.booking.agreed_client === true);
    await api('POST', `/api/bookings/${guestBookingId}/agree`, { token: tokA });
    r = await api('GET', `/api/guest/${guestToken}`);
    check('بعد موافقة الطرفين الحجز عند خطوة العمولة', r.body.booking.status === 'awaiting_fee');

    r = await api('GET', `/api/guest/${guestToken}/fee-info`);
    check('رقم العمولة يظهر للضيف داخل خطوة العمولة فقط وبالمبلغ الصحيح (60 من 600)', r.status === 200 && r.body.amount === 60 && r.body.phone === TEST_PHONE);

    r = await api('POST', `/api/guest/${guestToken}/pay`, { body: { kind: 'fee', ref: 'GFEE-1' } });
    check('الضيف يسجل مرجع العمولة → awaiting_deposit', r.body.booking.status === 'awaiting_deposit' && r.body.booking.fee_status === 'confirmed');
    r = await api('POST', `/api/guest/${guestToken}/pay`, { body: { kind: 'deposit', ref: 'GDEP-1' } });
    check('الضيف يسجل العربون 270 → in_progress', r.body.booking.status === 'in_progress' && r.body.booking.deposit === 270);

    await api('POST', `/api/bookings/${guestBookingId}/proof`, { token: tokA, body: { url: `${AUX}/proof-ok` } });
    r = await api('GET', `/api/guest/${guestToken}`);
    check('إثبات المنفذ يظهر للضيف في صفحة الرمز', r.body.booking.status === 'proof_submitted' && r.body.booking.proof_url === `${AUX}/proof-ok`);

    r = await api('POST', `/api/guest/${guestToken}/confirm-receipt`, { body: {} });
    check('الضيف يؤكد الاستلام → awaiting_rest', r.body.booking.status === 'awaiting_rest');
    r = await api('POST', `/api/guest/${guestToken}/pay`, { body: { kind: 'rest', ref: 'GREST-1' } });
    check('الضيف يسجل الباقي 270 → لا اكتمال قبل تأكيد الاحتجاز عند Deal', r.body.booking.status !== 'completed' && r.body.booking.escrow_status === 'awaiting_confirmation', `escrow=${r.body.booking.escrow_status}`);
    const gob1 = (await api('GET', '/api/owner/money', { token: founderTok })).body.items.find((o) => o.kind === 'booking_final' && o.booking_id === guestBookingId);
    await api('POST', `/api/owner/money/${gob1.id}/confirm`, { token: founderTok, body: {} });
    r = await api('GET', `/api/guest/${guestToken}`);
    check('تأكيد المالك لاحتجاز باقي الضيف → اكتمل الحجز «جاهز للإفراج»', r.body.booking.status === 'completed' && r.body.booking.escrow_status === 'ready_release');

    r = await api('POST', `/api/guest/${guestToken}/review`, { body: { sentiment: 'positive', stars: 5, comment: 'شغل محترم' } });
    check('تقييم الضيف بعد اكتمال القبض يُسجل', r.status === 200 && r.body.ok === true);
    r = await api('POST', `/api/guest/${guestToken}/review`, { body: { sentiment: 'negative', stars: 1 } });
    check('تقييم ضيف ثانٍ لنفس الحجز مرفوض 409', r.status === 409);

    r = await api('GET', '/api/my/stats', { token: tokA });
    check('أرباح الصانع من حجز الضيف وصلته (450 حجز أول + 90 عربون حجز ثانٍ + 540 ضيف = 1080)', r.body.earnings_total === 1080, `earnings=${r.body.earnings_total}`);

    const FLOOD_DEV = 'flood-device-1';
    let floodOk = 0;
    for (let i = 0; i < 3; i++) {
      const fr = await api('POST', '/api/guest-requests', { body: { business_name: 'إغراق', device_id: FLOOD_DEV, city: 'Cairo', niche: 'Food', budget: 100, details: 'طلب' } });
      if (fr.status === 200) floodOk++;
    }
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'إغراق', device_id: FLOOD_DEV, city: 'Cairo', niche: 'Food', budget: 100, details: 'طلب' } });
    check('حد الإغراق بالبصمة: 3 طلبات مفتوحة لنفس بصمة الجهاز ثم الرفض 429', floodOk === 3 && r.status === 429, `ok=${floodOk} last=${r.status}`);
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'ضيف آخر', device_id: 'another-device-9', city: 'Cairo', niche: 'Food', budget: 100, details: 'طلب' } });
    check('بصمة جهاز مختلفة لا تتأثر بحدّ جهاز آخر (تُقبل فوراً)', r.status === 200 && !!r.body.id);

    /* ===== ثبات البيانات: الدليل مرتين = قيم متطابقة (إصلاح أ.7) ===== */
    const dirSnap = (items) => JSON.stringify(items.map((i) => [i.id, i.completion_rate, i.completed_deals, i.price, i.verified]));
    const dOne = (await api('GET', '/api/directory', { token: tokA })).body.items;
    const dTwo = (await api('GET', '/api/directory', { token: tokA })).body.items;
    check('استدعاء الدليل مرتين لنفس البيانات يعيد قيماً متطابقة تماماً (لا تذبذب في نسبة الإتمام)',
      dirSnap(dOne) === dirSnap(dTwo), `one=${dirSnap(dOne)} two=${dirSnap(dTwo)}`);

    /* ===== تحويل طلب الضيف: ذرّي + رفض التكرار (إصلاح أ.1) ===== */
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل تحويل', phone: '01055500001', city: 'Cairo', niche: 'Tech', budget: 800, details: 'إعلان' } });
    const convReqId = r.body.id;
    const booksBefore = (await api('GET', '/api/bookings', { token: tokA })).body.items.length;
    r = await api('POST', `/api/guest-requests/${convReqId}/book`, { token: tokA, body: {} });
    check('تحويل طلب ضيف ينشئ حجزاً واحداً بمبالغ صحيحة (800: عمولة 80 ودفعتان 360)',
      r.status === 200 && r.body.booking.price === 800 && r.body.booking.fee === 80 && r.body.booking.deposit === 360 && r.body.booking.rest === 360);
    const booksAfter = (await api('GET', '/api/bookings', { token: tokA })).body.items.length;
    check('الحجز الفعلي زاد بواحد فقط بعد التحويل', booksAfter === booksBefore + 1, `before=${booksBefore} after=${booksAfter}`);
    r = await api('POST', `/api/guest-requests/${convReqId}/book`, { token: tokA, body: {} });
    check('تحويل مكرر لنفس الطلب يُرفض بخطأ واضح 400', r.status === 400 && /اتحجز خلاص/.test(r.body.error || ''));
    const booksFinal = (await api('GET', '/api/bookings', { token: tokA })).body.items.length;
    check('التحويل المكرر لم ينشئ حجزاً إضافياً', booksFinal === booksAfter);

    /* ===== تعديل الملف الشخصي + الصورة (ج.1 + ج.2) ===== */
    r = await api('PATCH', '/api/me/profile', { token: tokB, body: { name: 'Creator B2', city: 'Alexandria', niche: 'Food', price: 150, followers: 9000, bio: 'نبذة تجريبية', phone: '01077788899' } });
    check('تعديل الملف يحفظ الاسم والمدينة والمجال والسعر والمتابعين والنبذة والهاتف',
      r.status === 200 && r.body.user.name === 'Creator B2' && r.body.user.city === 'Alexandria' && r.body.user.price === 150 &&
      r.body.user.followers === 9000 && r.body.user.bio === 'نبذة تجريبية' && r.body.user.phone === '01077788899');
    r = await api('PATCH', '/api/me/profile', { token: tokB, body: { phone: '123' } });
    check('تعديل الملف برقم هاتف غير مصري مرفوض 400', r.status === 400);
    r = await api('PATCH', '/api/me/profile', { token: tokB, body: { is_platform_founder: 1, verified: 1, frozen: 1 } });
    check('تعديل الملف لا يستطيع تفعيل شكل/امتيازات المؤسس بأي حقل',
      r.status === 200 && r.body.user.is_platform_founder === false && r.body.user.verified === false && r.body.user.frozen === false);
    const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';
    r = await api('PATCH', '/api/me/profile', { token: tokB, body: { avatar: TINY_JPEG } });
    check('رفع صورة شخصية JPEG صالحة يُحفظ ويظهر في الرد', r.status === 200 && typeof r.body.user.avatar === 'string' && r.body.user.avatar.startsWith('data:image/jpeg'));
    r = await api('GET', '/api/directory', { token: tokA });
    const dirB = r.body.items.find((u) => u.id === creatorB.id);
    check('الصورة الشخصية تظهر في بطاقة السوق', !!dirB && dirB.avatar === TINY_JPEG);
    r = await api('PATCH', '/api/me/profile', { token: tokB, body: { avatar: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' } });
    check('صورة بنوع غير مسموح مرفوضة 400', r.status === 400);
    r = await api('PATCH', '/api/me/profile', { token: tokB, body: { avatar: 'data:image/jpeg;base64,' + 'A'.repeat(400000) } });
    check('صورة أكبر من 200KB مرفوضة 400', r.status === 400);

    /* ===== نماذج الشورتس: حد أقصى 3 مضمّنة (ج.3) ===== */
    r = await api('POST', '/api/me/portfolio', { token: tokB, body: { url: 'https://www.youtube.com/shorts/abcDEF123_-', title: 'شورت يوتيوب' } });
    check('إضافة شورت يوتيوب يستخرج رابط التضمين الرسمي',
      r.status === 200 && r.body.item.platform === 'youtube' && r.body.item.embed_url === 'https://www.youtube.com/embed/abcDEF123_-');
    await api('POST', '/api/me/portfolio', { token: tokB, body: { url: 'https://www.tiktok.com/@creator/video/7312345678901234567' } });
    r = await api('POST', '/api/me/portfolio', { token: tokB, body: { url: 'https://www.instagram.com/reel/C8xyzABC12-/' } });
    check('إضافة تيك توك وإنستجرام: 3 نماذج بروابط تضمين صحيحة',
      r.status === 200 && r.body.items.length === 3 &&
      r.body.items.some((s) => s.platform === 'tiktok' && s.embed_url === 'https://www.tiktok.com/embed/v2/7312345678901234567') &&
      r.body.items.some((s) => s.platform === 'instagram' && s.embed_url === 'https://www.instagram.com/reel/C8xyzABC12-/embed'));
    r = await api('POST', '/api/me/portfolio', { token: tokB, body: { url: 'https://www.facebook.com/reel/1234567890123' } });
    check('النموذج الرابع يُرفض برسالة حد أقصى واضحة', r.status === 400 && /الحد الأقصى/.test(r.body.error || ''));
    r = await api('POST', '/api/me/portfolio', { token: tokB, body: { url: 'https://example.com/watch/123' } });
    check('رابط فيديو غير مدعوم مرفوض 400', r.status === 400);
    r = await api('GET', `/api/talent/${creatorB.id}`, { token: shopTok });
    check('الملف العام يعرض الشورتس الثلاثة مضمّنة (لا روابط نصية فقط)',
      Array.isArray(r.body.shorts) && r.body.shorts.length === 3 && r.body.shorts.every((s) => s.embed_url.includes('embed')));
    const firstShortId = r.body.shorts[0].id;
    r = await api('DELETE', `/api/me/portfolio/${firstShortId}`, { token: tokB });
    check('حذف نموذج شورتس يعمل', r.status === 200 && r.body.items.length === 2);

    /* ===== تسجيل واحد فقط: تطبيع التواصل (د) ===== */
    r = await api('POST', '/api/auth/register', { body: { name: 'Norm User', role: 'creator', niche: 'Tech', city: 'Cairo', contact: '+201055566677' } });
    check('تسجيل برقم بصيغة +20 ينجح', r.status === 200 && !!r.body.token);
    r = await api('POST', '/api/auth/register', { body: { name: 'Norm Dup', role: 'creator', contact: '01055566677' } });
    check('تسجيل ثانٍ بنفس الرقم بالصيغة المحلية يُرفض 409 (حساب واحد فقط)', r.status === 409);
    r = await api('POST', '/api/auth/register', { body: { name: 'Norm Dup2', role: 'creator', contact: '00201055566677' } });
    check('تسجيل ثانٍ بنفس الرقم بصيغة 0020 يُرفض 409 أيضاً', r.status === 409);
    r = await api('POST', '/api/auth/login', { body: { contact: '01055566677' } });
    check('الدخول بالصيغة المحلية لنفس الرقم المسجل بـ+20 ينجح', r.status === 200 && !!r.body.token);

    /* ===== حساب المؤسس: ظهور مقيد + عرض فقط + بلا سعر/تواصل/شورتس ===== */
    r = await api('GET', '/api/directory');
    check('الزائر العام لا يرى المؤسس في الدليل إطلاقاً', !r.body.items.some((u) => u.id === founder.id));
    r = await api('GET', '/api/directory', { token: shopTok });
    check('المحل المسجل لا يرى المؤسس في الدليل', !r.body.items.some((u) => u.id === founder.id));
    r = await api('GET', '/api/directory', { token: tokA });
    const dirFounder = r.body.items.find((u) => u.id === founder.id);
    check('الصانع المسجل يرى المؤسس في الدليل — وبلا سعر', !!dirFounder && dirFounder.price === null);
    r = await api('GET', `/api/talent/${founder.id}`);
    check('ملف المؤسس للزائر العام 404 (كأنه غير موجود)', r.status === 404);
    r = await api('GET', `/api/talent/${founder.id}`, { token: shopTok });
    check('ملف المؤسس للمحل المسجل 404 أيضاً', r.status === 404);
    r = await api('GET', `/api/talent/${founder.id}`, { token: tokA });
    check('ملف المؤسس للصانع: بلا سعر وبلا شورتس وبلا معرض وبلا أي وسيلة تواصل',
      r.status === 200 && r.body.user.price === null && Array.isArray(r.body.shorts) && r.body.shorts.length === 0 &&
      Array.isArray(r.body.user.portfolio) && r.body.user.portfolio.length === 0 &&
      !JSON.stringify(r.body).includes('founder@test'));
    r = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: founder.id, price: 100 } });
    check('أي حجز يكون فيه المؤسس هو المنفذ يُرفض 400 برسالة واضحة', r.status === 400 && /عرض فقط/.test(r.body.error || ''));
    r = await api('POST', '/api/me/portfolio', { token: founderTok, body: { url: 'https://www.youtube.com/shorts/abcDEF123_-' } });
    check('المؤسس نفسه لا يستطيع إضافة نماذج شورتس (عرض فقط)', r.status === 400);

    /* ===== الدعم بالرد التلقائي ===== */
    r = await api('GET', '/api/support/topics?lang=ar');
    check('مواضيع الدعم الجاهزة 15 على الأقل', r.status === 200 && r.body.items.length >= 15, `topics=${r.body.items && r.body.items.length}`);
    r = await api('POST', '/api/support/ask', { body: { q: 'ما هي عمولة Deal ولماذا تدفع أولاً؟', lang: 'ar' } });
    check('سؤال معروف عن العمولة يعيد إجابته الصحيحة بالعربية', r.status === 200 && r.body.fallback === false && /10%/.test(r.body.answer || ''));
    r = await api('POST', '/api/support/ask', { body: { q: 'How does the Deal Guarantee work?', lang: 'en' } });
    check('سؤال معروف بالإنجليزية يعيد إجابة إنجليزية', r.status === 200 && r.body.fallback === false && /guarantee/i.test(r.body.answer || ''));
    r = await api('POST', '/api/support/ask', { body: { q: 'ما أخبار الطقس على كوكب المريخ اليوم؟', lang: 'ar', contact: '01000000000' } });
    check('سؤال خارج القاعدة يعيد رد الاحتياط مع أقرب المواضيع', r.status === 200 && r.body.fallback === true && Array.isArray(r.body.topics) && r.body.topics.length >= 1);
    r = await api('GET', '/api/owner/support-messages', { token: founderTok });
    check('السؤال المجهول حُفظ ويظهر في قسم رسائل الدعم بلوحة المالك مع عدّاد غير المقروء',
      r.status === 200 && r.body.unread >= 1 && r.body.items.some((m) => /المريخ/.test(m.question)));
    r = await api('GET', '/api/owner/support-messages', { token: tokA });
    check('رسائل الدعم ممنوعة على غير المالك 403', r.status === 403);

    /* ===== التنبيهات ===== */
    r = await api('GET', '/api/notifications', { token: tokA });
    check('التنبيهات وصلت للصانع عبر الأحداث (≥8 وغير مقروءة موجودة)',
      r.body.items.length >= 8 && r.body.unread >= 1 && r.body.items.some((n) => n.type === 'booking_new'),
      `count=${r.body.items.length} unread=${r.body.unread}`);

    /* ===== المتابعة (Follow) ===== */
    r = await api('POST', `/api/users/${creatorC.id}/follow`, { body: {} });
    check('متابعة بلا تسجيل دخول مرفوضة 401', r.status === 401);

    r = await api('POST', `/api/users/${creatorC.id}/follow`, { token: tokA, body: {} });
    check('صانع يتابع صانعاً آخر بنجاح وعدّاد متابِعيه يصبح 1', r.status === 200 && r.body.is_following === true && r.body.followers_count === 1);
    r = await api('POST', `/api/users/${creatorC.id}/follow`, { token: tokA, body: {} });
    check('تكرار المتابعة idempotent: لا خطأ ولا مضاعفة للعدّاد', r.status === 200 && r.body.followers_count === 1);
    r = await api('GET', '/api/directory', { token: tokA });
    const dirCforA = r.body.items.find((u) => u.id === creatorC.id);
    check('الدليل للمتابِع يعرض followers_count=1 وis_following=true', !!dirCforA && dirCforA.followers_count === 1 && dirCforA.is_following === true);
    r = await api('GET', '/api/directory', { token: tokB });
    const dirCforB = r.body.items.find((u) => u.id === creatorC.id);
    check('الدليل لغير المتابِع يعرض is_following=false', !!dirCforB && dirCforB.is_following === false);
    r = await api('GET', '/api/notifications', { token: tokC });
    check('إشعار «بدأ متابعتك» وصل للمتابَع', r.body.items.some((n) => n.type === 'follow'));
    r = await api('POST', `/api/users/${creatorA.id}/follow`, { token: tokA, body: {} });
    check('متابعة النفس مرفوضة 400', r.status === 400);
    r = await api('GET', '/api/me/social', { token: tokC });
    check('الملخص الاجتماعي للمتابَع: متابِع واحد وبيانات آمنة فقط (بلا أي تواصل)',
      r.status === 200 && r.body.followers_count === 1 && r.body.followers.length === 1 && r.body.followers[0].id === creatorA.id &&
      !('contact' in r.body.followers[0]) && !('phone' in r.body.followers[0]) && !JSON.stringify(r.body).includes('a@test'));
    r = await api('GET', '/api/me/social', { token: tokA });
    check('الملخص الاجتماعي للمتابِع: أتابع واحداً هو الصانع نفسه', r.body.following_count === 1 && r.body.following[0].id === creatorC.id);

    /* متابعة المؤسس: الاستثناء الوحيد المسموح — وبقية حظره كما هو */
    r = await api('POST', `/api/users/${founder.id}/follow`, { token: tokA, body: {} });
    check('متابعة حساب المؤسس تنجح', r.status === 200 && r.body.followers_count === 1);
    r = await api('GET', '/api/directory', { token: tokA });
    const dirF2 = r.body.items.find((u) => u.id === founder.id);
    check('بطاقة المؤسس بعد المتابعة: عدّاد متابِعين ظاهر وبلا سعر وبلا أي تواصل',
      !!dirF2 && dirF2.followers_count === 1 && dirF2.price === null && !JSON.stringify(dirF2).includes('founder@test'));
    r = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: founder.id, price: 100 } });
    check('الحجز على المؤسس يبقى مرفوضاً 400 رغم إتاحة متابعته', r.status === 400);
    r = await api('GET', '/api/me/social', { token: founderTok });
    check('عدّاد متابِعي المؤسس ظاهر في ملخصه الاجتماعي', r.body.followers_count === 1);

    /* إلغاء المتابعة */
    r = await api('DELETE', `/api/users/${creatorC.id}/unfollow`, { token: tokA });
    check('إلغاء المتابعة بـ DELETE يعمل والعدّاد يعود صفراً', r.status === 200 && r.body.is_following === false && r.body.followers_count === 0);
    r = await api('POST', `/api/users/${creatorC.id}/unfollow`, { token: tokA, body: {} });
    check('إلغاء متابعة غير موجودة بـ POST آمن ولا يخطئ', r.status === 200 && r.body.followers_count === 0);

    /* متابعة حساب مجمّد مرفوضة */
    r = await api('POST', '/api/auth/register', { body: { name: 'Frozen F', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'frozen@test', price: 100 } });
    const frozenUser = r.body.user;
    await api('POST', `/api/owner/users/${frozenUser.id}/penalty`, { token: founderTok, body: { level: 'none', frozen: true } });
    r = await api('POST', `/api/users/${frozenUser.id}/follow`, { token: tokA, body: {} });
    check('متابعة حساب مجمّد مرفوضة بوضوح 400', r.status === 400);
    await api('POST', `/api/owner/users/${frozenUser.id}/penalty`, { token: founderTok, body: { level: 'none', frozen: false } });

    /* ===== المراسلة الداخلية 1:1 ===== */
    /* تعديل موثّق (جولة الملف الاجتماعي): المراسلة عضو↔عضو صارت مقصورة على
       الأصدقاء المقبولين خادمياً (403 لغير صديق)، فتُبنى صداقة A↔C هنا أولاً
       كي تبقى كل فحوصات هذا القسم الأصلية كما هي حرفياً؛ فحوصات البوابة
       نفسها (الرفض 403 قبل الصداقة وبعد إلغائها) في قسم الجولة بالأسفل. */
    r = await api('POST', `/api/users/${creatorC.id}/friend-request`, { token: tokA, body: {} });
    check('إعداد قسم المراسلة: طلب صداقة A إلى C يُقبل لاحقاً', r.status === 200 && r.body.friend_state === 'pending_out');
    r = await api('POST', `/api/users/${creatorA.id}/friend-accept`, { token: tokC, body: {} });
    check('إعداد قسم المراسلة: C يقبل صداقة A (المراسلة بينهما مشروعة الآن)', r.status === 200 && r.body.friend_state === 'friends');
    r = await api('POST', `/api/messages/${creatorC.id}`, { body: { body: 'أهلاً' } });
    check('مراسلة بلا تسجيل دخول مرفوضة 401', r.status === 401);
    r = await api('POST', `/api/messages/${creatorC.id}`, { token: tokA, body: { body: 'أهلاً، عندي استفسار عن شغل' } });
    check('إرسال رسالة داخلية ينجح', r.status === 200 && r.body.ok === true);
    r = await api('GET', '/api/messages', { token: tokC });
    const convA = r.body.items.find((c) => c.user.id === creatorA.id);
    check('قائمة محادثات المستلم: محادثة واحدة، غير مقروءة 1، آخر رسالة صحيحة، وبلا تواصل أي طرف',
      r.body.items.length === 1 && r.body.unread_total === 1 && !!convA && convA.unread === 1 && /استفسار/.test(convA.last.body) &&
      !JSON.stringify(r.body).includes('a@test') && !('contact' in convA.user) && !('phone' in convA.user));
    r = await api('GET', `/api/messages/${creatorA.id}`, { token: tokC });
    check('فتح المحادثة يعرض الرسالة من منظور المستلم', r.status === 200 && r.body.items.length === 1 && r.body.items[0].mine === false);
    r = await api('GET', '/api/messages', { token: tokC });
    check('بعد فتح المحادثة عدّاد غير المقروء يصبح صفراً', r.body.unread_total === 0);
    r = await api('POST', `/api/messages/${creatorA.id}`, { token: tokC, body: { body: 'أهلاً بيك، اتفضل' } });
    check('الرد داخل نفس المحادثة ينجح', r.status === 200);
    r = await api('GET', `/api/messages/${creatorC.id}`, { token: tokA });
    check('الطرفان يريان الخيط كاملاً (رسالتان)', r.body.items.length === 2);
    r = await api('GET', '/api/notifications', { token: tokC });
    check('إشعار «رسالة جديدة» وصل للمستلم', r.body.items.some((n) => n.type === 'message'));
    r = await api('POST', `/api/messages/${founder.id}`, { token: tokA, body: { body: 'أهلاً' } });
    check('رسالة إلى المؤسس مرفوضة 400 (خارج المراسلة تماماً)', r.status === 400);
    r = await api('POST', `/api/messages/${creatorA.id}`, { token: founderTok, body: { body: 'أهلاً' } });
    check('رسالة صادرة من المؤسس عبر هذا المسار مرفوضة 400 أيضاً', r.status === 400);
    r = await api('POST', `/api/messages/${creatorA.id}`, { token: tokA, body: { body: 'لنفسي' } });
    check('مراسلة النفس مرفوضة 400', r.status === 400);
    r = await api('POST', `/api/messages/${creatorC.id}`, { token: tokA, body: { body: '   ' } });
    check('رسالة فارغة مرفوضة 400', r.status === 400);
    r = await api('POST', `/api/messages/${creatorC.id}`, { token: tokA, body: { body: 'س'.repeat(1001) } });
    check('رسالة أطول من 1000 حرف مرفوضة 400', r.status === 400);
    await api('POST', `/api/owner/users/${frozenUser.id}/penalty`, { token: founderTok, body: { level: 'none', frozen: true } });
    r = await api('POST', `/api/messages/${frozenUser.id}`, { token: tokA, body: { body: 'أهلاً' } });
    check('مراسلة حساب مجمّد مرفوضة 400', r.status === 400);
    await api('POST', `/api/owner/users/${frozenUser.id}/penalty`, { token: founderTok, body: { level: 'none', frozen: false } });

    /* ===== روابط الملفات القابلة للمشاركة + الإحالات الموثقة + شريط «كله في مكان واحد» ===== */
    r = await api('GET', `/api/talent/${creatorB.id}`);
    check('رابط ملف صانع عادي يفتح لزائر عام مع نماذج شورتسه المضمّنة (صفحة #/u/<id>)',
      r.status === 200 && r.body.user.id === creatorB.id && Array.isArray(r.body.shorts) && r.body.shorts.length === 2 && r.body.shorts.every((s) => s.embed_url.includes('embed')));
    r = await api('GET', `/api/talent/${founder.id}`);
    check('رابط ملف المؤسس لزائر لا يسرّب أي بيان (404 كأنه غير موجود)', r.status === 404 && !JSON.stringify(r.body).includes('founder@test'));

    r = await api('POST', '/api/auth/register', { body: { name: 'Ref One', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'ref@test', price: 100 } });
    const refUser = r.body.user, refTok = r.body.token;

    r = await api('POST', '/api/auth/register', { body: { name: 'No Ref', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'noref@test', ref: 999999 } });
    check('تسجيل برمز إحالة غير موجود ينجح ولا يُنسب لأحد', r.status === 200);
    r = await api('GET', '/api/me/referrals', { token: refTok });
    check('قائمة دعوات المُحيل فارغة قبل أي إحالة (إجمالي وموثقة صفر)', r.body.total === 0 && r.body.verified_count === 0);

    r = await api('POST', '/api/auth/register', { body: { name: 'Ref One Clone', role: 'creator', contact: 'REF@test', ref: refUser.id } });
    check('محاولة إحالة ذاتية بنفس التواصل المطبّع مرفوضة (409 تكرار) ولا تُنشئ إحالة', r.status === 409);
    r = await api('GET', '/api/me/referrals', { token: refTok });
    check('بعد محاولة الإحالة الذاتية: لا إحالات مسجلة للمُحيل', r.body.total === 0);

    const refdToks = [];
    for (let i = 1; i <= 5; i++) {
      const rr = await api('POST', '/api/auth/register', { body: { name: `Ref Junior ${i}`, role: 'creator', niche: 'Tech', city: 'Cairo', contact: `rj${i}@test`, price: 100, ref: refUser.id } });
      refdToks.push(rr.body.token);
    }
    r = await api('GET', '/api/me/referrals', { token: refTok });
    check('٥ تسجيلات من رابط المُحيل تُنسب إليه (إجمالي 5) وبلا أي وسيلة تواصل في الرد',
      r.body.total === 5 && r.body.items.length === 5 && !JSON.stringify(r.body).includes('@test') &&
      !('contact' in r.body.items[0]) && !('phone' in r.body.items[0]));
    check('غير الموثّق لا يُحتسب: العدّاد الموثق صفر وكل القائمة «بانتظار التوثيق»',
      r.body.verified_count === 0 && r.body.items.every((x) => x.verified === false));
    r = await api('GET', '/api/notifications', { token: refTok });
    check('إشعار «سجّل من رابطك» وصل للمُحيل عند تسجيل الإحالة', r.body.items.some((n) => n.type === 'referral'));

    async function verifyUser(tok, name) {
      const rq = await api('POST', '/api/verify/request', { token: tok });
      return api('POST', '/api/verify/check', { token: tok, body: { url: `${AUX}/bio?code=${encodeURIComponent(rq.body.code)}&name=${encodeURIComponent(name)}` } });
    }
    await verifyUser(refdToks[0], 'Ref Junior 1');
    r = await api('GET', '/api/me/referrals', { token: refTok });
    check('بعد توثيق أول مسجَّل: إحالة موثقة واحدة تُحتسب', r.body.verified_count === 1);
    r = await api('GET', '/api/notifications', { token: refTok });
    check('إشعار «توثّق صانع سجّل من رابطك» وصل للمُحيل لحظة التوثيق', r.body.items.some((n) => n.type === 'referral_verified'));

    await verifyUser(refdToks[1], 'Ref Junior 2');
    await verifyUser(refdToks[2], 'Ref Junior 3');
    r = await api('GET', '/api/me', { token: refTok });
    check('عند ٣ إحالات موثقة يُفعَّل «الظهور المميز» للمُحيل', r.body.user.featured === true);
    r = await api('GET', '/api/directory', { token: tokA });
    const idxFeat = r.body.items.findIndex((x) => x.id === refUser.id);
    const idxC = r.body.items.findIndex((x) => x.id === creatorC.id);
    const dirRef = r.body.items.find((x) => x.id === refUser.id);
    check('المميز موسوم في الدليل ويتقدّم على غير مميز بنفس بقية المعايير',
      !!dirRef && dirRef.featured === true && idxFeat >= 0 && idxC >= 0 && idxFeat < idxC, `feat=${idxFeat} c=${idxC}`);

    await verifyUser(refdToks[3], 'Ref Junior 4');
    await verifyUser(refdToks[4], 'Ref Junior 5');
    r = await api('GET', '/api/me/referrals', { token: refTok });
    check('عند ٥ إحالات موثقة: العدّاد 5 وهدف السفير 5', r.body.verified_count === 5 && r.body.ambassador_target === 5);
    r = await api('GET', `/api/talent/${refUser.id}`, { token: tokA });
    const amb = (r.body.badges || []).find((b) => b.key === 'ambassador');
    check('شارة «سفير Deal» تُكتسب عبر محرك الشارات القائم عند ٥ إحالات موثقة', !!amb && amb.earned === true);

    r = await api('POST', '/api/auth/register', { body: { name: 'Via Founder', role: 'creator', niche: 'Food', city: 'Giza', contact: 'viafounder@test', ref: founder.id } });
    check('التسجيل من رابط المؤسس ينجح (المؤسس مُحيل مشروع)', r.status === 200);
    r = await api('GET', '/api/me/referrals', { token: founderTok });
    check('إحالة المؤسس ظاهرة في قائمة دعواته', r.body.total >= 1 && r.body.items.some((x) => x.name === 'Via Founder'));

    await api('POST', `/api/messages/${creatorA.id}`, { token: tokC, body: { body: 'رسالة فحص الملخص' } });
    const ovA = (await api('GET', '/api/me/overview', { token: tokA })).body;
    const socA = (await api('GET', '/api/me/social', { token: tokA })).body;
    check('شريط الملخص: رسائل غير مقروءة = 1 بعد رسالة جديدة', ovA.unread_messages === 1, `unread=${ovA.unread_messages}`);
    check('شريط الملخص: المتابِعون يطابقون الملخص الاجتماعي + حجوزات جارية وفرص موجبة',
      ovA.followers === socA.followers_count && ovA.active_bookings >= 1 && ovA.opportunities >= 1, JSON.stringify(ovA));
    const ovRef = (await api('GET', '/api/me/overview', { token: refTok })).body;
    check('شريط ملخص المُحيل: إحالات موثقة = 5 مطابقة لقائمة دعواته', ovRef.verified_referrals === 5);
    r = await api('GET', '/api/me/overview');
    check('شريط الملخص بلا تسجيل دخول مرفوض 401', r.status === 401);

    /* ===== إخفاء مدينة المؤسس عن العامة (طلب المالك الصريح) ===== */
    r = await api('GET', '/api/directory', { token: tokA });
    const dirFounder2 = r.body.items.find((u) => u.id === founder.id);
    check('مدينة المؤسس محذوفة من بطاقته في الدليل (لا حقل city إطلاقاً)', !!dirFounder2 && !('city' in dirFounder2));
    r = await api('GET', `/api/talent/${founder.id}`, { token: tokA });
    check('مدينة المؤسس محذوفة من ملفه العام للصناع أيضاً', r.status === 200 && !('city' in r.body.user));
    r = await api('GET', `/api/talent/${creatorA.id}`, { token: tokB });
    check('مدن الصناع العاديين ما زالت ظاهرة في ملفاتهم كما هي', r.status === 200 && r.body.user.city === 'Cairo');
    r = await api('GET', '/api/me', { token: founderTok });
    check('المؤسس وحده يرى مدينته في /api/me (للوحته وتعديل ملفه)', r.status === 200 && r.body.user.city === 'Cairo');
    r = await api('GET', '/api/directory?city=Cairo', { token: tokA });
    check('فلتر المدينة لا يكشف المؤسس (مدينته غير قابلة للمطابقة) ويطابق الصناع العاديين',
      !r.body.items.some((u) => u.id === founder.id) && r.body.items.some((u) => u.id === creatorA.id));
    r = await api('GET', '/api/me/social', { token: tokA });
    const fInFollowing = r.body.following.find((x) => x.id === founder.id);
    check('ملخص المؤسس في قوائم المتابعة بلا مدينة إطلاقاً', !!fInFollowing && !('city' in fInFollowing));
    r = await api('GET', '/api/messages', { token: tokC });
    const convA2 = r.body.items.find((c) => c.user.id === creatorA.id);
    check('ملخص صانع عادي في قائمة المحادثات يحتفظ بمدينته', !!convA2 && convA2.user.city === 'Cairo');

    /* ===== تقدّم الشارات: مستويات الصانع نحو كل شارة (من نفس سجلات المحرك) ===== */
    r = await api('GET', '/api/me/badges-progress');
    check('تقدم الشارات بلا تسجيل دخول مرفوض 401', r.status === 401);
    r = await api('GET', '/api/me/badges-progress', { token: refTok });
    const bpRef = Object.fromEntries(r.body.items.map((b) => [b.key, b]));
    const refsNow = (await api('GET', '/api/me/referrals', { token: refTok })).body;
    check('تقدم الشارات يعيد الشارات الست القائمة في محرك الشارات',
      r.status === 200 && r.body.items.length === 6 &&
      ['perfect', 'top_rated', 'fast', 'rising', 'ambassador', 'veteran'].every((k) => !!bpRef[k]));
    check('سفير Deal في تقدم الشارات يطابق عدّاد دعواتي الموثق (5/5 ومحصّلة 100%)',
      bpRef.ambassador.current === refsNow.verified_count && bpRef.ambassador.target === 5 &&
      bpRef.ambassador.earned === true && bpRef.ambassador.pct === 100);
    const statsA2 = (await api('GET', '/api/my/stats', { token: tokA })).body;
    const bpA = Object.fromEntries((await api('GET', '/api/me/badges-progress', { token: tokA })).body.items.map((b) => [b.key, b]));
    check('تقدم «صانع صاعد» و«إتمام مثالي» يطابق صفقات الصانع المكتملة ونسبة إتمامه من سجلاته',
      bpA.rising.current === Math.min(statsA2.record.completed_deals, 5) &&
      bpA.perfect.current === Math.min(statsA2.record.completed_deals, 10) &&
      bpA.perfect.detail.completion_rate === statsA2.record.completion_rate);
    const talentA = (await api('GET', `/api/talent/${creatorA.id}`, { token: tokB })).body;
    const engineEarned = Object.fromEntries(talentA.badges.map((b) => [b.key, b.earned]));
    check('أعلام التحصيل في تقدم الشارات تطابق محرك الشارات لكل شارة (لا قواعد موازية)',
      Object.keys(engineEarned).every((k) => !!bpA[k] && bpA[k].earned === engineEarned[k]));
    check('نسب التقدم محصورة بين 0 و100 والباقي = الهدف − الحالي لكل الشارات',
      Object.values(bpA).every((b) => b.pct >= 0 && b.pct <= 100 && b.remaining === Math.max(0, b.target - b.current)) &&
      Object.values(bpRef).every((b) => b.pct >= 0 && b.pct <= 100));

    /* ===== نموذج وصول الضيوف: تصفح مفتوح + طلب موجّه + تصنيف موحّد =====
       (TESTING-BOLD-REDESIGN.md — بنود مستقلة: وصول الضيف، والخدمات الشاملة) */
    // --- التصنيف الموحّد من الخادم ---
    r = await api('GET', '/api/taxonomy');
    check('التصنيف الموحّد من الخادم: مجالات شاملة (≥15) وخدمات شاملة (≥10) بمفاتيح متوقعة',
      r.status === 200 && Array.isArray(r.body.niches) && r.body.niches.length >= 15
      && r.body.niches.includes('كوميديا') && r.body.niches.includes('سفر') && r.body.niches.includes('عام')
      && Array.isArray(r.body.services) && r.body.services.length >= 10
      && r.body.services.some((s) => s.key === 'editing') && r.body.services.some((s) => s.key === 'voiceover')
      && r.body.services.some((s) => s.key === 'dev') && r.body.services.some((s) => s.key === 'ads'));

    // --- مقدمو خدمة: من القائمة + «أخرى» حرة ---
    r = await api('POST', '/api/auth/register', { body: { name: 'Editor Pro', role: 'provider', provider_category: 'editing', city: 'Cairo', contact: 'prov1@test', price: 300 } });
    const prov1 = r.body.user, prov1Tok = r.body.token;
    check('تسجيل مقدم خدمة بخدمة من القائمة الشاملة (مونتاج) ينجح وتظهر في ملفه العام',
      r.status === 200 && !!prov1 && prov1.role === 'provider' && prov1.provider_category === 'editing');
    r = await api('POST', '/api/auth/register', { body: { name: 'Drone Shooter', role: 'provider', provider_category: 'other', provider_custom: 'تصوير منتجات بالدرون', city: 'Giza', contact: 'prov2@test', price: 800 } });
    const prov2 = r.body.user, prov2Tok = r.body.token;
    check('تسجيل مقدم خدمة بخدمة حرة «أخرى» ينجح ونصّها يظهر كما كتبه في ملفه',
      r.status === 200 && !!prov2 && prov2.provider_category === 'other' && prov2.provider_custom === 'تصوير منتجات بالدرون');
    r = await api('POST', '/api/auth/register', { body: { name: 'No Text', role: 'provider', provider_category: 'other', contact: 'prov3@test' } });
    check('خدمة «أخرى» بلا نص حر مرفوضة 400', r.status === 400);
    r = await api('POST', '/api/auth/register', { body: { name: 'Bad Svc', role: 'provider', provider_category: 'nope', contact: 'prov4@test' } });
    check('خدمة خارج القائمة الموحّدة مرفوضة 400', r.status === 400);

    // --- تصفح الزائر المفتوح: قائمة كاملة بلا تواصل وبلا مؤسس ---
    r = await api('GET', '/api/directory');
    const guestDir = r.body.items || [];
    check('زائر يرى الدليل: الصناع ومقدمو الخدمات موجودون والمؤسس غائب تماماً',
      guestDir.some((u) => u.id === creatorA.id) && guestDir.some((u) => u.id === prov1.id) && guestDir.some((u) => u.id === prov2.id)
      && !guestDir.some((u) => u.is_platform_founder));
    check('رد الدليل للزائر بلا أي حقل تواصل إطلاقاً (لا contact ولا phone ولا إيميلات الأعضاء)',
      guestDir.every((u) => !('contact' in u) && !('phone' in u)) && !JSON.stringify(guestDir).includes('@test'));
    check('الخدمة الحرة «أخرى» ظاهرة في الدليل العام كما كتبها صاحبها',
      (guestDir.find((u) => u.id === prov2.id) || {}).provider_custom === 'تصوير منتجات بالدرون');
    r = await api('GET', `/api/talent/${prov1.id}`);
    check('زائر يفتح ملف مقدم خدمة كاملاً (سعر/مدينة/خدمة) وبلا أي تواصل',
      r.status === 200 && r.body.user.id === prov1.id && r.body.user.price === 300 && !('contact' in r.body.user) && !('phone' in r.body.user));
    r = await api('GET', `/api/talent/${founder.id}`);
    check('ملف المؤسس للزائر = 404 كأنه غير موجود (حكم المؤسس لم يُمسّ)', r.status === 404);

    // --- فلاتر الدليل الموحّدة: النوع + المجال/الخدمة ---
    r = await api('GET', '/api/directory?role=provider');
    check('فلتر النوع «مقدمو خدمات» يعيد المقدمين فقط وفيهم الجديدان',
      r.body.items.length >= 2 && r.body.items.every((u) => u.role === 'provider') && r.body.items.some((u) => u.id === prov1.id));
    r = await api('GET', '/api/directory?role=creator');
    check('فلتر النوع «صناع محتوى» يعيد الصناع فقط (لا مقدم خدمة بينهم)',
      r.body.items.length >= 1 && r.body.items.every((u) => u.role === 'creator'));
    r = await api('GET', '/api/directory?niche=editing');
    check('فلتر الخدمة بمفتاح القائمة (editing) يجد مقدم المونتاج',
      r.body.items.some((u) => u.id === prov1.id) && r.body.items.every((u) => u.role === 'provider'));
    r = await api('GET', `/api/directory?niche=${encodeURIComponent('تصوير منتجات بالدرون')}`);
    check('فلتر الخدمة بالنص الحر يجد صاحب خدمة «أخرى»', r.body.items.some((u) => u.id === prov2.id));

    // --- الطلب الموجّه: إنشاء + إخفاء + ظهور للمستهدف + إشعار + تحويل حصري ---
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'عميل موجّه', phone: '01077770001', city: 'Cairo', niche: 'Tech', budget: 700, details: 'عاوزك أنت بالذات', target_talent_id: creatorA.id } });
    const tReqId = r.body.id, tReqToken = r.body.token;
    check('طلب ضيف موجّه لصانع يُنشأ ويرجع رمز متابعة', r.status === 200 && !!tReqId && typeof tReqToken === 'string' && tReqToken.length >= 32);
    r = await api('GET', '/api/requests');
    check('الطلب الموجّه غائب عن قائمة الطلبات المفتوحة العامة (للزائر)', !r.body.items.some((x) => x.id === tReqId));
    r = await api('GET', '/api/requests', { token: shopTok });
    check('الطلب الموجّه غائب عن القائمة العامة حتى للمسجلين', !r.body.items.some((x) => x.id === tReqId));
    r = await api('GET', '/api/opportunities', { token: tokA });
    const oppTargeted = r.body.items.find((x) => x.kind === 'request' && x.id === tReqId);
    check('الطلب الموجّه ظاهر في «فرص ليك» للمستهدف وحده موسوماً targeted وبمطابقة كاملة',
      !!oppTargeted && oppTargeted.targeted === true && oppTargeted.score === 100);
    r = await api('GET', '/api/opportunities', { token: tokC });
    check('الطلب الموجّه لا يظهر في فرص أي صانع آخر', !r.body.items.some((x) => x.id === tReqId));
    r = await api('GET', '/api/notifications', { token: tokA });
    check('إشعار «طلب موجّه» وصل للمستهدف', (r.body.items || []).some((n) => n.type === 'guest_targeted'));
    r = await api('POST', `/api/guest-requests/${tReqId}/book`, { token: tokC, body: {} });
    check('تحويل الطلب الموجّه من غير مستهدفه مرفوض 400', r.status === 400);
    r = await api('POST', `/api/guest-requests/${tReqId}/book`, { token: tokA, body: {} });
    check('مستهدف الطلب يحوّله لحجز ضمان بنفس المسار القائم (source=guest_request)',
      r.status === 200 && !!r.body.booking && r.body.booking.source === 'guest_request' && r.body.booking.price === 700);
    r = await api('GET', `/api/guest/${tReqToken}`);
    check('صفحة رمز الضيف بعد تحويل الموجّه تعرض الحجز كالمعتاد', r.body.type === 'booking');

    // --- أهداف مرفوضة: المؤسس + غير الموجود + دور غير قابل للطلب ---
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'س', phone: '01077770002', city: 'Cairo', niche: 'Tech', budget: 100, details: 'س', target_talent_id: founder.id } });
    check('طلب موجّه لحساب المؤسس مرفوض 400 صراحة', r.status === 400 && /المؤسس/.test(r.body.error || ''));
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'س', phone: '01077770003', city: 'Cairo', niche: 'Tech', budget: 100, details: 'س', target_talent_id: 999999 } });
    check('طلب موجّه لمعرّف غير موجود مرفوض 400', r.status === 400);
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'س', phone: '01077770005', city: 'Cairo', niche: 'Tech', budget: 100, details: 'س', target_talent_id: (await api('GET', '/api/me', { token: shopTok })).body.user.id } });
    check('طلب موجّه لحساب محل (دور غير قابل للطلب) مرفوض 400', r.status === 400);

    // --- زائر يطلب مقدم خدمة موجّهاً: يصله ويحوّله هو ---
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'براند عميل', phone: '01077770004', city: 'Cairo', niche: 'مونتاج', budget: 900, details: 'مونتاج إعلان', target_talent_id: prov1.id } });
    const pReqId = r.body.id;
    check('زائر يطلب مقدم خدمة من غير تسجيل (موجّه) يُنشأ بنجاح', r.status === 200 && !!pReqId);
    r = await api('GET', '/api/opportunities', { token: prov1Tok });
    check('الطلب الموجّه ظاهر في فرص مقدم الخدمة المستهدف', r.body.items.some((x) => x.kind === 'request' && x.id === pReqId && x.targeted === true));
    r = await api('GET', '/api/opportunities', { token: prov2Tok });
    check('فرص مقدم خدمة آخر لا تحوي إلا ما وُجّه إليه (فارغة هنا)', !r.body.items.some((x) => x.id === pReqId));
    r = await api('POST', `/api/guest-requests/${pReqId}/book`, { token: prov1Tok, body: {} });
    check('مقدم الخدمة المستهدف يحوّل الطلب الموجّه لحجز ضمان', r.status === 200 && !!r.body.booking && r.body.booking.source === 'guest_request');

    /* ===== خدمة «إنتاج فيديوهات وإعلانات» (videoproduction): الأولى والأبرز ===== */
    r = await api('GET', '/api/taxonomy');
    check('خدمة إنتاج الفيديوهات والإعلانات موجودة في التصنيف أول القائمة ببياناتها الثنائية',
      r.status === 200 && Array.isArray(r.body.services) && r.body.services.length >= 12
      && r.body.services[0].key === 'videoproduction' && r.body.services[0].ar === 'إنتاج فيديوهات وإعلانات'
      && r.body.services[0].en === 'Video & ad production',
      `first=${JSON.stringify(r.body.services && r.body.services[0])}`);
    r = await api('POST', '/api/auth/register', { body: { name: 'Video Producer', role: 'provider', provider_category: 'videoproduction', city: 'Cairo', contact: 'videoprod@test', price: 900 } });
    const videoProv = r.body.user, videoProvTok = r.body.token;
    check('تسجيل مقدم خدمة بإنتاج الفيديوهات والإعلانات ينجح وتظهر خدمته في ملفه',
      r.status === 200 && !!videoProv && videoProv.role === 'provider' && videoProv.provider_category === 'videoproduction');
    r = await api('GET', '/api/directory');
    const dirVideo = (r.body.items || []).find((u) => u.id === videoProv.id);
    check('بطاقة مقدم إنتاج الفيديوهات في الدليل العام بخدمته وسعره وبلا أي تواصل للزائر',
      !!dirVideo && dirVideo.provider_category === 'videoproduction' && dirVideo.price === 900 && !('contact' in dirVideo) && !('phone' in dirVideo));
    r = await api('GET', `/api/talent/${videoProv.id}`);
    check('الملف العام لمقدم إنتاج الفيديوهات يعرض خدمته كاملة للزائر',
      r.status === 200 && r.body.user.id === videoProv.id && r.body.user.provider_category === 'videoproduction' && r.body.user.price === 900);
    r = await api('GET', '/api/directory?niche=videoproduction');
    check('فلتر السوق بخدمة إنتاج الفيديوهات يجد مقدمها فقط كمقدم خدمة',
      r.body.items.some((u) => u.id === videoProv.id) && r.body.items.every((u) => u.role === 'provider' && u.provider_category === 'videoproduction'),
      `items=${JSON.stringify((r.body.items || []).map((u) => u.id))}`);
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'عميل فيديو', phone: '01077770006', city: 'Cairo', niche: 'إنتاج فيديوهات وإعلانات', budget: 1200, details: 'محتاج إعلان فيديو كامل', target_talent_id: videoProv.id } });
    const vReqId = r.body.id;
    check('طلب ضيف موجّه لمقدم إنتاج الفيديوهات يُنشأ بنجاح', r.status === 200 && !!vReqId);
    r = await api('GET', '/api/opportunities', { token: videoProvTok });
    check('الطلب الموجّه ظاهر في فرص مقدم إنتاج الفيديوهات موسوماً targeted',
      r.body.items.some((x) => x.kind === 'request' && x.id === vReqId && x.targeted === true));
    r = await api('POST', `/api/guest-requests/${vReqId}/book`, { token: videoProvTok, body: {} });
    check('مقدم إنتاج الفيديوهات يحوّل الطلب الموجّه لحجز ضمان بنفس المسار',
      r.status === 200 && !!r.body.booking && r.body.booking.source === 'guest_request' && r.body.booking.price === 1200);

    /* ===== الدول العربية: تسجيل ودخول وهواتف وعملات وفلاتر وضيوف وتوثيق ودعم =====
       قرار المستخدم: الدول تُضاف الآن بلا بوابة انتظار، ومقاعد أول ١٠٠ مؤسس
       بالأسبقية من أي دولة — أساس الأسبقية هو ترتيب التسجيل العالمي نفسه
       (معرّفات المستخدمين التصاعدية ids)، فلا حجز مقاعد هنا. */
    // --- التصنيف: 19 دولة بقواعدها + منصات الروابط ---
    r = await api('GET', '/api/taxonomy');
    const taxCountries = (r.body && r.body.countries) || [];
    check('التصنيف يبث 19 دولة عربية: مصر أولاً (+20) والسعودية (+966 وSTC Pay) والأردن (CliQ) ومنصتا X وسناب شات',
      taxCountries.length === 19 && taxCountries[0].code === 'EG' && taxCountries[0].dial === '20'
      && taxCountries.some((c) => c.code === 'SA' && c.dial === '966' && c.currency === 'SAR' && /STC/.test(c.payAr))
      && taxCountries.some((c) => c.code === 'JO' && c.payAr === 'CliQ')
      && Array.isArray(r.body.link_platforms) && r.body.link_platforms.includes('x.com') && r.body.link_platforms.includes('snapchat.com'),
      `countries=${taxCountries.length}`);

    // --- تسجيل سعودي بالصيغة الدولية ---
    r = await api('POST', '/api/auth/register', { body: { name: 'Saudi Creator', role: 'creator', niche: 'Tech', city: 'Riyadh', country: 'SA', contact: '+966512345678', price: 150 } });
    const saudi = r.body.user, saudiTok = r.body.token;
    check('تسجيل سعودي برقم +966 ينجح: الدولة SA والعملة مشتقة SAR خادمياً',
      r.status === 200 && !!saudi && saudi.country === 'SA' && saudi.currency === 'SAR');
    r = await api('GET', '/api/me', { token: saudiTok });
    check('الرقم السعودي محفوظ بصيغته الدولية القانونية +966512345678',
      !!(r.body.user) && r.body.user.contact === '+966512345678', `contact=${r.body.user && r.body.user.contact}`);

    // --- منع التكرار عبر صيغ نفس الرقم داخل الدولة نفسها ---
    r = await api('POST', '/api/auth/register', { body: { name: 'Saudi Dup', role: 'creator', niche: 'Tech', city: 'Jeddah', country: 'SA', contact: '0512345678' } });
    check('نفس الرقم السعودي بالصيغة المحلية (0…) مرفوض كمكرر 409', r.status === 409);
    r = await api('POST', '/api/auth/register', { body: { name: 'Saudi Dup2', role: 'creator', niche: 'Tech', city: 'Jeddah', country: 'SA', contact: '00966512345678' } });
    check('نفس الرقم السعودي بصيغة 00 الدولية مرفوض كمكرر 409', r.status === 409);

    // --- تسجيل سعودي آخر محلياً يُحفظ دولياً + الدخول بأي صيغة ---
    r = await api('POST', '/api/auth/register', { body: { name: 'Saudi Local', role: 'provider', provider_category: 'editing', city: 'Dammam', country: 'SA', contact: '0551234567', price: 200 } });
    const saudi2 = r.body.user;
    check('تسجيل سعودي بالصيغة المحلية ينجح (دولة SA وعملة SAR)',
      r.status === 200 && !!saudi2 && saudi2.country === 'SA' && saudi2.currency === 'SAR');
    r = await api('POST', '/api/auth/login', { body: { contact: '0551234567' } });
    check('الدخول بالصيغة المحلية لرقم سُجّل دولياً ينجح', r.status === 200 && !!r.body.user && r.body.user.id === saudi2.id);
    r = await api('POST', '/api/auth/login', { body: { contact: '+966551234567' } });
    check('الدخول بالصيغة الدولية لنفس الحساب ينجح', r.status === 200 && !!r.body.user && r.body.user.id === saudi2.id);

    // --- رفض صريح: دولة غير مدعومة + رقم لا يطابق قاعدة دولته ---
    r = await api('POST', '/api/auth/register', { body: { name: 'Nowhere', role: 'creator', niche: 'Tech', city: 'X', country: 'XX', contact: 'testxx@test' } });
    check('دولة غير مدعومة مرفوضة 400', r.status === 400);
    r = await api('POST', '/api/auth/register', { body: { name: 'Mismatch', role: 'creator', niche: 'Tech', city: 'Riyadh', country: 'SA', contact: '01012345678' } });
    check('رقم مصري تحت دولة السعودية مرفوض 400 (قاعدة الدولة)', r.status === 400);
    r = await api('POST', '/api/auth/register', { body: { name: 'Bad SA', role: 'creator', niche: 'Tech', city: 'Riyadh', country: 'SA', contact: '12345' } });
    check('رقم سعودي قصير غير مطابق للقاعدة مرفوض 400', r.status === 400);

    // --- مصر كما هي دون كسر: افتراضي EG/EGP + صيغة محلية + منع تكرار +20 ---
    r = await api('POST', '/api/auth/register', { body: { name: 'Egypt Phone', role: 'creator', niche: 'Food', city: 'Cairo', contact: '01012345670', price: 100 } });
    const egPhone = r.body.user;
    check('تسجيل مصري برقم محلي بلا دولة صريحة: EG وEGP كما هو قائم',
      r.status === 200 && !!egPhone && egPhone.country === 'EG' && egPhone.currency === 'EGP');
    r = await api('POST', '/api/auth/register', { body: { name: 'Egypt Dup', role: 'creator', niche: 'Food', city: 'Cairo', contact: '+201012345670' } });
    check('تكرار الرقم المصري بصيغة +20 مرفوض 409 (السلوك القائم لم ينكسر)', r.status === 409);

    // --- عملة العرض ودولة الملف في ردود API ---
    r = await api('GET', `/api/talent/${saudi.id}`);
    check('ملف السعودي العام: الدولة SA والسعر بعملته SAR في الرد',
      r.status === 200 && r.body.user.country === 'SA' && r.body.user.currency === 'SAR' && r.body.user.price === 150);

    // --- فلتر الدولة خادمياً + حماية دولة المؤسس ---
    r = await api('GET', '/api/directory?country=SA');
    check('فلتر الدولة SA: نتائج سعودية فقط وبها المسجّلون السعوديون',
      r.body.items.length >= 2 && r.body.items.every((u) => u.country === 'SA') && r.body.items.some((u) => u.id === saudi.id));
    r = await api('GET', '/api/directory?country=EG');
    check('فلتر الدولة EG: لا سعوديين فيه — والمؤسس مستبعد من أي فلتر دولة (دولته غير علنية)',
      r.body.items.every((u) => u.country === 'EG') && !r.body.items.some((u) => u.id === saudi.id) && !r.body.items.some((u) => u.is_platform_founder));
    r = await api('GET', `/api/talent/${founder.id}`, { token: tokA });
    check('المؤسس في الردود العامة: لا دولة ولا عملة ولا مدينة (قواعده كما هي)',
      r.status === 200 && !('country' in r.body.user) && !('currency' in r.body.user) && !('city' in r.body.user));

    // --- ضيف سعودي: طلب برقم محلي يظهر دولياً للصناع فقط ---
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'متجر رياض', phone: '0512987654', country: 'SA', city: 'Riyadh', niche: 'Tech', budget: 900, details: 'محتاج إعلان' } });
    const saGuestId = r.body.id;
    check('طلب ضيف سعودي برقم محلي يُنشأ بنجاح', r.status === 200 && !!saGuestId);
    r = await api('GET', '/api/requests', { token: saudiTok });
    const saGuest = r.body.items.find((x) => x.id === saGuestId);
    check('رقم الضيف السعودي لا يظهر للصناع إطلاقاً — دولته SA وعملته SAR ظاهرتان',
      !!saGuest && !('guest_phone' in saGuest) && !JSON.stringify(r.body).includes('+966512987654') && saGuest.country === 'SA' && saGuest.currency === 'SAR',
      `phone=${saGuest && saGuest.guest_phone}`);
    r = await api('GET', '/api/requests');
    const saGuestPub = r.body.items.find((x) => x.id === saGuestId);
    check('رقم الضيف السعودي لا يظهر للزائر العام إطلاقاً',
      !!saGuestPub && !('guest_phone' in saGuestPub) && !JSON.stringify(r.body).includes('+966512987654'));
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'ضيف سعودي بلا هاتف', country: 'SA', city: 'Riyadh', niche: 'Tech', budget: 100, details: 'طلب' } });
    check('طلب ضيف سعودي بلا أي هاتف يُنشأ بنجاح — لا تحقق هواتف في قناة الضيف إطلاقاً', r.status === 200 && !!r.body.id);

    // --- التوثيق وروابط X/سناب شات بنفس منطق القبول ---
    r = await api('POST', '/api/verify/request', { token: saudiTok });
    check('تعليمات التوثيق تذكر X وسناب شات كحسابات مقبولة صراحة',
      r.status === 200 && /x\.com/.test(r.body.instructions || '') && /سناب/.test(r.body.instructions || ''));
    r = await api('PATCH', '/api/me/profile', { token: saudiTok, body: { links: 'https://x.com/saudicreator — https://www.snapchat.com/add/saudicreator' } });
    check('روابط X وسناب شات تُحفظ في روابط الملف بلا رفض',
      r.status === 200 && /x\.com/.test(r.body.user.links || '') && /snapchat\.com/.test(r.body.user.links || ''));
    const codeSA = (await api('POST', '/api/verify/request', { token: saudiTok })).body.code;
    r = await api('POST', '/api/verify/check', { token: saudiTok, body: { url: `${AUX}/bio?code=${encodeURIComponent(codeSA)}&name=${encodeURIComponent('Saudi Creator')}` } });
    check('توثيق صانع سعودي بكود الملكية يعمل بنفس المنطق القائم', r.body.status === 'verified');

    // --- الدعم الآلي: موضوع الدول المتاحة AR/EN ---
    r = await api('POST', '/api/support/ask', { body: { q: 'هل Deal متاح في بلدي؟ ما هي الدول المتاحة؟' } });
    check('سؤال «هل Deal متاح في بلدي؟» يرد بموضوع الدول وقائمتها (19 دولة)',
      r.status === 200 && r.body.topic === 'countries' && /السعودية/.test(r.body.answer || '') && /19/.test(r.body.answer || ''));
    r = await api('POST', '/api/support/ask', { body: { q: 'Which countries is Deal available in?', lang: 'en' } });
    check('سؤال الدول بالإنجليزية يرد بموضوع الدول EN',
      r.status === 200 && r.body.topic === 'countries' && /Saudi Arabia/.test(r.body.answer || ''));

    /* ===== باقة «نجم Deal»: مال صارم (لا ميزة قبل تأكيد وصول الفلوس) + مزايا آلية ===== */
    r = await api('GET', '/api/star/info');
    const starTermsVersion = r.body && r.body.terms_version;
    check('معلومات الباقة العامة: 199 جنيه / 30 يوم وإصدار شروط — وبلا رقم العمولة إطلاقاً',
      r.status === 200 && r.body.price === 199 && r.body.days === 30 && r.body.currency === 'EGP' && !!starTermsVersion
      && !JSON.stringify(r.body).includes(TEST_PHONE));

    r = await api('POST', '/api/auth/register', { body: { name: 'Star Cook', role: 'creator', niche: 'طبخ', city: 'Cairo', contact: 'star1@test', price: 400 } });
    const starC = r.body.user, starCTok = r.body.token;
    r = await api('POST', '/api/auth/register', { body: { name: 'Star Editor', role: 'provider', provider_category: 'editing', city: 'Cairo', contact: 'starp@test', price: 250 } });
    const starP = r.body.user, starPTok = r.body.token;
    r = await api('POST', '/api/auth/register', { body: { name: 'Star Rej', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'starrej@test', price: 100 } });
    const rejU = r.body.user, rejTok = r.body.token;

    r = await api('POST', '/api/star/subscribe', { body: { ref: 'X', terms_accepted: true, terms_version: starTermsVersion } });
    check('اشتراك بلا تسجيل دخول مرفوض 401', r.status === 401);
    r = await api('POST', '/api/star/subscribe', { token: starCTok, body: { ref: 'STAR-PAY-1', terms_version: starTermsVersion } });
    check('اشتراك بلا قبول الشروط الرسمية مرفوض 400', r.status === 400 && /شروط/.test(r.body.error || ''));
    r = await api('POST', '/api/star/subscribe', { token: starCTok, body: { terms_accepted: true, terms_version: starTermsVersion } });
    check('اشتراك بلا مرجع تحويلة مرفوض 400', r.status === 400);
    r = await api('POST', '/api/star/subscribe', { token: founderTok, body: { ref: 'F-1', terms_accepted: true, terms_version: starTermsVersion } });
    check('المؤسس لا يشترك في الباقة — رفض خادمي واضح 400', r.status === 400 && /المؤسس/.test(r.body.error || ''));
    r = await api('POST', '/api/star/subscribe', { token: shopTok, body: { ref: 'S-1', terms_accepted: true, terms_version: starTermsVersion } });
    check('حساب محل لا يشترك في باقة الصناع/المقدمين 400', r.status === 400);
    r = await api('GET', '/api/star/payment-info', { token: founderTok });
    check('رقم دفع الباقة ممنوع على المؤسس 400', r.status === 400);
    r = await api('GET', '/api/star/payment-info', { token: starPTok });
    check('رقم دفع الباقة لعضو مؤهل فقط داخل خطوة الدفع وبالمبلغ الثابت 199',
      r.status === 200 && r.body.phone === TEST_PHONE && r.body.amount === 199);

    r = await api('POST', '/api/star/subscribe', { token: starCTok, body: { ref: 'STAR-PAY-1', terms_accepted: true, terms_version: starTermsVersion } });
    check('اشتراك صحيح يولد «قيد التحقق» بالمبلغ الثابت من إعدادات الخادم',
      r.status === 200 && r.body.state === 'pending' && r.body.subscription.amount === 199 && r.body.subscription.status === 'pending');
    const starSubId = r.body.subscription.id;
    r = await api('GET', '/api/star/me', { token: starCTok });
    check('حالتي مع الباقة: pending — وقبول الشروط مختوم زمنياً في السجل',
      r.body.state === 'pending' && r.body.subscription.terms_accepted_at > 0 && r.body.subscription.terms_version === starTermsVersion);
    r = await api('GET', '/api/directory', { token: tokA });
    const dirStarPending = r.body.items.find((u) => u.id === starC.id);
    check('قيد التحقق = بلا أي ميزة: لا شارة نجم في الدليل قبل تأكيد الفلوس', !!dirStarPending && dirStarPending.is_star === false && dirStarPending.star_of_week === false);
    r = await api('GET', '/api/star/fuel', { token: starCTok });
    check('وقود النمو مقفل أثناء قيد التحقق 403', r.status === 403);
    r = await api('GET', '/api/star/week');
    check('لا نجم أسبوع قبل أي تفعيل', r.status === 200 && r.body.star === null);
    r = await api('POST', '/api/star/subscribe', { token: starCTok, body: { ref: 'STAR-PAY-2', terms_accepted: true, terms_version: starTermsVersion } });
    check('اشتراك ثانٍ أثناء قيد التحقق مرفوض 400 بحالته', r.status === 400 && /قيد التحقق/.test(r.body.error || ''));
    r = await api('GET', '/api/star/payment-info', { token: starCTok });
    check('رقم الدفع يُحجب أثناء قيد التحقق (لا دفع مكرر)', r.status === 400);

    r = await api('GET', '/api/owner/star', { token: tokA });
    check('سجل الباقة في لوحة المالك ممنوع على غير المالك 403', r.status === 403);
    r = await api('GET', '/api/owner/star', { token: founderTok });
    const pendItem = (r.body.items || []).find((s) => s.id === starSubId);
    check('لوحة المالك: اشتراك قيد التحقق واحد بسجله الرسمي (مشترك/مبلغ/مرجع/قبول شروط) وإيراد صفر قبل التأكيد',
      r.body.counts.pending === 1 && r.body.revenue === 0 && !!pendItem && pendItem.ref === 'STAR-PAY-1'
      && pendItem.user && pendItem.user.name === 'Star Cook' && pendItem.terms_accepted_at > 0);
    r = await api('POST', `/api/owner/star/${starSubId}/confirm`, { token: tokA, body: {} });
    check('تأكيد الاشتراك من غير المالك مرفوض 403', r.status === 403);
    r = await api('POST', `/api/owner/star/${starSubId}/confirm`, { token: founderTok, body: {} });
    check('تأكيد المالك يفعّل فوراً: نشط ومدته 30 يوماً بالضبط من لحظة التأكيد',
      r.status === 200 && r.body.subscription.status === 'active'
      && (r.body.subscription.expires_at - r.body.subscription.activated_at) === 30 * 24 * 3600 * 1000);
    r = await api('POST', `/api/owner/star/${starSubId}/confirm`, { token: founderTok, body: {} });
    check('تأكيد اشتراك تم البت فيه مرفوض 400', r.status === 400);
    r = await api('GET', '/api/notifications', { token: starCTok });
    check('إشعار التفعيل وصل للمشترك لحظة تأكيد المالك', (r.body.items || []).some((n) => n.type === 'star_active'));
    r = await api('GET', '/api/star/me', { token: starCTok });
    check('حالتي بعد التفعيل: active وباقي 30 يوم وهو نجم الأسبوع (المشترك النشط الوحيد)',
      r.body.state === 'active' && r.body.subscription.days_left >= 29 && r.body.subscription.days_left <= 30 && r.body.is_week_star === true);
    r = await api('GET', '/api/directory', { token: tokA });
    const dirStar = r.body.items.find((u) => u.id === starC.id);
    const idxStar = r.body.items.findIndex((u) => u.id === starC.id);
    const idxC2 = r.body.items.findIndex((u) => u.id === creatorC.id);
    check('بعد التفعيل: شارة النجم ونجم الأسبوع في الدليل + أولوية ترتيب موثقة (يتقدّم على غير نجم بنفس بقية المعايير)',
      !!dirStar && dirStar.is_star === true && dirStar.star_of_week === true && idxStar >= 0 && idxC2 >= 0 && idxStar < idxC2,
      `star=${idxStar} c=${idxC2}`);
    r = await api('GET', `/api/talent/${starC.id}`, { token: shopTok });
    check('شارة النجم ظاهرة في الملف العام للمشترك النشط', r.status === 200 && r.body.user.is_star === true);
    r = await api('GET', '/api/star/week');
    check('نجم الأسبوع العام = المشترك النشط وبلا أي رقم عمولة في الرد',
      r.status === 200 && !!r.body.star && r.body.star.id === starC.id && !JSON.stringify(r.body).includes(TEST_PHONE));
    r = await api('GET', '/api/star/fuel', { token: starCTok });
    check('وقود النمو للمشترك النشط: إحصاءات حقيقية + ٣ أفكار عربية لمجاله (طبخ) + خطوة نمو',
      r.status === 200 && r.body.fuel.key === 'طبخ' && Array.isArray(r.body.fuel.ideas) && r.body.fuel.ideas.length === 3
      && r.body.fuel.ideas.every((x) => typeof x === 'string' && x.length > 20) && typeof r.body.fuel.step === 'string' && r.body.fuel.step.length > 10
      && typeof r.body.stats.views === 'number' && !!r.body.stats.record);
    r = await api('POST', '/api/star/subscribe', { token: starCTok, body: { ref: 'STAR-PAY-3', terms_accepted: true, terms_version: starTermsVersion } });
    check('اشتراك جديد أثناء النشاط مرفوض 400 بحالته النشطة', r.status === 400 && /نشط/.test(r.body.error || ''));

    /* رفض المالك: مرجع خاطئ → مرفوض بسبب، وإعادة اشتراك ممكنة */
    r = await api('POST', '/api/star/subscribe', { token: rejTok, body: { ref: 'BAD-REF', terms_accepted: true, terms_version: starTermsVersion } });
    const rejSubId = r.body.subscription.id;
    r = await api('POST', `/api/owner/star/${rejSubId}/reject`, { token: founderTok, body: { reason: 'مرجع خاطئ للفحص' } });
    check('رفض المالك لمرجع خاطئ ينجح', r.status === 200);
    r = await api('GET', '/api/star/me', { token: rejTok });
    check('حالة المرفوض: rejected بالسبب المسجل', r.body.state === 'rejected' && r.body.subscription.reject_reason === 'مرجع خاطئ للفحص');
    r = await api('GET', '/api/notifications', { token: rejTok });
    check('إشعار الرفض وصل للمشترك بالسبب', (r.body.items || []).some((n) => n.type === 'star_rejected'));
    r = await api('GET', '/api/directory', { token: tokA });
    check('المرفوض بلا أي ميزة نجم في الدليل', (r.body.items.find((u) => u.id === rejU.id) || {}).is_star === false);
    r = await api('POST', '/api/star/subscribe', { token: rejTok, body: { ref: 'GOOD-REF-2', terms_accepted: true, terms_version: starTermsVersion } });
    check('بعد الرفض يمكن الاشتراك من جديد (قيد تحقق جديد)', r.status === 200 && r.body.state === 'pending');

    /* مقدم خدمة مشترك: وقود بخدمته + أولوية دعم */
    r = await api('POST', '/api/star/subscribe', { token: starPTok, body: { ref: 'STAR-PAY-P', terms_accepted: true, terms_version: starTermsVersion } });
    const starPSubId = r.body.subscription.id;
    await api('POST', `/api/owner/star/${starPSubId}/confirm`, { token: founderTok, body: {} });
    r = await api('GET', '/api/star/fuel', { token: starPTok });
    check('وقود مقدم الخدمة النشط مربوط بخدمته (editing) بأفكار حقيقية',
      r.status === 200 && r.body.fuel.key === 'editing' && r.body.fuel.ideas.length === 3);
    r = await api('POST', '/api/support/ask', { token: starCTok, body: { q: 'هل توجد خطط لفتح فرع على القمر؟', lang: 'ar' } });
    check('سؤال المشترك النشط خارج القاعدة يُحفظ كالمعتاد', r.status === 200 && r.body.fallback === true);
    await api('POST', '/api/support/ask', { token: tokC, body: { q: 'كم عدد موظفي الشركة حالياً؟', lang: 'ar' } });
    r = await api('GET', '/api/owner/support-messages', { token: founderTok });
    const supStar = (r.body.items || []).find((m) => /القمر/.test(m.question));
    const supPlain = (r.body.items || []).find((m) => /موظفي الشركة/.test(m.question));
    check('أولوية الدعم: رسالة مشترك النجم موسومة أولوية وتتصدّر رسالة عادية أحدث منها',
      !!supStar && (supStar.priority === 1 || supStar.priority === true) && !!supPlain && !supPlain.priority
      && r.body.items.indexOf(supStar) < r.body.items.indexOf(supPlain));

    /* تذكير قرب الانتهاء + انتهاء بمحاكاة زمنية → انطفاء كل المزايا */
    const pgc2 = new Client({ connectionString: DATABASE_URL });
    await pgc2.connect();
    await pgc2.query('UPDATE star_subscriptions SET expires_at=$1 WHERE id=$2', [Date.now() + 2 * 24 * 3600 * 1000, starPSubId]);
    r = await api('GET', '/api/star/me', { token: starPTok });
    check('قبل الانتهاء بيومين: الاشتراك نشط وباقي يومان', r.body.state === 'active' && r.body.subscription.days_left === 2);
    r = await api('GET', '/api/notifications', { token: starPTok });
    check('تذكير «بينتهي خلال ٣ أيام» وصل تلقائياً مرة', (r.body.items || []).some((n) => n.type === 'star_expiring'));
    await pgc2.query('UPDATE star_subscriptions SET expires_at=$1 WHERE id=$2', [Date.now() - 1000, starSubId]);
    await pgc2.end();
    r = await api('GET', '/api/star/me', { token: starCTok });
    check('بعد انتهاء المدة (محاكاة زمنية): الحالة expired', r.body.state === 'expired');
    r = await api('GET', '/api/directory', { token: tokA });
    const dirStarExp = r.body.items.find((u) => u.id === starC.id);
    check('انطفاء تلقائي عند الانتهاء: الشارة والإطار ونجم الأسبوع زالت من الدليل', !!dirStarExp && dirStarExp.is_star === false && dirStarExp.star_of_week === false);
    r = await api('GET', '/api/star/fuel', { token: starCTok });
    check('وقود النمو يُقفل بعد الانتهاء 403', r.status === 403);
    r = await api('GET', '/api/star/week');
    check('نجم الأسبوع انتقل للمشترك النشط المتبقي (مقدم الخدمة)', r.status === 200 && !!r.body.star && r.body.star.id === starP.id);
    r = await api('GET', '/api/notifications', { token: starCTok });
    check('إشعار انتهاء الاشتراك وصل للمشترك', (r.body.items || []).some((n) => n.type === 'star_expired'));

    /* حساب مجمّد لا يشترك */
    await api('POST', `/api/owner/users/${frozenUser.id}/penalty`, { token: founderTok, body: { level: 'none', frozen: true } });
    const frozenTok = (await api('POST', '/api/auth/login', { body: { contact: 'frozen@test' } })).body.token;
    r = await api('POST', '/api/star/subscribe', { token: frozenTok, body: { ref: 'FRZ-1', terms_accepted: true, terms_version: starTermsVersion } });
    check('حساب مجمّد لا يستطيع الاشتراك 400', r.status === 400 && /مجمّد/.test(r.body.error || ''));
    await api('POST', `/api/owner/users/${frozenUser.id}/penalty`, { token: founderTok, body: { level: 'none', frozen: false } });

    /* سجل المالك النهائي: عدّادات وإيراد مؤكد فقط (نشط + منتهٍ — لا قيد تحقق ولا مرفوض) */
    r = await api('GET', '/api/owner/star', { token: founderTok });
    check('سجل المالك النهائي: نشط 1 (مقدم) + منتهٍ 1 (الصانع) + مرفوض 1 + قيد تحقق 1 (إعادة الاشتراك) وإيراد مؤكد 398',
      r.body.counts.active === 1 && r.body.counts.expired === 1 && r.body.counts.rejected === 1 && r.body.counts.pending === 1
      && r.body.revenue === 398, JSON.stringify(r.body.counts) + ' rev=' + r.body.revenue);

    /* وقود نجم لمقدم إنتاج الفيديوهات: بعد سجل المالك النهائي أعلاه حتى لا تتغير عدّاداته */
    r = await api('POST', '/api/star/subscribe', { token: videoProvTok, body: { ref: 'STAR-VIDEO-1', terms_accepted: true, terms_version: starTermsVersion } });
    check('اشتراك نجم لمقدم إنتاج الفيديوهات يولد «قيد التحقق» كالمعتاد', r.status === 200 && r.body.state === 'pending');
    const videoSubId = r.body.subscription && r.body.subscription.id;
    r = await api('GET', '/api/star/fuel', { token: videoProvTok });
    check('وقود النجم مقفل لمقدم إنتاج الفيديوهات أثناء قيد التحقق 403', r.status === 403);
    await api('POST', `/api/owner/star/${videoSubId}/confirm`, { token: founderTok, body: {} });
    r = await api('GET', '/api/star/fuel', { token: videoProvTok });
    check('وقود نجم مقدم إنتاج الفيديوهات مربوط بخدمته الجديدة (videoproduction) بـ٣ أفكار عربية كاملة وخطوة نمو — لا فراغ ولا خطأ',
      r.status === 200 && r.body.fuel.key === 'videoproduction' && Array.isArray(r.body.fuel.ideas) && r.body.fuel.ideas.length === 3
      && r.body.fuel.ideas.every((x) => typeof x === 'string' && x.length > 20) && typeof r.body.fuel.step === 'string' && r.body.fuel.step.length > 10,
      `fuel=${JSON.stringify(r.body && r.body.fuel)}`);

    /* ===== المرجع المالي الموحد + أمان المعاملات (TESTING-MONEY-REF.md) =====
       قرارات المستخدم: كل التزام مالي بكود معاملة ومبلغ فريد بكسور بصمة
       (الكسور هي المرجع لأن المحافظ الشخصية بلا خانة ملاحظات)، وتأكيد تلقائي
       عند وصول الفلوس عبر إيصال مطابق لكل الشروط الصارمة معاً، وأمان قوي لكل
       الأطراف: لا تأكيد بكلمة طرف واحد، وسجل append-only، وإلغاء مالك يسحب
       الأثر. القسم بعد «سجل المالك النهائي» للباقة حتى لا تتغير عدّاداته. */
    const cryptoT = require('crypto');
    const receiptImg = (uid) => {
      const bytes = Buffer.from('receipt-image-' + uid);
      return { dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), hash: cryptoT.createHash('sha256').update(bytes).digest('hex') };
    };
    const regMoney = async (contact) => {
      const rr = await api('POST', '/api/auth/register', { body: { name: 'Money ' + contact, role: 'creator', niche: 'Tech', city: 'Cairo', contact, price: 100 } });
      return rr.body;
    };

    /* التزام الاشتراك: شكل + إعادة استخدام + تكيّف وسيلة الدفع مع الدولة */
    const mStar = await regMoney('mstar@test');
    r = await api('GET', '/api/star/payment-info', { token: mStar.token });
    const mOb = r.body.obligation || {};
    const mCents = Math.round((mOb.exact_amount - 199) * 100);
    check('التزام اشتراك: كود DL- ومبلغ بالبصمة (199 + كسور 1..99) ووسيلة مصر ورقم المستلم ظاهر والالتزام مفتوح',
      r.status === 200 && /^DL-[A-Z0-9]{6}$/.test(mOb.code || '') && mOb.base_amount === 199 && mCents >= 1 && mCents <= 99
      && mOb.status === 'open' && mOb.country === 'EG' && /فودافون كاش/.test(mOb.method_label || '') && mOb.payee_phone === TEST_PHONE,
      JSON.stringify(mOb));
    r = await api('GET', '/api/star/payment-info', { token: mStar.token });
    check('فتح خطوة الدفع مجدداً يعيد نفس الالتزام المفتوح (لا التزام جديد)', r.status === 200 && !!r.body.obligation && r.body.obligation.code === mOb.code);
    r = await api('GET', '/api/star/payment-info', { token: saudiTok });
    check('تكيّف وسيلة الدفع مع دولة الحساب: السعودي يرى STC Pay ودولته SA في التزامه',
      !!(r.body.obligation) && r.body.obligation.country === 'SA' && /STC Pay/.test(r.body.obligation.method_label || ''),
      JSON.stringify(r.body.obligation || {}));
    r = await api('GET', '/api/money/obligation?kind=star_subscription', { token: tokA });
    check('التزام عضو لا يُكشف لعضو آخر: كل دافع يرى التزامه هو فقط',
      r.status === 400 || (!!r.body.obligation && r.body.obligation.code !== mOb.code));

    /* بصمة بلا تصادم لالتزامات مفتوحة بنفس المستلم والأساس */
    const feeExact = [], feeCodes = [];
    for (let i = 0; i < 3; i++) {
      const rb = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: creatorA.id, price: 500 } });
      const bid = rb.body.booking.id;
      await api('POST', `/api/bookings/${bid}/agree`, { token: shopTok });
      await api('POST', `/api/bookings/${bid}/agree`, { token: tokA });
      const rf = await api('GET', `/api/bookings/${bid}/fee-info`, { token: shopTok });
      feeExact.push(rf.body.obligation.exact_amount); feeCodes.push(rf.body.obligation.code);
    }
    check('بصمة بلا تصادم: 3 التزامات عمولة لنفس الأساس 50 بمبالغ دقيقة مختلفة وأكواد مختلفة',
      new Set(feeExact).size === 3 && new Set(feeCodes).size === 3 && feeExact.every((x) => x > 50 && x < 51),
      feeExact.join(','));

    /* التزام العربون: للدافع وحده والمستلم هو المقدم */
    const rbD = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: creatorA.id, price: 500 } });
    const bDep = rbD.body.booking.id;
    await api('POST', `/api/bookings/${bDep}/agree`, { token: shopTok });
    await api('POST', `/api/bookings/${bDep}/agree`, { token: tokA });
    await api('POST', `/api/bookings/${bDep}/pay`, { token: shopTok, body: { kind: 'fee', ref: 'FEE-DEP-1' } });
    r = await api('GET', `/api/money/obligation?kind=booking_deposit&booking_id=${bDep}`, { token: shopTok });
    check('التزام العربون للدافع: 225 + بصمة والمستلم هو المقدم ورقمه ظاهر للدافع',
      r.status === 200 && r.body.obligation.base_amount === 225 && r.body.obligation.exact_amount > 225 && r.body.obligation.exact_amount < 226
      && r.body.obligation.payee === `user:${creatorA.id}` && !!r.body.obligation.payee_phone,
      JSON.stringify(r.body.obligation || {}));
    r = await api('GET', `/api/money/obligation?kind=booking_deposit&booking_id=${bDep}`, { token: tokA });
    check('التزام العربون محجوب عن المقدم نفسه (يظهر للدافع وحده) 403', r.status === 403);
    r = await api('GET', `/api/money/obligation?kind=booking_deposit&booking_id=${bDep}`);
    check('التزام محجوب عن مجهول بلا جلسة 403', r.status === 403);

    /* تأكيد تلقائي كامل الشروط: اشتراك يُفعَّل فوراً + إشعار مالك + بحث بالمبلغ */
    r = await api('POST', '/api/star/subscribe', { token: mStar.token, body: { ref: 'MSTAR-REF-1', terms_accepted: true, terms_version: starTermsVersion } });
    check('اشتراك المرجع المالي: «قيد تحقق» كالمعتاد قبل أي تأكيد', r.status === 200 && r.body.state === 'pending');
    r = await api('GET', '/api/money/obligation?kind=star_subscription', { token: mStar.token });
    check('بعد الادعاء بالمرجع: رقم العمولات لم يعد مكشوفاً داخل الالتزام (بوابة الرقم)',
      r.status === 200 && !r.body.obligation.payee_phone);
    const img1 = receiptImg('mstar-1');
    r = await api('POST', '/api/money/verify-receipt', { token: mStar.token, body: { obligation_code: mOb.code, image: img1.dataUrl, image_hash: img1.hash, extracted: { amount: mOb.exact_amount, recipient_digits: TEST_PHONE, transfer_ref: 'MSTAR-REF-1', date: Date.now() } } });
    check('إيصال مطابق لكل الشروط الصارمة معاً → تأكيد تلقائي', r.status === 200 && r.body.verdict === 'auto_confirmed', JSON.stringify(r.body));
    r = await api('GET', '/api/star/me', { token: mStar.token });
    check('التأكيد التلقائي فعّل اشتراك النجم فوراً', r.body.state === 'active');
    r = await api('GET', '/api/notifications', { token: founderTok });
    check('إشعار فوري للمالك بالتفعيل التلقائي مع كود المعاملة', (r.body.items || []).some((n) => n.type === 'money_auto' && /تفعيل تلقائي/.test(n.text || '') && (n.text || '').includes(mOb.code)));
    r = await api('GET', `/api/owner/money/lookup?amount=${mOb.exact_amount}`, { token: founderTok });
    check('بحث المالك «وصلني مبلغ»: المبلغ بالبصمة يجد الالتزام المؤكد تلقائياً',
      r.status === 200 && (r.body.items || []).some((x) => x.code === mOb.code && x.status === 'auto_confirmed'));
    r = await api('GET', `/api/owner/money/lookup?amount=${mOb.exact_amount}`, { token: tokA });
    check('بحث المال للمالك فقط 403', r.status === 403);

    /* كل شرط منقوص على حدة → مراجعة مالك، لا تأكيد جزئي أبداً */
    const defectCase = async (contact, mutate) => {
      const u = await regMoney(contact);
      const pi = await api('GET', '/api/star/payment-info', { token: u.token });
      const ob = pi.body.obligation;
      await api('POST', '/api/star/subscribe', { token: u.token, body: { ref: 'DEF-' + contact, terms_accepted: true, terms_version: starTermsVersion } });
      const img = receiptImg('def-' + contact);
      const ex = { amount: ob.exact_amount, recipient_digits: TEST_PHONE, transfer_ref: 'DEF-' + contact, date: Date.now() };
      mutate(ex, ob);
      const vr = await api('POST', '/api/money/verify-receipt', { token: u.token, body: { obligation_code: ob.code, image: img.dataUrl, image_hash: img.hash, extracted: ex } });
      const me = await api('GET', '/api/star/me', { token: u.token });
      const obNow = await api('GET', '/api/money/obligation?kind=star_subscription', { token: u.token });
      return { vr, me, obNow };
    };
    let dc = await defectCase('defamt@test', (ex, ob) => { ex.amount = ob.exact_amount + 1; });
    check('شرط منقوص (مبلغ خطأ) → مراجعة مالك لا تأكيد: الاشتراك معلّق والالتزام مُدّعى',
      dc.vr.body.verdict === 'review' && dc.me.body.state === 'pending' && dc.obNow.body.obligation.status === 'claimed');
    dc = await defectCase('defrcp@test', (ex) => { ex.recipient_digits = '01011111111'; });
    check('شرط منقوص (رقم مستلم خطأ) → مراجعة لا تأكيد', dc.vr.body.verdict === 'review' && dc.me.body.state === 'pending');
    dc = await defectCase('defdate@test', (ex) => { ex.date = Date.now() - 72 * 3600 * 1000; });
    check('شرط منقوص (تاريخ أقدم من 48 ساعة) → مراجعة لا تأكيد', dc.vr.body.verdict === 'review' && dc.me.body.state === 'pending');
    dc = await defectCase('defref@test', (ex) => { ex.transfer_ref = ''; });
    check('شرط منقوص (مرجع فارغ) → مراجعة لا تأكيد', dc.vr.body.verdict === 'review' && dc.me.body.state === 'pending');

    /* احتيال: مرجع مستخدم من حساب آخر / صورة مكررة → 409 + علم عند المالك */
    const fB = await regMoney('fraudb@test');
    const piB = await api('GET', '/api/star/payment-info', { token: fB.token });
    const obB = piB.body.obligation;
    await api('POST', '/api/star/subscribe', { token: fB.token, body: { ref: 'FB-OWN-1', terms_accepted: true, terms_version: starTermsVersion } });
    const imgB = receiptImg('fraudb-1');
    r = await api('POST', '/api/money/verify-receipt', { token: fB.token, body: { obligation_code: obB.code, image: imgB.dataUrl, image_hash: imgB.hash, extracted: { amount: obB.exact_amount, recipient_digits: TEST_PHONE, transfer_ref: 'MSTAR-REF-1', date: Date.now() } } });
    check('مرجع تحويلة مستخدم في التزام آخر → رفض 409 بعلم احتيال', r.status === 409 && r.body.fraud === true, JSON.stringify(r.body));
    const ownerMoney1 = await api('GET', '/api/owner/money', { token: founderTok });
    const obBRow = (ownerMoney1.body.items || []).find((x) => x.code === obB.code);
    check('علم الاحتيال ظاهر للمالك في قائمة المعاملات', !!obBRow && (obBRow.fraud_flag === 1 || obBRow.fraud_flag === true));
    const fC = await regMoney('fraudc@test');
    const piC = await api('GET', '/api/star/payment-info', { token: fC.token });
    const obC = piC.body.obligation;
    await api('POST', '/api/star/subscribe', { token: fC.token, body: { ref: 'FC-OWN-1', terms_accepted: true, terms_version: starTermsVersion } });
    r = await api('POST', '/api/money/verify-receipt', { token: fC.token, body: { obligation_code: obC.code, image: img1.dataUrl, image_hash: img1.hash, extracted: { amount: obC.exact_amount, recipient_digits: TEST_PHONE, transfer_ref: 'FC-OWN-1', date: Date.now() } } });
    check('صورة إيصال مكررة من حساب آخر → رفض 409 بعلم احتيال', r.status === 409 && r.body.fraud === true);

    /* قفل الرفع بعد 5 محاولات فاشلة */
    const lk = await regMoney('lock@test');
    const piL = await api('GET', '/api/star/payment-info', { token: lk.token });
    const obL = piL.body.obligation;
    await api('POST', '/api/star/subscribe', { token: lk.token, body: { ref: 'LOCK-REF', terms_accepted: true, terms_version: starTermsVersion } });
    let lastVr = null;
    for (let i = 0; i < 5; i++) {
      const im = receiptImg('lock-' + i);
      lastVr = await api('POST', '/api/money/verify-receipt', { token: lk.token, body: { obligation_code: obL.code, image: im.dataUrl, image_hash: im.hash, extracted: { amount: obL.exact_amount + 5, recipient_digits: TEST_PHONE, transfer_ref: 'LOCK-BAD-' + i, date: Date.now() } } });
    }
    check('5 محاولات إيصال فاشلة → قفل الرفع على الالتزام وتحويله لمراجعة يدوية',
      !!lastVr && lastVr.body.verdict === 'review' && lastVr.body.locked === true, JSON.stringify(lastVr && lastVr.body));
    const im6 = receiptImg('lock-6');
    r = await api('POST', '/api/money/verify-receipt', { token: lk.token, body: { obligation_code: obL.code, image: im6.dataUrl, image_hash: im6.hash, extracted: { amount: obL.exact_amount, recipient_digits: TEST_PHONE, transfer_ref: 'LOCK-GOOD', date: Date.now() } } });
    check('بعد القفل: أي رفع جديد مرفوض 400 حتى لو كانت بياناته صحيحة', r.status === 400);

    /* صورة الإيصال للمالك فقط + إلغاء التأكيد يسحب المزايا + سجل مرتب */
    const ownerMoney2 = await api('GET', '/api/owner/money', { token: founderTok });
    const mRow = (ownerMoney2.body.items || []).find((x) => x.code === mOb.code);
    check('التزام الاشتراك المؤكد تلقائياً ظاهر في قائمة مال المالك', !!mRow && mRow.status === 'auto_confirmed');
    r = await api('GET', `/api/owner/money/${mRow.id}/receipt`, { token: founderTok });
    check('صورة الإيصال محفوظة لمراجعة المالك (200 بصورة)', r.status === 200 && typeof r.body.image === 'string' && r.body.image.startsWith('data:image'));
    r = await api('GET', `/api/owner/money/${mRow.id}/receipt`, { token: tokA });
    check('صورة الإيصال محجوبة عن غير المالك 403', r.status === 403);
    r = await api('POST', `/api/owner/money/${mRow.id}/revoke`, { token: founderTok, body: {} });
    check('إلغاء المالك لتأكيد تلقائي ينجح بضغطة', r.status === 200);
    r = await api('GET', '/api/star/me', { token: mStar.token });
    check('الإلغاء سحب مزايا الاشتراك فوراً (لم يعد نشطاً)', r.body.state !== 'active', String(r.body.state));
    r = await api('GET', `/api/owner/money/${mRow.id}`, { token: founderTok });
    const seq = (r.body.ledger || []).map((e) => e.to_status);
    check('سجل المعاملة: الانتقالات مرتبة (…→مُدّعى→مؤكد تلقائياً→ملغي) والحالة النهائية ملغاة',
      r.body.obligation.status === 'revoked' && seq.includes('claimed') && seq.includes('auto_confirmed')
      && seq.indexOf('claimed') < seq.indexOf('auto_confirmed') && seq.indexOf('auto_confirmed') < seq.lastIndexOf('revoked'),
      seq.join('>'));
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    check('سجل المال append-only في الكود: لا UPDATE ولا DELETE على money_ledger إطلاقاً',
      !/UPDATE\s+money_ledger/i.test(serverSrc) && !/DELETE\s+FROM\s+money_ledger/i.test(serverSrc));

    /* عمولة ضيف تُأكَّد تلقائياً بالإيصال من صفحة المتابعة */
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل المرجع', phone: '01055512345', city: 'Cairo', niche: 'Tech', budget: 600, details: 'فيديو للمرجع المالي' } });
    const gTok2 = r.body.token, gReq2 = r.body.id;
    check('طلب ضيف جديد لجولة المرجع المالي', r.status === 200 && !!gTok2);
    await api('POST', `/api/guest-requests/${gReq2}/book`, { token: tokA, body: {} });
    await api('POST', `/api/guest/${gTok2}/agree`, { body: {} });
    let gd = await api('GET', `/api/guest/${gTok2}`);
    if (gd.body.booking && gd.body.booking.status === 'pending_agreement') {
      await api('POST', `/api/bookings/${gd.body.booking.id}/agree`, { token: tokA });
      gd = await api('GET', `/api/guest/${gTok2}`);
    }
    r = await api('GET', `/api/guest/${gTok2}/fee-info`);
    const gOb = r.body.obligation || {};
    check('التزام عمولة الضيف ظاهر في خطوته بالمبلغ بالبصمة (60 + كسور)',
      r.status === 200 && gOb.base_amount === 60 && gOb.exact_amount > 60 && gOb.exact_amount < 61 && /^DL-/.test(gOb.code || ''),
      JSON.stringify(gOb));
    const imgG = receiptImg('guest-1');
    r = await api('POST', '/api/money/verify-receipt', { body: { obligation_code: gOb.code, guest_token: gTok2, image: imgG.dataUrl, image_hash: imgG.hash, extracted: { amount: gOb.exact_amount, recipient_digits: TEST_PHONE, transfer_ref: 'GUEST-AUTO-1', date: Date.now() } } });
    check('إيصال ضيف مطابق لكل الشروط → تأكيد تلقائي لعمولته', r.status === 200 && r.body.verdict === 'auto_confirmed', JSON.stringify(r.body));
    gd = await api('GET', `/api/guest/${gTok2}`);
    check('حجز الضيف تقدم لخطوة العربون بعد التأكيد التلقائي', !!gd.body.booking && gd.body.booking.fee_status === 'confirmed' && gd.body.booking.status === 'awaiting_deposit');

    /* ===== احتجاز الباقي عند Deal — Escrow بنموذج Binance P2P (TESTING-ESCROW.md) =====
       قرارات المستخدم: الدفعة الأخيرة (45%) تتحوّل لرقم Deal وتُحتجَز هناك —
       لا تصل المقدم مباشرة. اكتمال الحجز = احتجاز مؤكد + استلام مؤكد (يدوياً
       أو تلقائياً بعد 24 ساعة من إثبات سليم، مع تنبيه عند 12 ساعة). بعدها
       المبلغ «جاهز للإفراج» وفعل المالك اليدوي الوحيد هو تحويلته من محفظته
       للمقدم وتسجيل مرجعها؛ المقدم يؤكد الوصول أو يعلّم «ماوصلش». النزاع
       يجمّد المحتجَز فوراً، وحزمة الأدلة تتولد تلقائياً من سجل الحجز. */
    const escT = await regMoney('esctalent@test');
    const escC = await regMoney('escclient@test');
    const pgSet = async (sql, params) => { const c = new Client({ connectionString: DATABASE_URL }); await c.connect(); await c.query(sql, params); await c.end(); };
    const escDrive = async (price, tag) => {
      const rb = await api('POST', '/api/bookings', { token: escC.token, body: { talent_id: escT.user.id, price } });
      const id = rb.body.booking.id;
      await api('POST', `/api/bookings/${id}/agree`, { token: escC.token });
      await api('POST', `/api/bookings/${id}/agree`, { token: escT.token });
      await api('POST', `/api/bookings/${id}/pay`, { token: escC.token, body: { kind: 'fee', ref: 'EF-' + tag } });
      await api('POST', `/api/bookings/${id}/pay`, { token: escC.token, body: { kind: 'deposit', ref: 'ED-' + tag } });
      await api('POST', `/api/bookings/${id}/proof`, { token: escT.token, body: { url: `${AUX}/proof-ok` } });
      return id;
    };
    const finObOf = async (bid) => (await api('GET', '/api/owner/money', { token: founderTok })).body.items.find((o) => o.kind === 'booking_final' && o.booking_id === bid);

    /* E1: المسار الكامل + خصوصية الالتزام + الإفراج بمرجع + تأكيد وصول المنفذ */
    const e1 = await escDrive(500, 'E1');
    r = await api('POST', `/api/bookings/${e1}/confirm-receipt`, { token: escC.token });
    check('احتجاز: تأكيد الاستلام يفتح خطوة تحويل الباقي لـDeal', r.body.booking.status === 'awaiting_rest' && r.body.booking.escrow_status === 'awaiting_transfer', `escrow=${r.body.booking.escrow_status}`);
    r = await api('GET', `/api/money/obligation?kind=booking_final&booking_id=${e1}`, { token: escC.token });
    const e1ob = r.body.obligation || {};
    check('احتجاز: التزام الأخيرة بكود DL- ومبلغ بالبصمة (225) ومستلمه المالك ورقمه ظاهر للدافع', r.status === 200 && /^DL-/.test(e1ob.code || '') && e1ob.base_amount === 225 && e1ob.payee_phone === TEST_PHONE, JSON.stringify(e1ob));
    r = await api('GET', `/api/money/obligation?kind=booking_final&booking_id=${e1}`, { token: escT.token });
    check('احتجاز: المنفذ لا يرى التزام الباقي ولا رقم المالك 403', r.status === 403);
    r = await api('POST', `/api/bookings/${e1}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E1' } });
    check('احتجاز: تسجيل تحويل الباقي = «بانتظار تأكيد التحويلة» وبلا اكتمال', r.body.booking.escrow_status === 'awaiting_confirmation' && r.body.booking.status === 'awaiting_rest', `escrow=${r.body.booking.escrow_status}`);
    r = await api('POST', `/api/bookings/${e1}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E1B' } });
    check('احتجاز: تسجيل تحويل الباقي مرتين مرفوض 400', r.status === 400);
    const e1fin = await finObOf(e1);
    await api('POST', `/api/owner/money/${e1fin.id}/confirm`, { token: founderTok, body: {} });
    r = await api('GET', `/api/bookings/${e1}`, { token: escC.token });
    check('احتجاز: تأكيد المالك يحتجز الباقي ويكمل الحجز «جاهز للإفراج»', r.body.booking.status === 'completed' && r.body.booking.escrow_status === 'ready_release', `escrow=${r.body.booking.escrow_status}`);
    r = await api('GET', '/api/owner/escrow', { token: founderTok });
    const e1row = (r.body.items || []).find((x) => x.booking_id === e1);
    check('لوحة المالك: المحتجَز ظاهر في «مبالغ محتجزة» بمبلغه وأطرافه وكود التزامه', !!e1row && e1row.amount === 225 && e1row.escrow_status === 'ready_release' && e1row.obligation_code === e1ob.code, JSON.stringify(e1row));
    r = await api('GET', '/api/owner/escrow', { token: escT.token });
    check('قسم المحتجَزات للمالك فقط 403', r.status === 403);
    r = await api('POST', `/api/owner/escrow/${e1}/release`, { token: founderTok, body: {} });
    check('إفراج بلا مرجع تحويلة مرفوض 400', r.status === 400);
    r = await api('POST', `/api/owner/escrow/${e1}/release`, { token: founderTok, body: { ref: 'REL-E1' } });
    check('إفراج بمرجع التحويلة يُسجَّل والمبلغ «مُفرَج عنه» بالمرجع', r.status === 200 && r.body.item.escrow_status === 'released' && r.body.item.released_ref === 'REL-E1', JSON.stringify(r.body.item || {}));
    r = await api('POST', `/api/bookings/${e1}/release-response`, { token: escT.token, body: { received: true } });
    check('المنفذ يؤكد وصول الإفراج', r.status === 200 && r.body.booking.escrow_release_seen === 'received');
    r = await api('POST', `/api/bookings/${e1}/release-response`, { token: escT.token, body: { received: true } });
    check('رد المنفذ على الإفراج مرة واحدة فقط 400', r.status === 400);

    /* E2: المنفذ يعلّم الإفراج «ماوصلش» → تنبيه فوري للمالك */
    const e2 = await escDrive(200, 'E2');
    await api('POST', `/api/bookings/${e2}/confirm-receipt`, { token: escC.token });
    await api('POST', `/api/bookings/${e2}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E2' } });
    const e2fin = await finObOf(e2);
    await api('POST', `/api/owner/money/${e2fin.id}/confirm`, { token: founderTok, body: {} });
    await api('POST', `/api/owner/escrow/${e2}/release`, { token: founderTok, body: { ref: 'REL-E2' } });
    r = await api('POST', `/api/bookings/${e2}/release-response`, { token: escT.token, body: { received: false } });
    check('المنفذ يعلّم الإفراج «ماوصلش»', r.status === 200 && r.body.booking.escrow_release_seen === 'missing');
    r = await api('GET', '/api/notifications', { token: founderTok });
    check('تنبيه «ماوصلش» وصل المالك فوراً', (r.body.items || []).some((n) => n.type === 'escrow_missing' && /ماوصلش/.test(n.text || '')));

    /* E3: لا تنبيه ١٢ ساعة ولا تأكيد زمني أبداً — تحكيم ثم قرار مالك «إفراج» */
    const e3 = await escDrive(300, 'E3');
    await pgSet('UPDATE bookings SET proof_at=$1 WHERE id=$2', [Date.now() - 13 * 3600 * 1000, e3]);
    await api('GET', '/api/bookings', { token: escC.token });
    const warnN = async () => (await api('GET', '/api/notifications', { token: escC.token })).body.items.filter((n) => /١٢ ساعة/.test(n.text || '') && (n.text || '').includes('#' + e3)).length;
    check('لا تنبيه ١٢ ساعة في نموذج باينانس إطلاقاً', (await warnN()) === 0);
    r = await api('GET', `/api/bookings/${e3}`, { token: escC.token });
    check('عند ١٣ ساعة الحجز لم يُؤكَّد تلقائياً بعد', r.body.booking.status === 'proof_submitted');
    await pgSet('UPDATE bookings SET proof_at=$1 WHERE id=$2', [Date.now() - 23 * 3600 * 1000, e3]);
    await api('GET', '/api/bookings', { token: escC.token });
    r = await api('GET', `/api/bookings/${e3}`, { token: escC.token });
    check('عند ٢٣ ساعة لم يُؤكَّد بعد (لا نافذة تأكيد زمنية)', r.body.booking.status === 'proof_submitted');
    await pgSet('UPDATE bookings SET proof_at=$1 WHERE id=$2', [Date.now() - 25 * 3600 * 1000, e3]);
    await api('GET', '/api/bookings', { token: escC.token });
    r = await api('GET', `/api/bookings/${e3}`, { token: escC.token });
    check('عند ٢٥ ساعة لا تأكيد تلقائي (receipt_auto=0) — بانتظار التأكيد', r.body.booking.status === 'proof_submitted' && !r.body.booking.receipt_auto && !r.body.booking.receipt_confirmed_at, `status=${r.body.booking.status}`);
    r = await api('POST', `/api/bookings/${e3}/appeal`, { token: escT.token });
    check('تحكيم المنفذ بعد سكوت العميل ينجح', r.status === 200 && !!r.body.booking.appeal, `status=${r.status}`);
    const e3appeal = (await api('GET', '/api/owner/appeals', { token: founderTok })).body.items.find((a) => a.booking_id === e3);
    check('تحكيم E3 ظاهر للمالك بقائمته', !!e3appeal);
    r = await api('POST', `/api/owner/appeals/${e3appeal.id}/decide`, { token: founderTok, body: { action: 'release' } });
    check('قرار المالك «إفراج» من التحكيم يُقبل', r.status === 200, `status=${r.status}`);
    r = await api('GET', `/api/bookings/${e3}`, { token: escC.token });
    check('قرار «إفراج» = تأكيد استلام موثّق: خطوة الاحتجاز مفتوحة بلا receipt_auto', r.body.booking.status === 'awaiting_rest' && r.body.booking.escrow_status === 'awaiting_transfer' && !!r.body.booking.receipt_confirmed_at && !r.body.booking.receipt_auto, `status=${r.body.booking.status} escrow=${r.body.booking.escrow_status}`);

    /* E3B: احتجاز قبل تأكيد الاستلام — التأكيد التلقائي يكمل فوراً */
    const e3b = await escDrive(300, 'E3B');
    await api('POST', `/api/bookings/${e3b}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E3B' } });
    const e3bfin = await finObOf(e3b);
    await api('POST', `/api/owner/money/${e3bfin.id}/confirm`, { token: founderTok, body: {} });
    r = await api('GET', `/api/bookings/${e3b}`, { token: escT.token });
    check('احتجاز قبل تأكيد الاستلام: المبلغ «محتجَز» والحجز لم يكتمل بعد', r.body.booking.escrow_status === 'held' && r.body.booking.status === 'proof_submitted', `escrow=${r.body.booking.escrow_status} status=${r.body.booking.status}`);
    await pgSet('UPDATE bookings SET proof_at=$1 WHERE id=$2', [Date.now() - 25 * 3600 * 1000, e3b]);
    await api('GET', '/api/bookings', { token: escC.token });
    r = await api('GET', `/api/bookings/${e3b}`, { token: escT.token });
    check('مرور ٢٥ ساعة بلا تأكيد ولا تحكيم: المحتجَز باقٍ «محتجَز» والحجز لم يكتمل', r.body.booking.status === 'proof_submitted' && r.body.booking.escrow_status === 'held', `escrow=${r.body.booking.escrow_status} status=${r.body.booking.status}`);
    await api('POST', `/api/bookings/${e3b}/appeal`, { token: escT.token });
    const e3bAppeal = (await api('GET', '/api/owner/appeals', { token: founderTok })).body.items.find((a) => a.booking_id === e3b);
    r = await api('POST', `/api/owner/appeals/${e3bAppeal.id}/decide`, { token: founderTok, body: { action: 'release' } });
    r = await api('GET', `/api/bookings/${e3b}`, { token: escT.token });
    check('قرار تحكيم «إفراج» مع باقٍ محتجَز أصلاً → اكتمال فوري «جاهز للإفراج»', r.body.booking.status === 'completed' && r.body.booking.escrow_status === 'ready_release');
    r = await api('GET', `/api/bookings/${e3b}/evidence`, { token: escT.token });
    check('قرار التحكيم مسجّل في حزمة الأدلة (decided_release)', ((r.body.evidence || {}).appeals || []).some((a) => a.status === 'decided_release'));

    /* E4: نزاع يجمّد المحتجَز + حزمة أدلة + رد للعميل من التجميد */
    const e4 = await escDrive(500, 'E4');
    await api('POST', `/api/bookings/${e4}/confirm-receipt`, { token: escC.token });
    await api('POST', `/api/bookings/${e4}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E4' } });
    const e4fin = await finObOf(e4);
    await api('POST', `/api/owner/money/${e4fin.id}/confirm`, { token: founderTok, body: {} });
    r = await api('POST', `/api/bookings/${e4}/dispute`, { token: escC.token, body: { reason: 'الشغل مش زي الاتفاق' } });
    check('نزاع على حجز مكتمل باقيه محتجَز يُفتح (لحظة حماية الاحتجاز الحقيقية)', r.status === 200, `status=${r.status}`);
    r = await api('GET', `/api/bookings/${e4}`, { token: escT.token });
    check('النزاع يجمّد المحتجَز فوراً', r.body.booking.status === 'disputed' && r.body.booking.escrow_status === 'frozen_dispute', `escrow=${r.body.booking.escrow_status}`);
    r = await api('GET', `/api/bookings/${e4}/evidence`, { token: escT.token });
    const ev4 = r.body.evidence || {};
    check('حزمة الأدلة للمنفذ: إثبات تنفيذ + مرجع عمولة + التزام أخيرة + خط زمني', !!ev4.proof && !!ev4.proof.url && (ev4.obligations || []).some((o) => o.kind === 'booking_final') && (ev4.payments || []).some((p) => p.kind === 'fee' && !!p.ref) && (ev4.timeline || []).length >= 4, JSON.stringify(ev4).slice(0, 200));
    r = await api('GET', `/api/bookings/${e4}/evidence`, { token: founderTok });
    check('حزمة الأدلة متاحة للمالك أيضاً', r.status === 200 && !!r.body.evidence);
    r = await api('GET', `/api/bookings/${e4}/evidence`, { token: shopTok });
    check('حزمة الأدلة ممنوعة على غير الأطراف 404', r.status === 404);
    r = await api('POST', `/api/owner/escrow/${e4}/refund`, { token: founderTok, body: {} });
    check('رد المحتجَز المجمّد للعميل من لوحة المالك', r.status === 200 && r.body.item.escrow_status === 'refunded', JSON.stringify(r.body.item || {}));
    r = await api('GET', `/api/bookings/${e4}`, { token: escC.token });
    check('بعد الرد: الحجز ملغي والمبلغ «مردود» عند الطرفين', r.body.booking.status === 'cancelled' && r.body.booking.escrow_status === 'refunded');

    /* E4B: حل نزاع بإعادة المسار يفك تجميد الاحتجاز */
    const e4b = await escDrive(200, 'E4B');
    await api('POST', `/api/bookings/${e4b}/confirm-receipt`, { token: escC.token });
    await api('POST', `/api/bookings/${e4b}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E4B' } });
    const e4bfin = await finObOf(e4b);
    await api('POST', `/api/owner/money/${e4bfin.id}/confirm`, { token: founderTok, body: {} });
    const dspB = await api('POST', `/api/bookings/${e4b}/dispute`, { token: escT.token, body: { reason: 'خلاف على التفاصيل' } });
    r = await api('GET', `/api/bookings/${e4b}`, { token: escC.token });
    check('نزاع المنفذ يجمّد المحتجَز أيضاً', r.body.booking.escrow_status === 'frozen_dispute');
    await api('POST', `/api/owner/disputes/${dspB.body.dispute_id}/resolve`, { token: founderTok, body: { action: 'restore' } });
    r = await api('GET', `/api/bookings/${e4b}`, { token: escC.token });
    check('حل النزاع بإعادة المسار يفك التجميد ويرجع «جاهز للإفراج»', r.body.booking.status === 'completed' && r.body.booking.escrow_status === 'ready_release', `status=${r.body.booking.status} escrow=${r.body.booking.escrow_status}`);

    /* E5: رفض المالك لتحويلة الباقي → رجوع لانتظار تحويل + إعادة دفع تنجح */
    const e5 = await escDrive(200, 'E5');
    await api('POST', `/api/bookings/${e5}/confirm-receipt`, { token: escC.token });
    await api('POST', `/api/bookings/${e5}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E5' } });
    const e5fin = await finObOf(e5);
    await api('POST', `/api/owner/money/${e5fin.id}/reject`, { token: founderTok, body: {} });
    r = await api('GET', `/api/bookings/${e5}`, { token: escC.token });
    check('رفض المالك لتحويلة الباقي: الاحتجاز يرجع «بانتظار تحويل»', r.body.booking.escrow_status === 'awaiting_transfer' && r.body.booking.status === 'awaiting_rest', `escrow=${r.body.booking.escrow_status}`);
    r = await api('POST', `/api/bookings/${e5}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E5B' } });
    check('العميل يعيد تحويل الباقي بمرجع جديد بعد الرفض', r.status === 200 && r.body.booking.escrow_status === 'awaiting_confirmation');
    const e5fin2 = await finObOf(e5);
    check('التزام جديد للباقي بعد الرفض (ليس الملغي)', !!e5fin2 && e5fin2.id !== e5fin.id);
    await api('POST', `/api/owner/money/${e5fin2.id}/confirm`, { token: founderTok, body: {} });
    r = await api('GET', `/api/bookings/${e5}`, { token: escC.token });
    check('بعد إعادة التحويل والتأكيد: اكتمال وجاهزية إفراج', r.body.booking.status === 'completed' && r.body.booking.escrow_status === 'ready_release');

    /* E6: تأكيد تلقائي بالإيصال الصارم على التزام الدفعة الأخيرة */
    const e6 = await escDrive(400, 'E6');
    await api('POST', `/api/bookings/${e6}/confirm-receipt`, { token: escC.token });
    r = await api('GET', `/api/money/obligation?kind=booking_final&booking_id=${e6}`, { token: escC.token });
    const e6ob = r.body.obligation || {};
    const imgE6 = receiptImg('escrow-e6');
    r = await api('POST', '/api/money/verify-receipt', { token: escC.token, body: { obligation_code: e6ob.code, image: imgE6.dataUrl, image_hash: imgE6.hash, extracted: { amount: e6ob.exact_amount, recipient_digits: TEST_PHONE, transfer_ref: 'AUTO-E6', date: Date.now() } } });
    check('احتجاز: إيصال مطابق لكل الشروط على الأخيرة → تأكيد تلقائي', r.status === 200 && r.body.verdict === 'auto_confirmed', JSON.stringify(r.body));
    r = await api('GET', `/api/bookings/${e6}`, { token: escT.token });
    check('بعد تأكيد الإيصال: المبلغ محتجَز والحجز مكتمل «جاهز للإفراج»', r.body.booking.status === 'completed' && r.body.booking.escrow_status === 'ready_release', `escrow=${r.body.booking.escrow_status}`);

    /* E7: نافذة رفض مرجع العمولة ٢٤ ساعة — بعدها الرفض ممنوع */
    const e7rb = await api('POST', '/api/bookings', { token: escC.token, body: { talent_id: escT.user.id, price: 100 } });
    const e7 = e7rb.body.booking.id;
    await api('POST', `/api/bookings/${e7}/agree`, { token: escC.token });
    await api('POST', `/api/bookings/${e7}/agree`, { token: escT.token });
    await api('POST', `/api/bookings/${e7}/pay`, { token: escC.token, body: { kind: 'fee', ref: 'EF-E7' } });
    await pgSet('UPDATE bookings SET fee_confirmed_at=$1 WHERE id=$2', [Date.now() - 25 * 3600 * 1000, e7]);
    r = await api('POST', `/api/owner/bookings/${e7}/reject-fee`, { token: founderTok });
    check('رفض مرجع عمولة بعد نافذة الـ٢٤ ساعة مرفوض 400', r.status === 400, `status=${r.status}`);

    /* E8: الدعم الآلي — موضوع P2P ونموذج التحكيم بدل التأكيد التلقائي */
    r = await api('POST', '/api/support/ask', { body: { q: 'هل المعاملات P2P بين المحافظ الشخصية؟', lang: 'ar' } });
    check('دعم آلي: سؤال P2P يطابق موضوع p2p ونصه المعتمد (مش بنك)', r.body.topic === 'p2p' && /مش بنك/.test(r.body.answer || ''), JSON.stringify(r.body).slice(0, 160));
    r = await api('POST', '/api/support/ask', { body: { q: 'ما هو التأكيد التلقائي؟', lang: 'ar' } });
    check('دعم آلي: لا تأكيد تلقائي — الإجابة تشرح التحكيم بعد ٣ ساعات وقرار المالك النهائي', r.body.topic === 'auto_confirm' && /لا يوجد تأكيد تلقائي/.test(r.body.answer || '') && /تحكيم/.test(r.body.answer || '') && /٣ ساعات/.test(r.body.answer || ''), JSON.stringify(r.body).slice(0, 160));

    /* E9: احتجاز الضيف كاملاً من صفحة الرمز + حزمة أدلته */
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل احتجاز', phone: '01055598765', city: 'Cairo', niche: 'Tech', budget: 400, details: 'فيديو احتجاز' } });
    const gTokE = r.body.token, gReqE = r.body.id;
    await api('POST', `/api/guest-requests/${gReqE}/book`, { token: escT.token, body: {} });
    await api('POST', `/api/guest/${gTokE}/agree`, { body: {} });
    let ge = await api('GET', `/api/guest/${gTokE}`);
    const gBidE = ge.body.booking.id;
    if (ge.body.booking.status === 'pending_agreement') await api('POST', `/api/bookings/${gBidE}/agree`, { token: escT.token });
    await api('POST', `/api/guest/${gTokE}/pay`, { body: { kind: 'fee', ref: 'GF-E9' } });
    await api('POST', `/api/guest/${gTokE}/pay`, { body: { kind: 'deposit', ref: 'GD-E9' } });
    await api('POST', `/api/bookings/${gBidE}/proof`, { token: escT.token, body: { url: `${AUX}/proof-ok` } });
    await api('POST', `/api/guest/${gTokE}/confirm-receipt`, { body: {} });
    r = await api('GET', `/api/guest/${gTokE}/obligation?kind=booking_final`);
    check('احتجاز ضيف: التزام الأخيرة من صفحة الرمز مستلمه المالك', r.status === 200 && !!r.body.obligation && r.body.obligation.payee === 'owner', JSON.stringify(r.body.obligation || {}));
    await api('POST', `/api/guest/${gTokE}/pay`, { body: { kind: 'rest', ref: 'GR-E9' } });
    ge = await api('GET', `/api/guest/${gTokE}`);
    check('احتجاز ضيف: تسجيل الباقي لا يكمل الحجز', ge.body.booking.status !== 'completed' && ge.body.booking.escrow_status === 'awaiting_confirmation', `escrow=${ge.body.booking.escrow_status}`);
    const e9fin = await finObOf(gBidE);
    await api('POST', `/api/owner/money/${e9fin.id}/confirm`, { token: founderTok, body: {} });
    ge = await api('GET', `/api/guest/${gTokE}`);
    check('احتجاز ضيف: تأكيد الاحتجاز يكمل الحجز في صفحة الرمز', ge.body.booking.status === 'completed' && ge.body.booking.escrow_status === 'ready_release');
    r = await api('GET', `/api/guest/${gTokE}/evidence`);
    check('حزمة أدلة الضيف متاحة من صفحة الرمز', r.status === 200 && !!r.body.evidence && !!r.body.evidence.booking && r.body.evidence.booking.id === gBidE);

    /* E10: حراس بنيوية — ٢٤ ساعة في الواجهة + مكونات الاحتجاز + ثوابت الخادم */
    const pubHtmlE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check('واجهة بلا «٤٨ ساعة» ولا «48 hours» إطلاقاً والشريط المتحرك بإفراج فوري عند التأكيد', !pubHtmlE.includes('٤٨ ساعة') && !pubHtmlE.includes('48 hours') && pubHtmlE.includes('إفراج فوري عند تأكيد الاستلام'));
    check('بنيوي: لا «تأكيد تلقائي» ولا auto-confirm في الواجهة إطلاقاً (نموذج باينانس)', !pubHtmlE.includes('تأكيد تلقائي') && !pubHtmlE.includes('auto-confirm') && !pubHtmlE.includes('auto confirm'));
    check('بنيوي: لا «شغلان» ولا «واتساب» ولا WhatsApp ولا wa.me في الواجهة والخادم — و«طلب خدمة» حاضرة', !pubHtmlE.includes('شغلان') && !pubHtmlE.includes('واتساب') && !pubHtmlE.includes('WhatsApp') && !pubHtmlE.includes('wa.me') && !serverSrc.includes('شغلان') && pubHtmlE.includes('طلب خدمة') && pubHtmlE.includes('Request a service'));
    check('بنيوي: أيقونات مصغّرة (عقدة رحلة 40 وشارة ثقة 28 وأيقونة P2P 42 ورقم خطوة 40 وشريط سفلي ≤24)', /\.journey-node\{width:40px/.test(pubHtmlE) && /\.trust-badge-symbol\{width:28px/.test(pubHtmlE) && /\.trust-p2p-ic\{width:42px/.test(pubHtmlE) && /\.how-num\{font-size:40px/.test(pubHtmlE) && /\.tabbar button svg\{width:23px/.test(pubHtmlE));
    check('بنيوي: بطاقة العربون العائمة محذوفة من الهيرو وبطاقة الهاتف الداخلية بلا مبلغ ولا نسبة', !pubHtmlE.includes('mock_pay') && !pubHtmlE.includes('fw2') && !pubHtmlE.includes('ph-amt') && !pubHtmlE.includes('+38%') && pubHtmlE.includes('mock_paid'));
    check('قاموس: تسميات باينانس وحالات الطلب في القاموسين معاً', pubHtmlE.includes("paid_btn:'حوّلت — أبلغ الطرف الآخر'") && pubHtmlE.includes("paid_btn:'I transferred — notify the other side'") && pubHtmlE.includes("os_paid_awaiting:'تم الدفع — بانتظار تأكيد الاستلام'") && pubHtmlE.includes("os_paid_awaiting:'Paid — awaiting receipt confirmation'") && pubHtmlE.includes("os_arbitration:'قيد التحكيم'") && pubHtmlE.includes("os_arbitration:'Under arbitration'"));
    check('واجهة الاحتجاز: حالات الاحتجاز وشرح P2P وحوار إفراج المالك وحزمة الأدلة في القاموسين والمكونات', pubHtmlE.includes('esc_held_d') && pubHtmlE.includes('p2p_note') && pubHtmlE.includes('ow_escrow_t') && pubHtmlE.includes('ow_escrow_state_ready_release') && pubHtmlE.includes('id="escrowDlg"') && pubHtmlE.includes('id="evDlg"') && pubHtmlE.includes('escBlockHtml') && pubHtmlE.includes('/api/owner/escrow'));
    check('خادم: نافذة رفض العمولة ٢٤ ساعة ومهلة دفع موحّدة ٢٤ ساعة وموضوع p2p وثابت تحكيم ٣ ساعات — وغياب أي تأكيد/تنبيه زمني', /FEE_REVIEW_WINDOW_MS = 24 \* 3600 \* 1000/.test(serverSrc) && /MONEY_OB_TTL_MS = 24 \* 3600 \* 1000/.test(serverSrc) && /APPEAL_AFTER_MS = 3 \* 3600 \* 1000/.test(serverSrc) && serverSrc.includes("id: 'p2p'") && !serverSrc.includes('RECEIPT_WARN_MS') && !serverSrc.includes('RECEIPT_AUTO_CONFIRM_MS') && !serverSrc.includes('sweepAutoConfirm'));

    /* E11: التحكيم — توقيت ٣ ساعات + حماية العميل + قرار الرد + تكافؤ الضيف */
    const e11 = await escDrive(200, 'E11');
    r = await api('POST', `/api/bookings/${e11}/appeal`, { token: escT.token });
    check('طلب تحكيم قبل ٣ ساعات من الإثبات مرفوض 400', r.status === 400, `status=${r.status}`);
    r = await api('POST', `/api/bookings/${e11}/appeal`, { token: escC.token });
    check('طلب التحكيم للمنفذ فقط — العميل مرفوض 403', r.status === 403, `status=${r.status}`);
    await pgSet('UPDATE bookings SET proof_at=$1 WHERE id=$2', [Date.now() - 4 * 3600 * 1000, e11]);
    r = await api('POST', `/api/bookings/${e11}/appeal`, { token: escT.token });
    check('طلب تحكيم بعد ٣ ساعات ينجح', r.status === 200 && !!r.body.booking.appeal, `status=${r.status}`);
    r = await api('POST', `/api/bookings/${e11}/appeal`, { token: escT.token });
    check('طلب تحكيم ثانٍ أثناء قائم مرفوض 400', r.status === 400, `status=${r.status}`);
    r = await api('POST', `/api/bookings/${e11}/appeal-note`, { token: escC.token, body: { note: 'هستلم بكرة الصبح' } });
    check('ملاحظة العميل داخل التحكيم تُقبل', r.status === 200, `status=${r.status}`);
    const e11appeal = (await api('GET', '/api/owner/appeals', { token: founderTok })).body.items.find((a) => a.booking_id === e11);
    check('ملاحظة العميل ظاهرة للمالك داخل التحكيم', !!e11appeal && (e11appeal.client_note || '').includes('هستلم بكرة'));
    r = await api('POST', `/api/bookings/${e11}/dispute`, { token: escC.token, body: { reason: 'الشغل ناقص' } });
    check('نزاع العميل أثناء تحكيم قائم يُفتح بنجاح', r.status === 200, `status=${r.status}`);
    r = await api('GET', `/api/bookings/${e11}`, { token: escC.token });
    check('النزاع يجمّد الحجز فوراً ويغلق التحكيم لصالح مسار النزاع وحالة الطلب «قيد التحكيم»', r.body.booking.status === 'disputed' && !r.body.booking.appeal && r.body.booking.order_state === 'under_arbitration', `status=${r.body.booking.status}`);
    r = await api('GET', '/api/owner/appeals', { token: founderTok });
    check('التحكيم المغلق بالنزاع يختفي من قائمة المالك', !(r.body.items || []).some((a) => a.booking_id === e11));

    /* E11B: قرار «رد» على باقٍ محتجَز */
    const e11b = await escDrive(300, 'E11B');
    await api('POST', `/api/bookings/${e11b}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E11B' } });
    const e11bfin = await finObOf(e11b);
    await api('POST', `/api/owner/money/${e11bfin.id}/confirm`, { token: founderTok, body: {} });
    await pgSet('UPDATE bookings SET proof_at=$1 WHERE id=$2', [Date.now() - 4 * 3600 * 1000, e11b]);
    await api('POST', `/api/bookings/${e11b}/appeal`, { token: escT.token });
    const e11bAppeal = (await api('GET', '/api/owner/appeals', { token: founderTok })).body.items.find((a) => a.booking_id === e11b);
    r = await api('POST', `/api/owner/appeals/${e11bAppeal.id}/decide`, { token: founderTok, body: { action: 'refund' } });
    check('قرار المالك «رد» من التحكيم يُقبل', r.status === 200, `status=${r.status}`);
    r = await api('GET', `/api/bookings/${e11b}`, { token: escC.token });
    check('قرار «رد»: المحتجَز مردود والحجز ملغي', r.body.booking.status === 'cancelled' && r.body.booking.escrow_status === 'refunded', `status=${r.body.booking.status} escrow=${r.body.booking.escrow_status}`);

    /* E11C: تكافؤ الضيف في التحكيم من صفحة الرمز */
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل تحكيم', phone: '01055511122', city: 'Cairo', niche: 'Tech', budget: 400, details: 'فيديو تحكيم' } });
    const gTokA = r.body.token, gReqA = r.body.id;
    await api('POST', `/api/guest-requests/${gReqA}/book`, { token: escT.token, body: {} });
    await api('POST', `/api/guest/${gTokA}/agree`, { body: {} });
    let geA = await api('GET', `/api/guest/${gTokA}`);
    const gBidA = geA.body.booking.id;
    if (geA.body.booking.status === 'pending_agreement') await api('POST', `/api/bookings/${gBidA}/agree`, { token: escT.token });
    await api('POST', `/api/guest/${gTokA}/pay`, { body: { kind: 'fee', ref: 'GF-E11C' } });
    await api('POST', `/api/guest/${gTokA}/pay`, { body: { kind: 'deposit', ref: 'GD-E11C' } });
    await api('POST', `/api/bookings/${gBidA}/proof`, { token: escT.token, body: { url: `${AUX}/proof-ok` } });
    await pgSet('UPDATE bookings SET proof_at=$1 WHERE id=$2', [Date.now() - 4 * 3600 * 1000, gBidA]);
    r = await api('POST', `/api/bookings/${gBidA}/appeal`, { token: escT.token });
    check('تحكيم على حجز ضيف ينجح', r.status === 200, `status=${r.status}`);
    geA = await api('GET', `/api/guest/${gTokA}`);
    check('الضيف يرى التحكيم القائم وحالة الطلب في صفحة رمزه', !!geA.body.booking.appeal && geA.body.booking.order_state === 'paid_awaiting_confirmation');
    r = await api('POST', `/api/guest/${gTokA}/appeal-note`, { body: { note: 'وصلني جزء بس' } });
    check('ملاحظة الضيف داخل التحكيم تُقبل من صفحة الرمز', r.status === 200, `status=${r.status}`);
    r = await api('POST', `/api/guest/${gTokA}/confirm-receipt`, { body: {} });
    geA = await api('GET', `/api/guest/${gTokA}`);
    check('تأكيد الضيف يكمل المسار ويغلق التحكيم', geA.body.booking.status === 'awaiting_rest' && !geA.body.booking.appeal, `status=${geA.body.booking.status}`);

    /* E11D: سكوت طويل جداً بلا تحكيم — لا شيء يتحرك أبداً */
    const e11d = await escDrive(200, 'E11D');
    await pgSet('UPDATE bookings SET proof_at=$1 WHERE id=$2', [Date.now() - 100 * 3600 * 1000, e11d]);
    await api('GET', '/api/bookings', { token: escC.token });
    r = await api('GET', `/api/bookings/${e11d}`, { token: escC.token });
    check('سكوت ١٠٠ ساعة بلا تحكيم: الحجز بانتظار التأكيد ولا مليم تحرك', r.body.booking.status === 'proof_submitted' && !r.body.booking.receipt_confirmed_at && !r.body.booking.receipt_auto);

    /* E12: حالات الطلب الصريحة بالترتيب + مهلة دفع حاسمة + مطالبة كاذبة */
    const e12 = (await api('POST', '/api/bookings', { token: escC.token, body: { talent_id: escT.user.id, price: 200 } })).body.booking.id;
    r = await api('GET', `/api/bookings/${e12}`, { token: escC.token });
    check('حالة الطلب عند الإنشاء: «بانتظار الدفع»', r.body.booking.order_state === 'awaiting_payment');
    await api('POST', `/api/bookings/${e12}/agree`, { token: escC.token });
    await api('POST', `/api/bookings/${e12}/agree`, { token: escT.token });
    await api('POST', `/api/bookings/${e12}/pay`, { token: escC.token, body: { kind: 'fee', ref: 'EF-E12' } });
    await api('POST', `/api/bookings/${e12}/pay`, { token: escC.token, body: { kind: 'deposit', ref: 'ED-E12' } });
    await api('POST', `/api/bookings/${e12}/proof`, { token: escT.token, body: { url: `${AUX}/proof-ok` } });
    r = await api('GET', `/api/bookings/${e12}`, { token: escC.token });
    check('حالة الطلب بعد الإثبات: «تم الدفع — بانتظار تأكيد الاستلام»', r.body.booking.order_state === 'paid_awaiting_confirmation');
    await api('POST', `/api/bookings/${e12}/confirm-receipt`, { token: escC.token });
    r = await api('GET', `/api/bookings/${e12}`, { token: escC.token });
    check('حالة الطلب بعد التأكيد: «تم التأكيد — بانتظار الإفراج»', r.body.booking.order_state === 'confirmed_awaiting_release');
    await api('POST', `/api/bookings/${e12}/pay`, { token: escC.token, body: { kind: 'rest', ref: 'ER-E12' } });
    const e12fin = await finObOf(e12);
    await api('POST', `/api/owner/money/${e12fin.id}/confirm`, { token: founderTok, body: {} });
    r = await api('GET', `/api/bookings/${e12}`, { token: escC.token });
    check('اكتمال الحجز مع محتجَز جاهز: الحالة تبقى «بانتظار الإفراج»', r.body.booking.status === 'completed' && r.body.booking.order_state === 'confirmed_awaiting_release');
    await api('POST', `/api/owner/escrow/${e12}/release`, { token: founderTok, body: { ref: 'REL-E12' } });
    r = await api('GET', `/api/bookings/${e12}`, { token: escC.token });
    check('بعد إفراج المالك الفعلي بمرجع: حالة الطلب «مكتملة»', r.body.booking.order_state === 'completed');

    /* مهلة الدفع ٢٤ ساعة حاسمة: انتهاء بلا إعلان دفع = إلغاء نهائي بلا حركة مال */
    const e12x = (await api('POST', '/api/bookings', { token: escC.token, body: { talent_id: escT.user.id, price: 150 } })).body.booking.id;
    await api('POST', `/api/bookings/${e12x}/agree`, { token: escC.token });
    await api('POST', `/api/bookings/${e12x}/agree`, { token: escT.token });
    const e12fee = await api('GET', `/api/bookings/${e12x}/fee-info`, { token: escC.token });
    check('التزام العمولة بمهلة دفع موحّدة ٢٤ ساعة وعدّاد حي (expires_at مكشوف)', !!e12fee.body.obligation && Math.abs((e12fee.body.obligation.expires_at - e12fee.body.obligation.created_at) - 24 * 3600 * 1000) < 5000, JSON.stringify(e12fee.body.obligation || {}).slice(0, 160));
    await pgSet('UPDATE money_obligations SET expires_at=$1 WHERE booking_id=$2 AND kind=$3', [Date.now() - 1000, e12x, 'booking_commission']);
    await api('GET', '/api/bookings', { token: escC.token });
    r = await api('GET', `/api/bookings/${e12x}`, { token: escC.token });
    check('انتهاء مهلة الدفع بلا إعلان دفع: إلغاء تلقائي نهائي وحالة الطلب «ملغية»', r.body.booking.status === 'cancelled' && r.body.booking.order_state === 'cancelled', `status=${r.body.booking.status}`);
    const e12xOb = (await api('GET', '/api/owner/money', { token: founderTok })).body.items.find((o) => o.kind === 'booking_commission' && o.booking_id === e12x);
    check('الالتزام المنتهي موسوم «expired» في قائمة المالك', !!e12xOb && e12xOb.status === 'expired');
    const e12xDetail = await api('GET', `/api/owner/money/${e12xOb.id}`, { token: founderTok });
    check('سجل الالتزام يوثّق الإلغاء النظيف (expired) وبلا أي تأكيد/تحويل', (e12xDetail.body.ledger || []).some((l) => l.to_status === 'expired') && !(e12xDetail.body.ledger || []).some((l) => ['confirmed', 'auto_confirmed'].includes(l.to_status)));
    r = await api('GET', '/api/notifications', { token: escT.token });
    check('الطرفان يُنبَّهان بالإلغاء التلقائي النهائي', (r.body.items || []).some((n) => n.type === 'order_cancelled' && (n.text || '').includes('#' + e12x)));

    /* مطالبة قائمة تمنع الإلغاء التلقائي نهائياً */
    const e12y = (await api('POST', '/api/bookings', { token: escC.token, body: { talent_id: escT.user.id, price: 150 } })).body.booking.id;
    await api('POST', `/api/bookings/${e12y}/agree`, { token: escC.token });
    await api('POST', `/api/bookings/${e12y}/agree`, { token: escT.token });
    await api('GET', `/api/bookings/${e12y}/fee-info`, { token: escC.token });
    await api('POST', `/api/bookings/${e12y}/pay`, { token: escC.token, body: { kind: 'fee', ref: 'EF-E12Y' } });
    await pgSet('UPDATE money_obligations SET expires_at=$1 WHERE booking_id=$2 AND kind=$3', [Date.now() - 1000, e12y, 'booking_commission']);
    await api('GET', '/api/bookings', { token: escC.token });
    r = await api('GET', `/api/bookings/${e12y}`, { token: escC.token });
    check('وجود إعلان دفع/مطالبة قائمة: لا إلغاء تلقائي أبداً — المسار تأكيد أو تحكيم', r.body.booking.status !== 'cancelled', `status=${r.body.booking.status}`);

    /* إعلان «حوّلت» كاذب → سلم العقوبات المتدرج القائم + توثيق الاحتيال */
    const fcC = (await api('POST', '/api/auth/register', { body: { name: 'Fake Claim Client', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'fakeclaim@test', price: 100 } })).body;
    const fcT = (await api('POST', '/api/auth/register', { body: { name: 'Fake Claim Talent', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'faketalent@test', price: 200 } })).body;
    const fcDrive = async (tag) => {
      const id = (await api('POST', '/api/bookings', { token: fcC.token, body: { talent_id: fcT.user.id, price: 200 } })).body.booking.id;
      await api('POST', `/api/bookings/${id}/agree`, { token: fcC.token });
      await api('POST', `/api/bookings/${id}/agree`, { token: fcT.token });
      await api('GET', `/api/bookings/${id}/fee-info`, { token: fcC.token });
      await api('POST', `/api/bookings/${id}/pay`, { token: fcC.token, body: { kind: 'fee', ref: 'FAKE-' + tag } });
      return id;
    };
    const fc1 = await fcDrive('1');
    const fc1ob = (await api('GET', '/api/owner/money', { token: founderTok })).body.items.find((o) => o.kind === 'booking_commission' && o.booking_id === fc1);
    check('مطالبة العمولة مسجّلة «claimed» قبل قرار المالك', !!fc1ob && fc1ob.status === 'claimed', `status=${fc1ob && fc1ob.status}`);
    r = await api('POST', `/api/owner/money/${fc1ob.id}/reject`, { token: founderTok, body: { reason: 'التحويلة لم تصل فعلياً' } });
    check('رفض المالك للمطالبة يُقبل', r.status === 200, `status=${r.status}`);
    const fc1after = (await api('GET', '/api/owner/money', { token: founderTok })).body.items.find((o) => o.id === fc1ob.id);
    check('المطالبة الكاذبة موسومة بعلم الاحتيال وموثّقة في السجل', !!fc1after && (fc1after.fraud_flag === true || fc1after.fraud_flag === 1), JSON.stringify(fc1after || {}).slice(0, 160));
    r = await api('GET', '/api/me', { token: fcC.token });
    check('أول مطالبة كاذبة: تنبيه رسمي في سلم العقوبات (warning)', r.body.user.penalty_level === 'warning', `level=${r.body.user && r.body.user.penalty_level}`);
    const fc2 = await fcDrive('2');
    const fc2ob = (await api('GET', '/api/owner/money', { token: founderTok })).body.items.find((o) => o.kind === 'booking_commission' && o.booking_id === fc2);
    await api('POST', `/api/owner/money/${fc2ob.id}/reject`, { token: founderTok, body: { reason: 'التحويلة لم تصل فعلياً' } });
    r = await api('GET', '/api/me', { token: fcC.token });
    check('ثاني مطالبة كاذبة: تعليق وتجميد في سلم العقوبات (suspended + frozen)', r.body.user.penalty_level === 'suspended' && (r.body.user.frozen === true || r.body.user.frozen === 1), `level=${r.body.user && r.body.user.penalty_level} frozen=${r.body.user && r.body.user.frozen}`);

    /* ===== أمان الرقم + الأصول ===== */
    const pubDir = path.join(__dirname, '..', 'public');
    let leak = false;
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (fs.readFileSync(p, 'utf8').includes(TEST_PHONE)) leak = true;
      }
    })(pubDir);
    check('رقم عمولات التطبيق غير موجود في أي ملف واجهة (public/)', !leak);

    let assetsOk = true;
    for (const p of ['/', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png']) {
      const rr = await fetch(BASE + p);
      if (rr.status !== 200) assetsOk = false;
    }
    const health = await api('GET', '/api/health');
    check('الأصول الثابتة كلها 200 + فحص الصحة سليم', assetsOk && health.body.ok === true);

    /* ===== حارس انحدار الواجهة: زر «ابدأ حجز» وتحويل طلب الضيف =====
       العطل الأصلي: المعالج كان يبدأ بـ prompt() الأصلي — وفي بيئات يُخمَد فيها
       (متصفحات فحص آلي/ويب-فيو) يموت بصمت. الحارس هنا مزيج:
       (1) بنيوي: تصريف كل كتل JS + غياب prompt عن مسار التحويل + سلامة توليد الزر.
       (2) وظيفي: تنفيذ كتل الواجهة الحقيقية في VM ببدائل DOM وfetch، مع prompt
           مخمود تماماً، ومحاكاة النقر والتأكيد والفشل.
       توسعة لاحقة: نفس الحارس يغطي تدفقي «فتح نزاع» و«المتقدمون» بعد تحويلهما من
       prompt/alert الأصليين إلى حوارين داخل الصفحة، + مسح شامل يمنع عودة أي نداء
       حوار أصلي عارٍ في أي كتلة (الاستثناء الوحيد: deferredPrompt.prompt الخاصة
       بتثبيت PWA — واجهة متصفح رسمية لا حوار إدخال).
       حدوده: البدائل ليست متصفحاً — لا CSS ولا أحداث نقر حقيقية ولا حوارات أصلية؛
       هو يثبت منطق الربط والتدفق، ولا يغني عن فحص حي بعد النشر (TESTING-BUTTON-FIX.md). */
    {
      const vm = require('vm');
      const uiHtml = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
      const uiBlocks = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      let compileOk = uiBlocks.length >= 5;
      for (const b of uiBlocks) { try { new vm.Script(b); } catch (e) { compileOk = false; } }
      check('حارس واجهة: كل كتل جافاسكريبت الصفحة تُصرَّف بلا أخطاء صياغة (خطأ واحد يقتل كتلة كاملة بصمت)', compileOk);

      const fnSrc = (name) => { const m = uiHtml.match(new RegExp('(?:async )?function ' + name + '\\b[\\s\\S]*?\\n\\}')); return m ? m[0] : ''; };
      check('حارس واجهة: مسار تحويل طلب الضيف (bookGuestReq/doBookGuest) لا يستخدم prompt() الأصلي إطلاقاً',
        !!fnSrc('bookGuestReq') && !/prompt\s*\(/.test(fnSrc('bookGuestReq')) && !/prompt\s*\(/.test(fnSrc('doBookGuest')));
      check('حارس واجهة: بطاقتا طلبات السوق وفرص ليك تولّدان زر «ابدأ حجز» بسمة المعرّف الصحيحة',
        (uiHtml.match(/onclick="bookGuestReq\(this,\$\{(?:x|o)\.id\}/g) || []).length >= 2);
      check('حارس واجهة: حوار السعر داخل الصفحة موجود بعناصره وdoBookGuest يستدعي مسار التحويل الصحيح',
        uiHtml.includes('id="guestBookDlg"') && uiHtml.includes('id="gbPrice"') && uiHtml.includes('id="guestBookErr"')
        && fnSrc('doBookGuest').includes('/api/guest-requests/') && fnSrc('doBookGuest').includes('/book'));
      check('حارس واجهة: مسارا النزاع والمتقدمين (dispute/doDispute/viewApps) لا يستخدمان أي حوار أصلي',
        !!fnSrc('dispute') && !!fnSrc('doDispute') && !!fnSrc('viewApps')
        && !/prompt\s*\(|alert\s*\(|confirm\s*\(/.test(fnSrc('dispute') + fnSrc('doDispute') + fnSrc('viewApps')));
      check('حارس واجهة: حوارا النزاع والمتقدمين داخل الصفحة موجودان بعناصرهما ومساراتهما الصحيحة',
        uiHtml.includes('id="disputeDlg"') && uiHtml.includes('id="dpReason"') && uiHtml.includes('id="disputeErr"')
        && uiHtml.includes('id="appsDlg"') && uiHtml.includes('id="appsBody"') && uiHtml.includes('id="appsErr"')
        && fnSrc('doDispute').includes('/dispute') && fnSrc('viewApps').includes('appsBody'));
      /* مسح شامل لكل كتل السكربت بعد تجريد التعليقات الكتلية: لا نداء حوار أصلي
         عارٍ (prompt/alert/confirm) في أي تدفق — الاستثناء الوحيد المبرر هو
         deferredPrompt.prompt() وهي واجهة تثبيت PWA الرسمية لا حوار إدخال. */
      const strippedUi = uiBlocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
      const bareNative = strippedUi.match(/(?<![\w$.])(?:prompt|alert|confirm)\s*\(/g) || [];
      check('حارس واجهة: لا نداءات حوارات أصلية عارية (prompt/alert/confirm) في كل كتل الواجهة',
        bareNative.length === 0, `found=${bareNative.length}`);
      check('حارس واجهة: الاستثناء الوحيد deferredPrompt.prompt() (واجهة تثبيت PWA) موجود مرة واحدة فقط',
        (strippedUi.match(/deferredPrompt\.prompt\s*\(/g) || []).length === 1);
      check('حارس واجهة: زر المتابعة موجود بسمته ومساراه (follow/unfollow) صحيحان وبلا حوارات أصلية',
        uiHtml.includes('data-follow=') && fnSrc('toggleFollow').includes('/api/users/')
        && !/prompt\s*\(|alert\s*\(|confirm\s*\(/.test(fnSrc('toggleFollow') + fnSrc('followBtn')));
      check('حارس واجهة: قسم الرسائل موجود وزر المراسلة يستثني المؤسس ومسار الإرسال صحيح',
        uiHtml.includes('id="tab-messages"') && uiHtml.includes('id="msgInput"')
        && fnSrc('msgBtn').includes('is_platform_founder') && fnSrc('sendMsg').includes('/api/messages/'));
      check('حارس واجهة: صفحة الملف القابلة للمشاركة موجودة (قسم + مسار #/u/ + عنوان باسم الصانع)',
        uiHtml.includes('id="tab-profile"') && uiHtml.includes('#\\/u\\/') && fnSrc('loadProfilePage').includes('document.title'));
      check('حارس واجهة: نسخ رابط الملف وتخزين الإحالة (deal_ref) وربطها بالتسجيل — بلا حوارات أصلية',
        uiHtml.includes('copyProfileLink') && uiHtml.includes('deal_ref') && fnSrc('doAuth').includes('currentRef')
        && !/prompt\s*\(|alert\s*\(|confirm\s*\(/.test(fnSrc('copyProfileLink') + fnSrc('copyTextValue') + fnSrc('captureRef')));
      check('حارس واجهة: شريط «كله في مكان واحد» وقسم «دعواتي» في لوحتي بعناصرهما ومساريهما',
        uiHtml.includes('ov_tagline') && uiHtml.includes('/api/me/overview') && uiHtml.includes('dashReferrals') && uiHtml.includes('/api/me/referrals'));
      check('حارس واجهة: هوية المؤسس الجديدة (شريط قطري/ميدالية ذهبية/هيدر بطل/نطاق مالك) وعناصر التصميم الجديد (توهج الهيرو/بطاقات ov-strip)',
        uiHtml.includes('founder-ribbon') && uiHtml.includes('founder_ribbon') && uiHtml.includes('founder-ava') && uiHtml.includes('founder-hero')
        && uiHtml.includes('founder-scope') && uiHtml.includes('ov-strip') && uiHtml.includes('@keyframes heroGlow') && uiHtml.includes('@keyframes founderPulse'));
      check('حارس واجهة: الاسم الجديد «منصة كل صناع المحتوى» في أسطر التعريف الذاتي وغياب «والمحلات» منها (واجهة + خادم)',
        uiHtml.includes('منصة كل صناع المحتوى') && uiHtml.includes('platform for all content creators')
        && !uiHtml.includes('والمحلات المحلية') && !uiHtml.includes('creators and shops')
        && fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').includes('منصة كل صناع المحتوى'));
      check('حارس واجهة: قسم «شاراتي وتقدّمي» وسطر «أقرب شارة» مربوطان بمسار تقدم الشارات وبأسلوب أشرطة التقدم الجديد',
        uiHtml.includes('/api/me/badges-progress') && uiHtml.includes('dashBadges') && uiHtml.includes('bp_closest') && uiHtml.includes('bdg-fill'));
      check('حارس واجهة: سطر «أقرب شارة» لا يُخفى بشرط pct>0 — يُبنى كلما وُجدت شارة غير محصّلة (يظهر دائماً لأي صانع مسجل)',
        !uiHtml.includes('closest&&closest.pct>0') && uiHtml.includes('const closestHtml=closest?'));
      /* ===== إعادة التصميم الجريئة (TESTING-BOLD-REDESIGN.md): عناصر بنيوية جديدة ===== */
      check('حارس واجهة: الهيرو السينمائي الجديد (مسرح + نموذج موبايل CSS + بطاقات عائمة parallax + عدّادات + شرائح ثقة زجاجية)',
        uiHtml.includes('hero-stage') && uiHtml.includes('class="phone"') && uiHtml.includes('float-card')
        && uiHtml.includes('data-plx') && uiHtml.includes('class="cnt"') && uiHtml.includes('glass-chip'));
      check('حارس واجهة: الشريط المتحرك وقسم «إزاي بتشتغل» وبطاقة مقاعد المؤسسين موجودة بحركاتها ومفاتيحها',
        uiHtml.includes('marquee') && uiHtml.includes('@keyframes mqMove') && uiHtml.includes('how-card') && uiHtml.includes('how-num')
        && uiHtml.includes('seats-card') && uiHtml.includes('marquee_items') && uiHtml.includes('seats-dots'));
      check('حارس واجهة: شريط التنقل السفلي موجود بأزراره (٥ تبويبات موسومة بترتيب صورة ٣) وshowTab يزامن حالته النشطة عبر syncTabbar',
        uiHtml.includes('id="tabbar"') && (uiHtml.match(/data-tbtab="/g) || []).length === 5
        && uiHtml.includes('id="tbMsgBadge"') && fnSrc('showTab').includes('syncTabbar'));
      /* ربط تبويب «المنشئون» السفلي (حامل data-i18n="tb_creators" في الترتيب
         الجديد): هدفه هو سوق/دليل الصناع نفسه — showTab('market') كما الزر
         العلوي «السوق» — لا حملات البراندات (انحدار تاريخي موثّق). مفتاح
         التبويب صار 'creators' بقرار الترتيب الجديد، والهدف المستخرج يُحقن
         في سائق الـVM أدناه لفحص وظيفي ينفّذ النداء نفسه. */
      const tbBlock = (uiHtml.match(/<nav class="tabbar[^>]*>([\s\S]*?)<\/nav>/) || [])[1] || '';
      const tbMarketChunk = tbBlock.split('<button').slice(1).find((c) => c.includes('data-i18n="tb_creators"')) || '';
      const tbMarketArg = (tbMarketChunk.match(/showTab\('([^']+)'\)/) || [])[1] || null;
      const tbMarketKey = (tbMarketChunk.match(/data-tbtab="([^"]+)"/) || [])[1] || null;
      const navBlock = (uiHtml.match(/<nav id="nav">([\s\S]*?)<\/nav>/) || [])[1] || '';
      const navMarketChunk = navBlock.split('<button').slice(1).find((c) => c.includes('data-i18n="nav_market"')) || '';
      const navMarketArg = (navMarketChunk.match(/data-tab="([^"]+)"/) || [])[1] || null;
      check('حارس واجهة: تبويب «المنشئون» في الشريط السفلي مربوط بنفس هدف زر «السوق» العلوي بالضبط (showTab(\'market\')) — لا حملات البراندات',
        tbMarketArg === 'market' && tbMarketKey === 'creators' && navMarketArg === 'market' && !tbMarketChunk.includes('campaigns'),
        `bottom=${tbMarketArg}/${tbMarketKey} top=${navMarketArg}`);
      /* ===== جولة «داكن سينمائي» (TESTING-DESIGN-CINEMATIC.md): حراس بنيوية ===== */
      const tbOrder = ['tb_home', 'tb_wallet', 'nav_messages', 'tb_creators', 'tb_account'].map((k) => tbBlock.indexOf(`data-i18n="${k}"`));
      check('حارس تصميم: ترتيب تبويبات الشريط السفلي بالضبط (الرئيسية، المحفظة، الرسائل، المنشئون، الحساب) في DOM = من اليمين لليسار في RTL',
        tbOrder.every((v, i) => v >= 0 && (i === 0 || v > tbOrder[i - 1])), JSON.stringify(tbOrder));
      check('حارس تصميم: عنوان الهيرو الرسمي بقرار المستخدم في الواجهة والقاموسين + درع الهيرو + زر CTA ذهبي واحد',
        uiHtml.includes('اكتشف أفضل المبدعين وتعاون الآن') && uiHtml.includes('Discover the best creators. Collaborate now.')
        && uiHtml.includes('hero-emblem') && uiHtml.includes('hero_title') && uiHtml.includes('hero-cta')
        && (uiHtml.match(/hero_title:/g) || []).length >= 2 && (uiHtml.match(/hero_cta:/g) || []).length >= 2);
      check('حارس تصميم: نموذج الضيف بلا حقل هاتف نهائياً (لا gPhone ولا gPhoneLbl) وشاشة النجاح تجعل حفظ الرابط خطوة كبيرة',
        !uiHtml.includes('gPhone') && uiHtml.includes('save-link-card') && uiHtml.includes('g_save_step')
        && (uiHtml.match(/g_save_step:/g) || []).length >= 2 && fnSrc('doGuestRequest').includes('device_id') && !fnSrc('doGuestRequest').includes('phone'));
      const tcSrc = fnSrc('talentCard');
      const tcOrder = ['coverDiv(u)', 'tava', 't-spec', 't-meta', 'vchip', 'money(u.price, u.currency)'].map((m) => tcSrc.indexOf(m));
      check('حارس تصميم: ترتيب عناصر بطاقة الصانع كالمرجع (غلاف ← صورة ← تخصص ← سطر متابعين/مشاريع ← شريحة موثّق ← سعر)',
        tcOrder.every((v, i) => v >= 0 && (i === 0 || v > tcOrder[i - 1])), JSON.stringify(tcOrder));
      check('حارس تصميم: إخفاء المقاعد التلقائي مربوط (seatsVerifiedFull + heroSeatStat + loadSeatsState عند التهيئة) وترويسة ملف القائمة موجودة',
        uiHtml.includes('function seatsVerifiedFull') && uiHtml.includes('id="heroSeatStat"') && uiHtml.includes('loadSeatsState()')
        && uiHtml.includes('id="menuProfile"') && uiHtml.includes('id="menuAva"') && uiHtml.includes('goldband'));
      check('حارس واجهة: بطاقات الصناع بترويسة غلاف مشتقة من المجال (nicheHue + tcard/tcover) وهيدر اللوحة dash-hero وبلاطات KPI ملوّنة',
        uiHtml.includes('nicheHue') && uiHtml.includes('tcover') && uiHtml.includes('tcard')
        && uiHtml.includes('dash-hero') && uiHtml.includes('card g1'));
      check('حارس واجهة: نسخة كاش PWA رُفعت إلى deal-v3 حتى تلتقط الأجهزة التصميم السينمائي الجديد فوراً',
        fs.readFileSync(path.join(pubDir, 'sw.js'), 'utf8').includes("const CACHE = 'deal-v3'"));
      /* ===== جولة الإبداع الثانية + وصول الضيوف + التصنيف الموحّد (TESTING-BOLD-REDESIGN.md) ===== */
      const mqVals = [...uiHtml.matchAll(/marquee_items:'([^']*)'/g)].map((m) => m[1]);
      const mqBlock = (uiHtml.match(/<div class="marquee">([\s\S]*?)<\/div><\/div>/) || [])[1] || '';
      const mqCities = ['كفر الشيخ', 'الجيزة', 'الإسكندرية', 'المنصورة', 'طنطا', 'أسيوط', 'القاهرة', 'Kafr El Sheikh', 'Alexandria', 'Mansoura', 'Tanta', 'Assiut', 'Cairo', 'Giza'];
      check('حارس واجهة: الشريط المتحرك خدمات المنصة فقط — ضمان/عمولة/توثيق/دعم، وبلا أي مدينة وبلا قائمة المجالات القديمة',
        mqVals.length === 2 && mqVals[0].includes('ضمان Deal') && mqVals[0].includes('توثيق حساب فوري') && mqVals[0].includes('دعم فوري')
        && mqVals[1].includes('Deal Guarantee') && mqVals[1].includes('no registration')
        && mqCities.every((c) => !mqVals.join(' ').includes(c)) && !mqVals.join(' ').includes('كوميديا ✦') && !mqBlock.includes('كفر الشيخ'));
      const phoneBlock = (uiHtml.match(/<div class="phone">([\s\S]*?)<\/div>\s*<div class="float-wrap/) || [])[1] || '';
      check('حارس واجهة: نموذج الموبايل بلا بطاقة الصانع القديمة — مشهد «صفقة بتتم الآن» (تقدم مضيء + عربون + أعمدة أرباح + إشعارات) بدلها',
        !!phoneBlock && !phoneBlock.includes('mock_niche') && !phoneBlock.includes('mock_city') && !phoneBlock.includes('mock_steps') && !phoneBlock.includes('ph-ava')
        && phoneBlock.includes('ph-chart') && phoneBlock.includes('ph-paid') && phoneBlock.includes('mock_live')
        && phoneBlock.includes('mock_earn') && phoneBlock.includes('mock_notif1') && phoneBlock.includes('mock_notif2'));
      check('حارس واجهة: الهيرو بتوهج تابع للمؤشر (hero-spot يُحرَّك من initHeroFx) وبطاقات «إزاي بتشتغل» بإيقاع ظهور متدرج',
        uiHtml.includes('id="heroSpot"') && fnSrc('initHeroFx').includes('heroSpot')
        && uiHtml.includes('.why .how-card:nth-child(2)') && uiHtml.includes('.why .how-card:nth-child(3)'));
      check('حارس واجهة: وصول الضيوف — شريط «بتتصفح كزائر» في السوق + زر طلب موجّه من البطاقة + شريط استهداف في نموذج الضيف + توضيح التسجيل',
        uiHtml.includes('id="guestBanner"') && fnSrc('talentCard').includes('guestOrderBtn(u)') && fnSrc('renderAuth').includes('guestBanner')
        && uiHtml.includes('id="guestTarget"') && uiHtml.includes('auth_note') && uiHtml.includes('id="roleFilter"'));
      let taxMatch = false;
      try {
        const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
        const srvTax = JSON.parse((srvSrc.match(/const TAXONOMY = (\{[\s\S]*?\});/) || [])[1]);
        const uiTax = JSON.parse((uiHtml.match(/const TAX_FALLBACK = (\{[\s\S]*?\});/) || [])[1]);
        taxMatch = JSON.stringify(srvTax) === JSON.stringify(uiTax);
      } catch (e) { taxMatch = false; }
      check('حارس واجهة: التصنيف الموحّد — نسخة الواجهة الاحتياطية (TAX_FALLBACK) تطابق قائمة الخادم (TAXONOMY) حرفياً فلا تنحرف النسختان',
        taxMatch);
      check('حارس واجهة: التسجيل بالقوائم الموحّدة — قائمة مجالات + قائمة خدمات + حقول حرة لـ«أخرى» تُبنى من buildTaxUI وتُرسَل في doAuth',
        uiHtml.includes('id="aNicheCustom"') && uiHtml.includes('id="aProvCustom"') && fnSrc('buildTaxUI').includes('TAX.niches')
        && fnSrc('doAuth').includes('provider_custom') && fnSrc('doAuth').includes('__other'));
      check('حارس واجهة: الدول العربية — قوائم دولة للتسجيل والضيف وفلتر السوق تُبنى من TAX.countries وتُرسَل للخادم',
        uiHtml.includes('id="aCountry"') && uiHtml.includes('id="gCountry"') && uiHtml.includes('id="fCountry"')
        && fnSrc('countryOptions').includes('TAX.countries') && fnSrc('buildTaxUI').includes('countryOptions') && fnSrc('countryFx').includes('countryDef')
        && fnSrc('guestCountryFx').includes('countryDef') && fnSrc('doGuestRequest').includes('country')
        && fnSrc('loadMarket').includes('country=') && fnSrc('talentCard').includes('placeStr(u)')
        && fnSrc('talentCard').includes('money(u.price, u.currency)'));

      /* ===== توحيد المصطلح «منصة» + تجهيز بحث جوجل (TESTING-TERMINOLOGY-SEO.md) =====
         الإشارة الذاتية لـ Deal هي دائماً «منصة» (EN: "the platform"). الحراس أدناه
         بنيوية على المواضع الأساسية فقط (الاسم الذاتي/الهيرو/العمولة/الإثبات/الشريط/
         الشروط والدعم) حتى لا تهشّ مع أي نص حر آخر — الاستثناءات الموثقة (تسمية خدمة
         «تطوير مواقع وتطبيقات»، «تطبيق عملي/مشهور» عن الغير، اقتباس قائمة المتصفح
         «تثبيت التطبيق») خارج نطاقها عمداً. */
      const srvSrcT = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
      check('حارس مصطلح: الاسم الذاتي «Deal — منصة كل صناع المحتوى» حاضر في الواجهة والخادم',
        uiHtml.includes('Deal — منصة كل صناع المحتوى') && srvSrcT.includes('Deal — منصة كل صناع المحتوى'));
      check('حارس مصطلح: الواجهة بلا إشارة ذاتية بـ«التطبيق» في المواضع الأساسية وبالصيغ الجديدة «المنصة»',
        !uiHtml.includes('عمولة التطبيق') && !uiHtml.includes('يتحقق منه التطبيق') && !uiHtml.includes('داخل التطبيق')
        && uiHtml.includes('عمولة المنصة أولاً') && uiHtml.includes('تتحقق منه المنصة') && uiHtml.includes('دعم فوري داخل المنصة'));
      check('حارس مصطلح: الخادم بلا إشارة ذاتية بـ«التطبيق» (عمولات/داخل/لغة) وبلا "the app" إشارةً لـ Deal',
        !srvSrcT.includes('حساب عمولات التطبيق') && !srvSrcT.includes('داخل التطبيق') && !srvSrcT.includes('لغة التطبيق')
        && !srvSrcT.includes('the app') && srvSrcT.includes('حساب عمولات المنصة') && srvSrcT.includes('لغة المنصة'));
      check('حارس مصطلح EN: قاموس الواجهة بصيغة "the platform" (رسوم/دعم) بلا "the app fee" وبلا "in-app support"',
        !uiHtml.includes('the app fee') && !uiHtml.includes('in-app support')
        && uiHtml.includes('the platform fee first') && uiHtml.includes('Instant in-platform support')
        && uiHtml.includes('Deal — the platform for all content creators'));
      const rbRes = await fetch(BASE + '/robots.txt');
      const rbTxt = await rbRes.text();
      check('SEO: robots.txt يُخدَم فعلياً (200 + text/plain) ويسمح بالزحف ويشير إلى sitemap.xml',
        rbRes.status === 200 && (rbRes.headers.get('content-type') || '').includes('text/plain')
        && rbTxt.includes('Allow: /') && rbTxt.includes('Sitemap: https://deal-nine-ruddy.vercel.app/sitemap.xml'));
      const smRes = await fetch(BASE + '/sitemap.xml');
      const smTxt = await smRes.text();
      check('SEO: sitemap.xml يُخدَم فعلياً (200 + xml) وفيه الصفحة الرئيسية وحدها بأولوية 1.0',
        smRes.status === 200 && (smRes.headers.get('content-type') || '').includes('xml')
        && smTxt.includes('<loc>https://deal-nine-ruddy.vercel.app/</loc>') && smTxt.includes('<priority>1.0</priority>')
        && (smTxt.match(/<url>/g) || []).length === 1);
      check('SEO: <head> فيه الوصف البحثي الجديد وOpen Graph وrobots index,follow وموضع تحقق جوجل معلّقاً بلا قيمة وهمية',
        uiHtml.includes('من ١٩ دولة عربية') && uiHtml.includes('property="og:title"') && uiHtml.includes('property="og:description"')
        && uiHtml.includes('property="og:type" content="website"') && uiHtml.includes('property="og:image"')
        && uiHtml.includes('name="robots" content="index,follow"') && uiHtml.includes('GOOGLE_SITE_VERIFICATION')
        && uiHtml.includes('<!-- <meta name="google-site-verification" content=""> -->'));

      /* --- الفحص الوظيفي ببدائل DOM --- */
      const elCache = new Map();
      const makeEl = (sel) => {
        if (elCache.has(sel)) return elCache.get(sel);
        const classes = new Set();
        const el = {
          children: [], style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
          placeholder: '', disabled: false, title: '', _open: false,
          classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f; on ? classes.add(c) : classes.delete(c); return on; },
            contains: (c) => classes.has(c),
          },
          appendChild(c) { this.children.push(c); return c; },
          addEventListener() {}, removeEventListener() {},
          querySelector: () => makeEl(sel + '>q'), querySelectorAll: () => [],
          showModal() { this._open = true; }, close() { this._open = false; },
          select() {}, focus() {}, scrollTop: 0, scrollHeight: 0,
        };
        elCache.set(sel, el);
        return el;
      };
      const fetchLog = [];
      let bookFail = false;
      let appsFail = false;
      let disputeFail = false;
      let badgesPayload = { items: [] };
      /* حمولتا دليل لحارس تسرب المؤسس بعد الخروج: جلب العضو (بتفويض) يرى
         المؤسس كما يقرر الخادم، وجلب الزائر (بلا تفويض) لا يراه أبداً.
         dirDelay يؤخّر ردّ الدليل التالي (يُلتقط عند النداء) لمحاكاة سباق
         «جلب عضو بطيء يكتمل بعد خروج فوري». */
      let dirDelay = 0;
      /* حمولتا باقة النجم لحارس الواجهة الوظيفي: حالة اشتراكي (قيد تحقق/نشط)
         ونجم الأسبوع — تُبدَّل من السائق عبر __setStarMe/__setStarWeek. */
      let starMePayload = { state: 'none', subscription: null, is_week_star: false };
      /* حمولة /api/me قابلة للتبديل من السائق (__setMe) — لفحص بانر غير
         الموثّقين: loadDash يقرأ المستخدم من /api/me لا من ME مباشرة. */
      const meDefault = { user: { id: 7, role: 'creator', name: 'صانع فحص', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 0, penalty_level: 'none', frozen: 0, bio: '' }, verify_status: 'none', verify_code: null };
      let mePayload = meDefault;
      let starWeekPayload = { star: null, stats: null };
      const dirGuestItems = [{ id: 5, name: 'صانع عادي', role: 'creator', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 3, followers_count: 1, completion_rate: 100, avg_stars: 5, positive_pct: 100, badges: [] }];
      const dirMemberItems = [{ id: 1, name: 'مؤسس الفحص', role: 'creator', niche: 'FounderNiche', city: 'FounderCity', currency: 'EGP', price: 0, followers: 0, followers_count: 9, is_platform_founder: true, badges: [] }, ...dirGuestItems];
      const fetchStub = async (url, opts = {}) => {
        const u = String(url); const method = opts.method || 'GET';
        fetchLog.push({ method, url: u, body: opts.body || null });
        let body = { items: [] }; let ok = true;
        if (u.endsWith('/api/guest-requests') && method === 'POST') {
          body = { id: 55, token: 'tok123tok123tok123tok123tok12345', follow: '/#/g/tok123tok123tok123tok123tok12345' };
        } else if (u.includes('/api/guest-requests/') && u.endsWith('/book')) {
          if (bookFail) { ok = false; body = { error: 'هذا الطلب اتحجز خلاص — لا يمكن تحويله مرتين' }; }
          else body = { booking: { id: 99 } };
        } else if (u.includes('/api/bookings/99')) {
          body = { booking: { id: 99, title: 'طلب اختبار', client_id: 3, talent_id: 7, status: 'pending_agreement', fee: 50, deposit: 225, rest: 225, currency: 'EGP', fee_status: 'pending', agreed_client: 0, agreed_talent: 0, proof_url: null } };
        } else if (u.endsWith('/dispute')) {
          if (disputeFail) { ok = false; body = { error: 'لا يمكن فتح نزاع على هذا الحجز الآن' }; }
          else body = { ok: true };
        } else if (u.includes('/api/campaigns/9/applications')) {
          if (appsFail) { ok = false; body = { error: 'تعذر جلب المتقدمين' }; }
          else body = { items: [{ creator: { name: 'متقدم فحص' }, status: 'pending' }] };
        } else if (u.includes('/api/bookings/77')) {
          body = { booking: { id: 77, title: 'حجز فحص نزاع', client_id: 3, talent_id: 7, status: 'disputed', fee: 50, deposit: 225, rest: 225, currency: 'EGP', fee_status: 'confirmed', agreed_client: 1, agreed_talent: 1, proof_url: null, alternatives: [] } };
        } else if (u.includes('/api/talent/7')) {
          body = { user: { id: 7, name: 'صانع فحص', role: 'creator', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 10, followers_count: 3, member_since: 1700000000000, portfolio: [], badges: [] },
            stats: { completed_deals: 2, completion_rate: 100, positive_pct: 100, avg_stars: 5 }, badges: [], reviews: [], shorts: [] };
        } else if (u.includes('/api/talent/1')) {
          body = { user: { id: 1, name: 'مؤسس المنصة', role: 'creator', niche: 'FounderNiche', city: 'FounderCity', currency: 'EGP', price: 0, followers: 0, followers_count: 9, member_since: 1700000000000, portfolio: [], badges: [], is_platform_founder: true },
            stats: { completed_deals: 0, completion_rate: 0, positive_pct: null, avg_stars: null }, badges: [], reviews: [], shorts: [] };
        } else if (u.includes('/api/talent/42')) {
          body = { user: { id: 42, name: 'ملف فحص', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 10, followers_count: 3, member_since: 1700000000000, portfolio: [], badges: [] },
            stats: { completed_deals: 2, completion_rate: 100, positive_pct: 100, avg_stars: 5 }, badges: [], reviews: [],
            shorts: [{ platform: 'youtube', embed_url: 'https://www.youtube.com/embed/abcDEF123_-', title: 'شورت فحص' }] };
        } else if (u.includes('/api/me/badges-progress')) {
          body = badgesPayload;
        } else if (u === '/api/me') {
          body = mePayload;
        } else if (u === '/api/my/stats') {
          body = { views: 0, opportunities_open: 0, conversion: 0, earnings_total: 0, record: { completed_deals: 0 } };
        } else if (u === '/api/me/social') {
          body = { followers_count: 0, following_count: 0, followers: [], following: [] };
        } else if (u === '/api/me/overview') {
          body = { opportunities: 0, active_bookings: 0, unread_messages: 0, followers: 0, verified_referrals: 0 };
        } else if (u === '/api/me/referrals') {
          body = { items: [], total: 0, verified_count: 0, ambassador_target: 5, featured: false, featured_until: 0 };
        } else if (u === '/api/messages') {
          body = { items: [], unread_total: 0 };
        } else if (u.includes('/api/notifications')) body = { items: [], unread: 0 };
        else if (u.startsWith('/api/money/obligation')) {
          body = { obligation: { code: 'DL-TEST1', kind: 'star_subscription', booking_id: null, base_amount: 199, exact_amount: 199.43, currency: 'EGP', status: 'open', payee: 'owner', receipt_locked: false, country: 'EG', method_label: 'فودافون كاش / إنستاباي', method_label_en: 'Vodafone Cash / InstaPay', payee_phone: TEST_PHONE } };
        }
        else if (u === '/api/star/info') {
          body = { price: 199, currency: 'EGP', days: 30, terms_version: 'star-terms-v1', active_stars: 1 };
        } else if (u === '/api/star/me') {
          body = starMePayload;
        } else if (u === '/api/star/payment-info') {
          body = { label: 'Deal — حساب عمولات المنصة', phone: TEST_PHONE, methods: ['Vodafone Cash', 'InstaPay'], amount: 199, currency: 'EGP' };
        } else if (u === '/api/star/subscribe' && method === 'POST') {
          // محاكاة الخادم: اشتراك صحيح (مرجع + قبول شروط بالنسخة الحالية) يولد «قيد تحقق» فوراً بلا أي ميزة
          starMePayload = { state: 'pending', subscription: { ref: 'VM-REF', status: 'pending', days_left: 0 }, is_week_star: false };
          body = { state: 'pending', subscription: { id: 900, status: 'pending' } };
        } else if (u === '/api/star/fuel') {
          body = { stats: { views: 5, earnings_month: 100, earnings_total: 300, conversion: 50, record: { completed_deals: 2 } },
            fuel: { key: 'Tech', ideas: ['فكرة فحص ١', 'فكرة فحص ٢', 'فكرة فحص ٣'], step: 'خطوة فحص', month_index: 1 } };
        } else if (u === '/api/star/week') {
          body = starWeekPayload;
        }
        else if (u.startsWith('/api/directory')) {
          const authed = !!((opts.headers || {}).Authorization);
          const all = authed ? dirMemberItems : dirGuestItems;
          body = { items: u.includes('role=provider') ? all.filter((x) => x.role === 'provider') : all };
          if (dirDelay) { const dd = dirDelay; await new Promise((r3) => setTimeout(r3, dd)); }
        }
        return { ok, status: ok ? 200 : 409, json: async () => body };
      };
      let promptCalls = 0;
      let alertCalls = 0;
      const sandbox = {
        console, setTimeout, clearTimeout, Promise,
        document: {
          querySelector: (s) => makeEl(s), querySelectorAll: () => [],
          getElementById: (id) => makeEl('#' + id),
          createElement: (t) => makeEl('new:' + t + ':' + Math.random()),
          documentElement: makeEl('html'), title: '',
        },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        location: { hash: '', pathname: '/', search: '', origin: 'http://test' },
        history: { pushState() {} }, navigator: {},
        fetch: fetchStub, fetchLog,
        prompt: () => { promptCalls++; return null; }, // بيئة العطل نفسها: حوار مخمود
        alert: () => { alertCalls++; }, addEventListener: () => {}, scrollTo: () => {},
        __setBookFail: (v) => { bookFail = v; },
        __setAppsFail: (v) => { appsFail = v; },
        __setDisputeFail: (v) => { disputeFail = v; },
        __setBadges: (v) => { badgesPayload = v; },
        __setDirDelay: (v) => { dirDelay = v; },
        __setStarMe: (v) => { starMePayload = v; },
        __setMe: (v) => { mePayload = v || meDefault; },
        __setStarWeek: (v) => { starWeekPayload = v; },
        __tbMarketArg: tbMarketArg, // هدف زر «السوق» السفلي مستخرجاً من HTML الحقيقي أعلاه
      };
      sandbox.window = sandbox; sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      const uiDriver = `
;globalThis.__result = (async () => {
  const out = { type: typeof bookGuestReq };
  // --- زائر بلا جلسة: بطاقة صانع تحمل «اطلب من غير تسجيل» الموجّه، وبطاقة مقدم
  //     خدمة تظهر خدمته الحرة كما كتبها مع وسم «مقدم خدمة» ---
  const gCard = talentCard({ id: 9, name: 'صانع زائر', role: 'creator', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 5, followers_count: 1, completion_rate: 100, avg_stars: 5, positive_pct: 100, badges: [] }, 0);
  out.guestCardOrderBtn = gCard.includes(t('guest_order_btn')) && gCard.includes('openGuest(9,');
  const pCard = talentCard({ id: 10, name: 'مقدم زائر', role: 'provider', provider_category: 'other', provider_custom: 'خدمة حرة تجريبية', city: 'Giza', currency: 'EGP', price: 50, followers: 0, followers_count: 0, completion_rate: 0, avg_stars: null, positive_pct: null, badges: [] }, 0);
  out.providerCardSvc = pCard.includes('خدمة حرة تجريبية') && pCard.includes(t('provider_tag'));
  const vCard = talentCard({ id: 11, name: 'منتج فيديو', role: 'provider', provider_category: 'videoproduction', city: 'Cairo', currency: 'EGP', price: 900, followers: 0, followers_count: 0, completion_rate: 0, avg_stars: null, positive_pct: null, badges: [] }, 0);
  out.videoSvcCard = vCard.includes('إنتاج فيديوهات وإعلانات') && vCard.includes(t('provider_tag')) && vCard.includes('hsl(42,');
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } };
  const btn = { disabled: false, innerHTML: 'ابدأ حجز' };
  bookGuestReq(btn, 5, 500);
  out.dlgOpened = document.querySelector('#guestBookDlg')._open === true;
  out.pricePrefilled = String(document.querySelector('#gbPrice').value) === '500';
  out.noBookCallOnOpen = !fetchLog.some((f) => f.url.includes('/book'));
  await doBookGuest({ disabled: false, innerHTML: 'ابدأ حجز' });
  out.bookPosted = fetchLog.some((f) => f.method === 'POST' && f.url.includes('/api/guest-requests/5/book'));
  out.bookingOpened = fetchLog.some((f) => f.url.includes('/api/bookings/99'));
  __setBookFail(true);
  bookGuestReq(btn, 5, 500);
  await doBookGuest({ disabled: false, innerHTML: 'ابدأ حجز' });
  const errEl = document.getElementById('guestBookErr');
  out.errShown = errEl.classList.contains('show') && errEl.textContent.length > 0;
  // --- المتقدمون: عرض داخل حوار الصفحة (لا alert) + فشل ظاهر داخل الحوار ---
  await viewApps({ disabled: false, innerHTML: 'المتقدمون' }, 9);
  out.appsOpened = document.querySelector('#appsDlg')._open === true;
  out.appsListed = document.getElementById('appsBody').innerHTML.includes('متقدم فحص');
  __setAppsFail(true);
  await viewApps({ disabled: false, innerHTML: 'المتقدمون' }, 9);
  const appsErrEl = document.getElementById('appsErr');
  out.appsErrShown = appsErrEl.classList.contains('show') && appsErrEl.textContent.length > 0;
  __setAppsFail(false);
  // --- النزاع: حوار داخل الصفحة (لا prompt) + تأكيد يرسل ويغلق + فشل ظاهر ---
  dispute({ disabled: false, innerHTML: 'فتح نزاع' }, 77);
  out.disputeOpened = document.querySelector('#disputeDlg')._open === true;
  out.noDisputeCallOnOpen = !fetchLog.some((f) => f.url.endsWith('/dispute'));
  document.querySelector('#dpReason').value = 'سبب فحص';
  await doDispute({ disabled: false, innerHTML: 'فتح نزاع' });
  out.disputePosted = fetchLog.some((f) => f.method === 'POST' && f.url.includes('/api/bookings/77/dispute'));
  out.disputeClosedAfterOk = document.querySelector('#disputeDlg')._open === false;
  __setDisputeFail(true);
  dispute({ disabled: false, innerHTML: 'فتح نزاع' }, 77);
  await doDispute({ disabled: false, innerHTML: 'فتح نزاع' });
  const dpErrEl = document.getElementById('disputeErr');
  out.disputeErrShown = dpErrEl.classList.contains('show') && dpErrEl.textContent.length > 0;
  __setDisputeFail(false);
  // --- رابط الملف القابل للمشاركة: #/u/<id> يفتح الملف العام مباشرة + زر النسخ ---
  location.hash = '#/u/42';
  out.routeProfile = routeHash() === true;
  await new Promise((r2) => setTimeout(r2, 60));
  out.profileRendered = document.querySelector('#profileBody').innerHTML.includes('ملف فحص');
  out.profileShortsEmbedded = document.querySelector('#profileBody').innerHTML.includes('youtube.com/embed');
  out.profileTitleSet = String(document.title).includes('ملف فحص');
  const cpBtn = { disabled: false, innerHTML: 'x', textContent: '' };
  await copyProfileLink(cpBtn, 42);
  out.copyConfirmed = cpBtn.textContent === t('copied');
  // --- سطر «أقرب شارة» في شريط اللوحة: يظهر دائماً — أصفار كاملة ثم تقدم جزئي ---
  const bdgItem = (key, current, target, pct) => ({ key, name: key, color: '#123456', earned: false, current, target, remaining: target - current, pct, detail: {} });
  __setBadges({ items: [bdgItem('perfect', 0, 10, 0), bdgItem('rising', 0, 5, 0), bdgItem('ambassador', 0, 5, 0)] });
  await loadDash();
  const dash0 = document.querySelector('#dashBody').innerHTML;
  const ci0 = dash0.indexOf(t('bp_closest'));
  const seg0 = ci0 >= 0 ? dash0.slice(ci0, ci0 + 220) : '';
  out.zeroClosestShown = ci0 >= 0 && seg0.includes(t('bdg_perfect')) && seg0.includes(t('bp_done_w') + ' 0 ' + t('bp_of_w') + ' 10');
  __setBadges({ items: [bdgItem('perfect', 0, 10, 0), bdgItem('fast', 1, 5, 20), bdgItem('rising', 3, 5, 60)] });
  await loadDash();
  const dash1 = document.querySelector('#dashBody').innerHTML;
  const ci1 = dash1.indexOf(t('bp_closest'));
  const seg1 = ci1 >= 0 ? dash1.slice(ci1, ci1 + 220) : '';
  out.partialClosestShown = ci1 >= 0 && seg1.includes(t('bdg_rising')) && seg1.includes(t('bp_done_w') + ' 3 ' + t('bp_of_w') + ' 5') && seg1.includes('60%');
  // --- طلب الضيف الموجّه: openGuest(id,name) يثبّت الهدف ظاهراً، والإرسال يحمل
  //     target_talent_id، وفتح النموذج بلا وسيط يعود به طلباً عاماً ---
  // جولة «تواصل ومهام»: قناة الضيف تُعطَّل أثناء جلسة عضو (قاعدة منتج جديدة —
  // النموذج لا يعمل للمسجلين والخادم يرفض)، وهذا المقطع يختبر تدفق ضيف،
  // فنُصفّي ME قبله ونعيده بعده؛ كل تأكيدات المقطع كما هي بلا تغيير.
  const __meBeforeGuest = ME; ME = null;
  openGuest(42, 'صانع هدف');
  out.guestTargetSet = !!GUEST_TARGET && GUEST_TARGET.id === 42 && !document.querySelector('#guestTarget').classList.contains('hide');
  await doGuestRequest({ disabled: false, innerHTML: 'انشر الطلب' });
  const gPost = fetchLog.filter((f) => f.method === 'POST' && f.url.endsWith('/api/guest-requests')).pop();
  out.guestTargetPosted = !!gPost && JSON.parse(gPost.body).target_talent_id === 42;
  out.guestBodyNoPhone = !!gPost && !('phone' in JSON.parse(gPost.body)) && typeof JSON.parse(gPost.body).device_id === 'string' && JSON.parse(gPost.body).device_id.length > 0;
  // --- قرار إخفاء المقاعد عند اكتمال الموثّقة (جولة التصميم): دالة صافية على
  //     حمولات اصطناعية — ١٠٠ موثّقة = إغلاق، وأي نقص أو غياب توثيق = مفتوح ---
  const mkSeats = (taken, verified) => ({ seats: Array.from({ length: 100 }, (_, i) => ({ seat: i + 1, taken: i < taken, verified: i < verified })) });
  out.seatsFullAt100Verified = seatsVerifiedFull(mkSeats(100, 100)) === true;
  out.seatsOpenAt99Verified = seatsVerifiedFull(mkSeats(100, 99)) === false;
  out.seatsOpenWhenTakenUnverified = seatsVerifiedFull(mkSeats(100, 40)) === false;
  out.seatsNullSafe = seatsVerifiedFull(null) === false && seatsVerifiedFull({}) === false;
  await new Promise((r2) => setTimeout(r2, 80));
  openGuest();
  out.guestTargetCleared = GUEST_TARGET === null;
  ME = __meBeforeGuest;
  // --- تعطيل نموذج الضيف أثناء جلسة عضو: النموذج مخفي وتنبيه القناة ظاهر،
  //     ومحاولة الإرسال لا تصل إلى الخادم أصلاً (رفض واجهة + رفض خادم) ---
  const gFetchMark = fetchLog.length;
  openGuest();
  out.guestBlockedForMember = document.querySelector('#guestForm').classList.contains('hide') && !document.querySelector('#guestBlocked').classList.contains('hide');
  await doGuestRequest({ disabled: false, innerHTML: 'انشر الطلب' });
  out.guestBlockedNoPost = !fetchLog.slice(gFetchMark).some((f) => f.method === 'POST' && f.url.endsWith('/api/guest-requests'));
  // --- التنقل السفلي: syncTabbar موجود وshowTab يبدّل التبويب الحالي بلا أخطاء ---
  out.tabbarFn = typeof syncTabbar;
  showTab('dash');
  out.tabAfterDash = CURTAB;
  showTab('market');
  out.tabAfterMarket = CURTAB;
  // --- ضغط زر «السوق» في الشريط السفلي: ننفّذ النداء المكتوب في onclick الزر
  //     الحقيقي نفسه (محقون من HTML) — يجب أن يفتح سوق الصناع لا الحملات ---
  const tbFetchMark = fetchLog.length;
  showTab(__tbMarketArg);
  await new Promise((r2) => setTimeout(r2, 60));
  out.tbMarketArgTab = CURTAB;
  out.tbMarketSectionShown = !document.querySelector('#tab-market').classList.contains('hide');
  out.tbMarketDirectoryLoaded = fetchLog.slice(tbFetchMark).some((f) => f.url.includes('/api/directory'));
  out.tbCampaignsNotLoaded = !fetchLog.slice(tbFetchMark).some((f) => f.url.includes('/api/campaigns'));
  // --- بطاقة الصانع الجديدة: غلاف ملوّن من المجال — وبطاقة المؤسس لا يمسّها الشكل الجديد ---
  const nc = talentCard({ id: 5, name: 'صانع غلاف', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 10, followers_count: 2, completion_rate: 90, avg_stars: 5, positive_pct: 100, badges: [] }, 0);
  out.cardHasCover = nc.includes('tcover') && nc.includes('hsl(');
  const fc = talentCard({ id: 1, name: 'المؤسس', is_platform_founder: true, niche: 'Tech', followers_count: 9 }, 0);
  out.founderCardPure = fc.includes('founder-card') && !fc.includes('tcover');
  // --- تسرب المؤسس بعد الخروج: دليل عضو (فيه المؤسس شرعاً) → خروج → عرض زائر.
  //     الفحص الفاصل هو الحالة المتزامنة فور عودة logout(): DOM الدليل يجب أن
  //     يكون ممسوحاً في اللحظة نفسها — لا بطاقة ولا خيار فلتر من جلسة العضو. ---
  TOKEN = 'member-tok';
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } };
  FILTERS_READY = false;
  await loadMarket();
  const mGrid = document.querySelector('#marketGrid').innerHTML;
  const mNiche = document.querySelector('#fNiche').innerHTML;
  out.memberSeesFounder = mGrid.includes('founder-card') && mGrid.includes('مؤسس الفحص') && mNiche.includes('FounderNiche');
  logout();
  const loGrid = document.querySelector('#marketGrid').innerHTML;
  const loNiche = document.querySelector('#fNiche').innerHTML;
  const loCity = document.querySelector('#fCity').innerHTML;
  out.logoutGridPurgedSync = !loGrid.includes('مؤسس الفحص') && !loGrid.includes('founder-card') && !loGrid.includes('صانع عادي');
  out.logoutFiltersPurgedSync = !loNiche.includes('FounderNiche') && !loCity.includes('FounderCity');
  await new Promise((r2) => setTimeout(r2, 100));
  const gGrid2 = document.querySelector('#marketGrid').innerHTML;
  out.guestGridClean = gGrid2.includes('صانع عادي') && !gGrid2.includes('مؤسس الفحص') && !gGrid2.includes('founder-card');
  out.guestFiltersClean = !document.querySelector('#fNiche').innerHTML.includes('FounderNiche');
  showTab('services'); showTab('market');
  await new Promise((r2) => setTimeout(r2, 100));
  out.guestNavStillClean = !document.querySelector('#marketGrid').innerHTML.includes('مؤسس الفحص')
    && !document.querySelector('#fNiche').innerHTML.includes('FounderNiche');
  // --- سباق: جلب دليل عضو بطيء يبدأ (بتفويض العضو) ثم خروج فوري وجلب زائر
  //     سريع يستقر — ردّ العضو المتأخر يجب أن يُهمَل ولا يُرسم فوق عرض الزائر. ---
  TOKEN = 'member-tok';
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } };
  FILTERS_READY = true;
  __setDirDelay(60);
  const inflight = loadMarket();
  __setDirDelay(0);
  logout();
  await inflight;
  await new Promise((r2) => setTimeout(r2, 120));
  const rGrid = document.querySelector('#marketGrid').innerHTML;
  out.raceGridClean = !rGrid.includes('مؤسس الفحص') && !rGrid.includes('founder-card');
  out.raceGridGuest = rGrid.includes('صانع عادي');
  // --- باقة «نجم Deal»: صفحة الباقة بحالتيها (قيد تحقق بلا مزايا، ثم نشط مع
  //     وقود النمو) + قسم نجم الأسبوع في السوق من حمولة الخادم وحدها ---
  TOKEN = 'member-tok';
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } };
  __setStarMe({ state: 'pending', subscription: { ref: 'REF-FX', status: 'pending', days_left: 0 }, is_week_star: false });
  await loadStarPage();
  out.starPendingShown = document.querySelector('#starBody').innerHTML.includes(t('star_pending_t'));
  out.starPendingNoFuel = !document.querySelector('#starBody').innerHTML.includes(t('star_fuel_t'));
  __setStarMe({ state: 'active', subscription: { status: 'active', days_left: 17, expires_at: Date.now() + 17 * 864e5 }, is_week_star: true });
  await loadStarPage();
  const sbActive = document.querySelector('#starBody').innerHTML;
  out.starActiveShown = sbActive.includes(t('star_active_t')) && sbActive.includes('17');
  out.starFuelShown = sbActive.includes('فكرة فحص ١') && sbActive.includes('خطوة فحص');
  out.starTermsShown = sbActive.includes(t('star_terms_t')) || document.querySelector('#starBody').innerHTML.includes(t('star_terms_t'));
  __setStarWeek({ star: { id: 5, name: 'نجم فحص', role: 'creator', niche: 'Tech', city: 'Cairo', currency: 'EGP', is_star: true, star_of_week: true, followers_count: 2 }, stats: { completed_deals: 3, completion_rate: 100, avg_stars: 5 } });
  await loadStarWeek();
  out.starWeekShown = document.querySelector('#starWeekSec').innerHTML.includes('نجم فحص');
  __setStarWeek({ star: null, stats: null });
  await loadStarWeek();
  out.starWeekHiddenWhenNone = document.querySelector('#starWeekSec').classList.contains('hide');
  // --- بطاقة السوق: مشترك نشط بإطار ذهبي وشارة، وعادي بلا أي أثر ذهبي ---
  const sc2 = talentCard({ id: 5, name: 'نجم بطاقة', role: 'creator', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 10, followers_count: 2, completion_rate: 90, avg_stars: 5, positive_pct: 100, badges: [], is_star: true, star_of_week: true }, 0);
  out.starCardFramed = sc2.includes('star-frame') && sc2.includes(t('star_chip')) && sc2.includes(t('star_week_chip'));
  const pc2 = talentCard({ id: 6, name: 'عادي بطاقة', role: 'creator', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 10, followers_count: 2, completion_rate: 90, avg_stars: 5, positive_pct: 100, badges: [] }, 0);
  out.plainCardNoStar = !pc2.includes('star-frame') && !pc2.includes(t('star_chip'));
  // --- زر «الحصول على الباقة المميزة» الموحّد (TESTING-STAR-CTA.md): نفس
  //     المكوّن في أعلى لوحتي وشريط السوق، بحالاته الثلاث من حالة الخادم ---
  __setStarMe({ state: 'none', subscription: null, is_week_star: false });
  await loadDash();
  const dashCta = document.querySelector('#dashBody').innerHTML;
  out.ctaDashBtn = dashCta.includes(t('star_get')) && dashCta.includes('goStarSubscribe()');
  out.ctaDashAtTop = dashCta.indexOf(t('star_get')) > -1 && dashCta.indexOf(t('star_get')) < dashCta.indexOf('dash-hero');
  await refreshStarCtas();
  out.ctaMarketBtn = document.querySelector('#starCtaMarket').innerHTML.includes(t('star_get'))
    && document.querySelector('#starCtaMarket').innerHTML.includes('goStarSubscribe()');
  __setStarMe({ state: 'pending', subscription: { ref: 'REF-P', status: 'pending', days_left: 0 }, is_week_star: false });
  await loadDash();
  const dashPend = document.querySelector('#dashBody').innerHTML;
  out.ctaDashPending = dashPend.includes(t('star_cta_pending')) && !dashPend.includes('goStarSubscribe()') && !dashPend.includes(t('star_get'));
  await refreshStarCtas();
  const mktPend = document.querySelector('#starCtaMarket').innerHTML;
  out.ctaMarketPending = mktPend.includes(t('star_cta_pending')) && !mktPend.includes('goStarSubscribe()');
  __setStarMe({ state: 'active', subscription: { status: 'active', days_left: 9, expires_at: Date.now() + 9 * 864e5 }, is_week_star: false });
  await loadDash();
  const dashAct = document.querySelector('#dashBody').innerHTML;
  out.ctaDashActive = dashAct.includes(t('star_cta_active')) && dashAct.includes('9') && !dashAct.includes('goStarSubscribe()') && !dashAct.includes(t('star_get'));
  await refreshStarCtas();
  out.ctaMarketActive = document.querySelector('#starCtaMarket').innerHTML.includes(t('star_cta_active'))
    && !document.querySelector('#starCtaMarket').innerHTML.includes('goStarSubscribe()');
  // --- الأهلية نفسها: المؤسس والمجمّد والزائر والمتجر خارج الزر تماماً ---
  out.ctaEligRules = starCtaEligible({ role: 'creator' }) === true && starCtaEligible({ role: 'provider' }) === true
    && starCtaEligible({ role: 'creator', is_platform_founder: true }) === false
    && starCtaEligible({ role: 'creator', frozen: 1 }) === false
    && starCtaEligible({ role: 'shop' }) === false && starCtaEligible(null) === false;
  ME = { user: { id: 1, role: 'creator', name: 'مؤسس المنصة', is_platform_founder: true } };
  await refreshStarCtas();
  out.ctaFounderMarketNone = document.querySelector('#starCtaMarket').innerHTML === '';
  ME = { user: { id: 8, role: 'creator', name: 'مجمّد فحص', frozen: 1 } };
  await refreshStarCtas();
  out.ctaFrozenMarketNone = document.querySelector('#starCtaMarket').innerHTML === '';
  ME = null;
  await refreshStarCtas();
  out.ctaGuestMarketNone = document.querySelector('#starCtaMarket').innerHTML === '';
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } };
  // --- ضغط الزر يفتح صفحة الباقة على قسم الدفع مباشرة: مبلغ ضخم + سطر شرح
  //     واحد + الرقم ظاهر تلقائياً بخط ضخم مع زر نسخ + شروط مطوية ---
  __setStarMe({ state: 'none', subscription: null, is_week_star: false });
  goStarSubscribe();
  await new Promise((r2) => setTimeout(r2, 100));
  const sbPay = document.querySelector('#starBody').innerHTML;
  const payInfoHtml = document.querySelector('#starPayInfo').innerHTML;
  out.ctaOpensPaySection = CURTAB === 'star' && sbPay.includes('id="starPaySec"') && sbPay.includes(t('star_pay_line'));
  out.ctaAmountBig = sbPay.includes('star-pay-amount') && sbPay.includes('199');
  out.ctaNumberShown = payInfoHtml.includes('01099999999') && payInfoHtml.includes('star-pay-num') && payInfoHtml.includes(t('star_copy_num'));
  out.ctaTermsCollapsed = sbPay.includes('id="starTermsBox"') && sbPay.includes('class="hide"') && sbPay.includes(t('star_terms_show')) && sbPay.includes(t('star_terms').split('\\n')[0]);
  // --- إرسال بلا مرجع ثم بلا موافقة: يُرفض محلياً برسالة ظاهرة ولا يصل الخادم ---
  const subMark = fetchLog.length;
  document.querySelector('#starRef').value = '';
  document.querySelector('#starTermsOk').checked = true;
  await doSubscribeStar({ disabled: false, innerHTML: 'x' });
  out.subNoRefRejected = !fetchLog.slice(subMark).some((f) => f.method === 'POST' && f.url.includes('/api/star/subscribe'))
    && document.querySelector('#starErr').classList.contains('show') && document.querySelector('#starErr').textContent.length > 0;
  document.querySelector('#starRef').value = 'VM-REF-1';
  document.querySelector('#starTermsOk').checked = false;
  await doSubscribeStar({ disabled: false, innerHTML: 'x' });
  out.subNoTermsRejected = !fetchLog.slice(subMark).some((f) => f.method === 'POST' && f.url.includes('/api/star/subscribe'))
    && document.querySelector('#starErr').classList.contains('show') && document.querySelector('#starErr').textContent === t('star_err_terms');
  // --- إرسال صحيح: نفس عقد الخادم القائم (قبول الشروط بنسختها + المرجع)،
  //     وينتهي «قيد التحقق» — الرقم اختفى (لا قسم دفع) ولا أي ميزة ظاهرة ---
  document.querySelector('#starTermsOk').checked = true;
  await doSubscribeStar({ disabled: false, innerHTML: 'x' });
  const subPost = fetchLog.slice(subMark).find((f) => f.method === 'POST' && f.url.includes('/api/star/subscribe'));
  let subBody = {}; try { subBody = JSON.parse(subPost.body); } catch (e) {}
  out.subPostedContract = !!subPost && subBody.terms_accepted === true && subBody.terms_version === 'star-terms-v1' && subBody.ref === 'VM-REF-1';
  await new Promise((r2) => setTimeout(r2, 80));
  const sbAfter = document.querySelector('#starBody').innerHTML;
  out.subEndsPending = sbAfter.includes(t('star_pending_t')) && !sbAfter.includes('starPaySec') && !sbAfter.includes('01099999999') && !sbAfter.includes(t('star_fuel_t'));
  // --- خانة «ملفي الشخصي»: موجودة في القائمة ولوحتي للمسجل، وتفتح الملف العام
  //     نفسه — العضو العادي بالنسخة العادية مع وصول سريع للتعديل وبلا روابط
  //     مالك، والمؤسس بنسخته الفحمية/الذهبية مع روابط لوحة المالك. ---
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } };
  buildMenu();
  out.menuHasMyProfile = document.querySelector('#menuGrid').innerHTML.includes('openMyProfile()');
  await loadDash();
  const dashMp = document.querySelector('#dashBody').innerHTML;
  out.dashHasMyProfile = dashMp.includes('openMyProfile()') && dashMp.includes(t('my_profile'));
  openMyProfile();
  await new Promise((r2) => setTimeout(r2, 60));
  const myProf = document.querySelector('#profileBody').innerHTML;
  out.myProfileNormal = myProf.includes('صانع فحص') && !myProf.includes('founder-card') && !myProf.includes('founder-ribbon');
  out.myProfileEditAccess = myProf.includes('openProfile(this)') && myProf.includes(t('edit_profile'));
  out.myProfileNoOwnerLink = !myProf.includes("showTab('owner')");
  // --- المؤسس يفتح ملفه من الخانة نفسها: نسخة المؤسس الكاملة + روابط المالك ---
  ME = { user: { id: 1, role: 'creator', name: 'مؤسس المنصة', is_platform_founder: true } };
  openMyProfile();
  await new Promise((r2) => setTimeout(r2, 60));
  const fProf = document.querySelector('#profileBody').innerHTML;
  out.founderProfileVersion = fProf.includes('founder-card') && fProf.includes('founder-ribbon') && fProf.includes(t('founder_seal'));
  out.founderOwnerLinks = fProf.includes("showTab('owner')") && fProf.includes(t('nav_owner'));
  out.founderEditAccess = fProf.includes('openProfile(this)');
  // --- عضو آخر ينظر لملف المؤسس: الهوية البصرية نفسها، لكن بلا روابط مالك ولا تعديل ---
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } };
  showProfileRoute(1);
  await new Promise((r2) => setTimeout(r2, 60));
  const fView = document.querySelector('#profileBody').innerHTML;
  out.founderViewNoOwnerLink = fView.includes('founder-card') && !fView.includes("showTab('owner')") && !fView.includes('openProfile(this)');
  // --- زائر بلا جلسة: الخانة غائبة من القائمة أصلاً، والدالة نفسها بلا أثر ---
  ME = null;
  buildMenu();
  out.guestMenuNoMyProfile = !document.querySelector('#menuGrid').innerHTML.includes('openMyProfile');
  const pbBefore = document.querySelector('#profileBody').innerHTML;
  openMyProfile();
  out.guestOpenMyProfileNoop = document.querySelector('#profileBody').innerHTML === pbBefore;
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } };
  // --- المرجع المالي الموحد: بانر الباقة لغير الموثّقين (لوحتي/السوق/الملف)
  //     يظهر لغير الموثّق ويختفي بالتوثيق، وزرّه نفس تدفق الاشتراك السهل ---
  __setStarMe({ state: 'none', subscription: null, is_week_star: false });
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } }; // بلا verified = غير موثّق
  __setMe({ user: { id: 7, role: 'creator', name: 'صانع فحص', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 0, penalty_level: 'none', frozen: 0, bio: '' }, verify_status: 'none', verify_code: null });
  await loadDash();
  const dashUv = document.querySelector('#dashBody').innerHTML;
  out.uvBannerDash = dashUv.includes('uv-banner') && dashUv.includes(t('uv_t')) && dashUv.includes(t('uv_note')) && dashUv.includes('goStarSubscribe()');
  await refreshStarCtas();
  out.uvBannerMarket = document.querySelector('#starCtaMarket').innerHTML.includes('uv-banner');
  const profD = { user: { ...ME.user, member_since: 1700000000000, portfolio: [], followers_count: 0 }, stats: { completed_deals: 0, completion_rate: 0, positive_pct: null, avg_stars: null }, badges: [], reviews: [], shorts: [] };
  out.uvProfileSlot = profilePageHtml(profD).includes('uvBannerSlot');
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص', verified: 1 } };
  __setMe({ user: { id: 7, role: 'creator', name: 'صانع فحص', niche: 'Tech', city: 'Cairo', currency: 'EGP', price: 100, followers: 0, penalty_level: 'none', frozen: 0, bio: '', verified: 1 }, verify_status: 'verified', verify_code: null });
  await loadDash();
  const dashVer = document.querySelector('#dashBody').innerHTML;
  out.uvVerifiedNoBanner = !dashVer.includes('uv-banner') && dashVer.includes('star-cta') && dashVer.includes(t('star_get'));
  out.uvVerifiedNoSlot = !profilePageHtml({ ...profD, user: ME.user }).includes('uvBannerSlot');
  ME = { user: { id: 7, role: 'creator', name: 'صانع فحص' } };
  __setMe(null);
  // --- دليل «إزاي تحوّل؟» الذكي: أول مرة موسّع، بعد أول دفعة ناجحة مطوي
  //     افتراضياً (وأزرار النسخ ظاهرة دائماً)، وللضيف موسّع دائماً، ووسيلة
  //     الدفع تتكيف مع دولة الحساب، وزر النسخ الموحّد يحمل الرقم والمبلغ ---
  PAID_ONCE = null;
  const xOb = { code: 'DL-TEST1', exact_amount: 199.43, currency: 'EGP', country: 'EG', method_label: 'فودافون كاش / إنستاباي', method_label_en: 'Vodafone Cash / InstaPay', payee_phone: '01099999999', payee: 'owner' };
  const xFirst = transferStepsHtml(xOb);
  out.xferFirstOpen = xFirst.includes('xfer-steps') && !xFirst.includes('xfer-ol hide') && xFirst.includes(t('ts_hide'));
  out.xferContent = xFirst.includes('199.43') && xFirst.includes('01099999999') && xFirst.includes(t('ts_open_eg')) && xFirst.includes(t('ts_cents_warn'));
  out.xferCopyUnified = xFirst.includes(t('cp_all')) && xFirst.includes("copyXfer(this,'all')") && xFirst.includes("copyXfer(this,'phone')") && xFirst.includes("copyXfer(this,'amount')")
    && xFirst.includes('data-phone="01099999999"') && xFirst.includes('data-amount="199.43"');
  markPaidOnce();
  const xAfter = transferStepsHtml(xOb);
  out.xferAfterPaidCollapsed = xAfter.includes('xfer-ol hide') && xAfter.includes(t('ts_show')) && xAfter.includes(t('cp_all'));
  const xGuest = transferStepsHtml(xOb, { guest: true });
  out.xferGuestAlwaysOpen = !xGuest.includes('xfer-ol hide');
  PAID_ONCE = null;
  const xSa = transferStepsHtml({ ...xOb, country: 'SA', method_label: 'STC Pay / مدى', method_label_en: 'STC Pay / mada' });
  out.xferSaudiMethod = xSa.includes('STC Pay') && xSa.includes(t('ts_open_local').split('{m}')[0].trim());
  // --- استخراج الإيصال (دالة نقية): مبلغ بالبصمة + رقم + مرجع + تاريخ ---
  const rcx = rcExtract('Total 199.43 EGP to 01099999999 ref ABC123XYZ on 22/11/2026', { exact_amount: 199.43 });
  out.rcExtractOk = rcx.amount === 199.43 && rcx.recipient === '01099999999' && rcx.ref === 'ABC123XYZ' && rcx.date === '2026-11-22';
  // --- صفحة الباقة: قسم الدفع يحمل الالتزام (كود + مبلغ بالبصمة) + الدليل + الإيصال ---
  __setStarMe({ state: 'none', subscription: null, is_week_star: false });
  goStarSubscribe();
  await new Promise((r2) => setTimeout(r2, 100));
  const sob = document.querySelector('#starObligation').innerHTML;
  out.starObligationRendered = sob.includes('DL-TEST1') && sob.includes('199.43') && sob.includes('xfer-steps') && sob.includes('receipt-box') && sob.includes(t('money_code'));
  return out;
})().catch((e) => ({ driverError: String((e && e.stack) || e) }));`;
      let uiRes = null;
      try {
        vm.runInContext(uiBlocks.join('\n;\n') + uiDriver, sandbox, { filename: 'deal-ui.js' });
        await sleep(300);
        uiRes = await sandbox.__result;
      } catch (e) { uiRes = { driverError: String((e && e.stack) || e) }; }
      check('حارس واجهة وظيفي: النقر (مع prompt مخمود) يفتح حوار السعر داخل الصفحة معبّأً وبلا استدعاء حجز',
        !!uiRes && uiRes.type === 'function' && uiRes.dlgOpened === true && uiRes.pricePrefilled === true && uiRes.noBookCallOnOpen === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: تأكيد الحوار يرسل POST للتحويل ويفتح الحجز الجديد — وprompt لم يُستدعَ أبداً',
        !!uiRes && uiRes.bookPosted === true && uiRes.bookingOpened === true && promptCalls === 0,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: فشل الخادم عند التحويل يظهر كرسالة خطأ ظاهرة داخل الحوار (لا صمت)',
        !!uiRes && uiRes.errShown === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: «المتقدمون» يعرض القائمة داخل حوار الصفحة وفشل الجلب يظهر داخل الحوار',
        !!uiRes && uiRes.appsOpened === true && uiRes.appsListed === true && uiRes.appsErrShown === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: «فتح نزاع» يفتح حواراً داخل الصفحة بلا استدعاء عند الفتح، وتأكيده يرسل POST النزاع ويغلق الحوار',
        !!uiRes && uiRes.disputeOpened === true && uiRes.noDisputeCallOnOpen === true && uiRes.disputePosted === true && uiRes.disputeClosedAfterOk === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: فشل فتح النزاع يظهر كرسالة خطأ ظاهرة داخل حوار النزاع (لا صمت)',
        !!uiRes && uiRes.disputeErrShown === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: لا prompt ولا alert استُدعيا في أي تدفق مُختبَر (بيئة الحوار المخمود)',
        promptCalls === 0 && alertCalls === 0, `prompt=${promptCalls} alert=${alertCalls}`);
      check('حارس واجهة وظيفي: مسار #/u/<id> يفتح صفحة الملف العام مباشرة بشورتس مضمّنة وعنوان باسم الصانع',
        !!uiRes && uiRes.routeProfile === true && uiRes.profileRendered === true && uiRes.profileShortsEmbedded === true && uiRes.profileTitleSet === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: زر «انسخ رابط ملفي» يؤكد «تم النسخ» على الزر نفسه',
        !!uiRes && uiRes.copyConfirmed === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: سطر «أقرب شارة» يظهر في شريط اللوحة حتى مع تقدم كله أصفار (حساب جديد) — أول شارة غير محصّلة بصيغة «أنجزت 0 من Y»',
        !!uiRes && uiRes.zeroClosestShown === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: سطر «أقرب شارة» مع تقدم جزئي يعرض الشارة الأعلى نسبة (لا الأولى) بعدّادها ونسبتها',
        !!uiRes && uiRes.partialClosestShown === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: شريط التنقل السفلي — syncTabbar موجود وshowTab يبدّل التبويب الحالي (dash ثم market) بلا أخطاء',
        !!uiRes && uiRes.tabbarFn === 'function' && uiRes.tabAfterDash === 'dash' && uiRes.tabAfterMarket === 'market',
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: ضغط زر «السوق» السفلي (نداء onclick الحقيقي) يفتح سوق الصناع — تبويب market ظاهر ويُجلب /api/directory ولا تُجلب حملات البراندات',
        !!uiRes && uiRes.tbMarketArgTab === 'market' && uiRes.tbMarketSectionShown === true
        && uiRes.tbMarketDirectoryLoaded === true && uiRes.tbCampaignsNotLoaded === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: بطاقة الصانع العادي تحمل غلافاً ملوّناً مشتقاً من المجال وبطاقة المؤسس نقية بلا الغلاف الجديد',
        !!uiRes && uiRes.cardHasCover === true && uiRes.founderCardPure === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: زائر بلا جلسة — بطاقة الصانع تحمل «اطلب من غير تسجيل» الموجّه وبطاقة مقدم الخدمة تظهر خدمته الحرة ووسم «مقدم خدمة»',
        !!uiRes && uiRes.guestCardOrderBtn === true && uiRes.providerCardSvc === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: بطاقة مقدم «إنتاج فيديوهات وإعلانات» تظهر اسم خدمته العربية ووسم «مقدم خدمة» وغلافاً ذهبياً سينمائياً (hsl 42)',
        !!uiRes && uiRes.videoSvcCard === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: طلب الضيف الموجّه — openGuest(id) يثبّت الهدف ظاهراً والإرسال يحمل target_talent_id والفتح العام يصفّيه',
        !!uiRes && uiRes.guestTargetSet === true && uiRes.guestTargetPosted === true && uiRes.guestTargetCleared === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي (تصميم): جسم طلب الضيف بلا حقل phone نهائياً ويحمل device_id لبصمة حدّ الطلبات',
        !!uiRes && uiRes.guestBodyNoPhone === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي (تصميم): قرار إخفاء المقاعد — ١٠٠ موثّقة تُغلق، و٩٩ أو مشغولة بلا توثيق تبقى مفتوحة، ومدخلات فارغة آمنة',
        !!uiRes && uiRes.seatsFullAt100Verified === true && uiRes.seatsOpenAt99Verified === true
        && uiRes.seatsOpenWhenTakenUnverified === true && uiRes.seatsNullSafe === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: نموذج الضيف معطّل أثناء جلسة عضو — النموذج مخفي وتنبيه القناة ظاهر والإرسال لا يصل الخادم',
        !!uiRes && uiRes.guestBlockedForMember === true && uiRes.guestBlockedNoPost === true,
        JSON.stringify(uiRes));
      check('حارس واجهة: logout يمسح DOM الدليل متزامناً (resetDirectoryDom) ومسارات رسم الدليل محروسة بسياق العرض (ensureDirCtx/dirCtx)',
        fnSrc('logout').includes('resetDirectoryDom') && fnSrc('loadMarket').includes('ensureDirCtx')
        && fnSrc('loadServices').includes('ensureDirCtx') && fnSrc('loadFilterOptions').includes('dirCtx()'));
      check('حارس واجهة وظيفي: سلامة خط الأساس — العضو يرى بطاقة المؤسس في السوق وخيار مجاله في فلتر المجال (من جلب العضو)',
        !!uiRes && uiRes.memberSeesFounder === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: لحظة الخروج نفسها — شبكة السوق والفلاتر ممسوحة متزامناً (لا بطاقة مؤسس ولا «FounderNiche»/«FounderCity» قبل أي جلب زائر)',
        !!uiRes && uiRes.logoutGridPurgedSync === true && uiRes.logoutFiltersPurgedSync === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: عرض الزائر بعد الخروج وبعد تنقّل بين الأقسام دون تحديث — مبني من جلب الزائر فقط ولا أثر للمؤسس فيه',
        !!uiRes && uiRes.guestGridClean === true && uiRes.guestFiltersClean === true && uiRes.guestNavStillClean === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: سباق جلب عضو بطيء مع خروج فوري — ردّ العضو المتأخر يُهمَل ولا يُرسم فوق عرض الزائر المستقر',
        !!uiRes && uiRes.raceGridClean === true && uiRes.raceGridGuest === true,
        JSON.stringify(uiRes));
      /* ===== باقة «نجم Deal» (TESTING-STAR.md): حراس بنيوية + وظيفية ===== */
      check('حارس واجهة: صفحة باقة النجم الذهبية موجودة (قسم + بطل ذهبي + شروط رسمية + مسارات الاشتراك/الدفع/الأسبوع)',
        uiHtml.includes('id="tab-star"') && uiHtml.includes('id="starBody"') && uiHtml.includes('star-hero') && uiHtml.includes('star_terms')
        && uiHtml.includes('/api/star/subscribe') && uiHtml.includes('/api/star/payment-info') && uiHtml.includes('/api/star/week')
        && fnSrc('loadStarPage').includes('/api/star/me') && fnSrc('doSubscribeStar').includes('terms_accepted'));
      check('حارس واجهة: بطاقة نجم الأسبوع القابلة للمشاركة موجودة (قسم + مسار #/s/ + زر نسخ الرابط) وإطار النجم الذهبي في البطاقات',
        uiHtml.includes('id="tab-starcard"') && uiHtml.includes('#\\/s\\/') && uiHtml.includes('copyStarCard')
        && uiHtml.includes('star-frame') && fnSrc('talentCard').includes('star-frame') && fnSrc('loadStarCardPage').includes('/api/star/week'));
      check('حارس واجهة: مسارات باقة النجم بلا أي حوار أصلي (loadStarPage/doSubscribeStar/starPayInfo/loadStarWeek)',
        !/prompt\s*\(|alert\s*\(|confirm\s*\(/.test(fnSrc('loadStarPage') + fnSrc('doSubscribeStar') + fnSrc('starPayInfo') + fnSrc('loadStarWeek')));
      check('حارس خادم: الاشتراك يشترط قبول الشروط بنسختها الحالية والمزايا تُشتق من اشتراك مؤكد غير منتهٍ فقط',
        fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').includes('terms_accepted !== true')
        && fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').includes("status='active' AND expires_at>?"));
      /* ===== زر «الحصول على الباقة المميزة» (TESTING-STAR-CTA.md): بنيوي ===== */
      check('حارس واجهة: مكوّن CTA الموحّد مربوط في الموضعين — شريط السوق (#starCtaMarket) وأعلى لوحتي من starCtaHtml وبأهلية starCtaEligible، وزرّه goStarSubscribe',
        uiHtml.includes('id="starCtaMarket"') && fnSrc('loadDash').includes('starCtaEligible') && fnSrc('loadDash').includes('starCtaHtml')
        && fnSrc('starCtaHtml').includes('goStarSubscribe()') && fnSrc('starCtaHtml').includes("t('star_get')")
        && fnSrc('starCtaHtml').includes("t('star_cta_pending')") && fnSrc('starCtaHtml').includes("t('star_cta_active')")
        && fnSrc('refreshStarCtas').includes('/api/star/me') && fnSrc('loadMarket').includes('refreshStarCtas()')
        && fnSrc('resetDirectoryDom').includes('starCtaMarket'));
      check('حارس واجهة: قسم الدفع المباشر — يُبنى في loadStarPage (starPaySec) والرقم يُجلب تلقائياً من starPayInfo بلا زر إظهار وسيط، والشروط مطوية خلف «عرض الشروط» بنصها الكامل',
        fnSrc('loadStarPage').includes('starPaySec') && fnSrc('loadStarPage').includes('await starPayInfo()')
        && fnSrc('loadStarPage').includes('star-pay-amount') && fnSrc('loadStarPage').includes("t('star_pay_line')")
        && fnSrc('loadStarPage').includes("t('star_confirm_btn')") && !fnSrc('loadStarPage').includes('star_pay_show')
        && fnSrc('starPayInfo').includes('/api/star/payment-info') && fnSrc('starPayInfo').includes('star-pay-num')
        && fnSrc('starPayInfo').includes("t('star_copy_num')")
        && fnSrc('starTermsBlockHtml').includes('starTermsBox') && fnSrc('starTermsBlockHtml').includes('starTermsHtml()')
        && fnSrc('doSubscribeStar').includes("t('star_err_terms')") && fnSrc('doSubscribeStar').includes('terms_version'));
      /* ===== خانة «ملفي الشخصي» (TESTING-PROFILE-ENTRY.md): بنيوي ===== */
      check('حارس واجهة: خانة «ملفي الشخصي» مربوطة — زر بارز في لوحتي وبند القائمة الرئيسية يفتحان الملف العام نفسه (openMyProfile → showProfileRoute بمعرّف العضو، وبلا جلسة لا يعمل)',
        fnSrc('loadDash').includes('openMyProfile()') && fnSrc('loadDash').includes("t('my_profile')")
        && fnSrc('buildMenu').includes('openMyProfile()')
        && fnSrc('openMyProfile').includes('showProfileRoute(ME.user.id)') && fnSrc('openMyProfile').includes('if(!ME)'));
      check('حارس واجهة: من ملفي العام — تعديل البيانات لصاحبه فقط، وروابط لوحة المالك في نسخة المؤسس مشروطة بـ(mine && is_platform_founder) من حمولة الخادم',
        fnSrc('profilePageHtml').includes('openProfile(this)') && fnSrc('profilePageHtml').includes("t('edit_profile')")
        && fnSrc('profilePageHtml').includes('mine&&u.is_platform_founder') && fnSrc('profilePageHtml').includes("showTab('owner')"));
      check('حارس واجهة وظيفي: صفحة الباقة في حالة «قيد تحقق» تعرض الحالة بلا أي وقود/مزايا مفعّلة',
        !!uiRes && uiRes.starPendingShown === true && uiRes.starPendingNoFuel === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: صفحة الباقة في حالة «نشط» تعرض عدّاد الأيام ووقود النمو (أفكار + خطوة) والشروط الرسمية',
        !!uiRes && uiRes.starActiveShown === true && uiRes.starFuelShown === true && uiRes.starTermsShown === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: قسم نجم الأسبوع في السوق يظهر ببيانات النجم ويختفي تماماً عند غيابه',
        !!uiRes && uiRes.starWeekShown === true && uiRes.starWeekHiddenWhenNone === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: بطاقة المشترك النشط بإطار ذهبي وشارة نجم ونجم أسبوع — وبطاقة العادي بلا أي أثر للباقة',
        !!uiRes && uiRes.starCardFramed === true && uiRes.plainCardNoStar === true,
        JSON.stringify(uiRes));
      /* ===== زر «الحصول على الباقة المميزة» (TESTING-STAR-CTA.md): وظيفي ===== */
      check('حارس واجهة وظيفي: زر «الحصول على الباقة المميزة» ظاهر أعلى لوحتي (قبل بطاقة البطل) وفي شريط السوق لعضو بلا اشتراك',
        !!uiRes && uiRes.ctaDashBtn === true && uiRes.ctaDashAtTop === true && uiRes.ctaMarketBtn === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: حالة «قيد التحقق» — شارة انتظار في الموضعين وبلا زر دفع وبلا نص الزر إطلاقاً في اللوحة',
        !!uiRes && uiRes.ctaDashPending === true && uiRes.ctaMarketPending === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: حالة «نشط» — شارة «أنت مشترك في الباقة المميزة» بعدّاد الأيام في الموضعين وبلا زر',
        !!uiRes && uiRes.ctaDashActive === true && uiRes.ctaMarketActive === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: أهلية الزر — صانع ومقدم فقط؛ المؤسس والمجمّد والمتجر والزائر خارجها، وشريط السوق فارغ لهم',
        !!uiRes && uiRes.ctaEligRules === true && uiRes.ctaFounderMarketNone === true && uiRes.ctaFrozenMarketNone === true && uiRes.ctaGuestMarketNone === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: ضغط الزر يفتح صفحة الباقة على قسم الدفع مباشرة — مبلغ ضخم وسطر شرح واحد والشروط كاملة مطوية خلف «عرض الشروط»',
        !!uiRes && uiRes.ctaOpensPaySection === true && uiRes.ctaAmountBig === true && uiRes.ctaTermsCollapsed === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: رقم التحويل ظاهر تلقائياً بخط ضخم (star-pay-num) مع زر «نسخ الرقم» — بلا أي ضغطة إظهار',
        !!uiRes && uiRes.ctaNumberShown === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: الإرسال بلا مرجع ثم بلا موافقة على الشروط يُرفض محلياً برسالة ظاهرة ولا يصل الخادم أبداً',
        !!uiRes && uiRes.subNoRefRejected === true && uiRes.subNoTermsRejected === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: الإرسال الصحيح يمر بنفس عقد الخادم (terms_accepted + terms_version الحالية + المرجع) وينتهي «قيد التحقق» بلا رقم دفع وبلا أي ميزة',
        !!uiRes && uiRes.subPostedContract === true && uiRes.subEndsPending === true,
        JSON.stringify(uiRes));
      /* ===== خانة «ملفي الشخصي» (TESTING-PROFILE-ENTRY.md): وظيفي ===== */
      check('حارس واجهة وظيفي: خانة «ملفي الشخصي» ظاهرة للمسجل في القائمة الرئيسية وفي لوحتي معاً',
        !!uiRes && uiRes.menuHasMyProfile === true && uiRes.dashHasMyProfile === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: عضو عادي يفتح «ملفي الشخصي» فيرى ملفه العام بالنسخة العادية (لا بطاقة مؤسس ولا شريط) مع وصول سريع لتعديل البيانات وبلا أي رابط للوحة المالك',
        !!uiRes && uiRes.myProfileNormal === true && uiRes.myProfileEditAccess === true && uiRes.myProfileNoOwnerLink === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: المؤسس يفتح «ملفي الشخصي» فيرى نسخة المؤسس الكاملة (بطاقة فحمية/ذهبية + شريط + ختم) مع روابط سريعة للوحة المالك وتعديل البيانات',
        !!uiRes && uiRes.founderProfileVersion === true && uiRes.founderOwnerLinks === true && uiRes.founderEditAccess === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: عضو آخر يعاين ملف المؤسس — الهوية البصرية نفسها لكن بلا روابط مالك وبلا زر تعديل (النسخة الخاصة بصاحبها فقط)',
        !!uiRes && uiRes.founderViewNoOwnerLink === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: زائر بلا جلسة — خانة «ملفي الشخصي» غائبة من القائمة أصلاً ونداء الدالة بلا جلسة لا يغيّر شيئاً',
        !!uiRes && uiRes.guestMenuNoMyProfile === true && uiRes.guestOpenMyProfileNoop === true,
        JSON.stringify(uiRes));
      /* ===== المرجع المالي الموحد (TESTING-MONEY-REF.md): وظيفي + بنيوي ===== */
      check('حارس واجهة وظيفي: بانر الباقة الذهبي لغير الموثّقين في لوحتي والسوق وملفه (مع سطر «التوثيق مجاني» وزر الاشتراك السهل نفسه)',
        !!uiRes && uiRes.uvBannerDash === true && uiRes.uvBannerMarket === true && uiRes.uvProfileSlot === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: الموثّق لا يرى البانر — يبقى على CTA الباقة العادي وبلا خانة بانر في ملفه',
        !!uiRes && uiRes.uvVerifiedNoBanner === true && uiRes.uvVerifiedNoSlot === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: دليل التحويل الذكي — أول مرة موسّع بالرقم والمبلغ بالبصمة وتنبيه الكسور وخطوة مصر، وبعد أول دفعة ناجحة مطوي افتراضياً، وللضيف موسّع دائماً',
        !!uiRes && uiRes.xferFirstOpen === true && uiRes.xferContent === true && uiRes.xferAfterPaidCollapsed === true && uiRes.xferGuestAlwaysOpen === true,
        JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: زر النسخ الموحّد «انسخ بيانات التحويل» بجانب نسخ الرقم والمبلغ منفصلين، وحمولته الرقم + المبلغ بالبصمة (data-phone/data-amount)',
        !!uiRes && uiRes.xferCopyUnified === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: وسيلة الدفع في الدليل تتكيف مع دولة الحساب — السعودي يرى «وسيلة الدفع المحلية: STC Pay»',
        !!uiRes && uiRes.xferSaudiMethod === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: استخراج الإيصال (rcExtract) يلتقط المبلغ بالبصمة ورقم المستلم والمرجع والتاريخ من نص OCR',
        !!uiRes && uiRes.rcExtractOk === true, JSON.stringify(uiRes));
      check('حارس واجهة وظيفي: قسم دفع الباقة يعرض الالتزام (كود + مبلغ بالبصمة) + دليل التحويل + صندوق رفع الإيصال',
        !!uiRes && uiRes.starObligationRendered === true, JSON.stringify(uiRes));
      check('حارس واجهة بنيوي: دليل التحويل والالتزام والإيصال مربوطة في خطوات الدفع الأربع (باقة/عمولة عضو/عربون وأخيرة/ضيف) ولوحة المالك فيها قسم المال',
        fnSrc('loadStarPage').includes('starObligation') && fnSrc('loadStarPage').includes('receiptBlockHtml')
        && fnSrc('feeInfo').includes('transferStepsHtml') && fnSrc('feeInfo').includes('receiptBlockHtml')
        && fnSrc('openBooking').includes('booking_deposit') && fnSrc('openBooking').includes('transferStepsHtml')
        && fnSrc('gFeeInfo').includes('transferStepsHtml') && fnSrc('loadGuestPage').includes('transferStepsHtml')
        && fnSrc('loadOwner').includes('/api/owner/money')
        && fnSrc('loadTesseract').includes('tesseract.js')
        && serverSrc.includes('/api/money/verify-receipt') && serverSrc.includes('money_obligations'));
    }

    /* ===== جولة «تواصل ومهام»: محادثة ضيف↔مقدم + مهام اليوم + قناة الضيف ===== */
    // عضو مسجل برقم هاتف (تمهيد: إثبات أن قناة الضيف لم تعد تفحص الأرقام أصلاً)
    r = await api('POST', '/api/auth/register', { body: { name: 'Phone Member', role: 'creator', niche: 'Tech', city: 'Cairo', contact: '01011122233', price: 300 } });
    const phoneMember = r.body.user;
    check('تسجيل عضو برقم هاتف مصري يعمل (تمهيد لاختبارات قناة الضيف بلا هاتف)', r.status === 200 && !!phoneMember, JSON.stringify(r.body));

    // --- (ج) قناة الضيف بعد إزالة حقل الهاتف (جولة التصميم): لا فحص أرقام ---
    // قرار المستخدم: «طالما المحادثة داخل التطبيق مالوش لازمة رقم الموبايل» —
    // فحص «رقم مسجل كعضو» سقط مع الحقل؛ أي phone في الجسم يُتجاهل ولا يُخزَّن.
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل', phone: '01011122233', city: 'Cairo', niche: 'Tech', budget: 100, details: 'طلب' } });
    check('طلب ضيف يحمل رقم عضو مسجل في جسمه يُقبل — لا فحص أرقام في قناة الضيف بعد إزالة الحقل', r.status === 200 && !!r.body.id, JSON.stringify(r.body));
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل', phone: '01077788899', city: 'Cairo', niche: 'Food', budget: 100, details: 'طلب' } });
    check('طلب ضيف برقم هاتف ملف عضو يُقبل أيضاً لنفس السبب (الحقل مُزال)', r.status === 200 && !!r.body.id, JSON.stringify(r.body));
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل', phone: '0512345678', country: 'SA', city: 'Riyadh', niche: 'Tech', budget: 100, details: 'طلب' } });
    check('طلب ضيف سعودي برقم عضو سعودي يُقبل — لا تطبيع ولا فحص هواتف إطلاقاً', r.status === 200 && !!r.body.id, JSON.stringify(r.body));
    r = await api('POST', '/api/guest-requests', { token: tokA, body: { business_name: 'محل', phone: '01033344455', city: 'Cairo', niche: 'Tech', budget: 100, details: 'طلب' } });
    check('طلب ضيف أثناء جلسة عضو قائمة مرفوض 403 (القناة للعملاء بلا حسابات فقط)', r.status === 403 && /مسجل الدخول/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل حر', phone: '01033344455', city: 'Cairo', niche: 'Tech', budget: 100, details: 'طلب' } });
    check('طلب ضيف برقم غير مسجل وبلا جلسة يمر عادياً (شاهد تحكم)', r.status === 200 && !!r.body.id, JSON.stringify(r.body));

    // --- (أ) محادثة عميل ضيف ↔ مقدم الخدمة ---
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'عميل محادثة', phone: '01022233344', city: 'Cairo', niche: 'Tech', budget: 500, details: 'شغلانة محادثة' } });
    const chatReqId = r.body.id, chatToken = r.body.token;
    r = await api('POST', `/api/guest-requests/${chatReqId}/book`, { token: tokA, body: {} });
    const chatBookingId = r.body.booking && r.body.booking.id;
    check('حجز ضيف للمحادثة أُنشئ بتحويل الصانع', r.status === 200 && !!chatBookingId, JSON.stringify(r.body));

    r = await api('POST', `/api/guest/${chatToken}/messages`, { body: { body: 'أهلاً، محتاج الفيديو قبل الجمعة' } });
    check('العميل الضيف يكتب من صفحة رمزه بلا أي حساب', r.status === 200 && !!r.body.message && r.body.message.sender === 'guest', JSON.stringify(r.body));
    r = await api('GET', '/api/messages', { token: tokA });
    check('عدّاد غير المقروء عند المقدم يشمل رسائل الضيوف (guest_unread_total)', (r.body.guest_unread_total || 0) >= 1, JSON.stringify(r.body));
    r = await api('GET', '/api/guest-conversations', { token: tokA });
    const conv = (r.body.items || []).find((c) => c.booking_id === chatBookingId);
    check('محادثة الضيف في قائمة محادثات المقدم بعدّاد غير مقروء = 1', !!conv && conv.unread === 1 && (r.body.unread_total || 0) >= 1, JSON.stringify(r.body));
    r = await api('GET', `/api/bookings/${chatBookingId}/guest-messages`, { token: tokA });
    check('المقدم يقرأ رسالة العميل داخل محادثة الحجز', r.status === 200 && r.body.items.length === 1 && r.body.items[0].body.includes('الجمعة'), JSON.stringify(r.body));
    r = await api('GET', '/api/guest-conversations', { token: tokA });
    const convAfter = (r.body.items || []).find((c) => c.booking_id === chatBookingId);
    check('فتح المقدم للمحادثة يعلّم رسائل العميل مقروءة (العدّاد صفر)', !!convAfter && convAfter.unread === 0, JSON.stringify(r.body));
    r = await api('POST', `/api/bookings/${chatBookingId}/guest-messages`, { token: tokA, body: { body: 'تمام، هيوصلك قبل الجمعة' } });
    check('المقدم يرد من حسابه داخل نفس المحادثة', r.status === 200 && !!r.body.message && r.body.message.sender === 'talent', JSON.stringify(r.body));
    r = await api('GET', `/api/guest/${chatToken}`);
    check('العميل يرى شارة رد غير مقروء على صفحة رمزه (chat_unread = 1)', !!r.body.booking && r.body.booking.chat_unread === 1, JSON.stringify(r.body.booking || r.body));
    r = await api('GET', `/api/guest/${chatToken}/messages`);
    check('العميل يقرأ رد المقدم من صفحة رمزه (رسالتان بالترتيب)', r.status === 200 && r.body.items.length === 2 && r.body.items[1].sender === 'talent', JSON.stringify(r.body));
    r = await api('GET', `/api/guest/${chatToken}`);
    check('بعد قراءة العميل للردود: شارة غير المقروء صفر', !!r.body.booking && r.body.booking.chat_unread === 0, JSON.stringify(r.body.booking || r.body));
    r = await api('POST', `/api/guest/${chatToken}/messages`, { body: { body: 'تمام شكراً' } });
    r = await api('GET', '/api/notifications', { token: tokA });
    check('رسالة ضيف جديدة تولّد إشعاراً داخل المنصة للمقدم', (r.body.items || []).some((n) => n.type === 'guest_message'), JSON.stringify((r.body.items || []).slice(0, 3)));

    // المؤسس والأطراف الثالثة خارج المحادثة
    r = await api('POST', `/api/bookings/${chatBookingId}/guest-messages`, { token: founderTok, body: { body: 'تدخل مؤسس' } });
    check('المؤسس لا يكتب في محادثة ضيف أبداً (400 — خارج المراسلة تماماً)', r.status === 400, JSON.stringify(r.body));
    r = await api('POST', `/api/bookings/${chatBookingId}/guest-messages`, { token: tokB, body: { body: 'طرف ثالث' } });
    check('عضو ليس طرفاً في الحجز لا يكتب في محادثته (403)', r.status === 403, JSON.stringify(r.body));
    r = await api('GET', `/api/bookings/${chatBookingId}/guest-messages`, { token: tokB });
    check('عضو ليس طرفاً في الحجز لا يقرأ محادثته (403)', r.status === 403, JSON.stringify(r.body));
    r = await api('GET', `/api/bookings/${chatBookingId}/guest-messages`, { token: founderTok });
    check('المالك يقرأ المحادثة في سياق الحجز (للنزاعات) دون أن يكون طرفاً كاتباً', r.status === 200 && r.body.items.length >= 2, JSON.stringify(r.body));
    r = await api('GET', `/api/bookings/${chatBookingId}/evidence`, { token: tokA });
    const evChat = (r.body.evidence || {}).chat || [];
    check('حزمة أدلة النزاع تتضمن محادثة الحجز كاملة وموثقة بترتيبها', evChat.length >= 3 && evChat.some((m) => m.body.includes('الجمعة')) && evChat.some((m) => m.sender === 'talent'), JSON.stringify(evChat));

    // حجز مباشر (غير ضيف): لا محادثة ضيف عليه
    r = await api('POST', '/api/bookings', { token: shopTok, body: { talent_id: creatorA.id, title: 'حجز مباشر للمهام', price: 500 } });
    const directBookingId = r.body.booking && r.body.booking.id;
    check('حجز مباشر (عضو↔عضو) أُنشئ لاختبارات المهام', r.status === 200 && !!directBookingId, JSON.stringify(r.body));
    r = await api('GET', `/api/bookings/${directBookingId}/guest-messages`, { token: tokA });
    check('محادثة ضيف على حجز غير ضيف = 404', r.status === 404, JSON.stringify(r.body));

    // --- (ب) متاح اليوم + السعة + مهام اليوم ---
    r = await api('POST', '/api/me/availability', { token: tokA, body: { available_today: true, daily_capacity: 2 } });
    check('المقدم يضبط «متاح اليوم» وسعته اليومية من لوحته', r.status === 200 && r.body.available_today === true && r.body.daily_capacity === 2, JSON.stringify(r.body));
    r = await api('POST', '/api/me/availability', { token: tokA, body: { daily_capacity: 999 } });
    check('سعة يومية فوق الحد (50) مرفوضة 400', r.status === 400, JSON.stringify(r.body));
    r = await api('POST', '/api/me/availability', { token: tokA, body: { daily_capacity: -1 } });
    check('سعة يومية سالبة مرفوضة 400', r.status === 400, JSON.stringify(r.body));
    r = await api('POST', '/api/me/availability', { token: shopTok, body: { available_today: true } });
    check('حساب محل لا يضبط إعدادات اليوم (400 — للصناع ومقدمي الخدمة فقط)', r.status === 400, JSON.stringify(r.body));
    r = await api('GET', '/api/directory');
    const dirAvail = (r.body.items || []).find((u) => u.id === creatorA.id);
    check('شارة «متاح اليوم» تظهر في الدليل العام على بطاقة المقدم', !!dirAvail && dirAvail.available_today === true, JSON.stringify(dirAvail));
    r = await api('GET', '/api/me/tasks', { token: tokA });
    const tasksA = r.body;
    check('مهام اليوم: الحجوزات النشطة بالتوازي (حجز الضيف + الحجز المباشر معاً — لا حظر مهمة واحدة) ولكل مهمة إجراء تالٍ',
      tasksA.available_today === true && tasksA.daily_capacity === 2
      && (tasksA.items || []).some((x) => x.id === chatBookingId) && (tasksA.items || []).some((x) => x.id === directBookingId)
      && (tasksA.items || []).every((x) => typeof x.next_action === 'string' && x.next_action.length > 0),
      JSON.stringify({ n: (tasksA.items || []).length, cap: tasksA.capacity_left }));
    check('سعة اليوم المتبقية = السعة − المهام النشطة بحد أدنى صفر', tasksA.capacity_left === Math.max(0, 2 - tasksA.active_count), JSON.stringify({ left: tasksA.capacity_left, active: tasksA.active_count }));
    const chatTask = (tasksA.items || []).find((x) => x.id === chatBookingId);
    check('مهمة حجز الضيف الجديدة إجراءها التالي «agree» (في انتظار اتفاقه)', !!chatTask && chatTask.next_action === 'agree', JSON.stringify(chatTask));

    // --- (ب) علم «مستعجل — تنفيذ اليوم» وأولويته ---
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'عميل عادي', phone: '01044455566', city: 'Cairo', niche: 'Tech', budget: 500, details: 'طلب عادي مطابق تماماً' } });
    const normalReqId = r.body.id;
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'عميل مستعجل', phone: '01055544433', city: 'Giza', niche: 'Food', budget: 500, details: 'طلب مستعجل من مدينة ومجال مختلفين', urgent: 1 } });
    const urgentReqId = r.body.id, urgentReqToken = r.body.token;
    check('طلب ضيف مستعجل أُنشئ بعلمه', r.status === 200 && !!urgentReqId, JSON.stringify(r.body));
    r = await api('GET', '/api/opportunities', { token: tokA });
    const idxN = r.body.items.findIndex((x) => x.kind === 'request' && x.id === normalReqId);
    const idxU = r.body.items.findIndex((x) => x.kind === 'request' && x.id === urgentReqId);
    check('«مستعجل» يتصدّر «فرص ليك» قبل طلب غير مستعجل أعلى مطابقة (100 مقابل 20)',
      idxU >= 0 && idxN >= 0 && idxU < idxN && !!r.body.items[idxU].urgent,
      JSON.stringify({ idxU, idxN, sU: idxU >= 0 ? r.body.items[idxU].score : null, sN: idxN >= 0 ? r.body.items[idxN].score : null }));
    r = await api('POST', `/api/guest-requests/${urgentReqId}/book`, { token: tokA, body: {} });
    const urgentBooking = r.body.booking;
    check('علم المستعجل ينتقل من الطلب إلى الحجز عند التحويل', r.status === 200 && !!urgentBooking && urgentBooking.urgent === true, JSON.stringify(r.body.booking || r.body));
    r = await api('GET', '/api/me/tasks', { token: tokA });
    check('الحجز المستعجل أول قائمة مهام اليوم وبعلمه ظاهراً', (r.body.items || []).length > 0 && r.body.items[0].id === urgentBooking.id && r.body.items[0].urgent === true, JSON.stringify((r.body.items || []).slice(0, 2)));
    r = await api('POST', `/api/guest/${urgentReqToken}/urgent`, { body: { urgent: 0 } });
    check('العميل الضيف يلغي علم المستعجل من صفحة رمزه', r.status === 200 && !!r.body.booking && r.body.booking.urgent === false, JSON.stringify(r.body.booking || r.body));
    r = await api('POST', `/api/guest/${urgentReqToken}/urgent`, { body: { urgent: 1 } });
    check('العميل الضيف يعيد تفعيل علم المستعجل من صفحة رمزه', r.status === 200 && !!r.body.booking && r.body.booking.urgent === true, JSON.stringify(r.body.booking || r.body));
    r = await api('POST', `/api/bookings/${directBookingId}/urgent`, { token: tokA, body: { urgent: 1 } });
    check('منفذ الحجز لا يضع علم المستعجل على حجز عضو (403 — من العميل فقط)', r.status === 403, JSON.stringify(r.body));
    r = await api('POST', `/api/bookings/${directBookingId}/urgent`, { token: shopTok, body: { urgent: 1 } });
    check('العميل العضو صاحب الحجز يضع علم المستعجل على حجزه', r.status === 200 && !!r.body.booking && r.body.booking.urgent === true, JSON.stringify(r.body.booking || r.body));

    // --- حراس بنيوية للجولة ---
    const srvSrcCT = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const htmlSrcCT = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check('حارس بنيوي: الخادم فيه مسارات محادثة الضيف وبصمة قناة الضيف (فحص أرقام الأعضاء أُزيل مع حقل الهاتف بقرار جولة التصميم) ومهام اليوم وعلم المستعجل',
      srvSrcCT.includes('/api/guest/:token/messages') && srvSrcCT.includes('/api/guest-conversations')
      && srvSrcCT.includes('/api/bookings/:id/guest-messages') && srvSrcCT.includes('guestFingerprint')
      && srvSrcCT.includes('guest_fp') && !srvSrcCT.includes('guestNumberIsMember')
      && srvSrcCT.includes('/api/me/availability')
      && srvSrcCT.includes('/api/me/tasks') && srvSrcCT.includes('/api/bookings/:id/urgent'));
    check('حارس بنيوي: الواجهة فيها محادثة الضيف ومهام اليوم وتعطيل نموذج الضيف للمسجلين وعلم المستعجل',
      htmlSrcCT.includes('guestBlocked') && htmlSrcCT.includes('gUrgent') && htmlSrcCT.includes('/api/guest-conversations')
      && htmlSrcCT.includes('openGuestThread') && htmlSrcCT.includes('/api/me/tasks') && htmlSrcCT.includes('saveAvailability')
      && htmlSrcCT.includes('na_submit_proof') && htmlSrcCT.includes('guest_blocked_d') && htmlSrcCT.includes('bChatLog'));


    /* ===== مركز الثقة — تطوير «إزاي بتشتغل؟» (TESTING-TRUST-CENTER.md) ===== */
    const htmlTC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const trustStart = htmlTC.indexOf('id="trustCenter"');
    const trustEnd = htmlTC.indexOf('</section>', trustStart);
    const trustBlock = trustStart >= 0 && trustEnd > trustStart ? htmlTC.slice(trustStart, trustEnd) : '';
    const heroSegTC = htmlTC.slice(0, htmlTC.indexOf('<main'));
    check('مركز الثقة: عرض مستقل يُفتح من القائمة الرئيسية — القسم الكامل خارج الرئيسية وشريط مضغوط يربط به، بلا مسارات API وبلا حوارات أصلية',
      htmlTC.includes('id="tab-trust"') && htmlTC.includes("showTab('trust')") && htmlTC.includes('trust_center_nav')
      && trustStart > htmlTC.indexOf('<main') && trustEnd > trustStart
      && !heroSegTC.includes('id="trustCenter"') && heroSegTC.includes('trust-strip')
      && !trustBlock.includes('/api/') && !/(prompt|alert|confirm)\s*\(/.test(trustBlock));
    const tcKeys = ['tc_kicker','tc_title','tc_sub','tc_example','tc_eq','tc_a50','tc_a225','tc_s1_t','tc_s1_d','tc_s2_t','tc_s2_d','tc_s3_a','tc_s3_t','tc_s3_d','tc_s4_t','tc_s4_d','tc_s5_a','tc_s5_t','tc_s5_d','tc_s6_t','tc_s6_d','tc_p2p_t','tc_p2p','tc_g_t','tc_g_sub','tc_g1_t','tc_g1_d','tc_g2_t','tc_g2_d','tc_g3_t','tc_g3_d','tc_g4_t','tc_g4_d','tc_g5_t','tc_g5_d','tc_g6_t','tc_g6_d','tc_badges_t','tc_b1','tc_b2','tc_b3','tc_b4','tc_b5','tc_b6'];
    const tcMissingDef = tcKeys.filter((k) => (htmlTC.match(new RegExp(k + ':', 'g')) || []).length < 2);
    const tcMissingUse = tcKeys.filter((k) => !htmlTC.includes(`data-i18n="${k}"`));
    check('مركز الثقة: كل مفاتيح tc_* معرّفة في القاموسين (AR/EN) ومستخدمة في الواجهة', tcMissingDef.length === 0 && tcMissingUse.length === 0, JSON.stringify({ tcMissingDef, tcMissingUse }));
    const stageNums = [...trustBlock.matchAll(/data-stage="(\d+)"/g)].map((m) => m[1]);
    check('رحلة الفلوس: ست مراحل مرقّمة بالترتيب 1..6', stageNums.join(',') === '1,2,3,4,5,6' && (trustBlock.match(/class="journey-step"/g) || []).length === 6, stageNums.join(','));
    const stageAmounts = {};
    for (const m of trustBlock.matchAll(/data-stage="(\d+)"(?: data-amount="(\d+)")?/g)) stageAmounts[m[1]] = m[2] || null;
    check('رحلة الفلوس: مبالغ المراحل المدفوعة 50 ثم 225 ثم 225 ثم 225 (عمولة/عربون/محتجَز/إفراج)',
      stageAmounts['1'] === '50' && stageAmounts['2'] === '225' && stageAmounts['4'] === '225' && stageAmounts['6'] === '225' && stageAmounts['3'] === null, JSON.stringify(stageAmounts));
    check('رحلة الفلوس: المثال الثابت ٥٠٠ ومعادلته في النصين العربي والإنجليزي',
      trustBlock.includes('٥٠٠') && htmlTC.includes('٥٠ عمولة + ٢٢٥ عربون + ٢٢٥ باقٍ محتجَز = ٥٠٠')
      && htmlTC.includes('50 fee + 225 deposit + 225 held balance = 500'));
    check('رحلة الفلوس: مراحل التنفيذ والإثبات والاحتجاز والتأكيد والإفراج بالنصين، ومهلة تحكيم ٣ ساعات بدل نافذة التأكيد الزمنية',
      trustBlock.includes('data-appeal="3"') && !trustBlock.includes('data-window="24"')
      && htmlTC.includes('طلب تحكيم بعد ٣ ساعات') && htmlTC.includes('arbitration 3 hours')
      && htmlTC.includes('server-timestamped') && !htmlTC.includes('فيتم التأكيد تلقائياً') && !htmlTC.includes('24 hours pass'));
    const P2P_EXACT_TC = 'المعاملات P2P — فلوسك بتتحرك بين المحافظ الشخصية مباشرة (فودافون كاش/إنستاباي)، وDeal بينظّم ويوثّق ويحمي ومش بنك';
    check('مركز الثقة: نص P2P المعتمد حرفياً ظاهر في القسم والقاموس العربي', (htmlTC.match(new RegExp(P2P_EXACT_TC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length >= 2 && trustBlock.includes(P2P_EXACT_TC));
    const guaranteeNames = ['احتجاز الباقي عند Deal', 'ضمان الاستبدال', 'تجميد فوري ومراجعة عادلة عند النزاع', 'التقييم يُفتح فقط بعد اكتمال القبض', 'أعضاء موثّقون بكود ملكية', 'سجل موثّق لكل خطوة مالية لا يُعدَّل ولا يُحذف'];
    check('مركز الثقة: ست بطاقات ضمان بالأسماء الستة المعلنة', (trustBlock.match(/data-guarantee=/g) || []).length === 6 && guaranteeNames.every((n) => trustBlock.includes(n)), guaranteeNames.filter((n) => !trustBlock.includes(n)).join('|'));
    check('ضمان الاستبدال بصياغة صادقة: بديل بنفس الشروط «متى توفّر» أو مراجعة عبر مسار النزاع لبحث رد العربون — بلا ادعاء رد تلقائي',
      trustBlock.includes('متى توفّر') && trustBlock.includes('مسار النزاع') && trustBlock.includes('لبحث رد العربون وفق الأدلة')
      && !trustBlock.includes('يُردّ العربون تلقائياً') && !trustBlock.includes('رد فوري للعربون') && !trustBlock.includes('استرداد تلقائي'));
    const badgeSymbols = [...trustBlock.matchAll(/<span class="trust-badge-symbol">([^<]+)<\/span>/g)].map((m) => m[1]);
    check('صف شارات الثقة: ست شارات رموز بصرية خالصة (لا حروف ولا أرقام داخل الشارة) والتسميات نص عادي بجوارها',
      badgeSymbols.length === 6 && badgeSymbols.every((x) => !/[A-Za-z0-9\u0600-\u06FF]/.test(x))
      && (trustBlock.match(/class="trust-badge-label"/g) || []).length === 6, JSON.stringify(badgeSymbols));
    check('مركز الثقة: حركة CSS خالصة عند الظهور (تدفق الخط ونبض العقد ودخول المراحل) مع احترام تقليل الحركة',
      htmlTC.includes('@keyframes journeyFlow') && htmlTC.includes('@keyframes journeyIn') && htmlTC.includes('@keyframes trustPulse')
      && htmlTC.includes('.journey-shell.in .journey-progress') && htmlTC.includes('prefers-reduced-motion'));
    const tcDictSegs = [...htmlTC.matchAll(/tc_kicker:[\s\S]*?seats_t:/g)].map((m) => m[0]);
    check('مركز الثقة: لا «٤٨ ساعة» في أسطح الشرح المستهدفة (القسم + قاموسا tc_*) — النوافذ ٢٤ فقط',
      !/(٤٨|48\s*ساعة|48\s*hours|48h)/.test(trustBlock) && tcDictSegs.length === 2 && tcDictSegs.every((x) => !/(٤٨|48\s*hours|48h)/.test(x)));
    check('أصول محمية لم تُمس: ملف تحقق جوجل ومفتاح IndexNow وrobots وsitemap وكتلة JSON-LD',
      fs.readFileSync(path.join(__dirname, '..', 'public', 'googleda624c6a29aca769.html'), 'utf8').trim() === 'google-site-verification: googleda624c6a29aca769.html'
      && fs.readFileSync(path.join(__dirname, '..', 'public', '7e4e785e9e2c81a3de1598c0816c7e8e.txt'), 'utf8').trim() === '7e4e785e9e2c81a3de1598c0816c7e8e'
      && fs.readFileSync(path.join(__dirname, '..', 'public', 'robots.txt'), 'utf8').includes('Sitemap: https://deal-nine-ruddy.vercel.app/sitemap.xml')
      && fs.readFileSync(path.join(__dirname, '..', 'public', 'sitemap.xml'), 'utf8').includes('https://deal-nine-ruddy.vercel.app/')
      && htmlTC.includes('application/ld+json') && htmlTC.includes('"@graph"'));

    /* ===== جولة «الملف الاجتماعي الكامل + اقتراحا ١ و٢» =====
       تخصيص (غلاف/لون)، منشورات وتفاعلات، صداقة وبوابة مراسلة، مقاعد مؤسسين
       وجدار عام، رابط حجز + QR بنيوياً، وبطاقة صفقة موثقة بلا مبلغ/هاتف. */
    const htmlSoc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const pgQuery = async (sql, params) => { const c = new Client({ connectionString: DATABASE_URL }); await c.connect(); const q = await c.query(sql, params); await c.end(); return q.rows; };

    /* --- (د) مقاعد المؤسسين: إسناد بالأسبقية العالمية والمؤسس مستثنى --- */
    r = await api('GET', '/api/me', { token: founderTok });
    check('مقاعد المؤسسين: حساب المؤسس (is_platform_founder) بلا رقم مقعد — ختمه منفصل',
      r.status === 200 && (r.body.user.founder_seat === null || r.body.user.founder_seat === undefined));
    r = await api('GET', `/api/talent/${creatorA.id}`);
    check('مقاعد المؤسسين: أول صانع مؤهل مسجل = مقعد #1 على ملفه العام', r.status === 200 && r.body.user.founder_seat === 1, JSON.stringify(r.body.user && r.body.user.founder_seat));
    r = await api('GET', `/api/talent/${creatorB.id}`);
    check('مقاعد المؤسسين: الترتيب تصاعدي بتسلسل التسجيل (B بعد A)', r.status === 200 && r.body.user.founder_seat === 2);
    r = await api('GET', '/api/directory');
    const dirSeatA = r.body.items.find((u) => u.id === creatorA.id);
    check('مقاعد المؤسسين: الرقم يظهر في بطاقة السوق أيضاً', !!dirSeatA && dirSeatA.founder_seat === 1);
    r = await api('GET', '/api/founders-wall');
    const wall0 = r.body;
    check('جدار المؤسسين: ١٠٠ مقعد بالضبط، المشغول بالأولوية، والشاغر ظل بلا بيانات',
      r.status === 200 && Array.isArray(wall0.seats) && wall0.seats.length === 100
      && wall0.seats[0].taken === true && wall0.seats[0].user_id === creatorA.id
      && wall0.seats[99].taken === false && wall0.closed === false && wall0.taken >= 3, JSON.stringify(wall0.taken));
    check('جدار المؤسسين: لا بيانات تواصل في أي مقعد مشغول (قائمة بيضاء صارمة)',
      wall0.seats.filter((s) => s.taken).every((s) => !('contact' in s) && !('phone' in s)));

    /* --- (أ) تخصيص البروفايل: غلاف + لون تمييز --- */
    r = await api('POST', '/api/auth/register', { body: { name: 'Social X', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'socx@test', price: 150 } });
    const socX = r.body.user, tokX = r.body.token;
    r = await api('POST', '/api/auth/register', { body: { name: 'Social Y', role: 'creator', niche: 'Food', city: 'Giza', contact: 'socy@test', price: 120 } });
    const socY = r.body.user, tokY = r.body.token;
    const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    r = await api('PATCH', '/api/me/profile', { token: tokX, body: { accent: 'sapphire', cover: tinyJpeg } });
    check('تخصيص: حفظ لون تمييز من اللوحة + غلاف شخصي ينجح ويُحفظ',
      r.status === 200 && r.body.user.accent === 'sapphire' && String(r.body.user.cover).startsWith('data:image/'), JSON.stringify(r.status));
    r = await api('PATCH', '/api/me/profile', { token: tokX, body: { accent: 'notacolor' } });
    check('تخصيص: لون خارج اللوحة المنسّقة مرفوض 400', r.status === 400);
    r = await api('PATCH', '/api/me/profile', { token: founderTok, body: { accent: 'gold' } });
    check('تخصيص: المؤسس لا تنطبق عليه الألوان إطلاقاً (400 — هويته ثابتة)', r.status === 400);
    r = await api('PATCH', '/api/me/profile', { token: founderTok, body: { cover: tinyJpeg } });
    check('تخصيص: المؤسس لا غلاف شخصي له (400)', r.status === 400);
    r = await api('GET', `/api/talent/${socX.id}`);
    check('تخصيص: اللون والغلاف ينعكسان على الملف العام', r.status === 200 && r.body.user.accent === 'sapphire' && String(r.body.user.cover).startsWith('data:image/'));
    check('شارات البروفايل: أعلى شارة مكتسبة تقود لمسة الإطار (top_badge) وعدّاد الصفقات الموثقة موجود',
      r.status === 200 && 'top_badge' in r.body.user && typeof r.body.user.verified_deals === 'number');

    /* --- (ج) الصداقة + بوابة المراسلة --- */
    r = await api('POST', `/api/users/${socY.id}/friend-request`, { token: tokX, body: {} });
    check('صداقة: إرسال طلب ينجح بحالة pending_out', r.status === 200 && r.body.friend_state === 'pending_out');
    r = await api('POST', `/api/users/${socY.id}/friend-request`, { token: tokX, body: {} });
    check('صداقة: إعادة إرسال الطلب نفسه آمنة (idempotent)', r.status === 200 && r.body.friend_state === 'pending_out');
    r = await api('POST', `/api/messages/${socY.id}`, { token: tokX, body: { body: 'قبل الصداقة' } });
    check('بوابة المراسلة: إرسال رسالة لغير صديق مرفوض 403 برسالة واضحة',
      r.status === 403 && /أصدقاء|friends/i.test(r.body.error || ''), JSON.stringify(r.body));
    r = await api('GET', `/api/messages/${socY.id}`, { token: tokX });
    check('بوابة المراسلة: فتح المحادثة ممكن للقراءة مع can_message=false قبل الصداقة',
      r.status === 200 && r.body.can_message === false && r.body.friend_state === 'pending_out');
    r = await api('GET', '/api/me/friends', { token: tokY });
    check('صداقة: الطلب الوارد يظهر عند الطرف الآخر', r.status === 200 && r.body.incoming.some((x) => x.id === socX.id));
    r = await api('GET', '/api/notifications', { token: tokY });
    check('صداقة: إشعار طلب الصداقة وصل', r.body.items.some((n) => n.type === 'friend_request'));
    r = await api('POST', `/api/users/${socX.id}/friend-decline`, { token: tokY, body: {} });
    check('صداقة: الرفض ينجح ويعيد الحالة لغير الأصدقاء', r.status === 200 && r.body.friend_state === 'declined');
    r = await api('POST', `/api/users/${socY.id}/friend-request`, { token: tokX, body: {} });
    check('صداقة: بعد الرفض يمكن إعادة الطلب (لا طريق مسدود)', r.status === 200 && r.body.friend_state === 'pending_out');
    r = await api('POST', `/api/users/${socX.id}/friend-accept`, { token: tokY, body: {} });
    check('صداقة: القبول ينجح والحالة تصبح friends', r.status === 200 && r.body.friend_state === 'friends');
    r = await api('GET', '/api/notifications', { token: tokX });
    check('صداقة: إشعار قبول الصداقة وصل للطالب', r.body.items.some((n) => n.type === 'friend_accepted'));
    r = await api('POST', `/api/messages/${socY.id}`, { token: tokX, body: { body: 'بعد الصداقة' } });
    check('بوابة المراسلة: الإرسال بين صديقين مقبولين ينجح', r.status === 200 && r.body.ok === true);
    r = await api('GET', '/api/messages', { token: tokX });
    const convY = r.body.items.find((c) => c.user.id === socY.id);
    check('بوابة المراسلة: محادثة الصديق can_message=true في القائمة', !!convY && convY.can_message === true);
    r = await api('POST', `/api/users/${founder.id}/friend-request`, { token: tokX, body: {} });
    check('صداقة: أي طلب صداقة إلى المؤسس مرفوض 400 (خارج الصداقة تماماً)', r.status === 400);
    r = await api('POST', `/api/users/${socX.id}/friend-request`, { token: founderTok, body: {} });
    check('صداقة: أي طلب صداقة من المؤسس مرفوض 400 أيضاً', r.status === 400);
    r = await api('POST', `/api/users/${socX.id}/friend-request`, { token: tokX, body: {} });
    check('صداقة: طلب صداقة للنفس مرفوض 400', r.status === 400);
    r = await api('POST', `/api/users/${socX.id}/unfriend`, { token: tokY, body: {} });
    check('صداقة: إلغاء الصداقة ينجح', r.status === 200 && r.body.friend_state === 'none');
    r = await api('POST', `/api/messages/${socY.id}`, { token: tokX, body: { body: 'بعد الإلغاء' } });
    check('بوابة المراسلة: بعد إلغاء الصداقة يعود الرفض 403 فوراً', r.status === 403);
    r = await api('GET', `/api/messages/${socY.id}`, { token: tokX });
    check('بوابة المراسلة: المحادثة القديمة تبقى مقروءة (سجلها محفوظ) مع can_message=false',
      r.status === 200 && r.body.can_message === false && r.body.items.length >= 1);

    /* --- (ب) منشورات البروفايل والتفاعلات --- */
    r = await api('POST', `/api/users/${socX.id}/posts`, { token: tokX, body: { body: 'عرضي الأول: فيديو إعلاني لأي محل', link: 'https://example.com/work1' } });
    const post1 = r.body.post;
    check('منشورات: النشر على ملفي ينجح مع رابط عمل', r.status === 200 && !!post1 && post1.id > 0);
    r = await api('POST', `/api/users/${socY.id}/posts`, { token: tokX, body: { body: 'على ملف غيري' } });
    check('منشورات: النشر على ملف عضو آخر مرفوض 403', r.status === 403);
    r = await api('POST', `/api/users/${socX.id}/posts`, { token: tokX, body: { body: '   ' } });
    check('منشورات: منشور فارغ مرفوض 400', r.status === 400);
    r = await api('POST', `/api/users/${socX.id}/posts`, { token: tokX, body: { body: 'برابط خبيث', link: 'javascript:alert(1)' } });
    check('منشورات: رابط غير http(s) مرفوض 400', r.status === 400);
    r = await api('GET', `/api/users/${socX.id}/posts`);
    check('منشورات: الزائر يقرأ المنشورات بلا أي تسجيل', r.status === 200 && r.body.items.length === 1);
    r = await api('POST', `/api/posts/${post1.id}/react`, { body: { kind: 'love' } });
    check('تفاعلات: الزائر لا يتفاعل (401 — التفاعل للأعضاء فقط)', r.status === 401);
    r = await api('POST', `/api/posts/${post1.id}/react`, { token: tokY, body: { kind: 'love' } });
    check('تفاعلات: ❤️ من عضو مسجل تُحتسب', r.status === 200 && r.body.post.reactions.love === 1 && r.body.post.my_reactions.includes('love'));
    r = await api('GET', '/api/notifications', { token: tokX });
    const reactNotifs1 = r.body.items.filter((n) => n.type === 'post_reaction').length;
    check('تفاعلات: إشعار لصاحب المنشور عند أول تفاعل من الشخص', reactNotifs1 === 1);
    r = await api('POST', `/api/posts/${post1.id}/react`, { token: tokY, body: { kind: 'clap' } });
    check('تفاعلات: 👏 نوع ثانٍ مستقل يُحتسب أيضاً', r.status === 200 && r.body.post.reactions.clap === 1);
    r = await api('GET', '/api/notifications', { token: tokX });
    check('تفاعلات: لا إشعار ثانٍ من نفس الشخص على نفس المنشور (مرة واحدة لكل شخص)',
      r.body.items.filter((n) => n.type === 'post_reaction').length === 1);
    r = await api('POST', `/api/posts/${post1.id}/react`, { token: tokY, body: { kind: 'love' } });
    check('تفاعلات: الضغط مجدداً يلغي التفاعل (toggle)', r.status === 200 && r.body.post.reactions.love === 0 && !r.body.post.my_reactions.includes('love'));
    r = await api('POST', `/api/posts/${post1.id}/react`, { token: tokY, body: { kind: 'wow' } });
    check('تفاعلات: نوع ثالث غير مسموح مرفوض 400 (نوعان كحد أقصى)', r.status === 400);
    r = await api('POST', `/api/users/${socX.id}/posts`, { token: tokX, body: { body: 'منشور ثانٍ للتثبيت' } });
    const post2 = r.body.post;
    r = await api('POST', `/api/posts/${post2.id}/pin`, { token: tokX, body: {} });
    check('منشورات: تثبيت منشور ينجح ويظهر مثبّتاً', r.status === 200 && r.body.post.pinned === true);
    r = await api('POST', `/api/posts/${post1.id}/pin`, { token: tokX, body: {} });
    r = await api('GET', `/api/users/${socX.id}/posts`);
    check('منشورات: مثبّت واحد فقط لكل بروفايل والمثبّت يتصدّر القائمة',
      r.status === 200 && r.body.items.filter((p) => p.pinned).length === 1 && r.body.items[0].id === post1.id);
    r = await api('POST', `/api/posts/${post1.id}/pin`, { token: tokY, body: {} });
    check('منشورات: تثبيت منشور غيرك مرفوض 403', r.status === 403);
    r = await api('PATCH', `/api/posts/${post1.id}`, { token: tokY, body: { body: 'تعديل غيري' } });
    check('منشورات: تعديل منشور غيرك مرفوض 403', r.status === 403);
    r = await api('PATCH', `/api/posts/${post1.id}`, { token: tokX, body: { body: 'عرضي الأول — محدّث', link: '' } });
    check('منشورات: تعديل صاحب المنشور ينجح', r.status === 200 && /محدّث/.test(r.body.post.body));
    r = await api('DELETE', `/api/posts/${post2.id}`, { token: tokY });
    check('منشورات: حذف منشور غيرك مرفوض 403', r.status === 403);
    r = await api('DELETE', `/api/posts/${post2.id}`, { token: tokX });
    check('منشورات: حذف صاحب المنشور ينجح', r.status === 200 && r.body.ok === true);

    /* --- (هـ) اقتراح ١ بنيوياً: رابط الحجز + QR في الواجهة --- */
    check('رابط الحجز: بطاقة «رابط الحجز بتاعي» في لوحتي برابط ?book=1 وQR مرسوم محلياً',
      htmlSoc.includes("?book=1") && htmlSoc.includes('bookQr') && htmlSoc.includes('drawQr') && htmlSoc.includes('function qrEncode'));
    check('رابط الحجز: زر «احجزني عبر Deal» البارز في الملف العام للزوار',
      htmlSoc.includes('book_me_btn') && htmlSoc.includes("openGuest(d.user.id, d.user.name)"));

    /* --- (و) اقتراح ٢: بطاقة صفقة موثقة --- */
    await pgSet('INSERT INTO bookings (client_id, talent_id, guest_name, title, price, status, completed_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [null, creatorA.id, 'Alpha Store Branch', 'صفقة فحص البطاقة', 77777, 'completed', Date.now(), Date.now()]);
    const dealRow = await pgQuery('SELECT id FROM bookings WHERE price=77777 AND talent_id=$1 ORDER BY id DESC LIMIT 1', [creatorA.id]);
    const dealId = dealRow[0].id;
    r = await api('GET', `/api/deals/${dealId}`);
    check('بطاقة الصفقة: حجز مكتمل يعرض بطاقة عامة (اسم الصانع + أول اسم العميل فقط)',
      r.status === 200 && r.body.verified_deal === true && r.body.talent.id === creatorA.id && r.body.client_first_name === 'Alpha', JSON.stringify(r.body));
    check('بطاقة الصفقة: لا مبلغ ولا هاتف ولا أي بيانات تواصل في الرد إطلاقاً',
      !JSON.stringify(r.body).includes('77777') && !JSON.stringify(r.body).includes('a@test')
      && !('price' in r.body) && !('contact' in r.body.talent) && !('phone' in r.body.talent));
    await pgSet('INSERT INTO bookings (client_id, talent_id, guest_name, title, price, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [null, creatorA.id, '', 'صفقة غير مكتملة', 88888, 'in_progress', Date.now()]);
    const openRow = await pgQuery('SELECT id FROM bookings WHERE price=88888 ORDER BY id DESC LIMIT 1', []);
    r = await api('GET', `/api/deals/${openRow[0].id}`);
    check('بطاقة الصفقة: حجز غير مكتمل → 404 (البطاقة للمكتمل فقط)', r.status === 404);
    r = await api('GET', '/api/deals/99999999');
    check('بطاقة الصفقة: حجز غير موجود → 404', r.status === 404);
    r = await api('GET', `/api/talent/${creatorA.id}`);
    check('بطاقة الصفقة: عدّاد «صفقات موثقة عبر Deal» على البروفايل من المكتمل فعلياً (>= 1)',
      r.status === 200 && r.body.user.verified_deals >= 1 && r.body.stats.completed_deals >= 1);
    check('بطاقة الصفقة: صفحة المشاركة #/d/<id> وزر البطاقة داخل الحجز المكتمل في الواجهة',
      htmlSoc.includes('#/d/') && htmlSoc.includes('loadDealCardPage') && htmlSoc.includes('dealcard_btn'));

    /* --- إغلاق فئة المؤسسين عند ١٠٠ في بيانات اختبار --- */
    r = await api('GET', '/api/founders-wall');
    const takenNow = r.body.taken;
    const need = 100 - takenNow;
    let lastSeatUser = null;
    for (let i = 0; i < need; i++) {
      const rr = await api('POST', '/api/auth/register', { body: { name: `Seat Filler ${i}`, role: 'creator', niche: 'Tech', city: 'Cairo', contact: `seatfill${i}@test`, price: 50 } });
      lastSeatUser = rr.body.user;
    }
    check('مقاعد المؤسسين: آخر مقعد يُشغل برقم 100 بالضبط', !!lastSeatUser && lastSeatUser.founder_seat === 100, JSON.stringify(lastSeatUser && lastSeatUser.founder_seat));
    r = await api('POST', '/api/auth/register', { body: { name: 'Seat Overflow', role: 'creator', niche: 'Tech', city: 'Cairo', contact: 'seatoverflow@test', price: 50 } });
    check('مقاعد المؤسسين: أول مسجل بعد المئة بلا مقعد (الفئة أُغلقت نهائياً)',
      r.status === 200 && (r.body.user.founder_seat === null || r.body.user.founder_seat === undefined));
    r = await api('GET', '/api/founders-wall');
    check('جدار المؤسسين: عند الاكتمال taken=100 وclosed=true ولا مقعد شاغر',
      r.status === 200 && r.body.taken === 100 && r.body.closed === true && r.body.seats.every((s) => s.taken));
    check('جدار المؤسسين: كل مقعد يحمل علم verified (مدخل قرار إخفاء خانة المقاعد الموثّقة في الواجهة) — والاكتمال هنا تسجيلاً لا توثيقاً فلا إخفاء بعد',
      r.body.seats.every((s) => typeof s.verified === 'boolean') && r.body.seats.filter((s) => s.taken && s.verified).length < 100);

    /* --- قاموسا اللغتين لكل نصوص الجولة --- */
    const socKeys = ['book_me_btn', 'wall_t', 'friends_t', 'friend_add', 'msg_friends_only', 'thread_readonly', 'posts_t', 'post_publish', 'booklink_t', 'dealcard_t', 'verified_deals_w', 'pf_cover', 'pf_accent'];
    check('قاموسا AR/EN: كل مفاتيح الجولة موجودة في القاموسين معاً',
      socKeys.every((k) => (htmlSoc.match(new RegExp(k + ':', 'g')) || []).length >= 2),
      socKeys.filter((k) => (htmlSoc.match(new RegExp(k + ':', 'g')) || []).length < 2).join(','));

    /* ===== سفراء المدن = نقاط التحصيل المحلية (اقتراح ٤ — TESTING-AMBASSADOR.md) =====
       قرارات الجولة: المالك وحده يعيّن سفيراً من الأعضاء الموثّقين فقط (غير
       موثّق → 400، والمؤسس لا يُعيَّن أبداً)، سفير فعّال واحد لكل (دولة،
       مدينة) والبديل يُلغي السابق مع بقاء سجله، والمقابل حقل عرض فقط.
       نطاق الالتزام = مدينة/دولة الدافع: خطوة دفعه تعرض رقم سفير نطاقه بدل
       رقم المالك، وبوابة الإيصال تقبل رقم السفير النشط لنطاق الالتزام بنفس
       الصرامة، والمُحصّل يُختَم لحظة التأكيد فتبقى محصّلات السفير وتسوياته
       ثابتة عبر التبديلات. مدينة اختبار فريدة «AmbCity» حتى لا تتداخل الجولة
       مع أي قسم سابق، ورقم المالك الافتراضي في الاختبارات TEST_PHONE. */
    const cryptoA = require('crypto');
    const ambImg = (uid) => {
      const bytes = Buffer.from('amb-receipt-' + uid);
      return { dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), hash: cryptoA.createHash('sha256').update(bytes).digest('hex') };
    };
    const AMB_PHONE = '01077777777', AMB3_PHONE = '01088888888';
    const regAmbCity = async (contact, city) => {
      const rr = await api('POST', '/api/auth/register', { body: { name: 'Amb ' + contact, role: 'creator', niche: 'Tech', city, contact, price: 100 } });
      return rr.body;
    };
    const verifyAmbUser = async (tok, name) => {
      const rq = await api('POST', '/api/verify/request', { token: tok });
      return api('POST', '/api/verify/check', { token: tok, body: { url: `${AUX}/bio?code=${encodeURIComponent(rq.body.code)}&name=${encodeURIComponent(name)}` } });
    };
    const ambUser = await regAmbCity('ambmain@test', 'AmbCity');       // السفير (غير موثّق بعد)
    const ambShop = await regAmbCity('ambshop@test', 'AmbCity');       // دافع داخل النطاق
    const ambTalent = await regAmbCity('ambtalent@test', 'AmbCity');   // مقدم داخل النطاق
    const gzShop = await regAmbCity('gzshop@test', 'Giza');            // دافع خارج أي نطاق
    const gzTalent = await regAmbCity('gztalent@test', 'Giza');        // مقدم خارج أي نطاق
    const founderMe = await api('GET', '/api/me', { token: founderTok });

    r = await api('POST', '/api/owner/ambassadors', { token: founderTok, body: { user_id: ambUser.user.id, city: 'AmbCity', country: 'EG', collection_phone: AMB_PHONE, compensation: '5%' } });
    check('تعيين سفير غير موثّق مرفوض خادمياً 400', r.status === 400, JSON.stringify(r.body));
    r = await api('POST', '/api/owner/ambassadors', { token: founderTok, body: { user_id: founderMe.body.user.id, city: 'AmbCity', country: 'EG', collection_phone: AMB_PHONE, compensation: '' } });
    check('المؤسس لا يُعيَّن سفيراً أبداً (400)', r.status === 400, JSON.stringify(r.body));
    r = await api('POST', '/api/owner/ambassadors', { token: tokA, body: { user_id: ambUser.user.id, city: 'AmbCity', country: 'EG', collection_phone: AMB_PHONE, compensation: '' } });
    check('التعيين من غير المالك مرفوض 403', r.status === 403, JSON.stringify(r.body));
    r = await api('POST', '/api/owner/ambassadors', { token: founderTok, body: { user_id: ambUser.user.id, city: 'AmbCity', country: 'EG', collection_phone: '123', compensation: '' } });
    check('رقم تحصيل غير صالح لدولة النطاق مرفوض 400 (قبل التوثيق حتى)', r.status === 400, JSON.stringify(r.body));

    r = await verifyAmbUser(ambUser.token, 'Amb main');
    check('توثيق السفير المستقبلي بالكود', r.status === 200 && r.body.ok !== false, JSON.stringify(r.body));
    r = await api('POST', '/api/owner/ambassadors', { token: founderTok, body: { user_id: ambUser.user.id, city: 'AmbCity', country: 'EG', collection_phone: AMB_PHONE, compensation: '5%' } });
    check('تعيين السفير الموثّق ينجح وفعّال برقم تحصيله ومقابله المعروض',
      r.status === 200 && !!r.body.appointment && r.body.appointment.active === true && r.body.appointment.collection_phone === AMB_PHONE && r.body.appointment.compensation === '5%',
      JSON.stringify(r.body));
    const ambApptId = r.body.appointment.id;

    r = await api('GET', `/api/talent/${ambUser.user.id}`, { token: ambShop.token });
    check('شارة السفير: ambassador_scope ظاهر على ملفه بنطاقه (مدينة/دولة فقط)',
      !!(r.body.user.ambassador_scope) && r.body.user.ambassador_scope.city === 'AmbCity' && r.body.user.ambassador_scope.country === 'EG',
      JSON.stringify(r.body.user.ambassador_scope));
    r = await api('GET', `/api/talent/${gzTalent.user.id}`, { token: ambShop.token });
    check('عضو خارج أي تعيين بلا ambassador_scope', r.body.user.ambassador_scope === null || r.body.user.ambassador_scope === undefined);

    /* حجز داخل النطاق: خطوة الدفع تعرض رقم السفير والإيصال إليه يؤكّد تلقائياً */
    r = await api('POST', '/api/bookings', { token: ambShop.token, body: { talent_id: ambTalent.user.id, price: 500 } });
    const ambB1 = r.body.booking.id;
    await api('POST', `/api/bookings/${ambB1}/agree`, { token: ambShop.token });
    await api('POST', `/api/bookings/${ambB1}/agree`, { token: ambTalent.token });
    r = await api('GET', `/api/bookings/${ambB1}/fee-info`, { token: ambShop.token });
    const ambOb1 = r.body.obligation || {};
    check('داخل النطاق: خطوة دفع العمولة تعرض رقم السفير (لا رقم المالك) والمرجع الموحد كما هو',
      r.status === 200 && r.body.phone === AMB_PHONE && r.body.collector_via === 'ambassador'
      && ambOb1.payee_phone === AMB_PHONE && ambOb1.collector === 'ambassador' && ambOb1.collector_city === 'AmbCity'
      && /^DL-[A-Z0-9]{6}$/.test(ambOb1.code || '') && ambOb1.base_amount === 50 && ambOb1.exact_amount > 50 && ambOb1.exact_amount < 51,
      JSON.stringify(r.body));
    const imgA1 = ambImg('amb-1');
    r = await api('POST', '/api/money/verify-receipt', { token: ambShop.token, body: { obligation_code: ambOb1.code, image: imgA1.dataUrl, image_hash: imgA1.hash, extracted: { amount: ambOb1.exact_amount, recipient_digits: AMB_PHONE, transfer_ref: 'AMB-AUTO-1', date: Date.now() } } });
    check('إيصال برقم السفير النشط لنطاق الالتزام → تأكيد تلقائي بنفس الصرامة', r.status === 200 && r.body.verdict === 'auto_confirmed', JSON.stringify(r.body));
    r = await api('GET', `/api/bookings/${ambB1}`, { token: ambShop.token });
    check('عمولة الحجز داخل النطاق تأكدت وتقدم الحجز', r.body.booking.fee_status === 'confirmed' && r.body.booking.status === 'awaiting_deposit', JSON.stringify(r.body.booking));

    /* طلب ضيف داخل النطاق: خطوة دفعه تعرض رقم السفير أيضاً (نطاق الضيف من طلبه) */
    r = await api('POST', '/api/guest-requests', { body: { business_name: 'محل السفير', phone: '01055512346', city: 'AmbCity', niche: 'Tech', budget: 600, details: 'فيديو داخل نطاق السفير' } });
    const ambGTok = r.body.token, ambGReq = r.body.id;
    await api('POST', `/api/guest-requests/${ambGReq}/book`, { token: ambTalent.token, body: {} });
    await api('POST', `/api/guest/${ambGTok}/agree`, { body: {} });
    let agd = await api('GET', `/api/guest/${ambGTok}`);
    if (agd.body.booking && agd.body.booking.status === 'pending_agreement') {
      await api('POST', `/api/bookings/${agd.body.booking.id}/agree`, { token: ambTalent.token });
    }
    r = await api('GET', `/api/guest/${ambGTok}/fee-info`);
    check('ضيف داخل النطاق: خطوة دفع عمولته تعرض رقم السفير',
      r.status === 200 && r.body.phone === AMB_PHONE && r.body.collector_via === 'ambassador' && (r.body.obligation || {}).payee_phone === AMB_PHONE,
      JSON.stringify(r.body));

    /* خارج النطاق: الرقم الافتراضي كما هو، وإيصال برقم السفير يُرفض للمستلم */
    r = await api('POST', '/api/bookings', { token: gzShop.token, body: { talent_id: gzTalent.user.id, price: 500 } });
    const gzB1 = r.body.booking.id;
    await api('POST', `/api/bookings/${gzB1}/agree`, { token: gzShop.token });
    await api('POST', `/api/bookings/${gzB1}/agree`, { token: gzTalent.token });
    r = await api('GET', `/api/bookings/${gzB1}/fee-info`, { token: gzShop.token });
    const gzOb = r.body.obligation || {};
    check('خارج أي نطاق سفير: خطوة الدفع تعرض رقم المالك الافتراضي كما هو تماماً',
      r.status === 200 && r.body.phone === TEST_PHONE && r.body.collector_via === 'owner' && gzOb.payee_phone === TEST_PHONE && gzOb.collector === 'owner',
      JSON.stringify(r.body));
    const imgG1 = ambImg('amb-out-1');
    r = await api('POST', '/api/money/verify-receipt', { token: gzShop.token, body: { obligation_code: gzOb.code, image: imgG1.dataUrl, image_hash: imgG1.hash, extracted: { amount: gzOb.exact_amount, recipient_digits: AMB_PHONE, transfer_ref: 'AMB-WRONG-1', date: Date.now() } } });
    check('إيصال برقم سفير مدينة أخرى لالتزام خارج نطاقه → مراجعة لا تأكيد (لا تساهل)',
      r.status === 200 && r.body.verdict === 'review', JSON.stringify(r.body));
    r = await api('GET', `/api/bookings/${gzB1}`, { token: gzShop.token });
    check('عمولة خارج النطاق لم تتأكد بالإيصال الخاطئ المستلم', r.body.booking.fee_status !== 'confirmed');

    /* اشتراك النجم داخل النطاق */
    const ambStar = await regAmbCity('ambstar@test', 'AmbCity');
    r = await api('GET', '/api/star/payment-info', { token: ambStar.token });
    check('اشتراك نجم داخل النطاق: خطوة دفعه تعرض رقم السفير',
      r.status === 200 && r.body.phone === AMB_PHONE && r.body.collector_via === 'ambassador' && (r.body.obligation || {}).payee_phone === AMB_PHONE,
      JSON.stringify(r.body));

    /* قسم السفير: نطاقه وحده، بلا هواتف أعضاء، ومحصّلاته من التأكيدات */
    r = await api('GET', '/api/ambassador/me', { token: ambUser.token });
    const myAppt = (r.body.appointments || [])[0] || {};
    const myMemberIds = (myAppt.members || []).map((m) => m.id);
    check('قسم السفير: تعيين واحد فعّال بنطاقه ورقم تحصيله ومقابله',
      r.status === 200 && (r.body.appointments || []).length === 1 && myAppt.city === 'AmbCity' && myAppt.collection_phone === AMB_PHONE && myAppt.compensation === '5%',
      JSON.stringify(r.body.appointments));
    check('قسم السفير: أعضاء مدينته/دولته فقط — لا بيانات مدينة أخرى إطلاقاً',
      myMemberIds.includes(ambShop.user.id) && myMemberIds.includes(ambTalent.user.id)
      && !myMemberIds.includes(gzShop.user.id) && !myMemberIds.includes(gzTalent.user.id)
      && (myAppt.obligations || []).every((o) => o.code !== gzOb.code),
      JSON.stringify(myMemberIds));
    check('قسم السفير: لا أرقام هواتف ولا وسائل تواصل للأعضاء في أي حقل',
      (myAppt.members || []).every((m) => !('contact' in m) && !('phone' in m) && !('collection_phone' in m)),
      JSON.stringify((myAppt.members || [])[0] || {}));
    check('قسم السفير: الالتزام المؤكد داخل نطاقه ظاهر ومحصّلته = مبلغه بالبصمة وحالة التسوية «قيد الانتظار»',
      (myAppt.obligations || []).some((o) => o.code === ambOb1.code && o.collected === true)
      && Math.round((myAppt.collected || {}).total * 100) === Math.round(ambOb1.exact_amount * 100)
      && myAppt.collected.status === 'pending' && Math.round(myAppt.collected.pending * 100) === Math.round(ambOb1.exact_amount * 100),
      JSON.stringify(myAppt.collected));
    r = await api('GET', '/api/ambassador/me', { token: tokA });
    check('عضو عادي بلا تعيين: لا قسم سفير (قائمة فارغة)', r.status === 200 && Array.isArray(r.body.appointments) && r.body.appointments.length === 0);

    /* التسوية بيد المالك ثم تحصيل جديد يعيدها «قيد الانتظار» بختم المُحصّل */
    r = await api('POST', `/api/owner/ambassadors/${ambApptId}/settle`, { token: founderTok, body: {} });
    check('تعليم المالك «تمت التسوية» ينجح', r.status === 200 && !!r.body.appointment && !!r.body.appointment.settled_at, JSON.stringify(r.body));
    r = await api('GET', '/api/ambassador/me', { token: ambUser.token });
    check('بعد التسوية: الحالة «تمت» ولا مبلغ بانتظارها',
      ((r.body.appointments || [])[0] || {}).collected.status === 'settled' && ((r.body.appointments || [])[0] || {}).collected.pending === 0,
      JSON.stringify((r.body.appointments || [])[0]));
    r = await api('POST', '/api/bookings', { token: ambShop.token, body: { talent_id: ambTalent.user.id, price: 500 } });
    const ambB2 = r.body.booking.id;
    await api('POST', `/api/bookings/${ambB2}/agree`, { token: ambShop.token });
    await api('POST', `/api/bookings/${ambB2}/agree`, { token: ambTalent.token });
    await api('POST', `/api/bookings/${ambB2}/pay`, { token: ambShop.token, body: { kind: 'fee', ref: 'AMB-FEE-2' } });
    let ownMoney = await api('GET', '/api/owner/money', { token: founderTok });
    let ob2 = (ownMoney.body.items || []).find((o) => o.kind === 'booking_commission' && o.booking_id === ambB2);
    if (ob2 && ob2.status === 'claimed') {
      await api('POST', `/api/owner/money/${ob2.id}/confirm`, { token: founderTok, body: {} });
      ownMoney = await api('GET', '/api/owner/money', { token: founderTok });
      ob2 = (ownMoney.body.items || []).find((o) => o.kind === 'booking_commission' && o.booking_id === ambB2);
    }
    check('تأكيد التزام داخل النطاق يختم مُحصّله: السفير ورقمه ونطاقه على سجل المالك',
      !!ob2 && ['confirmed', 'auto_confirmed'].includes(ob2.status) && ob2.collector_user_id === ambUser.user.id && ob2.collector_phone === AMB_PHONE && ob2.scope_city === 'AmbCity',
      JSON.stringify(ob2 || {}));
    r = await api('GET', '/api/ambassador/me', { token: ambUser.token });
    check('تحصيل جديد بعد التسوية يعيد الحالة «قيد الانتظار» بمبلغه',
      ((r.body.appointments || [])[0] || {}).collected.status === 'pending' && ((r.body.appointments || [])[0] || {}).collected.pending > 0,
      JSON.stringify(((r.body.appointments || [])[0] || {}).collected));

    /* سفير واحد للنطاق: تعيين بديل يُلغي السابق (سجله يبقى) وينقل الرقم والشارة */
    const amb3 = await regAmbCity('ambthree@test', 'AmbCity');
    await verifyAmbUser(amb3.token, 'Amb three');
    r = await api('POST', '/api/owner/ambassadors', { token: founderTok, body: { user_id: amb3.user.id, city: 'AmbCity', country: 'EG', collection_phone: AMB3_PHONE, compensation: '7%' } });
    const amb3ApptId = r.body.appointment && r.body.appointment.id;
    check('تعيين بديل لنفس (المدينة، الدولة) ينجح وفعّال', r.status === 200 && !!amb3ApptId && r.body.appointment.active === true, JSON.stringify(r.body));
    r = await api('GET', '/api/owner/ambassadors', { token: founderTok });
    const oldAppt = (r.body.items || []).find((a) => a.id === ambApptId);
    const newAppt = (r.body.items || []).find((a) => a.id === amb3ApptId);
    check('السفير السابق أُلغي وبقي سجله التاريخي، والجديد وحده الفعّال للنطاق',
      !!oldAppt && oldAppt.active === false && !!oldAppt.removed_at && !!newAppt && newAppt.active === true
      && (r.body.items || []).filter((a) => a.active && a.city === 'AmbCity' && a.country === 'EG').length === 1,
      JSON.stringify(r.body.items));
    r = await api('GET', '/api/ambassador/me', { token: ambUser.token });
    check('السفير السابق لم يعد يرى أي قسم سفير', r.status === 200 && (r.body.appointments || []).length === 0);
    r = await api('GET', `/api/talent/${ambUser.user.id}`, { token: ambShop.token });
    check('شارة السفير اختفت من ملف السابق فور الإلغاء', r.body.user.ambassador_scope === null || r.body.user.ambassador_scope === undefined);
    r = await api('POST', '/api/bookings', { token: ambShop.token, body: { talent_id: ambTalent.user.id, price: 500 } });
    const ambB3 = r.body.booking.id;
    await api('POST', `/api/bookings/${ambB3}/agree`, { token: ambShop.token });
    await api('POST', `/api/bookings/${ambB3}/agree`, { token: ambTalent.token });
    r = await api('GET', `/api/bookings/${ambB3}/fee-info`, { token: ambShop.token });
    check('بعد التبديل: خطوة الدفع تعرض رقم السفير الجديد لا السابق',
      r.status === 200 && r.body.phone === AMB3_PHONE && (r.body.obligation || {}).payee_phone === AMB3_PHONE, JSON.stringify(r.body));

    /* إلغاء التعيين: الرقم الافتراضي يعود والشارة تختفي */
    r = await api('POST', `/api/owner/ambassadors/${amb3ApptId}/remove`, { token: founderTok, body: {} });
    check('إلغاء تعيين السفير من لوحة المالك ينجح', r.status === 200 && r.body.appointment.active === false, JSON.stringify(r.body));
    r = await api('POST', '/api/bookings', { token: ambShop.token, body: { talent_id: ambTalent.user.id, price: 500 } });
    const ambB4 = r.body.booking.id;
    await api('POST', `/api/bookings/${ambB4}/agree`, { token: ambShop.token });
    await api('POST', `/api/bookings/${ambB4}/agree`, { token: ambTalent.token });
    r = await api('GET', `/api/bookings/${ambB4}/fee-info`, { token: ambShop.token });
    check('بعد إلغاء السفير الوحيد: خطوة الدفع عادت لرقم المالك الافتراضي',
      r.status === 200 && r.body.phone === TEST_PHONE && r.body.collector_via === 'owner', JSON.stringify(r.body));
    r = await api('GET', `/api/talent/${amb3.user.id}`, { token: ambShop.token });
    check('شارة السفير اختفت من ملف الملغى تعيينه', r.body.user.ambassador_scope === null || r.body.user.ambassador_scope === undefined);

    /* --- بنيوي: الواجهة والخادم يحملان الجولة وإصلاحَي الجولة السابقة --- */
    const srvAmb = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const dbAmb = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
    check('بنيوي: جدول ambassadors ونطاق الالتزام وبوابة إيصال السفير في الخادم',
      dbAmb.includes('ambassadors') && srvAmb.includes('recipientMatchesForObligation') && srvAmb.includes('collectorForObligation') && srvAmb.includes('/api/ambassador/me') && srvAmb.includes('/api/owner/ambassadors'));
    check('بنيوي: الواجهة تحمل قسمَي السفير والمالك وشارة السفير وتحديث بطاقة الصداقة الفوري',
      htmlSoc.includes('ambChip') && htmlSoc.includes('/api/owner/ambassadors') && htmlSoc.includes('/api/ambassador/me') && htmlSoc.includes('data-fzone') && htmlSoc.includes('ambAppoint'));
    const ambKeys = ['back_home', 'amb_chip', 'ts_amb_note', 'star_amb_note', 'ow_amb_t', 'ow_amb_appoint', 'amb_members', 'amb_obs', 'amb_settle_done'];
    check('قاموسا AR/EN: كل مفاتيح جولة السفير + إصلاح back_home في القاموسين معاً',
      ambKeys.every((k) => (htmlSoc.match(new RegExp(k + ':', 'g')) || []).length >= 2),
      ambKeys.filter((k) => (htmlSoc.match(new RegExp(k + ':', 'g')) || []).length < 2).join(','));

    /* ===== مدخل Vercel (api/index.js) يصدّر التطبيق ويعمل ===== */
    const vercelApp = require('../api/index');
    const srv = http.createServer(vercelApp);
    await new Promise((r2) => srv.listen(0, r2));
    const vport = srv.address().port;
    const vh = await fetch(`http://127.0.0.1:${vport}/api/health`);
    const vj = await vh.json();
    srv.close();
    check('مدخل Vercel serverless (api/index.js) يخدم /api/health', vh.status === 200 && vj.ok === true);
  } finally {
    app.kill('SIGTERM');
    aux.close();
    await pg.stop();
  }

  console.log(`\nالنتيجة: ${passed} ناجح / ${failed} فاشل (المجموع ${passed + failed})`);
  if (failures.length) console.log('الفاشلة:', failures.join(' | '));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(2); });
