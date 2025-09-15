// src/app/telegram/modules/ignore.js
const IgnoreChat = require('../../../models/IgnoreChat');
const { normalizeToJid, adminOnly } = require('../util');

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

module.exports = function registerIgnoreCommands(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const parts = (msg.text || '').trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();

    // 🚫 إضافة رقم/محادثة إلى التجاهل
    if (cmd === '/ignore') {
      const jid = normalizeToJid(parts.join(' ').trim());
      if (!jid) {
        return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /ignore 9677XXXXXXXX');
      }
      const bare = jid.replace(/@.+$/, '');

      // إن كان موجودًا مسبقًا لا نكرر
      const exists = await IgnoreChat.findOne({
        $or: [{ chatId: jid }, { chatId: bare }, { bare: bare }]
      }).lean();
      if (exists) {
        return ctx.bot.sendMessage(ctx.adminId, `⚠️ الرقم ${bare} موجود مسبقًا في قائمة التجاهل.`);
      }

      await IgnoreChat.create({ chatId: jid, bare, addedBy: 'admin' });
      return ctx.bot.sendMessage(ctx.adminId, `🚫 تم التجاهل: ${jid}`);
    }

    // ✅ إزالة رقم/محادثة من التجاهل
    if (cmd === '/allow' || cmd === '/unignore') {
      const jid = normalizeToJid(parts.join(' ').trim());
      if (!jid) {
        return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /allow 9677XXXXXXXX');
      }
      const bare = jid.replace(/@.+$/, '');

      // نحاول حذف كل الصيغ المحتملة التي ربما سُجّلت سابقًا
      const candidates = uniq([jid, bare, `${bare}@s.whatsapp.net`]);

      const res = await IgnoreChat.deleteMany({
        $or: [
          { chatId: { $in: candidates } },
          { bare:   { $in: [bare] } }
        ]
      });

      if (res.deletedCount > 0) {
        return ctx.bot.sendMessage(ctx.adminId, `✅ تمت الإزالة من التجاهل: ${jid} (حُذف ${res.deletedCount})`);
      } else {
        return ctx.bot.sendMessage(ctx.adminId, `ℹ️ الرقم ${bare} غير موجود في قائمة التجاهل.`);
      }
    }

    // 📋 استعراض قائمة التجاهل
    if (cmd === '/ignores') {
      const list = await IgnoreChat.find({}).sort({ createdAt: -1 }).lean();
      const lines =
        (list || []).map((x, i) => `${i + 1}. ${x.chatId}${x.bare ? ` (bare:${x.bare})` : ''}`).join('\n') ||
        '— (قائمة فارغة)';
      return ctx.bot.sendMessage(ctx.adminId, `قائمة التجاهل:\n${lines}`, {
        disable_web_page_preview: true,
      });
    }
  }));
};
