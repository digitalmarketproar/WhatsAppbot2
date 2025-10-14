'use strict';

/**
 * Aggregator for Telegram admin modules
 * نصدّر اسمين لكل أمر (help/handleHelp, ignore/handleIgnore, ... إلخ)
 * حتى أي راوتر بأي تسمية يجد الدوال.
 */

function safeRequire(path) {
  try { return require(path); } catch { return null; }
}

const helpModule      = safeRequire('./help');
const ignoreModule    = safeRequire('./ignore');
const groupModule     = safeRequire('./group');
const whitelistModule = safeRequire('./whitelist');
const statusModule    = safeRequire('./status');
const rulesModule     = safeRequire('./rules');
const togglesModule   = safeRequire('./toggles');
const banwordsModule  = safeRequire('./banwords');

// -------- HELP --------
async function _help(ctx) {
  // يدعم help.js بنسختك التي فيها helpText + handleHelp
  if (helpModule?.handleHelp) return helpModule.handleHelp(ctx);
  if (helpModule?.helpText) {
    const { bot, msg } = ctx;
    return bot.sendMessage(msg.chat.id, helpModule.helpText(), { disable_web_page_preview: true });
  }
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'قائمة المساعدة غير متوفّرة حالياً.');
}

// -------- IGNORE / ALLOW / IGNORES --------
async function _ignore(ctx) {
  if (ignoreModule?.handleIgnore) return ignoreModule.handleIgnore(ctx);
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'لا يوجد ملف ignore. أضف modules/ignore.js');
}
async function _allow(ctx) {
  if (ignoreModule?.handleAllow) return ignoreModule.handleAllow(ctx);
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'لا يوجد ملف allow. أضف الدالة handleAllow');
}
async function _ignores(ctx) {
  if (ignoreModule?.handleIgnores) return ignoreModule.handleIgnores(ctx);
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'لا يوجد ملف ignores. أضف الدالة handleIgnores');
}

// -------- GROUP (/g_*) --------
async function _group(ctx) {
  if (groupModule?.handleGroupCommand) return groupModule.handleGroupCommand(ctx);
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'لا يوجد ملف group. أضف modules/group.js');
}

// -------- WHITE-LIST / STATUS / RULES / TOGGLES / BANWORDS --------
async function _whitelist(ctx) {
  if (whitelistModule?.handleWhitelist) return whitelistModule.handleWhitelist(ctx);
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'لا يوجد ملف whitelist. أضف modules/whitelist.js');
}
async function _status(ctx) {
  if (statusModule?.handleStatus) return statusModule.handleStatus(ctx);
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'لا يوجد ملف status. أضف modules/status.js');
}
async function _rules(ctx) {
  if (rulesModule?.handleRules) return rulesModule.handleRules(ctx);
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'لا يوجد ملف rules. أضف modules/rules.js');
}
async function _toggles(ctx) {
  if (togglesModule?.handleToggles) return togglesModule.handleToggles(ctx);
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'لا يوجد ملف toggles. أضف modules/toggles.js');
}
async function _banwords(ctx) {
  if (banwordsModule?.handleBanwords) return banwordsModule.handleBanwords(ctx);
  const { bot, msg } = ctx;
  return bot.sendMessage(msg.chat.id, 'لا يوجد ملف banwords. أضف modules/banwords.js');
}

module.exports = {
  // نصدّر الاسمين للتماشي مع أي راوتر
  help: _help,
  handleHelp: _help,

  ignore: _ignore,
  handleIgnore: _ignore,

  allow: _allow,
  handleAllow: _allow,

  ignores: _ignores,
  handleIgnores: _ignores,

  group: _group,
  handleGroupCommand: _group,

  whitelist: _whitelist,
  handleWhitelist: _whitelist,

  status: _status,
  handleStatus: _status,

  rules: _rules,
  handleRules: _rules,

  toggles: _toggles,
  handleToggles: _toggles,

  banwords: _banwords,
  handleBanwords: _banwords,
};
