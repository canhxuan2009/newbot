/**
 * db.js — Sử dụng node:sqlite (built-in Node.js v22+), không cần npm install
 * Tương thích 100% schema với phiên bản cũ (sqlite3/sqlite).
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');
const axios = require('axios');
const fs = require('fs');

const defaultDbDir = path.join(os.homedir(), '.kyrus_bot');
if (!fs.existsSync(defaultDbDir)) {
    fs.mkdirSync(defaultDbDir, { recursive: true });
}
const DB_PATH = process.env.DB_PATH || path.join(defaultDbDir, 'bot_data.db');

let db;

function initDb() {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id          TEXT    NOT NULL UNIQUE,
            username         TEXT,
            discriminator    TEXT,
            global_name      TEXT,
            added_at         TEXT    NOT NULL,
            status           TEXT    NOT NULL DEFAULT 'offline',
            last_seen        TEXT,
            manually_stopped INTEGER NOT NULL DEFAULT 0,
            requester_id     TEXT
        );
        CREATE TABLE IF NOT EXISTS tokens (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            token        TEXT    NOT NULL UNIQUE,
            build_number INTEGER,
            added_at     TEXT    NOT NULL,
            last_error   TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            token_id   INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
            started_at TEXT    NOT NULL,
            stopped_at TEXT,
            reason     TEXT
        );
        CREATE TABLE IF NOT EXISTS quest_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            token_id   INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
            quest_name TEXT,
            quest_id   TEXT,
            task_type  TEXT,
            action     TEXT    NOT NULL,
            status     TEXT    NOT NULL DEFAULT 'pending',
            message    TEXT,
            created_at TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
    `);

    try { db.exec("ALTER TABLE accounts ADD COLUMN manually_stopped INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
    try { db.exec("ALTER TABLE accounts ADD COLUMN requester_id TEXT"); } catch (e) {}
}

// ── helpers ───────────────────────────────────────────────────────────────────

function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    return stmt.get(...params) || null;
}

function dbAll(sql, params = []) {
    const stmt = db.prepare(sql);
    return stmt.all(...params);
}

function dbRun(sql, params = []) {
    const stmt = db.prepare(sql);
    return stmt.run(...params);
}

// ── API token validation ──────────────────────────────────────────────────────

async function validateToken(token) {
    try {
        const response = await axios.get("https://discord.com/api/v9/users/@me", {
            headers: {
                "Authorization": token,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            },
            timeout: 10000,
            validateStatus: () => true
        });
        return response.status === 200 ? response.data : null;
    } catch (e) {
        return null;
    }
}

// ── database functions ────────────────────────────────────────────────────────

async function dbAddAccount(token, requesterId = null) {
    const userInfo = await validateToken(token);
    if (!userInfo) return null;

    const userId = userInfo.id || "unknown";
    const username = userInfo.username;
    const disc = userInfo.discriminator;
    const gname = userInfo.global_name;
    const now = new Date().toISOString();
    const rid = requesterId || userId;

    let accountId;
    let tokenId;

    db.exec('BEGIN');
    try {
        let row = dbGet("SELECT id FROM accounts WHERE requester_id = ?", [rid]);
        if (row) {
            accountId = row.id;
            dbRun("UPDATE accounts SET user_id=?, username=?, last_seen=?, manually_stopped=0 WHERE id=?", [userId, username, now, accountId]);
        } else {
            let row2 = dbGet("SELECT id FROM accounts WHERE user_id = ?", [userId]);
            if (row2) {
                accountId = row2.id;
                dbRun("UPDATE accounts SET last_seen=?, requester_id=?, manually_stopped=0 WHERE id=?", [now, rid, accountId]);
            } else {
                const info = dbRun(
                    "INSERT INTO accounts (user_id,username,discriminator,global_name,added_at,status,last_seen,requester_id) VALUES (?,?,?,?,?,'offline',?,?)",
                    [userId, username, disc, gname, now, now, rid]
                );
                accountId = info.lastInsertRowid;
            }
        }

        let trow = dbGet("SELECT id FROM tokens WHERE account_id = ?", [accountId]);
        if (trow) {
            dbRun("UPDATE tokens SET token=?, last_error=NULL WHERE id=?", [token, trow.id]);
            tokenId = trow.id;
        } else {
            const info2 = dbRun(
                "INSERT INTO tokens (account_id, token, build_number, added_at) VALUES (?,?,NULL,?)",
                [accountId, token, now]
            );
            tokenId = info2.lastInsertRowid;
        }
        db.exec('COMMIT');
    } catch(e) {
        db.exec('ROLLBACK');
        throw e;
    }

    return { account_id: accountId, token_id: tokenId, user_id: userId, username, global_name: gname, token, requester_id: rid };
}

function dbGetAccountByRequester(requesterId) {
    return dbGet(`
        SELECT a.*, t.token, t.build_number, t.last_error
        FROM accounts a
        LEFT JOIN tokens t ON t.account_id = a.id
        WHERE a.requester_id = ?
        ORDER BY t.added_at DESC LIMIT 1
    `, [requesterId]);
}

function dbSetManuallyStopped(userId, stopped) {
    dbRun("UPDATE accounts SET manually_stopped = ? WHERE user_id = ?", [stopped ? 1 : 0, userId]);
}

function dbUpdateAccountStatus(userId, status) {
    dbRun("UPDATE accounts SET status = ?, last_seen = ? WHERE user_id = ?", [status, new Date().toISOString(), userId]);
}

function dbGetAccountsForResume() {
    return dbAll(`
        SELECT a.*, t.token
        FROM accounts a
        INNER JOIN tokens t ON t.account_id = a.id
        WHERE a.manually_stopped = 0
          AND a.user_id != 'unknown'
          AND a.user_id IS NOT NULL
          AND t.token IS NOT NULL AND t.token != ''
        ORDER BY a.added_at DESC
    `);
}

function dbGetAllAccounts() {
    return dbAll(`
        SELECT a.*, t.token, t.build_number, t.last_error
        FROM accounts a
        LEFT JOIN tokens t ON t.account_id = a.id
        ORDER BY a.added_at DESC
    `);
}

function dbStartSession(tokenId) {
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
        dbRun("UPDATE sessions SET stopped_at=?, reason='auto' WHERE token_id=? AND stopped_at IS NULL", [now, tokenId]);
        const info = dbRun("INSERT INTO sessions (token_id, started_at) VALUES (?,?)", [tokenId, now]);
        const sessionId = info.lastInsertRowid;
        db.exec('COMMIT');
        return sessionId;
    } catch(e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

function dbStopSession(sessionId, reason = "manual") {
    dbRun("UPDATE sessions SET stopped_at=?, reason=? WHERE id=?", [new Date().toISOString(), reason, sessionId]);
}

function dbLogQuest(tokenId, questName, questId, taskType, action, status = "pending", message = "") {
    dbRun(
        `INSERT INTO quest_log (token_id,quest_name,quest_id,task_type,action,status,message,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [tokenId, questName, questId, taskType, action, status, message, new Date().toISOString()]
    );
}

function dbGetSetting(key, defaultVal = null) {
    const row = dbGet("SELECT value FROM settings WHERE key=?", [key]);
    return row ? row.value : defaultVal;
}

function dbSetSetting(key, value) {
    dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", [key, value]);
}

function dbGetTokenId(userId) {
    const accs = dbGetAllAccounts();
    const acc = accs.find(a => a.user_id === userId);
    return acc ? acc.id : 1;
}

module.exports = {
    initDb,
    dbAddAccount,
    dbGetAccountByRequester,
    dbSetManuallyStopped,
    dbUpdateAccountStatus,
    dbGetAccountsForResume,
    dbGetAllAccounts,
    dbStartSession,
    dbStopSession,
    dbLogQuest,
    dbGetSetting,
    dbSetSetting,
    dbGetTokenId,
    DB_PATH
};
