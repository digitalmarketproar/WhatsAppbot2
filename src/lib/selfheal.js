// src/lib/selfheal.js
const mongoose = require('mongoose');
const logger = require('./logger');

const KEY_COLL_NAME = process.env.BAILEYS_KEY_COLLECTION || 'BaileysKey';

// عدّاد فشل متتالي لكل JID (لمنع purge عدواني)
const consecutiveFails = new Map();

// ⚠️ لا تمسح app-state-sync-key هنا أبداً
async function purgeSessionForJid(jid) {
  try {
    // ⛔ لا نلمس جلسات الستاتس
    if (String(jid) === 'status@broadcast') {
      logger.debug?.({ jid }, 'skip purge for status broadcast');
      return;
    }

    const bare = String(jid).replace(/@.+$/, '');
    const col = mongoose.connection.collection(KEY_COLL_NAME);
    await col.deleteMany({
      $or: [
        { type: 'session', id: jid },
        { type: 'session', id: bare },
        { _id: `session:${jid}` },
        { _id: `session:${bare}` }
      ]
    });
    logger.warn({ jid }, 'purged session keys for jid');
  } catch (e) {
    logger.warn({ e, jid }, 'purgeSessionForJid failed');
  }
}

async function purgeSenderKey(groupJid) {
  try {
    // ⛔ لا معنى لمسح sender-key لمعرّف ليس مجموعة
    if (!String(groupJid).endsWith('@g.us')) return;

    const col = mongoose.connection.collection(KEY_COLL_NAME);
    // احذف مفاتيح المرسل الخاصة بالمجموعة فقط
    await col.deleteMany({
      type: 'sender-key',
      id: new RegExp(`^${groupJid}:`, 'i')
    });
    logger.warn({ groupJid }, 'purged sender keys for group');
  } catch (e) {
    logger.warn({ e, groupJid }, 'purgeSenderKey failed');
  }
}

function registerSelfHeal(sock, { messageStore } = {}) {
  // نراقب الرسائل الواردة: إذا فشل فك التشفير (لا يوجد m.message)، ننظّف بشكل محدود وحذر
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!Array.isArray(messages)) return;

    for (const m of messages) {
      try {
        const chatId = m?.key?.remoteJid;

        // ⛔ تجاهل الستاتس بالكامل
        if (chatId === 'status@broadcast') {
          continue;
        }

        const isGroup = (chatId || '').endsWith('@g.us');

        if (!m.message && chatId) {
          // فشل فك التشفير → زد عدّاد الفشل لهذا الـJID
          const c = (consecutiveFails.get(chatId) || 0) + 1;
          consecutiveFails.set(chatId, c);

          // لا تنفّذ أي purge إلا عند فشل متتالي ≥ 3 لنفس الـJID (وممنوع للستاتس)
          if (c >= 3) {
            if (isGroup) {
              await purgeSenderKey(chatId);
            } else {
              await purgeSessionForJid(chatId);
            }

            // بعد التنظيف، أعد مزامنة حالة المفاتيح بشكل خفيف
            try {
              await sock.resyncAppState?.(['critical_unblock_low']);
            } catch (e) {
              logger.warn({ e }, 'resync after purge failed');
            }

            // صفّر العداد بعد إجراء التنظيف
            consecutiveFails.delete(chatId);
          }
        } else if (m?.key?.id && messageStore) {
          // نجاح استقبال/فك التشفير → صفّر العداد
          consecutiveFails.delete(chatId);
          // خزّن الرسالة لدعم getMessage
          messageStore.set(m.key.id, m);
        }
      } catch (e) {
        logger.warn({ e, m }, 'selfheal handler failed');
      }
    }
  });
}

module.exports = { registerSelfHeal };
