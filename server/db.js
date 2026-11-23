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
  guest_fp TEXT DEFAULT '',
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
  ai_answer TEXT DEFAULT '',
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
  kind TEXT NOT NULL CHECK(kind IN ('star_subscription','booking_commission','booking_deposit','booking_final','breach_penalty')),
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
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS guest_fp TEXT DEFAULT '';
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
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS ai_answer TEXT DEFAULT '';
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
  kind TEXT NOT NULL CHECK(kind IN ('star_subscription','booking_commission','booking_deposit','booking_final','breach_penalty')),
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
   عند ٥٠ لأن من ترتيبه بعد الخمسين لا يأخذ رقماً إطلاقاً. */
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
WHERE u.id = sub.id AND sub.rn <= 50 AND u.founder_seat IS NULL;
`;

/* ترحيلات جولة «سفير المدينة = نقطة التحصيل» (اقتراح ٤): جدول تعيينات
   السفراء (سفير فعّال واحد لكل (دولة، مدينة) — الفهرس الفريد الجزئي ظهر أخير،
   والتعيين البديل يُلغي السابق مع بقاء سجله التاريخي)، وأعمدة نطاق/مُحصّل على
   الالتزامات المالية: النطاق (مدينة/دولة الدافع) يُختم عند الإنشاء، والمُحصّل
   (السفير النشط وقت التأكيد + رقمه + وقته) يُختم عند انتقال الالتزام إلى
   confirmed/auto_confirmed فقط — فتبقى نسب التحصيل والتسويات ثابتة تاريخياً
   مهما تبدّل السفراء بعدها. كل عبارة idempotent. */
const AMBASSADOR_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS ambassadors (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'EG',
  collection_phone TEXT NOT NULL DEFAULT '',
  compensation TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  settled_at BIGINT DEFAULT 0,
  created_at BIGINT NOT NULL,
  removed_at BIGINT DEFAULT 0,
  removed_by INTEGER DEFAULT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ambassadors_scope_active ON ambassadors(country, city) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_ambassadors_user ON ambassadors(user_id, active);
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS scope_city TEXT DEFAULT '';
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS scope_country TEXT DEFAULT '';
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS collector_user_id INTEGER DEFAULT NULL;
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS collector_phone TEXT DEFAULT '';
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS collector_at BIGINT DEFAULT 0;
`;

/* ترحيلات جولة «إفراج Deal»: جدول طلبات مراجعة الإفراج (Appeals) — طلب
   واحد مفتوح لكل حجز كحد أقصى (فهرس فريد جزئي على الحالة open)، وسجل الطلب
   لا يُحذف أبداً: إغلاقه/قراره يُختم بحالته ووقته ومن قرّر، فيبقى القرار
   موثّقاً أمام الطرفين. حالاته: open | closed_confirmed (أكد العميل فأُغلق
   تلقائياً) | closed_dispute (فُتح نزاع فانتقل المسار للنزاع) |
   decided_release (قرار مالك: تأكيد استلام موثّق وإفراج) | decided_refund
   (قرار مالك: رد المحتجَز للعميل). */
