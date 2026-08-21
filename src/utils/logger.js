const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

// Tạo thư mục logs nếu chưa có
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Tạo tên file log theo thời điểm khởi động bot
function getStartupTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
        `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
    );
}

const LOG_FILE = path.join(LOGS_DIR, `${getStartupTimestamp()}.log`);

/**
 * Trả về timestamp hiện tại dạng [YYYY-MM-DD HH:MM:SS]
 */
function getTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
        `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
        `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`
    );
}

/**
 * Ghi một dòng log ra console và file
 * @param {string} level - Cấp độ log: INFO | CMD | WARN | ERROR
 * @param {string} message - Nội dung log
 */
function write(level, message) {
    const line = `${getTimestamp()} [${level.padEnd(5)}] ${message}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
}

const logger = {
    info:  (msg) => write('INFO',  msg),
    warn:  (msg) => write('WARN',  msg),
    error: (msg) => write('ERROR', msg),
    cmd:   (msg) => write('CMD',   msg),

    /**
     * Ghi log khi người dùng thực thi slash command
     * @param {import('discord.js').ChatInputCommandInteraction} interaction
     */
    logCommand(interaction) {
        const user    = `${interaction.user.tag} (${interaction.user.id})`;
        const guild   = interaction.guild
            ? `${interaction.guild.name} (${interaction.guild.id})`
            : 'DM';
        const command = `/${interaction.commandName}`;

        const options = interaction.options.data
            .map((opt) => {
                const val = opt.user ?? opt.member ?? opt.role ?? opt.channel ?? opt.value;
                const display = val?.tag ?? val?.displayName ?? val?.name ?? val;
                return `${opt.name}=${display}`;
            })
            .join(', ');

        const optStr = options ? ` | Options: ${options}` : '';
        this.cmd(`${command} | User: ${user} | Guild: ${guild}${optStr}`);
    },

    currentFile: LOG_FILE,
};

module.exports = logger;
