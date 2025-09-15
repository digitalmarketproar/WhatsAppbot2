// src/handlers/messages/moderation.js
// موديريشن القروبات مع منشن صحيح واسم/رقم واضح، واستثناء للمشرفين.
//
// ✅ الميزات:
// - حذف رسالة المخالفة أولًا لتخفيف التشويش.
// - تحذير 1..N ثم حظر في التحذير N (افتراضيًا 3).
// - منشن صحيح عبر تمرير mentions + كتابة @الرقم في النص.
// - عرض الاسم إن توفر وإلا نعرض @الرقم.
// - استثناء المشرفين (مفعّل افتراضيًا عبر GroupSettings.exemptAdmins).
// - التعامل مع JID بنمط @lid أو @s.whatsapp.net بشكل صحيح.

const GroupSettings = require('../../models/GroupSettings');
const UserWarning   = require('../../models/UserWarning');
const { normalizeArabic, hasLink, isMediaMessage } = require('../../lib/arabic');
const { normalizeUserJid, bareNumber } = require('../../lib/jid');
const logger = require('../../lib/logger');

// حافظات بسيطة
const ADMINS_TTL_MS = 5 * 60 * 1000;   // 5 دقائق
const adminsCache   = new Map();        // groupId -> { ts, adminsNumbers:Set }
const remind403     = new Map();        // groupId -> lastTs (لتنبيه أن البوت ليس مشرفًا أحيانًا)

/** إرسال آمن */
async function safeSend(sock, jid, content, extra = {}) {
  try {
    await sock.sendMessage(jid, content, extra);
  } catch (e) {
    logger.warn({ e, jid, content }, 'safeSend failed');
  }
}

/** استخراج الرقم من JID */
function numberFromJid(jid = '') {
  const beforeAt = String(jid).split('@')[0] || '';
  return beforeAt.split(':')[0];
}

/** جلب اسم العرض بسرعة من الكاش وإلا @الرقم */
function getDisplayNameFast(sock, jid) {
  try {
    const c = sock?.contacts?.[jid] || null;
    const name =
      c?.name ||
      c?.verifiedName ||
      c?.notify ||
      null;
    return name && String(name).trim()
      ? name.trim()
      : `@${numberFromJid(jid)}`;
  } catch {
    return `@${numberFromJid(jid)}`;
  }
}

/** استخراج نص الرسالة الخام */
function textFromMessage(m = {}) {
  const msg = m.message || {};
  if (typeof msg.conversation === 'string') return msg.conversation;
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage && msg.imageMessage.caption) return msg.imageMessage.caption;
  if (msg.videoMessage && msg.videoMessage.caption) return msg.videoMessage.caption;
  if (msg.documentMessage && msg.documentMessage.caption) return msg.documentMessage.caption;
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
        participant: m.key.participant || m.participant,
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

/** كاش المشرفين */
async function getAdminsNumbersCached(sock, groupId) {
  const now = Date.now();
  const cached = adminsCache.get(groupId);
  if (cached && (now - cached.ts) < ADMINS_TTL_MS) return cached.adminsNumbers;

  const extract = (participants = []) =>
    new Set(
      participants
        .filter(p => p?.admin)
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

/** إيجاد JID العضو الحقيقي كما يراه واتساب */
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

/** المعالجة الأساسية */
async function moderateGroupMessage(sock, m) {
  const groupId = m?.key?.remoteJid;
  if (!groupId?.endsWith('@g.us')) return false;

  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings?.enabled) return false;

  const maxWarnings  = Math.max(1, Number(settings.maxWarnings || 3));
  const exemptAdmins = settings?.exemptAdmins !== false;

  const fromUserJid = normalizeUserJid(m.key?.participant || m.participant || m.key?.remoteJid || '');
  if (!fromUserJid) return false;

  if (exemptAdmins) {
    const adminsNumbers = await getAdminsNumbersCached(sock, groupId);
    if (adminsNumbers.has(bareNumber(fromUserJid))) {
      logger.debug?.({ groupId, user: fromUserJid }, 'skip moderation: admin exempt');
      return false;
    }
  }

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

  const nameOrMention = getDisplayNameFast(sock, fromUserJid);
  const mentionsArr = [normalizeUserJid(fromUserJid)];

  await deleteOffendingMessage(sock, m);

  if (newCount >= maxWarnings) {
    try {
      const participantJid = await resolveParticipantJid(sock, groupId, fromUserJid);
      await sock.groupParticipantsUpdate(groupId, [participantJid], 'remove');
      await UserWarning.deleteOne({ groupId, userId: fromUserJid }).catch(() => {});
      await safeSend(sock, groupId, { text: `🚫 تم حظر ${nameOrMention} بعد ${maxWarnings} مخالفات.`, mentions: mentionsArr }, { quoted: m });
      logger.info({ groupId, user: fromUserJid, participantJid }, 'kick success');
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
    await safeSend(sock, groupId, { text: `⚠️ المخالفة ${newCount}/${maxWarnings}: ${nameOrMention}، الرجاء الالتزام بالقوانين.`, mentions: mentionsArr }, { quoted: m });
    logger.info({ groupId, user: fromUserJid, count: newCount }, 'warning message sent');
  }

  return true;
}

module.exports = { moderateGroupMessage };
