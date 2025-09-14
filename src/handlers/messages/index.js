const path = require('path');
const { loadCommands } = require('../../lib/commandLoader');
const IgnoreChat = require('../../models/IgnoreChat');
const keywords = require('../../config/keywords.json');
let contains = {};
let intents = {};
try { contains = require('../../config/contains.json'); } catch (_) { contains = {}; }
try { intents  = require('../../config/intents.json');   } catch (_) { intents  = {}; }
const logger = require('../../lib/logger');

let registry = null;
function ensureRegistry() {
  if (!registry) registry = loadCommands(path.join(__dirname, '../../commands'));
  return registry;
}

function normalizeArabic(input) {
  let s = String(input || '').trim();
  s = s.replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g, '');
  s = s.replace(/\u0640/g, '');
  s = s.replace(/[إأآا]/g, 'ا');
  s = s.replace(/[يى]/g, 'ي');
  s = s.replace(/ة/g, 'ه');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function matchExactKeyword(textNorm) {
  if (!matchExactKeyword._cache) {
    const c = {};
    for (const k of Object.keys(keywords)) c[normalizeArabic(k)] = keywords[k];
    matchExactKeyword._cache = c;
  }
  return matchExactKeyword._cache[textNorm] || '';
}

function pick(arr){ return Array.isArray(arr)&&arr.length? arr[Math.floor(Math.random()*arr.length)] : ''; }
function matchContains(textNorm){
  for (const key of Object.keys(contains)) {
    const rule = contains[key];
    if (!rule || !Array.isArray(rule.any) || !Array.isArray(rule.replies)) continue;
    const found = rule.any.some(ph => textNorm.includes(normalizeArabic(ph)));
    if (found) return pick(rule.replies) || '';
  }
  return '';
}

function matchIntent(textNorm){
  for (const key of Object.keys(intents)) {
    const rule = intents[key];
    if (!rule || !Array.isArray(rule.any) || !rule.reply) continue;
    const found = rule.any.some(ph => textNorm.includes(normalizeArabic(ph)));
    if (found) return rule.reply;
  }
  return '';
}

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

        if (m.key?.fromMe) continue;
        if (chatId === 'status@broadcast') continue;
        const sender = m.key?.participant || '';
        if (selfBare && String(sender).startsWith(selfBare)) continue;

        // ⬇️ التعديل هنا: افحص JID الكامل والرقم المجرّد (bare)
        const bare = chatId.replace(/@.+$/, '');
        const ignored = await IgnoreChat.findOne({ $or: [{ chatId }, { chatId: bare }, { bare }] }).lean().catch(() => null);
        if (ignored) continue;

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

        const cmdName = resolveCommandName(firstToken, reg);
        if (cmdName) {
          const args = rawText.split(/\s+/).slice(1);
          const run  = reg.commands.get(cmdName);
          await run({ sock, msg: m, args });
          handled = true;
        }

        if (!handled && (textNorm === 'مساعده' || textNorm === 'help')) {
          const help = require('../../commands/help.js');
          await help.run({ sock, msg: m, args: [] });
          handled = true;
        }

        if (!handled) {
          const r1 = matchExactKeyword(textNorm);
          if (r1) { await sock.sendMessage(chatId, { text: r1 }, { quoted: m }); handled = true; }
        }

        if (!handled) {
          const r2 = matchContains(textNorm);
          if (r2) { await sock.sendMessage(chatId, { text: r2 }, { quoted: m }); handled = true; }
        }

        if (!handled) {
          const r3 = matchIntent(textNorm);
          if (r3) { await sock.sendMessage(chatId, { text: r3 }, { quoted: m }); handled = true; }
        }

      } catch (err) {
        logger.error({ err, stack: err?.stack }, 'message handler error');
      }
    }
  };
}

module.exports = { onMessageUpsert };
