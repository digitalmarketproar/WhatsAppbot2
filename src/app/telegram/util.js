// src/app/telegram/util.js
const logger = require('../../lib/logger');

function normalizeToJid(input) {
  try {
    if (!input) return '';
    let s = String(input).trim();
    if (/@s\.whatsapp\.net$/.test(s) || /@g\.us$/.test(s)) return s;
    s = s.replace(/[^\d\-]/g, '');
    if (/^\d{6,20}$/.test(s)) return `${s}@s.whatsapp.net`;
    return '';
  } catch (e) {
    logger.error({ e, input }, 'normalizeToJid failed');
    return '';
  }
}

function adminOnly(ctx, handler) {
  return async (msg, ...rest) => {
    if (String(msg.chat.id) !== String(ctx.adminId)) return;
    try {
      await handler(msg, ...rest);
    } catch (e) {
      logger.error({ e, text: msg?.text }, 'Telegram admin command failed');
      await ctx.bot.sendMessage(ctx.adminId, '❌ حدث خطأ أثناء تنفيذ الأمر.');
    }
  };
}

module.exports = { normalizeToJid, adminOnly };
