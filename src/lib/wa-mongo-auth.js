const mongoose = require('mongoose');
const { initAuthCreds, makeCacheableSignalKeyStore, BufferJSON } = require('@whiskeysockets/baileys');

const credsSchema = new mongoose.Schema(
  { _id: { type: String, default: 'creds' }, data: { type: String, required: true } },
  { versionKey: false }
);
const keySchema = new mongoose.Schema(
  { type: { type: String, index: true }, id: { type: String, index: true }, value: { type: String, required: true } },
  { versionKey: false }
);
keySchema.index({ type: 1, id: 1 }, { unique: true });

const CredsModel = mongoose.models.BaileysCreds || mongoose.model('BaileysCreds', credsSchema);
const KeyModel = mongoose.models.BaileysKey || mongoose.model('BaileysKey', keySchema);

async function mongoAuthState(logger) {
  const credsDoc = await CredsModel.findById('creds').lean();
  const creds = credsDoc ? JSON.parse(credsDoc.data, BufferJSON.reviver) : initAuthCreds();

  const signalKeyStore = {
    get: async (type, ids) => {
      const rows = await KeyModel.find({ type, id: { $in: ids } }).lean();
      const out = {};
      for (const r of rows) out[r.id] = JSON.parse(r.value, BufferJSON.reviver);
      return out;
    },
    set: async (data) => {
      const bulk = KeyModel.collection.initializeUnorderedBulkOp();
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const value = JSON.stringify(data[type][id], BufferJSON.replacer);
          bulk.find({ type, id }).upsert().replaceOne({ type, id, value });
        }
      }
      if (bulk.length > 0) await bulk.execute();
    },
    clear: async () => KeyModel.deleteMany({})
  };

  const keys = makeCacheableSignalKeyStore(signalKeyStore, logger);
  async function saveCreds() {
    const data = JSON.stringify(creds, BufferJSON.replacer);
    await CredsModel.findByIdAndUpdate('creds', { data }, { upsert: true, new: true });
  }
  return { state: { creds, keys }, saveCreds };
}

module.exports = { mongoAuthState };