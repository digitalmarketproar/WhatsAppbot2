'use strict';

/**
 * WhatsApp socket manager with Mongo session, singleton lock & safe reconnects
 * - Prevent multiple instances (Render-safe)
 * - Handles stream conflict (440) with delay
 * - Cleans up gracefully on SIGTERM
 * - Binds only one messages.upsert handler per socket
 */

const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const { MongoClient }  = require('mongodb');
const QRCode           = require('qrcode');

const logger               = require('../lib/logger');
const { mongoAuthState }   = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');
const { onMessageUpsert }  = require('../handlers/messages');

const MONGO_URI   = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY = process.env.WA_LOCK_KEY || 'wa_lock_singleton';

let _lockMongoClient = null;
let _lockHeld = false;
let _lockHeartbeat = null;
let _sock = null;
let _starting = false;

// ---------------- LOCK SYSTEM ----------------
async function acquireLockOrExit() {
  if (!MONGO_URI) throw new Error('MONGODB_URI required');

  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  _lockMongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await _lockMongoClient.connect();
  const col = _lockMongoClient.db().collection('locks');

  const now = Date.now();
  const STALE_MS = 3 * 60 * 1000; // 3 minutes

  const res = await col.updateOne(
    { _id: WA_LOCK_KEY, $or: [{ holderId }, { ts: { $lt: now - STALE_MS } }, { holderId: { $exists: false } }] },
    { $set: { holderId, ts: now } },
    { upsert: true }
  );

  if (!res.matchedCount && !res.upsertedCount) {
    logger.warn('Another instance already holds WA lock. Exiting to avoid duplicate socket.');
    process.exit(0);
  }

  _lockHeld = true;
  logger.info({ holderId, key: WA_LOCK_KEY }, '✅ Acquired / refreshed WA singleton lock.');

  if (_lockHeartbeat) clearInterval(_lockHeartbeat);
  _lockHeartbeat = setInterval(async () => {
    try {
      await col.updateOne({ _id: WA_LOCK_KEY }, { $set: { ts: Date.now() } });
    } catch (e) {
      logger.warn({ e: e?.message }, 'Lock heartbeat failed.');
    }
  }, 30_000);
}

async function releaseLock() {
  try {
    if (_lockHeartbeat) { clearInterval(_lockHeartbeat); _lockHeartbeat = null; }
    if (_lockHeld) {
      await _lockMongoClient?.db()?.collection('locks')?.deleteOne?.({ _id: WA_LOCK_KEY });
      _lockHeld = false;
      logger.info('Released MongoDB singleton lock.');
    }
  } catch (e) {
    logger.warn({ e: e?.message }, 'Failed to release lock cleanly.');
  }
}

// ---------------- SOCKET HELPERS ----------------
function safeCloseSock(s) {
  try { s?.end?.(); } catch {}
  try { s?.ws?.close?.(); } catch {}
}

// ---------------- MAIN SOCKET CREATION ----------------
async function createSocket({ telegram }) {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds, clearAuth } = await mongoAuthState(logger);

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 20_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
  });

  sock.ev.on('creds.update', saveCreds);
  registerSelfHeal(sock, logger);

  let awaitingPairing = false;
  let qrRotateTimer = null;
  let reconnectTimer = null;

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      try {
        const png = await QRCode.toBuffer(qr, { width: 360, margin: 1 });
        if (telegram?.sendPhoto) {
          await telegram.sendPhoto(png, { caption: '📱 Scan this WhatsApp QR within 1 minute' });
        } else if (telegram?.sendQR) {
          await telegram.sendQR(qr);
        }
        awaitingPairing = true;
        if (qrRotateTimer) clearTimeout(qrRotateTimer);
        qrRotateTimer = setTimeout(async () => {
          if (awaitingPairing) {
            logger.warn('QR expired — rotating.');
            await clearAuth().catch(() => {});
            safeCloseSock(sock);
            _sock = null;
            startWhatsApp({ telegram });
          }
        }, 60_000);
      } catch (err) {
        logger.warn({ err: err.message }, 'QR send failed.');
      }
    }

    if (connection === 'open') {
      logger.info('✅ WhatsApp connected.');
      awaitingPairing = false;
      if (qrRotateTimer) clearTimeout(qrRotateTimer);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.status || 0;
      logger.warn({ code }, '⚠️ WA connection closed.');

      safeCloseSock(sock);
      _sock = null;

      if (reconnectTimer) clearTimeout(reconnectTimer);

      // --- conflict (duplicate socket)
      if (code === 440 || /conflict/i.test(lastDisconnect?.error?.message || '')) {
        logger.warn('Stream conflict detected — delaying reconnect 20s.');
        reconnectTimer = setTimeout(() => startWhatsApp({ telegram }), 20_000);
        return;
      }

      // --- temporary 515 error
      if (code === 515) {
        logger.warn('Stream 515 — restarting socket (no auth clear).');
        reconnectTimer = setTimeout(() => startWhatsApp({ telegram }), 5_000);
        return;
      }

      // --- logged out
      if (code === DisconnectReason.loggedOut || code === 401) {
        logger.warn('Logged out — clearing session. Waiting 90s for QR.');
        await clearAuth();
        reconnectTimer = setTimeout(() => startWhatsApp({ telegram }), 90_000);
        return;
      }

      // --- generic close
      reconnectTimer = setTimeout(() => startWhatsApp({ telegram }), 5_000);
    }
  });

  // ensure one handler only
  sock.ev.removeAllListeners('messages.upsert');
  sock.ev.on('messages.upsert', onMessageUpsert(sock));

  return sock;
}

// ---------------- STARTUP LOGIC ----------------
async function startWhatsApp({ telegram } = {}) {
  if (_starting) return _sock;
  _starting = true;
  try {
    await acquireLockOrExit();
    if (_sock) return _sock;

    _sock = await createSocket({ telegram });

    const shutdown = async () => {
      logger.warn('Graceful shutdown: closing WA socket.');
      safeCloseSock(_sock);
      _sock = null;
      await releaseLock();
      process.exit(0);
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return _sock;
  } catch (e) {
    logger.error({ e, stack: e?.stack }, 'startWhatsApp failed.');
    process.exit(1);
  } finally {
    _starting = false;
  }
}

module.exports = { startWhatsApp };
