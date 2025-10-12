'use strict';

/**
 * نقطة تشغيل الخدمة (root/index.js):
 * - يشغّل خادم HTTP الصحي
 * - يشغّل بوت تيليجرام
 * - يشغّل واتساب
 * المسارات كلها تشير إلى داخل src/
 */

const http    = require('http');
const logger  = require('./src/lib/logger');
const { startTelegram } = require('./src/app/telegram');
const { startWhatsApp } = require('./src/app/whatsapp');

// خادم صحي بسيط لطلبات Render
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.statusCode = 200;
  res.end('OK');
  try {
    logger.info(
      { ua: req.headers['user-agent'], path: req.url, method: req.method, ip: req.socket?.remoteAddress },
      'HTTP'
    );
  } catch {}
}).listen(PORT, '0.0.0.0', () => {
  logger.info(`🌐 HTTP server listening on 0.0.0.0:${PORT}`);
});

(async () => {
  try {
    const telegram = startTelegram();
    await startWhatsApp({ telegram });
  } catch (e) {
    logger.error({ err: e, stack: e?.stack }, 'Fatal error in bootstrap');
    process.exit(1);
  }
})();
