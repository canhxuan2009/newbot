require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, Events } = require('discord.js');
const mongoose = require('mongoose');
const logger = require('./utils/logger');
const { init: initAutoRename, scheduleRename } = require('./utils/autoRename');
const { getTracked } = require('./utils/tracker');
const { translateToVietnamese } = require('./utils/translator');
const { handleShopInteraction } = require('./utils/shopInteractions');
const questDb = require('./utils/questDb');
const { autoResumeQuests, handleQuestInteraction } = require('./utils/questInteractions');


// Cấu hình dịch tự động DonutSMP
const TRANSLATE_SOURCE = process.env.TRANSLATE_SOURCE_CHANNEL;
const TRANSLATE_TARGET = process.env.TRANSLATE_TARGET_CHANNEL;
const TRANSLATE_PING_ROLE_ID = process.env.TRANSLATE_PING_ROLE_ID;

// Kiểm tra token trước khi khởi động
if (!process.env.DISCORD_TOKEN) {
    logger.error('FATAL: Biến môi trường DISCORD_TOKEN chưa được cấu hình!');
    logger.error('Vui lòng thêm DISCORD_TOKEN=your_token vào file .env');
    process.exit(1);
}

// Kiểm tra và kết nối MongoDB
if (!process.env.MONGODB_URI) {
    logger.error('FATAL: Biến môi trường MONGODB_URI chưa được cấu hình!');
    process.exit(1);
}

mongoose.connect(process.env.MONGODB_URI)
    .then(() => logger.info('✅ Đã kết nối cơ sở dữ liệu MongoDB thành công.'))
    .catch((err) => {
        logger.error(`❌ Lỗi kết nối MongoDB: ${err.message}`);
        process.exit(1);
    });

// Khởi tạo database cho Quest
try {
    questDb.initDb();
    logger.info('✅ Đã kết nối cơ sở dữ liệu SQLite cho Quest.');
} catch (err) {
    logger.error(`❌ Lỗi kết nối SQLite: ${err.message}`);
}

