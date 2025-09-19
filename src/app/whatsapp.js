// src/app/whatsapp.js
'use strict';

const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const NodeCache = require('node-cache');
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

// ====== الإعدادات من البيئة ======
const MONGO_URI  = process.env.MONGODB_URI || '';
const CREDS_COL  = process.env.BAILEYS_CREDS_COLLECTION || 'baileyscreds';
const KEYS_COL   = process.env.BAILEYS_KEY_COLLECTION   || 'baileyskeys';
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';
const PAIR_NUMBER    = process.env.PAIR_NUMBER || null; // مثال: "967xxxxxxxx"

// Telegram ENV (لا تغيّر الأسماء)
const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID || '';

// WIPE flags
const ONCE_FLAG = path.join('/tmp', 'wipe_baileys_done');

// =============== أدوات مساعدة ===============
function parseList(val) {
  return String(val || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

if (process.env.WIPE_BAILEYS && process.env.WIPE_BAILEYS !== '0') {
  logger.warn('WIPE_BAILEYS مفعّل. سيؤدي هذا إلى حذف اعتماد Baileys. عطّل هذا المتغيّر في الإنتاج.');
}

// إرسال صورة QR إلى تيليجرام
async function sendQrToTelegramImage(pngBuf, caption = 'Scan this WhatsApp QR') {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_ADMIN_ID) {
      logger.warn('TELEGRAM_TOKEN/TELEGRAM_ADMIN_ID غير مضبوطة؛ لن يُرسل QR إلى تليجرام.');
      return;
    }
    const fd = new FormData();
    fd.append('chat_id', TELEGRAM_ADMIN_ID);
    fd.append('caption', caption);
    // في Node 18+ (undici): نستخدم Blob لرفع الصورة
    const blob = new Blob([pngBuf], { type: 'image/png' });
    fd.append('photo', blob, 'wa-qr.png');

    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
    const res = await fetch(url, { method: 'POST', body: fd });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logger.warn({ status: res.status, t }, 'فشل إرسال QR إلى تليجرام');
    }
  } catch (e) {
    logger.warn({ e }, 'استثناء أثناء إرسال QR إلى تيليجرام');
  }
}

// إرسال رسالة نصية إلى تيليجرام
async function sendTextToTelegram(text) {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_ADMIN_ID) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_ADMIN_ID, text }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logger.warn({ status: res.status, t }, 'فشل إرسال رسالة إلى تيليجرام');
    }
  } catch (e) {
    logger.warn({ e }, 'استثناء أثناء إرسال رسالة إلى تيليجرام');
  }
}

// =============== قفل أحادي عبر Mongo ===============
const WA_LOCK_KEY = process.env.WA_LOCK_KEY || '_wa_singleton_lock';
const WA_LOCK_TTL_MS = Number(process.env.WA_LOCK_TTL_MS || 60_000);
let _lockRenewTimer = null;
let _lockMongoClient = null;

async function acquireLockOrExit() {
  if (!MONGO_URI) throw new Error('MONGODB_URI مطلوب.');

  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);

  _lockMongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await _lockMongoClient.connect();
  const db = _lockMongoClient.db();
  const col = db.collection('locks');

  const now = Date.now();
  const doc = { _id: WA_LOCK_KEY, holder: holderId, expiresAt: now + WA_LOCK_TTL_MS };

  try {
    await col.insertOne(doc);
    logger.info({ holderId, key: WA_LOCK_KEY }, '✅ Acquired WA singleton lock (insert).');
  } catch (e) {
    if (e?.code !== 11000) {
      logger.error({ e }, 'Lock insert failed unexpectedly');
      process.exit(0);
    }

    // Driver v5: تُرجع الوثيقة مباشرة أو null
    const taken = await col.findOneAndUpdate(
      { _id: WA_LOCK_KEY, expiresAt: { $lte: now } },
      { $set: { holder: holderId, expiresAt: now + WA_LOCK_TTL_MS } },
      { returnDocument: 'after' }
    );

    if (!taken || taken.holder !== holderId) {
      logger.error({ holderId }, 'WA lock not acquired (held by another live instance). Exiting.');
      process.exit(0);
    }
    logger.info({ holderId, key: WA_LOCK_KEY }, '✅ Acquired WA singleton lock (takeover).');
  }

  _lockRenewTimer = setInterval(async () => {
    try {
      await col.updateOne(
        { _id: WA_LOCK_KEY, holder: holderId },
        { $set: { expiresAt: Date.now() + WA_LOCK_TTL_MS } }
      );
    } catch (e) {
      logger.warn({ e }, 'Failed to renew WA lock');
    }
  }, Math.max(5000, Math.floor(WA_LOCK_TTL_MS / 2)));
  _lockRenewTimer.unref?.();
}

