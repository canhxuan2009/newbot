const { getTracked, removeTracked } = require('./tracker');
const logger = require('./logger');

// Discord rate limit: tối đa 2 lần đổi tên / 10 phút mỗi kênh
const COOLDOWN_MS = 10 * 60 * 1000; // 10 phút
const DEBOUNCE_MS = 30 * 1000;       // 30 giây (gom nhiều tin nhắn liên tục)

// Map<channelId, NodeJS.Timeout> — timer đang chờ
const debounceTimers = new Map();
// Map<channelId, number> — thời điểm đổi tên lần cuối
const lastRenameTime = new Map();
// Map<channelId, boolean|number> — biến tạm lưu trạng thái thay đổi (1: có thay đổi, false: không có thay đổi)
const needsRename = new Map();

let _client = null;

/**
 * Khởi tạo với Discord client — gọi một lần sau khi client được tạo
 * @param {import('discord.js').Client} client
 */
function init(client) {
    _client = client;
}

/**
 * Đếm toàn bộ tin nhắn trong kênh (phân trang)
 * @param {import('discord.js').TextChannel} channel
 * @returns {Promise<number>}
 */
async function countMessages(channel) {
    let count = 0;
    let lastId;
    while (true) {
        const opts = { limit: 100 };
        if (lastId) opts.before = lastId;
        const msgs = await channel.messages.fetch(opts);
        count += msgs.size;
        if (msgs.size < 100) break;
        lastId = msgs.last().id;
    }
    return count;
}

/**
 * Thực sự đổi tên kênh sau khi debounce và cooldown đã đủ
 */
async function doRename(guildId, channelId) {
    debounceTimers.delete(channelId);

    const tracked = await getTracked(guildId, channelId);
    if (!tracked || !_client) return;

    // Kiểm tra biến tạm: nếu là false (không có thay đổi mới) thì không đổi tên nữa
    if (needsRename.get(channelId) !== 1) {
        logger.info(`[AutoRename] Kênh ${channelId} biến tạm là false (không có thay đổi). Bỏ qua việc đổi tên.`);
        return;
    }

    const now = Date.now();
    const lastTime = lastRenameTime.get(channelId) ?? 0;
    const elapsed = now - lastTime;

    // Nếu chưa đủ cooldown, lên lịch lại sau khi cooldown hết
    if (elapsed < COOLDOWN_MS) {
        const retryIn = COOLDOWN_MS - elapsed + 5000; // +5s buffer
        logger.info(`[AutoRename] Kênh ${channelId} — cooldown còn ${Math.round(retryIn / 1000)}s, tự động lên lịch lại.`);
        const timer = setTimeout(() => doRename(guildId, channelId), retryIn);
        debounceTimers.set(channelId, timer);
        return;
    }

    try {
        const guild = await _client.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(channelId);

        if (!channel) {
            logger.warn(`[AutoRename] Không tìm thấy kênh ${channelId}, xóa khỏi danh sách theo dõi.`);
            await removeTracked(guildId, channelId);
            needsRename.delete(channelId);
            return;
        }

        // Đặt biến tạm về false trước khi gọi API để tránh bị lặp vô hạn
        needsRename.set(channelId, false);

        // Chỉ khi biến tạm bằng 1 (lúc trước khi đặt về false) thì mới đếm lượng tin nhắn và đổi tên
        const count = await countMessages(channel);
        const newName = `${tracked.baseName} ${count}`;
        await channel.setName(newName, 'Tự động cập nhật bởi mescount');
        lastRenameTime.set(channelId, Date.now());
        logger.info(`[AutoRename] #${newName} — ${count} tin nhắn (Đổi tên thành công, biến tạm đặt về false)`);
    } catch (err) {
        // Nếu đổi tên thất bại (ví dụ lỗi mạng), đặt lại biến tạm bằng 1 để lần sau chạy lại
        needsRename.set(channelId, 1);
        logger.error(`[AutoRename] Lỗi khi đổi tên kênh ${channelId}: ${err.message}`);
    }
}

/**
 * Lên lịch đổi tên kênh với debounce 30 giây
 * Mỗi khi có sự kiện mới, timer 30s sẽ được reset
 */
function scheduleRename(guildId, channelId) {
    if (!_client) return;

    // Khi có thay đổi, đặt biến tạm bằng 1
    needsRename.set(channelId, 1);

    // Reset debounce timer
    if (debounceTimers.has(channelId)) {
        clearTimeout(debounceTimers.get(channelId));
    }

    const timer = setTimeout(() => doRename(guildId, channelId), DEBOUNCE_MS);
    debounceTimers.set(channelId, timer);
}

module.exports = { init, scheduleRename, countMessages };
