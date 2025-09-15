// src/handlers/messages/moderation.js
// موديريشن القروبات مع استثناء دقيق للمشرفين ومنشن مضبوط.
// يعتمد على: GroupSettings, UserWarning, logger, arabic.js, jid.js

const GroupSettings = require('../../models/GroupSettings');
const UserWarning   = require('../../models/UserWarning');
const { normalizeArabic, hasLink, isMediaMessage } = require('../../lib/arabic');
const { normalizeUserJid, bareNumber } = require('../../lib/jid');
const logger = require('../../lib/logger');

// ثوابت وكاش
const ADMINS_TTL_MS = 5 * 60 * 1000;   // 5 دقائق
const adminsCache   = new Map();        // groupId -> { ts, adminsNumbers:Set }
const remind403     = new Map();        // groupId -> lastTs (لتنبيه نقص الصلاحيات)

/** إرسال آمن */
async function safeSend(sock, jid, content, extra = {}) {
  try {
    await sock.sendMessage(jid, content, extra);
  } catch (e) {
    logger.warn({ e, jid, content }, 'safeSend failed');
  }
}

/** استخراج نص الرسالة الخام */
function textFromMessage(m = {}) {
  const msg = m.message || {};
  if (typeof msg.conversation === 'string') return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;
  for (const k of Object.keys(msg)) {
    const v = msg[k];
    if (v && typeof v.text === 'string') return v.text;
  }
  return '';
}

/** حذف الرسالة المخالفة */
async function deleteOffendingMessage(sock, m) {
  const groupId = m.key.remoteJid;
  try {
    await sock.sendMessage(groupId, {
      delete: {
        remoteJid: groupId,
        fromMe: false,
        id: m.key.id,
        participant: m.key.participant || m.participant, // قد يكون @lid
      },
    });
    return true;
  } catch (e) {
    const code = e?.data || e?.output?.statusCode;
    const msg  = String(e?.message || '').toLowerCase();
    if (code === 403 || msg.includes('forbidden') || msg.includes('not admin')) {
      const last = remind403.get(groupId) || 0;
      const now  = Date.now();
      if (now - last > 10 * 60 * 1000) {
        await safeSend(sock, groupId, { text: '⚠️ لا أستطيع حذف الرسائل — يجب أن أكون *مشرفًا*.' });
        remind403.set(groupId, now);
      }
    } else {
      logger.warn({ e }, 'deleteOffendingMessage failed');
    }
    return false;
  }
}

/** استخرج الرقم من JID (بدون مسافات/أجهزة) */
function numberFromJid(jid = '') {
  const beforeAt = String(jid).split('@')[0] || '';
  return beforeAt.split(':')[0];
}

/** جلب اسم سريع من كاش الاتصالات؛ وإلا نعيد null (المنشن يتكفّل بالرقم) */
function getDisplayNameFast(sock, jid) {
  try {
    const c = sock?.contacts?.[jid] || null;
    const name = c?.name || c?.verifiedName || c?.notify || null;
    return name && String(name).trim() ? String(name).trim() : null;
  } catch {
    return null;
  }
}

/** إبني سطر منشن مضبوط: دائمًا @الرقم، وإن وُجد اسم بشري أضِفه */
function buildMentionLine(displayName, bareNum) {
  const clean = String(bareNum).replace(/\D/g, '');
  const looksNumeric = /^\+?\d[\d\s]*$/.test(displayName || '');
  if (!displayName || looksNumeric) return `@${clean}`;
  return `@${clean} — *${displayName}*`;
}

/** هل المشارك مشرف؟ (تطبيع تعدد الأشكال) */
function participantIsAdmin(p) {
  // بعض الإصدارات: p.admin = 'admin' | 'superadmin' | undefined
  // أخرى: p.admin = true/false أو p.isAdmin = true/false
  if (!p) return false;
  if (p.isAdmin === true) return true;
  if (typeof p.admin === 'boolean') return p.admin;
  if (typeof p.admin === 'string') {
    const v = p.admin.toLowerCase();
    return v === 'admin' || v === 'superadmin';
  }
  return false;
}

/** اجمع Set أرقام المشرفين (صارم) */
async function fetchAdminsSetStrict(sock, groupId) {
  const collect = (participants = []) => new Set(
    (participants || [])
      .filter(participantIsAdmin)
      .map(p => bareNumber(normalizeUserJid(p.id)))
  );

  try {
    const mdMin = await sock.groupMetadataMinimal(groupId);
    const set1 = collect(mdMin?.participants);
    if (set1.size) return set1;
  } catch (e) {
    logger.debug?.({ e }, 'groupMetadataMinimal failed (admins)');
  }

  try {
    const md = await sock.groupMetadata(groupId);
    const set2 = collect(md?.participants);
    return set2;
  } catch (e) {
    logger.debug?.({ e }, 'groupMetadata failed (admins)');
    return new Set();
  }
}

/** كاش المشرفين كأرقام عارية */
async function getAdminsNumbersCached(sock, groupId) {
  const now = Date.now();
  const cached = adminsCache.get(groupId);
  if (cached && (now - cached.ts) < ADMINS_TTL_MS) return cached.adminsNumbers;

  const set = await fetchAdminsSetStrict(sock, groupId);
  adminsCache.set(groupId, { ts: now, adminsNumbers: set });
  return set;
}