// Global error handlers
process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Promise Rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error}`);
});

// Khởi tạo Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Khởi tạo module tự động đổi tên kênh
initAutoRename(client);

// Collection chứa tất cả commands
client.commands = new Collection();

// Tự động load commands từ thư mục commands/
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
            logger.info(`Loaded command: /${command.data.name}`);
        } else {
            logger.warn(`Command ${file} thiếu "data" hoặc "execute".`);
        }
    }
}

// Event khi bot sẵn sàng
client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`🤖 Bot đã đăng nhập thành công dưới tên: ${readyClient.user.tag}`);
    logger.info(`📁 File log phiên làm việc: ${logger.currentFile}`);

    await autoResumeQuests(readyClient);
});

// Xử lý slash commands
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
        logger.warn(`Không tìm thấy command: ${interaction.commandName}`);
        return;
    }

    logger.logCommand(interaction);

    try {
        await command.execute(interaction);
    } catch (error) {
        logger.error(`Lỗi khi chạy /${interaction.commandName}: ${error}`);
        const reply = {
            content: '❌ Đã xảy ra lỗi khi thực hiện lệnh này!',
            ephemeral: true,
        };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply);
        } else {
            await interaction.reply(reply);
        }
    }
});

// Xử lý Button & SelectMenu interactions
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isModalSubmit()) {
        logger.info(`[DEBUG] Nhận được ModalSubmit với customId: ${interaction.customId}`);
    }
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

    try {

        await handleShopInteraction(interaction);
        await handleQuestInteraction(interaction, client);
    } catch (error) {
        logger.error(`[Interaction] Lỗi xử lý: ${error.message}`);
        const reply = { content: '❌ Đã xảy ra lỗi khi xử lý yêu cầu.', ephemeral: true };
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(reply);
            } else {
                await interaction.reply(reply);
            }
        } catch { /* ignore */ }
    }
});

/**
 * Kiểm tra cú pháp tin nhắn hợp lệ (+1 vouch hoặc +1 legit có kèm lời nhắn)
 */
function isValidVouch(text) {
    if (!text) return false;

    const cleaned = text.trim().toLowerCase();

    // 1. Phải bắt đầu bằng ký tự '+'
    if (!cleaned.startsWith('+')) return false;

    let rest = cleaned.substring(1).trim();

    // 2. Tiếp theo phải bắt đầu bằng số '1'
    if (!rest.startsWith('1')) return false;

    rest = rest.substring(1).trim();

    // 3. Tiếp theo phải là 'vouch' hoặc 'legit'
    let keyword = '';
    if (rest.startsWith('vouch')) {
        keyword = 'vouch';
    } else if (rest.startsWith('legit')) {
        keyword = 'legit';
    } else {
        return false;
    }

    // 4. Bắt buộc phải có lời nhắn phía sau
    const messagePart = rest.substring(keyword.length).trim();
    return messagePart.length > 0;
}

// Lắng nghe tin nhắn mới — kiểm tra cú pháp + đếm tin nhắn
client.on(Events.MessageCreate, async (message) => {
    if (!message.guild || message.author.bot) return;

    const tracked = await getTracked(message.guild.id, message.channel.id);
    if (!tracked) return;

    // Kiểm tra cú pháp trong kênh đang theo dõi
    const isValid = isValidVouch(message.content);
    logger.info(`[FormatCheck] Thử nghiệm tin nhắn: "${message.content}" | Kết quả kiểm tra: ${isValid}`);

    if (!isValid) {
        try {
            await message.delete();

            const warning = await message.channel.send(
                `${message.author} 💬 Ôi, tin nhắn của bạn chưa đúng cú pháp rồi!\n` +
                `Bạn vui lòng gửi lại theo mẫu nhé:\n` +
                `> ✅ \`+1 vouch ...\` hoặc \`+1 legit ...\`\n` +
                `Cảm ơn bạn rất nhiều! 🙏✨`
            );

            // Tự xóa cảnh báo sau 10 giây
            setTimeout(() => warning.delete().catch(() => { }), 10_000);
        } catch (err) {
            logger.error(`[FormatCheck] Lỗi xử lý tin nhắn sai: ${err.message}`);
        }
        return;
    }

    // Tin nhắn hợp lệ — lên lịch cập nhật tên kênh
    scheduleRename(message.guild.id, message.channel.id);
});

// Lắng nghe tin nhắn bị xóa đơn lẻ (bỏ qua tin nhắn bot)
client.on(Events.MessageDelete, async (message) => {
    if (!message.guild) return;
    if (message.author?.bot) return;
    const tracked = await getTracked(message.guild.id, message.channel.id);
    if (!tracked) return;
    scheduleRename(message.guild.id, message.channel.id);
});

// Lắng nghe xóa tin nhắn hàng loạt
client.on(Events.MessageBulkDelete, async (messages) => {
    const first = messages.first();
    if (!first?.guild) return;
    const tracked = await getTracked(first.guild.id, first.channel.id);
    if (!tracked) return;
    scheduleRename(first.guild.id, first.channel.id);
});

