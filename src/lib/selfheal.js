// src/lib/selfheal.js
// آلية Self-Heal لأخطاء libsignal/Baileys:
// - Bad MAC / No session found / Invalid PreKey ID
// — تعالج: إعادة الإرسال (retry) + عدّاد فشل + تنظيف جلسات/مفاتيح ذات صلة + Resync خفيف
// — متوافقة مع تخزين Baileys في Mongo عبر Mongoose
// — ممارسات: حماية من التكرار، ضبط اسم الكولكشن تلقائياً، تجنّب لمس creds/app-state

const mongoose = require('mongoose');
const logger = require('./logger');

// إعدادات قابلة للتهيئة عبر البيئة
const FAILS_BEFORE_PURGE = Number(process.env.SELFHEAL_FAILS || 2);        // كم محاولة فاشلة قبل التنظيف
const PURGE_DEBOUNCE_MS   = Number(process.env.SELFHEAL_PURGE_DEBOUNCE_MS || 10_000); // عدم تكرار التنظيف لنفس الكيان خلال هذه المدة

// محاولة ذكية لاكتشاف اسم كولكشن المفاتيح الحقيقي:
// 1) متغير بيئة
// 2) اسم كولكشن موديـل Mongoose إن وُجد
// 3) الاسم الشائع في مشاريع Baileys: 'baileyskeys'
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
    // الوصول المباشر يحترم الاسم الحقيقي حتى لو فيه lowercase/pluralize
    return mongoose.connection.collection(name);
  }
  return mongoose.connection.collections[name];
}

function escapeReg(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function coreOf(jid)  { const s = String(jid || ''); const i = s.indexOf('@'); return i === -1 ? s : s.slice(0, i); }
function isGroupJid(jid) { return String(jid || '').endsWith('@g.us'); }

// عدّاد فشل ومحاولة-إرسال، + حظر تكرار التنظيف لفترة قصيرة
const consecutiveFails = new Map();     // key -> count
const retriedByMsgId   = new Set();     // message.id التي أرسلنا لها retry بالفعل
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
    // ⚠️ حماية: لا نحذف شيء له علاقة بـ creds أو app-state
    // نعتمد على كوننا نمرّر فلاتر خاصة بـ session / sender-key فقط.
    const res = await col.deleteMany(filter);
    logger.warn({ tag, filter, deleted: res?.deletedCount }, 'selfheal: deleteMany');
    return res?.deletedCount || 0;
  } catch (e) {
    logger.warn({ e, filter, tag }, 'selfheal: deleteMany failed');
    return 0;
  }
}

async function purgeSessionForJid(jid) {
  const sJid = String(jid || '');
  if (!sJid || sJid === 'status@broadcast') return;

  const core = coreOf(sJid);
  // بعض السكيمات تحفظ id أو _id بصيغة مسبوقة مثل: "session:<jid>" أو "session:<core>"
  const pats = [
    new RegExp(`^session:${escapeReg(sJid)}$`, 'i'),
    new RegExp(`^session:${escapeReg(core)}(@.+)?$`, 'i'),
    // احتياط: لو بعض السكيمات تحفظ مباشرة "session" كـ type و "id" == jid
  ];

  // نجرّب أكثر من احتمال للحقول
  const orConds = [
    { id:  { $regex: pats[0] } },
    { _id: { $regex: pats[0] } },
    { id:  { $regex: pats[1] } },
    { _id: { $regex: pats[1] } },
    { type: 'session', id: sJid },
    { type: 'session', id: core },
  ];

  const purgeKey = `session:${sJid}`;
  if (withinDebounce(purgeKey)) return;
  markPurged(purgeKey);

  await safeDeleteMany({ $or: orConds }, 'purgeSessionForJid');
}

async function purgeSenderKeysFor(groupJid, participantJid) {
  const g = String(groupJid || '');
  if (!isGroupJid(g)) return;

  const p = String(participantJid || '');
  const groupPat = `^sender-key-${escapeReg(g)}(::|:)`;

  const orConds = p
    ? [
        // مطابقة وفق الأنماط الشائعة لـ Baileys
        { id:  { $regex: `${groupPat}.*${escapeReg(p)}(::|:)`, $options: 'i' } },
        { _id: { $regex: `${groupPat}.*${escapeReg(p)}(::|:)`, $options: 'i' } },
        { id:  { $regex: `${groupPat}.*${escapeReg(coreOf(p))}(@.*)?(::|:)`, $options: 'i' } },
        { _id: { $regex: `${groupPat}.*${escapeReg(coreOf(p))}(@.*)?(::|:)`, $options: 'i' } },
      ]
    : [
        { id:  { $regex: groupPat, $options: 'i' } },
        { _id: { $regex: groupPat, $options: 'i' } },
      ];

  const purgeKey = `sender:${g}:${p || '*'}`;
  if (withinDebounce(purgeKey)) return;
  markPurged(purgeKey);

  await safeDeleteMany({ $or: orConds }, 'purgeSenderKeysFor');
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

  // معالجة أخطاء فك التشفير + الريتراي + التنظيف الانتقائي
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

        // 2) عدّاد فشل لكل جهة (يشمل كل المعرفات)
        const ck = counterKeyFrom(u);
        const fails = (consecutiveFails.get(ck) || 0) + 1;
        consecutiveFails.set(ck, fails);

        // 3) بعد حد معيّن: تنظيف مستهدف + resync خفيف
        if (fails >= FAILS_BEFORE_PURGE) {
          const candidates = extractCandidates(u);

          for (const jid of candidates) {
            await purgeSessionForJid(jid);
            if (isGroupJid(chatId)) {
              await purgeSenderKeysFor(chatId, jid);
            }
          }

          try {
            // resync خفيف يضمن تزامن الحالة (لا يلمس مفاتيح app-state في التخزين)
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
