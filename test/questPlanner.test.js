'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planQuestCycle, areAllDiscordQuestsDone } = require('../src/services/questPlanner');

const NOW = new Date('2026-08-20T12:00:00.000Z');

function quest(id, taskType, { enrolled = true, completed = false, expired = false } = {}) {
    return {
        id,
        config: {
            expiresAt: expired ? '2026-08-19T12:00:00.000Z' : '2026-08-21T12:00:00.000Z',
            messages: { questName: id },
            taskConfig: { tasks: { [taskType]: { target: 60 } } },
        },
        userStatus: {
            enrolledAt: enrolled ? '2026-08-20T10:00:00.000Z' : null,
            completedAt: completed ? '2026-08-20T11:00:00.000Z' : null,
            progress: { [taskType]: { value: completed ? 60 : 10 } },
        },
    };
}

test('matches Python cycle counts and video-first ordering', () => {
    const quests = [
        quest('game', 'PLAY_ON_DESKTOP'),
        quest('video', 'WATCH_VIDEO'),
        quest('activity', 'PLAY_ACTIVITY'),
        quest('unaccepted', 'WATCH_VIDEO_ON_MOBILE', { enrolled: false }),
        quest('done', 'STREAM_ON_DESKTOP', { completed: true }),
        quest('expired', 'WATCH_VIDEO', { expired: true }),
    ];

    const plan = planQuestCycle(quests, { now: NOW });
    assert.deepEqual(plan.stats, { total: 6, enrolled: 5, completed: 1, completable: 5 });
    assert.deepEqual(plan.unaccepted.map((item) => item.id), ['unaccepted']);
    assert.deepEqual(plan.videoQuests.map((item) => item.id), ['video']);
    assert.deepEqual(plan.otherQuests.map((item) => item.id), ['game', 'activity']);
    assert.deepEqual(plan.actionable.map((item) => item.id), ['video', 'game', 'activity']);
});

test('keeps locally completed ids out of actionable work and marks them done', () => {
    const quests = [quest('video', 'WATCH_VIDEO'), quest('game', 'PLAY_ON_DESKTOP')];
    const plan = planQuestCycle(quests, { completedIds: new Set(['video']), now: NOW });

    assert.deepEqual(plan.actionable.map((item) => item.id), ['game']);
    assert.equal(plan.questMap.find((item) => item.id === 'video').status, 'done');
});

test('requires a non-empty verified list before declaring all quests done', () => {
    assert.equal(areAllDiscordQuestsDone([], NOW), false);
    assert.equal(areAllDiscordQuestsDone([quest('done', 'WATCH_VIDEO', { completed: true })], NOW), true);
    assert.equal(areAllDiscordQuestsDone([quest('expired', 'WATCH_VIDEO', { expired: true })], NOW), true);
    assert.equal(areAllDiscordQuestsDone([quest('pending', 'WATCH_VIDEO')], NOW), false);
});
