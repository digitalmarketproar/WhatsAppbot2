// src/lib/logger.js
const pino = require('pino');

const isProd   = process.env.NODE_ENV === 'production';
const level    = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');
const pretty   = !isProd && (process.env.PRETTY_LOGS !== '0');

const logger = pino(
  pretty
    ? {
        level,
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:yyyy-mm-dd HH:MM:ss' }
        },
        // إخفاء احتمالية ظهور أسرار في اللوج
        redact: {
          paths: ['req.headers.authorization', 'auth', 'token', 'password', 'value'],
          censor: '[REDACTED]'
        }
      }
    : {
        level,
        redact: {
          paths: ['req.headers.authorization', 'auth', 'token', 'password', 'value'],
          censor: '[REDACTED]'
        }
      }
);

module.exports = logger;
