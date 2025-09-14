const pino = require('pino');
const pretty = process.env.NODE_ENV !== 'production';
const logger = pino(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:yyyy-mm-dd HH:MM:ss' } } } : {});
module.exports = logger;