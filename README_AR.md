# بوت واتساب — هيكلية نظيفة (عربي فقط)

- مبني على **Baileys**.
- بدون أي ميزات لإدارة القروبات (لا تحذيرات/طرد/سياسات).
- ردود عامة + قاموس كلمات عربية من `src/config/keywords.json`.
- أوامر تُستدعى ببادئة عربية بسيطة (افتراضيًا `>`).

## البدء
```bash
npm install
cp .env.example .env
# عدّل MONGODB_URI إذا أردت تخزين الحالة في Mongo
node index.js
```

## بنية المجلدات
```
src/
  app/         # express + whatsapp + telegram (اختياري)
  commands/    # أوامر (ملفات .js، كل ملف اسم الأمر)
  config/      # settings.js + keywords.json (عربي فقط)
  handlers/    # منطق استقبال الرسائل (مقسّم)
  lib/         # logger + db
  models/      # نماذج قاعدة البيانات (إن وُجدت)
```

## إضافة أمر جديد
أنشئ ملفًا `src/commands/الوقت.js`:

```js
module.exports.run = async (sock, m, args) => {
  await sock.sendMessage(m.key.remoteJid, { text: 'الساعة الآن: ' + new Date().toLocaleString('ar-EG') });
};
```

> ملاحظة: إذا كانت هناك **كلمة** في `keywords.json` تطابق اسم الأمر تمامًا، لا تنشئ أمرًا بنفس الاسم لتجنب التكرار — تم تنظيف المستودع ليحذف هذه الحالات تلقائيًا.