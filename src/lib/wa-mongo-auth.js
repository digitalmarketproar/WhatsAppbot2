'use strict';

/**
 * Mongo-backed Baileys auth state
 * - يصلح مشكلة BSON Binary بتحويله إلى Buffer قبل تمريره للتشفير
 * - يعرض clearAuth لمسح الجلسة
 * - لا يعتبر وجود وثائق = Logged In؛ القرار يُترك لـ connection.update('open')
 */

const { MongoClient } = require('mongodb');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const MONGO_URI     = process.env.MONGODB_URI || process.env.MONGODB_URL;
const DB_NAME       = process.env.MONGODB_DB  || undefined; // اختياري
const CREDS_COL     = process.env.WA_CREDS_COL || 'BaileysCreds';
const KEYS_COL      = process.env.WA_KEYS_COL  || 'BaileysKey';

/** يحوّل أي قيمة BSON Binary إلى Buffer عادي */
function toBuf(val) {
  if (!val) return val;
  if (Buffer.isBuffer(val)) return val;
  if (val?.buffer instanceof Uint8Array) return Buffer.from(val.buffer);
  if (val?._bsontype === 'Binary' && val?.buffer) return Buffer.from(val.buffer);
  return val;
}

/** تحويل شجري: أي حقول مفاتيح بداخل object */
function deepFixBinary(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Buffer.isBuffer(obj)) return obj;
  if (Array.isArray(obj)) return obj.map(deepFixBinary);

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (
      k === 'private' || k === 'public' || k === 'keyData' ||
      k === 'pubKey'  || k === 'prvKey'  || k === 'signature' ||
      k === 'key'     || k === 'value'
    ) {
      out[k] = toBuf(v);
    } else if (v && typeof v === 'object') {
      out[k] = deepFixBinary(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function mongoAuthState(logger) {
  if (!MONGO_URI) throw new Error('MONGODB_URI required for mongoAuthState');

  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db   = DB_NAME ? client.db(DB_NAME) : client.db();
  const cCol = db.collection(CREDS_COL);
  const kCol = db.collection(KEYS_COL);

  // ---- load creds (أوراق الاعتماد) ----
  let credsDoc = await cCol.findOne({ _id: 'creds' });
  let creds = credsDoc?.data ? BufferJSON.reviver('', credsDoc.data) : null;

  // ملاحظة: إن لم توجد creds سننشئ initAuthCreds، لكن هذا لا يعني "مسجّل دخول"
  if (!creds) {
    creds = initAuthCreds();
    await cCol.updateOne(
      { _id: 'creds' },
      { $set: { data: BufferJSON.replacer('', creds), createdAt: Date.now() } },
      { upsert: true }
    );
    logger?.info?.('Initialized fresh Baileys creds in MongoDB.');
  } else {
    // أصلح أي حقول Binary → Buffer
    creds = deepFixBinary(creds);
  }

  // ---- key store (Signal keys) ----
  const keyStore = {
    /** read */
    async get(type, ids) {
      const data = {};
      for (const id of ids) {
        const doc = await kCol.findOne({ _id: `${type}-${id}` });
        if (doc?.value) {
          const v = BufferJSON.reviver('', doc.value);
          data[id] = deepFixBinary(v);
        }
      }
      return data;
    },
    /** write */
    async set(data) {
      const ops = [];
      for (const category in data) {
        for (const id in data[category]) {
          const value = BufferJSON.replacer('', data[category][id]);
          ops.push({
            updateOne: {
              filter: { _id: `${category}-${id}` },
              update: { $set: { value } },
              upsert: true
            }
          });
        }
      }
      if (ops.length) await kCol.bulkWrite(ops, { ordered: false });
    },
    /** delete */
    async remove(type, ids) {
      if (!ids?.length) return;
      await kCol.deleteMany({ _id: { $in: ids.map(id => `${type}-${id}`) } });
    }
  };

  async function saveCreds() {
    // Baileys يستدعيها في creds.update (تتغير Counters/IDs…)
    await cCol.updateOne(
      { _id: 'creds' },
      { $set: { data: BufferJSON.replacer('', creds), updatedAt: Date.now() } },
      { upsert: true }
    );
  }

  async function clearAuth() {
    await cCol.deleteMany({});
    await kCol.deleteMany({});
    // بعد المسح ننشئ قالب جديد فقط (لا يعني دخول)
    creds = initAuthCreds();
    await cCol.updateOne(
      { _id: 'creds' },
      { $set: { data: BufferJSON.replacer('', creds), createdAt: Date.now() } },
      { upsert: true }
    );
    // لا نغلق client هنا، نفس العملية ستكمل
  }

  return {
    state: { creds, keys: keyStore },
    saveCreds,
    clearAuth,
    /** للمراقبة أو التشخيص */
    _client: client
  };
}

module.exports = { mongoAuthState };
