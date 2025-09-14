const path = require('path');
const { loadCommands } = require('../../lib/commandLoader');
const IgnoreChat = require('../../models/IgnoreChat');
const keywords = require('../../config/keywords.json');
let contains = {};
let intents = {};
try { contains = require('../../config/contains.json'); } catch (_) { contains = {}; }
try { intents  = require('../../config/intents.json');   } catch (_) { intents  = {}; }
const logger = require('../../lib/logger');

// تحميل الأوامر مرة واحدة
let registry = null;
function ensureRegistry() {
  if (!registry) registry = loadCommands(path.join(__dirname, '../../commands'));
  return registry;
}

// تطبيع عربي: إزالة التشكيل/التطويل وتوحيد الحروف + إزالة الرموز/الإيموجي
function normalizeArabic(input) {
  let s = String(input || '').trim();
  s = s.replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g, ''); // التشكيل
  s = s.replace(/\u0640/g, '');                                     // التطويل
  s = s.replace(/[إأآا]/g, 'ا');                                    // الألف
  s = s.replace(/[يى]/g, 'ي');                                      // الياء/المقصورة
  s = s.replace(/ة/g, 'ه');                                         // التاء المربوطة
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');                          // رموز/إيموجي
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// قاموس مطابق تمامًا (بعد التطبيع) مع كاش
function matchExactKeyword(textNorm) {
  if (!matchExactKeyword._cache) {
    const c = {};
    for (const k of Object.keys(keywords)) c[normalizeArabic(k)] = keywords[k];
    matchExactKeyword._cache = c;
  }
  return matchExactKeyword._cache[textNorm] || '';
}

// قاموس contains ذكي (قبل intents): يبحث عن أي من العبارات ويعيد ردًا ملائمًا
function pick(arr) { return Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random()*arr.length)] : ''; }
function matchContains(textNorm) {
  // contains.json: { key: { any: [..], replies: [..] }, ... }
  for (const key of Object.keys(contains)) {
    const rule = contains[key];
    if (!rule || !Array.isArray(rule.any) || !Array.isArray(rule.replies)) continue;
    const found = rule.any.some(ph => textNorm.includes(normalizeArabic(ph)));
    if (found) return pick(rule.replies) || '';
  }
  return '';
}

// نوايا عامة كملاذ أخير
function matchIntent(textNorm) {
  for (const key of Object.keys(intents)) {
    const rule = intents[key];
    if (!rule || !Array.isArray(rule.any) || !rule.reply) continue;
    const found = rule.any.some(ph => textNorm.includes(normalizeArabic(ph)));
    if (found) return rule.reply;
  }
  return '';
}

// إيجاد الأمر بدون بادئة: أول كلمة = اسم/مرادف
function resolveCommandName(firstToken, reg) {
  if (!firstToken) return '';
  const t  = firstToken;
  const tl = String(firstToken).toLowerCase();

  if (reg.commands.has(t)) return t;
  if (reg.aliases.has(t))  return reg.aliases.get(t);

  for (const name of reg.commands.keys()) if (String(name).toLowerCase() === tl) return name;
  for (const [alias, name] of reg.aliases.entries())
    if (String(alias).toLowerCase() === tl && reg.commands.has(name)) return name;

  return '';
}

function onMessageUpsert(sock) {
  return async ({ messages }) => {
    const reg = ensureRegistry();
    const selfBare = (sock.user?.id || '').split(':')[0];

    for (const m of (messages || [])) {
      try {
        const chatId = m.key?.remoteJid;
        if (!chatId) continue;

        // حراس
        if (m.key?.fromMe) continue;
        if (chatId === 'status@broadcast') continue;
        const sender = m.key?.participant || '';
        if (selfBare && String(sender).startsWith(selfBare)) continue;

        // قائمة التجاهل
        const ignored = await IgnoreChat.findOne({ chatId }).lean().catch(() => null);
        if (ignored) continue;

        // نص الرسالة (يشمل كابشن الصورة/الفيديو)
        const rawText =
          (m.message?.conversation ||
           m.message?.extendedTextMessage?.text ||
           m.message?.imageMessage?.caption ||
           m.message?.videoMessage?.caption ||
           '').trim();
        if (!rawText) continue;

        const textNorm   = normalizeArabic(rawText);
        const firstToken = textNorm.split(' ')[0] || '';
        let handled = false;

        // 1) أوامر بدون بادئة
        const cmdName = resolveCommandName(firstToken, reg);
        if (cmdName) {
          const args = rawText.split(/\s+/).slice(1);
          const run  = reg.commands.get(cmdName);
          await run({ sock, msg: m, args });
          handled = true;
        }

        // 2) "مساعدة"/help ككلمة كاملة
        if (!handled && (textNorm === 'مساعده' || textNorm === 'help')) {
          const help = require('../../commands/help.js');
          await help.run({ sock, msg: m, args: [] });
          handled = true;
        }

        // 3) قاموس مطابق تمامًا (يحافظ على ردودك التفصيلية)
        if (!handled) {
          const replyExact = matchExactKeyword(textNorm);
          if (replyExact) {
            await sock.sendMessage(chatId, { text: replyExact }, { quoted: m });
            handled = true;
          }
        }

        // 4) قاموس contains الذكي — يعطي ردود مختلفة للتحيات/الجمل الطويلة
        if (!handled) {
          const replyContains = matchContains(textNorm);
          if (replyContains) {
            await sock.sendMessage(chatId, { text: replyContains }, { quoted: m });
            handled = true;
          }
        }

        // 5) intents العامة كملاذ أخير فقط
        if (!handled) {
          const intentReply = matchIntent(textNorm);
          if (intentReply) {
            await sock.sendMessage(chatId, { text: intentReply }, { quoted: m });
            handled = true;
          }
        }

        // لا رد افتراضي
      } catch (err) {
        logger.error({ err, stack: err?.stack }, 'message handler error');
      }
    }
  };
}

module.exports = { onMessageUpsert };
