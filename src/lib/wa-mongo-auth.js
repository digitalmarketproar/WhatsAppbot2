// src/lib/wa-mongo-auth.js
'use strict';

const { MongoClient } = require('mongodb');
const { initAuthCreds } = require('@whiskeysockets/baileys');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL;
const CREDS_COL = process.env.BAILEYS_CREDS_COLLECTION || 'BaileysCreds';
const KEYS_COL  = process.env.BAILEYS_KEY_COLLECTION  || 'BaileysKey';

let _client; // shared client
let _db;
let _credsCol;
let _keysCol;

async function ensureMongo(logger) {
  if (_db) return;
  if (!_client) {
    _client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await _client.connect();
  }
  _db = _client.db(); // default DB from URI
  _credsCol = _db.collection(CREDS_COL);
  _keysCol  = _db.collection(KEYS_COL);

  // فهرس بسيط للمفاتيح
  await _keysCol.createIndex({ _id: 1 }, { unique: true }).catch(() => {});
}

/**
 * بايليز يتوقع:
 *  state: { creds, keys }
 *  keys.get({ type, ids }) -> { [id]: value | undefined }  (مهم: ليس null)
 *  keys.set([{ type, id, value }])
 */
async function mongoAuthState(logger = console) {
  await ensureMongo(logger);

  // تحميل الاعتماد
  let credsDoc = await _credsCol.findOne({ _id: 'creds' });
  let creds = credsDoc?.data ? credsDoc.data : initAuthCreds();

  // --- مفاتيح الإشارة ---
  const keys = {
    /**
     * @param {{type: string, ids: string[]}} param0
     * @returns {Promise<Record<string, any>>}
     */
    async get({ type, ids }) {
      if (!Array.isArray(ids) || ids.length === 0) return {};
      // مفاتيحنا مخزنة بـ _id = `${type}:${id}`
      const queryIds = ids.map((id) => `${type}:${id}`);
      const docs = await _keysCol
        .find({ _id: { $in: queryIds } })
        .project({ _id: 1, value: 1 })
        .toArray();

      const out = {};
      // عَبِّئ الموجود
      for (const d of docs) {
        const [, id] = String(d._id).split(':');
        out[id] = d.value;
      }
      // القيَم غير الموجودة يجب أن تبقى undefined وليس null
      for (const id of ids) {
        if (!(id in out)) out[id] = undefined;
      }
      return out; // مهم: كائن، ليس null
    },

    /**
     * @param {{type: string, id: string, value: any}[]} data
     */
    async set(data) {
      if (!Array.isArray(data) || data.length === 0) return;
      const ops = data.map(({ type, id, value }) => ({
        updateOne: {
          filter: { _id: `${type}:${id}` },
          update: { $set: { value } },
          upsert: true,
        },
      }));
      await _keysCol.bulkWrite(ops, { ordered: false });
    },

    // اختيارية: حذف مفاتيح محددة (نادرًا ما تُستخدم)
    async delete({ type, ids }) {
      if (!Array.isArray(ids) || ids.length === 0) return;
      const delIds = ids.map((id) => `${type}:${id}`);
      await _keysCol.deleteMany({ _id: { $in: delIds } });
    },
  };

  async function saveCreds() {
    await _credsCol.updateOne(
      { _id: 'creds' },
      { $set: { data: creds } },
      { upsert: true }
    );
  }

  async function clearAuth() {
    await Promise.all([
      _credsCol.deleteMany({}),
      _keysCol.deleteMany({}),
    ]);
  }

  async function getHasCreds() {
    const c = await _credsCol.findOne({ _id: 'creds' });
    return !!c;
  }

  const state = { creds, keys };
  return { state, saveCreds, clearAuth, getHasCreds };
}

module.exports = { mongoAuthState };
