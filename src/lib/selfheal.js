// src/lib/selfheal.js
// Self-Heal محسّن لأخطاء التشفير في Baileys/libsignal:
// - Bad MAC
// - No session found / No matching sessions
// - Invalid PreKey ID
// الاستراتيجية: Retry → عدّاد فشل لكل جهة → Purge انتقائي ثنائي (lid + pn) + sender-keys → Resync خفيف
// ⚠️ لا نلمس app-state-sync-key إطلاقًا.

const mongoose = require('mongoose');
const logger = require('./logger');

const KEY_COLL_NAME = process.env.BAILEYS_KEY_COLLECTION || 'BaileysKey';
const consecutiveFails = new Map(); // مفتاح العدّاد يمكن أن يضم أكثر من JID لذات الجهة

function escapeReg(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// تبسيط استخراج core قبل @
function coreOf(jid) {
  const s = String(jid || '');
  const i = s.indexOf('@');
  return i === -1 ? s : s.slice(0, i);
}

// ⚠️ لا تلمس app-state-sync-key هنا
async function purgeSessionForJid(jid) {
  try {
    const sJid = String(jid || '');
    if (!sJid || sJid === 'status@broadcast') return;

    const core = coreOf(sJid);
    const col  = mongoose.connection.collection(KEY_COLL_NAME);

    const patterns = [
      `^session:${escapeReg(sJid)}$`,
      `^session:${escapeReg(core)}(@.+)?$`,
    ];

    const res = await col.deleteMany({
      $or: [
        { id:  { $regex: patterns[0] } },
        { _id: { $regex: patterns[0] } },
        { id:  { $regex: patterns[1] } },
        { _id: { $regex: patterns[1] } },
      ],
    });
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

    // id: "sender-key-<groupJid>::<deviceJid>::<iter>" — نوسّع regex لاحتمالات مختلفة
    const groupPat = `^sender-key-${escapeReg(g)}(::|:)`;
    const orConds = p
      ? [
          { id:  { $regex: `${groupPat}.*${escapeReg(p)}(::|:)` } },
          { _id: { $regex: `${groupPat}.*${escapeReg(p)}(::|:)` } },
          // احتياط: ربما تُخزَّن بـcore فقط
          { id:  { $regex: `${groupPat}.*${escapeReg(coreOf(p))}(@.*)?(::|:)` } },
          { _id: { $regex: `${groupPat}.*${escapeReg(coreOf(p))}(@.*)?(::|:)` } },
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

// مفتاح عدّاد موحّد قد يجمع أكثر من مُعرّف لنفس الجهة (lid + pn)
function counterKeyFrom(mOrU) {
  const k = mOrU?.key || mOrU || {};
  const parts = [
    k.participant || '',
    k.participantPn || '', // بعض البيئات تضيف هذا الحقل داخل key
    k.remoteJid || '',
  ].filter(Boolean);
  return parts.join('|'); // مفتاح مركّب
}

// نستخرج ثنائية (lid + pn) إن توفرت: من الرسالة أو التحديث
function extractDualIds(mOrU) {
  const k = mOrU?.key || mOrU || {};
  const participantLid = k.participant && String(k.participant).includes('@lid') ? k.participant : '';
  const participantPn  = k.participantPn || '';
  const remote         = k.remoteJid || '';
  return { participantLid, participantPn, remoteJid: remote };
}

function registerSelfHeal(sock, { messageStore } = {}) {
  // تأمين getMessage لدعم retry
  if (typeof sock.getMessage !== 'function') {
    sock.getMessage = async (key) => {
      const id = key?.id;
      return id && messageStore?.get(id);
    };
  }

  // خزن الرسائل الجديدة واصفر العدّاد
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
      try {
        const chatId = m?.key?.remoteJid;
        if (chatId === 'status@broadcast') continue;
        if (m?.key?.id && messageStore) {
          messageStore.set(m.key.id, m);
          consecutiveFails.delete(counterKeyFrom(m));
        }
      } catch (e) {
        logger.warn({ e, m }, 'selfheal upsert handler failed');
      }
    }
  });

  // معالجة أخطاء فك التشفير
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

        const badMac      = /bad\s*mac/.test(errs);
        const noSess      = /no (matching )?sessions? found/.test(errs) || /no session found/.test(errs);
        const invalidPre  = /invalid\s*prekey\s*id/.test(errs);

        if (badMac || noSess || invalidPre) {
          // 1) اطلب إعادة الإرسال
          await requestRetry(sock, key);

          // 2) عدّاد فشل
          const ck = counterKeyFrom(u);
          const fails = (consecutiveFails.get(ck) || 0) + 1;
          consecutiveFails.set(ck, fails);

          // 3) بعد محاولتين فاشلتين: purge ثنائي (lid + pn) + sender-keys
          if (fails >= 2) {
            const { participantLid, participantPn, remoteJid } = extractDualIds(u);

            // نظّف جلسات كل المعرفات المتاحة
            await purgeSessionForJid(participantLid || remoteJid);
            if (participantPn) await purgeSessionForJid(participantPn);

            // نظّف مفاتيح المجموعة: جرّب بالحالتين
            await purgeSenderKeysFor(remoteJid, participantLid || '');
            if (participantPn) await purgeSenderKeysFor(remoteJid, participantPn);

            // resync خفيف
            try {
              await sock.resyncAppState?.(['critical_unblock_low', 'regular_high']);
            } catch (e) {
              logger.warn({ e }, 'resync after purge failed');
            }

            consecutiveFails.delete(ck);
          }

          logger.warn(
            { key, fails: consecutiveFails.get(ck), badMac, noSess, invalidPre },
            'selfheal: decryption error handled'
          );
        } else if (u?.message) {
          // نجاح فك التشفير → صفّر العدّاد
          consecutiveFails.delete(counterKeyFrom(u));
        }
      } catch (e) {
        logger.warn({ e, u }, 'selfheal messages.update handler failed');
      }
    }
  });
}

module.exports = { registerSelfHeal };
