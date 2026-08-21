'use strict';

const logger = require('../utils/logger');
const { getTaskType, getSecondsNeeded, getSecondsDone, getEnrolledAt } = require('./questParser');

class QuestProviderUnavailableError extends Error {
    constructor() {
        super('Quest provider is unavailable or missing configuration.');
        this.name = 'QuestProviderUnavailableError';
        this.code = 'QUEST_PROVIDER_UNAVAILABLE';
    }
}

function makeSuperProperties() {
    const obj = {
        os: 'Windows',
        browser: 'Discord Client',
        release_channel: 'stable',
        client_version: '1.0.9175',
        os_version: '10.0.26100',
        os_arch: 'x64',
        app_arch: 'x64',
        system_locale: 'en-US',
        browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36',
        browser_version: '32.2.7',
        client_build_number: 504649,
        native_build_number: 59498,
        client_event_source: null,
    };
    return Buffer.from(JSON.stringify(obj)).toString('base64');
}

const API_BASE = 'https://discord.com/api/v9';
const SUPER_PROPERTIES = makeSuperProperties();
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';

async function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('AbortError'));
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('AbortError'));
            }, { once: true });
        }
    });
}

class DiscordQuestProvider {
    constructor() {
        this.name = 'discord_oauth';
    }

    isConfigured() {
        return true;
    }

    _getHeaders(token) {
        return {
            'Authorization': token,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': DEFAULT_USER_AGENT,
            'X-Super-Properties': SUPER_PROPERTIES,
            'X-Discord-Locale': 'en-US',
            'X-Discord-Timezone': 'Asia/Ho_Chi_Minh',
            'Origin': 'https://discord.com',
            'Referer': 'https://discord.com/channels/@me',
        };
    }

    async _fetchWithRetry(url, options = {}, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, options);
                
                if (response.status === 429) {
                    const data = await response.json().catch(() => ({}));
                    const waitTime = (data.retry_after || 5) * 1000;
                    logger.warn(`[QuestProvider] Rate limited. Waiting ${waitTime}ms`);
                    await wait(waitTime, options.signal);
                    continue;
                }
                
