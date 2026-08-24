'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const QuestProfile = require('../src/models/questProfile');
const QuestSession = require('../src/models/questSession');
const QuestLog = require('../src/models/questLog');
const {
    QuestProviderUnavailableError,
} = require('../src/services/questProvider');
const {
    QuestSessionManager,
    mapSnapshotStatus,
    normalizePollInterval,
} = require('../src/services/questSessionManager');
const { handleQuestInteraction } = require('../src/utils/questInteractions');

test('provider-unavailable error exposes the session guard code', () => {
    const error = new QuestProviderUnavailableError();
    assert.equal(error.name, 'QuestProviderUnavailableError');
    assert.equal(error.code, 'QUEST_PROVIDER_UNAVAILABLE');
});

test('session manager requires both feature flag and configured provider', () => {
    const configuredProvider = { name: 'fake', isConfigured: () => true };
    const disabled = new QuestSessionManager({ provider: configuredProvider, enabled: false });
    assert.equal(disabled.isAvailable(), false);
    assert.throws(() => disabled.assertAvailable(), { code: 'QUEST_FEATURE_DISABLED' });

    const unavailable = new QuestSessionManager({
        provider: { name: 'missing', isConfigured: () => false },
        enabled: true,
    });
    assert.equal(unavailable.isAvailable(), false);
    assert.throws(() => unavailable.assertAvailable(), { code: 'QUEST_PROVIDER_UNAVAILABLE' });

    const available = new QuestSessionManager({ provider: configuredProvider, enabled: true });
    assert.equal(available.isAvailable(), true);
    assert.doesNotThrow(() => available.assertAvailable());
});

test('poll interval is clamped to the safe range', () => {
    assert.equal(normalizePollInterval('bad'), 60_000);
    assert.equal(normalizePollInterval(1), 15_000);
    assert.equal(normalizePollInterval(90_000), 90_000);
    assert.equal(normalizePollInterval(99_999_999), 15 * 60_000);
});

test('snapshot status mapping is deterministic', () => {
    assert.equal(mapSnapshotStatus({ completed: true }), 'done');
    assert.equal(mapSnapshotStatus({ expired: true }), 'expired');
    assert.equal(mapSnapshotStatus({ completable: false }), 'unsupported');
    assert.equal(mapSnapshotStatus({ completable: true, taskType: null }), 'unsupported');
    assert.equal(mapSnapshotStatus({ completable: true, taskType: 'WATCH_VIDEO', enrolled: true }), 'running');
    assert.equal(mapSnapshotStatus({ completable: true, taskType: 'WATCH_VIDEO', enrolled: false }), 'waiting');
});

test('Mongoose Quest documents validate without a database connection', async () => {
    const profile = new QuestProfile({ guildId: 'guild', requesterId: 'user' });
    await profile.validate();

    const session = new QuestSession({
        profileId: profile._id,
        guildId: 'guild',
        requesterId: 'user',
        activeKey: 'guild:user',
        quests: [{ name: 'Video', status: 'running', secondsDone: 5, secondsNeeded: 10 }],
    });
    await session.validate();

    const log = new QuestLog({
        profileId: profile._id,
        sessionId: session._id,
        action: 'session_started',
        status: 'success',
    });
    await log.validate();
});

test('QuestSession schema keeps the sparse unique active-session guard', () => {
    const activeIndex = QuestSession.schema.indexes()
        .find(([fields]) => fields.activeKey === 1);
    assert.ok(activeIndex, 'activeKey index is missing');
    assert.equal(activeIndex[1].unique, true);
    assert.equal(activeIndex[1].sparse, true);
});

test('Quest interaction router ignores unrelated components', async () => {
    const interaction = {
        isModalSubmit: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'shop_cancel',
    };
    assert.equal(await handleQuestInteraction(interaction), false);
});

test('Quest help interaction replies ephemerally without touching MongoDB', async () => {
    let reply;
    const interaction = {
        isModalSubmit: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'quest:help',
        guildId: 'guild',
        user: { id: 'user', displayName: 'Tester', username: 'tester' },
        reply: async (payload) => { reply = payload; },
    };

    assert.equal(await handleQuestInteraction(interaction), true);
    assert.equal(reply.ephemeral, true);
    assert.equal(reply.embeds[0].toJSON().title, '❔ Hướng dẫn Quest Assistant');
});

test('Quest router rejects direct-message interactions before session access', async () => {
    let reply;
    const interaction = {
        isModalSubmit: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: 'quest:stat',
        guildId: null,
        reply: async (payload) => { reply = payload; },
    };

    assert.equal(await handleQuestInteraction(interaction), true);
    assert.equal(reply.ephemeral, true);
    assert.match(reply.content, /chỉ hoạt động trong server/);
});
