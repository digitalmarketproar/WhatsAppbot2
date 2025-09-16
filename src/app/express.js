// src/app/express.js
const express = require('express');
const logger = require('../lib/logger');

function startExpress() {
  const app = express();

  // لوج مبسّط للطلبات
  app.use((req, res, next) => {
    logger.info(
      { ua: req.headers['user-agent'], path: req.path, method: req.method, ip: req.ip },
      'HTTP'
    );
    next();
  });

  // صحة/جهوزية
  app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
  app.head('/healthz', (_req, res) => res.status(200).end());
  app.get('/', (_req, res) => res.send('WhatsApp Bot is running.'));

  // جاهزية للخلف proxy (اختياري)
  if (process.env.TRUST_PROXY) app.set('trust proxy', true);

  // ✅ أهم شيء: استخدم منفذ Render الديناميكي واستمع على 0.0.0.0
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = '0.0.0.0';

  app.listen(PORT, HOST, () => logger.info(`🌐 HTTP server listening on ${HOST}:${PORT}`));
  return app;
}

module.exports = { startExpress };
