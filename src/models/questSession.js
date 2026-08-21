'use strict';

const mongoose = require('mongoose');

const questSnapshotSchema = new mongoose.Schema({
    questId: { type: String, default: null },
    name: { type: String, required: true },
    taskType: { type: String, default: null },
    status: {
        type: String,
        enum: ['waiting', 'running', 'done', 'expired', 'unsupported'],
        required: true,
    },
    secondsDone: { type: Number, default: 0 },
    secondsNeeded: { type: Number, default: 0 },
    expiresAt: { type: String, default: null },
}, { _id: false });

const questSessionSchema = new mongoose.Schema({
    profileId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'QuestProfile',
        required: true,
        index: true,
    },
    guildId: { type: String, required: true, index: true },
    requesterId: { type: String, required: true, index: true },
    displayName: { type: String, default: 'User' },
    status: {
        type: String,
        enum: ['starting', 'running', 'stopping', 'completed', 'stopped', 'failed', 'interrupted'],
        default: 'starting',
        index: true,
    },
    // Present only while a session is active. The sparse unique index makes
    // duplicate starts impossible even when multiple bot instances race.
    activeKey: { type: String },
    pollCount: { type: Number, default: 0 },
    quests: { type: [questSnapshotSchema], default: [] },
    lastError: { type: String, default: null },
    stopReason: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    lastPolledAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
}, { timestamps: true });

questSessionSchema.index({ activeKey: 1 }, { unique: true, sparse: true });
questSessionSchema.index({ guildId: 1, requesterId: 1, createdAt: -1 });

module.exports = mongoose.model('QuestSession', questSessionSchema);
