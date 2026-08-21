'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    SUPPORTED_TASKS,
    getTaskConfig,
    getQuestName,
    isExpired,
    isCompletable,
    isEnrolled,
    isCompleted,
    getTaskType,
    getSecondsNeeded,
    getSecondsDone,
    getEnrolledAt,
    toQuestSnapshot,
} = require('../src/services/questParser');

const NOW = new Date('2026-08-20T12:00:00.000Z');

function makeQuest(overrides = {}) {
    return {
        id: 'quest-1',
        config: {
            expiresAt: '2026-08-21T12:00:00.000Z',
            messages: { questName: '  Example Quest  ', gameTitle: 'Fallback Game' },
            taskConfig: {
                tasks: {
                    WATCH_VIDEO: { target: 120 },
                },
            },
        },
        userStatus: {
            enrolledAt: '2026-08-20T10:00:00.000Z',
            completedAt: null,
            progress: {
                WATCH_VIDEO: { value: 45 },
            },
        },
        ...overrides,
    };
}

test('keeps the Python supported-task priority', () => {
    assert.deepEqual(SUPPORTED_TASKS, [
        'WATCH_VIDEO',
        'WATCH_VIDEO_ON_MOBILE',
        'PLAY_ON_DESKTOP',
        'STREAM_ON_DESKTOP',
        'PLAY_ACTIVITY',
    ]);

    const quest = makeQuest();
    quest.config.taskConfig.tasks.PLAY_ON_DESKTOP = { target: 300 };
    assert.equal(getTaskType(quest), 'WATCH_VIDEO');
});

test('reads task config variants in the same order as Python', () => {
    const snakeConfig = { tasks: { PLAY_ACTIVITY: { duration_seconds: 30 } } };
    const quest = makeQuest({
        config: {
            taskConfig: {},
            task_config: snakeConfig,
            taskConfigV2: { tasks: { WATCH_VIDEO: { target: 5 } } },
        },
    });

    // Empty dict is false in Python, so task_config wins over taskConfig.
    assert.equal(getTaskConfig(quest), snakeConfig);
    assert.equal(getTaskType(quest), 'PLAY_ACTIVITY');
    assert.equal(getSecondsNeeded(quest), 30);
});

test('falls back from quest name to game title and then id', () => {
    assert.equal(getQuestName(makeQuest()), 'Example Quest');
    assert.equal(getQuestName(makeQuest({ config: { messages: { game_title: '  Game  ' } } })), 'Game');
    assert.equal(getQuestName({ id: 'abc', config: {} }), 'Quest#abc');
    assert.equal(getQuestName({}), 'Quest#?');
});

test('detects enrollment, completion and progress in camelCase', () => {
    const quest = makeQuest();
    assert.equal(isEnrolled(quest), true);
    assert.equal(isCompleted(quest), false);
    assert.equal(getEnrolledAt(quest), '2026-08-20T10:00:00.000Z');
    assert.equal(getSecondsNeeded(quest), 120);
    assert.equal(getSecondsDone(quest), 45);
});

test('detects enrollment and completion in snake_case', () => {
    const quest = makeQuest();
    delete quest.userStatus;
    quest.user_status = {
        enrolled_at: '2026-08-20T10:00:00.000Z',
        completed_at: '2026-08-20T11:00:00.000Z',
        progress: { WATCH_VIDEO: { value: 120 } },
    };

    assert.equal(isEnrolled(quest), true);
    assert.equal(isCompleted(quest), true);
    assert.equal(getSecondsDone(quest), 120);
});

test('does not fall through when the first alias exists with a null value', () => {
    const quest = makeQuest({
        userStatus: null,
        user_status: {
            enrolled_at: '2026-08-20T10:00:00.000Z',
            completed_at: '2026-08-20T11:00:00.000Z',
        },
    });

    assert.equal(isEnrolled(quest), false);
    assert.equal(isCompleted(quest), false);
});

test('matches expiry and completable behavior for aware timestamps', () => {
    const active = makeQuest();
    const expired = makeQuest();
    expired.config.expiresAt = '2026-08-19T12:00:00.000Z';

    assert.equal(isExpired(active, NOW), false);
    assert.equal(isCompletable(active, NOW), true);
    assert.equal(isExpired(expired, NOW), true);
    assert.equal(isCompletable(expired, NOW), false);
});

test('ignores malformed and timezone-naive expiry like the Python try/catch', () => {
    for (const expiresAt of ['not-a-date', '2026-08-19T12:00:00']) {
        const quest = makeQuest();
        quest.config.expiresAt = expiresAt;
        assert.equal(isExpired(quest, NOW), false);
        assert.equal(isCompletable(quest, NOW), true);
    }
});

test('does not treat unsupported or null tasks as completable', () => {
    const unsupported = makeQuest();
    unsupported.config.taskConfig.tasks = { SOME_NEW_TASK: { target: 10 } };
    const nullTask = makeQuest();
    nullTask.config.taskConfig.tasks = { WATCH_VIDEO: null };

    assert.equal(isCompletable(unsupported, NOW), false);
    assert.equal(getTaskType(unsupported), null);
    assert.equal(isCompletable(nullTask, NOW), false);
    assert.equal(getTaskType(nullTask), null);
});

test('reads numeric task definitions and all duration aliases', () => {
    const numeric = makeQuest();
    numeric.config.taskConfig.tasks.WATCH_VIDEO = 90;
    assert.equal(getSecondsNeeded(numeric), 90);

    for (const key of [
        'target',
        'duration',
        'seconds',
        'time',
        'durationSeconds',
        'duration_seconds',
        'totalSeconds',
        'total_seconds',
    ]) {
        const quest = makeQuest();
        quest.config.taskConfig.tasks.WATCH_VIDEO = { [key]: 75 };
        assert.equal(getSecondsNeeded(quest), 75, key);
    }
});

test('builds a normalized immutable-ready snapshot', () => {
    assert.deepEqual(toQuestSnapshot(makeQuest(), NOW), {
        id: 'quest-1',
        name: 'Example Quest',
        taskType: 'WATCH_VIDEO',
        secondsNeeded: 120,
        secondsDone: 45,
        enrolledAt: '2026-08-20T10:00:00.000Z',
        expiresAt: '2026-08-21T12:00:00.000Z',
        enrolled: true,
        completed: false,
        completable: true,
        expired: false,
    });
});
