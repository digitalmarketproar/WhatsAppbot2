// src/lib/wa-mongo-auth.js
'use strict';

const { MongoClient } = require('mongodb');
const { initAuthCreds } = require('@whiskeysockets/baileys');

const DB_NAME   = process.env.MONGODB_DBNAME || undefined;
const CREDS_COL = process.env.BAILEYS_CREDS_COLLECTION || 'BaileysCreds';
const KEYS_COL  = process.env.BAILEYS_KEY_COLLECTION   || 'BaileysKey';

function toBufferIfBinary(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (v && typeof v === 'object' && v._bsontype === 'Binary') return Buffer.from(v.buffer);
  return v;
}
function deepNormalize(obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(deepNormalize);
  if (typeof obj === 'object') {
    const direct = toBufferIfBinary(obj);
    if (Buffer.isBuffer(direct)) return direct;
    const out = {};
    for (const k of Object.keys(obj)) out[k] = deepNormalize(obj[k]);
    return out;
  }
  return obj;
}

async function mongoAuthState(logger) {
  const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL;
  if (!MONGO_URI) throw new Error('MONGODB_URI required');

  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db  = DB_NAME ? client.db(DB_NAME) : client.db();
  const cCreds = db.collection(CREDS_COL);
  const cKeys  = db.collection(KEYS_COL);

  async function readCreds() {
    const doc = await cCreds.findOne({ _id: 'creds' });
    if (!doc) return null;
    return deepNormalize(doc.data || doc);
  }
  async function writeCreds(creds) {
    await cCreds.updateOne(
      { _id: 'creds' },
      { $set: { data: creds } },
      { upsert: true }
    );
  }

  const keys = {
    get: async (type, ids) => {
      const result = {};
      if (!ids?.length) return result;
      const list = await cKeys.find({ type, id: { $in: ids } }).toArray();
      for (const it of list) result[it.id] = deepNormalize(it.value);
      return result;
    },
    set: async (data) => {
      if (!data) return;
      const bulk = cKeys.initializeUnorderedBulkOp();
      for (const type of Object.keys(data)) {
        const group = data[type] || {};
        for (const id of Object.keys(group)) {
          bulk.find({ type, id }).upsert().updateOne({
            $set: { type, id, value: group[id] }
          });
        }
      }
      if (bulk.length > 0) await bulk.execute();
    }
  };

  // ⚠️ أهم شيء: لو ما فيه وثيقة creds نولّد واحدة جديدة initAuthCreds()
  let creds = await readCreds();
  if (!creds) {
    creds = initAuthCreds();
    await writeCreds(creds);
    logger?.info?.('Initialized fresh Baileys creds in MongoDB.');
  }

  async function saveCreds() { await writeCreds(state.creds); }
  async function clearAuth()  { await cCreds.deleteMany({}); await cKeys.deleteMany({}); }
  async function getHasCreds(){ return !!(await cCreds.findOne({ _id: 'creds' }, { projection: { _id: 1 }})); }

  const state = { creds, keys };
  return { state, saveCreds, clearAuth, getHasCreds };
}

module.exports = { mongoAuthState };
