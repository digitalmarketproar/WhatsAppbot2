// commands/help.js — قائمة أوامر احترافية مع أوصاف ديناميكية (إن وُجدت)
const fs = require('fs');
const path = require('path');
const { loadCommands } = require('../lib/commandLoader');

module.exports = {
  name: 'مساعدة',
  aliases: ['help', 'قائمة', 'تعليمات'],
  run: async ({ sock, msg }) => {
    const chatId = msg.key.remoteJid;

    // حمّل الأوامر الفعّالة
    const commandsDir = path.join(__dirname);
    const { commands } = loadCommands(commandsDir);

    // حضّر أوصاف الأوامر: نقرأ ملفات الأوامر ونلتقط الحقل الاختياري "description"
    const descriptions = new Map();
    for (const file of fs.readdirSync(commandsDir)) {
      if (!file.endsWith('.js')) continue;
      const full = path.join(commandsDir, file);
      try {
        delete require.cache[require.resolve(full)];
        const mod = require(full);
        const name = (mod?.name || path.basename(file, '.js')).trim();
        const desc = (typeof mod?.description === 'string' && mod.description.trim()) ? mod.description.trim() : '';
        descriptions.set(name, desc);
      } catch {
        // تجاهل أي ملف به خطأ تحميل
      }
    }

    // اكتب القائمة (مستبعداً أمر "مساعدة" نفسه)
    const list = [...commands.keys()]
      .filter(n => n !== 'مساعدة')
      .sort((a, b) => a.localeCompare(b, 'ar'));

    const lines = [];
    lines.push('📘 *قائمة الأوامر*');
    lines.push('');

    if (list.length === 0) {
      lines.push('لا توجد أوامر متاحة حالياً.');
    } else {
      for (const name of list) {
        const desc = descriptions.get(name) || '';
        lines.push(desc ? `• ${name} — ${desc}` : `• ${name}`);
      }
    }

    lines.push('');
    lines.push('لطلب هذه القائمة مجدداً: اكتب "مساعدة".');

    await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: msg });
  },
};
