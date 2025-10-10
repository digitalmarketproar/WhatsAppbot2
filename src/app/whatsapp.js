// src/app/whatsapp.js
'use strict';

const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { MongoClient }  = require('mongodb');
const mongoose         = require('mongoose'); // compatibility
const NodeCache        = require('node-cache'); // compatibility
const QRCode           = require('qrcode');

const logger                 = require('../lib/logger');
const { mongoAuthState }     = require('../lib/wa-mongo-auth');
const { registerSelfHeal }   = require('../lib/selfheal');

const MONGO_URI   = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY = process.env.WA_LOCK_KEY || 'wa_lock_singleton';
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';

let _lockMongoClient = null;
let _lockHeld = false;
let _sock = null;

async function acquireLockOrExit() {
  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  _lockMongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await _lockMongoClient.connect();
  const col = _lockMongoClient.db().collection('locks');

  const now = Date.now();
  const STALE_MS = 3 * 60 * 1000; // 3 min
  const res = await col.updateOne(
    { _id: WA_LOCK_KEY, $or: [{ holderId }, { ts: { $lt: now - STALE_MS } }, { holderId: { $exists: false } }] },
    { $set: { holderId, ts: now } },
    { upsert: true }
  );
  const matched = res.matchedCount + (res.upsertedCount || 0);
  if (!matched) {
    logger.warn('Another instance holds the lock. Exiting.');
    process.exit(0);
  }
  _lockHeld = true;
  logger.info({ holderId, key: WA_LOCK_KEY }, '✅ Acquired/Refreshed WA singleton lock.');
}

async function releaseLock() {
  if (!_lockHeld) return;
  try { await _lockMongoClient.db().collection('locks').deleteOne({ _id: WA_LOCK_KEY }); } catch {}
  _lockHeld = false;
}

function safeCloseSock(s) {
  try { s?.end?.(); } catch {}
  try { s?.ws?.close?.(); } catch {}
}

async function createSocket({ telegram }) {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds, clearAuth } = await mongoAuthState(logger);

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    logger,
    syncFullHistory: false,
    keepAliveIntervalMs: 20_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    // تجاهل حالات الواتساب حتى لا نرى أخطاء status@broadcast
    shouldIgnoreJid: (jid) => jid === 'status@broadcast',
  });

  // احفظ الاعتماد
  sock.ev.on('creds.update', saveCreds);

  // معالجة ذاتية لمشاكل المفاتيح
  registerSelfHeal(sock, logger);

  // أعلام/مؤقتات
  let qrRotateTimer = null;

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      // أرسل QR إلى تيليجرام كصورة + تدوير كل 60s
      try {
        const png = await QRCode.toBuffer(qr, { width: 360, margin: 1 });
        if (telegram?.sendPhoto) await telegram.sendPhoto(png, { caption: 'Scan this WhatsApp QR within 1 minute' });
        else if (telegram?.sendQR) await telegram.sendQR(qr);

        if (qrRotateTimer) clearTimeout(qrRotateTimer);
        qrRotateTimer = setTimeout(async () => {
          logger.warn('QR expired — rotating for a fresh one.');
          try { await clearAuth(); } catch {}
          try { safeCloseSock(sock); } catch {}
          _sock = null;
          startWhatsApp({ telegram });
        }, 60_000);
      } catch (e) {
        logger.warn({ e: e.message }, 'Failed to render/send QR; sending raw text as fallback.');
        try { await telegram?.sendQR?.(qr); } catch {}
      }
    }

    if (connection === 'open') {
      logger.info('connected to WA');
      if (qrRotateTimer) { clearTimeout(qrRotateTimer); qrRotateTimer = null; }
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;
      logger.info({ code }, 'WA connection.close');

      try { safeCloseSock(sock); } catch {}
      _sock = null;

      if (code === 515) {
        logger.warn('Stream 515 — restarting socket without clearing auth.');
        setTimeout(() => startWhatsApp({ telegram }), 3000);
        return;
      }

      if (code === DisconnectReason.loggedOut || code === 401) {
        // ✅ إصلاح: أعد التشغيل دومًا بعد مسح الاعتماد (لا تعتمد على أي شرط)
        logger.warn('WA logged out — wiping & restarting soon to show a new QR.');
        await clearAuth();
        setTimeout(() => startWhatsApp({ telegram }), 2000);
        return;
      }

      setTimeout(() => startWhatsApp({ telegram }), 1500);
    }
  });

  // Echo اختياري وتجاهل fromMe
  if (ENABLE_WA_ECHO) {
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages || []) {
        if (m.key?.fromMe) continue;
        const jid  = m.key?.remoteJid;
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        if (jid && text) {
          try { await sock.sendMessage(jid, { text }); } catch (e) {
            logger.warn({ e: e?.message }, 'echo send failed');
          }
        }
      }
    });
  }

  return sock;
}

async function startWhatsApp({ telegram } = {}) {
  if (!MONGO_URI) throw new Error('MONGODB_URI required');
  await acquireLockOrExit();

  if (_sock) return _sock;
  _sock = await createSocket({ telegram });

  const shutdown = () => {
    logger.warn('SIGTERM/SIGINT: closing WA socket');
    safeCloseSock(_sock);
    _sock = null;
    releaseLock();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return _sock;
}

module.exports = { startWhatsApp };
