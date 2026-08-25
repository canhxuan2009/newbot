const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { sendMenuToChannel, CHANNEL_ID } = require('../utils/questInteractions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('menuquest')
        .setDescription('Nem Quest — Menu điều khiển chính'),
        
    async execute(interaction) {
        await interaction.deferReply({ flags: 64 });
        
        const res = await sendMenuToChannel(interaction.client, interaction.channel);
        if (!res.success) {
            if (res.err_type === "403") {
                await interaction.followUp({ embeds: [new EmbedBuilder()
                    .setTitle("❌ Lỗi 403 — Bot Thiếu Quyền")
                    .setDescription(`Bot không có quyền gửi tin vào kênh <#${CHANNEL_ID}>.\n\n**Cấp quyền cho bot:**\n✅ \`Send Messages\`\n✅ \`Attach Files\`\n✅ \`Manage Messages\`\n✅ \`Embed Links\``)
                    .setColor(0xFF4444)
                    .setFooter({text: "Nem Quest • Lỗi"})
                ]});
            } else {
                await interaction.followUp({ embeds: [new EmbedBuilder()
                    .setTitle("❌ Không Gửi Được Menu")
                    .setDescription("Kiểm tra lại `DISCORD_CHANNEL_ID` trong file `.env` và thử lại.")
                    .setColor(0xFF4444)
                    .setFooter({text: "Nem Quest • Lỗi"})
                ]});
            }
        } else if (res.err_type === "fallback") {
            await interaction.followUp({ content: `✅ Menu đã gửi vào kênh hiện tại (bot thiếu quyền tại <#${CHANNEL_ID}>).` });
        } else {
            await interaction.followUp({ content: `✅ Menu đã được cập nhật cuối kênh!` });
        }
    }
};
