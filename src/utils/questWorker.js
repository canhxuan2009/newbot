const axios = require('axios');
const db = require('./questDb');
const { EmbedBuilder } = require('discord.js');

const API_BASE = "https://discord.com/api/v9";
const HEARTBEAT_INTERVAL = 20000;
const MIN_REQUEST_GAP = 150;
const SUPPORTED_TASKS = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY"];
const VIDEO_TASKS = new Set(["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"]);
const _SPIN = ["🌀", "⚡", "💫", "✨", "🔥", "💙", "🌟", "⚡"];

let lastRequestTime = Date.now();
let cachedBuild = 0;
let cachedBuildTs = 0;
const BUILD_TTL = 1800000; 

function kget(d, ...keys) {
    if (!d) return null;
    for (const k of keys) {
        if (d[k] !== undefined) return d[k];
    }
    return null;
}

async function fetchLatestBuildNumber() {
    const now = Date.now();
    if (cachedBuild && (now - cachedBuildTs) < BUILD_TTL) return cachedBuild;
    
    const FALLBACK = 504649;
    try {
        const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36";
        const r = await axios.get("https://discord.com/app", { headers: { "User-Agent": ua }, timeout: 15000 });
        if (r.status !== 200) return cachedBuild || FALLBACK;
        
        let scripts = [...r.data.matchAll(/\/assets\/([a-f0-9]+)\.js/g)].map(m => m[1]);
        if (!scripts.length) {
            let alt = [...r.data.matchAll(/src="(\/assets\/[^"]+\.js)"/g)];
            scripts = alt.map(m => m[1].split('/').pop().replace('.js', ''));
        }
        if (!scripts.length) return cachedBuild || FALLBACK;

        for (const assetHash of scripts.slice(-5)) {
            try {
                const ar = await axios.get(`https://discord.com/assets/${assetHash}.js`, { headers: { "User-Agent": ua }, timeout: 15000 });
                const m = ar.data.match(/buildNumber["\s:]+["\s]*(\d{5,7})/);
                if (m) {
                    cachedBuild = parseInt(m[1], 10);
                    cachedBuildTs = Date.now();
                    return cachedBuild;
                }
            } catch(e) {}
        }
        return cachedBuild || FALLBACK;
    } catch (e) {
        return cachedBuild || FALLBACK;
    }
}

function makeSuperProperties(buildNumber) {
    const obj = {
        os: "Windows", browser: "Discord Client", release_channel: "stable",
        client_version: "1.0.9175", os_version: "10.0.26100", os_arch: "x64",
        app_arch: "x64", system_locale: "en-US",
        browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36",
        browser_version: "32.2.7",
        client_build_number: buildNumber,
        native_build_number: 59498,
        client_event_source: null
    };
    return Buffer.from(JSON.stringify(obj)).toString('base64');
}

async function throttle() {
    const now = Date.now();
    const gap = now - lastRequestTime;
    if (gap < MIN_REQUEST_GAP) {
        await new Promise(r => setTimeout(r, MIN_REQUEST_GAP - gap + Math.random() * 100));
    }
    lastRequestTime = Date.now();
}

class WorkerAPI {
    constructor(token, buildNumber) {
        this.token = token;
        const sp = makeSuperProperties(buildNumber);
        this.client = axios.create({
            baseURL: API_BASE,
            timeout: 20000,
            headers: {
                "Authorization": token,
                "Content-Type": "application/json",
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36",
                "X-Super-Properties": sp,
                "X-Discord-Locale": "en-US",
                "X-Discord-Timezone": "Asia/Ho_Chi_Minh",
                "Origin": "https://discord.com",
                "Referer": "https://discord.com/channels/@me"
            },
            validateStatus: () => true 
        });
    }

    async request(method, path, data = null, extraHeaders = {}, retries = 3) {
        for (let attempt = 0; attempt < retries; attempt++) {
            await throttle();
            try {
                const config = { method, url: path, headers: extraHeaders };
                if (data && (method === 'post' || method === 'put')) config.data = data;
                
                const r = await this.client(config);
                if (r.status === 429) {
                    const wait = r.data?.retry_after || 5;
                    await new Promise(res => setTimeout(res, (Math.min(wait, 30) * 1000) + (Math.random() * 1000 + 500)));
                    continue;
                }
                return r;
            } catch (e) {
                if (attempt < retries - 1) {
                    await new Promise(res => setTimeout(res, Math.pow(2, attempt) * 1000 + Math.random() * 1000));
                    continue;
                }
                throw e;
            }
        }
        return { status: 500 }; 
    }

    get(path, retries = 3) { return this.request('get', path, null, {}, retries); }
    post(path, payload = null, extraHeaders = {}, retries = 3) { return this.request('post', path, payload, extraHeaders, retries); }
}

function getTaskConfig(quest) {
    const cfg = quest.config || {};
    for (const key of ["taskConfig", "task_config", "taskConfigV2", "task_config_v2"]) {
        if (cfg[key]) return cfg[key];
    }
    if (cfg.tasks) return cfg;
    return null;
}

function getQuestName(quest) {
    const cfg = quest.config || {};
    const msgs = cfg.messages || {};
    const name = kget(msgs, "questName", "quest_name");
    if (name) return name.trim();
    const game = kget(msgs, "gameTitle", "game_title");
    if (game) return game.trim();
    return `Quest#${quest.id || '?'}`;
}

function getExpiresAt(quest) {
    const cfg = quest.config || {};
    return kget(cfg, "expiresAt", "expires_at");
}

