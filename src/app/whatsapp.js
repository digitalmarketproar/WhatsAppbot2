'use strict';

/**
 * WhatsApp (Baileys) + Mongo Session + Singleton Lock
 * ---------------------------------------------------
 * - اتصال واحد فقط عبر قفل في Mongo (locks)
 * - إعادة اتصال آمنة، وتأخير في حالة 440 (conflict)
 * - مستمع messages.upsert مربوط مرة واحدة لكل سوكِت
 * - إرسال QR إلى تيليجرام إذا توفر كائن telegram أو متغيرات البيئة
 */

const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const { MongoClient } = require('mongodb');
const QRCode = require('qrcode');

const logger                 = require('../lib/logger');
const { mongoAuthState }     = require('../lib/wa-mongo-auth');
const { registerSelfHeal }   = require('../lib/selfheal');
const { onMessageUpsert }    = require('../handlers/messages');

const MONGO_URI   = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY = process.env.WA_LOCK_KEY || 'wa_lock_singleton';

// اختياري: لو أردت إرسال الـ QR عبر Telegram بدون تمرير كائن telegram من الخارج
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_ADMIN = process.env.TELEGRAM_ADMIN_ID || '';

let _lockMongoClient = null;
let _lockHeld = false;
let _lockTicker = null;
let _sock = null;
let _starting = false;

// ------- أدوات مساعدة -------

async function getMongoClient() {
  if (!_lockMongoClient || !_lockMongoClient.topology?.isConnected?.()) {
    _lockMongoClient = new MongoClient(MONGO_URI, {
      maxPoolSize: Number(process.env.MAX_POOL_SIZE || 5),
      serverSelectionTimeoutMS: 8000,
    });
    await _lockMongoClient.connect();
  }
  return _lockMongoClient;
}

function scheduleProcessCleanup() {
  if (scheduleProcessCleanup._wired) return;
  scheduleProcessCleanup._wired = true;
  const close = async () => {
    try { await _lockMongoClient?.close?.(); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function safeCloseSock(s) {
  try { s?.end?.(); } catch {}
  try { s?.ws?.close?.(); } catch {}
}

async function sendQRToTelegram({ pngBuffer, rawQR, telegram }) {
  try {
    if (telegram?.sendPhoto) {
      await telegram.sendPhoto(pngBuffer, { caption: 'Scan this WhatsApp QR within 1 minute' });
      return;
    }
  } catch (e) {
    logger.warn({ e: e?.message }, 'sendPhoto via passed telegram object failed');
  }

  // خطة احتياط: استخدام Telegram API مباشرة إن وُجِد TOKEN و ADMIN
  try {
    if (TG_TOKEN && TG_ADMIN && typeof fetch === 'function') {
      const form = new FormData();
      form.append('chat_id', TG_ADMIN);
      form.append('caption', 'Scan this WhatsApp QR within 1 minute');
      // سنرسل الـ QR كنص إذا تعذّر رفع الصورة (لتفادي مشاكل multipart في بعض البيئات)
      // الحل الأبسط والموثوق هنا: إرسال نص فقط
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_ADMIN, text: `QR:\n\`${rawQR}\``, parse_mode: 'Markdown' }),
      });
      return;
    }
  } catch (e) {
    logger.warn({ e: e?.message }, 'sending QR via Telegram HTTP failed');
  }

  logger.warn('No Telegram integration available to deliver QR.');
}

// ------- قفل الـ Singleton في Mongo -------

