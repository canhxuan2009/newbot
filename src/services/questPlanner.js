'use strict';

const {
    VIDEO_TASKS,
    getQuestName,
    getTaskType,
    getSecondsNeeded,
    getSecondsDone,
    isCompletable,
    isEnrolled,
    isCompleted,
} = require('./questParser');

/**
 * Pure port of the selection/order section in QuestWorker.run(). It does not
 * perform network mutations; an approved provider can consume this plan.
 */
function planQuestCycle(quests, { completedIds = new Set(), now = new Date() } = {}) {
    const safeQuests = Array.isArray(quests) ? quests : [];
    const knownCompletedIds = completedIds instanceof Set
        ? completedIds
        : new Set(completedIds || []);

    const stats = {
        total: safeQuests.length,
        enrolled: safeQuests.filter((quest) => isEnrolled(quest)).length,
        completed: safeQuests.filter((quest) => isCompleted(quest)).length,
        completable: safeQuests.filter((quest) => isCompletable(quest, now)).length,
    };

    const questMap = safeQuests
        .filter((quest) => isCompletable(quest, now))
        .map((quest) => {
            const id = quest?.id ?? null;
            return {
                id,
                name: getQuestName(quest),
                status: isCompleted(quest) || knownCompletedIds.has(id) ? 'done' : 'waiting',
                secondsDone: getSecondsDone(quest),
                secondsNeeded: getSecondsNeeded(quest),
                taskType: getTaskType(quest) || '',
            };
        });

    const unaccepted = safeQuests.filter((quest) => (
        !isEnrolled(quest)
        && !isCompleted(quest)
        && isCompletable(quest, now)
    ));

    const actionableRaw = safeQuests.filter((quest) => (
        isEnrolled(quest)
        && !isCompleted(quest)
        && isCompletable(quest, now)
        && !knownCompletedIds.has(quest?.id ?? null)
    ));
    const videoQuests = actionableRaw.filter((quest) => VIDEO_TASKS.has(getTaskType(quest)));
    const otherQuests = actionableRaw.filter((quest) => !VIDEO_TASKS.has(getTaskType(quest)));

    return {
        stats,
        questMap,
        unaccepted,
        actionable: [...videoQuests, ...otherQuests],
        videoQuests,
        otherQuests,
    };
}

function areAllDiscordQuestsDone(quests, now = new Date()) {
    const safeQuests = Array.isArray(quests) ? quests : [];
    return safeQuests.length > 0
        && safeQuests.every((quest) => isCompleted(quest) || !isCompletable(quest, now));
}

module.exports = { planQuestCycle, areAllDiscordQuestsDone };
