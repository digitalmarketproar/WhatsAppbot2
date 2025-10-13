'use strict';

/**
 * إدارة اتصال واتساب باستخدام Baileys مع تخزين جلسة على MongoDB
 * - قفل Singleton عبر Mongo لمنع تعدد المثيلات
 * - إرسال QR لتليجرام عند الحاجة
 * - ربط مستمع الرسائل الرسمي لكل سوكِت جديد (منع فقدان المستمع بعد إعادة الاتصال)
 * - إزالة أي Echo handlers لمنع اللوب
 */

const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const { MongoClient }  = require('mongodb');
const QRCode           = require('qrcode');

const logger                 = require('../lib/logger');
const { mongoAuthState }     = require('../lib/wa-mongo-auth');
const { registerSelfHeal }   = require('../lib/selfheal');
const { onMessageUpsert }    = require('../handlers/messages');

const MONGO_URI        = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY      = process.env.WA_LOCK_KEY || 'wa_lock_singleton';

let _lockMongoClient = null;
let _lockHeld = false;
let _sock = null;
let _starting = false;

async function acquireLockOrExit() {
  if (!MONGO_URI) throw new Error('MONGODB_URI required');

  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  _lockMongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await _lockMongoClient.connect();
  const col = _lockMongoClient.db().collection('locks');

  const now = Date.now();
  const STALE_MS = 3 * 60 * 1000; // 3 دقائق

  // لو القفل لنفس الحامل/قديم/بدون حامل — حدّثه، غير ذلك اخرج بهدوء
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
  try {
    await _lockMongoClient.db().collection('locks').deleteOne({ _id: WA_LOCK_KEY });
  } catch {}
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
    printQRInTerminal: false, // سنرسل QR لتليجرام كصورة
    auth: state,
    logger,
    syncFullHistory: false,
    keepAliveIntervalMs: 20_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
  });

  sock.ev.on('creds.update', saveCreds);
  registerSelfHeal(sock, logger);

  // أعلام/مؤقتات
  let awaitingPairing = false;
  let restartTimer = null;
  let qrRotateTimer = null;

  // اربط مستمع الرسائل على هذا السوكت (وحده فقط)
  try { sock.ev.removeAllListeners('messages.upsert'); } catch {}
  sock.ev.on('messages.upsert', onMessageUpsert(sock));

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      // QR جديد — أرسله لتليجرام
      try {
        const png = await QRCode.toBuffer(qr, { width: 360, margin: 1 });
        if (telegram?.sendPhoto) {
          await telegram.sendPhoto(png, { caption: 'Scan this WhatsApp QR within 1 minute' });
        } else if (telegram?.sendQR) {
          await telegram.sendQR(qr);
        }
        awaitingPairing = true;

        // تدوير QR كل 60 ثانية (بدون إنشاء سوكِت ثانٍ بالتزامن)
        if (qrRotateTimer) clearTimeout(qrRotateTimer);
        qrRotateTimer = setTimeout(async () => {
          if (awaitingPairing) {
            logger.warn('QR expired — rotating for a fresh one.');
            try { await clearAuth(); } catch {}
            try { safeCloseSock(sock); } catch {}
            if (_sock === sock) _sock = null;
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
            if (_sock === sock) _sock = null;
            startWhatsApp({ telegram });
          }
        }, 60_000);
      }
    }

    if (connection === 'open') {
      logger.info('connected to WA');
      awaitingPairing = false;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (qrRotateTimer) { clearTimeout(qrRotateTimer); qrRotateTimer = null; }
    }

    if (connection === 'close') {
      const code =
        (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;
      logger.info({ code }, 'WA connection.close');

      try { safeCloseSock(sock); } catch {}
      if (_sock === sock) _sock = null;

      // 440/“replaced”: تم استبدالنا باتصال آخر — انتظر لحظات ثم أعد المحاولة
      if (code === 440) {
        logger.warn('Stream conflict (replaced). Delaying reconnect to avoid race.');
        setTimeout(() => startWhatsApp({ telegram }), 5_000);
        return;
      }

      if (code === 515) {
        // إعادة تشغيل تيار بدون مسح اعتماد
        logger.warn('Stream 515 — restarting socket without clearing auth.');
        setTimeout(() => startWhatsApp({ telegram }), 3_000);
        return;
      }

      if (code === DisconnectReason.loggedOut || code === 401) {
        // تسجيل خروج حقيقي — نمسح الاعتماد ونمنح نافذة لمسح QR
        logger.warn('WA logged out — wiping. Waiting 90s to allow QR scan before restart.');
        await clearAuth();

        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          if (awaitingPairing) startWhatsApp({ telegram });
        }, 90_000);
        return;
      }

      // أخطاء أخرى: إعادة محاولة
      setTimeout(() => startWhatsApp({ telegram }), 1_500);
    }
  });

  return sock;
}

async function startWhatsApp({ telegram } = {}) {
  if (_starting) return _sock;
  _starting = true;

  await acquireLockOrExit();

  if (_sock) { _starting = false; return _sock; }
  _sock = await createSocket({ telegram });
  _starting = false;

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
