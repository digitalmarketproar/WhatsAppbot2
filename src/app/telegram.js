const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const IgnoreChat = require('../models/IgnoreChat');
const logger = require('../lib/logger');

function startTelegram(token, adminId) {
  if (!token || !adminId) return null;
  const bot = new TelegramBot(token, { polling: true });

  async function notify(text) {
    try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' }); } 
    catch (e) { logger.warn({ e }, 'Telegram notify failed'); }
  }
  async function sendQR(qrString) {
    try {
      const buf = await QRCode.toBuffer(qrString, { type: 'png', margin: 1, scale: 6 });
      await bot.sendPhoto(adminId, buf, { caption: '📱 QR لتسجيل الدخول إلى واتساب' });
    } catch(e) {
      logger.warn({ e }, 'Telegram sendQR failed');
      await notify('QR: ' + qrString);
    }
  }

  // Admin commands: /ignore, /allow, /ignores
  bot.on('text', async (msg) => {
    if (String(msg.chat.id) !== String(adminId)) return; // admin-only
    const text = (msg.text || '').trim();
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    try {
      if (cmd === '/ignore' && arg) {
        await IgnoreChat.findOneAndUpdate({ chatId: arg }, { chatId: arg, addedBy: 'admin' }, { upsert: true, new: true });
        await bot.sendMessage(adminId, `🚫 تم تجاهل: ${arg}`);
      } else if ((cmd === '/allow' || cmd === '/unignore') && arg) {
        await IgnoreChat.deleteOne({ chatId: arg });
        await bot.sendMessage(adminId, `✅ تمت الإزالة من التجاهل: ${arg}`);
      } else if (cmd === '/ignores') {
        const list = await IgnoreChat.find({}).sort({ createdAt: -1 }).lean();
        const lines = list.map((x,i) => `${i+1}. ${x.chatId}`).join('\n') || '— (قائمة فارغة)';
        await bot.sendMessage(adminId, '*قائمة التجاهل*\n' + lines, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      logger.error({ e }, 'Telegram admin cmd failed');
      await bot.sendMessage(adminId, 'حدث خطأ أثناء تنفيذ الأمر.');
    }
  });

  bot.on('polling_error', (err) => {
    if (String(err?.message || '').includes('409')) return;
    logger.warn({ err }, 'Telegram polling error');
  });

  logger.info('🤖 Telegram bot started (admin commands ready).');
  return { bot, notify, sendQR };
}

module.exports = { startTelegram };