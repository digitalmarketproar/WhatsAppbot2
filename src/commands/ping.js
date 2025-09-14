// commands/ping.js
module.exports = {
  name: "اختبار",
  aliases: ["بنق", "تست", "سرعة"],
  run: async ({ sock, msg }) => {
    const chatId = msg.key.remoteJid;
    const ts = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;
    const latency = Date.now() - ts;
    const text = `🏓 اختبار الاستجابة: ~${latency >= 0 ? latency : 0} ملّي ثانية`;
    await sock.sendMessage(chatId, { text }, { quoted: msg });
  },
};
