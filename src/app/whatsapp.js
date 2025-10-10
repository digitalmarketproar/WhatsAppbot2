// src/app/whatsapp.js
'use strict';

const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { MongoClient }  = require('mongodb');
const mongoose         = require('mongoose'); // compatibility
const NodeCache        = require('node-cache'); // compatibility
const QRCode           = require('qrcode');

const logger               = require('../lib/logger');
const { mongoAuthState }   = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

const MONGO_URI    = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY  = process.env.WA_LOCK_KEY || 'wa_lock_singleton';
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';

// --- process-wide guards to avoid duplicate boots/restarts ---
let _lockMongoClient = null;
let _lockHeld = false;
let _sock = null;
let _booting = false;
let _bootPromise = null;
let _restartToken = 0;

let _qrRotateTimer = null;
let _restartTimer  = null;

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

function clearTimers() {
  if (_qrRotateTimer) { clearTimeout(_qrRotateTimer); _qrRotateTimer = null; }
  if (_restartTimer)  { clearTimeout(_restartTimer); _restartTimer  = null; }
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
    // Ignore status broadcast to avoid decrypt noise
    shouldIgnoreJid: (jid) => jid === 'status@broadcast',
  });

  sock.ev.on('creds.update', saveCreds);
  registerSelfHeal(sock, logger);

  let rotatingQR = false; // prevent concurrent QR rotations

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    // ---- QR handling ----
    if (qr && !rotatingQR) {
      try {
        const png = await QRCode.toBuffer(qr, { width: 360, margin: 1 });
        if (telegram?.sendPhoto) await telegram.sendPhoto(png, { caption: 'Scan this WhatsApp QR within 1 minute' });
        else if (telegram?.sendQR) await telegram.sendQR(qr);
      } catch (e) {
        logger.warn({ e: e.message }, 'Failed to render/send QR; sending raw text as fallback.');
        try { await telegram?.sendQR?.(qr); } catch {}
      }

      // rotate once per minute until paired
      if (_qrRotateTimer) clearTimeout(_qrRotateTimer);
      _qrRotateTimer = setTimeout(async () => {
        if (rotatingQR) return;
        rotatingQR = true;
        logger.warn('QR expired — rotating for a fresh one.');
        try { await clearAuth(); } catch {}
        try { safeCloseSock(sock); } catch {}
        _sock = null;
        const token = ++_restartToken;
        setTimeout(() => {
          if (token === _restartToken) startWhatsApp({ telegram }).catch(() => {});
          rotatingQR = false;
        }, 500);
      }, 60_000);
    }

    if (connection === 'open') {
      logger.info('connected to WA');
      clearTimers();
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;
      logger.info({ code }, 'WA connection.close');

      clearTimers();
      try { safeCloseSock(sock); } catch {}
      _sock = null;

      const token = ++_restartToken;

      if (code === 515) {
        logger.warn('Stream 515 — restarting socket without clearing auth.');
        _restartTimer = setTimeout(() => {
          if (token === _restartToken) startWhatsApp({ telegram }).catch(() => {});
        }, 2000);
        return;
      }

      if (code === DisconnectReason.loggedOut || code === 401) {
        logger.warn('WA logged out — wiping & restarting to show a new QR.');
        await clearAuth();
        _restartTimer = setTimeout(() => {
          if (token === _restartToken) startWhatsApp({ telegram }).catch(() => {});
        }, 1500);
        return;
      }

      _restartTimer = setTimeout(() => {
        if (token === _restartToken) startWhatsApp({ telegram }).catch(() => {});
      }, 1500);
    }
  });

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

  // prevent double boots
  if (_booting && _bootPromise) return _bootPromise;
  _booting = true;
  _bootPromise = (async () => {
    await acquireLockOrExit();
    if (_sock) return _sock;
    _sock = await createSocket({ telegram });

    const shutdown = () => {
      logger.warn('SIGTERM/SIGINT: closing WA socket');
      clearTimers();
      safeCloseSock(_sock);
      _sock = null;
      releaseLock();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return _sock;
  })();

  try {
    const s = await _bootPromise;
    return s;
  } finally {
    _booting = false;
  }
}

module.exports = { startWhatsApp };
