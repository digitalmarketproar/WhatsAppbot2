// src/lib/selfheal.js
// Self-Heal لأخطاء libsignal/Baileys:
// - Bad MAC / No session found / Invalid PreKey ID
// يستهدف كل هويات المرسل المحتملة (remoteJid + senderLid + participantPn)
// ويطبّق: Retry → عدّاد → Purge جلسات مستهدفة (+ sender-keys للمجموعات) → Resync خفيف.

const mongoose = require('mongoose');
const logger = require('./logger');

const KEY_COLL_NAME = process.env.BAILEYS_KEY_COLLECTION || 'BaileysKey';
const consecutiveFails = new Map();

function escapeReg(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function coreOf(jid)  { const s = String(jid || ''); const i = s.indexOf('@'); return i === -1 ? s : s.slice(0, i); }

async function purgeSessionForJid(jid) {
  try {
    const sJid = String(jid || '');
    if (!sJid || sJid === 'status@broadcast') return;

    const col  = mongoose.connection.collection(KEY_COLL_NAME);
    const core = coreOf(sJid);
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
    if (!g.endsWith('@g.us')) return; // فقط في القروبات
    const p = String(participantJid || '');
    const col = mongoose.connection.collection(KEY_COLL_NAME);

    const groupPat = `^sender-key-${escapeReg(g)}(::|:)`;
    const orConds = p
      ? [
          { id:  { $regex: `${groupPat}.*${escapeReg(p)}(::|:)` } },
          { _id: { $regex: `${groupPat}.*${escapeReg(p)}(::|:)` } },
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

// مفتاح عدّاد مركّب: يشمل كل المعرفات المتاحة لنفس الجهة
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

// استخرج كل المرشحين الممكنين للتنظيف
function extractCandidates(mOrU) {
  const k = mOrU?.key || mOrU || {};
  const candidates = [];
  if (k.participant)   candidates.push(k.participant);
  if (k.participantPn) candidates.push(k.participantPn);
  if (k.senderLid)     candidates.push(k.senderLid);
  if (k.remoteJid)     candidates.push(k.remoteJid);
  return Array.from(new Set(candidates.filter(Boolean)));
}

function registerSelfHeal(sock, { messageStore } = {}) {
  // دعم retry: توفير getMessage
  if (typeof sock.getMessage !== 'function') {
    sock.getMessage = async (key) => {
      const id = key?.id;
      return id && messageStore?.get(id);
    };
  }

  // خزّن الرسائل الجديدة واصفر العدّاد
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

        const errs = []
          .concat(u?.errors || [])
          .concat(u?.error ? [u.error] : [])
          .map(e => (typeof e === 'string' ? e : (e?.message || e?.toString() || '')))
          .join(' | ')
          .toLowerCase();

        const badMac     = /bad\s*mac/.test(errs);
        const noSess     = /no (matching )?sessions? found/.test(errs) || /no session found/.test(errs);
        const invalidPre = /invalid\s*prekey\s*id/.test(errs);

        if (badMac || noSess || invalidPre) {
          // 1) اطلب إعادة الإرسال
          await requestRetry(sock, key);

          // 2) عدّاد فشل
          const ck = counterKeyFrom(u);
          const fails = (consecutiveFails.get(ck) || 0) + 1;
          consecutiveFails.set(ck, fails);

          // 3) بعد محاولتين: نظّف كل المرشحين (يغطي الخاص + القروبات)
          if (fails >= 2) {
            const candidates = extractCandidates(u); // قد تتضمن senderLid / participantPn / remoteJid
            for (const jid of candidates) {
              await purgeSessionForJid(jid);
              // إن كانت رسالة ضمن مجموعة: نظّف sender-keys للمجموعة لهذا المشارك
              if (String(chatId).endsWith('@g.us')) {
                await purgeSenderKeysFor(chatId, jid);
              }
            }

            try {
              await sock.resyncAppState?.(['critical_unblock_low', 'regular_high']);
            } catch (e) {
              logger.warn({ e }, 'resync after purge failed');
            }
            consecutiveFails.delete(ck);
          }

          logger.warn({ key, fails: consecutiveFails.get(ck), badMac, noSess, invalidPre }, 'selfheal: decryption error handled');
        } else if (u?.message) {
          consecutiveFails.delete(counterKeyFrom(u));
        }
      } catch (e) {
        logger.warn({ e, u }, 'selfheal messages.update handler failed');
      }
    }
  });
}

module.exports = { registerSelfHeal };