function isExpired(quest) {
    const tc = getTaskConfig(quest);
    if (!tc || !tc.tasks) return false;
    if (!SUPPORTED_TASKS.some(t => tc.tasks[t] !== undefined)) return false;
    const expires = getExpiresAt(quest);
    if (!expires) return false;
    try {
        const expDt = new Date(expires);
        return expDt <= new Date();
    } catch(e) { return false; }
}

function getUserStatus(quest) {
    const us = kget(quest, "userStatus", "user_status");
    return (us && typeof us === 'object') ? us : {};
}

function isCompletable(quest) {
    const expires = getExpiresAt(quest);
    if (expires) {
        try {
            if (new Date(expires) <= new Date()) return false;
        } catch(e) {}
    }
    const tc = getTaskConfig(quest);
    if (!tc || !tc.tasks) return false;
    return SUPPORTED_TASKS.some(t => tc.tasks[t] !== undefined);
}

function isEnrolled(quest) {
    const us = getUserStatus(quest);
    return !!kget(us, "enrolledAt", "enrolled_at");
}

function isCompleted(quest) {
    const us = getUserStatus(quest);
    return !!kget(us, "completedAt", "completed_at");
}

function getTaskType(quest) {
    const tc = getTaskConfig(quest);
    if (!tc || !tc.tasks) return null;
    for (const t of SUPPORTED_TASKS) {
        if (tc.tasks[t] !== undefined) return t;
    }
    return null;
}

function getSecondsNeeded(quest) {
    const tc = getTaskConfig(quest);
    const taskType = getTaskType(quest);
    if (!tc || !taskType) return 0;
    const taskData = (tc.tasks || {})[taskType];
    if (taskData && typeof taskData === 'object') {
        for (const key of ["target", "duration", "seconds", "time", "durationSeconds", "duration_seconds", "totalSeconds", "total_seconds"]) {
            if (taskData[key]) return parseFloat(taskData[key]);
        }
    } else if (taskData && (typeof taskData === 'number' || typeof taskData === 'string')) {
        return parseFloat(taskData);
    }
    return 0;
}

function getSecondsDone(quest) {
    const taskType = getTaskType(quest);
    if (!taskType) return 0;
    const us = getUserStatus(quest);
    const progress = us.progress || {};
    const val = progress[taskType];
    if (val && typeof val === 'object') {
        return parseFloat(val.value || 0);
    }
    return val ? parseFloat(val) : 0;
}

function getEnrolledAt(quest) {
    return kget(getUserStatus(quest), "enrolledAt", "enrolled_at");
}

class QuestWorker {
    constructor(token, userId, username, options = {}) {
        this.token = token;
        this.userId = userId;
        this.username = username;
        this.pollInterval = options.pollInterval || 30;
        this.autoAccept = options.autoAccept !== undefined ? options.autoAccept : true;
        this.botClient = options.botClient;
        this.channelId = options.channelId;
        this.requesterDiscordId = options.requesterDiscordId;
        this.avatarUrl = options.avatarUrl;
        this.silent = options.silent || false;
        this.onCompleteCallback = options.onCompleteCallback;
        this.preChannelMsg = options.preChannelMsg;
        
        this.api = null;
        this.buildNumber = 0;
        this.sessionId = null;
        this.completedIds = new Set();
        this.running = false;
        this.lastStatus = "idle";
        this.statusMsg = "Khởi động...";
        this.questMap = {};
        this.dmMsg = null;
        this.channelStatusMsg = this.preChannelMsg;
        this.completionSent = false;
        this.notifiedStart = false;
        this.finalStats = {};
        this.liveUpdaterActive = false;
        this.retryCounts = {};
        this.spinIdx = 0;
        
        this._abortController = new AbortController();
    }
    
    get isRunning() { return this.running; }
    get status() { return this.lastStatus; }
    get isStopped() { return this._abortController.signal.aborted; }

    log(msg, level = "info") {
        const ts = new Date().toLocaleTimeString('en-US', {hour12: false});
        const prefix = { "info": "INFO", "ok": "  OK", "warn": "WARN", "error": " ERR", "progress": "PROG" }[level] || level.toUpperCase();
        console.log(`${ts} [${this.username}][${prefix}] ${msg}`);
    }

    bar(done, total, width = 10) {
        if (total <= 0) return "`░░░░░░░░░░` 0%";
        const pct = Math.min(done / total, 1.0);
        const filled = Math.floor(pct * width);
        const b = "█".repeat(filled) + "░".repeat(width - filled);
        const pctStr = `${(pct * 100).toFixed(0)}%`;
        let timeStr;
        if (total >= 60) {
            const dMin = Math.floor(done / 60);
            const dSec = Math.floor(done % 60);
            const tMin = Math.floor(total / 60);
            const tSec = Math.floor(total % 60);
            timeStr = `${dMin}:${dSec.toString().padStart(2, '0')}/${tMin}:${tSec.toString().padStart(2, '0')}`;
        } else {
            timeStr = `${Math.floor(done)}/${Math.floor(total)}s`;
        }
        return `\`${b}\` **${pctStr}** · ⏱ ${timeStr}`;
    }

