// src/handlers/messages/moderation.js
const GroupSettings = require('../../models/GroupSettings');
const UserWarning   = require('../../models/UserWarning');
const { normalizeArabic, hasLink, isMediaMessage } = require('../../lib/arabic');
const logger = require('../../lib/logger');

const notAdminCooldown = new Map(); // groupId -> lastTs

function textFromMessage(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    ''
  ).trim();
}

/**
 * نحاول حذف الرسالة مباشرةً. لو فشلنا 403/forbidden -> نُبلغ مرة واحدة كل 10 دقائق.
 */
async function deleteForAllOrWarn(sock, m) {
  const groupId = m.key.remoteJid;
  try {
    await sock.sendMessage(groupId, {
      delete: {
        remoteJid: groupId,
        fromMe: false,
        id: m.key.id,
        participant: m.key.participant || m.participant, // مهم في القروبات
      }
    });
    return true;
  } catch (e) {
    const msg = String(e?.message || '').toLowerCase();
    const code = e?.data || e?.output?.statusCode;
    if (code === 403 || msg.includes('forbidden') || msg.includes('not-authorized')) {
      const last = notAdminCooldown.get(groupId) || 0;
      const now  = Date.now();
      if (now - last > 10 * 60 * 1000) {
        await sock.sendMessage(groupId, { text: '⚠️ لتفعيل الحذف/الحظر يرجى ترقية البوت إلى *مشرف*.' });
        notAdminCooldown.set(groupId, now);
      }
    } else {
      logger.warn({ e }, 'deleteForAll failed');
    }
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

async function moderateGroupMessage(sock, m) {
  const groupId = m.key?.remoteJid;
  if (!groupId?.endsWith('@g.us')) return false;

  // إعدادات القروب
  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings?.enabled) return false;

  // نص الرسالة
  const raw  = textFromMessage(m);
  const norm = normalizeArabic(raw);

  // مرسل الرسالة (قد يأتي كـ participant في القروبات)
  const fromUser = m.key?.participant || m.participant;
  if (!fromUser) return false;

  // فحص المخالفات
  const violations = [];

  // روابط
  if (settings.blockLinks && hasLink(raw)) {
    violations.push('روابط');
  }

  // وسائط
  if (settings.blockMedia && isMediaMessage(m)) {
    violations.push('وسائط');
  }

  // كلمات محظورة (contains بعد التطبيع)
  if (Array.isArray(settings.bannedWords) && settings.bannedWords.length) {
    const hit = settings.bannedWords.some(w => norm.includes(normalizeArabic(w)));
    if (hit) violations.push('كلمة محظورة');
  }

  if (!violations.length) return false;

  // نحذف ثم نُحذّر/نطرد
  const deleted = await deleteForAllOrWarn(sock, m);
  if (deleted) {
    await warnAndMaybeKick(sock, groupId, fromUser, settings);
  }
  return deleted;
}

module.exports = { moderateGroupMessage };
