const mongoose = require('mongoose');

const GroupSettingsSchema = new mongoose.Schema(
  {
    groupId: { type: String, required: true, unique: true, index: true }, // 1203...@g.us
    enabled: { type: Boolean, default: false },

    // قوانين (نص حر/Markdown بسيط)
    rules: { type: String, default: '' },
    welcomeEnabled: { type: Boolean, default: true },
    farewellEnabled: { type: Boolean, default: true },

    // سياسات المنع
    blockMedia: { type: Boolean, default: true },
    blockLinks: { type: Boolean, default: true },

    // كلمات محظورة (نخزّنها غير مطبّعة، ونطبّع وقت المطابقة)
    bannedWords: { type: [String], default: [] },

    // التحذيرات
    maxWarnings: { type: Number, default: 3 }
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.models.GroupSettings || mongoose.model('GroupSettings', GroupSettingsSchema);
