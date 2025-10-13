'use strict';

/**
 * WA socket with Mongo session + singleton lock + safe reconnects
 * - Prevent multiple sockets
 * - Delay on 440 conflict
 * - One messages.upsert handler bound per socket
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
let _holderId = null;

async function acquireLockOrExit() {
  if (!MONGO_URI) throw new Error('MONGODB_URI required');

  _holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  _lockMongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await _lockMongoClient.connect();
  const col = _lockMongoClient.db().collection('locks');

  const now = Date.now();
  const STALE_MS = 3 * 60 * 1000; // 3 دقائق

  // 1) جرّب تحديث القفل إن كان لنا أو قديم — بدون upsert (لتجنب E11000)
  const cond = {
    _id: WA_LOCK_KEY,
    $or: [
      { holderId: _holderId },
      { ts: { $lt: now - STALE_MS } },
      { holderId: { $exists: false } }
    ]
  };

  const res = await col.updateOne(cond, { $set: { holderId: _holderId, ts: now } });
  if (res.matchedCount === 1) {
    _lockHeld = true;
    logger.info({ holderId: _holderId, key: WA_LOCK_KEY }, '✅ Acquired / refreshed WA singleton lock.');
  } else {
    // 2) لا يوجد تطابق — افحص القفل الحالي
    const doc = await col.findOne({ _id: WA_LOCK_KEY });
    if (doc && doc.holderId && doc.ts && doc.ts >= now - STALE_MS && doc.holderId !== _holderId) {
      // قفل نشط لشخص آخر — اخرج بهدوء
      logger.warn({ currentHolder: doc.holderId }, 'Another instance holds the WA lock. Exiting.');
      process.exit(0);
    }

    // 3) إمّا القفل غير موجود، أو قديم — خذه بـ upsert لكن بدون $or لتفادي E11000
    await col.updateOne(
      { _id: WA_LOCK_KEY },
      { $set: { holderId: _holderId, ts: now } },
      { upsert: true }
    );

    _lockHeld = true;
    logger.info({ holderId: _holderId, key: WA_LOCK_KEY }, '✅ Acquired / refreshed WA singleton lock.');
  }

  // heartbeat لتحديث الطابع الزمني
  if (_lockHeartbeat) clearInterval(_lockHeartbeat);
  _lockHeartbeat = setInterval(async () => {
    try {
      await col.updateOne({ _id: WA_LOCK_KEY, holderId: _holderId }, { $set: { ts: Date.now() } });
    } catch (e) {
      logger.warn({ e: e?.message }, 'lock heartbeat failed');
    }
  }, 30_000);
}

async function releaseLock() {
  try {
    if (_lockHeartbeat) { clearInterval(_lockHeartbeat); _lockHeartbeat = null; }
    if (_lockHeld) {
      await _lockMongoClient?.db()?.collection('locks')?.deleteOne?.({ _id: WA_LOCK_KEY, holderId: _holderId });
      _lockHeld = false;
    }
  } catch {}
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
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 20_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
  });

  sock.ev.on('creds.update', saveCreds);
  registerSelfHeal(sock, logger);

  let awaitingPairing = false;
  let restartTimer = null;
  let qrRotateTimer = null;

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      try {
        const png = await QRCode.toBuffer(qr, { width: 360, margin: 1 });
        if (telegram?.sendPhoto) {
          await telegram.sendPhoto(png, { caption: 'Scan this WhatsApp QR within 1 minute' });
        } else if (telegram?.sendQR) {
          await telegram.sendQR(qr);
        }
        awaitingPairing = true;

        if (qrRotateTimer) clearTimeout(qrRotateTimer);
        qrRotateTimer = setTimeout(async () => {
          if (awaitingPairing) {
            logger.warn('QR expired — rotating for a fresh one.');
            try { await clearAuth(); } catch {}
            try { safeCloseSock(sock); } catch {}
            _sock = null;
            startWhatsApp({ telegram });
          }
        }, 60_000);
      } catch (e) {
        logger.warn({ e: e.message }, 'Failed to render/send QR; sending raw text as fallback.');
        try { await telegram?.sendQR?.(qr); } catch {}
        awaitingPairing = true;

        if (qrRotateTimer) clearTimeout(qrRotateTimer);
        qrRotateTimer = setTimeout(async () => {
          if (awaitingPairing) {
            logger.warn('QR expired — rotating after fallback text.');
            try { await clearAuth(); } catch {}
            try { safeCloseSock(sock); } catch {}
            _sock = null;
            startWhatsApp({ telegram });
          }
        }, 60_000);
      }
    }

    if (connection === 'open') {
      logger.info('✅ WhatsApp connected.');
      awaitingPairing = false;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (qrRotateTimer) { clearTimeout(qrRotateTimer); qrRotateTimer = null; }
    }

    if (connection === 'close') {
      const code =
        (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;
      logger.warn({ code }, '⚠️ WA connection closed.');

      try { safeCloseSock(sock); } catch {}
      _sock = null;

      if (code === 440) {
        logger.warn('Stream conflict detected — delaying reconnect 20s.');
        setTimeout(() => startWhatsApp({ telegram }), 20_000);
        return;
      }
      if (code === 515) {
        logger.warn('Stream 515 — restarting socket without clearing auth.');
        setTimeout(() => startWhatsApp({ telegram }), 3000);
        return;
      }
      if (code === DisconnectReason.loggedOut || code === 401) {
        logger.warn('WA logged out — wiping. Waiting 90s for QR scan before restart.');
        await clearAuth();
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          if (awaitingPairing) startWhatsApp({ telegram });
        }, 90_000);
        return;
      }
      setTimeout(() => startWhatsApp({ telegram }), 3000);
    }
  });

  // messages.upsert — اربطه لسوكت واحد فقط
  try { sock.ev.removeAllListeners('messages.upsert'); } catch {}
  sock.ev.on('messages.upsert', onMessageUpsert(sock));

  return sock;
}

async function startWhatsApp({ telegram } = {}) {
  if (_starting) return _sock;
  _starting = true;
  try {
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
  } finally {
    _starting = false;
  }
}

module.exports = { startWhatsApp };
