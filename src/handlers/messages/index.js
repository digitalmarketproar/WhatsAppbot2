const path = require('path');
const { loadCommands } = require('../../lib/commandLoader');
const IgnoreChat = require('../../models/IgnoreChat');
const keywords = require('../../config/keywords.json');
const intents = require('../../config/intents.json');
const logger = require('../../lib/logger');

// تحميل الأوامر مرة واحدة
let registry = null;
function ensureRegistry() {
  if (!registry) registry = loadCommands(path.join(__dirname, '../../commands'));
  return registry;
}

// تطبيع عربي: إزالة التشكيل/التطويل وتوحيد بعض الحروف
function normalizeArabic(input) {
  let s = String(input || '').trim();

  // إزالة التشكيل
  s = s.replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g, '');
  // إزالة التطويل
  s = s.replace(/\u0640/g, '');
  // توحيد الألف
  s = s.replace(/[إأآا]/g, 'ا');
  // توحيد الياء/الألف المقصورة
  s = s.replace(/[يى]/g, 'ي');
  // توحيد التاء المربوطة
  s = s.replace(/ة/g, 'ه');
  // مسافات إضافية
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

// تطابق قاموس (تطابق كامل بعد التطبيع)
function matchExactKeyword(textNorm) {
  // نبني نسخة مطبّعة من مفاتيح القاموس لمرة واحدة (كاش بسيط)
  if (!matchExactKeyword._cache) {
    const c = {};
    for (const k of Object.keys(keywords)) {
      const nk = normalizeArabic(k);
      c[nk] = keywords[k];
    }
    matchExactKeyword._cache = c;
  }
  return matchExactKeyword._cache[textNorm] || '';
}

// تطابق نوايا/عبارات تحتوي (contains)
// يفحص أي من العبارات في any[] موجودة داخل النص المطبّع
function matchIntent(textNorm) {
  // مثال بنية intents.json:
  // { "problem": { "any": ["مشكله","لا يعمل","علق",...], "reply":"..." }, ... }
  for (const key of Object.keys(intents)) {
    const rule = intents[key];
    if (!rule || !Array.isArray(rule.any) || !rule.reply) continue;
    const found = rule.any.some(ph => textNorm.includes(normalizeArabic(ph)));
    if (found) return rule.reply;
  }
  return '';
}

// محاولة إيجاد أمر بدون بادئة: أول كلمة = اسم/مرادف
function resolveCommandName(firstToken, reg) {
  if (!firstToken) return '';
  const t = firstToken;                 // كما هي (دعم العربي)
  const tl = String(firstToken).toLowerCase();

  if (reg.commands.has(t)) return t;
  if (reg.aliases.has(t)) return reg.aliases.get(t);

  // تطابق غير حساس لحالة الأحرف (للإنجليزي)
  for (const name of reg.commands.keys()) {
    if (String(name).toLowerCase() === tl) return name;
  }
  for (const [alias, name] of reg.aliases.entries()) {
    if (String(alias).toLowerCase() === tl && reg.commands.has(name)) return name;
  }
  return '';
}

function onMessageUpsert(sock) {
  return async ({ messages }) => {
    const reg = ensureRegistry();

    for (const m of (messages || [])) {
      try {
        const chatId = m.key?.remoteJid;
        if (!chatId) continue;

        // تخطّي المحادثات الموجودة في قائمة التجاهل
        const ignored = await IgnoreChat.findOne({ chatId }).lean().catch(() => null);
        if (ignored) continue;

        const rawText =
          (m.message?.conversation ||
           m.message?.extendedTextMessage?.text ||
           '').trim();
        if (!rawText) continue;

        const textNorm = normalizeArabic(rawText);
        const tokens = textNorm.split(' ');
        const firstToken = tokens[0] || '';
        let handled = false;

        // 1) جرّب تنفيذ أمر (بدون بادئة): أول كلمة = اسم/مرادف الأمر
        const cmdName = resolveCommandName(firstToken, reg);
        if (cmdName) {
          const run = reg.commands.get(cmdName);
          const args = (rawText.split(/\s+/).slice(1)); // استخدم النص الأصلي للأرجومنتس بدون تطبيع
          await run({ sock, msg: m, args });
          handled = true;
        }

        // 2) أمر "مساعدة" إذا جاءت ككلمة كاملة (بدون بادئة أيضًا)
        if (!handled && (textNorm === 'مساعده' || textNorm === 'help')) {
          const help = require('../../commands/help.js');
          await help.run({ sock, msg: m, args: [] });
          handled = true;
        }

        // 3) تطابق قاموس حرفي بعد التطبيع
        if (!handled) {
          const reply = matchExactKeyword(textNorm);
          if (reply) {
            await sock.sendMessage(chatId, { text: reply }, { quoted: m });
            handled = true;
          }
        }

        // 4) تطابق نوايا "contains" لجمل طويلة تحتوي كلمات مفتاحية
        if (!handled) {
          const intentReply = matchIntent(textNorm);
          if (intentReply) {
            await sock.sendMessage(chatId, { text: intentReply }, { quoted: m });
            handled = true;
          }
        }

        // لا رد افتراضي لتقليل الضجيج
      } catch (err) {
        logger.error({ err, stack: err?.stack }, 'message handler error');
      }
    }
  };
}

module.exports = { onMessageUpsert };
