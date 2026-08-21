const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { hasPermission } = require('../utils/permissions');
const { addTracked, removeTracked, getAllTracked } = require('../utils/tracker');
const { countMessages } = require('../utils/autoRename');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mescount')
        .setDescription('Quản lý đếm tin nhắn tự động cho kênh')
        .addSubcommand(sub =>
            sub.setName('track')
                .setDescription('Đếm tin nhắn và tự động cập nhật tên kênh khi có tin nhắn mới/bị xóa')
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Kênh cần theo dõi')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildText))
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Tên gốc của kênh (kết quả sẽ là: <tên> <số>)')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('stop')
                .setDescription('Dừng theo dõi tự động cho kênh')
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Kênh cần dừng theo dõi')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Xem danh sách các kênh đang được theo dõi')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        // Kiểm tra quyền cho track và stop
        if (sub === 'track' || sub === 'stop') {
            if (!hasPermission(interaction, PermissionFlagsBits.ManageChannels)) {
                return interaction.reply({
                    content: '❌ Bạn không có quyền sử dụng lệnh này!\n💡 Cần quyền **Quản lý kênh** hoặc được cấp **Bot Admin**.',
                    ephemeral: true,
                });
            }
        }

        // ─────────────── /mescount track ───────────────
        if (sub === 'track') {
            const channel = interaction.options.getChannel('channel');
            const baseName = interaction.options.getString('name');

            await interaction.deferReply();

            try {
                const count = await countMessages(channel);
                const newName = `${baseName} ${count}`;
                await channel.setName(newName, 'Khởi tạo bởi /mescount track');

                // Lưu vào danh sách theo dõi
                await addTracked(interaction.guild.id, channel.id, baseName);

                const embed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('✅ Đã bắt đầu theo dõi')
                    .addFields(
                        { name: '📢 Kênh', value: `${channel}`, inline: true },
                        { name: '💬 Tin nhắn hiện tại', value: count.toLocaleString('vi-VN'), inline: true },
                        { name: '✏️ Tên mới', value: `\`${newName}\``, inline: true },
                        {
                            name: '🔄 Cập nhật tự động',
                            value: 'Tên kênh sẽ tự cập nhật khi có tin nhắn mới hoặc bị xóa.\n⏱️ **Cooldown 10 phút** giữa mỗi lần đổi tên (giới hạn của Discord).',
                        },
                    )
                    .setFooter({ text: `Thực hiện bởi ${interaction.user.displayName}` })
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                await interaction.editReply({ content: `❌ Lỗi: ${error.message}` });
            }
        }

        // ─────────────── /mescount stop ───────────────
        if (sub === 'stop') {
            const channel = interaction.options.getChannel('channel');
            const removed = await removeTracked(interaction.guild.id, channel.id);

            if (!removed) {
                return interaction.reply({
                    content: `❌ Kênh ${channel} không nằm trong danh sách theo dõi.`,
                    ephemeral: true,
                });
            }

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('🛑 Đã dừng theo dõi')
                .setDescription(`Kênh ${channel} sẽ không còn tự động cập nhật tên nữa.`)
                .setFooter({ text: `Thực hiện bởi ${interaction.user.displayName}` })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }

        // ─────────────── /mescount list ───────────────
        if (sub === 'list') {
            const allTracked = await getAllTracked();
            const guildTracked = allTracked[interaction.guild.id] ?? {};
            const entries = Object.entries(guildTracked);

            if (entries.length === 0) {
                return interaction.reply({
                    content: '📭 Chưa có kênh nào đang được theo dõi trong server này.',
                    ephemeral: true,
                });
            }

            const lines = entries
                .map(([channelId, { baseName }]) =>
                    `<#${channelId}> — Tên gốc: **${baseName}**`)
                .join('\n');

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`📋 Kênh đang theo dõi (${entries.length})`)
                .setDescription(lines)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }
    },
};
