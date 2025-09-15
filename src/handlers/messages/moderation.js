// src/handlers/messages/moderation.js
// موديريشن القروبات (نهائي):
// - استثناء المشرفين اختياري عبر GroupSettings.exemptAdmins (إن true يتخطّاهم كليًا).
// - يزيد عدّاد التحذيرات دائمًا عند المخالفة.
// - يرسل رسالة التحذير حتى لو فشل حذف الرسالة.
// - عند بلوغ الحد: يحاول الطرد مباشرةً باستخدام JID مطبّع (@s.whatsapp.net).
// - لوج واضح عند فشل الحذف/الطرد لتشخيص المشكلات.

const GroupSettings = require('../../models/GroupSettings');
const UserWarning   = require('../../models/UserWarning');
const { normalizeArabic, hasLink, isMediaMessage } = require('../../lib/arabic');
const { normalizeUserJid, bareNumber } = require('../../lib/jid');
const logger = require('../../lib/logger');

const notAdminCooldown = new Map(); // groupId -> lastTs (لتقليل رسائل "عيّنني مشرف")
const adminsCache      = new Map(); // groupId -> { ts, adminsNumbers: Set<string> }
const ADMINS_TTL_MS    = 5 * 60 * 1000; // 5 دقائق

function textFromMessage(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    ''
  ).trim();
}

/** إرسال آمن */
async function safeSend(sock, jid, text, extra = {}) {
  try {
    await sock.sendMessage(jid, { text, ...extra });
  } catch (e) {
    logger.warn({ e, jid, text }, 'safeSend failed');
  }
}

/** حذف الرسالة إن أمكن؛ وإلا تذكير بالصلاحيات بشكل محدود */
async function deleteForAllOrWarn(sock, m) {
  const groupId = m.key.remoteJid;
  try {
    await sock.sendMessage(groupId, {
      delete: {
        remoteJid: groupId,
        fromMe: false,
        id: m.key.id,
        participant: m.key.participant || m.participant, // ضروري في القروبات
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
        await safeSend(sock, groupId, '⚠️ لتفعيل الحذف/الحظر يرجى ترقية البوت إلى *مشرف*.');
        notAdminCooldown.set(groupId, now);
      }
    } else {
      logger.warn({ e }, 'deleteForAll failed');
    }
    return false;
  }
}

/** كاش المشرفين بالأرقام العارية */
async function getAdminsNumbersCached(sock, groupId) {
  const now = Date.now();
  const cached = adminsCache.get(groupId);
  if (cached && (now - cached.ts) < ADMINS_TTL_MS) return cached.adminsNumbers;

  const extract = (participants = []) =>
    new Set(
      participants.filter(p => p?.admin).map(p => bareNumber(normalizeUserJid(p.id)))
    );

  try {
    const mdMin = await sock.groupMetadataMinimal(groupId);
    const set = extract(mdMin?.participants);
    adminsCache.set(groupId, { ts: now, adminsNumbers: set });
    return set;
  } catch (e) {
    logger.warn({ e, groupId }, 'getAdminsNumbersCached minimal failed; trying full');
    try {
      const md = await sock.groupMetadata(groupId);
      const set = extract(md?.participants);
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

async function moderateGroupMessage(sock, m) {
  const groupId = m.key?.remoteJid;
  if (!groupId?.endsWith('@g.us')) return false;

  // إعدادات القروب
  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings?.enabled) return false;

  const maxWarnings  = Math.max(1, Number(settings.maxWarnings || 3)); // حد أدنى 1
  const exemptAdmins = settings.exemptAdmins === true; // إن true → لا نعالج المشرفين نهائيًا

  // المرسل (طبع إلى @s.whatsapp.net)
  const fromUserJid = normalizeUserJid(m.key?.participant || m.participant || '');
  if (!fromUserJid) return false;

  // استثناء المشرفين (إن مفعّل)
  if (exemptAdmins) {
    const adminsNumbers = await getAdminsNumbersCached(sock, groupId);
    if (adminsNumbers.has(bareNumber(fromUserJid))) {
      logger.debug?.({ groupId, user: fromUserJid }, 'moderation skipped (admin exempt)');
      return false;
    }
  }

  // محتوى الرسالة
  const raw  = textFromMessage(m);
  const norm = normalizeArabic(raw);

  // هل هناك مخالفة؟
  let violated = false;
  if (!violated && settings.blockLinks && hasLink(raw)) violated = true;
  if (!violated && settings.blockMedia && isMediaMessage(m)) violated = true;
  if (!violated && Array.isArray(settings.bannedWords) && settings.bannedWords.length) {
    const hit = settings.bannedWords.some(w => norm.includes(normalizeArabic(w)));
    if (hit) violated = true;
  }
  if (!violated) return false;

  // زد العدّاد دائمًا عند المخالفة
  let newCount = 1;
  try {
    const doc = await UserWarning.findOneAndUpdate(
      { groupId, userId: fromUserJid },       // نخزن دائمًا بصيغة @s.whatsapp.net
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );
    newCount = doc?.count || 1;
    logger.debug?.({ groupId, user: fromUserJid, count: newCount }, 'warning incremented');
  } catch (e) {
    logger.warn({ e, groupId, user: fromUserJid }, 'warn counter inc failed');
  }

  // حاول حذف الرسالة (ثم أرسل التحذير دائمًا)
  await deleteForAllOrWarn(sock, m);

  if (newCount >= maxWarnings) {
    // الطرد عند الحد
    try {
      await sock.groupParticipantsUpdate(groupId, [fromUserJid], 'remove');
      await UserWarning.deleteOne({ groupId, userId: fromUserJid }).catch(() => {});
      await safeSend(
        sock,
        groupId,
        `🚫 تم حظر @${fromUserJid.split('@')[0]} بعد ${maxWarnings} مخالفات.`,
        { mentions: [fromUserJid] }
      );
    } catch (e) {
      logger.warn({ e, groupId, user: fromUserJid }, 'kick user failed');
      const last = notAdminCooldown.get(groupId) || 0;
      const now  = Date.now();
      if (now - last > 10 * 60 * 1000) {
        await safeSend(sock, groupId, '⚠️ لا أستطيع الحظر بدون صلاحية *مشرف*.');
        notAdminCooldown.set(groupId, now);
      }
    }
  } else {
    await safeSend(sock, groupId, `⚠️ المخالفة ${newCount}/${maxWarnings}: الرجاء الالتزام بالقوانين.`);
  }

  return true;
}

module.exports = { moderateGroupMessage };
