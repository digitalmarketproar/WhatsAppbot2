const GroupSettings = require('../../models/GroupSettings');
const { normalizeUserJid } = require('../../lib/jid');
const logger = require('../../lib/logger');

async function getDisplayName(sock, jid) {
  try {
    const [c] = await sock.onWhatsApp(jid);
    if (c?.notify) return c.notify;
    if (c?.verifiedName) return c.verifiedName;
    if (c?.pushName) return c.pushName;
  } catch {}
  return '+' + jid.split('@')[0];
}

async function getGroupSubject(sock, groupId) {
  try {
    const md = await sock.groupMetadataMinimal(groupId);
    return md?.subject || 'المجموعة';
  } catch {
    return 'المجموعة';
  }
}

function welcomeMsg(name, subject, rules) {
  return `🎉 أهلاً وسهلاً *${name}*!\nمرحبًا بك في *${subject}*.\n\n📜 ${rules || 'الرجاء الالتزام بالقوانين العامة وعدم إرسال روابط أو وسائط مخالفة.'}\n\nنتمنى لك وقتًا ممتعًا!`;
}

function farewellMsg(name, subject) {
  return `👋 وداعًا *${name}*.\nسعدنا بوجودك معنا في *${subject}*.`;
}

function registerGroupParticipantHandler(sock) {
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      const groupId = ev.id;
      const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
      if (!settings?.enabled) return;

      const subject = await getGroupSubject(sock, groupId);

      if (ev.action === 'add' && settings.welcomeEnabled) {
        for (const p of ev.participants || []) {
          const user = normalizeUserJid(p);
          const name = await getDisplayName(sock, user);
          await sock.sendMessage(groupId, { text: welcomeMsg(name, subject, settings.rules), mentions: [user] });
        }
      }

      if (ev.action === 'remove' && settings.farewellEnabled) {
        for (const p of ev.participants || []) {
          const user = normalizeUserJid(p);
          const name = await getDisplayName(sock, user);
          await sock.sendMessage(groupId, { text: farewellMsg(name, subject) });
        }
      }
    } catch (e) {
      logger.warn({ e, ev }, 'group-participants.update handler failed');
    }
  });
}

module.exports = { registerGroupParticipantHandler };
