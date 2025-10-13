'use strict';

/**
 * نقطة تشغيل الخدمة (root/index.js):
 * - يشغّل خادم HTTP الصحي
 * - يشغّل بوت تيليجرام (WebHook أو Polling حسب ما يوفّره الموديول الداخلي)
 * - يشغّل واتساب
 */

const http   = require('http');
const logger = require('./src/lib/logger');
const { startWhatsApp } = require('./src/app/whatsapp');

// نحاول دعم الاسمين معًا: startTelegramBot و/أو startTelegram
let tgModule = {};
try {
  tgModule = require('./src/app/telegram');
} catch (e) {
  logger.warn('لم يتم العثور على src/app/telegram — سيتم تشغيل واتساب فقط.');
}
const startTelegramBot =
  tgModule.startTelegramBot || tgModule.startTelegram || (async () => null);

// خادم صحي بسيط لطلبات Render
const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.end('OK');
  try {
    logger.info(
      { ua: req.headers['user-agent'], path: req.url, method: req.method, ip: req.socket?.remoteAddress },
      'HTTP'
    );
  } catch {}
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`🌐 HTTP server listening on 0.0.0.0:${PORT}`);
});

// مسك الأخطاء غير المُلتقطة
process.on('unhandledRejection', (err) => {
  logger.error({ err, stack: err?.stack }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err, stack: err?.stack }, 'uncaughtException');
});

(async () => {
  try {
    // شغّل تيليجرام إن وُجد التوكن/الموديول — لا تُسقط الخدمة إن فشل
    let telegram = null;
    try {
      telegram = await startTelegramBot({ server }); // الموديول الداخلي يتصرّف حسب تنفيذه
      if (!telegram) {
        if (!process.env.TELEGRAM_BOT_TOKEN) {
          logger.warn('TELEGRAM_BOT_TOKEN مفقود — بوت تيليجرام لن يبدأ (لا مشكلة، سنُكمل واتساب).');
        } else {
          logger.warn('startTelegramBot لم يُرجِع كائن تحكم — سنُكمل واتساب فقط.');
        }
      }
    } catch (tgErr) {
      logger.error({ err: tgErr, stack: tgErr?.stack }, 'فشل بدء بوت تيليجرام — سنتابع تشغيل واتساب فقط');
    }

    // شغّل واتساب
    await startWhatsApp({ telegram });
  } catch (e) {
    logger.error({ err: e, stack: e?.stack }, 'Fatal error in bootstrap');
    process.exit(1);
  }
})();
