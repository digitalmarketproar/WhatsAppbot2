const AR_PREFIXES = ['>', '،', 'أمر ']; // أمثلة بادئات
function isCommand(text) {
  if (!text) return false;
  const t = text.trim();
  return AR_PREFIXES.some(p => t.startsWith(p));
}
function parseCommand(text) {
  const t = text.trim();
  // اقطع البادئة إن وجدت
  const pref = AR_PREFIXES.find(p => t.startsWith(p));
  const body = pref ? t.slice(pref.length).trim() : t;
  const [name, ...args] = body.split(/\s+/);
  return { name: (name||'').toLowerCase(), args };
}
module.exports = { isCommand, parseCommand };