// src/app/whatsapp.js
'use strict';

const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// ===== بيئة اختيارية =====
// لتوليد كود اقتران بدل QR أثناء أول تشغيل:
const PAIR_NUMBER = process.env.PAIR_NUMBER || null;
// تفعيل رد "echo" للاختبار فقط:
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';
// أسماء مجموعات Mongo إن كانت مختلفة:
const CREDS_COL = process.env.BAILEYS_CREDS_COLLECTION || 'baileyscreds';
const KEYS_COL  = process.env.BAILEYS_KEY_COLLECTION   || 'baileyskeys';

// ===== أدوات مساعدة =====
const ONCE_FLAG = path.join('/tmp', 'wipe_baileys_done');

function parseList(val) {
  return String(val || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function maybeWipeDatabase() {
  const mode = (process.env.WIPE_BAILEYS || '').toLowerCase().trim();
  if (!mode) return;

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

    if (mode === 'all') {
      const name = db.name;
      await db.dropDatabase();
      logger.warn(`🗑️ Dropped entire Mongo database "${name}".`);
    } else if (mode === '1') {
      const r1 = await db.collection(CREDS_COL).deleteMany({});
      const r2 = await db.collection(KEYS_COL).deleteMany({});
      logger.warn(
        { collections: [CREDS_COL, KEYS_COL], deleted: { [CREDS_COL]: r1?.deletedCount || 0, [KEYS_COL]: r2?.deletedCount || 0 } },
        '✅ Wiped Baileys collections'
      );
    } else if (mode === 'custom') {
      const list = parseList(process.env.WIPE_BAILEYS_COLLECTIONS);
      if (!list.length) {
        logger.warn('WIPE_BAILEYS=custom but WIPE_BAILEYS_COLLECTIONS is empty. Skipping.');
      } else {
        const deleted = {};
        for (const colName of list) {
          try {
            const res = await db.collection(colName).deleteMany({});
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

    if (String(process.env.WIPE_BAILEYS_ONCE || '') === '1') {
      try {
        fs.writeFileSync(ONCE_FLAG, String(Date.now()));
      } catch {}
    }
  } catch (e) {
    logger.warn({ e }, '❌ Database wipe failed');
  } finally {
    try {
      await mongoose.disconnect();
    } catch {}
  }
}

// مسح اعتماد بايليز عند تسجيل الخروج النهائي
async function wipeAuthMongoNow() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    logger.warn('MONGODB_URI is empty; cannot wipe auth.');
    return;
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection;
    const r1 = await db.collection(CREDS_COL).deleteMany({});
    const r2 = await db.collection(KEYS_COL).deleteMany({});
    logger.warn(
      { collections: [CREDS_COL, KEYS_COL], deleted: { [CREDS_COL]: r1?.deletedCount || 0, [KEYS_COL]: r2?.deletedCount || 0 } },
      '🧹 Wiped Baileys auth after loggedOut'
    );
  } catch (e) {
    logger.warn({ e }, '❌ wipeAuthMongoNow failed');
  } finally {
    try {
      await mongoose.disconnect();
    } catch {}
  }
}

// ===== Store بسيط للرسائل =====
const messageStore = new Map();
const MAX_STORE = Number(process.env.WA_MESSAGE_STORE_MAX || 5000);
function storeMessage(msg) {
  if (!msg?.key?.id) return;
  if (messageStore.size >= MAX_STORE) {
    const firstKey = messageStore.keys().next().value;
    if (firstKey) messageStore.delete(firstKey);
  }
  messageStore.set(msg.key.id, msg);
}

// ===== حارس سوكِت =====
let currentSock = null;
let reconnecting = false;
let generation = 0;

function safeCloseSock(sock) {
  try {
    sock?.end?.();
  } catch {}
  try {
    sock?.ws?.close?.();
  } catch {}
}

// ===== إنشاء سوكِت واحد =====
async function createSingleSocket({ telegram } = {}) {
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
    logger,
    printQRInTerminal: !telegram,      // اطبع QR في اللوج إن لم يكن تيليجرام
    emitOwnEvents: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: true,         // أعلن التواجد بعد الاتصال
    getMessage: async (key) => (key?.id ? messageStore.get(key.id) : undefined),
    msgRetryCounterCache,
    shouldIgnoreJid: (jid) => jid === 'status@broadcast',
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    connectTimeoutMs: 60_000,
  });

  const myGen = ++generation;
  logger.info({ gen: myGen }, 'WA socket created');

  // حفظ الاعتماد
  sock.ev.on('creds.update', saveCreds);

  // لوج الاتصال + اقتران بالكود إذا أردت
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u || {};
    const code =
      lastDisconnect?.error?.output?.statusCode ??
      lastDisconnect?.error?.statusCode ??
      lastDisconnect?.statusCode;

    logger.info({ gen: myGen, connection, code, hasQR: Boolean(qr) }, 'WA connection.update');

    // إرسال QR إلى تيليجرام عند توفره
    if (qr && telegram) {
      try {
        if (typeof telegram.sendQR === 'function') {
          await telegram.sendQR(qr);
        } else if (typeof telegram.sendMessage === 'function') {
          await telegram.sendMessage(process.env.TG_CHAT_ID, 'Scan this WhatsApp QR:\n' + qr);
        }
      } catch (e) {
        logger.warn({ e }, 'Failed to send QR to Telegram');
      }
    }

    // بديل QR: كود اقتران مرئي مرّة واحدة عند عدم التسجيل
    try {
      if (!sock.authState.creds?.registered && PAIR_NUMBER) {
        const codeTxt = await sock.requestPairingCode(PAIR_NUMBER);
        logger.info({ code: codeTxt }, 'PAIRING CODE');
      }
    } catch {
      // قد لا يكون متاحًا قبل اكتمال بعض الخطوات، تجاهل
    }

    if (connection === 'open') {
      logger.info('WA connection open');
      try {
        await sock.sendPresenceUpdate('available');
      } catch {}
    }

    if (connection === 'close') {
      const isLoggedOut = code === DisconnectReason.loggedOut;
      if (isLoggedOut) {
        logger.error('WA logged out — wiping creds in Mongo and stopping.');
        // امسح الاعتماد من Mongo حتى يظهر QR/Pairing في التشغيل القادم
        await wipeAuthMongoNow();
        return; // لا تعاود الاتصال تلقائيًا بعد تسجيل الخروج النهائي
      }

      // حالات إعادة التشغيل الطبيعية مثل 515 (restart required) أو تقلب الشبكة
      if (!reconnecting) {
        reconnecting = true;
        logger.warn({ gen: myGen, code }, 'WA closed, scheduling clean restart...');
        safeCloseSock(currentSock);
        currentSock = null;
        setTimeout(async () => {
          try {
            currentSock = await createSingleSocket({ telegram });
            logger.info({ gen: generation }, 'WA restarted cleanly');
          } catch (err) {
            logger.error({ err }, 'WA restart failed');
          } finally {
            reconnecting = false;
          }
        }, 2000);
      } else {
        logger.warn({ gen: myGen }, 'Reconnect already in progress, skipping duplicate restart');
      }
    }
  });

  // تخزين الرسائل
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      for (const m of messages || []) {
        const rjid = m?.key?.remoteJid;
        if (rjid === 'status@broadcast') continue;
        storeMessage(m);

        if (!ENABLE_WA_ECHO) continue;   // ألغِ هذا السطر لتفعّل الإيكو دائمًا
        if (m.key?.fromMe) continue;

        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          '';

        if (text) {
          await sock.sendMessage(rjid, { text: `echo: ${text}` });
        } else {
          await sock.sendMessage(rjid, { text: 'received.' });
        }
      }
    } catch (e) {
      logger.warn({ e, type }, 'messages.upsert handler error');
    }
  });

  // resync خفيف عند retry/409/410
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates || []) {
      try {
        const rjid = u?.key?.remoteJid;
        if (rjid === 'status@broadcast') continue;

        const needsResync = u.update?.retry || u.update?.status === 409 || u.update?.status === 410;
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

  // تفعيل Self-Heal
  registerSelfHeal(sock, { messageStore });

  return sock;
}

// ===== نقطة البدء =====
let wipedOnce = false;
async function startWhatsApp({ telegram } = {}) {
  if (!wipedOnce) {
    try {
      await maybeWipeDatabase();
    } catch (e) {
      logger.warn({ e }, 'maybeWipeDatabase error');
    }
    wipedOnce = true;
  }

  if (currentSock) return currentSock;

  currentSock = await createSingleSocket({ telegram });

  const shutdown = () => {
    logger.warn('SIGTERM/SIGINT: closing WA socket');
    safeCloseSock(currentSock);
    currentSock = null;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return currentSock;
}

module.exports = { startWhatsApp };
