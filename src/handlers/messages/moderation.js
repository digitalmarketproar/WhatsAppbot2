// src/handlers/messages/moderation.js
// موديريشن القروبات (نسخة مُثبتة):
// - يزيد عدّاد التحذيرات دائمًا عند المخالفة.
// - يحذف رسالة المخالفة إن أمكن، ثم يرسل التحذير دائمًا.
// - عند بلوغ الحد: يحاول الحظر باستخدام JID الفعلي من participants (قد يكون @lid).
// - استثناء المشرفين اختياري عبر GroupSettings.exemptAdmins (true = استثناء).
// - لوج واضح لتشخيص المشاكل.

const GroupSettings = require('../../models/GroupSettings');
const UserWarning   = require('../../models/UserWarning');
const { normalizeArabic, hasLink, isMediaMessage } = require('../../lib/arabic');
const { normalizeUserJid, bareNumber } = require('../../lib/jid');
const logger = require('../../lib/logger');

const ADMINS_TTL_MS = 5 * 60 * 1000; // 5 دقائق
const adminsCache   = new Map();      // groupId -> { ts, adminsNumbers:Set }
const remind403     = new Map();      // groupId -> lastTs (تقليل رسائل "اجعلني مشرف")

function textFromMessage(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    ''
  ).trim();
}

async function safeSend(sock, jid, text, extra = {}) {
  try { await sock.sendMessage(jid, { text, ...extra }); }
  catch (e) { logger.warn({ e, jid, text }, 'safeSend failed'); }
}

/** حذف رسالة المخالفة (إن أمكن). */
async function deleteOffendingMessage(sock, m) {
  const groupId = m.key.remoteJid;
  try {
    await sock.sendMessage(groupId, {
      delete: {
        remoteJid: groupId,
        fromMe: false,
        id: m.key.id,
        participant: m.key.participant || m.participant, // ضروري في القروبات (قد يكون @lid)
      }
    });
    return true;
  } catch (e) {
    const code = e?.data || e?.output?.statusCode;
    const msg  = String(e?.message || '').toLowerCase();
    if (code === 403 || msg.includes('forbidden') || msg.includes('not-authorized')) {
      const last = remind403.get(groupId) || 0;
      const now  = Date.now();
      if (now - last > 10 * 60 * 1000) {
        await safeSend(sock, groupId, '⚠️ لتفعيل الحذف/الحظر يرجى ترقية البوت إلى *مشرف*.');
        remind403.set(groupId, now);
      }
    } else {
      logger.warn({ e }, 'deleteOffendingMessage failed');
    }
    return false;
  }
}

/** جلب كاش المشرفين كأرقام عارية (لاستثناءهم لو مطلوب). */
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
    logger.warn({ e, groupId }, 'getAdminsNumbersCached(minimal) failed, fallback full');
    try {
      const md = await sock.groupMetadata(groupId);
      const set = extract(md?.participants);
      adminsCache.set(groupId, { ts: now, adminsNumbers: set });
      return set;
    } catch (e2) {
      logger.warn({ e2, groupId }, 'getAdminsNumbersCached(full) failed');
      const empty = new Set();
      adminsCache.set(groupId, { ts: now, adminsNumbers: empty });
      return empty;
    }
  }
}

/**
 * إيجاد JID الفعلي للعضو كما تراه واتساب في القروب (قد يكون @lid).
 * نطابق بالرقم العاري، ثم نعيد participant.id كما هو.
 */
async function resolveParticipantJid(sock, groupId, anyUserJid) {
  const targetBare = bareNumber(normalizeUserJid(anyUserJid));
  try {
    // minimal أخف عادة ويحتوي قائمة participants
    const mdMin = await sock.groupMetadataMinimal(groupId);
    const found = (mdMin?.participants || []).find(p =>
      bareNumber(normalizeUserJid(p.id)) === targetBare
    );
    if (found?.id) return found.id;
  } catch {}
  try {
    const md = await sock.groupMetadata(groupId);
    const found = (md?.participants || []).find(p =>
      bareNumber(normalizeUserJid(p.id)) === targetBare
    );
    if (found?.id) return found.id;
  } catch {}
  // فشلنا — أعِد JID مطبّعًا؛ قد ينجح أحيانًا
  return normalizeUserJid(anyUserJid);
}

async function moderateGroupMessage(sock, m) {
  const groupId = m.key?.remoteJid;
  if (!groupId?.endsWith('@g.us')) return false;

  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings?.enabled) return false;

  const maxWarnings  = Math.max(1, Number(settings.maxWarnings || 3));
  const exemptAdmins = settings.exemptAdmins === true;

  // المرسل (نحوّل دائمًا إلى @s.whatsapp.net للحفظ في DB)
  const fromUserJid = normalizeUserJid(m.key?.participant || m.participant || '');
  if (!fromUserJid) return false;

  // استثناء المشرفين (لو مفعل)
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

  // ✳️ زد العداد دائمًا عند المخالفة
  let newCount = 1;
  try {
    const doc = await UserWarning.findOneAndUpdate(
      { groupId, userId: fromUserJid }, // نخزن دائمًا بصيغة @s.whatsapp.net
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );
    newCount = doc?.count || 1;
    logger.debug?.({ groupId, user: fromUserJid, count: newCount }, 'warning incremented');
  } catch (e) {
    logger.warn({ e, groupId, user: fromUserJid }, 'warn counter inc failed');
  }

  // نحذف رسالة المخالفة (إن أمكن) — لكن لن نوقف التحذير في كل الأحوال
  await deleteOffendingMessage(sock, m);

  // أرسل التحذير أو نفّذ الحظر
  if (newCount >= maxWarnings) {
    try {
      // استخدم JID الفعلي في participants (قد يكون @lid)
      const participantJid = await resolveParticipantJid(sock, groupId, fromUserJid);

      await sock.groupParticipantsUpdate(groupId, [participantJid], 'remove');

      // نظّف السجل ثم أعلن الحظر
      await UserWarning.deleteOne({ groupId, userId: fromUserJid }).catch(() => {});
      await safeSend(sock, groupId, `🚫 تم حظر @${fromUserJid.split('@')[0]} بعد ${maxWarnings} مخالفات.`, {
        mentions: [fromUserJid]
      });
    } catch (e) {
      logger.warn({ e, groupId, user: fromUserJid }, 'kick user failed');
      const last = remind403.get(groupId) || 0;
      const now  = Date.now();
      if (now - last > 10 * 60 * 1000) {
        await safeSend(sock, groupId, '⚠️ لا أستطيع الحظر — تأكد أن البوت *مشرف* وله صلاحية إدارة الأعضاء.');
        remind403.set(groupId, now);
      }
    }
  } else {
    await safeSend(sock, groupId, `⚠️ المخالفة ${newCount}/${maxWarnings}: الرجاء الالتزام بالقوانين.`);
  }

  return true;
}

module.exports = { moderateGroupMessage };
