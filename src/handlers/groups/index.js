// src/handlers/groups/index.js
const GroupSettings = require('../../models/GroupSettings');
const { normalizeUserJid, bareNumber } = require('../../lib/jid');
const logger = require('../../lib/logger');

/**
 * محاولة قوية لجلب اسم العرض:
 * 1) إن توفّر sock.getName() نستخدمه.
 * 2) نحاول إيجاده داخل groupMetadata(participants) بعد تطبيع JID.
 * 3) نحاول onWhatsApp(jid) و onWhatsApp(number) لاستخراج notify/pushName/verifiedName إن توفرت.
 * 4) fallback: نُرجع +الرقم.
 */
async function getDisplayName(sock, groupId, rawJid) {
  const userJid = normalizeUserJid(rawJid);
  const num = '+' + bareNumber(userJid);

  try {
    // 1) بعض إصدارات Baileys توفر getName
    if (typeof sock.getName === 'function') {
      const n = sock.getName(userJid);
      if (n) return n;
    }
  } catch {}

  // 2) حاول عبر groupMetadata (مرّة واحدة لكل حدث مقبولة)
  try {
    const md = await sock.groupMetadata(groupId);
    if (Array.isArray(md?.participants)) {
      // نقارن بعد التطبيع أو بالأرقام العارية لضمان التطابق
      const p = md.participants.find(px => {
        if (!px?.id) return false;
        const a = bareNumber(normalizeUserJid(px.id));
        const b = bareNumber(userJid);
        return a === b;
      });
      if (p) {
        // حاول استخدام notify/name لو توفّرت
        if (p.notify && String(p.notify).trim()) return p.notify;
        if (p.name && String(p.name).trim())     return p.name;
      }
      // إن فشلنا بإيجاد participant مناسب، نكمل للمحاولات التالية
    }
  } catch (e) {
    // لا تُسقط الترحيب/الوداع، أكمل بمحاولات أخرى
    logger.debug?.({ e }, 'getDisplayName: groupMetadata fallback to onWhatsApp');
  }

  // 3) onWhatsApp(jid) و onWhatsApp(number)
  try {
    const [c1] = await sock.onWhatsApp(userJid);
    if (c1) {
      if (c1.notify)       return c1.notify;
      if (c1.verifiedName) return c1.verifiedName;
      if (c1.pushName)     return c1.pushName;
    }
  } catch {}

  try {
    const [c2] = await sock.onWhatsApp(bareNumber(userJid));
    if (c2) {
      if (c2.notify)       return c2.notify;
      if (c2.verifiedName) return c2.verifiedName;
      if (c2.pushName)     return c2.pushName;
    }
  } catch {}

  // 4) أخيرًا: الرقم
  return num;
}

/** جلب اسم القروب (subject) بشكل موثوق قدر الإمكان */
async function getGroupSubject(sock, groupId) {
  try {
    const md = await sock.groupMetadata(groupId); // subject موثوق
    if (md?.subject && String(md.subject).trim()) return md.subject;
  } catch (e) {
    // كمل بمحاولة أخف
    logger.debug?.({ e }, 'getGroupSubject: groupMetadata failed, trying minimal');
  }
  try {
    const md2 = await sock.groupMetadataMinimal(groupId);
    if (md2?.subject && String(md2.subject).trim()) return md2.subject;
  } catch {}
  return 'المجموعة';
}

function welcomeMsg(name, subject, rules) {
  const lines = [
    `🎉 أهلاً وسهلاً *${name}*!`,
    `مرحبًا بك في *${subject}*.`,
    ''
  ];
  if (rules && String(rules).trim()) {
    lines.push('📜 *قوانين المجموعة*:', String(rules).trim().slice(0, 600));
  } else {
    lines.push('📜 *قوانين عامة*: الرجاء الالتزام بالأدب العام وعدم إرسال الروابط أو الوسائط المخالفة.');
  }
  lines.push('', 'نتمنى لك وقتًا ممتعًا!');
  return lines.join('\n');
}

function farewellMsg(name, subject) {
  return [
    `👋 وداعًا *${name}*.`,
    `سعدنا بوجودك معنا في *${subject}*. نتمنى لك التوفيق دائمًا.`
  ].join('\n');
}

function registerGroupParticipantHandler(sock) {
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      const groupId = ev.id;
      const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
      if (!settings?.enabled) return;

      // اجلب subject مرة واحدة لكل حدث
      const subject = await getGroupSubject(sock, groupId);

      if (ev.action === 'add' && settings.welcomeEnabled) {
        for (const raw of ev.participants || []) {
          // طبع الـ JID إلى s.whatsapp.net قبل أي شيء
          const userJid = normalizeUserJid(raw);
          const name = await getDisplayName(sock, groupId, userJid);
          await sock.sendMessage(groupId, { text: welcomeMsg(name, subject, settings.rules), mentions: [userJid] });
        }
      }

      if (ev.action === 'remove' && settings.farewellEnabled) {
        for (const raw of ev.participants || []) {
          const userJid = normalizeUserJid(raw);
          const name = await getDisplayName(sock, groupId, userJid);
          await sock.sendMessage(groupId, { text: farewellMsg(name, subject) });
        }
      }
    } catch (e) {
      // لا نوقف التشغيل لو فشل الحصول على اسم — نستخدم FallBack
      logger.warn({ e, ev }, 'group-participants.update handler failed');
    }
  });
}

module.exports = { registerGroupParticipantHandler };
