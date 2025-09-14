const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const IgnoreChat = require('../models/IgnoreChat');
const logger = require('../lib/logger');

function normalizeToJid(input) {
  if (!input) return '';
  let s = String(input).trim();

  // لو كان JID كامل مسبقًا (شخص أو قروب) أعده كما هو
  if (/@s\.whatsapp\.net$/.test(s) || /@g\.us$/.test(s)) return s;

  // أزل كل ما ليس رقمًا أو علامات بسيطة
  s = s.replace(/[^\d\-]/g, '');

  // أرقام فقط → اعتبره رقم واتساب لشخص
  if (/^\d{6,20}$/.test(s)) return `${s}@s.whatsapp.net`;

  // فشل التطبيع
  return '';
}

function startTelegram(token, adminId) {
  if (!token || !adminId) return null;

  const bot = new TelegramBot(token, { polling: false });
  // إزالة أي WebHook سابق ثم ابدأ polling
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

  bot.on('text', async (msg) => {
    if (String(msg.chat.id) !== String(adminId)) return; // أوامر للمشرف فقط
    const text = (msg.text || '').trim();
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd?.toLowerCase?.() || '';
    const argRaw = rest.join(' ').trim();

    try {
      if (cmd === '/ignore') {
        const jid = normalizeToJid(argRaw);
        if (!jid) return bot.sendMessage(adminId, '⚠️ رجاءً أرسل رقمًا صحيحًا أو JID كامل.\nمثال: `/ignore 9677XXXXXXXX`', { parse_mode: 'Markdown' });

        // خزّن الشكلين معًا لضمان التطابق لاحقًا
        const bare = jid.replace(/@.+$/, '');
        await IgnoreChat.findOneAndUpdate(
          { $or: [{ chatId: jid }, { chatId: bare }] },
          { chatId: jid, bare, addedBy: 'admin' },
          { upsert: true, new: true }
        );
        await bot.sendMessage(adminId, `🚫 تم تجاهل: \`${jid}\``, { parse_mode: 'Markdown' });

      } else if (cmd === '/allow' || cmd === '/unignore') {
        const jid = normalizeToJid(argRaw);
        if (!jid) return bot.sendMessage(adminId, '⚠️ رجاءً أرسل رقمًا صحيحًا أو JID كامل.\nمثال: `/allow 9677XXXXXXXX`', { parse_mode: 'Markdown' });
        const bare = jid.replace(/@.+$/, '');
        const res = await IgnoreChat.deleteMany({ $or: [{ chatId: jid }, { chatId: bare }] });
        await bot.sendMessage(adminId, `✅ تمت الإزالة من التجاهل: \`${jid}\` (حُذِف ${res.deletedCount})`, { parse_mode: 'Markdown' });

      } else if (cmd === '/ignores') {
        const list = await IgnoreChat.find({}).sort({ createdAt: -1 }).lean();
        const lines = list.map((x, i) => `${i + 1}. ${x.chatId}${x.bare ? ` (bare:${x.bare})` : ''}`).join('\n') || '— (قائمة فارغة)';
        await bot.sendMessage(adminId, '*قائمة التجاهل*\n' + lines, { parse_mode: 'Markdown' });
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
  notify('🤖 Telegram bot started (admin commands ready).').catch(() => {});
  return { bot, notify, sendQR };
}

module.exports = { startTelegram };
