// src/app/whatsapp.js
const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// ---------- مسح القاعدة/المجموعات عند الإقلاع (اختياري عبر البيئة) ----------
const ONCE_FLAG = path.join('/tmp', 'wipe_baileys_done');

function parseList(val) {
  return String(val || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

async function maybeWipeDatabase() {
  const mode = (process.env.WIPE_BAILEYS || '').toLowerCase().trim(); // '', '1', 'all', 'custom'
  if (!mode) return;

  // منع التكرار إن تم تفعيل once
  if (String(process.env.WIPE_BAILEYS_ONCE || '') === '1' && fs.existsSync(ONCE_FLAG)) {
    logger.warn('WIPE_BAILEYS_ONCE=1: wipe already performed previously; skipping.');
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    logger.warn('WIPE_BAILEYS is set, but MONGODB_URI is empty. Skipping wipe.');
    return;
  }

  try {
    logger.warn({ mode }, '🧹 Starting database wipe (WIPE_BAILEYS)');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection;

    const CREDS = process.env.BAILEYS_CREDS_COLLECTION || 'baileyscreds';
    const KEYS  = process.env.BAILEYS_KEY_COLLECTION   || 'baileyskeys';

    if (mode === 'all') {
      const name = db.name;
      await db.dropDatabase();
      logger.warn(`🗑️ Dropped entire Mongo database "${name}".`);
    } else if (mode === '1') {
      // الوضع الآمن: امسح مجموعتي Baileys فقط
      const credsCol = db.collection(CREDS);
      const keysCol  = db.collection(KEYS);
      const r1 = await credsCol.deleteMany({});
      const r2 = await keysCol.deleteMany({});
      logger.warn({
        collections: [CREDS, KEYS],
        deleted: { [CREDS]: r1?.deletedCount || 0, [KEYS]: r2?.deletedCount || 0 }
      }, '✅ Wiped Baileys collections');
    } else if (mode === 'custom') {
      const list = parseList(process.env.WIPE_BAILEYS_COLLECTIONS);
      if (!list.length) {
        logger.warn('WIPE_BAILEYS=custom but WIPE_BAILEYS_COLLECTIONS is empty. Skipping.');
      } else {
        const deleted = {};
        for (const colName of list) {
          try {
            const col = db.collection(colName);
            const res = await col.deleteMany({});
            deleted[colName] = res?.deletedCount || 0;
          } catch (e) {
            logger.warn({ colName, e }, 'Failed to wipe collection');
          }
        }
        logger.warn({ deleted }, '✅ Wiped custom collections');
      }
    } else {
      logger.warn({ mode }, 'Unknown WIPE_BAILEYS mode; skipping.');
    }

    // علّم مرة واحدة إذا مفعّل
    if (String(process.env.WIPE_BAILEYS_ONCE || '') === '1') {
      try { fs.writeFileSync(ONCE_FLAG, String(Date.now())); } catch {}
    }
  } catch (e) {
    logger.warn({ e }, '❌ Database wipe failed');
  } finally {
    try { await mongoose.disconnect(); } catch {}
  }
}

// ---------- مخزن بسيط للرسائل لدعم getMessage ----------
const messageStore = new Map(); // key: message.key.id -> value: proto message
const MAX_STORE = Number(process.env.WA_MESSAGE_STORE_MAX || 5000);

function storeMessage(msg) {
  if (!msg?.key?.id) return;
  if (messageStore.size >= MAX_STORE) {
    const firstKey = messageStore.keys().next().value;
    if (firstKey) messageStore.delete(firstKey);
  }
  messageStore.set(msg.key.id, msg);
}

// ---------- *إنشاء* سوكِت واتساب ----------
async function createWhatsApp({ telegram } = {}) {
  const { state, saveCreds } = await mongoAuthState(logger);
  const { version } = await fetchLatestBaileysVersion();

  const msgRetryCounterCache = new NodeCache({
    stdTTL: Number(process.env.WA_RETRY_TTL || 3600),
    checkperiod: Number(process.env.WA_RETRY_CHECK || 120),
    useClones: false,
  });

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !telegram, // لإظهار QR بالكونسول إن لم يكن Telegram مفعّلًا
    logger,
    emitOwnEvents: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    getMessage: async (key) => {
      if (!key?.id) return undefined;
      return messageStore.get(key.id);
    },
    msgRetryCounterCache,
    shouldIgnoreJid: (jid) => jid === 'status@broadcast',
  });

  sock.ev.on('creds.update', saveCreds);

  // مراقبة الاتصال + إرسال QR إلى تيليجرام
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u || {};
    logger.info(
      { connection, lastDisconnectReason: lastDisconnect?.error?.message, hasQR: Boolean(qr) },
      'WA connection.update'
    );

    // ⬅️ إرسال الـ QR إلى تيليجرام فور توليده
    if (qr && telegram) {
      try {
        if (typeof telegram.sendQR === 'function') {
          await telegram.sendQR(qr); // صورة QR
        } else if (typeof telegram.sendMessage === 'function') {
          await telegram.sendMessage(process.env.TG_CHAT_ID, 'Scan this WhatsApp QR:\n' + qr);
        }
      } catch (e) {
        logger.warn({ e }, 'Failed to send QR to Telegram');
      }
    }

    // ⬅️ إعادة الاتصال تلقائيًا عند الإغلاق ما لم نكن "Logged Out"
    if (connection === 'close') {
      const code =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.statusCode ??
        lastDisconnect?.statusCode;

      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        logger.warn({ code }, 'WA closed, restarting socket...');
        // مهلة قصيرة لتفادي الازدواجية
        setTimeout(() => {
          startWhatsApp({ telegram }).catch(err => logger.error({ err }, 'restart failed'));
        }, 2000);
      } else {
        logger.error('WA logged out — wipe creds or rescan QR to login again.');
      }
    }
  });

  // تخزين الرسائل
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages || []) {
      const rjid = m?.key?.remoteJid;
      if (rjid === 'status@broadcast') continue;
      storeMessage(m);
    }
  });

  // resync خفيف عند إشارات retry/409/410
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates || []) {
      try {
        const rjid = u?.key?.remoteJid;
        if (rjid === 'status@broadcast') continue;

        const needsResync =
          u.update?.retry ||
          u.update?.status === 409 ||
          u.update?.status === 410;

        if (needsResync) {
          try {
            await sock.resyncAppState?.(['critical_unblock_low']);
          } catch (e) {
            logger.warn({ e }, 'resyncAppState failed');
          }
        }
      } catch (e) {
        logger.warn({ e, u }, 'messages.update handler error');
      }
    }
  });

  // Self-Heal بإعدادات آمنة
  registerSelfHeal(sock, { messageStore });

  return sock;
}

// ---------- *بدء* واتساب مع مسح اختياري + إعادة اتصال تلقائية ----------
let starting = false;
async function startWhatsApp({ telegram } = {}) {
  if (starting) return;
  starting = true;

  try {
    // نفّذ المسح الاختياري قبل أول تهيئة فقط
    await maybeWipeDatabase();
  } catch (e) {
    logger.warn({ e }, 'maybeWipeDatabase error (continuing)');
  }

  try {
    const sock = await createWhatsApp({ telegram });
    return sock;
  } finally {
    starting = false;
  }
}

module.exports = { createWhatsApp, startWhatsApp };