    buildStatusEmbed(completedAll = false) {
        const total = Object.keys(this.questMap).length;
        const doneCount = Object.values(this.questMap).filter(v => v.status === "done").length;
        const runningCount = Object.values(this.questMap).filter(v => v.status === "running").length;
        const pendingCount = total - doneCount;
        
        this.spinIdx = (this.spinIdx + 1) % _SPIN.length;
        const spin = _SPIN[this.spinIdx];
        
        let title, color;
        if (completedAll) {
            title = "🎉 HOÀN THÀNH TOÀN BỘ QUEST 🎉"; color = 0x00BFFF;
        } else if (total === 0) {
            title = `${spin} Nem Quest — Đang tìm quest...`; color = 0xFFA500;
        } else if (runningCount > 0) {
            title = `${spin} Nem Quest — Đang làm quest`; color = 0x00BFFF;
        } else if (pendingCount > 0) {
            title = `🌸 nem quest — Đang chuẩn bị`; color = 0xFFA500;
        } else {
            title = "✅ nem quest — Hoàn thành"; color = 0x00BFFF;
        }

        const embed = new EmbedBuilder().setTitle(title).setColor(color);
        const lines = [];
        for (const info of Object.values(this.questMap)) {
            const { name, status, seconds_done: sd = 0, seconds_needed: sn = 0 } = info;
            if (status === "done") continue;
            else if (status === "running") {
                if (sn > 0) lines.push(`⚡ **${name}**\n　${this.bar(sd, sn)}`);
                else lines.push(`⚡ **${name}** · đang xử lý...`);
            } else if (status === "enrolling") {
                lines.push(`🎯 **${name}** · đang nhận...`);
            } else if (status === "failed") {
                const retry = this.retryCounts[name] || 0;
                lines.push(`❌ **${name}** · thất bại (${retry}x retry)`);
            } else {
                lines.push(`⏳ **${name}** · chờ xử lý`);
            }
        }

        if (lines.length) embed.addFields({ name: "📋 Nhiệm vụ đang xử lý", value: lines.slice(0, 10).join('\n') });
        else if (completedAll) {
            embed.addFields({ name: "🏆 Perfect! Tất cả hoàn thành", value: "✨ Vào **Cài đặt Discord** → **Quà tặng** để nhận phần thưởng" });
        } else if (doneCount === total && total > 0) {
            embed.addFields({ name: "🏆 Tất cả quest đã hoàn thành!", value: "✨ Không còn nhiệm vụ nào cần làm" });
        }

        if (this.avatarUrl) embed.setThumbnail(this.avatarUrl);
        embed.setFooter({ text: `💙 Nem Quest  •  ${this.username}  •  ${new Date().toLocaleTimeString('en-US', {hour12: false})}` });
        return embed;
    }

    startLiveUpdater() {
        if (this.liveUpdaterActive) return;
        this.liveUpdaterActive = true;

        const syncReal = async () => {
            while (!this.isStopped && this.liveUpdaterActive) {
                await new Promise(r => setTimeout(r, 30000));
                if (this.isStopped || !this.api) break;
                try {
                    const r = await this.api.get("/quests/@me");
                    if (r.status !== 200) continue;
                    const data = r.data;
                    const ql = Array.isArray(data.quests) ? data.quests : (Array.isArray(data) ? data : []);
                    for (const q of ql) {
                        const qid = q.id;
                        if (!this.questMap[qid]) continue;
                        const info = this.questMap[qid];
                        if (info.status === "done" || info.status === "failed") continue;
                        
                        const realDone = getSecondsDone(q);
                        const realNeeded = getSecondsNeeded(q);
                        if (isCompleted(q)) {
                            info.seconds_done = realNeeded > 0 ? realNeeded : realDone;
                            info.status = "done";
                        } else {
                            if (realDone > 0) info.seconds_done = realDone;
                            if (realNeeded > 0) info.seconds_needed = realNeeded;
                        }
                    }
                } catch(e) {}
            }
        };

        const loop = async () => {
            while (!this.isStopped && this.liveUpdaterActive) {
                await new Promise(r => setTimeout(r, 5000));
                if (this.isStopped) break;
                if (Object.keys(this.questMap).length > 0) {
                    this.sendBothUpdate();
                }
            }
        };

        syncReal();
        loop();
    }

    async sendStartPing() {
        await this.sendChannelUpdate();
        if (!this.botClient || !this.requesterDiscordId) return;
        try {
            const user = await this.botClient.users.fetch(this.requesterDiscordId);
            const dm = await user.createDM();
            this.dmMsg = await dm.send({ embeds: [this.buildStatusEmbed()] });
        } catch(e) {
            this.log(`Lỗi DM start: ${e.message}`, "warn");
        }
    }

    async sendDmUpdate(completedAll = false) {
        if (!this.botClient || !this.requesterDiscordId) return;
        const embed = this.buildStatusEmbed(completedAll);
        try {
            if (!this.dmMsg) {
                const user = await this.botClient.users.fetch(this.requesterDiscordId);
                const dm = await user.createDM();
                this.dmMsg = await dm.send({ embeds: [embed] });
            } else {
                await this.dmMsg.edit({ embeds: [embed] });
            }
        } catch(e) {}
    }

    async sendChannelUpdate(completedAll = false) {
        if (!this.botClient || !this.channelId || !this.requesterDiscordId) return;
        const embed = this.buildStatusEmbed(completedAll);
        try {
            if (!this.channelStatusMsg) {
                let ch = this.botClient.channels.cache.get(this.channelId) || await this.botClient.channels.fetch(this.channelId);
                this.channelStatusMsg = await ch.send({ content: `<@${this.requesterDiscordId}>`, embeds: [embed] });
            } else {
                await this.channelStatusMsg.edit({ embeds: [embed] });
            }
        } catch (e) {
            this.log(`Lỗi channel update: ${e.message}`, "warn");
        }
    }

    sendBothUpdate(completedAll = false) {
        this.sendChannelUpdate(completedAll).catch(() => {});
        this.sendDmUpdate(completedAll).catch(() => {});
    }

