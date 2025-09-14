const express = require('express');
const logger = require('../lib/logger');
const { PORT } = require('../config/settings');

function startExpress() {
  const app = express();
  app.use((req,res,next)=>{ logger.info({ ua: req.headers['user-agent'], path: req.path, method: req.method }, 'HTTP'); next(); });
  app.get('/healthz', (req,res)=>res.json({ ok:true, ts: Date.now() }));
  app.head('/healthz', (req,res)=>res.status(200).end());
  app.get('/', (req,res)=>res.send('WhatsApp Bot is running.'));
  app.listen(PORT, ()=> logger.info(`🌐 HTTP server listening on :${PORT}`));
  return app;
}

module.exports = { startExpress };