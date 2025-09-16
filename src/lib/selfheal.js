// src/lib/selfheal.js
// آلية Self-Heal لأخطاء libsignal/Baileys (محسّنة):
// - تقليل الحذف، وجعله انتقائيًا (type محدّد: session / sender-key فقط)
// - رفع العتبات الافتراضية لمنع الحذف المبكر
// - دعم retry + عدّاد فشل + resync خفيف
// - متوافقة مع تخزين Baileys في Mongo عبر Mongoose
// - لا تلمس creds/app-state مطلقًا

const mongoose = require('mongoose');
const logger = require('./logger');

// إعدادات قابلة للتهيئة عبر البيئة
// ✅ رفعنا العتبات الافتراضية: 5 إخفاقات + 5 دقائق تأجيل
const FAILS_BEFORE_PURGE = Number(process.env.SELFHEAL_FAILS || 5);                 // كان 2
const PURGE_DEBOUNCE_MS   = Number(process.env.SELFHEAL_PURGE_DEBOUNCE_MS || 300_000); // كان 10_000
const SELFHEAL_ENABLED    = String(process.env.SELFHEAL_ENABLED || '1') !== '0';   // لإيقاف الميزة إن لزم

// اكتشاف اسم كولكشن المفاتيح
function getKeyCollectionName() {
  return (
    process.env.BAILEYS_KEY_COLLECTION ||
    (mongoose.models.BaileysKey && mongoose.models.BaileysKey.collection?.name) ||
    'baileyskeys'
  );
}
function getKeyCollection() {
  const name = getKeyCollectionName();
  if (!mongoose.connection?.collections?.[name]) {
    return mongoose.connection.collection(name);
  }
  return mongoose.connection.collections[name];
}

