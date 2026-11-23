'use strict';
/**
 * Deal — WebAuthn / Passkey (جولة البصمة، TESTING-PASSKEY.md).
 *
 * تحقق WebAuthn مصغّر وصحيح بـ node:crypto وحده + مفكّك CBOR صغير لمفتاح
 * COSE — بلا أي اعتماديات جديدة. نطاق التحقق المتعمّد:
 *  - تسجيل: clientData (النوع/التحدي/الأصل) + authenticatorData (بصمة
 *    RP ID + علمَا الحضور والشهادة) + استخراج مفتاح COSE من بيانات
 *    الاعتماد المشهودة. بيانات الشهادة (attestation statement) لا تُتحقق
 *    سلسلة ثقتها: التسجيل نفسه يتم داخل جلسة كاملة موثّقة بكلمة السر،
 *    فالبصمة اعتماد إضافي يُربط بحساب قائم موثّق الهوية أصلاً — والواجهة
 *    تطلب attestation:'none' صراحة.
 *  - دخول: توقيع التأكيد بمفتاح COSE المحفوظ (ES256 مطلوب؛ RS256 مدعوم
 *    عبر JWK) + التحدي + بصمة RP ID + علم التحقق من المستخدم (UV) +
 *    رتابة عدّاد التوقيع (كشف الاستنساخ — انظر verifyAssertion).
 *  - لا بيومترية هنا أبداً: البصمة لا تغادر جهاز المستخدم؛ الخادم يحفظ
 *    المفتاح العام فقط ويتحقق من توقيعاته.
 *
 * الإعداد من البيئة فقط: WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN /
 * WEBAUTHN_RP_NAME (افتراضي دومين الإنتاج الرسمي).
 */
const crypto = require('crypto');

const RP_ID = process.env.WEBAUTHN_RP_ID || 'dealplatform.vercel.app';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://dealplatform.vercel.app';
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Deal';
const RP_ID_HASH = crypto.createHash('sha256').update(RP_ID).digest();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function b64urlToBuf(s) {
  if (typeof s !== 'string' || !s || s.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('bad base64url');
  return Buffer.from(s, 'base64url');
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

/* ---------------- مفكّك CBOR مصغّر ----------------
   يكفي لخرائط COSE و attestationObject: الأنواع الكبرى 0–5 وقيم بسيطة
   أساسية. يعيد { value, bytesRead } حتى يعرف المستدعي أين ينتهي كل عنصر
   (مفتاح COSE داخل بيانات الاعتماد يليه لا شيء، لكن طوله لازم لاستخراج
   بايتاته الخام كما هي). */
function cborDecode(buf, offset = 0) {
  let pos = offset;
  const first = buf[pos++];
  const major = first >> 5;
  const info = first & 0x1f;
  let arg;
  if (info < 24) arg = info;
  else if (info === 24) { arg = buf[pos]; pos += 1; }
  else if (info === 25) { arg = buf.readUInt16BE(pos); pos += 2; }
  else if (info === 26) { arg = buf.readUInt32BE(pos); pos += 4; }
  else if (info === 27) { const hi = buf.readUInt32BE(pos), lo = buf.readUInt32BE(pos + 4); arg = hi * 2 ** 32 + lo; pos += 8; }
  else throw new Error('cbor: unsupported additional info');
  switch (major) {
    case 0: return { value: arg, bytesRead: pos - offset };
    case 1: return { value: -1 - arg, bytesRead: pos - offset };
    case 2: { const v = buf.subarray(pos, pos + arg); return { value: Buffer.from(v), bytesRead: pos + arg - offset }; }
    case 3: { const v = buf.toString('utf8', pos, pos + arg); return { value: v, bytesRead: pos + arg - offset }; }
    case 4: {
      const arr = [];
      for (let i = 0; i < arg; i++) { const r = cborDecode(buf, pos); arr.push(r.value); pos += r.bytesRead; }
      return { value: arr, bytesRead: pos - offset };
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < arg; i++) {
        const k = cborDecode(buf, pos); pos += k.bytesRead;
        const v = cborDecode(buf, pos); pos += v.bytesRead;
        map.set(k.value, v.value);
      }
      return { value: map, bytesRead: pos - offset };
    }
    case 7: {
      if (info === 20) return { value: false, bytesRead: pos - offset };
      if (info === 21) return { value: true, bytesRead: pos - offset };
      if (info === 22) return { value: null, bytesRead: pos - offset };
      throw new Error('cbor: unsupported simple value');
    }
    default: throw new Error('cbor: unsupported major type');
  }
}

/* ---------------- clientDataJSON ---------------- */
function parseClientData(buf, expectedType, expectedChallenge) {
  let cd;
  try { cd = JSON.parse(Buffer.from(buf).toString('utf8')); } catch (e) { throw new Error('clientData not JSON'); }
  if (!cd || cd.type !== expectedType) throw new Error('clientData type mismatch');
  if (cd.challenge !== expectedChallenge) throw new Error('challenge mismatch');
  if (cd.origin !== ORIGIN) throw new Error('origin mismatch');
  return cd;
}

/* ---------------- authenticatorData ----------------
   التخطيط: rpIdHash(32) ‖ flags(1) ‖ signCount(4 BE) ‖ [بيانات اعتماد
   مشهودة عند علم AT: aaguid(16) ‖ طول المعرّف(2 BE) ‖ المعرّف ‖ مفتاح
   COSE]. الأعلام: UP=0x01 UV=0x04 AT=0x40 ED=0x80. */
function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw new Error('authData too short');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  if (!rpIdHash.equals(RP_ID_HASH)) throw new Error('rpIdHash mismatch');
  const out = { flags, signCount, userPresent: !!(flags & 0x01), userVerified: !!(flags & 0x04), attested: !!(flags & 0x40) };
  if (out.attested) {
    if (buf.length < 55) throw new Error('attested data truncated');
    const credIdLen = buf.readUInt16BE(53);
    const credIdStart = 55;
    const credIdEnd = credIdStart + credIdLen;
    if (buf.length <= credIdEnd) throw new Error('credential id truncated');
    out.credentialId = Buffer.from(buf.subarray(credIdStart, credIdEnd));
    const cose = cborDecode(buf, credIdEnd);
    out.coseKey = cose.value;
    out.coseKeyBytes = Buffer.from(buf.subarray(credIdEnd, credIdEnd + cose.bytesRead));
  }
  return out;
}

