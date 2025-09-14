// src/lib/arabic.js
function normalizeArabic(input) {
  let s = String(input || '').trim();
  // إزالة التشكيل
  s = s.replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g, '');
  // إزالة التطويل
  s = s.replace(/\u0640/g, '');
  // توحيد الألف
  s = s.replace(/[إأآا]/g, 'ا');
  // توحيد الياء/الألف المقصورة
  s = s.replace(/[يى]/g, 'ي');
  // توحيد التاء المربوطة
  s = s.replace(/ة/g, 'ه');
  // مسافات زائدة
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// كشف روابط (http/https + دعوات واتساب)
const LINK_REGEX = /\b((https?:\/\/|www\.)[^\s]+|chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.me\/\d+)\b/i;
function hasLink(text) {
  return LINK_REGEX.test(String(text || ''));
}

function isMediaMessage(m) {
  const msg = m?.message || {};
  return !!(
    msg.imageMessage ||
    msg.videoMessage ||
    msg.audioMessage ||
    msg.documentMessage ||
    msg.stickerMessage ||
    msg.locationMessage ||
    msg.liveLocationMessage ||
    msg.contactMessage ||
    msg.contactsArrayMessage
  );
}

module.exports = { normalizeArabic, hasLink, isMediaMessage };