/** تحقّق لحظي أدقّ: هل المستخدم مشرف الآن؟ (يجمع بين اللحظي والكاش) */
async function isUserAdmin(sock, groupId, anyUserJid) {
  const targetBare = bareNumber(normalizeUserJid(anyUserJid));

  // محاولة لحظية دقيقة
  try {
    const mdMin = await sock.groupMetadataMinimal(groupId);
    const p = (mdMin?.participants || []).find(x => bareNumber(normalizeUserJid(x.id)) === targetBare);
    if (participantIsAdmin(p)) return true;
  } catch {}

  try {
    const md = await sock.groupMetadata(groupId);
    const p = (md?.participants || []).find(x => bareNumber(normalizeUserJid(x.id)) === targetBare);
    if (participantIsAdmin(p)) return true;
  } catch {}

  // كاش
  const cached = await getAdminsNumbersCached(sock, groupId);
  return cached.has(targetBare);
}

/** إيجاد JID الحقيقي كما يراه واتساب (قد يكون @lid) */
async function resolveParticipantJid(sock, groupId, anyUserJid) {
  const targetBare = bareNumber(normalizeUserJid(anyUserJid));
  try {
    const mdMin = await sock.groupMetadataMinimal(groupId);
    const found = (mdMin?.participants || []).find((p) => bareNumber(normalizeUserJid(p.id)) === targetBare);
    if (found?.id) return found.id;
  } catch {}
  try {
    const md = await sock.groupMetadata(groupId);
    const found = (md?.participants || []).find((p) => bareNumber(normalizeUserJid(p.id)) === targetBare);
    if (found?.id) return found.id;
  } catch {}
  return normalizeUserJid(anyUserJid);
}

/** المعالجة الأساسية للرسائل في القروبات */
async function moderateGroupMessage(sock, m) {
  const groupId = m?.key?.remoteJid;
  if (!groupId?.endsWith('@g.us')) return false;

  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings?.enabled) return false;

  // يجب أن يكون لدينا participant في رسائل القروبات
  const senderRaw = m.key?.participant || m.participant;
  if (!senderRaw) {
    logger.warn({ mKey: m?.key }, 'moderation: missing participant in group message');
    return false;
  }

  const fromUserJid = normalizeUserJid(senderRaw);
  const senderBare  = bareNumber(fromUserJid);

  // === استثناء المشرفين (قطعي) ===
  const exemptAdmins = settings?.exemptAdmins !== false; // افتراضيًا true
  if (exemptAdmins) {
    const adminNow = await isUserAdmin(sock, groupId, fromUserJid);
    if (adminNow) {
      logger.debug?.({ groupId, user: fromUserJid }, 'skip moderation: admin exempt');
      return false; // لا حذف ولا تحذير ولا حظر
    }
  }

  // إعدادات
  const maxWarnings = Math.max(1, Number(settings.maxWarnings || 3));

  // كشف المخالفة
  const raw  = textFromMessage(m);
  const norm = normalizeArabic(raw);

  let violated = false;
  if (!violated && settings.blockLinks && hasLink(raw)) violated = true;
  if (!violated && settings.blockMedia && isMediaMessage(m)) violated = true;
  if (!violated && Array.isArray(settings.bannedWords) && settings.bannedWords.length) {
    const hit = settings.bannedWords.some(w => norm.includes(normalizeArabic(w)));
    if (hit) violated = true;
  }
  if (!violated) return false;

  // عدّاد التحذيرات
  let newCount = 1;
  try {
    const doc = await UserWarning.findOneAndUpdate(
      { groupId, userId: fromUserJid },
      { $inc: { count: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    newCount = doc?.count || 1;
    logger.debug?.({ groupId, user: fromUserJid, count: newCount }, 'warning incremented');
  } catch (e) {
    logger.warn({ e, groupId, user: fromUserJid }, 'warn counter inc failed');
  }

  // بناء المنشن: @الرقم (دائمًا) + اسم إن توفر
  const displayFast = getDisplayNameFast(sock, fromUserJid);
  const mentionText = buildMentionLine(displayFast, senderBare);

  // جهّز mentions بالـJID الحقيقي (@lid لو لازم)
  const realParticipantJid = await resolveParticipantJid(sock, groupId, fromUserJid);
  const mentionsArr = [realParticipantJid];

  // احذف المخالفة أولًا (إن أمكن)
  await deleteOffendingMessage(sock, m);

  if (newCount >= maxWarnings) {
    // حظر (طالما ليس مشرفًا — تمت التصفية مسبقًا)
    try {
      await sock.groupParticipantsUpdate(groupId, [realParticipantJid], 'remove');
      await UserWarning.deleteOne({ groupId, userId: fromUserJid }).catch(() => {});
      await safeSend(
        sock,
        groupId,
        { text: `🚫 تم حظر ${mentionText} بعد ${maxWarnings} مخالفات.`, mentions: mentionsArr },
        { quoted: m }
      );
      logger.info({ groupId, user: fromUserJid, participantJid: realParticipantJid }, 'kick success');
    } catch (e) {
      logger.warn({ e, groupId, user: fromUserJid }, 'kick user failed');
      const last = remind403.get(groupId) || 0;
      const now  = Date.now();
      if (now - last > 10 * 60 * 1000) {
        await safeSend(sock, groupId, { text: '⚠️ لا أستطيع الحظر — تأكد أنني *مشرف* ولدي صلاحية إدارة الأعضاء.' });
        remind403.set(groupId, now);
      }
    }
  } else {
    // تحذير
    await safeSend(
      sock,
      groupId,
      { text: `⚠️ المخالفة ${newCount}/${maxWarnings}: ${mentionText}، الرجاء الالتزام بالقوانين.`, mentions: mentionsArr },
      { quoted: m }
    );
    logger.info({ groupId, user: fromUserJid, count: newCount }, 'warning message sent');
  }

  return true;
}

module.exports = { moderateGroupMessage };