function escapeReg(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function coreOf(jid)  { const s = String(jid || ''); const i = s.indexOf('@'); return i === -1 ? s : s.slice(0, i); }
function isGroupJid(jid) { return String(jid || '').endsWith('@g.us'); }

// عدّادات وتتبّع
const consecutiveFails = new Map();     // key -> count
const retriedByMsgId   = new Set();     // message.key.id التي أرسلنا لها retry بالفعل
const lastPurgeAt      = new Map();     // entityKey -> ts

function now() { return Date.now(); }
function withinDebounce(key) {
  const ts = lastPurgeAt.get(key) || 0;
  return now() - ts < PURGE_DEBOUNCE_MS;
}
function markPurged(key) { lastPurgeAt.set(key, now()); }

async function safeDeleteMany(filter, tag) {
  try {
    const col = getKeyCollection();
    const res = await col.deleteMany(filter);
    logger.warn({ tag, filter, deleted: res?.deletedCount }, 'selfheal: deleteMany');
    return res?.deletedCount || 0;
  } catch (e) {
    logger.warn({ e, filter, tag }, 'selfheal: deleteMany failed');
    return 0;
  }
}

// ✅ تعديل مهم: حصر الحذف على type:'session' فقط + فلترة دقيقة بالـ id
async function purgeSessionForJid(jid) {
  const sJid = String(jid || '');
  if (!sJid || sJid === 'status@broadcast') return;

  const core = coreOf(sJid);
  const pats = [
    new RegExp(`^${escapeReg(sJid)}$`, 'i'),
    new RegExp(`^${escapeReg(core)}(@.+)?$`, 'i'),
  ];

  const filter = {
    type: 'session',
    $or: [
      { id: { $regex: pats[0] } },
      { id: { $regex: pats[1] } },
      { id: sJid },
      { id: core }
    ]
  };

  const purgeKey = `session:${sJid}`;
  if (withinDebounce(purgeKey)) return;
  markPurged(purgeKey);

  await safeDeleteMany(filter, 'purgeSessionForJid');
}

// ✅ تعديل مهم: حصر الحذف على type:'sender-key' فقط + مطابقة المجموعة بدقّة
async function purgeSenderKeysFor(groupJid, participantJid) {
  const g = String(groupJid || '');
  if (!isGroupJid(g)) return;

  const p = String(participantJid || '');
  const groupPat = escapeReg(g);

  const orConds = p
    ? [
        // Baileys يخزّن sender-key عادة في id يحتوي groupJid ثم معلومات المشارك
        { id: { $regex: new RegExp(`${groupPat}.*${escapeReg(p)}`, 'i') } },
        { id: { $regex: new RegExp(`${groupPat}.*${escapeReg(coreOf(p))}`, 'i') } },
      ]
    : [
        { id: { $regex: new RegExp(`${groupPat}`, 'i') } },
      ];

  const filter = { type: 'sender-key', $or: orConds };

  const purgeKey = `sender:${g}:${p || '*'}`;
  if (withinDebounce(purgeKey)) return;
  markPurged(purgeKey);

  await safeDeleteMany(filter, 'purgeSenderKeysFor');
}

async function requestRetry(sock, key) {
  try {
    const msgId = key?.id;
    if (!msgId || retriedByMsgId.has(msgId)) return;
    retriedByMsgId.add(msgId);
    await sock.sendRetryRequest(key);
    logger.debug?.({ key }, 'selfheal: retry request sent');
  } catch (e) {
    logger.warn({ e }, 'selfheal: sendRetryRequest failed');
  }
}

function counterKeyFrom(mOrU) {
  const k = mOrU?.key || mOrU || {};
  const parts = [
    k.participant || '',
    k.participantPn || '',
    k.senderLid || '',
    k.remoteJid || '',
  ].filter(Boolean);
  return parts.join('|');
}

function extractCandidates(mOrU) {
  const k = mOrU?.key || mOrU || {};
  const set = new Set();
  if (k.participant)   set.add(k.participant);
  if (k.participantPn) set.add(k.participantPn);
  if (k.senderLid)     set.add(k.senderLid);
  if (k.remoteJid)     set.add(k.remoteJid);
  return Array.from(set);
}

function parseErrorsToFlags(u) {
  const all = []
    .concat(u?.errors || [])
    .concat(u?.error ? [u.error] : [])
    .map(e => (typeof e === 'string' ? e : (e?.message || e?.toString() || '')))
    .join(' | ')
    .toLowerCase();

  return {
    badMac:     /bad\s*mac/.test(all),
    noSess:     /no (matching )?sessions? found/.test(all) || /no session found/.test(all),
    invalidPre: /invalid\s*pre.?key\s*id/.test(all),
  };
}

function registerSelfHeal(sock, { messageStore } = {}) {
  if (!SELFHEAL_ENABLED) {
    logger.warn('selfheal: disabled via SELFHEAL_ENABLED=0');
    return;
  }

  // تأمين getMessage لعكس retry receipts
  if (typeof sock.getMessage !== 'function') {
    sock.getMessage = async (key) => {
      const id = key?.id;
      return id && messageStore?.get(id);
    };
  }

  // عند ورود رسالة سليمة: خزّنها وصفر العدّاد
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
      try {
        if (m?.key?.remoteJid === 'status@broadcast') continue;
        if (m?.key?.id && messageStore) {
          messageStore.set(m.key.id, m);
          consecutiveFails.delete(counterKeyFrom(m));
        }
      } catch (e) {
        logger.warn({ e, m }, 'selfheal: upsert handler failed');
      }
    }
  });

  // معالجة أخطاء فك التشفير + retry + التنظيف الانتقائي
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates || []) {
      try {
        const key = u?.key || {};
        const chatId = key?.remoteJid || '';
        if (chatId === 'status@broadcast') continue;

        const { badMac, noSess, invalidPre } = parseErrorsToFlags(u);
        if (!(badMac || noSess || invalidPre)) {
          if (u?.message) consecutiveFails.delete(counterKeyFrom(u));
          continue;
        }

        // 1) اطلب إعادة إرسال
        await requestRetry(sock, key);

        // 2) عدّاد فشل لكل جهة (يشمل جميع المعرفات في المفتاح)
        const ck = counterKeyFrom(u);
        const fails = (consecutiveFails.get(ck) || 0) + 1;
        consecutiveFails.set(ck, fails);

        // 3) بعد الحد: تنظيف مستهدف + resync خفيف
        if (fails >= FAILS_BEFORE_PURGE) {
          const candidates = extractCandidates(u);

          for (const jid of candidates) {
            // جلسة الطرف
            await purgeSessionForJid(jid);
            // مفاتيح المجموعة (إن كانت رسالة مجموعة)
            if (isGroupJid(chatId)) {
              await purgeSenderKeysFor(chatId, jid);
            }
          }

          try {
            // resync خفيف يضمن تزامن الحالة (لا يلمس app-state في التخزين)
            await sock.resyncAppState?.(['critical_unblock_low', 'regular_high']);
          } catch (e) {
            logger.warn({ e }, 'selfheal: resync after purge failed');
          } finally {
            consecutiveFails.delete(ck);
          }
        }

        logger.warn({ key, fails: consecutiveFails.get(ck), badMac, noSess, invalidPre }, 'selfheal: decryption error handled');
      } catch (e) {
        logger.warn({ e, u }, 'selfheal: messages.update handler failed');
      }
    }
  });
}

module.exports = { registerSelfHeal };