/* ---------------- مفتاح COSE → مفتاح تحقق ----------------
   ES256 (kty=2, alg=-7, crv=1 P-256, x=-2, y=-3) هو المطلوب؛ RS256
   (kty=3, alg=-257, n=-1, e=-2) مدعوم لأنه يمر عبر JWK بنفس السطر.
   أي شيء آخر يُرفض بنظافة. الإخراج: KeyObject + وصف JWK ثابت التخزين؟
   التخزين هو بايتات COSE الخام نفسها (في جدول passkeys) — التحويل هنا
   وقت التحقق فقط. */
function coseToKeyObject(cose) {
  if (!(cose instanceof Map)) throw new Error('cose key not a map');
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2) {
    if (alg !== -7) throw new Error('ec alg not ES256');
    if (cose.get(-1) !== 1) throw new Error('ec curve not P-256');
    const x = cose.get(-2), y = cose.get(-3);
    if (!Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) throw new Error('ec coords bad');
    return crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) } });
  }
  if (kty === 3) {
    if (alg !== -257) throw new Error('rsa alg not RS256');
    const n = cose.get(-1), e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !n.length || !Buffer.isBuffer(e) || !e.length) throw new Error('rsa params bad');
    return crypto.createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: b64url(n), e: b64url(e) } });
  }
  throw new Error('unsupported cose kty');
}
function coseAlgSupported(cose) {
  try { coseToKeyObject(cose); return true; } catch (e) { return false; }
}

/* ---------------- مراسم التسجيل ----------------
   يتحقق ويعيد بيانات الاعتماد الجاهزة للحفظ. يرمي Error برسالة سبب
   داخلية عند أي فشل — المستدعي يحوّلها لرد عام واحد ثابت الشكل. */
function verifyRegistration({ attestationObject, clientDataJSON }, expectedChallenge) {
  parseClientData(clientDataJSON, 'webauthn.create', expectedChallenge);
  const att = cborDecode(attestationObject, 0).value;
  if (!(att instanceof Map)) throw new Error('attestation not a map');
  const authData = att.get('authData');
  if (!Buffer.isBuffer(authData)) throw new Error('authData missing');
  const parsed = parseAuthData(authData);
  if (!parsed.userPresent) throw new Error('user presence missing');
  if (!parsed.attested) throw new Error('attested credential data missing');
  if (!coseAlgSupported(parsed.coseKey)) throw new Error('cose key unsupported');
  return {
    credentialId: parsed.credentialId,
    coseKeyBytes: parsed.coseKeyBytes,
    signCount: parsed.signCount,
  };
}

/* ---------------- مراسم الدخول ----------------
   قاعدة عدّاد التوقيع (اختيار موثّق — إرشاد مواصفة WebAuthn لكشف
   الاستنساخ): إن كان أيٌّ من العدّادين صفراً فالمصدّق لا يدعم العدّ
   فعلياً (شائع في مفاتيح المنصة المتزامنة) ويُقبل التوقيع بلا حكم
   رتابة. أما وكلاهما موجب فأي عدّاد جديد ≤ المحفوظ يعني نسخة مستنسخة
   محتملة → رفض. */
function verifyAssertion({ authenticatorData, clientDataJSON, signature }, storedCoseKeyBytes, expectedChallenge) {
  parseClientData(clientDataJSON, 'webauthn.get', expectedChallenge);
  const parsed = parseAuthData(authenticatorData);
  if (!parsed.userPresent) throw new Error('user presence missing');
  if (!parsed.userVerified) throw new Error('user verification missing');
  const cose = cborDecode(storedCoseKeyBytes, 0).value;
  const key = coseToKeyObject(cose);
  const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  let ok = false;
  try { ok = crypto.verify('sha256', signed, key, signature); } catch (e) { ok = false; }
  if (!ok) throw new Error('signature invalid');
  return { signCount: parsed.signCount };
}
function signCountAcceptable(storedCount, newCount) {
  if (!storedCount || !newCount) return true; // أحد الطرفين بلا عدّاد داعم
  return newCount > storedCount;
}

module.exports = {
  RP_ID, ORIGIN, RP_NAME,
  b64url, b64urlToBuf, sha256,
  cborDecode, parseAuthData, coseToKeyObject,
  verifyRegistration, verifyAssertion, signCountAcceptable,
};