// ─── Dịch tự động thông báo DonutSMP (EN → VI) ─────────────────────────
client.on(Events.MessageCreate, async (message) => {
    // Bỏ qua nếu chưa cấu hình channel dịch
    if (!TRANSLATE_SOURCE || !TRANSLATE_TARGET) return;

    // Chỉ xử lý tin nhắn trong channel nguồn
    if (message.channel.id !== TRANSLATE_SOURCE) return;

    // Bỏ qua tin nhắn của chính bot này
    if (message.author.id === message.client.user.id) return;

    // Lấy nội dung — ưu tiên content, nếu rỗng thì lấy từ embed đầu tiên
    let content = message.content;
    if (!content && message.embeds.length > 0) {
        const embed = message.embeds[0];
        content = [embed.title, embed.description].filter(Boolean).join('\n\n');
    }

    if (!content || content.trim().length === 0) return;

    logger.info(`[Translator] Nhận tin nhắn từ #${message.channel.name}: "${content.substring(0, 80)}..."`);

    try {
        const translated = await translateToVietnamese(content);
        if (!translated) {
            logger.warn('[Translator] Không nhận được kết quả dịch, bỏ qua.');
            return;
        }

        const targetChannel = await message.client.channels.fetch(TRANSLATE_TARGET);
        if (!targetChannel) {
            logger.error(`[Translator] Không tìm thấy channel đích: ${TRANSLATE_TARGET}`);
            return;
        }

        const pingText = (TRANSLATE_PING_ROLE_ID && TRANSLATE_PING_ROLE_ID.trim())
            ? `<@&${TRANSLATE_PING_ROLE_ID.trim()}>\n`
            : '';
        const prefix = pingText;

        const MAX_MESSAGE_LIMIT = 2000;
        const availableLength = MAX_MESSAGE_LIMIT - prefix.length;
        const truncated = translated.length > availableLength
            ? translated.substring(0, availableLength - 3) + '...'
            : translated;

        const finalMessage = `${prefix}${truncated}`;

        await targetChannel.send({ content: finalMessage });
        logger.info(`[Translator] ✅ Đã gửi bản dịch vào #${targetChannel.name}`);

    } catch (error) {
        logger.error(`[Translator] ❌ Lỗi xử lý dịch tự động: ${error.message}`);
    }
});

// ─── Tính năng Chào Mừng Thành Viên Mới ─────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
    const welcomeChannelId = process.env.WELCOME_CHANNEL_ID;
    if (!welcomeChannelId) return;

    const channel = member.guild.channels.cache.get(welcomeChannelId);
    if (!channel) return;

    const stockChannel = process.env.WELCOME_STOCK_CHANNEL_ID ? `<#${process.env.WELCOME_STOCK_CHANNEL_ID}>` : '# 🛒 ・ stock';
    const buyChannel = process.env.WELCOME_BUY_CHANNEL_ID ? `<#${process.env.WELCOME_BUY_CHANNEL_ID}>` : '# 📩 ・ mua-hàng';
    const tosChannel = process.env.WELCOME_TOS_CHANNEL_ID ? `<#${process.env.WELCOME_TOS_CHANNEL_ID}>` : '# 📜 ・ tos-bảo-hành';

    const memberCount = member.guild.memberCount.toLocaleString('vi-VN');

    const embed = {
        title: 'Chào Mừng Thành Viên Mới ⭐',
        description: `Xin chào ${member} 👋\nBạn là thành viên thứ **#${memberCount}** sì to chúng tớ 🤍\n\n` +
            `───────────────────────────────\n\n` +
            `${stockChannel} ・ Mua hàng tại đây!\n` +
            `${buyChannel} ・ Trò chuyện tại đây!\n` +
            `${tosChannel} ・ Thu Money hàng ngày tại đây!\n\n` +
            `Cảm ơn bạn đã gia nhập Nem Sờ Ti 💚`,
        color: 0x2ecc71, // Vibrant Green
        thumbnail: {
            url: member.displayAvatarURL({ dynamic: true, size: 512 }) || member.guild.iconURL({ dynamic: true, size: 512 })
        },
        image: {
            url: 'https://cdn.discordapp.com/attachments/1524083621512613918/1541800402230710302/ezgif-53c83bb88da2f063.gif?ex=6a8ee905&is=6a8d9785&hm=eb184c6710d111973d27eaa2186ecf8ef26890410eee0c92e2f147a9409e5518'
        }
    };

    try {
        await channel.send({ embeds: [embed] });
        logger.info(`[Welcome] Đã gửi tin nhắn chào mừng cho ${member.user.tag}`);
    } catch (error) {
        logger.error(`[Welcome] Lỗi khi gửi tin nhắn chào mừng: ${error.message}`);
    }
});

// Khởi chạy bot
client.login(process.env.DISCORD_TOKEN);

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[Shutdown] Nhận ${signal}, đang dừng các session...`);

    try {
        client.destroy();
        await mongoose.disconnect();
    } catch (error) {
        logger.error(`[Shutdown] ${error.stack || error}`);
    } finally {
        process.exit(0);
    }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
