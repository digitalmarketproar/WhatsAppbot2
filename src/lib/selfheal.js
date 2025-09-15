// src/lib/selfheal.js
// Self-heal مُحسّن لأخطاء التشفير (Bad MAC / No matching sessions)
// - يرسل Retry Request رسمي للرسالة الفاشلة
// - يحتسب فشل متتالي لكل JID (participant أو group)
// - عند فشل ≥2: ينظّف session + sender-keys لذلك الـJID فقط (بدون لمس app-state-sync-key)

const mongoose = require('mongoose');
const logger = require('./logger');

const KEY_COLL_NAME = process.env.BAILEYS_KEY_COLLECTION || 'BaileysKey';
// عدّاد فشل متتالي لكل مفتاح (participant أو group)
const consecutiveFails = new Map();

function escapeReg(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ⚠️ لا تلمس app-state-sync-key هنا أبداً
async function purgeSessionForJid(jid) {
  try {
    const sJid = String(jid || '');
    if (!sJid || sJid === 'status@broadcast') {
      logger.debug?.({ jid: sJid }, 'skip purge session for invalid/status jid');
      return;
    }

    // استهدف صيغ @lid و @s.whatsapp.net وأيضًا "النواة" قبل @
    const at = sJid.indexOf('@');
    const core = at === -1 ? sJid : sJid.slice(0, at);
    const col  = mongoose.connection.collection(KEY_COLL_NAME);

    // Baileys يخزن مفاتيح session بصيغ متنوعة:
    // - { _id: "session:<jid>" } أو { id: "session:<jid>" }
    // - أحيانًا type/collection schema تختلف؛ لذا نستخدم regex على id/_id.
    const patterns = [
      `^session:${escapeReg(sJid)}$`,
      `^session:${escapeReg(core)}(@.+)?$`, // تحوط
    ];

    const orConds = [
      { id:  { $regex: patterns[0] } },
      { _id: { $regex: patterns[0] } },
      { id:  { $regex: patterns[1] } },
      { _id: { $regex: patterns[1] } },
    ];

    const res = await col.deleteMany({ $or: orConds });
    logger.warn({ jid: sJid, deleted: res?.deletedCount }, 'purged session keys for jid');
  } catch (e) {
    logger.warn({ e, jid }, 'purgeSessionForJid failed');
  }
}

async function purgeSenderKeysFor(groupJid, participantJid) {
  try {
    const g = String(groupJid || '');
    if (!g.endsWith('@g.us')) return;
    const p = String(participantJid || '');
    const col = mongoose.connection.collection(KEY_COLL_NAME);

    // صيغة sender-key في بايليس غالبًا:
    // id: "sender-key-<groupJid>::<deviceJid>::<iteration>"
    // نستهدف group + participant معًا لو توفر participant، وإلا المجموعة فقط.
    const groupPat = `^sender-key-${escapeReg(g)}(::|:)`;
    const orConds = p
      ? [
          { id:  { $regex: `${groupPat}.*${escapeReg(p)}(::|:)` } },
          { _id: { $regex: `${groupPat}.*${escapeReg(p)}(::|:)` } },
        ]
      : [
          { id:  { $regex: groupPat } },
          { _id: { $regex: groupPat } },
        ];

    const res = await col.deleteMany({ $or: orConds });
    logger.warn({ groupJid: g, participantJid: p, deleted: res?.deletedCount }, 'purged sender keys');
  } catch (e) {
    logger.warn({ e, groupJid, participantJid }, 'purgeSenderKeysFor failed');
  }
}

async function requestRetry(sock, key) {
  try {
    if (!key?.id) return;
    await sock.sendRetryRequest(key);
    logger.debug?.({ key }, 'retry request sent');
  } catch (e) {
    logger.warn({ e }, 'sendRetryRequest failed');
  }
}

// مفتاح العدّاد: نفضّل participant إن وجد، وإلا group/chat
function counterKeyFrom(mOrU) {
  const k = mOrU?.key || mOrU || {};
  return k.participant || k.remoteJid || 'unknown';
}

function registerSelfHeal(sock, { messageStore } = {}) {
  // تأمين getMessage لدعم إعادة الإرسال
  if (typeof sock.getMessage !== 'function') {
    sock.getMessage = async (key) => {
      const id = key?.id;
      return id && messageStore?.get(id);
    };
  }

  // رسائل جديدة: خزن الرسالة واصفر العدّاد
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
      try {
        const chatId = m?.key?.remoteJid;
        if (chatId === 'status@broadcast') continue;

        if (m?.key?.id && messageStore) {
          messageStore.set(m.key.id, m);
          const ck = counterKeyFrom(m);
          consecutiveFails.delete(ck);
        }
      } catch (e) {
        logger.warn({ e, m }, 'selfheal upsert handler failed');
      }
    }
  });

  // تحديثات الرسائل (محل ظهور أخطاء Bad MAC/No session)
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates || []) {
      try {
        const key = u?.key || {};
        const chatId = key?.remoteJid || '';
        if (chatId === 'status@broadcast') continue;

        // اجمع كل الأخطاء في نص واحد
        const errs = []
          .concat(u?.errors || [])
          .concat(u?.error ? [u.error] : [])
          .map(e => (typeof e === 'string' ? e : (e?.message || e?.toString() || '')))
          .join(' | ')
          .toLowerCase();

        const badMac = /bad\s*mac/.test(errs);
        const noSess = /no (matching )?sessions? found/.test(errs) || /no session found/.test(errs);

        if (badMac || noSess) {
          const ck = counterKeyFrom(u);
          // اطلب إعادة الإرسال أولًا
          await requestRetry(sock, key);

          // زد العدّاد
          const fails = (consecutiveFails.get(ck) || 0) + 1;
          consecutiveFails.set(ck, fails);

          // بعد محاولتين: نظّف ثم صفّر العدّاد
          if (fails >= 2) {
            const participant = key?.participant || '';
            // نظّف session للطرف المسبب + sender-keys في الغروب
            await purgeSessionForJid(participant || chatId);
            await purgeSenderKeysFor(chatId, participant);

            // resync خفيف
            try {
              await sock.resyncAppState?.(['critical_unblock_low', 'regular_high']);
            } catch (e) {
              logger.warn({ e }, 'resync after purge failed');
            }

            consecutiveFails.delete(ck);
          }

          logger.warn({ key, fails: consecutiveFails.get(ck), badMac, noSess }, 'selfheal: decryption error handled');
        } else if (u?.message) {
          // نجاح الاستلام/فك التشفير: صفّر
          const ck = counterKeyFrom(u);
          consecutiveFails.delete(ck);
        }
      } catch (e) {
        logger.warn({ e, u }, 'selfheal messages.update handler failed');
      }
    }
  });
}

module.exports = { registerSelfHeal };
