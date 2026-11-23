'use strict';
/**
 * طبقة «الرد الذكي» لدعم Deal (جولة رد الدعم الذكي — قرار المستخدم المعتمد:
 * الرد الذكي في الدعم فقط، وممنوع منعاً باتاً داخل محادثات الحجوزات لأنها
 * أدلة تحكيم).
 *
 * المزوّد يُختار بمتغير البيئة AI_PROVIDER: gemini | test
 * والمفاتيح من متغيرات البيئة فقط (لا قيمة افتراضية لأي سر في الكود):
 *   GEMINI_API_KEY   مفتاح Google AI Studio (خطة مجانية بلا بطاقة)
 *   GEMINI_MODEL     اسم النموذج (اختياري) — الافتراضي نموذج Flash Lite
 *                    صاحب حصة الخطة المجانية الأعلى (500 طلب/يوم في مشروع
 *                    المالك مقابل 20 فقط لـ Gemini 2.5 Flash). تجاوز البيئة
 *                    هو العقد: لو أتاح AI Studio نموذج Lite أحدث (مثل
 *                    «Gemini 3.1 Flash Lite») يُضبط اسمه هنا دون لمس الكود.
 *   AI_TIMEOUT_MS    مهلة استدعاء المزوّد (افتراضي 10000ms)
 * بلا مزوّد مُعدّ: configured()‎ = false وaiSupportReply يرد
 * { ok:false, reason:'not_configured' } — فيسقط مسار الدعم لاحتياط اليوم
 * (طابور المالك) تماماً كما لو لم توجد الميزة (نفس سلوك EMAIL_NOT_CONFIGURED
 * في mailer.js).
 *
 * التأريض: الرد لا يخرج إلا من كتلة معرفة منسّقة من نصوص التطبيق نفسه
 * (قاعدة الأسئلة الشائعة، مركز الثقة، شروط المعاملات) — لا قواعد مخترعة.
 * أي سؤال عن حجز بعينه أو نزاع أو مبلغ مستحق لشخص أو إجراء حساب أو ما لا
 * تغطيه الكتلة → النموذج يرد بالرمز ESCALATE وحده، فيتحول السؤال لطابور
 * المالك كما هو اليوم. حصة المزوّد (HTTP 429) فشل صامت بنفس الطريقة —
 * لا خطأ يصل للمستخدم أبداً.
 *
 * المزوّد test لا يعمل إلا مع DEAL_TEST_HOOKS=1 (بيئة الاختبار): سلوكه
 * يُكتب من خطّاف الاختبار في global.__dealAiScript ونداءاته تُسجَّل في
 * global.__dealAiCalls — بلا أي شبكة حقيقية في الاختبارات.
 */
const PROVIDER = String(process.env.AI_PROVIDER || '').toLowerCase().trim();
const TEST_HOOKS = process.env.DEAL_TEST_HOOKS === '1';
const MODEL = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite').trim();
const TIMEOUT_MS = Math.max(500, +(process.env.AI_TIMEOUT_MS || 10000) || 10000);
const MAX_OUTPUT_TOKENS = 400;
const ESCALATE = 'ESCALATE';

/* كتلة المعرفة المؤرَّضة — كل سطر فيها حقيقة مذكورة أصلاً داخل التطبيق
   (الأسئلة الشائعة/مركز الثقة/شروط المعاملات). لا أرقام ولا وعود من خارجها. */
