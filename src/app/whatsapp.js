'use strict';

/**
 * WA socket with Mongo session + singleton lock + safe reconnects
 * - يمنع تعدد المثيلات عبر Lock في Mongo
 * - يتعامل مع 440 (conflict) بتأخير محاولة الاتصال
 * - يربط messages.upsert على سوكت واحد
 * - يدعم WA_FORCE_FRESH=1 لمسح الجلسة عند الإقلاع لإجبار QR (مرة واحدة فقط)
 * - إرسال الـQR إلى تيليجرام بطرق متعددة + طباعة احتياطية في اللوج
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

let _lockMongoClient = null;
let _lockHeld = false;
let _lockHeartbeat = null;
let _sock = null;
let _starting = false;
let _freshClearedThisBoot = false;

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
  const caption = 'Scan this WhatsApp QR within 1 minute';

  // 1) حاول صورة (لو عندك رابر يضيف chatId داخليًا)
  if (telegram?.sendPhoto) {
    try {
      await telegram.sendPhoto(png, { caption });
      return true;
    } catch (e) {
      logger.warn({ e: e?.message }, 'sendPhoto failed');
    }
  }

  // 2) حاول واجهة خاصة لإرسال QR كنص
  if (telegram?.sendQR) {
    try {
      await telegram.sendQR(qr);
      return true;
    } catch (e) {
      logger.warn({ e: e?.message }, 'sendQR failed');
    }
  }

  // 3) حاول sendText (لو متاحة)
  if (telegram?.sendText) {
    try {
      await telegram.sendText(`*WhatsApp QR*\n\`\`\`\n${qr}\n\`\`\``);
      return true;
    } catch (e) {
      logger.warn({ e: e?.message }, 'sendText failed');
    }
  }

  // 4) اطبع في اللوج كحل أخير (وركّب WA_QR_TO_CONSOLE=1 لو تحب دائمًا)
  if (QR_TO_CONSOLE || !telegram) {
    logger.info({ qr }, 'QR (fallback)');
  }

  return false;
}

/* ------------------------------ Core ------------------------------ */

async function createSocket({ telegram }) {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds, clearAuth } = await mongoAuthState(logger);

  // FORCE_FRESH مرة واحدة فقط عند هذا البوت-أب
  if (FORCE_FRESH && !_freshClearedThisBoot) {
    logger.warn('WA_FORCE_FRESH=1 — clearing auth on boot to force QR.');
    await clearAuth();
    _freshClearedThisBoot = true;
  }

  const sock = makeWASocket({
    version,
    printQRInTerminal: QR_TO_CONSOLE, // ممكن تفعّله من env كنسخة احتياطية
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
        const ok = await sendQrToTelegram({ telegram, qr, png });
        if (!ok) logger.warn('QR could not be delivered to Telegram; fallback(s) used.');
        awaitingPairing = true;

        if (qrRotateTimer) clearTimeout(qrRotateTimer);
        qrRotateTimer = setTimeout(async () => {
          if (awaitingPairing) {
            logger.warn('QR expired — rotating.');
            try { await clearAuth(); } catch {}
            try { safeCloseSock(sock); } catch {}
            _sock = null;
            startWhatsApp({ telegram });
          }
        }, 60_000);
      } catch (e) {
        logger.warn({ e: e.message }, 'Failed to render QR buffer; sending raw as fallback.');
        await sendQrToTelegram({ telegram, qr, png: null });
        awaitingPairing = true;
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
        logger.warn('Stream 515 — restarting socket (no clear).');
        setTimeout(() => startWhatsApp({ telegram }), 3_000);
        return;
      }
      if (code === DisconnectReason.loggedOut || code === 401) {
        logger.warn('Logged out — clearing auth & waiting 90s for QR pairing.');
        await clearAuth();
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          if (awaitingPairing) startWhatsApp({ telegram });
        }, 90_000);
        return;
      }
      setTimeout(() => startWhatsApp({ telegram }), 3_000);
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
