// src/app/whatsapp.js
'use strict';

const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { MongoClient }  = require('mongodb');
const mongoose         = require('mongoose');
const NodeCache        = require('node-cache');
const QRCode           = require('qrcode'); // ← لتوليد صورة QR

const logger           = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

const MONGO_URI   = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY = process.env.WA_LOCK_KEY || 'wa_lock_singleton';
// NOTE: سنُهمل PAIR_NUMBER الآن لأننا سنستخدم QR فقط.
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';

let _lockMongoClient = null;
let _lockHeld = false;
let _sock = null;

async function acquireLockOrExit() {
  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  _lockMongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await _lockMongoClient.connect();
  const col = _lockMongoClient.db().collection('locks');

  // تحسين: upsert مع انتهاء صلاحية لمنع E11000
  const now = Date.now();
  const STALE_MS = 3 * 60 * 1000; // 3 دقائق
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
    printQRInTerminal: false,  // سنرسل الصورة إلى تليجرام بدل الطباعة
    auth: state,
    logger,
    syncFullHistory: false,
    keepAliveIntervalMs: 20_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
  });

  // حفظ الاعتماد
  sock.ev.on('creds.update', saveCreds);

  // مسجّل ذاتي لمعالجة أخطاء المفاتيح (لا يلمس creds)
  registerSelfHeal(sock, logger);

  let awaitingPairing = false;
  let restartTimer = null;

  // QR → توليد صورة PNG وإرسالها لتليجرام
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      try {
        // حوّل النص إلى صورة PNG
        const png = await QRCode.toBuffer(qr, { width: 360, margin: 1 });
        if (telegram?.sendPhoto) {
          await telegram.sendPhoto(png, { caption: 'Scan this WhatsApp QR within 1 minute' });
        } else if (telegram?.sendQR) {
          // احتياطي: أرسل النص إذا ما في sendPhoto
          await telegram.sendQR(qr);
        }
        awaitingPairing = true;
      } catch (e) {
        logger.warn({ e: e.message }, 'Failed to render/send QR; sending raw text as fallback.');
        try { await telegram?.sendQR?.(qr); } catch {}
        awaitingPairing = true;
      }
    }

    if (connection === 'open') {
      logger.info('connected to WA');
      awaitingPairing = false;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;
      logger.info({ code }, 'WA connection.close');

      if (code === DisconnectReason.loggedOut || code === 401) {
        logger.warn('WA logged out — wiping. Waiting 90s to allow QR scan before restart.');
        await clearAuth();

        // انتظر 90 ثانية لإتاحة مسح الـQR
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          // لو لم يتم الارتباط خلال المهلة، أعد البدء
          if (awaitingPairing) startWhatsApp({ telegram });
        }, 90_000);
        return;
      }

      // أخطاء أخرى: أعد المحاولة بعد 1.5 ثانية
      setTimeout(() => startWhatsApp({ telegram }), 1500);
    }
  });

  // Echo اختياري
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

  // هام: لا نطلب pairing code إطلاقًا الآن (نستخدم QR فقط)
  // (لا تفعل: await sock.requestPairingCode(...))

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