const P2P_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS release_appeals (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  talent_id INTEGER NOT NULL,
  status TEXT DEFAULT 'open',
  client_note TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  decided_at BIGINT DEFAULT 0,
  decided_by INTEGER DEFAULT NULL,
  decision TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_one_open ON release_appeals(booking_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS idx_appeals_booking ON release_appeals(booking_id, id);
`;

/* ترحيلات جولة «المحاذاة الحرفية مع Deal P2P» (TESTING-P2P-ALIGN.md):
   طور تفاوض موقوت للتحكيم + إعادة تحكيم بمهلة، خطأ الإلغاء لصالح/ضد طرف،
   تنبيه إفراج، التزامات فرق ورفض طرف ثالث، أحداث نظام لمحادثة الطلب،
   بلاغات دفع متأخر، أعلام سلوك، وبوابة قبول «شروط المعاملات». كلها idempotent. */
const ALIGN_MIGRATIONS_SQL = `
ALTER TABLE release_appeals ADD COLUMN IF NOT EXISTS phase TEXT DEFAULT 'owner_review';
ALTER TABLE release_appeals ADD COLUMN IF NOT EXISTS phase_deadline BIGINT DEFAULT 0;
ALTER TABLE release_appeals ADD COLUMN IF NOT EXISTS escalated_at BIGINT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_fault TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS escrow_alert_sent INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deemed_at BIGINT DEFAULT 0;
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS reject_kind TEXT DEFAULT '';
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS is_difference INTEGER DEFAULT 0;
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS parent_obligation_id INTEGER DEFAULT NULL;
CREATE TABLE IF NOT EXISTS booking_events (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_booking_events_booking ON booking_events(booking_id, created_at);
CREATE TABLE IF NOT EXISTS late_payment_reports (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  reporter TEXT DEFAULT 'member',
  user_id INTEGER DEFAULT NULL,
  ref TEXT DEFAULT '',
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  created_at BIGINT NOT NULL,
  decided_at BIGINT DEFAULT 0,
  decided_by INTEGER DEFAULT NULL,
  decision_note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_late_reports_booking ON late_payment_reports(booking_id, status);
CREATE TABLE IF NOT EXISTS behavior_flags (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_by INTEGER DEFAULT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_behavior_flags_user ON behavior_flags(user_id);
CREATE TABLE IF NOT EXISTS booking_terms_acceptances (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  side TEXT NOT NULL,
  user_id INTEGER DEFAULT NULL,
  guest_token TEXT DEFAULT '',
  version TEXT NOT NULL,
  accepted_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_terms_acc_unique ON booking_terms_acceptances(booking_id, side, version);
CREATE INDEX IF NOT EXISTS idx_terms_acc_booking ON booking_terms_acceptances(booking_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_version TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at BIGINT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at BIGINT DEFAULT 0;
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS warn_sent INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deemed_warn_sent INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deemed_mid_warn_sent INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agreed_revisions INTEGER DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agreed_delivery_at BIGINT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS initial_proof_url TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS initial_proof_at BIGINT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS initial_proof_check TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS initial_confirmed_at BIGINT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS fin_wallet_number TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS fin_declared_at BIGINT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS fin_declared_version TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_delivered_at BIGINT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_confirmed_at BIGINT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_auto INTEGER DEFAULT 0;
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
ALTER TABLE ambassadors ADD COLUMN IF NOT EXISTS settlement_method TEXT DEFAULT '';
CREATE TABLE IF NOT EXISTS obligation_settlements (
  id SERIAL PRIMARY KEY,
  obligation_id INTEGER NOT NULL,
  ambassador_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  method TEXT DEFAULT '',
  transfer_ref TEXT DEFAULT '',
  status TEXT DEFAULT 'declared',
  declared_at BIGINT NOT NULL,
  confirmed_at BIGINT DEFAULT 0,
  confirmed_by INTEGER DEFAULT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_obsettle_ob_live ON obligation_settlements(obligation_id) WHERE status IN ('declared','confirmed');
CREATE INDEX IF NOT EXISTS idx_obsettle_amb ON obligation_settlements(ambassador_id, status);
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT '',
  updated_at BIGINT DEFAULT 0
);
`;

/* ترحيلات جولة «الدخول والاسترجاع زي التطبيقات الكبرى» (قرار المستخدم
   2026-11-23): كلمات سر حقيقية (تجزئة scrypt في password_hash — NULL يعني
   حساباً قديماً بلا كلمة سر يخضع لمسار الترحيل)، إيميل استرجاع اختياري
   لحسابات الموبايل، جلسات غنية (وكيل المستخدم + آخر نشاط) لقسم «أجهزتي»،
   أكواد إعادة تعيين قصيرة العمر مُجزّأة، أكواد احتياطية مُجزّأة أحادية
   الاستخدام، خانق محاولات دخول/استرجاع، وجدول بلاغات المحتوى/الملفات
   (بلاغ مفتوح واحد لكل مُبلِّغ وهدف — الفهرس الفريد الجزئي). كل عبارة
   idempotent كسائر ترحيلات هذا الملف. */
const RECOVERY_MIGRATIONS_SQL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at BIGINT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email TEXT DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at BIGINT DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'full';
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER DEFAULT 0,
  used_at BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pwresets_user ON password_resets(user_id, id);
CREATE TABLE IF NOT EXISTS backup_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  used_at BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_backup_codes_user ON backup_codes(user_id, used_at);
CREATE TABLE IF NOT EXISTS auth_throttle (
  key TEXT PRIMARY KEY,
  fails INTEGER DEFAULT 0,
  window_start BIGINT DEFAULT 0,
  locked_until BIGINT DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  target_user_id INTEGER NOT NULL,
  reason TEXT DEFAULT '',
  details TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  action TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  resolved_at BIGINT DEFAULT 0,
  resolved_by INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open ON reports(reporter_id, target_type, target_id) WHERE status='open';
`;

/* ترحيلات جولة «ضمان الاستبدال الصارم + الردع بحكم القانون» (قرار المستخدم
   المعتمَد 2026-11-23 — TESTING-DETERRENCE-APPLY.md):
   - نوع التزام جديد breach_penalty (غرامة إخلال لصالح Deal): توسيع قيد CHECK
     على kind في القواعد القائمة (الجدول الجديد يُنشأ بالقيد الموسّع أصلاً).
   - قائمة حظر على مستوى الشخص (person_blocklist): هاتف/إيميل/بصمة جهاز —
     الحظر النهائي للشخص لا للحساب، فلا حساب جديد بنفس أيٍّ منها.
   - بصمات أجهزة الأعضاء المعروفة (user_fingerprints): تُسجَّل عند التسجيل
     والدخول (حين يرسل العميل معرّف جهاز) لتُنسخ إلى قائمة الحظر عند الحظر.
   - users.dues_frozen: علامة أن التجميد الحالي سببه مستحقات متجاوزة (تجميد
     آلي) — فكه آلي عند سداد كل المستحقات، ولا يمسّ تجميد العقوبات اليدوي. */
const DETERRENCE_MIGRATIONS_SQL = `
DO $deal_kind$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'money_obligations'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%star_subscription%'
     AND pg_get_constraintdef(oid) NOT LIKE '%breach_penalty%'
   LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE 'ALTER TABLE money_obligations DROP CONSTRAINT ' || quote_ident(c);
    ALTER TABLE money_obligations ADD CONSTRAINT money_obligations_kind_check
      CHECK (kind IN ('star_subscription','booking_commission','booking_deposit','booking_final','breach_penalty'));
  END IF;
END
$deal_kind$;
CREATE TABLE IF NOT EXISTS person_blocklist (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('phone','email','device')),
  value TEXT NOT NULL,
  user_id INTEGER DEFAULT NULL,
  reason TEXT DEFAULT '',
  created_by INTEGER DEFAULT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocklist_kind_value ON person_blocklist(kind, value);
CREATE INDEX IF NOT EXISTS idx_blocklist_user ON person_blocklist(user_id);
CREATE TABLE IF NOT EXISTS user_fingerprints (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  fp TEXT NOT NULL,
  last_seen BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_fp_unique ON user_fingerprints(user_id, fp);
CREATE INDEX IF NOT EXISTS idx_user_fp_fp ON user_fingerprints(fp);
ALTER TABLE users ADD COLUMN IF NOT EXISTS dues_frozen INTEGER DEFAULT 0;
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS is_refund INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS protection_voided INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS protection_voided_at BIGINT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS protection_voided_by INTEGER DEFAULT NULL;
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

/* هجرات «باقة المزايا + محرك الترتيب والمطابقة» (2026-11-23): أعمدة وجداول
   المزايا العشر ومحرك النمو الصامت — كلها إضافية ومتوافقة رجعياً. */
const FEATURES_MIGRATIONS_SQL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at BIGINT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_summary_at BIGINT DEFAULT 0;
ALTER TABLE guest_messages ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'text';
ALTER TABLE guest_messages ADD COLUMN IF NOT EXISTS media_url TEXT DEFAULT '';
ALTER TABLE guest_messages ADD COLUMN IF NOT EXISTS duration_sec INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delivery_due_at BIGINT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delivery_accepted INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS replacement_available INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS replacement_activated INTEGER DEFAULT 0;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS deliver_after BIGINT DEFAULT 0;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed INTEGER DEFAULT 0;
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS rescued_at BIGINT DEFAULT 0;
CREATE TABLE IF NOT EXISTS user_templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_user ON user_templates(user_id, sort, id);
CREATE TABLE IF NOT EXISTS directory_impressions (
  id SERIAL PRIMARY KEY,
  talent_id INTEGER NOT NULL,
  viewer_key TEXT NOT NULL,
  city TEXT DEFAULT '',
  niche TEXT DEFAULT '',
  day TEXT NOT NULL,
  hits INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_impr_unique ON directory_impressions(talent_id, viewer_key, city, niche, day);
CREATE TABLE IF NOT EXISTS request_matches (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  score DOUBLE PRECISION DEFAULT 0,
  notified INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_unique ON request_matches(request_id, user_id);
CREATE INDEX IF NOT EXISTS idx_match_user ON request_matches(user_id, score);
CREATE TABLE IF NOT EXISTS user_activity_hours (
  user_id INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  hits INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);
`;

/* ترحيلات جولة «التوسعة» (قرارات المستخدم 2026-11-23 — TESTING-EXPANSION.md):
   عروض أسعار منظمة، باقات أسعار، عروض سريعة، قوائم انتظار، فيديوهات شغل
   يومية، تعاقدات شهرية متكررة، تحدي أسبوع، إكراميات (نوع التزام tip —
   توسيع قيد CHECK بنفس آلية جولة الردع)، وضع إجازة، أسئلة عامة على الملف،
   أقسام موسمية مخصّصة/معدّلة من المالك، وأكاديمية Deal (تقدم + شارات).
   كل عبارة idempotent كسائر ترحيلات هذا الملف. */
const EXPANSION_MIGRATIONS_SQL = `
DO $deal_kind_tip$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'money_obligations'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%booking_commission%'
     AND pg_get_constraintdef(oid) NOT LIKE '%tip%'
   LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE 'ALTER TABLE money_obligations DROP CONSTRAINT ' || quote_ident(c);
    ALTER TABLE money_obligations ADD CONSTRAINT money_obligations_kind_check
      CHECK (kind IN ('star_subscription','booking_commission','booking_deposit','booking_final','breach_penalty','tip'));
  END IF;
END
$deal_kind_tip$;
CREATE TABLE IF NOT EXISTS request_quotes (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL,
  talent_id INTEGER NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  delivery_days INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  decided_at BIGINT DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_one_pending ON request_quotes(request_id, talent_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_quotes_request ON request_quotes(request_id, status);
CREATE TABLE IF NOT EXISTS creator_packages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tier INTEGER NOT NULL,
  name TEXT DEFAULT '',
  price DOUBLE PRECISION DEFAULT 0,
  description TEXT DEFAULT '',
  features TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_packages_user_tier ON creator_packages(user_id, tier);
ALTER TABLE users ADD COLUMN IF NOT EXISTS flash_pct DOUBLE PRECISION DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS flash_price DOUBLE PRECISION DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS flash_until BIGINT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vacation_until BIGINT DEFAULT 0;
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id SERIAL PRIMARY KEY,
  talent_id INTEGER NOT NULL,
  request_id INTEGER DEFAULT NULL,
  client_id INTEGER DEFAULT NULL,
  guest_token TEXT DEFAULT '',
  guest_name TEXT DEFAULT '',
  status TEXT DEFAULT 'waiting',
  offered_at BIGINT DEFAULT 0,
  expires_at BIGINT DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waitlist_talent ON waitlist_entries(talent_id, status, created_at);
CREATE TABLE IF NOT EXISTS daily_videos (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  video_id TEXT DEFAULT '',
  embed_url TEXT NOT NULL,
  source_url TEXT DEFAULT '',
  title TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_videos_user ON daily_videos(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_daily_videos_feed ON daily_videos(created_at);
CREATE TABLE IF NOT EXISTS contracts (
  id SERIAL PRIMARY KEY,
  client_id INTEGER DEFAULT NULL,
  guest_token TEXT DEFAULT '',
  guest_name TEXT DEFAULT '',
  talent_id INTEGER NOT NULL,
  title TEXT DEFAULT '',
  service TEXT DEFAULT '',
  times_per_month INTEGER DEFAULT 1,
  cycle_price DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'EGP',
  status TEXT DEFAULT 'pending',
  client_accepted INTEGER DEFAULT 0,
  talent_accepted INTEGER DEFAULT 0,
  terms_version TEXT DEFAULT '',
  cycles_done INTEGER DEFAULT 0,
  next_cycle_at BIGINT DEFAULT 0,
  stop_requested_by TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_talent ON contracts(talent_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_client ON contracts(client_id, status);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS contract_id INTEGER DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS package_tier INTEGER DEFAULT NULL;
CREATE TABLE IF NOT EXISTS challenge_weeks (
  week_key TEXT PRIMARY KEY,
  winner_id INTEGER NOT NULL,
  completed_count INTEGER DEFAULT 0,
  videos_count INTEGER DEFAULT 0,
  score INTEGER DEFAULT 0,
  crowned_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_questions (
  id SERIAL PRIMARY KEY,
  talent_id INTEGER NOT NULL,
  asker_id INTEGER DEFAULT NULL,
  asker_name TEXT DEFAULT '',
  question TEXT NOT NULL,
  answer TEXT DEFAULT '',
  answered_at BIGINT DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_talent ON profile_questions(talent_id, created_at);
CREATE TABLE IF NOT EXISTS seasons_custom (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name_ar TEXT DEFAULT '',
  name_en TEXT DEFAULT '',
  start_md TEXT NOT NULL,
  end_md TEXT NOT NULL,
  niches TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS academy_progress (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  track_key TEXT NOT NULL,
  lesson_key TEXT NOT NULL,
  done_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_academy_progress_unique ON academy_progress(user_id, track_key, lesson_key);
CREATE TABLE IF NOT EXISTS academy_badges (
  user_id INTEGER NOT NULL,
  track_key TEXT NOT NULL,
  earned_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, track_key)
);
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS managed INTEGER DEFAULT 0;
ALTER TABLE shop_requests ADD COLUMN IF NOT EXISTS template_key TEXT DEFAULT '';
`;

/* ترحيلات جولة «المراجعة الشاملة» (قرارات المستخدم 2026-11-23 —
   TESTING-AUDIT.md):
   • عمود country_name للمستخدم: اسم الدولة النصي لحسابات المسار الدولي
     العام (country='OTHER') — فارغ لكل حسابات الدول الـ١٩.
   • ترحيل دمج المهارات المعتمد: مقدمو «المونتاج» (editing) ينتقلون إلى
     «إنتاج ومونتاج الفيديو» (videoproduction)، ومقدمو «إدارة حسابات
     سوشيال» (accounts) إلى «تسويق وإدارة حسابات» (marketing) — في
     تصنيف المستخدم وتقدّم/شارات الأكاديمية معاً، بلا فقد أي تقدّم
     (عند التعارض يبقى الصف المدمج الأقدم ويُحذف المكرر).
   كل عبارة idempotent كسائر ترحيلات هذا الملف. */
const AUDIT_MIGRATIONS_SQL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS country_name TEXT DEFAULT '';
UPDATE users SET provider_category='videoproduction' WHERE provider_category='editing';
UPDATE users SET provider_category='marketing' WHERE provider_category='accounts';
INSERT INTO academy_progress (user_id,track_key,lesson_key,done_at)
  SELECT user_id,'svc_videoproduction',lesson_key,done_at FROM academy_progress WHERE track_key='svc_editing'
  ON CONFLICT (user_id,track_key,lesson_key) DO NOTHING;
DELETE FROM academy_progress WHERE track_key='svc_editing';
INSERT INTO academy_progress (user_id,track_key,lesson_key,done_at)
  SELECT user_id,'svc_marketing',lesson_key,done_at FROM academy_progress WHERE track_key='svc_accounts'
  ON CONFLICT (user_id,track_key,lesson_key) DO NOTHING;
DELETE FROM academy_progress WHERE track_key='svc_accounts';
INSERT INTO academy_badges (user_id,track_key,earned_at)
  SELECT user_id,'svc_videoproduction',earned_at FROM academy_badges WHERE track_key='svc_editing'
  ON CONFLICT (user_id,track_key) DO NOTHING;
DELETE FROM academy_badges WHERE track_key='svc_editing';
INSERT INTO academy_badges (user_id,track_key,earned_at)
  SELECT user_id,'svc_marketing',earned_at FROM academy_badges WHERE track_key='svc_accounts'
  ON CONFLICT (user_id,track_key) DO NOTHING;
DELETE FROM academy_badges WHERE track_key='svc_accounts';
`;

/* ترحيلات بناء «تصحيحات المراجعة الخارجية» (الأقسام ١–٨): حقول الاتفاق
   المهيكل والمعاينة الأولية والهوية المالية موجودة في ALIGN أعلاه؛ هنا:
   تحقق الإيميل الإلزامي (حالة + جدول أكواد مُجزّأة قصيرة العمر)، الاسم
   القانوني واسم صاحب المحفظة، وهوية الدافع على الالتزامات والسجل المالي،
   وأعمدة هوية الدافع على المدفوعات. ترحيل الحسابات القائمة: أول تشغيل
   يختم «email_verify_cutoff_ms» بوقته ويعلّم كل حساب أُنشئ حتى تلك اللحظة
   موثّقاً (المؤسس وكل القائمين) — والحسابات اللاحقة تبدأ غير موثّقة. */
const REVIEW_MIGRATIONS_SQL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS legal_name TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS fin_wallet_owner TEXT DEFAULT '';
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  email TEXT DEFAULT '',
  code_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER DEFAULT 0,
  used_at BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_email_verify_user ON email_verification_codes(user_id, id);
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS payer_name TEXT DEFAULT '';
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS payer_wallet TEXT DEFAULT '';
ALTER TABLE money_obligations ADD COLUMN IF NOT EXISTS payer_device_fp TEXT DEFAULT '';
ALTER TABLE money_ledger ADD COLUMN IF NOT EXISTS payer_name TEXT DEFAULT '';
ALTER TABLE money_ledger ADD COLUMN IF NOT EXISTS payer_wallet TEXT DEFAULT '';
ALTER TABLE money_ledger ADD COLUMN IF NOT EXISTS device_fp TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_name TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_wallet TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_device_fp TEXT DEFAULT '';
INSERT INTO platform_settings (key,value,updated_at)
  SELECT 'email_verify_cutoff_ms', CAST(EXTRACT(EPOCH FROM NOW())*1000 AS BIGINT)::text, CAST(EXTRACT(EPOCH FROM NOW())*1000 AS BIGINT)
  WHERE NOT EXISTS (SELECT 1 FROM platform_settings WHERE key='email_verify_cutoff_ms');
UPDATE users SET email_verified=1 WHERE email_verified=0 AND created_at <= (SELECT NULLIF(value,'')::bigint FROM platform_settings WHERE key='email_verify_cutoff_ms');
`;

/* ترحيلات جولة «التلميع والنمو» (TESTING-POLISH.md): جدول طلبات السفير
   (طلب مفتوح واحد لكل عضو — فهرس فريد جزئي على الحالة open)، وعمود ختم
   رسالة ترحيب المؤسس على المستخدم (يُختم ذرّياً مرة واحدة عند أول تحقق
   إيميل فلا تتكرر الرسالة أبداً). كل عبارة idempotent. */
const POLISH_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS ambassador_applications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'EG',
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  created_at BIGINT NOT NULL,
  decided_at BIGINT DEFAULT 0,
  decided_by INTEGER DEFAULT NULL,
  ambassador_id INTEGER DEFAULT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_amb_app_one_open ON ambassador_applications(user_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS idx_amb_app_status ON ambassador_applications(status, id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS founder_welcomed_at BIGINT DEFAULT 0;
`;

let readyPromise = null;
function init() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await pool.query(SCHEMA_SQL);
      await pool.query(MIGRATIONS_SQL);
      await pool.query(SOCIAL_MIGRATIONS_SQL);
      await pool.query(AMBASSADOR_MIGRATIONS_SQL);
      await pool.query(P2P_MIGRATIONS_SQL);
      await pool.query(ALIGN_MIGRATIONS_SQL);
      await pool.query(RECOVERY_MIGRATIONS_SQL);
      await pool.query(DETERRENCE_MIGRATIONS_SQL);
      await pool.query(FEATURES_MIGRATIONS_SQL);
      await pool.query(EXPANSION_MIGRATIONS_SQL);
      await pool.query(AUDIT_MIGRATIONS_SQL);
      await pool.query(REVIEW_MIGRATIONS_SQL);
      await pool.query(POLISH_MIGRATIONS_SQL);
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
  'money_obligations', 'money_ledger', 'money_receipts', 'ambassadors',
  'release_appeals', 'booking_events', 'late_payment_reports', 'behavior_flags',
  'booking_terms_acceptances', 'push_subscriptions', 'obligation_settlements',
  'password_resets', 'backup_codes', 'reports', 'email_verification_codes',
  'person_blocklist', 'user_fingerprints',
  'user_templates', 'directory_impressions', 'request_matches',
  'request_quotes', 'creator_packages', 'waitlist_entries', 'daily_videos',
  'contracts', 'profile_questions', 'seasons_custom', 'academy_progress',
  'ambassador_applications',
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