const KNOWLEDGE = [
  'Deal is a platform for all content creators and service providers. Clients can request a service as guests without any account; creators and providers register for free. Deal — منصة كل صناع المحتوى ومقدمي الخدمات: العميل يقدر يطلب خدمة كضيف من غير حساب، والتسجيل مجاني للصناع ومقدمي الخدمات.',
  'The Deal fee (commission) is 10% of the deal value and is paid FIRST by the client before any money reaches the creator. The client pays exactly the listed price — the fee is part of it and comes out of the creator share, so the creator nets 90%. عمولة Deal هي 10% من قيمة الصفقة وتُدفع أولاً من العميل قبل أي مبلغ للصانع، والعميل يدفع السعر المعلن بالضبط وصافي الصانع 90%.',
  'After the fee, the client pays a 45% deposit DIRECTLY to the creator so work starts. On deals over 1000, the deposit splits into two instalments: 20% when execution starts, then 25% after the provider submits an initial preview and the client confirms it. بعد العمولة يدفع العميل 45% عربوناً للصانع مباشرة، وفي الصفقات الأكبر من 1000 يتقسم العربون 20% عند بدء التنفيذ ثم 25% بعد معاينة أولية يقدّمها المنفذ ويؤكدها العميل.',
  'The provider executes and submits a proof of delivery (a preview of the work). The final copy is delivered ONLY after the client confirms receipt of the preview, pays the final 45% DIRECTLY to the creator, and the creator confirms receiving it. المنفذ ينفّذ ويرفع إثبات تنفيذ (معاينة)، والنسخة النهائية لا تُسلَّم إلا بعد تأكيد العميل استلام المعاينة ودفعه الـ45% الأخيرة للمنفذ مباشرة وتأكيد المنفذ قبضها.',
  'Every payment step has a 3-hour deadline with a live countdown; if it expires with no payment declared, the order is cancelled automatically with no money moving. كل خطوة دفع لها مهلة 3 ساعات بعدّاد حي، وانتهاؤها بلا إعلان دفع يلغي الطلب تلقائياً بلا أي حركة مال.',
  'Silence rules: if the client stays silent for 24 hours after a valid proof of delivery, receipt is deemed confirmed and the final-payment step opens (with graduated reminders during the window). If the client stays silent for 3 hours after the final delivery, completion is deemed. سكوت العميل 24 ساعة بعد إثبات تنفيذ سليم = استلام مُعتبَر يفتح خطوة دفع الباقي (مع تنبيهات متدرجة أثناء المهلة)، وسكوت العميل 3 ساعات بعد التسليم النهائي = اكتمال مُعتبَر.',
  'Deal NEVER receives or holds transaction money between the parties at any stage — Deal لا يستلم ولا يحتجز أموال المعاملات بين الأطراف في أي مرحلة أبداً. Money moves directly between personal wallets (P2P — e.g. Vodafone Cash/InstaPay in Egypt and each country\'s local method), and Deal organizes, documents and protects — it is not a bank. Only its fee and subscriptions are its revenue. الفلوس بتتحرك بين المحافظ الشخصية مباشرة (P2P)، وDeal بينظّم ويوثّق ويحمي ومش بنك.',
  'Replacement guarantee: it activates only if the provider declares inability, or stays silent in the booking chat for a full 24 hours after receiving the deposit despite two automatic warnings. The platform offers one verified substitute from the same city and niche at the identical price and terms within 24 hours, and the client decides within 3 hours; if there is no suitable substitute, the deposit is refunded in full by an arbitration decision within 72 hours. A money breach freezes the account automatically with a public "late dues" marker plus a breach penalty of 10% of the deal value (doubling on repetition), and fraud means a lifetime ban of the person. There is no replacement after the preview is approved. ضمان الاستبدال في حالتين فقط: إعلان المنفذ عدم قدرته، أو سكوته 24 ساعة في محادثة الحجز بعد قبض العربون رغم تنبيهين. بديل واحد موثّق من نفس المدينة والمجال بنفس السعر والشروط خلال 24 ساعة وقرار العميل خلال 3 ساعات، وإلا يُردّ العربون كاملاً بقرار تحكيم خلال 72 ساعة. الإخلال المالي = تجميد تلقائي وعلامة «مستحقات متأخرة» وغرامة إخلال 10% من قيمة الصفقة (تتضاعف عند التكرار)، والاحتيال = حظر نهائي للشخص. ولا استبدال بعد اعتماد المعاينة.',
  'Any agreement outside the platform does not happen and the platform is not bound by it — no guarantee, no arbitration, no evidence bundle and no rating for anything not opened and documented as a booking inside Deal. The only step that happens outside is executing the transfer itself from your wallet; the agreement, proof, confirmation, delivery, rating and arbitration are all inside Deal, and the booking chat is the only evidence channel. أي اتفاق خارج المنصة لا يتم والمنصة غير ملزمة بيه — الحاجة الوحيدة اللي بتتم برّه هي تنفيذ التحويل نفسه من محفظتك، ومحادثة الحجز هي قناة الأدلة الوحيدة.',
  'Disputes are opened from inside the booking: the booking progress freezes immediately, arbitration starts with a 10-minute negotiation phase between the two parties, then the owner decides from the auto-generated evidence bundle, with the decision issued within 72 hours of complete evidence. النزاع يُفتح من داخل الحجز فيتجمّد تقدمه فوراً، والتحكيم يبدأ بطور تفاوض 10 دقائق ثم يحسم المالك من حزمة الأدلة بقرار خلال 72 ساعة من اكتمال الأدلة.',
  'Ratings unlock only after full payment completion, once per side per booking, and cannot be edited afterwards. التقييم يفتح فقط بعد اكتمال القبض، مرة واحدة لكل طرف ولكل حجز، ولا يمكن تعديله.',
  'Verification: a creator places an ownership code in the bio of a public account or a pinned post and submits the link — a match grants the "Deal Verified" badge instantly. The first 50 creators to register receive a permanent "Founding Member" badge. Email verification with a 6-digit code is required before a creator can accept bookings or submit quotes. التوثيق بكود ملكية في بايو حساب علني أو منشور مثبّت يمنح شارة «موثّق Deal» فوراً، وأول 50 صانعاً يسجلون يحصلون على شارة «عضو مؤسس» الدائمة، وتحقق الإيميل بكود من 6 أرقام إلزامي قبل ما الصانع يقدر يقبل حجوزات أو يقدّم عروضاً.',
  'The "Deal Star" package costs EGP 199 for 30 days: a gold badge and frame, ranking priority and first recommendation to clients, a shot at "Star of the Week", monthly growth fuel, and priority support. It activates ONLY after the owner confirms the money actually arrived — before that, zero benefits. باقة «نجم Deal» بـ199 جنيهاً لمدة 30 يوماً (شارة وإطار ذهبي، أولوية ترتيب وترشيح أول، فرصة «نجم الأسبوع»، وقود نمو شهري، أولوية دعم) ولا تتفعّل إلا بعد تأكيد المالك وصول الفلوس فعلياً — قبلها صفر مزايا.',
  'Deal is available in 19 Arab countries, and registration is open from any other country in the world (choose "Other country", write its name, pick a currency and register with an international phone number). Payments use each country\'s local method; outside Egypt, platform fees and subscriptions are collected by local collection points (city ambassadors) and settled to the owner via Payoneer, deal by deal. Deal متاح في 19 دولة عربية والتسجيل مفتوح من أي دولة أخرى في العالم، والدفع بوسيلة كل بلد المحلية، وحصص المنصة برّه مصر بتتجمع عند سفراء المدن وبتتسوّى للمالك عبر Payoneer صفقةً بصفقة.',
  'Each person gets exactly one Deal account — one contact = one profile. كل شخص له حساب واحد فقط على Deal.',
  'Password recovery: from the sign-in screen, "Forgot password?" sends a 6-digit code to your email (valid 10 minutes) to set a new password; or use one of your ten one-time backup codes from "My devices & sessions". استعادة كلمة السر بكود من 6 أرقام على الإيميل (صالح 10 دقائق) أو بكود احتياطي من «أجهزتي وجلساتي».',
  'The Deal Academy is a free in-platform learning section for everyone and all services, with short tracks and an "apply it on your profile" task verified automatically from a real action, ending in a qualification badge. "Deal Plus" is a request option (full management by Deal) that routes the request to the Deal team instead of the market. أكاديمية Deal قسم تعليمي مجاني داخل المنصة للجميع ولكل الخدمات بشارة تأهيل، و«Deal Plus» اختيار إدارة كاملة من فريق Deal لطلبك.',
  'Questions this assistant cannot answer from these facts are saved for the Deal team to review personally. الأسئلة اللي الرد الذكي مش بيقدر يجاوبها من الحقائق دي بتتحفظ لفريق Deal للمراجعة الشخصية.',
].join('\n');