                return response;
            } catch (error) {
                if (error.message === 'AbortError') throw error;
                if (i === retries - 1) throw error;
                await wait((2 ** i) * 1000 + Math.random() * 1000, options.signal);
            }
        }
        throw new Error('Max retries reached');
    }

    async validateToken(token) {
        if (!token) return false;
        try {
            const res = await this._fetchWithRetry(`${API_BASE}/users/@me`, {
                method: 'GET',
                headers: this._getHeaders(token)
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    async listQuests({ profile, signal }) {
        if (!profile.discordToken) return [];
        const res = await this._fetchWithRetry(`${API_BASE}/quests/@me`, {
            method: 'GET',
            headers: this._getHeaders(profile.discordToken),
            signal
        });
        
        if (!res.ok) {
            logger.warn(`[QuestProvider] Failed to list quests. Status: ${res.status}`);
            return [];
        }
        
        const data = await res.json();
        return Array.isArray(data.quests) ? data.quests : (Array.isArray(data) ? data : []);
    }

    async enrollQuest({ profile, quest, signal }) {
        if (!profile.discordToken) return false;
        
        const payload = {
            location: 11,
            is_targeted: false,
            metadata_raw: null,
            metadata_sealed: null,
            traffic_metadata_raw: quest.traffic_metadata_raw || null,
            traffic_metadata_sealed: quest.traffic_metadata_sealed || null
        };

        const res = await this._fetchWithRetry(`${API_BASE}/quests/${quest.id}/enroll`, {
            method: 'POST',
            headers: this._getHeaders(profile.discordToken),
            body: JSON.stringify(payload),
            signal
        });

        if (res.ok || res.status === 204) return true;
        if (res.status === 404 || res.status === 403) return false;
        
        return false;
    }

    async completeVideo({ profile, quest, signal, onProgress }) {
        const qid = quest.id;
        const taskType = getTaskType(quest);
        const secondsNeeded = getSecondsNeeded(quest);
        let secondsDone = getSecondsDone(quest);
        const token = profile.discordToken;
        
        if (secondsNeeded <= 0) return false;
        
        const headers = {
            ...this._getHeaders(token),
            'Referer': `https://discord.com/quests/${qid}`
        };

        const sendProgress = async (ts, useTask) => {
            try {
                const res = await this._fetchWithRetry(`${API_BASE}/quests/${qid}/video-progress`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ timestamp: Number(ts.toFixed(2)) }),
                    signal
                });
                
                if (res.ok) {
                    const body = await res.json();
                    let updated = secondsDone;
                    if (body.progress) {
                        for (const key of [useTask, 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']) {
                            if (body.progress[key] != null) {
                                const val = body.progress[key];
                                updated = typeof val === 'object' ? Number(val.value || updated) : Number(val);
                                break;
                            }
                        }
                    }
                    secondsDone = Math.max(updated, secondsDone);
                    if (onProgress) onProgress(secondsDone, secondsNeeded);
                    return { updated: secondsDone, done: !!body.completed_at, bail: false };
                } else if (res.status === 404) {
                    return { updated: secondsDone, done: false, bail: true };
                }
            } catch (e) {
                if (e.message !== 'AbortError') {
                    logger.warn(`[QuestProvider] Video progress error: ${e.message}`);
                }
            }
            return { updated: secondsDone, done: false, bail: false };
        };

        const doVideo = async (useTask) => {
            let res = await sendProgress(secondsNeeded, useTask);
            if (res.bail) return false;
            if (res.done) return true;

            const enrolledAtStr = getEnrolledAt(quest);
            let enrolledTs = Date.now() / 1000 - secondsDone;
            if (enrolledAtStr) {
                const d = new Date(enrolledAtStr);
                if (!isNaN(d)) enrolledTs = d.getTime() / 1000;
            }

            const speed = 15;
            const maxFuture = 60;
            const interval = 300;

            while (secondsDone < secondsNeeded && (!signal || !signal.aborted)) {
                const elapsed = (Date.now() / 1000) - enrolledTs;
                const maxAllowed = elapsed + maxFuture;
                const nextTs = secondsDone + speed;

                if (nextTs > maxAllowed && nextTs < secondsNeeded) {
                    await wait(interval, signal);
                    continue;
                }

                const sendTs = Math.min(nextTs + (Math.random() * 0.5), secondsNeeded);
                res = await sendProgress(sendTs, useTask);
                
                if (res.bail) return false;
                if (res.done) return true;

                if (secondsDone < sendTs - 1) {
                    secondsDone = Math.min(sendTs, secondsNeeded);
                }

                if (secondsDone >= secondsNeeded) break;
                await wait(interval, signal);
            }

            for (let i = 0; i < 3 && (!signal || !signal.aborted); i++) {
                res = await sendProgress(secondsNeeded, useTask);
                if (res.done) return true;
                if (res.bail) break;
                await wait(300, signal);
            }

            return false;
        };

        let result = await doVideo(taskType);
        if (result) return true;
        
        const altTask = taskType === 'WATCH_VIDEO' ? 'WATCH_VIDEO_ON_MOBILE' : 'WATCH_VIDEO';
        if (!signal?.aborted) {
            result = await doVideo(altTask);
        }
        
        return result;
    }

    async completeHeartbeat({ profile, quest, signal, onProgress }) {
        const qid = quest.id;
        const taskType = getTaskType(quest);
        const secondsNeeded = getSecondsNeeded(quest);
        let secondsDone = getSecondsDone(quest);
        const token = profile.discordToken;
        const pid = Math.floor(Math.random() * 29000) + 1000;
        const streamKey = taskType === 'PLAY_ACTIVITY' ? 'call:0:1' : `call:0:${pid}`;

        const heartbeatInterval = 20000;

        if (secondsNeeded <= 0) return false;

        while (secondsDone < secondsNeeded && (!signal || !signal.aborted)) {
            try {
                const res = await this._fetchWithRetry(`${API_BASE}/quests/${qid}/heartbeat`, {
                    method: 'POST',
                    headers: this._getHeaders(token),
                    body: JSON.stringify({ stream_key: streamKey, terminal: false }),
                    signal
                });

                if (res.ok) {
                    const body = await res.json();
                    if (body.progress && body.progress[taskType]) {
                        const val = body.progress[taskType];
                        secondsDone = typeof val === 'object' ? Number(val.value || secondsDone) : Number(val);
                    }
                    if (body.completed_at) secondsDone = secondsNeeded;
                    if (onProgress) onProgress(secondsDone, secondsNeeded);
                    if (secondsDone >= secondsNeeded) break;
                } else if (res.status === 400 || res.status === 404) {
                    break;
                }
            } catch (e) {
                if (e.message !== 'AbortError') logger.warn(`[QuestProvider] Heartbeat error: ${e.message}`);
            }

            if (secondsDone >= secondsNeeded) break;
            await wait(heartbeatInterval, signal);
        }

        try {
            await fetch(`${API_BASE}/quests/${qid}/heartbeat`, {
                method: 'POST',
                headers: this._getHeaders(token),
                body: JSON.stringify({ stream_key: streamKey, terminal: true }),
                signal
            }).catch(() => {});
        } catch {}

        return secondsDone >= secondsNeeded;
    }
}

function createQuestProvider() {
    return new DiscordQuestProvider();
}

module.exports = {
    createQuestProvider,
    QuestProviderUnavailableError,
    DiscordQuestProvider
};
