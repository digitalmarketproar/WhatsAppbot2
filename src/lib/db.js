// src/lib/db.js
const mongoose = require('mongoose');
const logger = require('./logger');

async function connectMongo(uri) {
  if (!uri) {
    throw new Error('MONGODB_URI مطلوب لاستمرارية الاعتماد. أضِفه في بيئة التشغيل.');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  logger.info('✅ Connected to MongoDB');
  return mongoose;
}

module.exports = { connectMongo };
