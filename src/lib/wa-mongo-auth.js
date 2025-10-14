'use strict';

/**
 * Mongo-backed Baileys auth state (strict Buffer sanitization)
 * - يحوّل أي Binary/BSON أو كائنات مشابهة لـ Buffer إلى Buffers حقيقية
 * - يصلّح كل الحقول الحساسة (noiseKey, signedIdentityKey, signedPreKey, advSecretKey,
 *   pairingEphemeralKeyPair, account, me, processingPending, platform, preKeys, sessions...)
 * - clearAuth يمسح ثم يُعيد تهيئة قالب نظيف
 */

const { MongoClient } = require('mongodb');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL;
const DB_NAME   = process.env.MONGODB_DB  || undefined;
const CREDS_COL = process.env.WA_CREDS_COL || 'BaileysCreds';
const KEYS_COL  = process.env.WA_KEYS_COL  || 'BaileysKey';

/* ------------------------ Helpers: Buffer coercion ------------------------ */

function isLikeBuffer(v) {
  // أشكال قد ترجع من Mongo/JSON
  if (!v) return false;
  if (Buffer.isBuffer(v)) return true;
  if (v instanceof Uint8Array) return true;
  if (v?.type === 'Buffer' && Array.isArray(v?.data)) return true; // JSON.stringify(Buffer)
  if (v?._bsontype === 'Binary' && v?.buffer) return true;         // BSON Binary
  if (v?.buffer instanceof Uint8Array) return true;
  return false;
}

function toBuf(v) {
  if (!v) return v;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (v?.type === 'Buffer' && Array.isArray(v?.data)) return Buffer.from(v.data);
  if (v?._bsontype === 'Binary' && v?.buffer) return Buffer.from(v.buffer);
  if (v?.buffer instanceof Uint8Array) return Buffer.from(v.buffer);
  return v;
}

// تُصلح كل الحقول الثنائية داخل شجرة الاعتماد/المفاتيح
function deepFixBinary(x) {
  if (x == null) return x;
  if (isLikeBuffer(x)) return toBuf(x);
  if (Array.isArray(x)) return x.map(deepFixBinary);
  if (typeof x !== 'object') return x;

  const out = Array.isArray(x) ? [] : {};
  for (const [k, v] of Object.entries(x)) {
    // أسماء شائعة لحقول ثنائية في Baileys/Signal
    if (
      k === 'private' || k === 'public' || k === 'privKey' || k === 'pubKey' ||
      k === 'prvKey'  || k === 'signature' || k === 'keyData' || k === 'value' ||
      k === 'noiseKey' || k === 'advSecretKey' || k === 'identityKey' ||
      k === 'signedIdentityKey' || k === 'signedPreKey' ||
      k === 'pairingEphemeralKeyPair' || k === 'account' ||
      k === 'hash' || k === 'salt' || k === 'ciphertext'
    ) {
      // قد يكون الكائن داخله مفاتيح/خصائص أخرى — طبّق deep
      if (v && typeof v === 'object' && !isLikeBuffer(v)) {
        out[k] = deepFixBinary(v);
      } else {
        out[k] = toBuf(v);
      }
    } else if (v && typeof v === 'object') {
      out[k] = deepFixBinary(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ------------------------------ Main logic ------------------------------ */

async function mongoAuthState(logger) {
  if (!MONGO_URI) throw new Error('MONGODB_URI required for mongoAuthState');

  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db   = DB_NAME ? client.db(DB_NAME) : client.db();
  const cCol = db.collection(CREDS_COL);
  const kCol = db.collection(KEYS_COL);

  // ---- load creds ----
  let credsDoc = await cCol.findOne({ _id: 'creds' });
  let creds = credsDoc?.data ? BufferJSON.reviver('', credsDoc.data) : null;

  if (!creds) {
    creds = initAuthCreds();
    // خزّن كـ BufferJSON (سيحفظ Buffers بشكل صحيح)
    await cCol.updateOne(
      { _id: 'creds' },
      { $set: { data: BufferJSON.replacer('', creds), createdAt: Date.now() } },
      { upsert: true }
    );
    logger?.info?.('Initialized fresh Baileys creds in MongoDB.');
  } else {
    // أصلح كل القيم الثنائية
    creds = deepFixBinary(creds);
    // أعد حفظها بشكل مصحّح حتى لا تعود تالفة لاحقًا
    await cCol.updateOne(
      { _id: 'creds' },
      { $set: { data: BufferJSON.replacer('', creds), repairedAt: Date.now() } },
      { upsert: true }
    );
  }

  // ---- key store ----
  const keyStore = {
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
    async set(data) {
      const ops = [];
      for (const category in data) {
        for (const id in data[category]) {
          const value = BufferJSON.replacer('', deepFixBinary(data[category][id]));
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
    async remove(type, ids) {
      if (!ids?.length) return;
      await kCol.deleteMany({ _id: { $in: ids.map(id => `${type}-${id}`) } });
    }
  };

  async function saveCreds() {
    // Baileys يمرر كائن نفس المرجع — عالج قبل الحفظ
    const fixed = deepFixBinary(creds);
    await cCol.updateOne(
      { _id: 'creds' },
      { $set: { data: BufferJSON.replacer('', fixed), updatedAt: Date.now() } },
      { upsert: true }
    );
  }

  async function clearAuth() {
    await cCol.deleteMany({});
    await kCol.deleteMany({});
    creds = initAuthCreds();
    await cCol.updateOne(
      { _id: 'creds' },
      { $set: { data: BufferJSON.replacer('', creds), createdAt: Date.now() } },
      { upsert: true }
    );
  }

  return {
    state: { creds, keys: keyStore },
    saveCreds,
    clearAuth,
    _client: client
  };
}

module.exports = { mongoAuthState };
