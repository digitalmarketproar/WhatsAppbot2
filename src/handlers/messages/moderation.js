const GroupSettings = require('../../models/GroupSettings');
const UserWarning = require('../../models/UserWarning');
const { normalizeArabic, hasLink, isMediaMessage } = require('../../lib/arabic');
const { normalizeUserJid } = require('../../lib/jid');
const logger = require('../../lib/logger');

const notAdminCooldown = new Map();

async function isGroupAdmin(sock, groupId, userJidRaw) {
  try {
    const me = normalizeUserJid(userJidRaw);
    const md = await sock.groupMetadataMinimal(groupId); // أخف وأضمن
    const admins = (md?.participants || [])
      .filter(p => p.admin)
      .map(p => normalizeUserJid(p.id));
    return admins.includes(me);
  } catch (e) {
    logger.warn({ e, groupId }, 'isGroupAdmin failed');
    return false;
  }
}

async function deleteForAll(sock, m) {
  try {
    await sock.sendMessage(m.key.remoteJid, {
      delete: {
        remoteJid: m.key.remoteJid,
        fromMe: false,
        id: m.key.id,
        participant: m.key.participant || m.participant,
      }
    });
    return true;
  } catch (e) {
    logger.warn({ e }, 'deleteForAll failed');
    return false;
  }
}

async function warnAndMaybeKick(sock, groupId, userId, settings) {
  const maxW = settings.maxWarnings || 3;
  const doc = await UserWarning.findOneAndUpdate(
    { groupId, userId },
    { $inc: { count: 1 } },
    { upsert: true, new: true }
  );
  const count = doc.count;
  if (count >= maxW) {
    try {
      await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
      await UserWarning.deleteOne({ groupId, userId }).catch(() => {});
      await sock.sendMessage(groupId, {
        text: `🚫 تم حظر @${userId.split('@')[0]} بعد ${maxW} مخالفات.`,
        mentions: [userId]
      });
    } catch (e) {
      logger.warn({ e }, 'kick user failed');
    }
  } else {
    await sock.sendMessage(groupId, { text: `⚠️ تحذير ${count}/${maxW}: الرجاء الالتزام بالقوانين.` });
  }
}

function textFromMessage(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    ''
  ).trim();
}

async function moderateGroupMessage(sock, m) {
  const groupId = m.key?.remoteJid;
  if (!groupId?.endsWith('@g.us')) return false;

  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings?.enabled) return false;

  const meJid = sock.user?.id;
  const amIAdmin = await isGroupAdmin(sock, groupId, meJid);

  if (!amIAdmin) {
    const now = Date.now();
    if ((now - (notAdminCooldown.get(groupId) || 0)) > 600000) {
      await sock.sendMessage(groupId, { text: '⚠️ لتفعيل الحذف/الحظر يجب ترقية البوت إلى *مشرف*.' });
      notAdminCooldown.set(groupId, now);
    }
    return false;
  }

  const raw = textFromMessage(m);
  const norm = normalizeArabic(raw);
  const fromUser = normalizeUserJid(m.key.participant || m.participant || '');

  if (settings.blockLinks && hasLink(raw)) {
    if (await deleteForAll(sock, m)) await warnAndMaybeKick(sock, groupId, fromUser, settings);
    return true;
  }

  if (settings.blockMedia && isMediaMessage(m)) {
    if (await deleteForAll(sock, m)) await warnAndMaybeKick(sock, groupId, fromUser, settings);
    return true;
  }

  if (Array.isArray(settings.bannedWords) && settings.bannedWords.length) {
    const hit = settings.bannedWords.some(w => norm.includes(normalizeArabic(w)));
    if (hit) {
      if (await deleteForAll(sock, m)) await warnAndMaybeKick(sock, groupId, fromUser, settings);
      return true;
    }
  }

  return false;
}

module.exports = { moderateGroupMessage };
