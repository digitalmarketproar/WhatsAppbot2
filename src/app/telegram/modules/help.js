const { adminOnly } = require('../util');

function helpText() {
  return [
    'أوامر المشرف (تيليجرام):',
    '',
    '/help',
    'عرض هذه القائمة.',
    '',
    '/ignore 9677XXXXXXXX',
    'تجاهل رقم/محادثة (لن يرد عليها البوت).',
    '',
    '/allow 9677XXXXXXXX',
    'إزالة التجاهل.',
    '',
    '/ignores',
    'عرض قائمة التجاهل.',
    '',
    'إدارة القروبات:',
    '',
    '/g_enable 1203...@g.us',
    'تفعيل إدارة القروب.',
    '',
    '/g_disable 1203...@g.us',
    'تعطيل إدارة القروب.',
    '',
    '/g_rules_set 1203...@g.us نص القوانين...',
    'ضبط/تحديث القوانين (تظهر مع الترحيب).',
    '',
    '/g_rules_get 1203...@g.us',
    'عرض القوانين الحالية.',
    '',
    '/g_media on|off 1203...@g.us',
    'حظر/سماح الوسائط (صور/فيديو/ملفات).',
    '',
    '/g_links on|off 1203...@g.us',
    'حظر/سماح الروابط.',
    '',
    '/g_welcome on|off 1203...@g.us',
    'تفعيل/تعطيل رسالة الترحيب بالأعضاء الجدد.',
    '',
    '/g_farewell on|off 1203...@g.us',
    'تفعيل/تعطيل رسالة الوداع عند المغادرة.',
    '',
    '/g_banword_add 1203...@g.us كلمة',
    'إضافة كلمة محظورة.',
    '',
    '/g_banword_remove 1203...@g.us كلمة',
    'إزالة كلمة محظورة.',
    '',
    '/g_banword_list 1203...@g.us',
    'عرض قائمة الكلمات المحظورة.',
    '',
    '/g_warns_get 1203...@g.us 9677XXXXXXXX',
    'عرض عدد تحذيرات عضو.',
    '',
    '/g_warns_reset 1203...@g.us 9677XXXXXXXX',
    'تصفير تحذيرات عضو.',
    '',
    '/g_status 1203...@g.us',
    'ملخص حالة القروب (إعدادات مختصرة).'
  ].join('\n');
}

module.exports = function registerHelpCommand(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const [cmd] = (msg.text || '').trim().split(/\s+/);
    if (!cmd) return;
    const c = cmd.toLowerCase();
    if (c === '/help' || c === '/commands') {
      await ctx.bot.sendMessage(ctx.adminId, helpText(), { disable_web_page_preview: true });
    }
  }));
};
