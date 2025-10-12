'use strict';

/**
 * نقطة تشغيل الخدمة:
 * - يشغّل خادم HTTP صحي للـ Render
 * - يشغّل بوت تيليجرام
 * - يشغّل واتساب (وسيُعيد ربط مستمع الرسائل داخليًا عند أي إعادة اتصال)
 */

const http    = require('http');
const logger  = require('./lib/logger');
const { startTelegram } = require('./app/telegram');
const { startWhatsApp } = require('./app/whatsapp');

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
    const telegram = startTelegram();          // بوت تيليجرام (لإرسال QR… إلخ)
    await startWhatsApp({ telegram });         // بوت واتساب — مستمع الرسائل يُسجل داخل startWhatsApp
  } catch (e) {
    logger.error({ err: e, stack: e?.stack }, 'Fatal error in bootstrap');
    process.exit(1);
  }
})();
