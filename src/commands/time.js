// commands/time.js
module.exports = {
  name: "الوقت",
  aliases: ["الساعة", "التاريخ"],
  run: async ({ sock, msg }) => {
    const chatId = msg.key.remoteJid;
    const now = new Date().toLocaleString("ar-YE", { timeZone: "Asia/Aden" });
    await sock.sendMessage(chatId, { text: `🕒 الوقت الحالي (آسيا/عدن): ${now}` }, { quoted: msg });
  },
};
