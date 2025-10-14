'use strict';

/**
 * نقطة التشغيل:
 * - يشغّل Express الرئيسي (health + root)
 * - يشغّل بوت تيليجرام (ويبهوك) على نفس الـExpress
 * - يشغّل واتساب، ويمرر له واجهة تيليجرام لإرسال الـQR
 */

const express = require('express');
const logger  = require('./src/lib/logger');
const { startTelegramBot } = require('./src/app/telegram');
const { startWhatsApp }    = require('./src/app/whatsapp');

const app = express();

// health endpoints
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.send('WhatsApp Bot is running.'));

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🌐 HTTP server listening on 0.0.0.0:${PORT}`);
});

(async () => {
  try {
    const telegram = await startTelegramBot({ app });
    await startWhatsApp({ telegram });
    logger.info('🚀 Both Telegram and WhatsApp initializers executed.');
  } catch (e) {
    logger.error({ err: e, stack: e?.stack }, 'Fatal error during bootstrap');
    process.exit(1);
  }
})();
