// src/app/whatsapp.js
'use strict';

const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys'); // Baileys core
// (English) Baileys core imports. | (Arabic) استيراد بايليز الأساسي.
const { MongoClient }  = require('mongodb'); // Mongo driver
// (English) MongoDB official driver. | (Arabic) مُشغّل مونغو الرسمي.
const mongoose         = require('mongoose'); // kept for compatibility
// (English) Kept to match your original file. | (Arabic) مُبقي للتوافق مع ملفك الأصلي.
const NodeCache        = require('node-cache'); // kept for compatibility
// (English) Kept to match your original file. | (Arabic) مُبقي للتوافق مع ملفك الأصلي.
const QRCode           = require('qrcode'); // QR generator
// (English) Generate PNG QR images. | (Arabic) لتوليد صور QR بصيغة PNG.

const logger           = require('../lib/logger');
// (English) Your logger helper. | (Arabic) أداة التسجيل لديك.
const { mongoAuthState } = require('../lib/wa-mongo-auth');
// (English) Mongo-backed auth state with clearAuth(). | (Arabic) حالة مصادقة على مونغو مع clearAuth().
const { registerSelfHeal } = require('../lib/selfheal');
// (English) Self-heal for signal key issues. | (Arabic) معالج ذاتي لمشكلات مفاتيح سيغنال.

const MONGO_URI   = process.env.MONGODB_URI || process.env.MONGODB_URL;
// (English) Mongo connection string from env. | (Arabic) رابط اتصال مونغو من البيئة.
const WA_LOCK_KEY = process.env.WA_LOCK_KEY || 'wa_lock_singleton';
// (English) Singleton lock key in DB. | (Arabic) مفتاح قفل العملية المنفردة.
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';
// (English) Optional echo replies. | (Arabic) تفعيل رد الصدى اختياري.

let _lockMongoClient = null;
let _lockHeld = false;
let _sock = null;

async function acquireLockOrExit() {
  // (English) Acquire/refresh a singleton lock with staleness window. | (Arabic) الحصول/تحديث قفل منفرد مع نافذة صلاحية.
  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  _lockMongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await _lockMongoClient.connect();
  const col = _lockMongoClient.db().collection('locks');

  const now = Date.now();
  const STALE_MS = 3 * 60 * 1000; // 3 min
  // (English) Upsert if same holder, or stale, or missing holder. | (Arabic) إدراج/تحديث إذا نفس الحامل أو قديم أو بلا حامل.
  const res = await col.updateOne(
    { _id: WA_LOCK_KEY, $or: [{ holderId }, { ts: { $lt: now - STALE_MS } }, { holderId: { $exists: false } }] },
    { $set: { holderId, ts: now } },
    { upsert: true }
  );
  const matched = res.matchedCount + (res.upsertedCount || 0);
  if (!matched) {
    logger.warn('Another instance holds the lock. Exiting.');
    // (English) Exit quietly if someone else holds the lock. | (Arabic) الخروج بهدوء لو هناك عملية أخرى تمسك القفل.
    process.exit(0);
  }
  _lockHeld = true;
  logger.info({ holderId, key: WA_LOCK_KEY }, '✅ Acquired/Refreshed WA singleton lock.');
}

async function releaseLock() {
  // (English) Release lock on shutdown. | (Arabic) تحرير القفل عند الإيقاف.
  if (!_lockHeld) return;
  try {
    await _lockMongoClient.db().collection('locks').deleteOne({ _id: WA_LOCK_KEY });
  } catch {}
  _lockHeld = false;
}

function safeCloseSock(s) {
  // (English) Best-effort close of the current socket. | (Arabic) إغلاق آمن للسوكت الحالي قدر الإمكان.
  try { s?.end?.(); } catch {}
  try { s?.ws?.close?.(); } catch {}
}

