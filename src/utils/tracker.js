const Tracker = require('../models/tracker');

/**
 * Đăng ký theo dõi một kênh
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} baseName - Tên gốc của kênh (không có số)
 */
async function addTracked(guildId, channelId, baseName) {
    await Tracker.findOneAndUpdate(
        { guildId, channelId },
        { baseName },
        { upsert: true, new: true },
    );
}

/**
 * Hủy theo dõi một kênh
 * @returns {Promise<boolean>} true nếu xóa thành công, false nếu không tìm thấy
 */
async function removeTracked(guildId, channelId) {
    const result = await Tracker.deleteOne({ guildId, channelId });
    return result.deletedCount > 0;
}

/**
 * Lấy thông tin theo dõi của một kênh
 * @returns {Promise<{ baseName: string } | null>}
 */
async function getTracked(guildId, channelId) {
    const doc = await Tracker.findOne({ guildId, channelId }).lean();
    if (!doc) return null;
    return { baseName: doc.baseName };
}

/**
 * Lấy tất cả kênh đang theo dõi
 * @returns {Promise<Object>} { guildId: { channelId: { baseName } } }
 */
async function getAllTracked() {
    const docs = await Tracker.find().lean();
    const result = {};
    for (const doc of docs) {
        if (!result[doc.guildId]) result[doc.guildId] = {};
        result[doc.guildId][doc.channelId] = { baseName: doc.baseName };
    }
    return result;
}

module.exports = { addTracked, removeTracked, getTracked, getAllTracked };
