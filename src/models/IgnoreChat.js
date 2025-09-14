const mongoose = require("mongoose");

const ignoreChatSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true }, // 9677...@s.whatsapp.net أو ...@g.us
    addedBy: { type: String },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.models.IgnoreChat || mongoose.model("IgnoreChat", ignoreChatSchema);
