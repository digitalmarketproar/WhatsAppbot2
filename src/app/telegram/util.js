'use strict';

/**
 * adminOnly(ctx, handler)
 * - إن لم تحدد TELEGRAM_ADMIN_ID يسمح للجميع (ويسجّل تحذير)
 * - إن حددته، يسمح فقط لمن chat.id === adminId (رقم صحيح)
 */

const logger = require('../../lib/logger');

function adminOnly(ctx, handler) {
  const adminIdStr = (ctx.adminId || '').trim();
  const adminId = adminIdStr ? Number(adminIdStr) : null;

  if (!adminId) {
    logger.warn('TELEGRAM_ADMIN_ID is not set — adminOnly will ALLOW ALL senders.');
    return async (msg, ...rest) => {
      try { await handler(msg, ...rest); } catch (e) { logger.error({ err: e?.message, stack: e?.stack }, 'adminOnly handler error'); }
    };
  }

  return async (msg, ...rest) => {
    const chatId = msg?.chat?.id;
    if (Number(chatId) !== adminId) {
      logger.info({ chatId, expectedAdminId: adminId }, 'adminOnly: blocked non-admin message');
      return; // تجاهل
    }
    try {
      await handler(msg, ...rest);
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'adminOnly handler error');
    }
  };
}

module.exports = { adminOnly };