    async sendCompletionToChannel() {
        if (!this.botClient || !this.channelId || !this.requesterDiscordId) return;
        const stats = this.finalStats;
        const completed = stats.completed ?? Object.values(this.questMap).filter(v => v.status === "done").length;
        const expired = stats.expired || 0;
        const total = stats.total ?? (completed + expired);

        const embed = new EmbedBuilder().setTitle("🎉 HOÀN THÀNH TOÀN BỘ QUEST 🎉").setColor(0x00BFFF);
        embed.addFields({ name: "📊 Tình trạng", value: `✅ **${completed}/${total}** đã hoàn thành\n${expired ? `🔴 **${expired}** hết hạn` : ''}` });
        if (expired === 0 && completed > 0) {
            embed.addFields({ name: "🏆 Perfect!", value: "Hoàn thành 100% — không bỏ sót quest nào!" });
        }
        embed.addFields({ name: "🎁 Nhận thưởng", value: "✨ Vào **Cài đặt Discord** → **Quà tặng (Gifts)** để nhận" });
        if (this.avatarUrl) embed.setThumbnail(this.avatarUrl);
        embed.setFooter({ text: `💙 Nem Quest  •  ${this.username}  •  ${new Date().toLocaleTimeString('en-US', {hour12: false})}` });

        try {
            if (this.channelStatusMsg) {
                await this.channelStatusMsg.edit({ content: `<@${this.requesterDiscordId}>`, embeds: [embed] });
            } else {
                let ch = this.botClient.channels.cache.get(this.channelId) || await this.botClient.channels.fetch(this.channelId);
                await ch.send({ content: `<@${this.requesterDiscordId}>`, embeds: [embed] });
            }
        } catch(e) {}

        if (this.onCompleteCallback) {
            try { await this.onCompleteCallback(); } catch(e) {}
        }
    }

    async fetchBuild() {
        this.log("Lấy build number...", "info");
        this.buildNumber = await fetchLatestBuildNumber();
        this.api = new WorkerAPI(this.token, this.buildNumber);
        this.log(`Build: ${this.buildNumber}`, "ok");
    }

    async fetchQuests() {
        try {
            const r = await this.api.get("/quests/@me");
            if (r.status === 200) {
                const data = r.data;
                const quests = Array.isArray(data.quests) ? data.quests : (Array.isArray(data) ? data : []);
                return quests;
            }
            if (r.status === 429) {
                const wait = r.data?.retry_after || 5;
                this.log(`Rate limited – chờ ${wait}s`, "warn");
                await new Promise(r => setTimeout(r, wait * 1000));
                return await this.fetchQuests();
            }
            if (r.status === 401 || r.status === 403) {
                this.log(`⚠️ Token không hợp lệ khi fetch (${r.status}), dừng worker!`, "error");
                this.stop();
                return [];
            }
            this.log(`Fetch quest lỗi (${r.status})`, "warn");
            return [];
        } catch (e) {
            this.log(`Lỗi fetch: ${e.message}`, "error");
            return [];
        }
    }

