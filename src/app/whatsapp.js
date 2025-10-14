'use strict';

/**
 * WA socket with Mongo session + singleton lock + safe reconnects
 * - Lock لمنع تعدد المثيلات
 * - تهدئة + تدوير QR
 * - إلغاء أي مؤقّتات عند close لتفادي مسح الاعتماد بعد الاقتران
 * - تجاهل أي QR بعد أول اقتران ناجح
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

const MONGO_URI     = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY   = process.env.WA_LOCK_KEY || 'wa_lock_singleton';
const FORCE_FRESH   = String(process.env.WA_FORCE_FRESH || '0') === '1';
const QR_TO_CONSOLE = String(process.env.WA_QR_TO_CONSOLE || '0') === '1';

const QR_ROTATE_MS   = Number(process.env.WA_QR_ROTATE_MS   || 120_000); // 2 min
const QR_COOLDOWN_MS = Number(process.env.WA_QR_COOLDOWN_MS || 110_000); // ~2 min

let _lockMongoClient = null;
let _lockHeld = false;
let _lockHeartbeat = null;
let _sock = null;
let _starting = false;
let _freshClearedThisBoot = false;

// QR state
let _lastQrSentAt = 0;
let _pairedOk = false; // بعد أول اقتران ناجح نتجاهل أي QR لاحق

/* ------------------------------ Lock helpers ------------------------------ */

async function acquireLockOrExit() {
  if (!MONGO_URI) throw new Error('MONGODB_URI required');

  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  _lockMongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await _lockMongoClient.connect();
  const col = _lockMongoClient.db().collection('locks');

  const now = Date.now();
  const STALE_MS = 3 * 60 * 1000;

  const res = await col.updateOne(
    { _id: WA_LOCK_KEY, $or: [{ holderId }, { ts: { $lt: now - STALE_MS } }, { holderId: { $exists: false } }] },
    { $set: { holderId, ts: now } },
    { upsert: true }
  ).catch(e => {
    logger.warn({ e }, 'lock upsert race; continuing');
    return { matchedCount: 1 };
  });

  const matched = (res?.matchedCount || 0) + (res?.upsertedCount || 0);
  if (!matched) {
    const cur = await col.findOne({ _id: WA_LOCK_KEY });
    logger.warn({ currentHolder: cur?.holderId }, 'Another instance holds the WA lock. Exiting.');
    process.exit(0);
  }
  _lockHeld = true;
  logger.info({ holderId, key: WA_LOCK_KEY }, '✅ Acquired / refreshed WA singleton lock.');

  if (_lockHeartbeat) clearInterval(_lockHeartbeat);
  _lockHeartbeat = setInterval(async () => {
    try { await col.updateOne({ _id: WA_LOCK_KEY }, { $set: { ts: Date.now() } }); }
    catch (e) { logger.warn({ e: e?.message }, 'lock heartbeat failed'); }
  }, 30_000);
}

async function releaseLock() {
  try {
    if (_lockHeartbeat) { clearInterval(_lockHeartbeat); _lockHeartbeat = null; }
    if (_lockHeld) {
      await _lockMongoClient?.db()?.collection('locks')?.deleteOne?.({ _id: WA_LOCK_KEY });
      _lockHeld = false;
    }
  } catch {}
}

/* ------------------------------ Utils ------------------------------ */

function safeCloseSock(s) {
  try { s?.end?.(); } catch {}
  try { s?.ws?.close?.(); } catch {}
}

async function sendQrToTelegram({ telegram, qr, png }) {
  const caption = 'Scan this WhatsApp QR within 2 minutes';

  if (telegram?.sendPhoto) {
    try {
      await telegram.sendPhoto(png, { caption, filename: 'qr.png' });
      return true;
    } catch (e) { logger.warn({ e: e?.message }, 'sendPhoto failed'); }
  }
  if (telegram?.sendQR) {
    try { await telegram.sendQR(qr); return true; }
    catch (e) { logger.warn({ e: e?.message }, 'sendQR failed'); }
  }
  if (telegram?.sendText) {
    try {
      await telegram.sendText(`*WhatsApp QR*\n\`\`\`\n${qr}\n\`\`\`\n(Valid ~2 minutes)`);
      return true;
    } catch (e) { logger.warn({ e: e?.message }, 'sendText failed'); }
  }
  if (QR_TO_CONSOLE || !telegram) logger.info({ qr }, 'QR (fallback)');
  return false;
}

