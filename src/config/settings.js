require('dotenv').config();
module.exports = {
  PORT: process.env.PORT || 3000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  MONGODB_URI: process.env.MONGODB_URI || process.env.MONGODB_URL || '',
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
  TELEGRAM_ADMIN_ID: process.env.TELEGRAM_ADMIN_ID || ''
};