/**
 * Kiểm tra người dùng có quyền sử dụng lệnh không
 * Cho phép nếu: Chủ server hoặc có quyền Discord được yêu cầu
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {bigint} requiredPermission - Discord permission flag cần thiết
 * @returns {boolean}
 */
function hasPermission(interaction, requiredPermission) {
    if (interaction.guild && interaction.guild.ownerId === interaction.user.id) {
        return true;
    }

    if (interaction.member && interaction.member.permissions.has(requiredPermission)) {
        return true;
    }

    return false;
}

module.exports = { hasPermission };
