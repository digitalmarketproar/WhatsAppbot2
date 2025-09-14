// src/lib/jid.js
/**
 * أدوات JID: تطبيع/استخراج لتوافق أشكال Baileys المختلفة.
 */

/** يُرجع JID مستخدم بصيغة 12345@s.whatsapp.net بدون لاحقة الجهاز 12345:1@... */
function normalizeUserJid(jid) {
  if (!jid) return '';
  const s = String(jid);
  const at = s.indexOf('@');
  if (at === -1) return s;
  const beforeAt = s.slice(0, at);
  const domain = s.slice(at + 1);
  const core = beforeAt.split(':')[0]; // أزل لاحقة الجهاز إن وجدت 12345:1
  if (domain.startsWith('s.whatsapp.net')) return `${core}@s.whatsapp.net`;
  if (domain.startsWith('lid')) return `${core}@s.whatsapp.net`; // حالات @lid
  return `${core}@${domain}`;
}

/** هل هو قروب */
function isGroupJid(jid) {
  return /@g\.us$/i.test(String(jid || ''));
}

/** الجزء الرقمي 12345 من 12345@s.whatsapp.net */
function bareNumber(jid) {
  return String(jid || '').replace(/@.+$/, '');
}

module.exports = { normalizeUserJid, isGroupJid, bareNumber };
