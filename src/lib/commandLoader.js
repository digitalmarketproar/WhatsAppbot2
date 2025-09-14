const fs = require('fs');
const path = require('path');
const logger = require('./logger');

function loadCommands(dir) {
  const commands = new Map(); // name -> run
  const aliases = new Map();  // alias -> name

  if (!fs.existsSync(dir)) return { commands, aliases };

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const full = path.join(dir, file);
    try {
      delete require.cache[require.resolve(full)];
      const mod = require(full);
      const name = (mod.name || path.basename(file, '.js')).trim();
      const run = mod.run || (typeof mod === 'function' ? mod : null);
      if (!name || typeof run !== 'function') continue;
      commands.set(name, run);
      const arr = Array.isArray(mod.aliases) ? mod.aliases : [];
      for (const a of arr) aliases.set(a, name);
      logger.info(`✅ Loaded command: ${name} (${file})`);
    } catch (e) {
      logger.error({ e }, `❌ Failed to load command from ${file}`);
    }
  }
  return { commands, aliases };
}

module.exports = { loadCommands };