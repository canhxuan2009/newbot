const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    amount: { type: Number, required: true },
    type: { type: String, enum: ['ADD', 'SUB'], required: true },
    staffId: { type: String, required: true },
    channelId: { type: String, required: true },
    date: { type: Date, default: Date.now },
}, { _id: false });

const memberSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    totalAmount: { type: Number, default: 0 },
    transactions: { type: [transactionSchema], default: [] },
}, { timestamps: true });

memberSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Member', memberSchema);
