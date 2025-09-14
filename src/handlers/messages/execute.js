const keywords = require('../../config/keywords.json');
async function executeCommand(sock, m, cmd) {
  const from = m.key.remoteJid;
  const name = cmd.name;
  // نبحث عن ملف أمر مطابق
  try {
    const mod = require(`../../commands/${name}.js`);
    if (mod && typeof mod.run === 'function') {
      return await mod.run(sock, m, cmd.args);
    }
  } catch(e) {
    // لا يوجد أمر مطابق
  }
  // fallback: الكلمات المفتاحية العربية
  const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
  if (text && keywords[text]) {
    await sock.sendMessage(from, { text: String(keywords[text]) });
    return true;
  }
  // مساعدة عربية بسيطة
  if (['help','مساعدة','?'].includes(name)) {
    await sock.sendMessage(from, { text: 'أوامر متاحة: اكتب >الوقت ، >المعرف ، أو استخدم كلمات القاموس مباشرة.' });
    return true;
  }
  return false;
}
module.exports = { executeCommand };