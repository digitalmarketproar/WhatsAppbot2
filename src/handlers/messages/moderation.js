// src/handlers/messages/moderation.js
const GroupSettings = require('../../models/GroupSettings');
const UserWarning = require('../../models/UserWarning');
const { normalizeArabic, hasLink, isMediaMessage } = require('../../lib/arabic');
const { normalizeUserJid } = require('../../lib/jid');
const logger = require('../../lib/logger');

const notAdminCooldown = new Map(); // groupId -> timestamp

async function isGroupAdmin(sock, groupId, userJidRaw) {
  try {
    const me = normalizeUserJid(userJidRaw);
    const md = await sock.groupMetadata(groupId);
    const admins = (md?.participants || []).filter(p =>
      p?.admin === 'admin' ||
      p?.admin === 'superadmin' ||
      p?.isAdmin === true
    ).map(p => normalizeUserJid(p.id));
    return admins.includes(me);
  } catch (e) {
    logger.warn({ e, groupId }, 'isGroupAdmin failed');
    return false;
  }
}

async function deleteForAll(sock, msgKey) {
  try {
    await sock.sendMessage(msgKey.remoteJid, { delete: msgKey });
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
      await UserWarning.deleteOne({ groupId, userId }).catch(()=>{});
      await sock.sendMessage(
        groupId,
        { text: `🚫 تم حظر @${userId.split('@')[0]} بعد ${maxW} مخالفات.` },
        { mentions: [userId] }
      );
    } catch (e) {
      logger.warn({ e }, 'kick user failed');
    }
  } else {
    await sock.sendMessage(groupId, { text: `⚠️ تحذير ${count}/${maxW}: الرجاء الالتزام بقوانين المجموعة.` });
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
  if (!groupId || !groupId.endsWith('@g.us')) return false;

  // اجلب الإعدادات
  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings || !settings.enabled) return false;

  // تحقق أن البوت فعلاً مشرف
  const meJid = sock.user?.id;
  const amIAdmin = await isGroupAdmin(sock, groupId, meJid);

  if (!amIAdmin) {
    const last = notAdminCooldown.get(groupId) || 0;
    const now  = Date.now();
    if (now - last > 10 * 60 * 1000) { // 10 دقائق
      await sock.sendMessage(groupId, { text: '⚠️ لتفعيل الحذف/الحظر: الرجاء ترقية البوت إلى *مشرف*.' });
      notAdminCooldown.set(groupId, now);
    }
    return false;
  }

  // من هنا لدينا صلاحية الحذف/الحظر
  const raw = textFromMessage(m);
  const norm = normalizeArabic(raw);
  const fromUser = normalizeUserJid(m.key?.participant || m.participant || '');

  // 1) روابط
  if (settings.blockLinks && hasLink(raw)) {
    const ok = await deleteForAll(sock, m.key);
    if (ok) await warnAndMaybeKick(sock, groupId, fromUser, settings);
    return true;
  }

  // 2) وسائط
  if (settings.blockMedia && isMediaMessage(m)) {
    const ok = await deleteForAll(sock, m.key);
    if (ok) await warnAndMaybeKick(sock, groupId, fromUser, settings);
    return true;
  }

  // 3) كلمات محظورة
  if (Array.isArray(settings.bannedWords) && settings.bannedWords.length) {
    const hit = settings.bannedWords.some(w => norm.includes(normalizeArabic(w)));
    if (hit) {
      const ok = await deleteForAll(sock, m.key);
      if (ok) await warnAndMaybeKick(sock, groupId, fromUser, settings);
      return true;
    }
  }

  return false;
}

module.exports = { moderateGroupMessage };
