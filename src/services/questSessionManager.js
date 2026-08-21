'use strict';

const QuestProfile = require('../models/questProfile');
const QuestSession = require('../models/questSession');
const QuestLog = require('../models/questLog');
const logger = require('../utils/logger');
const { toQuestSnapshot, getTaskType } = require('./questParser');
const { createQuestProvider, QuestProviderUnavailableError } = require('./questProvider');

const ACTIVE_STATUSES = ['starting', 'running', 'stopping'];

class QuestFeatureDisabledError extends Error {
    constructor() {
        super('Tính năng Quest đang bị tắt bởi QUEST_ENABLED.');
        this.name = 'QuestFeatureDisabledError';
        this.code = 'QUEST_FEATURE_DISABLED';
    }
}

class QuestAlreadyRunningError extends Error {
    constructor() {
        super('Bạn đã có một phiên Quest đang chạy.');
        this.name = 'QuestAlreadyRunningError';
        this.code = 'QUEST_ALREADY_RUNNING';
    }
}

function envFlag(value, fallback = false) {
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizePollInterval(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 60_000;
    return Math.max(15_000, Math.min(parsed, 15 * 60_000));
}

function waitWithSignal(milliseconds, signal) {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve(false);
            return;
        }

        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        }, milliseconds);

        function onAbort() {
            clearTimeout(timer);
            resolve(false);
        }

        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function sessionKey(guildId, requesterId) {
    return `${guildId}:${requesterId}`;
}

function mapSnapshotStatus(snapshot) {
    if (snapshot.completed) return 'done';
    if (snapshot.expired) return 'expired';
    if (!snapshot.completable || !snapshot.taskType) return 'unsupported';
    if (snapshot.enrolled) return 'running';
    return 'waiting';
}

class QuestSessionManager {
    constructor({
        provider = createQuestProvider(),
        enabled = envFlag(process.env.QUEST_ENABLED, false),
        pollIntervalMs = normalizePollInterval(process.env.QUEST_POLL_INTERVAL_MS),
    } = {}) {
        this.provider = provider;
        this.enabled = enabled;
        this.pollIntervalMs = pollIntervalMs;
        this.workers = new Map();
        this.initialized = false;
    }

    isAvailable() {
        return this.enabled && this.provider.isConfigured();
    }

    assertAvailable() {
        if (!this.enabled) throw new QuestFeatureDisabledError();
        if (!this.provider.isConfigured()) throw new QuestProviderUnavailableError();
    }

    async initialize() {
        if (this.initialized) return;
        this.initialized = true;

        if (!this.enabled) {
            logger.info('[Quest] Module đã nạp nhưng đang tắt (QUEST_ENABLED=false).');
            return;
        }

        if (!this.provider.isConfigured()) {
            logger.warn('[Quest] Chưa có provider API chính thức; Start Session sẽ bị khóa.');
            return;
        }

        const sessions = await QuestSession.find({ status: { $in: ACTIVE_STATUSES } });
        for (const session of sessions) {
            const profile = await QuestProfile.findById(session.profileId);
            if (!profile?.enabled || !profile.autoResume) {
                await this._finishSession(session._id, 'interrupted', 'restart_no_resume');
                continue;
            }

            await this._attachWorker(session, profile);
        }

        logger.info(`[Quest] Đã khôi phục ${this.workers.size} session.`);
    }

    async start({ guildId, requesterId, displayName }) {
        this.assertAvailable();
        const key = sessionKey(guildId, requesterId);
        if (this.workers.has(key)) throw new QuestAlreadyRunningError();

        const profile = await QuestProfile.findOneAndUpdate(
            { guildId, requesterId },
            {
                $set: { displayName, enabled: true },
                $setOnInsert: { provider: this.provider.name, autoResume: true },
            },
            { new: true, upsert: true, runValidators: true },
        );

        let session;
        try {
            session = await QuestSession.create({
                profileId: profile._id,
                guildId,
                requesterId,
                displayName,
                activeKey: key,
                status: 'starting',
            });
        } catch (error) {
            if (error?.code === 11000) throw new QuestAlreadyRunningError();
            throw error;
        }

        await QuestLog.create({
            profileId: profile._id,
            sessionId: session._id,
            action: 'session_started',
            status: 'success',
        });

        await this._attachWorker(session, profile);
        return session.toObject();
    }

    async _attachWorker(session, profile) {
        const key = sessionKey(session.guildId, session.requesterId);
        if (this.workers.has(key)) return;

        const controller = new AbortController();
        const worker = {
            controller,
            sessionId: session._id,
            promise: null,
        };

        this.workers.set(key, worker);
        worker.promise = this._run(session, profile, controller.signal)
            .catch((error) => logger.error(`[Quest] Worker ${key}: ${error.message}`))
            .finally(() => this.workers.delete(key));
    }

