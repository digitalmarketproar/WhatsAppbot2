// commands/id.js — إرجاع المعرّف (JID) للمحادثة/العضو
module.exports = {
  name: 'المعرف',
  aliases: ['id', 'معرف'],
  description: 'إظهار معرّف واتساب (JID) للمحادثة الحالية. داخل القروب: لو رددتَ على رسالة عضو، يعرض JID الخاص به أيضًا.',
  run: async ({ sock, msg }) => {
    const chatId = msg.key?.remoteJid || '';
    const isGroup = chatId.endsWith('@g.us');
    const lines = [];

    lines.push(`*Chat JID*: \`${chatId}\``);

    // إن كانت مجموعة وفيه رد على رسالة شخص، أعرض JID ذلك الشخص
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant ||
                   msg.participant || msg.key?.participant;
    if (isGroup && quoted) {
      lines.push(`*User JID*: \`${quoted}\``);
    }

    await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: msg });
  },
};
