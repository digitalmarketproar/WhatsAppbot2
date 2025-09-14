// تطبيع عربي خفيف + أدوات مساعدة
function normalizeArabic(input) {
  let s = String(input || '').trim();
  s = s.replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g, ''); // التشكيل
  s = s.replace(/\u0640/g, '');                                     // التطويل
  s = s.replace(/[إأآا]/g, 'ا');                                    // الألف
  s = s.replace(/[يى]/g, 'ي');                                      // الياء/المقصورة
  s = s.replace(/ة/g, 'ه');                                         // التاء المربوطة
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');                          // رموز/إيموجي
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const linkRegex = /\b((?:https?:\/\/|www\.)[^\s]+|(?:t\.me|wa\.me|chat\.whatsapp\.com)\/[^\s]+)/i;

function hasLink(text) {
  return linkRegex.test(text || '');
}

function isMediaMessage(msg) {
  const m = msg?.message || {};
  return !!(
    m.imageMessage ||
    m.videoMessage ||
    m.audioMessage ||
    m.stickerMessage ||
    m.documentMessage ||
    m.contactsArrayMessage ||
    m.pollCreationMessage
  );
}

module.exports = { normalizeArabic, hasLink, isMediaMessage };