    async _run(session, profile, signal) {
        let finalStatus = 'stopped';
        let stopReason = 'manual';

        try {
            await QuestSession.updateOne(
                { _id: session._id },
                { $set: { status: 'running', lastError: null } },
            );

            let pollCount = session.pollCount || 0;
            const completedIds = new Set();
            
            while (!signal.aborted) {
                pollCount += 1;
                const quests = await this.provider.listQuests({ profile, signal });
                const now = new Date();
                
                const { planQuestCycle } = require('./questPlanner');
                const plan = planQuestCycle(quests, { completedIds, now });
                
                const snapshots = plan.questMap;

                await QuestSession.updateOne(
                    { _id: session._id },
                    { $set: { quests: snapshots, pollCount, lastPolledAt: now } },
                );

                if (plan.stats.total > 0 && plan.stats.total === plan.stats.completed) {
                    finalStatus = 'completed';
                    stopReason = 'completed';
                    break;
                }

                // Enroll unaccepted quests
                for (const quest of plan.unaccepted) {
                    if (signal.aborted) break;
                    logger.info(`[Quest] Enrolling quest ${quest.id}...`);
                    await this.provider.enrollQuest({ profile, quest, signal });
                    await waitWithSignal(2000, signal);
                }

                // Process actionable quests
                for (const quest of plan.actionable) {
                    if (signal.aborted) break;
                    const taskType = getTaskType(quest);
                    logger.info(`[Quest] Processing quest ${quest.id} (taskType: ${taskType})...`);
                    
                    const onProgress = (done, needed) => {
                        // We could potentially update DB with progress here if needed
                    };
                    
                    let success = false;
                    if (['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE'].includes(taskType)) {
                        success = await this.provider.completeVideo({ profile, quest, signal, onProgress });
                    } else if (['PLAY_ON_DESKTOP', 'STREAM_ON_DESKTOP', 'PLAY_ACTIVITY'].includes(taskType)) {
                        success = await this.provider.completeHeartbeat({ profile, quest, signal, onProgress });
                    }

                    if (success) {
                        logger.info(`[Quest] Quest ${quest.id} completed successfully.`);
                        completedIds.add(quest.id);
                        await QuestLog.create({
                            profileId: profile._id,
                            sessionId: session._id,
                            action: 'quest_completed',
                            status: 'success',
                            details: `Quest ${quest.id} finished.`
                        });
                    } else {
                        logger.warn(`[Quest] Quest ${quest.id} did not complete or failed.`);
                    }
                    await waitWithSignal(5000, signal);
                }

                if (signal.aborted) break;
                
                // If everything is done now, we can check in the next loop, but we can also break if all done
                if (plan.unaccepted.length === 0 && plan.actionable.length === 0) {
                    const shouldContinue = await waitWithSignal(this.pollIntervalMs, signal);
                    if (!shouldContinue) break;
                }
            }
        } catch (error) {
            if (signal.aborted || error?.name === 'AbortError') {
                finalStatus = 'stopped';
                stopReason = 'manual';
            } else {
                finalStatus = 'failed';
                stopReason = 'error';
                await QuestSession.updateOne(
                    { _id: session._id },
                    { $set: { lastError: String(error.message || error).slice(0, 500) } },
                );
                throw error;
            }
        } finally {
            await this._finishSession(session._id, finalStatus, stopReason);
        }
    }

    async _finishSession(sessionId, status, stopReason) {
        await QuestSession.updateOne(
            { _id: sessionId },
            {
                $set: { status, stopReason, stoppedAt: new Date() },
                $unset: { activeKey: 1 },
            },
        );
    }

    async stop({ guildId, requesterId }) {
        const key = sessionKey(guildId, requesterId);
        const worker = this.workers.get(key);

        if (worker) {
            await QuestSession.updateOne(
                { _id: worker.sessionId },
                { $set: { status: 'stopping', stopReason: 'manual' } },
            );
            worker.controller.abort();
            return true;
        }

        const session = await QuestSession.findOne({ activeKey: key });
        if (!session) return false;
        await this._finishSession(session._id, 'interrupted', 'orphaned_worker');
        return true;
    }

    async getStatus({ guildId, requesterId }) {
        return QuestSession.findOne({ guildId, requesterId }).sort({ createdAt: -1 }).lean();
    }

    async shutdown() {
        const workers = [...this.workers.values()];
        for (const worker of workers) worker.controller.abort();
        await Promise.allSettled(workers.map((worker) => worker.promise));
    }
}

const questSessionManager = new QuestSessionManager();

module.exports = {
    QuestSessionManager,
    QuestFeatureDisabledError,
    QuestAlreadyRunningError,
    questSessionManager,
    mapSnapshotStatus,
    normalizePollInterval,
};