function systemPrompt(lang) {
  const langLine = lang === 'en'
    ? 'The user wrote in English — answer in English.'
    : 'The user wrote in Arabic — answer in Arabic (Egyptian-friendly, clear).';
  return [
    'You are the automated support assistant of Deal, a platform for content creators and service providers.',
    'Answer the user\'s support question using ONLY the facts in the KNOWLEDGE block below. Never invent rules, prices, deadlines, names, or promises that are not in the block. Never promise an arbitration outcome.',
    'Be brief and helpful: a few short sentences at most, in a friendly tone. ' + langLine,
    'If the question is about a SPECIFIC booking, a specific dispute or complaint, money a specific person owes, an action on a specific account (ban, freeze, refund, activation), a report about a specific person, or ANYTHING not covered by the knowledge block, reply with exactly this word and nothing else: ' + ESCALATE,
    'KNOWLEDGE:',
    KNOWLEDGE,
  ].join('\n');
}

function configured() {
  if (PROVIDER === 'gemini') return !!process.env.GEMINI_API_KEY;
  if (PROVIDER === 'test') return TEST_HOOKS;
  return false;
}

function withTimeout(promiseFactory, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { const e = new Error('ai provider timeout'); e.code = 'AI_TIMEOUT'; reject(e); }, ms);
    Promise.resolve()
      .then(promiseFactory)
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

