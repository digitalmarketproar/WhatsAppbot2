// src/handlers/messages/moderation.js
// موديريشن القروبات باعتماد استثناء "القائمة البيضاء" فقط (بدون أي تمييز للمشرفين).
// يعتمد على: GroupSettings, UserWarning, logger, arabic.js, jid.js

const GroupSettings = require('../../models/GroupSettings');
const UserWarning   = require('../../models/UserWarning');
const { normalizeArabic, hasLink, isMediaMessage } = require('../../lib/arabic');
const { normalizeUserJid, bareNumber } = require('../../lib/jid');
const logger = require('../../lib/logger');

// تنبيه نقص الصلاحيات (لتخفيف الإزعاج)
const remind403 = new Map(); // groupId -> lastTs

/** إرسال آمن */
async function safeSend(sock, jid, content, extra = {}) {
  try { await sock.sendMessage(jid, content, extra); }
  catch (e) { logger.warn({ e, jid, content }, 'safeSend failed'); }
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
async function deleteOffendingMessage(sock, m, realParticipantJid) {
  const groupId = m.key.remoteJid;
  try {
    await sock.sendMessage(groupId, {
      delete: {
        remoteJid: groupId,
        fromMe: false,
        id: m.key.id,
        participant: realParticipantJid || m.key.participant || m.participant,
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

/** جلب اسم سريع من كاش الاتصالات؛ وإلا نعيد null (المنشن يتكفّل بالرقم) */
function getDisplayNameFast(sock, jid) {
  try {
    const c = sock?.contacts?.[jid] || null;
    const name = c?.name || c?.verifiedName || c?.notify || null;
    return name && String(name).trim() ? String(name).trim() : null;
  } catch { return null; }
}

/** إبني سطر منشن مضبوط: دائمًا @الرقم، وإن وُجد اسم بشري أضِفه */
function buildMentionLine(displayName, bareNum) {
  const clean = String(bareNum).replace(/\D/g, '');
  const looksNumeric = /^\+?\d[\d\s]*$/.test(displayName || '');
  if (!displayName || looksNumeric) return `@${clean}`;
  return `@${clean} — *${displayName}*`;
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

/** حوّل أي قيمة إلى bare number منقّى من أي رموز */
function toBareNum(v) {
  if (!v) return '';
  // يدعم إدخال jid (xxx@domain) أو رقم صِرف أو participantPn
  const s = String(v);
  const beforeAt = s.includes('@') ? s.split('@')[0] : s;
  return beforeAt.replace(/\D/g, '');
}

/** فحص القائمة البيضاء: يطابق ضد عدة مرشّحين للمرسل للتغلب على فروقات LID/MD */
function inWhitelist(settings, candidates = []) {
  const list = Array.isArray(settings?.whitelistNumbers) ? settings.whitelistNumbers.map(toBareNum) : [];
  if (!list.length) return false;
  for (const c of candidates) {
    const b = toBareNum(c);
    if (b && list.includes(b)) return true;
  }
  return false;
}

/** المعالجة الأساسية للرسائل في القروبات */
async function moderateGroupMessage(sock, m) {
  const groupId = m?.key?.remoteJid;
  if (!groupId?.endsWith('@g.us')) return false;

  const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
  if (!settings?.enabled) return false;

  const senderRaw = m.key?.participant || m.participant;
  if (!senderRaw) {
    logger.warn({ mKey: m?.key }, 'moderation: missing participant in group message');
    return false;
  }

  // جهّز كل صيغ الهوية الممكنة للمرسل
  const fromUserJid       = normalizeUserJid(senderRaw);                 // قد يكون lid ← s.whatsapp
  const realParticipantJid= await resolveParticipantJid(sock, groupId, fromUserJid); // JID الفعلي في القروب
  const participantPn     = m?.key?.participantPn || null;               // إن وُجد (من لوجك)
  const senderBare        = toBareNum(fromUserJid);

  // ✅ استثناء بالقائمة البيضاء فقط (Early Return) مع تعدد المرشّحين
  // يشمل: JID الفعلي، JID الخام، participantPn (إن وُجد)
  const wlHit = inWhitelist(settings, [realParticipantJid, fromUserJid, participantPn]);
  if (wlHit) {
    logger.debug?.({
      groupId, user: realParticipantJid,
      candidates: { realParticipantJid, fromUserJid, participantPn },
      whitelist: settings?.whitelistNumbers
    }, 'skip moderation: whitelist exempt');
    return false;
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
      { groupId, userId: realParticipantJid },
      { $inc: { count: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    newCount = doc?.count || 1;
    logger.debug?.({ groupId, user: realParticipantJid, count: newCount }, 'warning incremented');
  } catch (e) {
    logger.warn({ e, groupId, user: realParticipantJid }, 'warn counter inc failed');
  }

  // بناء المنشن: @الرقم (دائمًا) + اسم إن توفر
  const displayFast = getDisplayNameFast(sock, realParticipantJid);
  const mentionText = buildMentionLine(displayFast, senderBare);
  const mentionsArr = [realParticipantJid];

  // احذف المخالفة أولًا (إن أمكن)
  await deleteOffendingMessage(sock, m, realParticipantJid);

  if (newCount >= maxWarnings) {
    // حظر
    try {
      await sock.groupParticipantsUpdate(groupId, [realParticipantJid], 'remove');
      await UserWarning.deleteOne({ groupId, userId: realParticipantJid }).catch(() => {});
      await safeSend(
        sock,
        groupId,
        { text: `🚫 تم حظر ${mentionText} بعد ${maxWarnings} مخالفات.`, mentions: mentionsArr },
        { quoted: m }
      );
      logger.info({ groupId, user: realParticipantJid }, 'kick success');
    } catch (e) {
      logger.warn({ e, groupId, user: realParticipantJid }, 'kick user failed');
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
    logger.info({ groupId, user: realParticipantJid, count: newCount }, 'warning message sent');
  }

  return true;
}

module.exports = { moderateGroupMessage };