function releaseLock() {
  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  try { _lockRenewTimer && clearInterval(_lockRenewTimer); } catch {}
  (async () => {
    try {
      if (_lockMongoClient) {
        const db = _lockMongoClient.db();
        await db.collection('locks').deleteOne({ _id: WA_LOCK_KEY, holder: holderId });
      }
    } catch {}
    try { await _lockMongoClient?.close?.(); } catch {}
  })().catch(() => {});
}

// =============== Wipe Utilities ===============
async function maybeWipeDatabase() {
  const mode = (process.env.WIPE_BAILEYS || '').toLowerCase().trim();
  if (!mode) return;

  if (String(process.env.WIPE_BAILEYS_ONCE || '') === '1' && fs.existsSync(ONCE_FLAG)) {
    logger.warn('WIPE_BAILEYS_ONCE=1: تمت عملية المسح سابقاً؛ سيتم التخطي الآن.');
    return;
  }

  const uri = MONGO_URI;
  if (!uri) {
    logger.warn('WIPE_BAILEYS مفعّل لكن MONGODB_URI فارغ. سيتم التخطي.');
    return;
  }

  let conn;
  try {
    logger.warn({ mode }, '🧹 بدء مسح قاعدة البيانات (WIPE_BAILEYS)');
    conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 }).asPromise();
    const db = conn.db;

    if (mode === 'all') {
      const name = db.databaseName;
      await db.dropDatabase();
      logger.warn(`🗑️ تم إسقاط قاعدة البيانات كاملة "${name}".`);
    } else if (mode === '1') {
      const r1 = await db.collection(CREDS_COL).deleteMany({});
      const r2 = await db.collection(KEYS_COL).deleteMany({});
      logger.warn(
        { collections: [CREDS_COL, KEYS_COL], deleted: { [CREDS_COL]: r1?.deletedCount || 0, [KEYS_COL]: r2?.deletedCount || 0 } },
        '✅ تم مسح مجموعات Baileys'
      );
    } else if (mode === 'custom') {
      const list = parseList(process.env.WIPE_BAILEYS_COLLECTIONS);
      if (!list.length) {
        logger.warn('WIPE_BAILEYS=custom لكن WIPE_BAILEYS_COLLECTIONS فارغ. سيتم التخطي.');
      } else {
        const deleted = {};
        for (const colName of list) {
          try {
            const res = await db.collection(colName).deleteMany({});
            deleted[colName] = res?.deletedCount || 0;
          } catch (e) {
            logger.warn({ colName, e }, 'فشل مسح المجموعة');
          }
        }
        logger.warn({ deleted }, '✅ تم مسح مجموعات مخصّصة');
      }
    } else {
      logger.warn({ mode }, 'وضع WIPE_BAILEYS غير معروف؛ سيتم التخطي.');
    }

    if (String(process.env.WIPE_BAILEYS_ONCE || '') === '1') {
      try { fs.writeFileSync(ONCE_FLAG, String(Date.now())); } catch {}
    }
  } catch (e) {
    logger.warn({ e }, '❌ فشل مسح قاعدة البيانات');
  } finally {
    try { await conn?.close(); } catch {}
  }
}

async function wipeAuthMongoNow() {
  if (!MONGO_URI) {
    logger.warn('MONGODB_URI فارغ؛ لا يمكن مسح الاعتماد.');
    return;
  }
  let conn;
  try {
    conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 10000 }).asPromise();
    const db = conn.db;
    const r1 = await db.collection(CREDS_COL).deleteMany({});
    const r2 = await db.collection(KEYS_COL).deleteMany({});
    logger.warn(
      { collections: [CREDS_COL, KEYS_COL], deleted: { [CREDS_COL]: r1?.deletedCount || 0, [KEYS_COL]: r2?.deletedCount || 0 } },
      '🧹 تم مسح اعتماد Baileys بعد loggedOut'
    );
  } catch (e) {
    logger.warn({ e }, '❌ فشل wipeAuthMongoNow');
  } finally {
    try { await conn?.close(); } catch {}
  }
}

// =============== Store بسيط للرسائل ===============
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