async function acquireLockOrExit() {
  if (!MONGO_URI) throw new Error('MONGODB_URI required');
  scheduleProcessCleanup();

  const client = await getMongoClient();
  const col = client.db().collection('locks');

  const now = Date.now();
  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  const STALE_MS = 3 * 60 * 1000;

  try {
    const res = await col.findOneAndUpdate(
      {
        _id: WA_LOCK_KEY,
        $or: [
          { holderId },
          { ts: { $lt: now - STALE_MS } },
          { holderId: { $exists: false } },
        ],
      },
      { $set: { holderId, ts: now } },
      { upsert: true, returnDocument: 'after' }
    );

    if (!res.value || (res.value.holderId && res.value.holderId !== holderId)) {
      logger.warn({ currentHolder: res.value?.holderId }, 'Another instance holds the WA lock. Exiting.');
      process.exit(0);
    }

    _lockHeld = true;
    logger.info({ holderId, key: WA_LOCK_KEY }, '✅ Acquired / refreshed WA singleton lock.');

    // نبقي الطابع الزمني حديثًا
    if (_lockTicker) clearInterval(_lockTicker);
    _lockTicker = setInterval(async () => {
      try {
        await col.updateOne({ _id: WA_LOCK_KEY }, { $set: { ts: Date.now() } });
      } catch (e) {
        logger.warn({ e: e?.message }, 'lock heartbeat failed');
      }
    }, 30_000);
  } catch (e) {
    // في حال حدث E11000 أو أي خطأ سباق — اخرج بهدوء
    logger.error({ e, stack: e?.stack }, 'acquireLockOrExit error');
    process.exit(0);
  }
}

async function releaseLock() {
  try {
    if (_lockTicker) { clearInterval(_lockTicker); _lockTicker = null; }
    if (_lockHeld) {
      await _lockMongoClient?.db()?.collection('locks')?.deleteOne?.({ _id: WA_LOCK_KEY });
      _lockHeld = false;
    }
  } catch {}
}

// ------- إنشاء وربط سوكِت Baileys -------

async function createSocket({ telegram }) {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds, clearAuth } = await mongoAuthState(logger);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
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

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    // إرسال QR
    if (qr) {
      try {
        const png = await QRCode.toBuffer(qr, { width: 360, margin: 1 });
        await sendQRToTelegram({ pngBuffer: png, rawQR: qr, telegram });
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
        logger.warn({ e: e?.message }, 'QR rendering/sending failed, sending raw text only.');
        await sendQRToTelegram({ pngBuffer: null, rawQR: qr, telegram });
        awaitingPairing = true;
      }
    }

    // فتح اتصال
    if (connection === 'open') {
      logger.info('✅ WhatsApp connected.');
      awaitingPairing = false;
      if (qrRotateTimer) { clearTimeout(qrRotateTimer); qrRotateTimer = null; }
    }

    // إغلاق اتصال
    if (connection === 'close') {
      const code =
        (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;

      if (code === 440) { // conflict (replaced)
        logger.warn({ code }, '⚠️ WA connection closed.');
        logger.warn('Stream conflict detected — delaying reconnect 20s.');
        try { safeCloseSock(sock); } catch {}
        _sock = null;
        setTimeout(() => startWhatsApp({ telegram }), 20_000);
        return;
      }

      if (code === 515) { // إعادة التيار
        logger.warn('Stream 515 — restarting socket without clearing auth.');
        try { safeCloseSock(sock); } catch {}
        _sock = null;
        setTimeout(() => startWhatsApp({ telegram }), 3_000);
        return;
      }

      if (code === DisconnectReason.loggedOut || code === 401) {
        // تسجيل خروج حقيقي
        logger.warn('WA logged out — wiping creds & keys, waiting 90s for rescanning QR.');
        await clearAuth();
        try { safeCloseSock(sock); } catch {}
        _sock = null;

        setTimeout(() => startWhatsApp({ telegram }), 90_000);
        return;
      }

      // غير ذلك: أعد المحاولة سريعًا
      logger.warn({ code }, 'WA connection closed — retrying in 3s.');
      try { safeCloseSock(sock); } catch {}
      _sock = null;
      setTimeout(() => startWhatsApp({ telegram }), 3_000);
    }
  });

  // اربط مستمع الرسائل مرة واحدة لهذا السوكِت
  try { sock.ev.removeAllListeners('messages.upsert'); } catch {}
  sock.ev.on('messages.upsert', onMessageUpsert(sock));

  return sock;
}

// ------- API عام للتشغيل -------

async function startWhatsApp({ telegram } = {}) {
  if (_starting) return _sock;
  _starting = true;
  try {
    await acquireLockOrExit();
    if (_sock) return _sock;

    _sock = await createSocket({ telegram });

    // إغلاق نظيف
    const shutdown = () => {
      logger.warn('SIGTERM/SIGINT: closing WA socket');
      try { safeCloseSock(_sock); } catch {}
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
