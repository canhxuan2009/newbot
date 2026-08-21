'use strict';

const SUPPORTED_TASKS = Object.freeze([
    'WATCH_VIDEO',
    'WATCH_VIDEO_ON_MOBILE',
    'PLAY_ON_DESKTOP',
    'STREAM_ON_DESKTOP',
    'PLAY_ACTIVITY',
]);

const VIDEO_TASKS = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);

/**
 * Python considers empty arrays/objects false. JavaScript does not, so the
 * port uses this helper where the reference implementation relies on Python
 * truthiness.
 */
function pythonTruthy(value) {
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function kget(value, ...keys) {
    if (!isObject(value)) return null;

    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            return value[key];
        }
    }

    return null;
}

function getTaskConfig(quest) {
    const config = isObject(quest?.config) ? quest.config : {};

    for (const key of ['taskConfig', 'task_config', 'taskConfigV2', 'task_config_v2']) {
        const value = config[key];
        if (pythonTruthy(value)) return value;
    }

    if (Object.prototype.hasOwnProperty.call(config, 'tasks')) return config;
    return null;
}

function getQuestName(quest) {
    const config = isObject(quest?.config) ? quest.config : {};
    const messages = isObject(config.messages) ? config.messages : {};
    const questName = kget(messages, 'questName', 'quest_name');
    if (pythonTruthy(questName)) return String(questName).trim();

    const gameTitle = kget(messages, 'gameTitle', 'game_title');
    if (pythonTruthy(gameTitle)) return String(gameTitle).trim();

    return `Quest#${quest?.id ?? '?'}`;
}

function getExpiresAt(quest) {
    const config = isObject(quest?.config) ? quest.config : {};
    return kget(config, 'expiresAt', 'expires_at');
}

/**
 * Python's reference compares timezone-aware datetimes only. A timestamp
 * without Z/offset becomes a naive datetime and is ignored by its try/catch.
 */
function parseAwareTimestamp(value) {
    if (typeof value !== 'string') return null;
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;

    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : timestamp;
}

function isExpired(quest, now = new Date()) {
    const taskConfig = getTaskConfig(quest);
    if (!isObject(taskConfig) || !Object.prototype.hasOwnProperty.call(taskConfig, 'tasks')) {
        return false;
    }

    const tasks = isObject(taskConfig.tasks) ? taskConfig.tasks : {};
    if (!SUPPORTED_TASKS.some((task) => tasks[task] !== null && tasks[task] !== undefined)) {
        return false;
    }

    const expiresAt = getExpiresAt(quest);
    if (!pythonTruthy(expiresAt)) return false;

    const expiresTimestamp = parseAwareTimestamp(expiresAt);
    if (expiresTimestamp === null) return false;
    return expiresTimestamp <= now.getTime();
}

function getUserStatus(quest) {
    const userStatus = kget(quest, 'userStatus', 'user_status');
    return isObject(userStatus) ? userStatus : {};
}

function isCompletable(quest, now = new Date()) {
    const expiresAt = getExpiresAt(quest);
    if (pythonTruthy(expiresAt)) {
        const expiresTimestamp = parseAwareTimestamp(expiresAt);
        if (expiresTimestamp !== null && expiresTimestamp <= now.getTime()) return false;
    }

    const taskConfig = getTaskConfig(quest);
    if (!pythonTruthy(taskConfig) || !isObject(taskConfig)) return false;

    const tasks = isObject(taskConfig.tasks) ? taskConfig.tasks : {};
    return SUPPORTED_TASKS.some((task) => tasks[task] !== null && tasks[task] !== undefined);
}

function isEnrolled(quest) {
    return pythonTruthy(kget(getUserStatus(quest), 'enrolledAt', 'enrolled_at'));
}

function isCompleted(quest) {
    return pythonTruthy(kget(getUserStatus(quest), 'completedAt', 'completed_at'));
}

function getTaskType(quest) {
    const taskConfig = getTaskConfig(quest);
    if (!pythonTruthy(taskConfig) || !isObject(taskConfig)) return null;

    const tasks = isObject(taskConfig.tasks) ? taskConfig.tasks : {};
    for (const task of SUPPORTED_TASKS) {
        if (tasks[task] !== null && tasks[task] !== undefined) return task;
    }

    return null;
}

function getSecondsNeeded(quest) {
    const taskConfig = getTaskConfig(quest);
    const taskType = getTaskType(quest);
    if (!pythonTruthy(taskConfig) || !isObject(taskConfig) || !taskType) return 0;

    const tasks = isObject(taskConfig.tasks) ? taskConfig.tasks : {};
    const taskData = tasks[taskType];

    if (isObject(taskData)) {
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
            if (Object.prototype.hasOwnProperty.call(taskData, key) && pythonTruthy(taskData[key])) {
                return Number(taskData[key]);
            }
        }
    } else if (typeof taskData === 'number' && pythonTruthy(taskData)) {
        return Number(taskData);
    }

    return 0;
}

function getSecondsDone(quest) {
    const taskType = getTaskType(quest);
    if (!taskType) return 0;

    const progress = isObject(getUserStatus(quest).progress)
        ? getUserStatus(quest).progress
        : {};
    const value = progress[taskType];

    if (isObject(value)) return Number(value.value ?? 0);
    return 0;
}

function getEnrolledAt(quest) {
    return kget(getUserStatus(quest), 'enrolledAt', 'enrolled_at');
}

function toQuestSnapshot(quest, now = new Date()) {
    return {
        id: quest?.id ?? null,
        name: getQuestName(quest),
        taskType: getTaskType(quest),
        secondsNeeded: getSecondsNeeded(quest),
        secondsDone: getSecondsDone(quest),
        enrolledAt: getEnrolledAt(quest),
        expiresAt: getExpiresAt(quest),
        enrolled: isEnrolled(quest),
        completed: isCompleted(quest),
        completable: isCompletable(quest, now),
        expired: isExpired(quest, now),
    };
}

module.exports = {
    SUPPORTED_TASKS,
    VIDEO_TASKS,
    getTaskConfig,
    getQuestName,
    getExpiresAt,
    isExpired,
    getUserStatus,
    isCompletable,
    isEnrolled,
    isCompleted,
    getTaskType,
    getSecondsNeeded,
    getSecondsDone,
    getEnrolledAt,
    toQuestSnapshot,
};
