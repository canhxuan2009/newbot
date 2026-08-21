'use strict';

const mongoose = require('mongoose');

const questLogSchema = new mongoose.Schema({
    profileId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'QuestProfile',
        required: true,
        index: true,
    },
    sessionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'QuestSession',
        required: true,
        index: true,
    },
    questId: { type: String, default: null },
    questName: { type: String, default: null },
    taskType: { type: String, default: null },
    action: { type: String, required: true },
    status: { type: String, required: true },
    message: { type: String, default: null },
}, { timestamps: true });

questLogSchema.index({ sessionId: 1, createdAt: -1 });

module.exports = mongoose.model('QuestLog', questLogSchema);
