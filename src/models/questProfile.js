'use strict';

const mongoose = require('mongoose');

const questProfileSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    requesterId: { type: String, required: true, index: true },
    displayName: { type: String, default: 'User' },
    provider: { type: String, default: 'discord_oauth' },
    discordToken: { type: String, default: null },
    enabled: { type: Boolean, default: true },
    autoResume: { type: Boolean, default: true },
}, { timestamps: true });

questProfileSchema.index({ guildId: 1, requesterId: 1 }, { unique: true });

module.exports = mongoose.model('QuestProfile', questProfileSchema);