/* ------------------------------ Core ------------------------------ */

async function createSocket({ telegram }) {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds, clearAuth } = await mongoAuthState(logger);

  if (FORCE_FRESH && !_freshClearedThisBoot) {
    logger.warn('WA_FORCE_FRESH=1 — clearing auth on boot to force QR.');
    await clearAuth();
    _freshClearedThisBoot = true;
    _pairedOk = false;
  }

  const sock = makeWASocket({
    version,
    printQRInTerminal: QR_TO_CONSOLE,
    auth: state,
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 20_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
  });

  // عندما تتحدّث الاعتمادات وفيها me/registered نعتبره اقتران ناجح
  sock.ev.on('creds.update', (creds) => {
    try {
      if (creds?.me || creds?.registered) {
        _pairedOk = true;
        logger.info({ me: creds?.me }, '🔐 creds updated — pairing considered complete');
      }
    } catch {}
    saveCreds(creds);
  });

  registerSelfHeal(sock, logger);

  let awaitingPairing = false;
  let restartTimer = null;
  let qrRotateTimer = null;

  const clearTimers = () => {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (qrRotateTimer) { clearTimeout(qrRotateTimer); qrRotateTimer = null; }
  };

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    // لا ترسل QR إن كنا مقترنين بالفعل
    if (qr && !_pairedOk) {
      const now = Date.now();
      if (now - _lastQrSentAt >= QR_COOLDOWN_MS) {
        try {
          const png = await QRCode.toBuffer(qr, { width: 360, margin: 1 });
          await sendQrToTelegram({ telegram, qr, png });
          awaitingPairing = true;
          _lastQrSentAt = now;
        } catch (e) {
          logger.warn({ e: e.message }, 'Failed to render QR; sending raw fallback.');
          await sendQrToTelegram({ telegram, qr, png: null });
          awaitingPairing = true;
          _lastQrSentAt = now;
        }
      } else {
        logger.info({ sinceMs: now - _lastQrSentAt }, 'QR throttled — duplicate ignored');
      }

      // دوّر الـQR بعد المهلة، لكن **لا تمسح الاعتماد** إطلاقًا
      if (qrRotateTimer) clearTimeout(qrRotateTimer);
      qrRotateTimer = setTimeout(async () => {
        if (awaitingPairing && !_pairedOk) {
          logger.warn('QR expired — rotating after timeout (no clear).');
          try { safeCloseSock(sock); } catch {}
          _sock = null;
          startWhatsApp({ telegram });
        }
      }, QR_ROTATE_MS);
    }

    if (connection === 'open') {
      logger.info('✅ WhatsApp connected.');
      _pairedOk = true;           // اعتبره تم
      awaitingPairing = false;
      clearTimers();
    }

    if (connection === 'close') {
      const code =
        (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;

      // مهم جدًا: أوقف مؤقّت تدوير QR وإلّا يمسح الاعتماد بعد الاقتران
      clearTimers();
      awaitingPairing = false;

      logger.warn({ code }, '⚠️ WA connection closed.');
      try { safeCloseSock(sock); } catch {}
      _sock = null;

      if (code === 440) {
        logger.warn('Stream conflict detected — delaying reconnect 20s.');
        setTimeout(() => startWhatsApp({ telegram }), 20_000);
        return;
      }
      if (code === 515) {
        // إعادة تشغيل متوقعة بعد pairing — لا نمسح الاعتماد إطلاقًا
        logger.warn('Stream 515 — restarting socket (no clear).');
        setTimeout(() => startWhatsApp({ telegram }), 3_000);
        return;
      }
      if (code === DisconnectReason.loggedOut || code === 401) {
        logger.warn('Logged out — clearing auth & waiting 90s for QR pairing.');
        await clearAuth();
        restartTimer = setTimeout(() => {
          if (!_pairedOk) startWhatsApp({ telegram });
        }, 90_000);
        return;
      }

      setTimeout(() => startWhatsApp({ telegram }), 3_000);
    }
  });

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
