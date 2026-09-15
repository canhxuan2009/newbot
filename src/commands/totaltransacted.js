const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const Member = require('../models/member');
const { hasPermission } = require('../utils/permissions');

const SHOP_ADMIN_IDS = (process.env.SHOP_ADMIN_ID || '1053646107785302069,717336894941167646')
    .split(',')
    .map((id) => id.trim());

const RANK_MILESTONES = [
    { name: '💎 Kim Cương', amount: 10_000_000 },
    { name: '🟢 Lục Bảo', amount: 5_000_000 },
    { name: '🟡 Vàng', amount: 1_000_000 },
    { name: '⚪ Iron', amount: 100_000 },
];

function checkIsAdmin(interaction) {
    if (interaction.guild && interaction.guild.ownerId === interaction.user.id) return true;
    if (SHOP_ADMIN_IDS.includes(interaction.user.id)) return true;
    if (hasPermission(interaction, PermissionFlagsBits.Administrator)) return true;
    return false;
}

function getCurrentRank(amount) {
    return RANK_MILESTONES.find(m => amount >= m.amount) || null;
}

function getNextRank(amount) {
    const sortedAsc = [...RANK_MILESTONES].reverse();
    return sortedAsc.find(m => amount < m.amount) || null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('totaltransacted')
        .setDescription('Tra cứu số tiền đã giao dịch (Chỉ xem của mình, Admin có thể xem người khác)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Thành viên cần tra cứu (Chỉ Admin mới được dùng)')
                .setRequired(false)),

    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;
        const isSelf = targetUser.id === interaction.user.id;

        // Nếu không phải tra cứu chính mình, bắt buộc phải là Admin
        if (!isSelf && !checkIsAdmin(interaction)) {
            return interaction.reply({
                content: '❌ Bạn chỉ được phép tra cứu số tiền giao dịch của chính mình! Chỉ Admin mới có quyền tra cứu người khác.',
                ephemeral: true,
            });
        }

        try {
            const memberData = await Member.findOne({
                guildId: interaction.guildId,
                userId: targetUser.id,
            });

            const totalAmount = memberData ? memberData.totalAmount : 0;
            const transactionCount = memberData && memberData.transactions ? memberData.transactions.length : 0;

            const currentRank = getCurrentRank(totalAmount);
            const nextRank = getNextRank(totalAmount);

            const embed = new EmbedBuilder()
                .setColor(0x2ecc71)
                .setAuthor({
                    name: `Thông Tin Giao Dịch • ${targetUser.displayName || targetUser.username}`,
                    iconURL: targetUser.displayAvatarURL({ dynamic: true })
                })
                .setDescription(isSelf 
                    ? `Dưới đây là thông tin giao dịch tích lũy của bạn trên server:`
                    : `Dưới đây là thông tin giao dịch tích lũy của thành viên <@${targetUser.id}>:`)
                .addFields(
                    { name: '👤 Thành viên', value: `<@${targetUser.id}>`, inline: true },
                    { name: '💵 Số tiền đã giao dịch', value: `**${totalAmount.toLocaleString('vi-VN')}đ**`, inline: true },
                    { name: '🏆 Hạng hiện tại', value: currentRank ? `**${currentRank.name}**` : '_Chưa có rank_', inline: true },
                );

            if (nextRank) {
                const remaining = nextRank.amount - totalAmount;
                embed.addFields({
                    name: '🎯 Mốc kế tiếp',
                    value: `Cần giao dịch thêm **${remaining.toLocaleString('vi-VN')}đ** để đạt **${nextRank.name}**`,
                    inline: false
                });
            }

            if (transactionCount > 0) {
                embed.setFooter({ text: `Tổng cộng ${transactionCount} lượt giao dịch ghi nhận` });
            } else {
                embed.setFooter({ text: 'Chưa có giao dịch nào được ghi nhận' });
            }
            embed.setTimestamp();

            await interaction.reply({
                embeds: [embed],
                ephemeral: true,
            });
        } catch (error) {
            await interaction.reply({
                content: `❌ Đã xảy ra lỗi khi lấy thông tin giao dịch: ${error.message}`,
                ephemeral: true,
            });
        }
    },
};