// =============== إدارة سوكِت ===============
let currentSock = null;
let reconnecting = false;
let generation = 0;

function safeCloseSock(sock) {
  try { sock?.end?.(); } catch {}
  try { sock?.ws?.close?.(); } catch {}
}

// =============== إنشاء سوكِت واحد ===============
async function createSingleSocket({ telegram } = {}) {
  if (!MONGO_URI) {
    throw new Error('MONGODB_URI مطلوب لاستمرارية جلسة WhatsApp. أضف المتغيّر في بيئة التشغيل.');
  }

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
    printQRInTerminal: !telegram, // إن كنت لا تريد طباعته في اللوج عند وجود تيليجرام: اتركها true لإخفائه
    emitOwnEvents: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: true,
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

  // اتصال وتدفق الحالة
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u || {};
    const code =
      lastDisconnect?.error?.output?.statusCode ??
      lastDisconnect?.error?.statusCode ??
      lastDisconnect?.statusCode;

    logger.info({ gen: myGen, connection, code, hasQR: Boolean(qr) }, 'WA connection.update');

    // إرسال QR إلى تيليجرام (صورة)
    if (qr && TELEGRAM_TOKEN && TELEGRAM_ADMIN_ID) {
      try {
        const png = await QRCode.toBuffer(qr, { type: 'png', margin: 1, scale: 6 });
        await sendQrToTelegramImage(png, 'امسح هذا الـ QR لربط الواتساب');
      } catch (e) {
        logger.warn({ e }, 'Failed to generate/send QR image');
      }
    }

    // بديل QR: كود اقتران مرئي مرّة واحدة إلى تيليجرام
    try {
      if (!sock.authState.creds?.registered && PAIR_NUMBER) {
        const codeTxt = await sock.requestPairingCode(PAIR_NUMBER);
        logger.info({ code: codeTxt }, 'PAIRING CODE');
        await sendTextToTelegram(`PAIR CODE: \`${codeTxt}\``);
      }
    } catch (e) {
      logger.warn({ e }, 'requestPairingCode failed');
    }

    if (connection === 'open') {
      logger.info('WA connection open');
      try { await sock.sendPresenceUpdate('available'); } catch {}
    }

    if (connection === 'close') {
      const isLoggedOut = code === DisconnectReason.loggedOut || code === 401;
      if (isLoggedOut) {
        logger.error('WA logged out — سيتم مسح الاعتماد وإيقاف الخدمة.');
        await wipeAuthMongoNow();
        return; // لا إعادة اتصال بعد تسجيل الخروج النهائي
      }

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

  // Echo اختياري
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      for (const m of messages || []) {
        const rjid = m?.key?.remoteJid;
        if (rjid === 'status@broadcast') continue;
        storeMessage(m);

        if (!ENABLE_WA_ECHO) continue;
        if (m.key?.fromMe) continue;

        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          '';

        await sock.sendMessage(rjid, { text: text ? `echo: ${text}` : 'received.' });
      }
    } catch (e) {
      logger.warn({ e, type }, 'messages.upsert handler error');
    }
  });

  // Resync خفيف
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates || []) {
      try {
        const needsResync = u.update?.retry || u.update?.status === 409 || u.update?.status === 410;
        if (needsResync) {
          try { await sock.resyncAppState?.(['critical_unblock_low']); } catch (e) {
            logger.warn({ e }, 'resyncAppState failed');
          }
        }
      } catch (e) {
        logger.warn({ e, u }, 'messages.update handler error');
      }
    }
  });

  // Self-Heal
  registerSelfHeal(sock, { messageStore });

  return sock;
}

// =============== نقطة البدء ===============
let wipedOnce = false;

async function startWhatsApp({ telegram } = {}) {
  if (!MONGO_URI) {
    throw new Error('MONGODB_URI مطلوب. بدونه ستفقد الجلسة بعد كل إعادة تشغيل.');
  }

  await acquireLockOrExit();

  if (!wipedOnce) {
    try { await maybeWipeDatabase(); } catch (e) { logger.warn({ e }, 'maybeWipeDatabase error'); }
    wipedOnce = true;
  }

  if (currentSock) return currentSock;

  currentSock = await createSingleSocket({ telegram });

  const shutdown = () => {
    logger.warn('SIGTERM/SIGINT: closing WA socket');
    safeCloseSock(currentSock);
    currentSock = null;
    releaseLock();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return currentSock;
}

module.exports = { startWhatsApp };