    async enrollQuest(quest) {
        const name = getQuestName(quest);
        const qid = quest.id;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const r = await this.api.post(`/quests/${qid}/enroll`, {
                    location: 11, is_targeted: false,
                    metadata_raw: null, metadata_sealed: null,
                    traffic_metadata_raw: quest.traffic_metadata_raw,
                    traffic_metadata_sealed: quest.traffic_metadata_sealed
                });
                if (r.status === 429) {
                    await new Promise(res => setTimeout(res, (r.data?.retry_after || 3) * 1000));
                    continue;
                }
                if ([200, 201, 204].includes(r.status)) {
                    this.log(`✅ Nhận quest: ${name}`, "ok");
                    db.dbLogQuest(db.dbGetTokenId(this.userId), name, qid, getTaskType(quest) || "", "enrolled", "success");
                    return true;
                }
                if (r.status === 401) {
                    this.log(`⚠️ Token không hợp lệ khi enroll (${r.status}), dừng worker!`, "error");
                    this.stop();
                    return false;
                }
                if ([404, 403].includes(r.status)) {
                    this.log(`  Enroll ${name}: ${r.status}, bỏ qua`, "warn");
                    return false;
                }
                this.log(`Enroll lần ${attempt}/3 thất bại (${r.status})`, "warn");
                if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
            } catch(e) {
                this.log(`Lỗi enroll ${attempt}/3: ${e.message}`, "error");
                if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
            }
        }
        return false;
    }

    async completeVideo(quest) {
        const name = getQuestName(quest);
        const qid = quest.id;
        const taskType = getTaskType(quest);
        const secondsNeeded = getSecondsNeeded(quest);
        let secondsDone = getSecondsDone(quest);
        const altTaskType = taskType === "WATCH_VIDEO" ? "WATCH_VIDEO_ON_MOBILE" : "WATCH_VIDEO";
        
        const tc = getTaskConfig(quest);
        const tasksDict = (tc && tc.tasks) || {};
        const hasAlt = tasksDict[altTaskType] !== undefined;
        const videoHeaders = { "Referer": `https://discord.com/quests/${qid}` };

        if (secondsNeeded <= 0) {
            this.log(`  seconds_needed=0 cho ${name}, bỏ qua`, "warn");
            return false;
        }
        if (this.questMap[qid]) {
            this.questMap[qid].seconds_needed = secondsNeeded;
            this.questMap[qid].seconds_done = secondsDone;
        }

        const enrolledAtStr = getEnrolledAt(quest);
        let enrolledTs = (Date.now() / 1000) - secondsDone;
        if (enrolledAtStr) {
            try {
                enrolledTs = new Date(enrolledAtStr).getTime() / 1000;
            } catch(e) {}
        }

        this.log(`Video: ${name} (${secondsDone.toFixed(0)}/${secondsNeeded}s, type=${taskType})`, "progress");
        const speed = 15;
        const maxFuture = 60;
        const interval = 300;

        const sendProgress = async (ts, useTask) => {
            try {
                const r = await this.api.post(`/quests/${qid}/video-progress`, { timestamp: Math.round(ts * 100) / 100 }, videoHeaders);
                if (r.status === 200) {
                    const body = r.data;
                    const prog = body.progress || {};
                    let updated = secondsDone;
                    let found = false;
                    for (const key of [useTask, "WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"]) {
                        if (prog[key] !== undefined) {
                            const val = prog[key];
                            updated = typeof val === 'object' ? parseFloat(val.value || updated) : parseFloat(val);
                            found = true;
                            break;
                        }
                    }
                    if (!found) updated = Math.max(secondsDone, ts);
                    
                    secondsDone = updated;
                    if (this.questMap[qid]) this.questMap[qid].seconds_done = updated;
                    this.log(`  ${name}: ${updated.toFixed(0)}/${secondsNeeded}s`, "progress");
                    return { updated, done: !!body.completed_at, bail: false };
                } else if (r.status === 429) {
                    const wait = r.data?.retry_after || 5;
                    await new Promise(res => setTimeout(res, wait * 1000 + 1000));
                    return { updated: secondsDone, done: false, bail: false };
                } else if (r.status === 401 || r.status === 403) {
                    this.log(`⚠️ Token không hợp lệ khi video-progress (${r.status}), dừng worker!`, "error");
                    this.stop();
                    return { updated: secondsDone, done: false, bail: true };
                } else if (r.status === 404) {
                    return { updated: secondsDone, done: false, bail: true };
                }
                return { updated: secondsDone, done: false, bail: false };
            } catch (e) {
                this.log(`Lỗi video-progress: ${e.message}`, "error");
                return { updated: secondsDone, done: false, bail: false };
            }
        };

        const doVideo = async (useTask) => {
            let localDone = secondsDone;
            if (!this.isStopped) {
                const { updated, done, bail } = await sendProgress(secondsNeeded, useTask);
                localDone = updated;
                if (bail) return false;
                if (done) return true;
            }
            
            this.log(`  Step [${useTask}]: ${localDone.toFixed(0)}s → ${secondsNeeded}s`, "progress");
            while (localDone < secondsNeeded && !this.isStopped) {
                const elapsed = (Date.now() / 1000) - enrolledTs;
                const maxAllowed = elapsed + maxFuture;
                const nextTs = localDone + speed;
                
                if (nextTs > maxAllowed && nextTs < secondsNeeded) {
                    await new Promise(r => setTimeout(r, interval));
                    continue;
                }
                
                const sendTs = Math.min(nextTs + Math.random() * 0.5, secondsNeeded);
                const { updated, done, bail } = await sendProgress(sendTs, useTask);
                localDone = updated;
                if (bail) return false;
                if (done) return true;
                
                if (localDone < sendTs - 1) {
                    localDone = Math.min(sendTs, secondsNeeded);
                    secondsDone = localDone;
                    if (this.questMap[qid]) this.questMap[qid].seconds_done = localDone;
                }
                if (localDone >= secondsNeeded) break;
                await new Promise(r => setTimeout(r, interval));
            }
            
            if (!this.isStopped) {
                for (let attempt = 0; attempt < 3; attempt++) {
                    const { done, bail } = await sendProgress(secondsNeeded, useTask);
                    if (done) return true;
                    if (bail) break;
                    if (attempt < 2) await new Promise(r => setTimeout(r, 300));
                }
            }
            
            try {
                const r = await this.api.get("/quests/@me");
                if (r.status === 200) {
                    const ql = Array.isArray(r.data.quests) ? r.data.quests : (Array.isArray(r.data) ? r.data : []);
                    const q = ql.find(x => x.id === qid);
                    if (q && isCompleted(q)) return true;
                }
            } catch(e) {}
            return false;
        };

        if (await doVideo(taskType)) {
            this.log(`✅ Video xong [${taskType}]: ${name}`, "ok");
            if (this.questMap[qid]) this.questMap[qid].seconds_done = secondsNeeded;
            db.dbLogQuest(db.dbGetTokenId(this.userId), name, qid, taskType, "completed", "success");
            return true;
        }
        if (hasAlt && !this.isStopped) {
            this.log(`  Thử fallback [${altTaskType}] cho ${name}`, "info");
            if (await doVideo(altTaskType)) {
                this.log(`✅ Video xong [${altTaskType}]: ${name}`, "ok");
                if (this.questMap[qid]) this.questMap[qid].seconds_done = secondsNeeded;
                db.dbLogQuest(db.dbGetTokenId(this.userId), name, qid, altTaskType, "completed", "success");
                return true;
            }
        }
        this.log(`⚠️ Video thất bại: ${name} (${secondsDone.toFixed(0)}/${secondsNeeded}s)`, "warn");
        db.dbLogQuest(db.dbGetTokenId(this.userId), name, qid, taskType || "WATCH_VIDEO", "failed", "failed");
        return false;
    }

    async completeHeartbeat(quest) {
        const name = getQuestName(quest);
        const qid = quest.id;
        const taskType = getTaskType(quest);
        const secondsNeeded = getSecondsNeeded(quest);
        let secondsDone = getSecondsDone(quest);
        const pid = Math.floor(Math.random() * 29000) + 1000;
        
        if (this.questMap[qid]) {
            this.questMap[qid].seconds_needed = secondsNeeded;
            this.questMap[qid].seconds_done = secondsDone;
        }
        this.log(`${taskType}: ${name} (${secondsDone.toFixed(0)}/${secondsNeeded}s)`, "progress");
        
        while (secondsDone < secondsNeeded && !this.isStopped) {
            try {
                const r = await this.api.post(`/quests/${qid}/heartbeat`, { stream_key: `call:0:${pid}`, terminal: false });
                if (r.status === 200) {
                    const prog = r.data.progress || {};
                    if (prog[taskType] !== undefined) {
                        const val = prog[taskType];
                        secondsDone = typeof val === 'object' ? parseFloat(val.value || secondsDone) : parseFloat(val);
                    }
                    if (r.data.completed_at) secondsDone = secondsNeeded;
                    if (this.questMap[qid]) this.questMap[qid].seconds_done = secondsDone;
                    this.log(`  ${name}: ${secondsDone.toFixed(0)}/${secondsNeeded}s`, "progress");
                    if (secondsDone >= secondsNeeded) break;
                } else if (r.status === 429) {
                    await new Promise(res => setTimeout(res, (r.data?.retry_after || 1) * 1000));
                    continue;
                } else if (r.status === 401 || r.status === 403) {
                    this.log(`⚠️ Token không hợp lệ khi heartbeat (${r.status}), dừng worker!`, "error");
                    this.stop();
                    break;
                } else if ([400, 404].includes(r.status)) {
                    break;
                }
            } catch (e) {
                this.log(`Lỗi heartbeat: ${e.message}`, "error");
            }
            await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL));
        }
        
        try {
            await this.api.post(`/quests/${qid}/heartbeat`, { stream_key: `call:0:${pid}`, terminal: true });
        } catch(e) {}
        
        const ok = secondsDone >= secondsNeeded;
        this.log(`${ok ? '✅' : '⚠️'} Heartbeat ${ok ? 'xong' : 'chưa xong'}: ${name}`, ok ? "ok" : "warn");
        db.dbLogQuest(db.dbGetTokenId(this.userId), name, qid, taskType || "", ok ? "completed" : "failed", ok ? "success" : "failed");
        return ok;
    }

    async completeActivity(quest) {
        const name = getQuestName(quest);
        const qid = quest.id;
        const secondsNeeded = getSecondsNeeded(quest);
        let secondsDone = getSecondsDone(quest);
        
        if (this.questMap[qid]) {
            this.questMap[qid].seconds_needed = secondsNeeded;
            this.questMap[qid].seconds_done = secondsDone;
        }
        this.log(`PLAY_ACTIVITY: ${name} (${secondsDone.toFixed(0)}/${secondsNeeded}s)`, "progress");
        const streamKey = "call:0:1";
        
        while (secondsDone < secondsNeeded && !this.isStopped) {
            try {
                const r = await this.api.post(`/quests/${qid}/heartbeat`, { stream_key: streamKey, terminal: false });
                if (r.status === 200) {
                    const prog = r.data.progress || {};
                    if (prog["PLAY_ACTIVITY"] !== undefined) {
                        const val = prog["PLAY_ACTIVITY"];
                        secondsDone = typeof val === 'object' ? parseFloat(val.value || secondsDone) : parseFloat(val);
                    }
                    if (r.data.completed_at) secondsDone = secondsNeeded;
                    if (this.questMap[qid]) this.questMap[qid].seconds_done = secondsDone;
                    this.log(`  ${name}: ${secondsDone.toFixed(0)}/${secondsNeeded}s`, "progress");
                    if (secondsDone >= secondsNeeded) break;
                } else if (r.status === 429) {
                    await new Promise(res => setTimeout(res, (r.data?.retry_after || 1) * 1000));
                    continue;
                } else if (r.status === 401 || r.status === 403) {
                    this.log(`⚠️ Token không hợp lệ khi activity (${r.status}), dừng worker!`, "error");
                    this.stop();
                    break;
                } else if ([400, 404].includes(r.status)) {
                    break;
                }
            } catch (e) {
                this.log(`Lỗi activity: ${e.message}`, "error");
            }
            await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL));
        }
        
        try {
            await this.api.post(`/quests/${qid}/heartbeat`, { stream_key: streamKey, terminal: true });
        } catch(e) {}
        
        const ok = secondsDone >= secondsNeeded;
        this.log(`${ok ? '✅' : '⚠️'} Activity ${ok ? 'xong' : 'chưa xong'}: ${name}`, ok ? "ok" : "warn");
        db.dbLogQuest(db.dbGetTokenId(this.userId), name, qid, "PLAY_ACTIVITY", ok ? "completed" : "failed", ok ? "success" : "failed");
        return ok;
    }

    async processQuest(quest) {
        const qid = quest.id;
        const name = getQuestName(quest);
        const taskType = getTaskType(quest);
        
        if (!taskType) {
            this.log(`"${name}" – task không hỗ trợ, bỏ qua`, "warn");
            return false;
        }
        if (this.completedIds.has(qid)) return true;
        
        this.log(`━━━ ${name} (task: ${taskType}) ━━━`, "info");
        
        if (VIDEO_TASKS.has(taskType)) return await this.completeVideo(quest);
        if (["PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP"].includes(taskType)) return await this.completeHeartbeat(quest);
        if (taskType === "PLAY_ACTIVITY") return await this.completeActivity(quest);
        return false;
    }

    async run() {
        this.running = true;
        this.lastStatus = "running";
        this.log("Worker khởi động", "info");
        await this.fetchBuild();
        db.dbUpdateAccountStatus(this.userId, "running");
        this.sessionId = db.dbStartSession(db.dbGetTokenId(this.userId));
        this.log(`Session #${this.sessionId} started`, "ok");

        let cycle = 0;
        while (!this.isStopped) {
            cycle++;
            this.statusMsg = `Quét lần #${cycle}`;
            this.log(`── Quét #${cycle} ──`, "info");
            
            let quests = await this.fetchQuests();
            
            if (quests.length > 0) {
                const enrolledC = quests.filter(q => isEnrolled(q)).length;
                const completedC = quests.filter(q => isCompleted(q)).length;
                const completableC = quests.filter(q => isCompletable(q)).length;
                
                this.log(`Tổng: ${quests.length} | Enrolled: ${enrolledC} | Completed: ${completedC} | Completable: ${completableC}`, "info");

                for (const q of quests) {
                    if (isCompletable(q)) {
                        const qid = q.id;
                        if (!this.questMap[qid]) {
                            this.questMap[qid] = {
                                name: getQuestName(q), status: "waiting",
                                seconds_done: getSecondsDone(q),
                                seconds_needed: getSecondsNeeded(q),
                                task_type: getTaskType(q) || ""
                            };
                        }
                        if (isCompleted(q) || this.completedIds.has(qid)) {
                            this.questMap[qid].status = "done";
                        }
                    }
                }

                if (this.autoAccept) {
                    const unaccepted = quests.filter(q => !isEnrolled(q) && !isCompleted(q) && isCompletable(q));
                    if (unaccepted.length > 0) {
                        this.log(`Tự nhận ${unaccepted.length} quest...`, "info");
                        for (let idx = 0; idx < unaccepted.length; idx++) {
                            const q = unaccepted[idx];
                            const qidEnroll = q.id;
                            this.log(`  → ${getQuestName(q)} [${getTaskType(q)}]`, "info");
                            if (this.questMap[qidEnroll]) this.questMap[qidEnroll].status = "enrolling";
                            this.sendChannelUpdate();
                            
                            await this.enrollQuest(q);
                            
                            if (this.questMap[qidEnroll]) this.questMap[qidEnroll].status = "waiting";
                            if (idx < unaccepted.length - 1) await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                        }
                        quests = await this.fetchQuests();
                        for (const q of quests) {
                            if (isCompletable(q)) {
                                const qid = q.id;
                                if (!this.questMap[qid]) {
                                    this.questMap[qid] = {
                                        name: getQuestName(q), status: "waiting",
                                        seconds_done: getSecondsDone(q),
                                        seconds_needed: getSecondsNeeded(q),
                                        task_type: getTaskType(q) || ""
                                    };
                                }
                                if (isCompleted(q) || this.completedIds.has(qid)) {
                                    this.questMap[qid].status = "done";
                                }
                            }
                        }
                    }
                }

                if (!this.notifiedStart) {
                    await this.sendStartPing();
                    this.notifiedStart = true;
                    this.startLiveUpdater();
                }

                const actionableRaw = quests.filter(q => isEnrolled(q) && !isCompleted(q) && isCompletable(q) && !this.completedIds.has(q.id));
                const videoQuests = actionableRaw.filter(q => VIDEO_TASKS.has(getTaskType(q)));
                const otherQuests = actionableRaw.filter(q => !VIDEO_TASKS.has(getTaskType(q)));
                const actionable = [...videoQuests, ...otherQuests];

                if (actionable.length > 0) {
                    this.log(`${actionable.length} quest cần làm (video=${videoQuests.length}, game=${otherQuests.length})`, "info");
                    for (const q of actionable) {
                        if (this.questMap[q.id]) this.questMap[q.id].status = "running";
                    }
                    this.sendBothUpdate();

                    const runOne = async (q, stagger = 0) => {
                        if (stagger) await new Promise(r => setTimeout(r, stagger * 1000));
                        if (this.isStopped) return;
                        const qid = q.id;
                        const name = getQuestName(q);
                        const ok = await this.processQuest(q);
                        if (ok) {
                            this.completedIds.add(qid);
                            delete this.retryCounts[name];
                            if (this.questMap[qid]) this.questMap[qid].status = "done";
                        } else {
                            this.retryCounts[name] = (this.retryCounts[name] || 0) + 1;
                            if (this.questMap[qid]) this.questMap[qid].status = "failed";
                        }
                        this.sendBothUpdate();
                    };

                    if (videoQuests.length > 0 && !this.isStopped) {
                        this.log(`▶ PHASE 1: ${videoQuests.length} video quest (chạy song song max 5)`, "info");
                        // chunk array up to 5
                        for (let i = 0; i < videoQuests.length; i += 5) {
                            const chunk = videoQuests.slice(i, i + 5);
                            await Promise.all(chunk.map(q => runOne(q, 0)));
                        }
                        this.log("✅ PHASE 1 xong", "ok");
                    }

                    if (otherQuests.length > 0 && !this.isStopped) {
                        const remaining = otherQuests.filter(q => !this.completedIds.has(q.id));
                        if (remaining.length > 0) {
                            this.log(`▶ PHASE 2: ${remaining.length} game quest (max 5 thread)`, "info");
                            for (let i = 0; i < remaining.length; i += 5) {
                                const chunk = remaining.slice(i, i + 5);
                                await Promise.all(chunk.map((q, idx) => runOne(q, (0.1 + Math.random() * 0.2) * idx)));
                            }
                        }
                    }
                } else {
                    this.log("Không có quest cần làm", "info");
                }

                if (Object.keys(this.questMap).length > 0 && !this.completionSent && !this.isStopped) {
                    const hasPending = Object.values(this.questMap).some(v => ["running", "waiting"].includes(v.status));
                    const allLocalDone = !hasPending && 
                        Object.values(this.questMap).every(v => ["done", "failed"].includes(v.status)) &&
                        Object.values(this.questMap).some(v => v.status === "done");
                    
                    if (allLocalDone) {
                        let finalQuests = [];
                        for (let retry = 0; retry < 3; retry++) {
                            finalQuests = await this.fetchQuests();
                            if (finalQuests.length > 0) break;
                            if (retry < 2) await new Promise(r => setTimeout(r, 2000));
                        }
                        
                        let discordAllDone = false;
                        if (!finalQuests.length) {
                            this.log("⚠️ Không xác nhận được quest list từ Discord — thử lại sau", "warn");
                        } else {
                            discordAllDone = finalQuests.every(q => isCompleted(q) || !isCompletable(q));
                        }

                        if (!discordAllDone && finalQuests.length > 0) {
                            for (const q of finalQuests) {
                                const qidChk = q.id;
                                if (this.questMap[qidChk] && isCompletable(q) && !isCompleted(q)) {
                                    this.questMap[qidChk].status = "waiting";
                                    this.completedIds.delete(qidChk);
                                    const sdPct = getSecondsDone(q);
                                    const snPct = getSecondsNeeded(q);
                                    const pct = snPct ? `${((sdPct/snPct)*100).toFixed(0)}%` : "?";
                                    this.log(`⚠️ ${getQuestName(q)}: Discord vẫn ở ${pct} (${sdPct.toFixed(0)}/${snPct.toFixed(0)}s) — reset về waiting, thử lại`, "warn");
                                }
                            }
                        }

                        if (discordAllDone) {
                            this.log("✅ Tất cả quest xong! Dừng worker...", "ok");
                            const botDone = Object.values(this.questMap).filter(v => v.status === "done").length;
                            const expiredC = finalQuests.filter(q => isExpired(q)).length;
                            const discDone = finalQuests.filter(q => isCompleted(q)).length;
                            const actual = Math.max(botDone, discDone);
                            this.finalStats = { completed: actual, expired: expiredC, total: actual + expiredC };
                            
                            this.sendBothUpdate(true);
                            await this.sendCompletionToChannel();
                            this.completionSent = true;
                            db.dbSetManuallyStopped(this.userId, true);
                            this.stop();
                        }
                    } else if (!hasPending && Object.values(this.questMap).every(v => v.status === "failed")) {
                        const totalRetries = Object.values(this.retryCounts).reduce((a, b) => a + b, 0);
                        if (totalRetries >= 5) {
                            this.log("⚠️ Tất cả quest thất bại sau nhiều lần thử, dừng worker", "warn");
                            this.stop();
                        } else {
                            this.log(`⚠️ Quest failed, thử lại sau ${this.pollInterval}s...`, "warn");
                            for (const v of Object.values(this.questMap)) {
                                if (v.status === "failed") v.status = "waiting";
                            }
                        }
                    }
                }
            } else {
                this.log("Không có quest", "info");
                if (!this.notifiedStart) {
                    await this.sendChannelUpdate();
                    this.notifiedStart = true;
                    this.startLiveUpdater();
                }
            }

            for (let i = 0; i < this.pollInterval; i++) {
                if (this.isStopped) break;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        
        this.running = false;
        this.liveUpdaterActive = false;
        this.lastStatus = "stopped";
        const reason = this.completionSent ? "completed" : "manual";
        this.statusMsg = this.completionSent ? "Đã hoàn thành" : "Đã dừng";
        
        if (this.sessionId) db.dbStopSession(this.sessionId, reason);
        db.dbUpdateAccountStatus(this.userId, "offline");
        
        workerRegistry.delete(this.userId);
        
        this.questMap = {};
        this.completedIds.clear();
        this.retryCounts = {};
        
        this.log(`Worker dừng (${reason})`, "info");
    }

    stop() {
        this._abortController.abort();
        this.liveUpdaterActive = false;
    }
}

const workerRegistry = new Map();

function workerStart(token, userId, username, options = {}) {
    workerStop(userId);
    const worker = new QuestWorker(token, userId, username, options);
    workerRegistry.set(userId, worker);
    worker.run().catch(e => {
        console.error(`[Worker ${username}] Fatal error:`, e);
        workerRegistry.delete(userId);
    });
    return worker;
}

function workerStop(userId) {
    const worker = workerRegistry.get(userId);
    if (worker) {
        worker.stop();
        workerRegistry.delete(userId);
    }
}

function workerGet(userId) {
    return workerRegistry.get(userId);
}

function workerGetAll() {
    return Object.fromEntries(workerRegistry);
}

async function fetchCompletableActionable(token) {
    try {
        const build = await fetchLatestBuildNumber();
        const api = new WorkerAPI(token, build);
        const r = await api.get("/quests/@me");
        if (r.status === 200) {
            const data = r.data;
            const qs = Array.isArray(data.quests) ? data.quests : (Array.isArray(data) ? data : []);
            return qs.filter(q => isCompletable(q) && !isCompleted(q));
        }
        if (r.status === 401 || r.status === 403) return "DEAD_TOKEN";
        return null;
    } catch(e) { return null; }
}

module.exports = {
    QuestWorker,
    workerStart,
    workerStop,
    workerGet,
    workerGetAll,
    fetchCompletableActionable
};