async function createSocket({ telegram }) {
  const { version } = await fetchLatestBaileysVersion();
  // (English) Always use latest WA Web version. | (Arabic) استخدام أحدث نسخة ويب لواتساب دائمًا.
  const { state, saveCreds, clearAuth } = await mongoAuthState(logger);

  const sock = makeWASocket({
    version,
    printQRInTerminal: false, // we send PNG to Telegram instead
    // (English) We’ll deliver QR via Telegram as PNG. | (Arabic) سنرسل QR لتليجرام كصورة.
    auth: state,
    logger,
    syncFullHistory: false,
    keepAliveIntervalMs: 20_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
  });

  // (English) Persist creds on updates. | (Arabic) حفظ بيانات الاعتماد عند التحديث.
  sock.ev.on('creds.update', saveCreds);

  // (English) Register self-heal (won’t touch creds). | (Arabic) تفعيل المعالج الذاتي (لا يلمس الاعتماد).
  registerSelfHeal(sock, logger);

  // (English) Pairing/QR control flags & timers. | (Arabic) أعلام ومؤقتات التحكم بالاقتران/QR.
  let awaitingPairing = false;
  let restartTimer = null;
  let qrRotateTimer = null;

  // (English) Connection updates: handle QR/open/close. | (Arabic) تحديثات الاتصال: معالجة QR/فتح/إغلاق.
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      // (English) Convert QR text to PNG and send to Telegram. | (Arabic) تحويل QR لنص إلى صورة وإرسالها لتليجرام.
      try {
        const png = await QRCode.toBuffer(qr, { width: 360, margin: 1 });
        if (telegram?.sendPhoto) {
          await telegram.sendPhoto(png, { caption: 'Scan this WhatsApp QR within 1 minute' });
          // (English) Scan within 1 minute. | (Arabic) امسح خلال دقيقة واحدة.
        } else if (telegram?.sendQR) {
          await telegram.sendQR(qr);
        }
        awaitingPairing = true;

        // (English) Auto-rotate QR every 60s until paired. | (Arabic) تدوير تلقائي للـQR كل 60 ثانية حتى يتم الاقتران.
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
      // (English) Paired successfully; clear timers. | (Arabic) تم الاقتران بنجاح؛ تنظيف المؤقتات.
      awaitingPairing = false;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (qrRotateTimer) { clearTimeout(qrRotateTimer); qrRotateTimer = null; }
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error && (lastDisconnect.error.output?.statusCode || lastDisconnect.error?.status)) || 0;
      logger.info({ code }, 'WA connection.close');

      // (English) Always tear down old socket so restart truly rebuilds. | (Arabic) إغلاق السوكت القديم لتضمن إعادة بناء حقيقية.
      try { safeCloseSock(sock); } catch {}
      _sock = null;

      if (code === 515) {
        // (English) Stream restart after pairing attempt; just rebuild soon. | (Arabic) إعادة تشغيل التيار بعد محاولة اقتران؛ أعد البناء قليلًا.
        logger.warn('Stream 515 — restarting socket without clearing auth.');
        setTimeout(() => startWhatsApp({ telegram }), 3000);
        return;
      }

      if (code === DisconnectReason.loggedOut || code === 401) {
        // (English) Give 90s window to scan new QR before restart. | (Arabic) منح 90 ثانية لمسح QR جديد قبل إعادة التشغيل.
        logger.warn('WA logged out — wiping. Waiting 90s to allow QR scan before restart.');
        await clearAuth();

        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          if (awaitingPairing) startWhatsApp({ telegram });
        }, 90_000);
        return;
      }

      // (English) Other errors: quick retry. | (Arabic) أخطاء أخرى: إعادة محاولة سريعة.
      setTimeout(() => startWhatsApp({ telegram }), 1500);
    }
  });

  // (English) Optional echo of incoming DMs. | (Arabic) رد صدى اختياري للرسائل الخاصة.
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

  // (English) IMPORTANT: do NOT request pairing code; QR-only mode. | (Arabic) مهم: لا نطلب رمز اقتران؛ وضع QR فقط.
  return sock;
}

async function startWhatsApp({ telegram } = {}) {
  if (!MONGO_URI) throw new Error('MONGODB_URI required');
  // (English) Ensure Mongo URI exists. | (Arabic) التأكد من وجود رابط مونغو.

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
// (English) Export start function. | (Arabic) تصدير دالة البدء.
