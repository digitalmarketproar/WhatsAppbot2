// src/handlers/messages/moderation.js
// موديريشن القروبات مع استثناء حقيقي للمشرفين ومنشن مضبوط (اسم/رقم)
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

/** جلب اسم سريع من كاش الاتصالات؛ وإلا نعيد null (نترك المنشن يتكفّل بالرقم) */
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
  // bareNum يجب أن يكون أرقام فقط (بدون مسافات أو رموز)
  const clean = String(bareNum).replace(/\D/g, '');
  // إن كان displayName مجرد رقم/أرقام، لا نكرّر الاسم
  const looksNumeric = /^\+?\d[\d\s]*$/.test(displayName || '');
  if (!displayName || looksNumeric) return `@${clean}`;
  return `@${clean} — *${displayName}*`;
}

/** كاش المشرفين كأرقام عارية */
async function getAdminsNumbersCached(sock, groupId) {
  const now = Date.now();
  const cached = adminsCache.get(groupId);
  if (cached && (now - cached.ts) < ADMINS_TTL_MS) return cached.adminsNumbers;

  const extract = (participants = []) =>
    new Set(
      (participants || [])
        // في Baileys تكون القيمة 'admin' أو 'superadmin' أو undefined
        .filter(p => !!p?.admin)
        .map(p => bareNumber(normalizeUserJid(p.id)))
    );

  try {
    const mdMin = await sock.groupMetadataMinimal(groupId);
    const set = extract(mdMin?.participants);
    adminsCache.set(groupId, { ts: now, adminsNumbers: set });
    return set;
  } catch {}
  try {
    const md = await sock.groupMetadata(groupId);
    const set = extract(md?.participants);
    adminsCache.set(groupId, { ts: now, adminsNumbers: set });
    return set;
  } catch {}
  return new Set();
}

/** تحقّق لحظي أدقّ: هل المستخدم مشرف الآن؟ */
async function isUserAdmin(sock, groupId, anyUserJid) {
  const targetBare = bareNumber(normalizeUserJid(anyUserJid));
  try {
    const mdMin = await sock.groupMetadataMinimal(groupId);
    const p = (mdMin?.participants || []).find(x => bareNumber(normalizeUserJid(x.id)) === targetBare);
    return !!p?.admin; // 'admin' | 'superadmin' | undefined
  } catch {}
  try {
    const md = await sock.groupMetadata(groupId);
    const p = (md?.participants || []).find(x => bareNumber(normalizeUserJid(x.id)) === targetBare);
    return !!p?.admin;
  } catch {}
  // كFallback: استخدم الكاش
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

  const maxWarnings  = Math.max(1, Number(settings.maxWarnings || 3));
  const exemptAdmins = settings?.exemptAdmins !== false; // افتراضيًا true

  // استخرج المرسل بثبات: في القروبات يجب أن يوجد participant
  const senderRaw = m.key?.participant || m.participant;
  if (!senderRaw) {
    // كحالة نادرة جدًا، نتوقّف بدلًا من استخدام groupId
    logger.warn({ mKey: m?.key }, 'moderation: missing participant in group message');
    return false;
  }

  const fromUserJid = normalizeUserJid(senderRaw);
  const senderBare  = bareNumber(fromUserJid);

  // استثناء المشرفين (قطعي)
  if (exemptAdmins) {
    const adminNow = await isUserAdmin(sock, groupId, fromUserJid);
    if (adminNow) {
      logger.debug?.({ groupId, user: fromUserJid }, 'skip moderation: admin exempt');
      return false;
    }
  }

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
