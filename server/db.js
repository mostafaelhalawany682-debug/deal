'use strict';
/**
 * Deal — طبقة قاعدة البيانات (PostgreSQL عبر pg).
 * الاتصال من متغير البيئة DATABASE_URL فقط (متوافق مع Supabase Postgres
 * وConnection Pooling — يُفضَّل رابط الـ Transaction Pooler على المنفذ 6543
 * عند النشر على Vercel لأن كل نسخة serverless تفتح تجميعة اتصالات خاصة بها).
 *
 * الواجهة تحاكي أسلوب node:sqlite القديم (prepare → get/all/run) لكنها async،
 * حتى يبقى منطق العمل في index.js كما هو دون تغيير.
 */
const { Pool, types } = require('pg');

// pg يعيد int8 و numeric كنصوص افتراضياً — نحوّلها لأرقام حتى تبقى
// الحسابات والمقارنات في منطق العمل مطابقة لسلوك SQLite (أرقام حقيقية).
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8 / COUNT / SUM
types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric / AVG

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — اضبط رابط اتصال Postgres (Supabase) في متغيرات البيئة');
}
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);

// رابط Supabase Pooler يحمل sslmode=require، وإصدارات pg الحديثة تفسّره كتحقق
// صارم (verify-full) فيفشل أمام سلسلة شهادات الـ Pooler رغم ضبط ssl أدناه —
// لأن باراميتر الرابط يتغلب على إعداد الكائن. الحل: حذف sslmode من الرابط
// والاعتماد على إعداد ssl الصريح في التجميعة.
let connStr = DATABASE_URL;
try {
  const u = new URL(DATABASE_URL);
  u.searchParams.delete('sslmode');
  connStr = u.toString();
} catch { /* إن فشل التحليل نستخدم الرابط كما هو */ }

const pool = new Pool({
  connectionString: connStr,
  // Supabase يتطلب SSL من خارج شبكته؛ الاتصال المحلي (اختبار) بلا SSL.
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // تجميعة صغيرة لكل نسخة serverless حتى لا نستنفد اتصالات الـ Pooler.
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (err) => console.error('pg pool error:', err.message));

/* ---------- schema (نفس جداول وأعمدة نسخة SQLite، بأنواع Postgres) ---------- */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('creator','provider','shop','brand')),
  niche TEXT DEFAULT '',
  provider_category TEXT DEFAULT NULL,
  city TEXT DEFAULT '',
  country TEXT DEFAULT 'EG',
  currency TEXT DEFAULT 'EGP',
  contact TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  followers INTEGER DEFAULT 0,
  price DOUBLE PRECISION DEFAULT 0,
  bio TEXT DEFAULT '',
  links TEXT DEFAULT '',
  is_platform_founder INTEGER DEFAULT 0,
  is_founder_member INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  pioneer INTEGER DEFAULT 0,
  boost_until BIGINT DEFAULT 0,
  penalty_level TEXT DEFAULT 'none',
  frozen INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  verify_code TEXT DEFAULT '',
  verify_status TEXT DEFAULT 'none',
  verify_reason TEXT DEFAULT '',
  verify_url TEXT DEFAULT '',
  min_price_pref DOUBLE PRECISION DEFAULT 0,
  notify_pref TEXT DEFAULT 'whatsapp',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_requests (
  id SERIAL PRIMARY KEY,
  shop_user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  niche TEXT DEFAULT '',
  city TEXT DEFAULT '',
  budget DOUBLE PRECISION DEFAULT 0,
  currency TEXT DEFAULT 'EGP',
  details TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  brand_user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  brief TEXT DEFAULT '',
  niche TEXT DEFAULT '',
  city TEXT DEFAULT '',
  budget DOUBLE PRECISION DEFAULT 0,
  currency TEXT DEFAULT 'EGP',
  status TEXT DEFAULT 'open',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_applications (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  pitch TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  booking_id INTEGER DEFAULT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(campaign_id, creator_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL,
  talent_id INTEGER NOT NULL,
  source TEXT DEFAULT 'direct',
  ref_id INTEGER DEFAULT NULL,
  title TEXT DEFAULT '',
  price DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'EGP',
  status TEXT DEFAULT 'pending_agreement',
  agreed_client INTEGER DEFAULT 0,
  agreed_talent INTEGER DEFAULT 0,
  fee_status TEXT DEFAULT 'none',
  fee_ref TEXT DEFAULT '',
  fee_confirmed_at BIGINT DEFAULT 0,
  prev_status TEXT DEFAULT '',
  deadline BIGINT DEFAULT 0,
  proof_url TEXT DEFAULT '',
  proof_at BIGINT DEFAULT 0,
  proof_check TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  completed_at BIGINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  ref TEXT DEFAULT '',
  status TEXT DEFAULT 'confirmed',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  opened_by INTEGER NOT NULL,
  reason TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  resolution TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  resolved_at BIGINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  reviewer_id INTEGER NOT NULL,
  reviewee_id INTEGER NOT NULL,
  sentiment TEXT NOT NULL CHECK(sentiment IN ('positive','negative')),
  stars INTEGER DEFAULT 5,
  comment TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  UNIQUE(booking_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type TEXT DEFAULT '',
  text TEXT NOT NULL,
  ref TEXT DEFAULT '',
  is_read INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_views (
  id SERIAL PRIMARY KEY,
  talent_id INTEGER NOT NULL,
  viewer_id INTEGER DEFAULT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS badge_state (
  user_id INTEGER NOT NULL,
  badge_key TEXT NOT NULL,
  earned INTEGER DEFAULT 0,
  PRIMARY KEY(user_id, badge_key)
);
`;

/* إنشاء الجداول مرة واحدة عند أول تشغيل (آمن للتكرار: IF NOT EXISTS). */
let readyPromise = null;
function init() {
  if (!readyPromise) {
    readyPromise = pool.query(SCHEMA_SQL).then(() => undefined);
  }
  return readyPromise;
}

/* ---------- prepare/get/all/run بأسلوب SQLite لكن async ---------- */
// جداول لها عمود id تسلسلي — تُستخدم لإرجاع lastInsertRowid من run() كما في SQLite.
const ID_TABLES = new Set([
  'users', 'shop_requests', 'campaigns', 'campaign_applications', 'bookings',
  'payments', 'disputes', 'reviews', 'notifications', 'profile_views',
]);

function toPgSql(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function prepare(sql) {
  const pgSql = toPgSql(sql);
  const insertMatch = /^\s*INSERT\s+INTO\s+([a-z_]+)/i.exec(pgSql);
  const wantsReturning =
    insertMatch && ID_TABLES.has(insertMatch[1].toLowerCase()) && !/RETURNING/i.test(pgSql);
  const finalSql = wantsReturning ? `${pgSql} RETURNING id` : pgSql;
  return {
    async get(...args) {
      const r = await pool.query(finalSql, args);
      return r.rows[0];
    },
    async all(...args) {
      const r = await pool.query(finalSql, args);
      return r.rows;
    },
    async run(...args) {
      const r = await pool.query(finalSql, args);
      return {
        lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : undefined,
        changes: r.rowCount,
      };
    },
  };
}

const db = { prepare };

module.exports = { db, pool, init, ready: init };
