const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Setting = require('../models/setting');
const { hasPermission } = require('../utils/permissions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setbank')
        .setDescription('Cài đặt thông tin ngân hàng VietQR cho Shop')
        .addStringOption(option =>
            option.setName('bank_id')
                .setDescription('Mã ngân hàng (VD: BIDV, MB, VCB)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('account')
                .setDescription('Số tài khoản')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Tên chủ tài khoản (Không dấu)')
                .setRequired(true)),

    async execute(interaction) {
        if (!hasPermission(interaction, PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ Bạn không có quyền sử dụng lệnh này.',
                ephemeral: true,
            });
        }

        const bankId = interaction.options.getString('bank_id').toUpperCase();
        const bankAccount = interaction.options.getString('account');
        const bankName = interaction.options.getString('name').toUpperCase();

        try {
            await Setting.findOneAndUpdate(
                { key: 'bank_config' },
                { value: { bankId, bankAccount, bankName } },
                { upsert: true, new: true }
            );

            await interaction.reply({
                content: `✅ Đã lưu cấu hình ngân hàng thành công!\n🏦 **Ngân hàng:** ${bankId}\n🔢 **STK:** ${bankAccount}\n👤 **Chủ TK:** ${bankName}`,
                ephemeral: true
            });
        } catch (error) {
            await interaction.reply({
                content: `❌ Đã xảy ra lỗi khi lưu cấu hình: ${error.message}`,
                ephemeral: true
            });
        }
    },
};
