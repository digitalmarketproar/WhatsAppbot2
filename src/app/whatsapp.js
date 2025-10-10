// src/app/whatsapp.js
'use strict';

const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { MongoClient }  = require('mongodb');
const mongoose         = require('mongoose');
const NodeCache        = require('node-cache');

const logger           = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

const MONGO_URI   = process.env.MONGODB_URI || process.env.MONGODB_URL;
const WA_LOCK_KEY = process.env.WA_LOCK_KEY || 'wa_lock_singleton';
const PAIR_NUMBER = process.env.PAIR_NUMBER || null;
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';

let _lockMongoClient = null;
let _lockHeld = false;
let _sock = null;

async function acquireLockOrExit() {
  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  _lockMongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await _lockMongoClient.connect();
  const col = _lockMongoClient.db().collection('locks');
  const doc = { _id: WA_LOCK_KEY, holderId, ts: Date.now() };
  try {
    await col.insertOne(doc);
    _lockHeld = true;
    logger.info({ holderId, key: WA_LOCK_KEY }, '✅ Acquired WA singleton lock (insert).');
  } catch (e) {
    logger.warn({ e: e.message }, 'Another instance holds the lock. Exiting.');
    process.exit(0);
  }
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

  // حفظ الاعتماد
  sock.ev.on('creds.update', saveCreds);

  // مسجّل ذاتي لمعالجة أخطاء المفاتيح (لا يلمس creds)
  registerSelfHeal(sock, logger);

  // QR → إلى تليجرام
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      try { await telegram?.sendQR(qr); } catch {}
    }

    if (connection === 'open') {
      logger.info('connected to WA');
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;
      logger.info({ code }, 'WA connection.close');

      if (code === DisconnectReason.loggedOut || code === 401) {
        logger.warn('WA logged out — wiping & restart.');
        await clearAuth(); // ← يمسح BaileysCreds / BaileysKey فعليًا
        // أعد البدء: سيظهر QR أو سنستخدم Pairing
        setTimeout(() => startWhatsApp({ telegram }), 1500);
        return;
      }

      // أخطاء أخرى: أعد المحاولة
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

  // إذا لا توجد creds مسجلة، أعطِ Pairing Code بدل QR (أنسب على السيرفر)
  try {
    const has = await getHasCreds();
    if (!has && PAIR_NUMBER) {
      const code = await sock.requestPairingCode(PAIR_NUMBER);
      await telegram?.notify?.(`Pairing code: ${code}`); // سيصل للأدمِن على تليجرام
    }
  } catch (e) {
    logger.warn({ e: e.message }, 'pairing code failed');
  }

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
