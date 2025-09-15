// src/handlers/messages/moderation.js
// الموديريشن داخل القروبات: يزيد عدّاد التحذيرات دائمًا عند المخالفة، يحاول حذف الرسالة، ويطرد عند بلوغ الحد.
const GroupSettings = require('../../models/GroupSettings');
const UserWarning   = require('../../models/UserWarning');
const { normalizeArabic, hasLink, isMediaMessage } = require('../../lib/arabic');
const { normalizeUserJid, bareNumber } = require('../../lib/jid');
const logger = require('../../lib/logger');

const notAdminCooldown = new Map();       // groupId -> lastTs (تنبيه "اجعلني مشرف")
const adminsCache      = new Map();       // groupId -> { ts, adminsNumbers: Set<string> }
const ADMINS_TTL_MS    = 5 * 60 * 1000;   // 5 دقائق

function textFromMessage(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    ''
  ).trim();
}

/** كاش المشرفين بالأرقام العارية */
async function getAdminsNumbersCached(sock, groupId) {
  const now = Date.now();
  const cached = adminsCache.get(groupId);
  if (cached && (now - cached.ts) < ADMINS_TTL_MS) return cached.adminsNumbers;

  try {
    const md = await sock.groupMetadataMinimal(groupId);
    const admins = (md?.participants || [])
      .filter(p => p?.admin)
      .map(p => bareNumber(normalizeUserJid(p.id)));
    const set = new Set(admins);
    adminsCache.set(groupId, { ts: now, adminsNumbers: set });
    return set;
  } catch (e) {
    logger.warn({ e, groupId }, 'getAdminsNumbersCached minimal failed; trying full');
    try {
      const md2 = await sock.groupMetadata(groupId);
      const admins = (md2?.participants || [])
        .filter(p => p?.admin)
        .map(p => bareNumber(normalizeUserJid(p.id)));
      const set = new Set(admins);
      adminsCache.set(groupId, { ts: now, adminsNumbers: set });
      return set;
    } catch (e2) {
      logger.warn({ e2, groupId }, 'getAdminsNumbersCached full failed');
      const empty = new Set();
      adminsCache.set(groupId, { ts: now, adminsNumbers: empty });
      return empty;
    }
  }
}

/** نحاول حذف الرسالة؛ لو فشل 403 نرسل تذكير بالمشرف كل 10 دقائق */
async function deleteForAllOrWarn(sock, m) {
  const groupId = m.key.remoteJid;
  try {
    await sock.sendMessage(groupId, {
      delete: {
        remoteJid: groupId,
        fromMe: false,
        id: m.key.id,
        participant: m.key.participant || m.participant,
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

async function warnAndMaybeKick(sock, groupId, userId, settings, currentCount) {
  const count = currentCount;
  const maxW  = settings.maxWarnings || 3;

  if (count >= maxW) {
    try {
      await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
      await UserWarning.deleteOne({ groupId, userId }).catch(() => {});
      await sock.sendMessage(groupId, {
        text: `🚫 تم حظر @${userId.split('@')[0]} بعد ${maxW} مخالفات.`,
        mentions: [userId]
      });
    } catch (e) {
      const last = notAdminCooldown.get(groupId) || 0;
      const now  = Date.now();
      if (now - last > 10 * 60 * 1000) {
        await sock.sendMessage(groupId, { text: '⚠️ لا أستطيع الحظر بدون صلاحية *مشرف*.' });
        notAdminCooldown.set(groupId, now);
      }
      logger.warn({ e }, 'kick user failed');
    }
  } else {
    await sock.sendMessage(groupId, { text: `⚠️ المخالفة ${count}/${maxW}: الرجاء الالتزام بالقوانين.` });
  }
}

async function moderateGroupMessage(sock, m) {
  const groupId = m.key?.remoteJid;
  if (!groupId?.endsWith('@g.us')) return false;

  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings?.enabled) return false;

  // استثناء المشرفين (افتراضيًا مُعطّل؛ فعّله من DB لو تريد)
  const exemptAdmins = settings.exemptAdmins === true;

  const fromUserJid = normalizeUserJid(m.key?.participant || m.participant || '');
  if (!fromUserJid) return false;
  const fromBare = bareNumber(fromUserJid);

  if (exemptAdmins) {
    const adminsNumbers = await getAdminsNumbersCached(sock, groupId);
    if (adminsNumbers.has(fromBare)) return false;
  }

  const raw  = textFromMessage(m);
  const norm = normalizeArabic(raw);

  // حدد وجود مخالفة
  let violated = false;
  if (settings.blockLinks && hasLink(raw)) violated = true;
  if (!violated && settings.blockMedia && isMediaMessage(m)) violated = true;
  if (!violated && Array.isArray(settings.bannedWords) && settings.bannedWords.length) {
    const hit = settings.bannedWords.some(w => norm.includes(normalizeArabic(w)));
    if (hit) violated = true;
  }
  if (!violated) return false;

  // ✳️ زد العدّاد دائمًا عند المخالفة (حتى لو فشل الحذف)
  let newCount = 1;
  try {
    const doc = await UserWarning.findOneAndUpdate(
      { groupId, userId: fromUserJid },
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );
    newCount = doc?.count || 1;
  } catch (e) {
    logger.warn({ e }, 'warn counter inc failed');
  }

  // حاول حذف الرسالة
  await deleteForAllOrWarn(sock, m);

  // أرسل التحذير/أطرد
  await warnAndMaybeKick(sock, groupId, fromUserJid, settings, newCount);

  return true;
}

module.exports = { moderateGroupMessage };
