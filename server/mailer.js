'use strict';
/**
 * طبقة إرسال بريد مجردة لجولة «الدخول والاسترجاع زي التطبيقات الكبرى».
 *
 * المزوّد يُختار بمتغير البيئة EMAIL_PROVIDER: resend | brevo | smtp | test
 * والمفاتيح من متغيرات البيئة فقط (لا قيمة افتراضية لأي سر في الكود):
 *   EMAIL_FROM       عنوان المُرسِل (مثال: Deal <no-reply@trydeal.app>)
 *   RESEND_API_KEY   مفتاح Resend (خطة مجانية)
 *   BREVO_API_KEY    مفتاح Brevo (خطة مجانية)
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS   خادم SMTP خاص
 * بلا مزوّد مُعدّ: configured()‎ = false — وخطوة «نسيت كلمة السر» تتعطل
 * برسالة واضحة من الخادم ولا ينهار أي شيء آخر.
 *
 * المزوّد test لا يعمل إلا مع DEAL_TEST_HOOKS=1 (بيئة الاختبار): يحفظ
 * الرسائل في global.__dealOutbox بدل إرسالها، فتلتقطها الاختبارات.
 */
const net = require('net');
const tls = require('tls');

const PROVIDER = String(process.env.EMAIL_PROVIDER || '').toLowerCase().trim();
const TEST_HOOKS = process.env.DEAL_TEST_HOOKS === '1';

function fromAddress() {
  return String(process.env.EMAIL_FROM || 'Deal <onboarding@resend.dev>');
}
function fromEmailOnly() {
  const f = fromAddress();
  const m = /<([^>]+)>/.exec(f);
  const addr = (m ? m[1] : f).trim();
  return addr.includes('@') ? addr : 'onboarding@resend.dev';
}
function fromName() {
  const f = fromAddress();
  const m = /^([^<]+)</.exec(f);
  return (m ? m[1] : 'Deal').trim() || 'Deal';
}

function configured() {
  if (PROVIDER === 'resend') return !!process.env.RESEND_API_KEY;
  if (PROVIDER === 'brevo') return !!process.env.BREVO_API_KEY;
  if (PROVIDER === 'smtp') return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  if (PROVIDER === 'test') return TEST_HOOKS;
  return false;
}

async function fetchJson(url, opts, timeoutMs = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* not json */ }
    if (!r.ok) throw new Error(`email provider HTTP ${r.status}: ${text.slice(0, 200)}`);
    return j;
  } finally { clearTimeout(timer); }
}

async function sendViaResend({ to, subject, text }) {
  return fetchJson('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, text }),
  });
}

async function sendViaBrevo({ to, subject, text }) {
  return fetchJson('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: fromName(), email: fromEmailOnly() },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
}

/* عميل SMTP minimal (AUTH LOGIN + رسالة نصية واحدة): يدعم TLS ضمني
   (465 افتراضياً عند غياب SMTP_PORT) واتصالاً عادياً. عند أي فشل يرمي
   خطأً ويلتقطه المتصل — لا حالة نصف مرسلة تبقى معلّقة. */
function sendViaSmtp({ to, subject, text }) {
  const host = process.env.SMTP_HOST;
  const port = +(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const implicitTls = port === 465;
  return new Promise((resolve, reject) => {
    const sock = implicitTls
      ? tls.connect(port, host, { servername: host })
      : net.connect(port, host);
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('smtp timeout')); });
    let buf = '';
    let step = 0;
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const msg = [
      `From: ${fromAddress()}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      String(text || ''),
      '.',
    ].join('\r\n');
    const steps = [
      null, // greeting 220
      () => `EHLO deal.local`,
      () => `AUTH LOGIN`,
      () => b64(user),
      () => b64(pass),
      () => `MAIL FROM:<${fromEmailOnly()}>`,
      () => `RCPT TO:<${to}>`,
      () => `DATA`,
      () => msg,
      () => `QUIT`,
    ];
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.lastIndexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const code = parseInt(line.slice(line.lastIndexOf('\n') + 1), 10) || parseInt(line, 10);
      if (step >= 4 && code >= 400) { sock.destroy(); reject(new Error(`smtp error ${code}`)); return; }
      step++;
      if (step >= steps.length) { sock.end(); resolve({ ok: true }); return; }
      const cmd = steps[step] && steps[step]();
      if (cmd) sock.write(cmd + '\r\n');
    });
    sock.on('error', reject);
  });
}

async function sendMail(mail) {
  if (!configured()) throw new Error('email provider not configured');
  if (PROVIDER === 'resend') return sendViaResend(mail);
  if (PROVIDER === 'brevo') return sendViaBrevo(mail);
  if (PROVIDER === 'smtp') return sendViaSmtp(mail);
  if (PROVIDER === 'test') {
    if (!TEST_HOOKS) throw new Error('email provider not configured');
    if (!global.__dealOutbox) global.__dealOutbox = [];
    global.__dealOutbox.push({ to: mail.to, subject: mail.subject, text: mail.text, at: Date.now() });
    return { ok: true, test: true };
  }
  throw new Error('email provider not configured');
}

module.exports = { configured, sendMail, provider: PROVIDER };
