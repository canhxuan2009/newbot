const { SlashCommandBuilder, Events } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('testwelcome')
        .setDescription('Test tin nhắn chào mừng (Mô phỏng 1 thành viên mới tham gia)'),

    async execute(interaction) {
        if (!process.env.WELCOME_CHANNEL_ID) {
            return interaction.reply({
                content: '❌ Bạn chưa cấu hình `WELCOME_CHANNEL_ID` trong file `.env`!',
                ephemeral: true
            });
        }

        const channel = interaction.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
        if (!channel) {
            return interaction.reply({
                content: `❌ Không tìm thấy kênh có ID: ${process.env.WELCOME_CHANNEL_ID}. Vui lòng kiểm tra lại cấu hình.`,
                ephemeral: true
            });
        }

        // Mô phỏng sự kiện GuildMemberAdd bằng chính member đang gõ lệnh
        interaction.client.emit(Events.GuildMemberAdd, interaction.member);

        await interaction.reply({
            content: `✅ Đã gửi tin nhắn test chào mừng tới kênh <#${process.env.WELCOME_CHANNEL_ID}>!`,
            ephemeral: true
        });
    }
};
