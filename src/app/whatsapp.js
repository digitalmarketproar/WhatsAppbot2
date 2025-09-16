// src/app/whatsapp.js
const { default: makeWASocket, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

// ⬇️ جديد: تنظيف قاعدة البيانات اختيارياً عبر متغيّر بيئة
const mongoose = require('mongoose');

async function maybeWipeBaileysCollections() {
  const mode = (process.env.WIPE_BAILEYS || '').toLowerCase().trim(); // '', '1', 'all'
  if (!mode) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    logger.warn('WIPE_BAILEYS is set, but MONGODB_URI is empty. Skipping wipe.');
    return;
  }

  try {
    logger.warn({ mode }, '🧹 Starting Mongo wipe as requested by WIPE_BAILEYS');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });

    const db = mongoose.connection;
    const CREDS = process.env.BAILEYS_CREDS_COLLECTION || 'baileyscreds';
    const KEYS  = process.env.BAILEYS_KEY_COLLECTION   || 'baileyskeys';

    if (mode === 'all') {
      // ⚠️ يحذف القاعدة كاملة (احذر!)
      const name = db.name;
      await db.dropDatabase();
      logger.warn(`🗑️ Dropped entire Mongo database "${name}".`);
    } else {
      // الوضع الآمن: امسح كولكشن الاعتمادات والمفاتيح فقط
      const credsCol = db.collection(CREDS);
      const keysCol  = db.collection(KEYS);

      const r1 = await credsCol.deleteMany({});
      const r2 = await keysCol.deleteMany({});

      logger.warn({
        collections: [CREDS, KEYS],
        deleted: { [CREDS]: r1?.deletedCount || 0, [KEYS]: r2?.deletedCount || 0 }
      }, '✅ Wiped Baileys collections');
    }
  } catch (e) {
    logger.warn({ e }, '❌ Mongo wipe failed');
  } finally {
    try { await mongoose.disconnect(); } catch {}
    // ملاحظة: أزل متغيّر WIPE_BAILEYS من إعدادات البيئة بعد أول تشغيل حتى لا يعاد المسح كل مرة.
  }
}

// مخزن بسيط للرسائل لدعم getMessage أثناء إعادة المحاولة
// إضافة حد أعلى + تنظيف دوري لتفادي تسرب الذاكرة
const messageStore = new Map(); // key: message.key.id -> value: proto message
const MAX_STORE = Number(process.env.WA_MESSAGE_STORE_MAX || 5000);

function storeMessage(msg) {
  if (!msg?.key?.id) return;
  // حد أعلى بسيط: حذف أقدم عنصر عندما نتجاوز الحد
  if (messageStore.size >= MAX_STORE) {
    const firstKey = messageStore.keys().next().value;
    if (firstKey) messageStore.delete(firstKey);
  }
  messageStore.set(msg.key.id, msg);
}

async function createWhatsApp({ telegram } = {}) {
  // ⬇️ جديد: نفّذ المسح الاختياري قبل تهيئة Baileys
  await maybeWipeBaileysCollections();

  const { state, saveCreds } = await mongoAuthState(logger);
  const { version } = await fetchLatestBaileysVersion();

  // Cache لمحاولات إعادة فك التشفير
  const msgRetryCounterCache = new NodeCache({
    stdTTL: Number(process.env.WA_RETRY_TTL || 3600),
    checkperiod: Number(process.env.WA_RETRY_CHECK || 120),
    useClones: false,
  });

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !telegram, // إن أردت إرسال الـ QR لتلغرام، أضف لوجيكك في connection.update
    logger,
    emitOwnEvents: false,

    // نسدّ مزامنة التاريخ القديم نهائياً (Performance + تجنّب ضجيج)
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,

    // إرجاع الرسالة الأصلية عند إعادة المحاولة
    getMessage: async (key) => {
      if (!key?.id) return undefined;
      return messageStore.get(key.id);
    },

    // تتبع محاولات إعادة فك التشفير
    msgRetryCounterCache,

    // تجاهل حالات status تماماً
    shouldIgnoreJid: (jid) => jid === 'status@broadcast',
  });

  // احفظ الاعتمادات دائماً
  sock.ev.on('creds.update', saveCreds);

  // تتبّع حالة الاتصال (للمراقبة + رؤية الـ QR)
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u || {};
    logger.info({ connection, lastDisconnectReason: lastDisconnect?.error?.message, hasQR: Boolean(qr) }, 'WA connection.update');

    // مثال: إن أردت إرسال QR لتلغرام (إن لديك كائن telegram ودوال sendMessage/sendPhoto)
    // if (qr && telegram) {
    //   try {
    //     await telegram.sendMessage(process.env.TG_CHAT_ID, 'Scan this WhatsApp QR:\n' + qr);
    //   } catch (e) {
    //     logger.warn({ e }, 'Failed to send QR to Telegram');
    //   }
    // }
  });

  // خزّن الرسائل الواردة كي تعمل getMessage في أي إعادة محاولة
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages || []) {
      const rjid = m?.key?.remoteJid;
      if (rjid === 'status@broadcast') continue; // لا نخزن الستاتس
      storeMessage(m);
    }
  });

  // لو حصلت تحديثات تشير لإعادة محاولة/فشل تشفير — اعمل resync خفيفة (عدا الستاتس)
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

  // التعافي الذاتي (ينظّف sessions/sender-keys عند الفشل المتكرر) — بإعدادات جديدة آمنة
  registerSelfHeal(sock, { messageStore });

  // تنظيف دوري للذاكرة المؤقتة (اختياري)
  const CLEAN_INTERVAL = Number(process.env.WA_STORE_CLEAN_MS || 10 * 60 * 1000); // كل 10 دقائق
  const cleaner = setInterval(() => {
    // حذف أقدم 1% تقريبًا لتقليل الذروة (خيار بسيط)
    const toDelete = Math.floor(messageStore.size * 0.01);
    for (let i = 0; i < toDelete; i++) {
      const k = messageStore.keys().next().value;
      if (!k) break;
      messageStore.delete(k);
    }
  }, CLEAN_INTERVAL).unref?.();

  // إلغاء المنظف عند الخروج
  process.once('SIGINT',  () => clearInterval(cleaner));
  process.once('SIGTERM', () => clearInterval(cleaner));

  return sock;
}

module.exports = { createWhatsApp };
