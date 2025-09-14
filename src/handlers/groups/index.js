// src/handlers/groups/index.js
const GroupSettings = require('../../models/GroupSettings');
const logger = require('../../lib/logger');

/**
 * نجلب اسم العرض للعضو قدر الإمكان.
 * نحاول onWhatsApp() لاسترجاع notify/verifiedName/pushName،
 * وإن لم يتوفر نرجع الرقم مع "+" كحل أخير.
 */
async function getDisplayName(sock, jid) {
  try {
    const [c] = await sock.onWhatsApp(jid);
    if (c?.notify) return c.notify;
    if (c?.verifiedName) return c.verifiedName;
    if (c?.pushName) return c.pushName;
  } catch {}
  return '+' + String(jid).split('@')[0];
}

/** نجلب اسم القروب مع استهلاك خفيف */
async function getGroupSubject(sock, groupId) {
  try {
    // minimal أخف من groupMetadata الكامل
    const md = await sock.groupMetadataMinimal(groupId);
    return md?.subject || 'المجموعة';
  } catch {
    return 'المجموعة';
  }
}

function welcomeMsg(name, subject, rules) {
  return [
    `🎉 أهلاً وسهلاً *${name}*!`,
    `مرحبًا بك في *${subject}*.`,
    '',
    '📜 ' + (rules && rules.trim()
      ? `*قوانين المجموعة*: \n${rules.trim().slice(0, 600)}`
      : '*قوانين عامة*: الرجاء الالتزام بالأدب العام وعدم إرسال الروابط أو الوسائط المخالفة.'),
    '',
    'نتمنى لك وقتًا ممتعًا!'
  ].join('\n');
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

      const subject = await getGroupSubject(sock, groupId);

      // نستخدم المنشن دائماً ليظهر الاسم/الرقم بوضوح داخل واتساب
      if (ev.action === 'add' && settings.welcomeEnabled) {
        for (const p of ev.participants || []) {
          const name = await getDisplayName(sock, p);
          await sock.sendMessage(groupId, { text: welcomeMsg(name, subject, settings.rules), mentions: [p] });
        }
      }

      if (ev.action === 'remove' && settings.farewellEnabled) {
        for (const p of ev.participants || []) {
          const name = await getDisplayName(sock, p);
          await sock.sendMessage(groupId, { text: farewellMsg(name, subject) });
        }
      }
    } catch (e) {
      // إذا كانت هناك مجموعات لا نملك صلاحية عرض بياناتها، لا نُسقط البوت
      logger.warn({ e, ev }, 'group-participants.update handler failed');
    }
  });
}

module.exports = { registerGroupParticipantHandler };
