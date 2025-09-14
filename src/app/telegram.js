const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const GroupSettings = require('../models/GroupSettings');
const UserWarning = require('../models/UserWarning');
const IgnoreChat = require('../models/IgnoreChat');
const logger = require('../lib/logger');

function normalizeToJid(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (/@s\.whatsapp\.net$/.test(s) || /@g\.us$/.test(s)) return s;
  s = s.replace(/[^\d\-]/g, '');
  if (/^\d{6,20}$/.test(s)) return `${s}@s.whatsapp.net`;
  return '';
}

function startTelegram(token, adminId) {
  if (!token || !adminId) return null;

  const bot = new TelegramBot(token, { polling: false });
  bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  bot.startPolling({ restart: true, interval: 300, timeout: 30 }).catch(() => {});

  async function notify(text) {
    try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' }); }
    catch (e) { logger.warn({ e }, 'Telegram notify failed'); }
  }

  async function sendQR(qrString) {
    try {
      const buf = await QRCode.toBuffer(qrString, { type: 'png', margin: 1, scale: 6 });
      await bot.sendPhoto(adminId, buf, { caption: '📱 QR لتسجيل الدخول إلى واتساب' });
    } catch (e) {
      logger.warn({ e }, 'Telegram sendQR failed');
      await notify('QR: ' + qrString);
    }
  }

  function helpText() {
    return [
      '*أوامر المشرف (تيليجرام)*',
      '',
      '• `/help` — عرض هذه القائمة.',
      '• `/ignore 9677XXXXXXXX` — تجاهل رقم/محادثة (لن يرد عليها البوت).',
      '• `/allow 9677XXXXXXXX` — إزالة التجاهل.',
      '• `/ignores` — عرض قائمة التجاهل.',
      '• `/jidify 9677XXXXXXXX` — تحويل رقم إلى JID شخصي (@s.whatsapp.net).',
      '',
      '*إدارة القروبات*',
      '• `/g_enable 1203...@g.us` — تفعيل إدارة القروب.',
      '• `/g_disable 1203...@g.us` — تعطيل إدارة القروب.',
      '• `/g_rules_set 1203...@g.us نص القوانين...` — ضبط القوانين.',
      '• `/g_rules_get 1203...@g.us` — عرض القوانين.',
      '• `/g_media on|off 1203...@g.us` — حظر/سماح الوسائط.',
      '• `/g_links on|off 1203...@g.us` — حظر/سماح الروابط.',
      '• `/g_banword_add 1203...@g.us كلمة` — إضافة كلمة محظورة.',
      '• `/g_banword_remove 1203...@g.us كلمة` — إزالة كلمة محظورة.',
      '• `/g_banword_list 1203...@g.us` — عرض قائمة الكلمات المحظورة.',
      '• `/g_warns_get 1203...@g.us 9677XXXXXXXX` — عرض تحذيرات عضو.',
      '• `/g_warns_reset 1203...@g.us 9677XXXXXXXX` — تصفير تحذيرات عضو.',
      '• `/g_status 1203...@g.us` — ملخّص حالة القروب.',
      '',
      '_ملاحظة:_ للحصول على JID لأي قروب/مستخدم من داخل واتساب، أرسل أمر *المعرف* أو *id* هناك، وسيُرجع لك الـ JID بدقة.'
    ].join('\n');
  }

  bot.on('text', async (msg) => {
    if (String(msg.chat.id) !== String(adminId)) return;
    const text = (msg.text || '').trim();
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd  = (rawCmd || '').toLowerCase();
    const args = rest;

    try {
      // ======== قائمة الأوامر ========
      if (cmd === '/help' || cmd === '/commands') {
        return bot.sendMessage(adminId, helpText(), { parse_mode: 'Markdown' });
      }

      // ======== أدوات JID بسيطة ========
      if (cmd === '/jidify') {
        const input = args.join(' ').trim();
        const jid = normalizeToJid(input);
        if (!jid) return bot.sendMessage(adminId, 'استخدم: `/jidify 9677XXXXXXXX`', { parse_mode: 'Markdown' });
        return bot.sendMessage(adminId, '`' + jid + '`', { parse_mode: 'Markdown' });
      }

      // ======== أوامر التجاهل العام ========
      if (cmd === '/ignore') {
        const jid = normalizeToJid(args.join(' ').trim());
        if (!jid) {
          return bot.sendMessage(adminId, '⚠️ رجاءً أرسل رقمًا صحيحًا أو JID كامل.\nمثال: `/ignore 9677XXXXXXXX`', { parse_mode: 'Markdown' });
        }
        const bare = jid.replace(/@.+$/, '');
        await IgnoreChat.findOneAndUpdate(
          { $or: [{ chatId: jid }, { chatId: bare }, { bare }] },
          { chatId: jid, bare, addedBy: 'admin' },
          { upsert: true, new: true }
        );
        return bot.sendMessage(adminId, `🚫 تم التجاهل: \`${jid}\``, { parse_mode: 'Markdown' });
      }

      if (cmd === '/allow' || cmd === '/unignore') {
        const jid = normalizeToJid(args.join(' ').trim());
        if (!jid) {
          return bot.sendMessage(adminId, '⚠️ رجاءً رجاءً أرسل رقمًا صحيحًا أو JID كامل.\nمثال: `/allow 9677XXXXXXXX`', { parse_mode: 'Markdown' });
        }
        const bare = jid.replace(/@.+$/, '');
        const res = await IgnoreChat.deleteMany({ $or: [{ chatId: jid }, { chatId: bare }, { bare }] });
        return bot.sendMessage(adminId, `✅ تمت الإزالة من التجاهل: \`${jid}\` (حُذِف ${res.deletedCount})`, { parse_mode: 'Markdown' });
      }

      if (cmd === '/ignores') {
        const list = await IgnoreChat.find({}).sort({ createdAt: -1 }).lean();
        const lines = list.map((x, i) => `${i + 1}. ${x.chatId}${x.bare ? ` (bare:${x.bare})` : ''}`).join('\n') || '— (قائمة فارغة)';
        return bot.sendMessage(adminId, '*قائمة التجاهل*\n' + lines, { parse_mode: 'Markdown' });
      }

      // ======== إدارة القروبات ========
      if (cmd === '/g_enable' || cmd === '/g_disable') {
        const groupJid = args[0];
        if (!groupJid || !/@g\.us$/.test(groupJid)) {
          return bot.sendMessage(adminId, 'استخدم: `/g_enable 1203...@g.us` أو `/g_disable 1203...@g.us`', { parse_mode: 'Markdown' });
        }
        const enabled = cmd === '/g_enable';
        await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, enabled }, { upsert: true, new: true });
        return bot.sendMessage(adminId, `تم ${enabled ? 'التفعيل' : 'التعطيل'}: ${groupJid}`);
      }

      if (cmd === '/g_rules_set') {
        const groupJid = args.shift();
        const rules = (args.join(' ') || '').trim();
        if (!groupJid || !/@g\.us$/.test(groupJid) || !rules) {
          return bot.sendMessage(adminId, 'استخدم: `/g_rules_set 1203...@g.us نص القوانين...`', { parse_mode: 'Markdown' });
        }
        await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, rules }, { upsert: true, new: true });
        return bot.sendMessage(adminId, `تم تحديث القوانين لـ ${groupJid}.`);
      }

      if (cmd === '/g_rules_get') {
        const groupJid = args[0];
        if (!groupJid || !/@g\.us$/.test(groupJid)) {
          return bot.sendMessage(adminId, 'استخدم: `/g_rules_get 1203...@g.us`', { parse_mode: 'Markdown' });
        }
        const s = await GroupSettings.findOne({ groupId: groupJid }).lean();
        return bot.sendMessage(adminId, s?.rules ? `قوانين ${groupJid}:\n${s.rules}` : `لا قوانين مضبوطة لـ ${groupJid}.`);
      }

      if (cmd === '/g_media') {
        const mode = (args[0] || '').toLowerCase();
        const groupJid = args[1];
        if (!['on','off'].includes(mode) || !groupJid || !/@g\.us$/.test(groupJid)) {
          return bot.sendMessage(adminId, 'استخدم: `/g_media on 1203...@g.us` أو `off`', { parse_mode: 'Markdown' });
        }
        await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, blockMedia: mode === 'on' }, { upsert: true, new: true });
        return bot.sendMessage(adminId, `حظر الوسائط: ${mode} لـ ${groupJid}`);
      }

      if (cmd === '/g_links') {
        const mode = (args[0] || '').toLowerCase();
        const groupJid = args[1];
        if (!['on','off'].includes(mode) || !groupJid || !/@g\.us$/.test(groupJid)) {
          return bot.sendMessage(adminId, 'استخدم: `/g_links on 1203...@g.us` أو `off`', { parse_mode: 'Markdown' });
        }
        await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, blockLinks: mode === 'on' }, { upsert: true, new: true });
        return bot.sendMessage(adminId, `حظر الروابط: ${mode} لـ ${groupJid}`);
      }

      if (cmd === '/g_banword_add') {
        const groupJid = args.shift();
        const word = (args.join(' ') || '').trim();
        if (!groupJid || !/@g\.us$/.test(groupJid) || !word) {
          return bot.sendMessage(adminId, 'استخدم: `/g_banword_add 1203...@g.us كلمة`', { parse_mode: 'Markdown' });
        }
        const s = await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid }, { upsert: true, new: true });
        s.bannedWords = Array.from(new Set([...(s.bannedWords || []), word]));
        await s.save();
        return bot.sendMessage(adminId, `أُضيفت كلمة محظورة لـ ${groupJid}.`);
      }

      if (cmd === '/g_banword_remove') {
        const groupJid = args.shift();
        const word = (args.join(' ') || '').trim();
        if (!groupJid || !/@g\.us$/.test(groupJid) || !word) {
          return bot.sendMessage(adminId, 'استخدم: `/g_banword_remove 1203...@g.us كلمة`', { parse_mode: 'Markdown' });
        }
        const s = await GroupSettings.findOne({ groupId: groupJid });
        if (!s) return bot.sendMessage(adminId, `لا توجد إعدادات لهذا القروب.`);
        s.bannedWords = (s.bannedWords || []).filter(w => w !== word);
        await s.save();
        return bot.sendMessage(adminId, `أُزيلت الكلمة من ${groupJid}.`);
      }

      if (cmd === '/g_banword_list') {
        const groupJid = args[0];
        if (!groupJid || !/@g\.us$/.test(groupJid)) {
          return bot.sendMessage(adminId, 'استخدم: `/g_banword_list 1203...@g.us`', { parse_mode: 'Markdown' });
        }
        const s = await GroupSettings.findOne({ groupId: groupJid }).lean();
        const list = (s?.bannedWords || []).map((w,i)=>`${i+1}. ${w}`).join('\n') || '— (فارغة)';
        return bot.sendMessage(adminId, `قائمة الكلمات المحظورة لـ ${groupJid}:\n${list}`);
      }

      if (cmd === '/g_warns_get') {
        const groupJid = args[0];
        const userArg  = args[1];
        if (!groupJid || !userArg) {
          return bot.sendMessage(adminId, 'استخدم: `/g_warns_get 1203...@g.us 9677XXXXXXXX`', { parse_mode: 'Markdown' });
        }
        const userJid = normalizeToJid(userArg);
        const doc = await UserWarning.findOne({ groupId: groupJid, userId: userJid }).lean();
        return bot.sendMessage(adminId, `تحذيرات ${userJid} في ${groupJid}: ${doc?.count || 0}`);
      }

      if (cmd === '/g_warns_reset') {
        const groupJid = args[0];
        const userArg  = args[1];
        if (!groupJid || !userArg) {
          return bot.sendMessage(adminId, 'استخدم: `/g_warns_reset 1203...@g.us 9677XXXXXXXX`', { parse_mode: 'Markdown' });
        }
        const userJid = normalizeToJid(userArg);
        const res = await UserWarning.deleteOne({ groupId: groupJid, userId: userJid });
        return bot.sendMessage(adminId, `تم تصفير التحذيرات (${res.deletedCount}) لـ ${userJid} في ${groupJid}.`);
      }

      if (cmd === '/g_status') {
        const groupJid = args[0];
        if (!groupJid || !/@g\.us$/.test(groupJid)) {
          return bot.sendMessage(adminId, 'استخدم: `/g_status 1203...@g.us`', { parse_mode: 'Markdown' });
        }
        const s = await GroupSettings.findOne({ groupId: groupJid }).lean();
        if (!s) return bot.sendMessage(adminId, `لا إعدادات لـ ${groupJid}.`);
        const info =
          `groupId: ${s.groupId}\n` +
          `enabled: ${s.enabled}\n` +
          `welcome: ${s.welcomeEnabled} | farewell: ${s.farewellEnabled}\n` +
          `blockMedia: ${s.blockMedia} | blockLinks: ${s.blockLinks}\n` +
          `maxWarnings: ${s.maxWarnings}\n` +
          `bannedWords: ${(s.bannedWords||[]).length}\n` +
          `rules:\n${(s.rules||'').slice(0, 400)}`;
        return bot.sendMessage(adminId, info);
      }

    } catch (e) {
      logger.error({ e }, 'Telegram admin cmd failed');
      await bot.sendMessage(adminId, '❌ حدث خطأ أثناء تنفيذ الأمر.');
    }
  });

  bot.on('polling_error', (err) => {
    if (String(err?.message || '').includes('409')) return;
    logger.warn({ err }, 'Telegram polling error');
  });

  logger.info('🤖 Telegram bot started (admin commands ready).');
  notify('🤖 Telegram bot started (admin commands ready).').catch(()=>{});
  return { bot, notify, sendQR };
}

module.exports = { startTelegram };
