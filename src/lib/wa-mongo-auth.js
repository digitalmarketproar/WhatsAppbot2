// src/lib/wa-mongo-auth.js
'use strict';

const { MongoClient } = require('mongodb');
const makeDebug = require('./logger'); // لو كان لوجركم ديفولت اتركه
const logger = makeDebug.child ? makeDebug.child({ scope: 'wa-mongo-auth' }) : console;

// أسماء التجميعات من متغيرات البيئة
const DB_NAME   = process.env.MONGODB_DBNAME || undefined; // اختياري، يختار من URI إن لم يوجد
const CREDS_COL = process.env.BAILEYS_CREDS_COLLECTION || 'BaileysCreds';
const KEYS_COL  = process.env.BAILEYS_KEY_COLLECTION   || 'BaileysKey';

// ————— أدوات تحويل BSON Binary → Buffer —————
function toBufferIfBinary(v) {
  // Buffer أو Uint8Array: أرجعه Buffer
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  // MongoDB Binary: في الإصدارات الحديثة يكون كائن بـ _bsontype = 'Binary'
  if (v && typeof v === 'object' && v._bsontype === 'Binary') {
    // v.buffer هو Buffer داخلي
    return Buffer.from(v.buffer);
  }
  return v;
}

function deepNormalize(obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(deepNormalize);
  if (typeof obj === 'object') {
    // بعض الحقول تكون { type, data } أو باينري مباشر
    const direct = toBufferIfBinary(obj);
    if (Buffer.isBuffer(direct)) return direct;

    const out = {};
    for (const k of Object.keys(obj)) {
      out[k] = deepNormalize(obj[k]);
    }
    return out;
  }
  return obj;
}

// ————— واجهة بايليز auth state —————
async function mongoAuthState(extLogger) {
  const log = extLogger || logger;

  const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL;
  if (!MONGO_URI) throw new Error('MONGODB_URI required');

  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db  = DB_NAME ? client.db(DB_NAME) : client.db();
  const cCreds = db.collection(CREDS_COL);
  const cKeys  = db.collection(KEYS_COL);

  // ——— creds ———
  async function readCreds() {
    const doc = await cCreds.findOne({ _id: 'creds' });
    if (!doc) return null;
    // مهم: نحول أي Binary داخل الشجرة إلى Buffer
    const data = deepNormalize(doc.data || doc);
    return data;
  }

  async function writeCreds(creds) {
    // يمكن تخزين الـ Buffer كما هو؛ درايفر Mongo سيحوله Binary داخليًا.
    await cCreds.updateOne(
      { _id: 'creds' },
      { $set: { data: creds } },
      { upsert: true }
    );
  }

  async function clearAuth() {
    await cCreds.deleteMany({});
    await cKeys.deleteMany({});
  }

  async function getHasCreds() {
    const doc = await cCreds.findOne({ _id: 'creds' }, { projection: { _id: 1 }});
    return !!doc;
  }

  // ——— keys (sessions / sender keys / app state) ———
  // بايليز تتوقع دوال: get(type, ids) و set(data)
  const keys = {
    /**
     * type: 'pre-key' | 'session' | 'app-state-sync-key' | 'sender-key' | ...
     * ids:  string[]
     */
    get: async (type, ids) => {
      const result = {};
      if (!ids?.length) return result;

      const cursor = cKeys.find({ type, id: { $in: ids } });
      const list = await cursor.toArray();

      // رجع القيم الطبيعية (Buffer بدل Binary)
      for (const it of list) {
        // بعض الأنواع قيمها كائنات مع بايتات داخلية؛ نطبّق deepNormalize دائمًا
        result[it.id] = deepNormalize(it.value);
      }
      return result;
    },

    /**
     * data: { [type]: { [id]: any } }
     */
    set: async (data) => {
      if (!data) return;

      const bulk = cKeys.initializeUnorderedBulkOp();

      for (const type of Object.keys(data)) {
        const group = data[type] || {};
        for (const id of Object.keys(group)) {
          const value = group[id];
          bulk.find({ type, id }).upsert().updateOne({ $set: { type, id, value }});
        }
      }

      if (bulk.length > 0) {
        await bulk.execute();
      }
    }
  };

  // ——— واجهة بايليز الكاملة ———
  const state = {
    creds: await (async () => {
      const c = await readCreds();
      return c || {};
    })(),
    keys
  };

  async function saveCreds() {
    await writeCreds(state.creds);
  }

  return { state, saveCreds, clearAuth, getHasCreds };
}

module.exports = { mongoAuthState };
