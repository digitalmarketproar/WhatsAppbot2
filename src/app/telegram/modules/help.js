'use strict';
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
    '/g_wl_add 1203...@g.us 9677XXXXXXXX',
    'إضافة رقم (bare) إلى القائمة البيضاء — يُستثنى من الموديريشن.',
    '',
    '/g_wl_del 1203...@g.us 9677XXXXXXXX',
    'حذف رقم من القائمة البيضاء.',
    '',
    '/g_wl_list 1203...@g.us',
    'استعراض قائمة الأرقام في القائمة البيضاء.',
    '',
    '/g_status 1203...@g.us',
    'ملخص حالة القروب (إعدادات مختصرة).'
  ].join('\n');
}

// دالة بصيغة يتوقعها الراوتر: handleHelp({ bot, msg })
async function handleHelp({ bot, msg }) {
  const send = adminOnly({ bot, adminId: process.env.TELEGRAM_ADMIN_ID }, async () => {
    return bot.sendMessage(msg.chat.id, helpText(), { disable_web_page_preview: true });
  });
  return send(msg);
}

module.exports = { handleHelp, helpText };
