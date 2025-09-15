// src/models/GroupSettings.js
const mongoose = require('mongoose');

const GroupSettingsSchema = new mongoose.Schema({
  groupId:          { type: String, index: true, required: true, unique: true },
  enabled:          { type: Boolean, default: true },

  // ترحيب/وداع
  welcomeEnabled:   { type: Boolean, default: true },
  farewellEnabled:  { type: Boolean, default: true },
  rules:            { type: String, default: '' },

  // فلاتر
  blockLinks:       { type: Boolean, default: false },
  blockMedia:       { type: Boolean, default: false },
  bannedWords:      { type: [String], default: [] },

  // ضبط التحذيرات
  maxWarnings:      { type: Number, default: 3 },

  // استثناء المشرفين — مفعّل افتراضيًا (لن تُحذف/تُحظر رسائل المشرفين)
  // يمكن لاحقًا إضافة أمر لتبديله إن لزم.
  exemptAdmins:     { type: Boolean, default: true },
}, {
  timestamps: true,
  versionKey: false,
});

module.exports = mongoose.model('GroupSettings', GroupSettingsSchema);
