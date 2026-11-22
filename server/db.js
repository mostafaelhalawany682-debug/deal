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
  avatar TEXT DEFAULT '',
  followers INTEGER DEFAULT 0,
  price DOUBLE PRECISION DEFAULT 0,
  bio TEXT DEFAULT '',
  links TEXT DEFAULT '',
  cover TEXT DEFAULT '',
  accent TEXT DEFAULT '',
  founder_seat INTEGER DEFAULT NULL,
  is_platform_founder INTEGER DEFAULT 0,
  is_founder_member INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  pioneer INTEGER DEFAULT 0,
  boost_until BIGINT DEFAULT 0,
  referred_by INTEGER DEFAULT NULL,
  featured_until BIGINT DEFAULT 0,
  penalty_level TEXT DEFAULT 'none',
  frozen INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  verify_code TEXT DEFAULT '',
  verify_status TEXT DEFAULT 'none',
  verify_reason TEXT DEFAULT '',
  verify_url TEXT DEFAULT '',
  min_price_pref DOUBLE PRECISION DEFAULT 0,
  notify_pref TEXT DEFAULT 'whatsapp',
  available_today INTEGER DEFAULT 0,
  daily_capacity INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_requests (
  id SERIAL PRIMARY KEY,
  shop_user_id INTEGER,
  title TEXT NOT NULL,
  niche TEXT DEFAULT '',
  city TEXT DEFAULT '',
  budget DOUBLE PRECISION DEFAULT 0,
  currency TEXT DEFAULT 'EGP',
  details TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  is_guest INTEGER DEFAULT 0,
  guest_name TEXT DEFAULT '',
  guest_phone TEXT DEFAULT '',
  guest_token TEXT DEFAULT '',
  urgent INTEGER DEFAULT 0,
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
  client_id INTEGER,
  talent_id INTEGER NOT NULL,
  guest_name TEXT DEFAULT '',
  guest_phone TEXT DEFAULT '',
  guest_token TEXT DEFAULT '',
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
  receipt_confirmed_at BIGINT DEFAULT 0,
  receipt_auto INTEGER DEFAULT 0,
  proof_warned INTEGER DEFAULT 0,
  escrow_status TEXT DEFAULT '',
  escrow_prev_status TEXT DEFAULT '',
  escrow_released_ref TEXT DEFAULT '',
  escrow_released_at BIGINT DEFAULT 0,
  escrow_release_seen TEXT DEFAULT '',
  urgent INTEGER DEFAULT 0,
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
  evidence TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  resolved_at BIGINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  reviewer_id INTEGER,
  reviewee_id INTEGER,
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

CREATE TABLE IF NOT EXISTS portfolio_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  video_id TEXT DEFAULT '',
  embed_url TEXT NOT NULL,
  source_url TEXT DEFAULT '',
  title TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER DEFAULT NULL,
  question TEXT NOT NULL,
  contact TEXT DEFAULT '',
  lang TEXT DEFAULT 'ar',
  is_read INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS star_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'EGP',
  ref TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  terms_version TEXT DEFAULT '',
  terms_accepted_at BIGINT DEFAULT 0,
  created_at BIGINT NOT NULL,
  decided_at BIGINT DEFAULT 0,
  decided_by INTEGER DEFAULT NULL,
  reject_reason TEXT DEFAULT '',
  activated_at BIGINT DEFAULT 0,
  expires_at BIGINT DEFAULT 0,
  reminded_expiring INTEGER DEFAULT 0,
  reminded_expired INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_star_subs_user ON star_subscriptions(user_id, status);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL,
  followee_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(recipient_id, sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(recipient_id, is_read);

CREATE TABLE IF NOT EXISTS friendships (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
  created_at BIGINT NOT NULL,
  decided_at BIGINT DEFAULT 0,
  UNIQUE(requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);

CREATE TABLE IF NOT EXISTS profile_posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  link TEXT DEFAULT '',
  pinned INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_profile_posts_user ON profile_posts(user_id, pinned, created_at);

CREATE TABLE IF NOT EXISTS post_reactions (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('love','clap')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY(post_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions(post_id);

CREATE TABLE IF NOT EXISTS guest_messages (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  sender TEXT NOT NULL CHECK(sender IN ('guest','talent')),
  body TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guest_messages_booking ON guest_messages(booking_id, created_at);

CREATE TABLE IF NOT EXISTS money_obligations (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('star_subscription','booking_commission','booking_deposit','booking_final')),
  booking_id INTEGER DEFAULT NULL,
  user_id INTEGER DEFAULT NULL,
  base_amount DOUBLE PRECISION NOT NULL,
  fingerprint_cents INTEGER NOT NULL,
  exact_amount DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'EGP',
  payer_user_id INTEGER DEFAULT NULL,
  guest_token TEXT DEFAULT '',
  payee TEXT NOT NULL DEFAULT 'owner',
  payee_user_id INTEGER DEFAULT NULL,
  status TEXT DEFAULT 'open',
  transfer_ref TEXT DEFAULT '',
  receipt_hash TEXT DEFAULT '',
  receipt_attempts INTEGER DEFAULT 0,
  receipt_locked INTEGER DEFAULT 0,
  fraud_flag INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL,
  expires_at BIGINT DEFAULT 0,
  decided_by INTEGER DEFAULT NULL,
  decided_at BIGINT DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_money_ob_open_exact ON money_obligations(payee, exact_amount) WHERE status IN ('open','claimed');
CREATE INDEX IF NOT EXISTS idx_money_ob_booking ON money_obligations(booking_id, kind);
CREATE INDEX IF NOT EXISTS idx_money_ob_user ON money_obligations(user_id, kind, status);

CREATE TABLE IF NOT EXISTS money_ledger (
  id SERIAL PRIMARY KEY,
  obligation_id INTEGER NOT NULL,
  from_status TEXT DEFAULT '',
  to_status TEXT NOT NULL,
  actor TEXT DEFAULT 'system',
  note TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_money_ledger_ob ON money_ledger(obligation_id, id);

CREATE TABLE IF NOT EXISTS money_receipts (
  id SERIAL PRIMARY KEY,
  obligation_id INTEGER NOT NULL,
  uploader_user_id INTEGER DEFAULT NULL,
  guest_token TEXT DEFAULT '',
  image TEXT NOT NULL,
  image_hash TEXT NOT NULL UNIQUE,
  extracted_amount DOUBLE PRECISION DEFAULT NULL,
  extracted_recipient TEXT DEFAULT '',
  extracted_ref TEXT DEFAULT '',
  extracted_date BIGINT DEFAULT 0,
  verdict TEXT DEFAULT 'review',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_money_receipts_ob ON money_receipts(obligation_id, id);
`;

/* ترحيلات «طلب العميل كضيف»: آمنة للتكرار على قواعد قائمة (إنتاج Supabase)
   وعلى قواعد جديدة على حد سواء — كل عبارة idempotent. */
const MIGRATIONS_SQL = `
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'EG';
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS is_guest INTEGER DEFAULT 0;
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS guest_name TEXT DEFAULT '';
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS guest_phone TEXT DEFAULT '';
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS guest_token TEXT DEFAULT '';
ALTER TABLE shop_requests ALTER COLUMN shop_user_id DROP NOT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_name TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_phone TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_token TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_confirmed_at BIGINT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_auto INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proof_warned INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS escrow_status TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS escrow_prev_status TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS escrow_released_ref TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS escrow_released_at BIGINT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS escrow_release_seen TEXT DEFAULT '';
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS evidence TEXT DEFAULT '';
ALTER TABLE bookings ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE reviews ALTER COLUMN reviewer_id DROP NOT NULL;
ALTER TABLE reviews ALTER COLUMN reviewee_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_requests_guest_token ON shop_requests(guest_token) WHERE guest_token<>'';
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_guest_token ON bookings(guest_token) WHERE guest_token<>'';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT '';
CREATE TABLE IF NOT EXISTS portfolio_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  video_id TEXT DEFAULT '',
  embed_url TEXT NOT NULL,
  source_url TEXT DEFAULT '',
  title TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER DEFAULT NULL,
  question TEXT NOT NULL,
  contact TEXT DEFAULT '',
  lang TEXT DEFAULT 'ar',
  is_read INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_contact_norm ON users(contact);
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL,
  followee_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(recipient_id, sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(recipient_id, is_read);
CREATE TABLE IF NOT EXISTS guest_messages (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  sender TEXT NOT NULL CHECK(sender IN ('guest','talent')),
  body TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guest_messages_booking ON guest_messages(booking_id, created_at);
ALTER TABLE users ADD COLUMN IF NOT EXISTS available_today INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_capacity INTEGER DEFAULT 0;
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS urgent INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS urgent INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS featured_until BIGINT DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS target_talent_id INTEGER DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_shop_requests_target ON shop_requests(target_talent_id) WHERE target_talent_id IS NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_custom TEXT DEFAULT '';
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;
CREATE TABLE IF NOT EXISTS star_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'EGP',
  ref TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  terms_version TEXT DEFAULT '',
  terms_accepted_at BIGINT DEFAULT 0,
  created_at BIGINT NOT NULL,
  decided_at BIGINT DEFAULT 0,
  decided_by INTEGER DEFAULT NULL,
  reject_reason TEXT DEFAULT '',
  activated_at BIGINT DEFAULT 0,
  expires_at BIGINT DEFAULT 0,
  reminded_expiring INTEGER DEFAULT 0,
  reminded_expired INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_star_subs_user ON star_subscriptions(user_id, status);
ALTER TABLE star_subscriptions ADD COLUMN IF NOT EXISTS obligation_id INTEGER DEFAULT NULL;
CREATE TABLE IF NOT EXISTS money_obligations (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('star_subscription','booking_commission','booking_deposit','booking_final')),
  booking_id INTEGER DEFAULT NULL,
  user_id INTEGER DEFAULT NULL,
  base_amount DOUBLE PRECISION NOT NULL,
  fingerprint_cents INTEGER NOT NULL,
  exact_amount DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'EGP',
  payer_user_id INTEGER DEFAULT NULL,
  guest_token TEXT DEFAULT '',
  payee TEXT NOT NULL DEFAULT 'owner',
  payee_user_id INTEGER DEFAULT NULL,
  status TEXT DEFAULT 'open',
  transfer_ref TEXT DEFAULT '',
  receipt_hash TEXT DEFAULT '',
  receipt_attempts INTEGER DEFAULT 0,
  receipt_locked INTEGER DEFAULT 0,
  fraud_flag INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL,
  expires_at BIGINT DEFAULT 0,
  decided_by INTEGER DEFAULT NULL,
  decided_at BIGINT DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_money_ob_open_exact ON money_obligations(payee, exact_amount) WHERE status IN ('open','claimed');
CREATE INDEX IF NOT EXISTS idx_money_ob_booking ON money_obligations(booking_id, kind);
CREATE INDEX IF NOT EXISTS idx_money_ob_user ON money_obligations(user_id, kind, status);
CREATE TABLE IF NOT EXISTS money_ledger (
  id SERIAL PRIMARY KEY,
  obligation_id INTEGER NOT NULL,
  from_status TEXT DEFAULT '',
  to_status TEXT NOT NULL,
  actor TEXT DEFAULT 'system',
  note TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_money_ledger_ob ON money_ledger(obligation_id, id);
CREATE TABLE IF NOT EXISTS money_receipts (
  id SERIAL PRIMARY KEY,
  obligation_id INTEGER NOT NULL,
  uploader_user_id INTEGER DEFAULT NULL,
  guest_token TEXT DEFAULT '',
  image TEXT NOT NULL,
  image_hash TEXT NOT NULL UNIQUE,
  extracted_amount DOUBLE PRECISION DEFAULT NULL,
  extracted_recipient TEXT DEFAULT '',
  extracted_ref TEXT DEFAULT '',
  extracted_date BIGINT DEFAULT 0,
  verdict TEXT DEFAULT 'review',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_money_receipts_ob ON money_receipts(obligation_id, id);
`;

/* ترحيلات جولة «الملف الاجتماعي»: غلاف/لون تمييز/مقعد مؤسس + جداول الصداقة
   ومنشورات البروفايل وتفاعلاتها. كل عبارة idempotent، وإسناد المقاعد بأثر
   رجعي حتمي: الرقم = ترتيب التسجيل (id) بين المؤهلين (صانع/مقدم، بلا المؤسس
   صاحب المنصة) — فلا يتغير رقم أي عضو أبداً مهما تكرر التشغيل، والفئة تُغلق
   عند ١٠٠ لأن من ترتيبه بعد المئة لا يأخذ رقماً إطلاقاً. */
const SOCIAL_MIGRATIONS_SQL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS accent TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS founder_seat INTEGER DEFAULT NULL;
CREATE TABLE IF NOT EXISTS friendships (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
  created_at BIGINT NOT NULL,
  decided_at BIGINT DEFAULT 0,
  UNIQUE(requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);
CREATE TABLE IF NOT EXISTS profile_posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  link TEXT DEFAULT '',
  pinned INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_profile_posts_user ON profile_posts(user_id, pinned, created_at);
CREATE TABLE IF NOT EXISTS post_reactions (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('love','clap')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY(post_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions(post_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_founder_seat ON users(founder_seat) WHERE founder_seat IS NOT NULL;
UPDATE users u SET founder_seat = sub.rn
FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id ASC) AS rn FROM users WHERE role IN ('creator','provider') AND is_platform_founder=0) sub
WHERE u.id = sub.id AND sub.rn <= 100 AND u.founder_seat IS NULL;
`;

/* تطبيع وسيلة التواصل (contact): إيميل بأحرف صغيرة، وهاتف مصري بصيغة محلية
   موحّدة (0xxxxxxxxxx) مهما كانت الصيغة المدخلة (+20 / 0020 / مسافات).
   يُستخدم في التسجيل والدخول معاً حتى لا يتكرر حساب لنفس الشخص أبداً. */
function normalizeContact(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  if (s.includes('@')) return s.toLowerCase().replace(/\s+/g, '');
  let d = s.replace(/[\s()-]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('0020')) d = '0' + d.slice(4);
  else if (d.startsWith('20') && d.length === 12) d = '0' + d.slice(2);
  return d;
}

/* إنشاء الجداول مرة واحدة عند أول تشغيل (آمن للتكرار: IF NOT EXISTS). */
let readyPromise = null;
function init() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await pool.query(SCHEMA_SQL);
      await pool.query(MIGRATIONS_SQL);
      await pool.query(SOCIAL_MIGRATIONS_SQL);
      // تطبيع contact للصفوف القائمة (idempotent): أي صف بصيغة غير مطبّعة يُحدَّث،
      // وعند أي تعارض تفرّد يُترك الصف كما هو دون تعطيل الإقلاع (إنتاج حالي: مستخدم واحد).
      try {
        const rows = (await pool.query('SELECT id, contact FROM users')).rows;
        for (const r of rows) {
          const n = normalizeContact(r.contact);
          if (n && n !== r.contact) {
            try { await pool.query('UPDATE users SET contact=$1 WHERE id=$2', [n, r.id]); }
            catch (e) { /* تعارض تفرّد — يُترك كما هو */ }
          }
        }
      } catch (e) { /* تطبيع الصفوف القائمة لا يعطّل الإقلاع أبداً */ }
    })();
  }
  return readyPromise;
}

/* ---------- prepare/get/all/run بأسلوب SQLite لكن async ---------- */
// جداول لها عمود id تسلسلي — تُستخدم لإرجاع lastInsertRowid من run() كما في SQLite.
const ID_TABLES = new Set([
  'users', 'shop_requests', 'campaigns', 'campaign_applications', 'bookings',
  'payments', 'disputes', 'reviews', 'notifications', 'profile_views',
  'portfolio_items', 'support_messages', 'messages', 'star_subscriptions',
  'friendships', 'profile_posts',
  'money_obligations', 'money_ledger', 'money_receipts',
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

module.exports = { db, pool, init, ready: init, normalizeContact };
