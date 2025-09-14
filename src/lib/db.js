const mongoose = require('mongoose');
const logger = require('./logger');
async function connectMongo(uri) {
  if (!uri) {
    logger.warn('MongoDB URI is empty; continuing without DB (memory-only auth may fail).');
    return null;
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  logger.info('✅ Connected to MongoDB');
  return mongoose;
}
module.exports = { connectMongo };