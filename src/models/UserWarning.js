const mongoose = require('mongoose');

const UserWarningSchema = new mongoose.Schema(
  {
    groupId: { type: String, required: true, index: true },
    userId:  { type: String, required: true, index: true }, // 9677...@s.whatsapp.net
    count:   { type: Number, default: 0 }
  },
  { timestamps: true, versionKey: false }
);

// فهرس مركّب لتسريع القراءة
UserWarningSchema.index({ groupId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.models.UserWarning || mongoose.model('UserWarning', UserWarningSchema);
