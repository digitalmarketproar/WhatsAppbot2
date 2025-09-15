// src/models/UserWarning.js
const mongoose = require('mongoose');

const UserWarningSchema = new mongoose.Schema({
  groupId: { type: String, index: true, required: true },
  userId:  { type: String, index: true, required: true }, // احفظه بصيغة @s.whatsapp.net
  count:   { type: Number, default: 0 },
}, {
  timestamps: true,
  versionKey: false,
});

UserWarningSchema.index({ groupId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('UserWarning', UserWarningSchema);
