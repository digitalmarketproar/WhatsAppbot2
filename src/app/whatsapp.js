'use strict';

/**
 * WA socket with Mongo session + singleton lock + safe reconnects
 * - Waits for Mongo lock instead of exiting (handles Render blue/green deploy)
 * - Adds TTL index on lock to auto-expire stale holders
 * - Binds exactly one messages.upsert per socket
 * - Handles 440 (replaced) with delayed reconnect
 */

const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const { MongoClient } = require('mongodb');
const QRCode          = require('qrcode');

const logger               = require('../lib/logger');
const { mongoAuthState }   = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');
const { onMessageUpsert }  = require('../handlers/messages');

const MONGO_URI   = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY = process.env.WA_LOCK_KEY || 'wa_lock_singleton';

// ===== Singleton state =====
let _lockMongoClient = null;
let _locksCol = null;
let _lockHeld = false;
let _lockHeartbeat = null;

let _sock = null;
let _starting = false;

// ===== Lock helpers =====
async function ensureMongo() {
  if (_lockMongoClient) return;
  if (!MONGO_URI) throw new Error('MONGODB_URI required for WA lock');

  // قلل عدد الاتصالات لتجنّب تجاوز حد M0
  _lockMongoClient = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 3,
    minPoolSize: 0,
  });
  await _lockMongoClient.connect();
  _locksCol = _lockMongoClient.db().collection('locks');

  // أنشئ فهرس TTL يزيل الأقفال القديمة تلقائيًا (3 دقائق)
  try {
    await _locksCol.createIndex({ ts: 1 }, { expireAfterSeconds: 180 });
  } catch (e) {
    logger.warn({ e: e?.message }, 'failed to ensure TTL index on locks');
  }
}

async function acquireLockWithWait() {
  await ensureMongo();

  const holderId =
    process.env.WA_LOCK_HOLDER ||
    process.env.RENDER_INSTANCE_ID ||
    process.env.HOSTNAME ||
    String(process.pid);

  const STALE_MS = 3 * 60 * 1000; // 3 دقائق
  const RETRY_MS = 5000;          // 5 ثوانٍ

  // حلقة انتظار حتى يتحرر القفل (بدل الخروج من العملية)
  // هذا يسمح للنشر على Render بأن يمر بلا سباق بين النسخ.
  // ملاحظة: وثّقنا holderId ليسهل تتبع من يحمل القفل.
  // الشرط: خذه إن كان نفس الحامل، أو قديم، أو بلا حامل.
  // إن فشل — انتظر وجرّب مجددًا.
  /* eslint no-constant-condition: "off" */
  while (true) {
    const now = Date.now();
    try {
      const res = await _locksCol.updateOne(
        {
          _id: WA_LOCK_KEY,
          $or: [
            { holderId },
            { ts: { $lt: now - STALE_MS } },
            { holderId: { $exists: false } }
          ]
        },
        { $set: { holderId, ts: now } },
        { upsert: true }
      );

      // نجحنا إذا كان هناك upsert أو تمّت المطابقة/التعديل
      if ((res.upsertedCount || 0) > 0 || res.matchedCount > 0 || res.modifiedCount > 0) {
        _lockHeld = true;
        logger.info({ holderId, key: WA_LOCK_KEY }, '✅ Acquired / refreshed WA singleton lock.');
        break;
      }

      // فشل الاستحواذ — اجلب من يحمل القفل لمعلومة فقط ثم انتظر
      const doc = await _locksCol.findOne({ _id: WA_LOCK_KEY }).catch(() => null);
      const currentHolder = doc?.holderId || 'unknown';
      logger.warn({ currentHolder }, 'Another instance holds the WA lock. Waiting to retry…');
      await new Promise(r => setTimeout(r, RETRY_MS));
    } catch (e) {
      // احتمال سباق نادر: duplicate key — انتظر وأعد المحاولة
      if (e?.code === 11000) {
        logger.warn('Duplicate key on lock upsert (race). Retrying…');
        await new Promise(r => setTimeout(r, RETRY_MS));
        continue;
      }
      throw e;
    }
  }

  // نبقي القفل حيًا
  if (_lockHeartbeat) clearInterval(_lockHeartbeat);
  _lockHeartbeat = setInterval(async () => {
    try {
      await _locksCol.updateOne({ _id: WA_LOCK_KEY }, { $set: { ts: Date.now() } });
    } catch (e) {
      logger.warn({ e: e?.message }, 'lock heartbeat failed');
    }
  }, 30_000);
}

async function releaseLock() {
  try {
    if (_lockHeartbeat) { clearInterval(_lockHeartbeat); _lockHeartbeat = null; }
    if (_lockHeld && _locksCol) {
      await _locksCol.deleteOne({ _id: WA_LOCK_KEY }).catch(() => {});
      _lockHeld = false;
    }
  } catch {}
}

// ===== Socket helpers =====
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

      // 440 = replaced (conflict)
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
        logger.warn('WA logged out — wiping. Waiting 90s to allow QR scan before restart.');
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

  // Ensure single messages.upsert listener
  try { sock.ev.removeAllListeners('messages.upsert'); } catch {}
  sock.ev.on('messages.upsert', onMessageUpsert(sock));

  return sock;
}

// ===== Public API =====
async function startWhatsApp({ telegram } = {}) {
  if (_starting) return _sock;
  _starting = true;
  try {
    await acquireLockWithWait();  // ← لا نخرج؛ ننتظر حتى يتوفر القفل
    if (_sock) return _sock;

    _sock = await createSocket({ telegram });

    const shutdown = async () => {
      logger.warn('SIGTERM/SIGINT: closing WA socket & releasing lock');
      try { safeCloseSock(_sock); } catch {}
      _sock = null;
      await releaseLock();
      try { await _lockMongoClient?.close?.(); } catch {}
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return _sock;
  } finally {
    _starting = false;
  }
}

module.exports = { startWhatsApp };
