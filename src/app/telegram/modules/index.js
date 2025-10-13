// src/app/telegram/modules/index.js
module.exports = {
  handleGroupCommand : require('./group').run,
  handleHelp         : require('./help').run,
  handleIgnore       : require('./ignore').run,
  handleWhitelist    : require('./whitelist').run,
  handleStatus       : require('./status').run,
  handleRules        : require('./rules').run,
  handleToggles      : require('./toggles').run,
  handleBanwords     : require('./banwords').run,
};
