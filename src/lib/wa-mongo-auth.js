'use strict';

/**
 * Baileys Mongo Auth State
 * -----------------------
 * يخزن الـ creds والـ keys داخل MongoDB بطريقة آمنة مع كاش بالذاكرة،
 * ويُعيد دوال saveCreds / clearAuth لاستخدامها مع socket.ev.
 */

const { MongoClient } = require('mongodb');

// ====== اتصال واحد مُعاد استخدامه (Singleton) ======
let _globalMongoClient = null;
async function getMongoClient(uri) {
  if (_globalMongoClient && _globalMongoClient.topology?.isConnected?.()) {
    return _globalMongoClient;
  }
  _globalMongoClient = new MongoClient(uri, {
    maxPoolSize: Number(process.env.MAX_POOL_SIZE || 5),
    serverSelectionTimeoutMS: 8000,
  });
  await _globalMongoClient.connect();
  return _globalMongoClient;
}

// إغلاق نظيف عند الإنهاء
function wireProcessCleanup() {
  if (wireProcessCleanup._wired) return;
  wireProcessCleanup._wired = true;
  const close = async () => {
    try { await _globalMongoClient?.close?.(); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

/**
 * mongoAuthState(logger?)
 *  - يعيد { state, saveCreds, clearAuth }
 *  - state: { creds, keys: { get, set } } لاستخدامه مع makeWASocket
 */
async function mongoAuthState(logger = console) {
  const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL;
  if (!MONGO_URI) {
    throw new Error('MONGODB_URI is required for mongoAuthState');
  }

  wireProcessCleanup();
  const client = await getMongoClient(MONGO_URI);
  const db = client.db(); // الافتراضي من الـ URI
  const credsCol = db.collection('BaileysCreds');
  const keysCol  = db.collection('BaileysKeys');

  // *** تحميل الـ creds من DB أو إنشاء مستند جديد ***
  const CREDS_ID = 'creds';
  let credsDoc = await credsCol.findOne({ _id: CREDS_ID });
  if (!credsDoc) {
    // بنية creds فارغة؛ Baileys سيملؤها عند أول QR
    credsDoc = { _id: CREDS_ID, data: {} };
    await credsCol.insertOne(credsDoc);
    logger.info('Initialized fresh Baileys creds in MongoDB.');
  }

  // كاش بالذاكرة لتقليل القراءة من DB
  let _creds = credsDoc.data || {};
  const _keysCache = new Map();

  // *** واجهة keys لـ Baileys ***
  const keys = {
    /**
     * get(type, ids)
     *  - يعيد كائن بالـ ids المطلوبة
     */
    get: async (type, ids) => {
      const out = {};
      const toFetch = [];
      for (const id of ids) {
        const keyName = `${type}:${id}`;
        if (_keysCache.has(keyName)) {
          out[id] = _keysCache.get(keyName);
        } else {
          toFetch.push({ _id: keyName });
        }
      }

      if (toFetch.length) {
        const found = await keysCol.find({ $or: toFetch }).toArray();
        for (const doc of found) {
          const [t, id] = String(doc._id).split(':');
          out[id] = doc.data;
          _keysCache.set(doc._id, doc.data);
        }
      }
      return out;
    },

    /**
     * set(data)
     *  - data: { [type]: { [id]: value } }
     */
    set: async (data) => {
      const bulk = keysCol.initializeUnorderedBulkOp();
      let hasOps = false;

      for (const type of Object.keys(data || {})) {
        const entries = data[type];
        for (const id of Object.keys(entries || {})) {
          const keyName = `${type}:${id}`;
          const value = entries[id];

          if (value == null) {
            // احذف المفتاح
            bulk.find({ _id: keyName }).delete();
            _keysCache.delete(keyName);
          } else {
            bulk.find({ _id: keyName }).upsert().updateOne({ $set: { data: value } });
            _keysCache.set(keyName, value);
          }
          hasOps = true;
        }
      }

      if (hasOps) await bulk.execute().catch(() => {});
    },
  };

  // *** دالة حفظ الـ creds ***
  async function saveCreds() {
    await credsCol.updateOne(
      { _id: CREDS_ID },
      { $set: { data: _creds } },
      { upsert: true }
    );
  }

  // *** دالة مسح الجلسة كاملة (creds + keys) ***
  async function clearAuth() {
    try {
      await credsCol.deleteOne({ _id: CREDS_ID });
      await keysCol.deleteMany({}); // امسح كلّ المفاتيح
      _creds = {};
      _keysCache.clear();
      logger.warn('Auth wiped: BaileysCreds + BaileysKeys cleared.');
    } catch (e) {
      logger.error({ e: e?.message }, 'Failed to clear auth');
    }
  }

  return {
    state: {
      creds: _creds,
      keys,
    },
    saveCreds,
    clearAuth,
  };
}

module.exports = { mongoAuthState, getMongoClient };
