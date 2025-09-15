// src/handlers/messages/moderation.js
// موديريشن القروبات مع منشن صحيح واسم/رقم واضح، واستثناء للمشرفين.
//
// ✅ الميزات:
// - حذف رسالة المخالفة أولًا لتخفيف التشويش.
// - تحذير 1..N ثم حظر في التحذير N (افتراضيًا 3).
// - منشن صحيح عبر تمرير mentions + كتابة @الرقم في النص.
// - عرض الاسم إن توفر وإلا نعرض الرقم.
// - استثناء المشرفين (مفعّل افتراضيًا عبر GroupSettings.exemptAdmins).
// - التعامل مع JID بنمط @lid أو @s.whatsapp.net بشكل صحيح.
//
// ملاحظات:
// - يعتمد على: GroupSettings, UserWarning, logger, arabic.js, jid.js
// - مكتبة Baileys: sock.sendMessage / groupMetadata / groupParticipantsUpdate.

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

/** استخراج نص الرسالة الخام */
function textFromMessage(m = {}) {
  const msg = m.message || {};
  if (typeof msg.conversation === 'string') return msg.conversation;
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage && msg.imageMessage.caption) return msg.imageMessage.caption;
  if (msg.videoMessage && msg.videoMessage.caption) return msg.videoMessage.caption;
  if (msg.documentMessage && msg.documentMessage.caption) return msg.documentMessage.caption;
  // جرّب أي حقل نصي معروف آخر
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
      // ليس مشرفًا — لا تكرر التنبيه كثيرًا
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

/** كاش المشرفين كأرقام عارية لسرعة التحقق من الإعفاء */
async function getAdminsNumbersCached(sock, groupId) {
  const now = Date.now();
  const cached = adminsCache.get(groupId);
  if (cached && (now - cached.ts) < ADMINS_TTL_MS) return cached.adminsNumbers;

  const extract = (participants = []) =>
    new Set(
      participants
        .filter(p => p?.admin) // Baileys يضع admin=true للمشرفين
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

/** جلب اسم العرض من القروب، ثم getName، ثم رجوع لرقم +XXXXXXXX */
async function getDisplayNameInGroup(sock, groupId, anyUserJid) {
  const targetBare = bareNumber(normalizeUserJid(anyUserJid));
  try {
    const mdMin = await sock.groupMetadataMinimal(groupId);
    const p = (mdMin?.participants || []).find((x) => bareNumber(normalizeUserJid(x.id)) === targetBare);
    const name = p?.notify || p?.name || p?.verifiedName;
    if (name && String(name).trim()) return String(name).trim();
  } catch {}
  try {
    const md = await sock.groupMetadata(groupId);
    const p = (md?.participants || []).find((x) => bareNumber(normalizeUserJid(x.id)) === targetBare);
    const name = p?.notify || p?.name || p?.verifiedName;
    if (name && String(name).trim()) return String(name).trim();
  } catch {}
  try {
    if (typeof sock.getName === 'function') {
      const n = sock.getName(normalizeUserJid(anyUserJid));
      if (n && String(n).trim()) return String(n).trim();
    }
  } catch {}
  return '+' + targetBare;
}

/** إيجاد معرف العضو الحقيقي كما يراه واتساب في القروب (قد يكون @lid) */
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

/** يبني نص منشن لا يكرر المعرف: إن كان الاسم رقمًا، فقط @الرقم؛ غير ذلك @الرقم — *الاسم* */
function buildMentionLine(displayName, bareNum) {
  const looksNumeric = /^\+?\d[\d\s]*$/.test(displayName || '');
  if (looksNumeric) return `@${bareNum}`;
  return `@${bareNum} — *${displayName}*`;
}

/** المعالجة الأساسية للرسائل في القروبات */
async function moderateGroupMessage(sock, m) {
  const groupId = m?.key?.remoteJid;
  if (!groupId?.endsWith('@g.us')) return false;

  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings?.enabled) return false;

  const maxWarnings  = Math.max(1, Number(settings.maxWarnings || 3));
  // ✅ افتراضيًا: إعفاء المشرفين (إلا إذا ضُبط صراحةً على false في DB)
  const exemptAdmins = settings?.exemptAdmins !== false;

  // المرسل (نحوّل إلى @s.whatsapp.net للحفظ والثبات)
  const fromUserJid = normalizeUserJid(m.key?.participant || m.participant || m.key?.remoteJid || '');
  if (!fromUserJid) return false;

  // إعفاء المشرفين إن كان مفعّلًا
  if (exemptAdmins) {
    const adminsNumbers = await getAdminsNumbersCached(sock, groupId);
    if (adminsNumbers.has(bareNumber(fromUserJid))) {
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

  const bare = bareNumber(fromUserJid);
  const displayName = await getDisplayNameInGroup(sock, groupId, fromUserJid);
  const mentionLine = buildMentionLine(displayName, bare);
  const mentionsArr = [normalizeUserJid(fromUserJid)]; // لإجبار التلوين الصحيح

  // احذف المخالفة أولًا
  await deleteOffendingMessage(sock, m);

  if (newCount >= maxWarnings) {
    // حظر
    try {
      const participantJid = await resolveParticipantJid(sock, groupId, fromUserJid);
      await sock.groupParticipantsUpdate(groupId, [participantJid], 'remove');
      await UserWarning.deleteOne({ groupId, userId: fromUserJid }).catch(() => {});
      await safeSend(sock, groupId, { text: `🚫 تم حظر ${mentionLine} بعد ${maxWarnings} مخالفات.`, mentions: mentionsArr }, { quoted: m });
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
    // تحذير
    await safeSend(sock, groupId, { text: `⚠️ المخالفة ${newCount}/${maxWarnings}: ${mentionLine}، الرجاء الالتزام بالقوانين.`, mentions: mentionsArr }, { quoted: m });
    logger.info({ groupId, user: fromUserJid, count: newCount }, 'warning message sent');
  }

  return true;
}

module.exports = { moderateGroupMessage };
