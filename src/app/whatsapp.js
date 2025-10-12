// src/app/whatsapp.js
'use strict';

const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { MongoClient }  = require('mongodb');

const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

const MONGO_URI     = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY   = process.env.WA_LOCK_KEY || 'wa_lock_singleton';
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';

let _lockMongoClient = null;
let _lockHeld = false;
let _sock = null;
let _starting = false;

// ———————————————— Lock (singleton) ————————————————
async function acquireLockOrExit() {
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

// ———————————————— Core ————————————————
async function createSocket({ telegram }) {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds, clearAuth, getHasCreds } = await mongoAuthState(logger);

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    logger,
    syncFullHistory: false,
    keepAliveIntervalMs: 20_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
  });

  sock.ev.on('creds.update', saveCreds);
  registerSelfHeal(sock, logger);

  // ——— QR throttling ———
  let lastQrAt = 0;
  let paired = false;

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr && !paired) {
      // لا نمسح الاعتماد هنا إطلاقاً — فقط نرسل QR بهدوء مع تبطيء
      const now = Date.now();
      if (now - lastQrAt > 45_000) {
        lastQrAt = now;
        try {
          // عندك دالة sendQR في تيليجرام تولّد الصورة بنفسها
          if (telegram?.sendQR) await telegram.sendQR(qr);
          else {
            // احتياط: نص خام
            await telegram?.notify?.('Scan this WhatsApp QR within 1 minute:\n' + qr);
          }
        } catch (e) {
          logger.warn({ e: e.message }, 'Failed to send QR via Telegram');
        }
      }
    }

    if (connection === 'open') {
      paired = true;
      logger.info('connected to WA');
      lastQrAt = 0;
    }

    if (connection === 'close') {
      const code =
        (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;

      logger.info({ code }, 'WA connection.close');

      // دائماً أغلق السوكِت القديم قبل إعادة التشغيل
      try { safeCloseSock(sock); } catch {}
      if (_sock === sock) _sock = null;

      if (code === DisconnectReason.loggedOut || code === 401) {
        // فقط هنا نمسح الاعتماد
        logger.warn('WA logged out — clearing auth & restarting.');
        try { await clearAuth(); } catch {}
        setTimeout(() => startWhatsApp({ telegram }), 2500);
        return;
      }

      // باقي الأخطاء: إعادة محاولة بدون مسح الاعتماد
      setTimeout(() => startWhatsApp({ telegram }), 2000);
    }
  });

  // ——— Echo اختياري للتشخيص ———
  if (ENABLE_WA_ECHO) {
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages || []) {
        const jid  = m.key?.remoteJid;
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        if (jid && text) {
          try { await sock.sendMessage(jid, { text }); } catch {}
        }
      }
    });
  }

  // عدم طلب Pairing Code إطلاقاً — وضع QR فقط
  try {
    const has = await getHasCreds();
    // لا نفعل شيء هنا؛ يكفي إشعار QR عند وروده
    if (!has) logger.info('No creds in DB yet — waiting for QR scan.');
  } catch (e) {
    logger.warn({ e: e.message }, 'getHasCreds failed');
  }

  return sock;
}

async function startWhatsApp({ telegram } = {}) {
  if (!MONGO_URI) throw new Error('MONGODB_URI required');
  if (_sock || _starting) return _sock;
  _starting = true;

  await acquireLockOrExit();

  _sock = await createSocket({ telegram });

  const shutdown = () => {
    logger.warn('SIGTERM/SIGINT: closing WA socket');
    safeCloseSock(_sock);
    _sock = null;
    releaseLock();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  _starting = false;
  return _sock;
}

module.exports = { startWhatsApp };
