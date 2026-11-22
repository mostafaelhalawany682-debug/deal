'use strict';
/**
 * مدخل Vercel serverless — يصدّر تطبيق Express كما هو.
 * vercel.json يوجّه كل مسارات /api/* إلى هذا الملف، والواجهة الثابتة
 * تُخدَم من مجلد public/ مباشرة بواسطة Vercel.
 * إنشاء الجداول يحدث تلقائياً عند أول طلب (middleware داخل server/index.js).
 */
module.exports = require('../server/index');
