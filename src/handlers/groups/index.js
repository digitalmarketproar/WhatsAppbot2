// src/handlers/groups/index.js
const GroupSettings = require('../../models/GroupSettings');
const { normalizeUserJid } = require('../../lib/jid');
const logger = require('../../lib/logger');

/** محاولة ذكية لجلب اسم العرض للعضو */
async function getDisplayName(sock, userJid) {
  try {
    // بعض نسخ Baileys توفر getName
    if (typeof sock.getName === 'function') {
      const n = sock.getName(userJid);
      if (n) return n;
    }
  } catch {}
  // احتياط: استخدم الرقم
  return '+' + userJid.split('@')[0];
}

async function getGroupSubject(sock, groupId) {
  try {
    const md = await sock.groupMetadata(groupId);
    return md?.subject || 'المجموعة';
  } catch {
    return 'المجموعة';
  }
}

function formatWelcome(name, subject, rules) {
  const lines = [
    `🎉 أهلاً وسهلاً *${name}*!`,
    `مرحبًا بك في *${subject}*.`,
  ];
  if (rules && rules.trim()) {
    lines.push('', '📜 *قوانين المجموعة*:', rules.trim().slice(0, 600));
  } else {
    lines.push('', '📜 *قوانين عامة*: الرجاء الالتزام بالأدب العام وعدم إرسال الروابط أو الوسائط المخالفة.');
  }
  lines.push('', 'نتمنى لك وقتًا ممتعًا!');
  return lines.join('\n');
}

function formatFarewell(name, subject) {
  return [
    `👋 وداعًا *${name}*.`,
    `سعدنا بوجودك معنا في *${subject}*. نتمنى لك التوفيق دائمًا.`,
  ].join('\n');
}

function registerGroupParticipantHandler(sock) {
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      const groupId = ev.id;
      const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
      if (!settings || !settings.enabled) return;

      const subject = await getGroupSubject(sock, groupId);

      if (ev.action === 'add' && settings.welcomeEnabled) {
        for (const p of ev.participants || []) {
          const user = normalizeUserJid(p);
          const name = await getDisplayName(sock, user);
          const text = formatWelcome(name, subject, settings.rules);
          await sock.sendMessage(groupId, { text, mentions: [user] });
        }
      }

      if (ev.action === 'remove' && settings.farewellEnabled) {
        for (const p of ev.participants || []) {
          const user = normalizeUserJid(p);
          const name = await getDisplayName(sock, user);
          const text = formatFarewell(name, subject);
          await sock.sendMessage(groupId, { text });
        }
      }
    } catch (e) {
      logger.warn({ e, ev }, 'group-participants.update handler failed');
    }
  });
}

module.exports = { registerGroupParticipantHandler };
