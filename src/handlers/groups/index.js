const GroupSettings = require('../../models/GroupSettings');
const logger = require('../../lib/logger');

function registerGroupParticipantHandler(sock) {
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      const { id: groupId, participants = [], action } = ev || {};
      if (!groupId || !participants.length) return;

      const settings = await GroupSettings.findOne({ groupId }).lean().catch(() => null);
      if (!settings || !settings.enabled) return;

      // اجلب اسم القروب مرة واحدة
      let groupName = groupId;
      try {
        const md = await sock.groupMetadata(groupId);
        groupName = md?.subject || groupName;
      } catch { /* لا مشكلة */ }

      for (const user of participants) {
        if (action === 'add' && settings.welcomeEnabled) {
          await sock.sendMessage(groupId, {
            text:
              `مرحبًا <@${user.split('@')[0]}> في *${groupName}* 👋\n` +
              (settings.rules ? `\nالقوانين:\n${settings.rules}` : '')
          }, { mentions: [user] });
        } else if (action === 'remove' && settings.farewellEnabled) {
          await sock.sendMessage(groupId, { text: `وداعًا <@${user.split('@')[0]}> من *${groupName}* 👋` }, { mentions: [user] });
        }
      }
    } catch (err) {
      logger.warn({ err }, 'group-participants.update handler error');
    }
  });
}

module.exports = { registerGroupParticipantHandler };
