// src/app/whatsapp.js
'use strict';

const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys'); // Baileys core
const { MongoClient }  = require('mongodb'); // Mongo driver
const mongoose         = require('mongoose'); // kept for compatibility
const NodeCache        = require('node-cache'); // kept for compatibility
const QRCode           = require('qrcode'); // QR generator

const logger           = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

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

  // ⬇️ جديد: إجبار ظهور QR عند الإقلاع إذا FORCE_FRESH_QR=1
  if (String(process.env.FORCE_FRESH_QR || '') === '1') {
    try {
      await clearAuth();
      logger.warn('FORCE_FRESH_QR is ON — cleared auth to force QR at boot.');
    } catch (e) {
      logger.warn({ e: e.message }, 'FORCE_FRESH_QR clearAuth failed');
    }
  }

  const sock = makeWASocket({
    version,
    printQRInTerminal: false, // سنرسل صورة QR لتليجرام بدل الطباعة
    auth: state,
    logger,
    syncFullHistory: false,
    keepAliveIntervalMs: 20_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
  });

  // حفظ الاعتماد
  sock.ev.on('creds.update', saveCreds);

  // self-heal لمشاكل المفاتيح (لا يمس الـcreds)
  registerSelfHeal(sock, logger);

  // أعلام ومؤقتات
  let awaitingPairing = false;
  let restartTimer = null;
  let qrRotateTimer = null;

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    // إرسال QR كصورة لتليجرام + تدوير تلقائي كل 60 ثانية
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
            logger.warn('QR expired — rotating: clearing auth & rebuilding socket for a fresh QR.');
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
      logger.info('connected to WA');
      awaitingPairing = false;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (qrRotateTimer) { clearTimeout(qrRotateTimer); qrRotateTimer = null; }
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;
      logger.info({ code }, 'WA connection.close');

      // تأكد من إنهاء السوكت القديم قبل أي إعادة تشغيل
      try { safeCloseSock(sock); } catch {}
      _sock = null;

      if (code === 515) {
        logger.warn('Stream 515 — restarting socket without clearing auth.');
        setTimeout(() => startWhatsApp({ telegram }), 3000);
        return;
      }

      if (code === DisconnectReason.loggedOut || code === 401) {
        logger.warn('WA logged out — wiping. Waiting 8s to allow QR scan before restart.');
        await clearAuth();

        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          if (awaitingPairing) startWhatsApp({ telegram });
        }, 8_000);
        return;
      }

      // أخطاء أخرى: إعادة محاولة سريعة
      setTimeout(() => startWhatsApp({ telegram }), 1500);
    }
  });

  // Echo اختياري للرسائل الخاصة
  if (ENABLE_WA_ECHO) {
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages || []) {
        const jid = m.key?.remoteJid;
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        if (jid && text) {
          try { await sock.sendMessage(jid, { text }); } catch {}
        }
      }
    });
  }

  // لا نطلب pairing code إطلاقًا — وضع QR فقط
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
