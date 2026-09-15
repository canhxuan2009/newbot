const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');
const Member = require('../models/member');
const Setting = require('../models/setting');
const logger = require('./logger');

const PAGE_SIZE = 20;

/**
 * Xây dựng Embed và Buttons cho Bảng Xếp Hạng
 */
async function buildLeaderboardPayload(guild, page = 1) {
    const totalCount = await Member.countDocuments({ guildId: guild.id, totalAmount: { $gt: 0 } });
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, page), totalPages);

    const members = await Member.find({ guildId: guild.id, totalAmount: { $gt: 0 } })
        .sort({ totalAmount: -1 })
        .skip((currentPage - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE);

    // Tính tổng doanh số giao dịch toàn server
    const agg = await Member.aggregate([
        { $match: { guildId: guild.id } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);
    const serverTotal = agg.length > 0 ? agg[0].total : 0;

    let description = '';
    if (members.length === 0) {
        description = '📭 _Chưa có dữ liệu giao dịch nào được ghi nhận trên hệ thống._';
    } else {
        const lines = members.map((m, idx) => {
            const rankNum = (currentPage - 1) * PAGE_SIZE + idx + 1;
            let medal = '▫️';
            if (rankNum === 1) medal = '🥇';
            else if (rankNum === 2) medal = '🥈';
            else if (rankNum === 3) medal = '🥉';

            const padRank = String(rankNum).padStart(2, '0');
            const count = m.transactions ? m.transactions.length : 0;
            const countStr = count > 0 ? ` *(${count} đơn)*` : '';

            return `${medal} **#${padRank}** • <@${m.userId}> • **${m.totalAmount.toLocaleString('vi-VN')}đ**${countStr}`;
        });

        description = `*Cập nhật thời gian thực • Bảng quản trị nội bộ*\n\n` +
            lines.join('\n') +
            `\n\n──────────────────────────────\n` +
            `📈 **Tổng giao dịch toàn server:** **${serverTotal.toLocaleString('vi-VN')}đ** • **Khách hàng:** **${totalCount} người**`;
    }

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('📊 BẢNG XẾP HẠNG GIAO DỊCH (ADMIN)')
        .setDescription(description);

    if (guild.iconURL()) {
        embed.setThumbnail(guild.iconURL({ dynamic: true }));
    }

    embed.setFooter({ text: `Trang ${currentPage}/${totalPages} • Tự động cập nhật` })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`lb_prev_${currentPage}`)
            .setLabel('◀️ Trang trước')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage <= 1),
        new ButtonBuilder()
            .setCustomId('lb_page_indicator')
            .setLabel(`Trang ${currentPage}/${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(`lb_next_${currentPage}`)
            .setLabel('Trang sau ▶️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage >= totalPages),
        new ButtonBuilder()
            .setCustomId(`lb_refresh_${currentPage}`)
            .setLabel('🔄 Làm mới')
            .setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [row] };
}

/**
 * Tự động cập nhật (hoặc tạo mới) tin nhắn bảng xếp hạng thời gian thực
 */
async function updateLeaderboardMessage(client, targetPage = 1) {
    const channelId = process.env.LEADERBOARD_CHANNEL_ID || '1549315315496787999';
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            logger.warn(`[Leaderboard] Không tìm thấy kênh bảng xếp hạng ID: ${channelId}`);
            return;
        }

        const payload = await buildLeaderboardPayload(channel.guild, targetPage);
        const setting = await Setting.findOne({ key: 'leaderboard_message' });

        if (setting && setting.value && setting.value.messageId) {
            const existingMsg = await channel.messages.fetch(setting.value.messageId).catch(() => null);
            if (existingMsg) {
                await existingMsg.edit(payload);
                logger.info(`[Leaderboard] Đã cập nhật tin nhắn Bảng Xếp Hạng thành công.`);
                return;
            }
        }

        // Nếu chưa có hoặc tin nhắn cũ bị xoá, gửi tin nhắn mới
        const newMsg = await channel.send(payload);
        await Setting.findOneAndUpdate(
            { key: 'leaderboard_message' },
            { value: { channelId, messageId: newMsg.id } },
            { upsert: true, new: true }
        );
        logger.info(`[Leaderboard] Đã gửi tin nhắn Bảng Xếp Hạng mới (ID: ${newMsg.id}).`);
    } catch (error) {
        logger.error(`[Leaderboard] Lỗi khi cập nhật Bảng Xếp Hạng: ${error.message}`);
    }
}

/**
 * Xử lý nút bấm phân trang Bảng Xếp Hạng
 */
async function handleLeaderboardInteraction(interaction) {
    if (!interaction.isButton()) return false;
    const { customId } = interaction;

    if (!customId.startsWith('lb_')) return false;
    if (customId === 'lb_page_indicator') return true;

    try {
        await interaction.deferUpdate();

        let targetPage = 1;
        if (customId.startsWith('lb_prev_')) {
            const current = parseInt(customId.replace('lb_prev_', ''), 10) || 1;
            targetPage = Math.max(1, current - 1);
        } else if (customId.startsWith('lb_next_')) {
            const current = parseInt(customId.replace('lb_next_', ''), 10) || 1;
            targetPage = current + 1;
        } else if (customId.startsWith('lb_refresh_')) {
            targetPage = parseInt(customId.replace('lb_refresh_', ''), 10) || 1;
        }

        const payload = await buildLeaderboardPayload(interaction.guild, targetPage);
        await interaction.editReply(payload);
    } catch (error) {
        logger.error(`[Leaderboard] Lỗi xử lý nút bấm: ${error.message}`);
    }

    return true;
}

module.exports = {
    buildLeaderboardPayload,
    updateLeaderboardMessage,
    handleLeaderboardInteraction,
};

