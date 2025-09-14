// src/lib/selfheal.js
const mongoose = require('mongoose');
const logger = require('./logger');

const KEY_COLL_NAME = process.env.BAILEYS_KEY_COLLECTION || 'BaileysKey';

async function purgeSessionForJid(jid) {
  try {
    const bare = String(jid).replace(/@.+$/, '');
    const col = mongoose.connection.collection(KEY_COLL_NAME);
    const res = await col.deleteMany({
      $or: [
        { type: 'session', id: jid },
        { type: 'session', id: bare },
        { _id: `session:${jid}` },
        { _id: `session:${bare}` }
      ]
    });
    logger.warn({ jid, deleted: res.deletedCount }, 'selfheal: purged session keys');
  } catch (e) {
    logger.warn({ e, jid }, 'selfheal: purgeSessionForJid failed');
  }
}

async function purgeSenderKey(groupJid, userJid) {
  try {
    const bare = String(userJid || '').replace(/@.+$/, '');
    const col = mongoose.connection.collection(KEY_COLL_NAME);
    const res = await col.deleteMany({
      $or: [
        { type: 'sender-key', id: { $regex: groupJid } },
        { type: 'sender-key', id: { $regex: bare } },
        { _id: { $regex: `sender-key:${groupJid}` } },
        { _id: { $regex: `sender-key:.*${bare}` } }
      ]
    });
    logger.warn({ groupJid, userJid, deleted: res.deletedCount }, 'selfheal: purged sender-key');
  } catch (e) {
    logger.warn({ e, groupJid, userJid }, 'selfheal: purgeSenderKey failed');
  }
}

function registerSelfHeal(sock) {
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates) {
      try {
        if (u.update && u.update.status === 8 && u.key) {
          const chatId = u.key.remoteJid || '';
          const isGroup = /@g\.us$/.test(chatId);
          const participant = u.key.participant || u.participant || '';

          if (isGroup) {
            await purgeSenderKey(chatId, participant);
          } else if (chatId) {
            await purgeSessionForJid(chatId);
          }
        }
      } catch (e) {
        logger.warn({ e, updates: u }, 'selfheal handler failed');
      }
    }
  });
}

module.exports = { registerSelfHeal };
