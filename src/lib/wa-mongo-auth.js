'use strict';

/**
 * Mongo-backed Baileys auth state with proper Buffer serialization
 * - Uses BufferJSON replacer/reviver so keys/creds stay valid
 * - Initializes creds via initAuthCreds() on first run
 * - Stores keys per type in BaileysKeys, and creds in BaileysCreds
 */

const { MongoClient } = require('mongodb');
const {
  initAuthCreds,
  BufferJSON,
} = require('@whiskeysockets/baileys');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL;
if (!MONGO_URI) {
  throw new Error('MONGODB_URI is required for wa-mongo-auth');
}

// وثّق أسماء المجموعات هنا لتوحيدها
const CREDS_COL = process.env.WA_CREDS_COLLECTION || 'BaileysCreds';
const KEYS_COL  = process.env.WA_KEYS_COLLECTION  || 'BaileysKeys';

// المفتاح الوحيد لمحفظة هذا التطبيق (يمكنك تغييره لو أردت دعم تعدد الأجهزة)
const CREDS_DOC_ID = process.env.WA_CREDS_ID || 'default';

// الأنواع المعروفة في Baileys (لا بأس بإضافة/حذف حسب النسخة)
const VALID_KEY_TYPES = new Set([
  'pre-key',
  'session',
  'sender-key',
  'app-state-sync-key',
  'app-state-sync-version',
  'sender-key-memory',
  'adv-secret-key',
  'account',
  'app-state-sync-key-data',
  'app-state-sync-key-share',
  'sender-key-retry',
]);

/**
 * mongoAuthState(logger?)
 * يعيد { state, saveCreds, clearAuth }
 */
async function mongoAuthState(logger = console) {
  // اتّصال خفيف لتجنّب Alert الحد الأقصى للاتصالات على M0
  const client = new MongoClient(MONGO_URI, {
    maxPoolSize: 3,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 8000,
  });
  await client.connect();

  const db        = client.db();
  const credsCol  = db.collection(CREDS_COL);
  const keysCol   = db.collection(KEYS_COL);

  // تحميل/تهيئة creds
  let credsDoc = await credsCol.findOne({ _id: CREDS_DOC_ID });
  let creds    = credsDoc?.data
    ? JSON.parse(JSON.stringify(credsDoc.data), BufferJSON.reviver)
    : initAuthCreds(); // ← مهم

  // مُخزن مفاتيح كسول — نحفظ/نقرأ حسب الطلب
  const keyStore = {
    /**
     * get(type, ids[])
     * يعيد كائنًا { id: value } لكل id موجود
     */
    async get(type, ids) {
      const out = {};
      if (!ids || ids.length === 0) return out;
      if (!VALID_KEY_TYPES.has(type)) return out;

      const docs = await keysCol
        .find({ type, id: { $in: ids.map(String) } })
        .toArray();

      for (const d of docs) {
        // استعادة Buffer
        out[d.id] = d.value ? JSON.parse(JSON.stringify(d.value), BufferJSON.reviver) : null;
      }
      return out;
    },

    /**
     * set(data)
     * data: { [type]: { [id]: value } }
     */
    async set(data) {
      const bulk = keysCol.initializeUnorderedBulkOp();
      let hasOps = false;

      for (const type of Object.keys(data || {})) {
        if (!VALID_KEY_TYPES.has(type)) continue;
        const entries = data[type] || {};
        for (const id of Object.keys(entries)) {
          const value = entries[id];

          // حذف المفتاح لو null، غير ذلك حدّث/أدرج
          if (value === null || typeof value === 'undefined') {
            bulk.find({ type, id: String(id) }).deleteOne();
            hasOps = true;
          } else {
            const serialized = JSON.parse(
              JSON.stringify(value, BufferJSON.replacer)
            );
            bulk
              .find({ type, id: String(id) })
              .upsert()
              .updateOne({ $set: { type, id: String(id), value: serialized } });
            hasOps = true;
          }
        }
      }

      if (hasOps) await bulk.execute();
    },
  };

  // حفظ الكريدنز
  async function saveCreds() {
    const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await credsCol.updateOne(
      { _id: CREDS_DOC_ID },
      { $set: { _id: CREDS_DOC_ID, data: serialized, ts: Date.now() } },
      { upsert: true }
    );
  }

  // مسح كل شيء لإجبار QR جديد
  async function clearAuth() {
    await credsCol.deleteOne({ _id: CREDS_DOC_ID }).catch(() => {});
    await keysCol.deleteMany({}).catch(() => {});
    // إعادة تعيين الذاكرة
    creds = initAuthCreds();
    logger.warn('Auth collections cleared. Next connect will require QR.');
  }

  // واجهة Baileys الرسمية
  const state = {
    creds,
    keys: keyStore,
  };

  // إرجاع أدوات الحفظ/المسح مع state
  return {
    state,
    saveCreds,
    clearAuth,
    // اختياري: وسيلة إغلاق اتصال Mongo نظيفًا عند الخروج
    close: async () => {
      try { await client.close(); } catch {}
    },
  };
}

module.exports = { mongoAuthState };