async function callGemini({ question, lang }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(lang) }] },
        contents: [{ role: 'user', parts: [{ text: String(question || '').slice(0, 1000) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
    });
    const text = await r.text();
    if (!r.ok) { const e = new Error(`ai provider HTTP ${r.status}`); e.status = r.status; throw e; }
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* not json */ }
    const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    return Array.isArray(parts) ? parts.map((p) => (p && p.text) || '').join('') : '';
  } finally { clearTimeout(timer); }
}

/* مزوّد الاختبار: سلوك مكتوب من الخطّاف (global.__dealAiScript):
   { mode:'reply', text } | { mode:'escalate' } | { mode:'throw' } |
   { mode:'quota' } (خطأ بحالة 429 كما يرده المزوّد الحقيقي عند نفاد الحصة) |
   { mode:'hang' } (لا يرد أبداً — تختبره مهلة الالتفاف). بلا سيناريو مكتوب
   يتصرف كأنه غير مُعدّ، فتبقى أي نسخة اختبار أخرى على سلوك اليوم تماماً. */
async function callTest({ question, lang }) {
  const script = global.__dealAiScript;
  if (!script || !script.mode || script.mode === 'off') {
    const e = new Error('ai test provider not scripted'); e.aiReason = 'not_configured'; throw e;
  }
  if (!global.__dealAiCalls) global.__dealAiCalls = [];
  global.__dealAiCalls.push({ question: String(question || ''), lang: lang || 'ar', at: Date.now() });
  switch (script.mode) {
    case 'reply': return String(script.text || 'حاضر — ده رد ذكي تجريبي.');
    case 'escalate': return ESCALATE;
    case 'quota': { const e = new Error('ai test quota'); e.status = 429; throw e; }
    case 'hang': return new Promise(() => {});
    default: throw new Error('ai test provider failure');
  }
}

async function aiSupportReply({ question, lang } = {}) {
  if (!configured()) return { ok: false, reason: 'not_configured' };
  let raw;
  try {
    raw = await withTimeout(() => (PROVIDER === 'gemini' ? callGemini({ question, lang }) : callTest({ question, lang })), TIMEOUT_MS);
  } catch (e) {
    if (e && e.aiReason) return { ok: false, reason: e.aiReason };
    if (e && e.status === 429) return { ok: false, reason: 'quota' };
    if (e && (e.code === 'AI_TIMEOUT' || e.name === 'AbortError')) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'error' };
  }
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text === ESCALATE) return { ok: false, reason: 'escalate' };
  return { ok: true, text: text.slice(0, 2000) };
}

module.exports = { aiSupportReply, configured, systemPrompt, KNOWLEDGE, ESCALATE, MODEL, TIMEOUT_MS, provider: PROVIDER };
