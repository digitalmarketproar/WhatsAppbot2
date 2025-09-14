// src/handlers/groups/index.js
//
// ترحيب/وداع بأقل استهلاك للموارد:
// - نجلب subject للقروب مرة واحدة عبر groupMetadata.
// - لجلب اسم العضو نقرأ من sock.contacts[jid] (name / verifiedName / notify).
// - إن لم يتوفر اسم، نعرض منشن @الرقم (مع mentions ليظهر الاسم/الرقم داخل واتساب).
//
// ملاحظة: نعتمد على إعدادات القروب من GroupSettings (enabled, welcomeEnabled, farewellEnabled, rules).

const GroupSettings = require('../../models/GroupSettings');
const logger = require('../../lib/logger');

// استخرج الرقم من JID (يحذف اللاحقة وأي لاحقة جهاز)
function numberFromJid(jid = '') {
  //  "9677XXXX@s.whatsapp.net"  أو  "9677XXXX:1@s.whatsapp.net"
  const beforeAt = String(jid).split('@')[0] || '';
  return beforeAt.split(':')[0];
}

// جلب اسم العرض بطريقة سريعة بدون اتصالات إضافية:
// - نعتمد على sock.contacts[jid] إن وُجد (name / verifiedName / notify).
// - وإلا نعيد @الرقم (ويُرفق mention لاحقًا).
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

// جلب اسم القروب (subject) مرة واحدة لكل حدث
async function getGroupSubjectOnce(sock, groupId) {
  try {
    const meta = await sock.groupMetadata(groupId);
    if (meta?.subject && String(meta.subject).trim()) {
      return { subject: meta.subject.trim(), meta };
    }
    return { subject: 'المجموعة', meta };
  } catch (e) {
    logger.warn({ e, groupId }, 'groups: groupMetadata failed, fallback subject');
    return { subject: 'المجموعة', meta: null };
  }
}

// تنسيق رسالة الترحيب
function formatWelcome(name, subject, rules) {
  const lines = [
    `🎉 أهلاً وسهلاً *${name}*!`,
    `مرحبًا بك في *${subject}*.`,
    '',
  ];
  if (rules && String(rules).trim()) {
    lines.push('📜 *قوانين المجموعة*:', String(rules).trim().slice(0, 600));
  } else {
    lines.push('📜 *قوانين عامة*: الرجاء الالتزام بالأدب العام وعدم إرسال الروابط أو الوسائط المخالفة.');
  }
  lines.push('', 'نتمنى لك وقتًا ممتعًا!');
  return lines.join('\n');
}

// تنسيق رسالة الوداع
function formatFarewell(name, subject) {
  return [
    `👋 وداعًا *${name}*.`,
    `سعدنا بوجودك معنا في *${subject}*. نتمنى لك التوفيق دائمًا.`,
  ].join('\n');
}

// المراقب الرئيسي لحدث إضافة/خروج أعضاء القروب
function registerGroupParticipantHandler(sock) {
  sock.ev.on('group-participants.update', async (ev) => {
    // ev: { id: groupJid, participants: [jid...], action: 'add'|'remove'|'promote'|'demote' }
    try {
      const groupId = ev?.id;
      const parts = Array.isArray(ev?.participants) ? ev.participants : [];
      if (!groupId || !groupId.endsWith('@g.us') || parts.length === 0) return;

      const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
      if (!settings?.enabled) return;

      // نجلب subject مرة واحدة
      const { subject } = await getGroupSubjectOnce(sock, groupId);

      // نجهّز mentions دائمًا لضمان ظهور المنشن والاسم/الرقم داخل واتساب
      const mentions = parts;

      if (ev.action === 'add' && settings.welcomeEnabled) {
        for (const jid of parts) {
          const name = getDisplayNameFast(sock, jid);
          const text = formatWelcome(name, subject, settings.rules);
          await sock.sendMessage(groupId, { text, mentions });
        }
      }

      if (ev.action === 'remove' && settings.farewellEnabled) {
        for (const jid of parts) {
          const name = getDisplayNameFast(sock, jid);
          const text = formatFarewell(name, subject);
          await sock.sendMessage(groupId, { text, mentions });
        }
      }

      // (اختياري لاحقًا) دعم promote/demote برسائل خفيفة

    } catch (e) {
      // لا نوقف التشغيل إن فشل اسم عضو واحد — نستخدم منشن @رقم كحل أخير
      logger.warn({ e, ev }, 'group-participants.update handler failed');
    }
  });
}

module.exports = { registerGroupParticipantHandler };
