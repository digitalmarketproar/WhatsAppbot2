// src/lib/wa-mongo-auth.js
const mongoose = require('mongoose');
const {
  initAuthCreds,
  makeCacheableSignalKeyStore,
  BufferJSON
} = require('@whiskeysockets/baileys');

const CREDS_COL = process.env.BAILEYS_CREDS_COLLECTION || 'BaileysCreds';
const KEYS_COL  = process.env.BAILEYS_KEY_COLLECTION  || 'BaileysKey';

const credsSchema = new mongoose.Schema(
  { _id: { type: String, default: 'creds' }, data: { type: String, required: true } },
  { versionKey: false, collection: CREDS_COL }
);

const keySchema = new mongoose.Schema(
  { type: { type: String, index: true }, id: { type: String, index: true }, value: { type: String, required: true } },
  { versionKey: false, collection: KEYS_COL }
);
keySchema.index({ type: 1, id: 1 }, { unique: true });

const CredsModel = mongoose.models[CREDS_COL] || mongoose.model(CREDS_COL, credsSchema);
const KeyModel   = mongoose.models[KEYS_COL]  || mongoose.model(KEYS_COL,  keySchema);

async function mongoAuthState(logger) {
  // تحميل الـcreds من Mongo أو تهيئة جديدة
  let stored = await CredsModel.findById('creds').lean();
  const creds = stored?.data
    ? JSON.parse(stored.data, BufferJSON.reviver)
    : initAuthCreds();

  const signalKeyStore = {
    get: async (type, id) => {
      const doc = await KeyModel.findOne({ type, id }).lean();
      return doc?.value ? JSON.parse(doc.value, BufferJSON.reviver) : null;
    },
    set: async (type, id, value) => {
      const v = JSON.stringify(value, BufferJSON.replacer);
      await KeyModel.updateOne({ type, id }, { $set: { value: v } }, { upsert: true });
    },
    delete: async (type, id) => {
      await KeyModel.deleteOne({ type, id });
    },
    getAll: async (type) => {
      const docs = await KeyModel.find({ type }).lean();
      return docs.map(d => [d.id, JSON.parse(d.value, BufferJSON.reviver)]);
    },
    clear: async () => KeyModel.deleteMany({})
  };

  const keys = makeCacheableSignalKeyStore(signalKeyStore, logger);

  async function saveCreds() {
    const data = JSON.stringify(creds, BufferJSON.replacer);
    await CredsModel.findByIdAndUpdate('creds', { data }, { upsert: true, new: true });
  }

  async function clearAuth() {
    await Promise.all([
      CredsModel.deleteMany({}),
      KeyModel.deleteMany({})
    ]);
  }

  async function getHasCreds() {
    const c = await CredsModel.countDocuments({});
    const k = await KeyModel.countDocuments({});
    return (c > 0) || (k > 0);
  }

  return { state: { creds, keys }, saveCreds, clearAuth, getHasCreds, models: { CredsModel, KeyModel } };
}

module.exports = { mongoAuthState };
