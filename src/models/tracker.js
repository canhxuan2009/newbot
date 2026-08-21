const mongoose = require('mongoose');

const trackerSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    baseName: { type: String, required: true },
}, { timestamps: true });

// Compound index để truy vấn nhanh theo guildId + channelId
trackerSchema.index({ guildId: 1, channelId: 1 }, { unique: true });

module.exports = mongoose.model('Tracker', trackerSchema);
