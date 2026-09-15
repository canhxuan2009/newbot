const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits,
} = require('discord.js');
const Member = require('../models/member');
const logger = require('./logger');
const { updateLeaderboardMessage } = require('./leaderboard');

const RANK_MILESTONES = [
    { key: 'DIAMOND', name: 'Kim Cương', amount: 10_000_000, envVar: 'RANK_ROLE_DIAMOND' },
    { key: 'EMERALD', name: 'Lục Bảo', amount: 5_000_000, envVar: 'RANK_ROLE_EMERALD' },
    { key: 'GOLD', name: 'Vàng', amount: 1_000_000, envVar: 'RANK_ROLE_GOLD' },
    { key: 'IRON', name: 'Iron', amount: 100_000, envVar: 'RANK_ROLE_IRON' },
];

/**
 * Phân tích chuỗi số tiền hỗ trợ các định dạng: 100k, 1m, 1b, 250.000.000, 2.5m, v.v.
 */
function parseAmount(rawStr) {
    if (!rawStr) return null;
    let s = rawStr.trim().toLowerCase().replace(/đ$/, '').replace(/vnd$/, '').trim();

    s = s.replace(/^-+/, '').replace(/-+$/, '').trim();

    let multiplier = 1;
    if (s.endsWith('tỷ') || s.endsWith('ty')) {
        multiplier = 1_000_000_000;
        s = s.replace(/(tỷ|ty)$/, '').trim();
    } else if (s.endsWith('b')) {
        multiplier = 1_000_000_000;
        s = s.slice(0, -1).trim();
    } else if (s.endsWith('m') || s.endsWith('tr')) {
        multiplier = 1_000_000;
        s = s.replace(/(m|tr)$/, '').trim();
    } else if (s.endsWith('k')) {
        multiplier = 1_000;
        s = s.slice(0, -1).trim();
    }

    if ((s.match(/\./g) || []).length > 1) {
        s = s.replace(/\./g, '');
    } else if ((s.match(/,/g) || []).length > 1) {
        s = s.replace(/,/g, '');
    } else if (s.includes(',') && !s.includes('.')) {
        if (/^\d+,\d{3}$/.test(s) && multiplier === 1) {
            s = s.replace(',', '');
        } else {
            s = s.replace(',', '.');
        }
    } else if (s.includes('.') && multiplier === 1 && /^\d+\.\d{3}$/.test(s)) {
        s = s.replace('.', '');
    }

    const num = parseFloat(s);
    if (isNaN(num) || num <= 0) return null;

    return Math.round(num * multiplier);
}

function getHighestMilestone(amount) {
    return RANK_MILESTONES.find(m => amount >= m.amount) || null;
}

/**
 * Cập nhật role rank cho thành viên (chỉ giữ role cao nhất)
 */
async function syncMemberRankRole(guild, member, newAmount) {
    const highest = getHighestMilestone(newAmount);
    const targetRoleId = highest ? (process.env[highest.envVar] || '').trim() : null;

    const allRankRoleIds = RANK_MILESTONES
        .map(m => (process.env[m.envVar] || '').trim())
        .filter(Boolean);

    // 1. Gỡ tất cả role rank cũ không phải role cao nhất hiện tại
    for (const rId of allRankRoleIds) {
        if (rId !== targetRoleId && member.roles.cache.has(rId)) {
            await member.roles.remove(rId, 'Cập nhật mốc rank: chỉ giữ role cao nhất').catch(() => {});
        }
    }

    // 2. Thêm role cao nhất nếu chưa có
    if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
        await member.roles.add(targetRoleId, `Đạt mốc giao dịch ${highest.amount.toLocaleString('vi-VN')}đ`).catch(() => {});
    }
}

/**
 * Tự động tìm ID khách hàng trong ticket
 */
async function detectCustomerId(message, parts = []) {
    // 1. Tag trực tiếp trong lệnh (bất kỳ user nào được tag mà không phải bot)
    const mention = message.mentions.users.find(u => !u.bot);
    if (mention) return mention.id;

    // 1.1 Kiểm tra nếu admin nhập trực tiếp ID Discord dạng chuỗi số (17-20 ký tự)
    const rawId = parts.slice(1).find(p => /^\d{17,20}$/.test(p));
    if (rawId && rawId !== message.client.user.id) {
        return rawId;
    }

    // 2. Ticket nội bộ của bot (ShopTicket)
    try {
        const ShopTicket = require('../models/shopTicket');
        const shopTicket = await ShopTicket.findOne({ channelId: message.channel.id }).catch(() => null);
        if (shopTicket && shopTicket.buyerId) {
            return shopTicket.buyerId;
        }
    } catch (e) {
        // ignore
    }

    // 3. Ticket King (hoặc bot khác): Quét các tin nhắn đầu tiên của kênh
    try {
        const fetchedMessages = await message.channel.messages.fetch({ limit: 25 });
        const sorted = Array.from(fetchedMessages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const m of sorted) {
            if (m.author.bot) {
                // Ưu tiên 1: mentions user
                const userMention = m.mentions.users.find(u => !u.bot);
                if (userMention) return userMention.id;

                // Ưu tiên 2: Regex ping <@123456789> trong content
                const match = m.content.match(/<@!?(\d{17,20})>/);
                if (match && match[1] !== message.client.user.id) {
                    return match[1];
                }

                // Ưu tiên 3: Regex trong Embed description hoặc fields
                for (const embed of m.embeds) {
                    const embedText = [embed.description, ...(embed.fields || []).map(f => f.value)].join(' ');
                    const embedMatch = embedText.match(/<@!?(\d{17,20})>/);
                    if (embedMatch && embedMatch[1] !== message.client.user.id) {
                        return embedMatch[1];
                    }
                }
            }
        }
    } catch (e) {
        logger.error(`[RankManager] Lỗi fetch tin nhắn tìm khách hàng: ${e.message}`);
    }

    // 4. Quét Channel Topic
    if (message.channel.topic) {
        const topicMatch = message.channel.topic.match(/<@!?(\d{17,20})>|\b(\d{17,20})\b/);
        if (topicMatch) {
            const id = topicMatch[1] || topicMatch[2];
            if (id && id !== message.client.user.id) return id;
        }
    }

    // 5. Quét Permission Overwrites
    try {
        const overwrites = message.channel.permissionOverwrites.cache;
        const memberOverwrites = [];
        for (const [id, overwrite] of overwrites) {
            if (overwrite.type === 1 && id !== message.client.user.id && id !== message.author.id) {
                const member = await message.guild.members.fetch(id).catch(() => null);
                if (member && !member.user.bot) {
                    memberOverwrites.push(member.id);
                }
            }
        }
        if (memberOverwrites.length === 1) {
            return memberOverwrites[0];
        }
    } catch (e) {
        // ignore
    }

    return null;
}

/**
 * Xử lý lệnh !rank
 */
async function handleRankCommand(message) {
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) {
        return message.reply({
            content: '⚠️ Cú pháp: `!rank [-]<số tiền>` (Ví dụ: `!rank 100k` hoặc `!rank -50k`)',
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
    }

    // 1. Kiểm tra dấu trừ và lấy số tiền
    let isSubtract = false;
    let amountStr = '';

    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        // Bỏ qua tag user, role, channel, everyone hoặc ID Discord
        if (p === '@everyone' || p === '@here' || p.startsWith('<@') || p.startsWith('<#') || /^\d{17,20}$/.test(p)) {
            continue;
        }

        if (p === '-') {
            isSubtract = true;
            continue;
        }

        if (p.startsWith('-')) {
            isSubtract = true;
            amountStr = p.slice(1);
            break;
        }

        if (p.endsWith('-')) {
            isSubtract = true;
            amountStr = p.slice(0, -1);
            break;
        }

        amountStr = p;
        break;
    }

    // Nếu còn có tham số '-' ở bất kỳ đâu trong lệnh
    if (parts.some(p => p === '-')) {
        isSubtract = true;
    }

    if (!amountStr) {
        return message.reply({
            content: '❌ Vui lòng nhập số tiền hợp lệ (Ví dụ: `!rank 100k` hoặc `!rank -50k`).',
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
    }

    const amount = parseAmount(amountStr);
    if (!amount) {
        return message.reply({
            content: '❌ Số tiền không hợp lệ! Ví dụ: `!rank 100k`, `!rank -50k`, `!rank 1m`, `!rank 250.000.000`',
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
    }

    // 2. Tìm ID khách hàng (truyền cả message và parts)
    const targetUserId = await detectCustomerId(message, parts);
    if (!targetUserId) {
        return message.reply({
            content: '⚠️ Không thể tự nhận diện khách hàng trong kênh này (hoặc bạn đang dùng ngoài ticket). Vui lòng tag khách hàng: `!rank [-]<số tiền> @user`',
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
    }

    // 3. Lấy dữ liệu Member từ MongoDB
    let memberData = await Member.findOne({ guildId: message.guild.id, userId: targetUserId });
    if (!memberData) {
        memberData = new Member({
            guildId: message.guild.id,
            userId: targetUserId,
            totalAmount: 0,
            transactions: [],
        });
    }

    const oldAmount = memberData.totalAmount;
    const newAmount = Math.max(0, isSubtract ? oldAmount - amount : oldAmount + amount);

    memberData.totalAmount = newAmount;
    memberData.transactions.push({
        amount: amount,
        type: isSubtract ? 'SUB' : 'ADD',
        staffId: message.author.id,
        channelId: message.channel.id,
        date: new Date(),
    });

    await memberData.save();

    // 4. Cập nhật role rank cho khách hàng (chỉ giữ role cao nhất)
    const targetMember = await message.guild.members.fetch(targetUserId).catch(() => null);
    if (targetMember) {
        await syncMemberRankRole(message.guild, targetMember, newAmount);
    }

    // 5. Kiểm tra nếu có Rank Up (tăng lên mốc mới)
    const oldMilestone = getHighestMilestone(oldAmount);
    const newMilestone = getHighestMilestone(newAmount);

    const isRankUp = !isSubtract && newMilestone && (!oldMilestone || newMilestone.amount > oldMilestone.amount);

    // 6. Xây dựng tin nhắn phản hồi theo đúng mẫu
    const formatNumber = (num) => num.toLocaleString('vi-VN');

    let replyContent = '';
    if (!isSubtract) {
        replyContent = `💰 **Đã cộng ${formatNumber(amount)}đ** / Money ${formatNumber(amount)} added!\n` +
            `💵 **Số tiền đã giao dịch** / Total transacted: **${formatNumber(newAmount)}đ**`;
    } else {
        replyContent = `💸 **Đã trừ ${formatNumber(amount)}đ** / Money ${formatNumber(amount)} deducted!\n` +
            `💵 **Số tiền đã giao dịch** / Total transacted: **${formatNumber(newAmount)}đ**`;
    }

    if (isRankUp) {
        replyContent += `\n\n🎉 **CHÚC MỪNG! / CONGRATULATIONS!**\n` +
            `🏆 Bạn đã đạt mốc **${formatNumber(newMilestone.amount)}đ** và được cấp role!\n` +
            `✨ You reached **${formatNumber(newMilestone.amount)}đ** and got the role!`;
    }

    try {
        await message.channel.send({ content: replyContent });
        // Cập nhật Bảng Xếp Hạng thời gian thực tại kênh Admin
        updateLeaderboardMessage(message.client).catch(() => {});
    } catch (err) {
        logger.error(`[RankManager] Lỗi gửi thông báo rank: ${err.message}`);
    }
}

const SHOP_ADMIN_IDS = (process.env.SHOP_ADMIN_ID || '1053646107785302069,717336894941167646')
    .split(',')
    .map((id) => id.trim());

function checkIsAdmin(user, member, guild) {
    if (guild && guild.ownerId === user.id) return true;
    if (SHOP_ADMIN_IDS.includes(user.id)) return true;
    if (member && member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return false;
}

/**
 * Xử lý lệnh !rankup <rate> <money> [@user]
 */
async function handleRankUpCommand(message) {
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 3) {
        return message.reply({
            content: '⚠️ Cú pháp: `!rankup <rate> <money> [@user]`\nVí dụ: `!rankup 500 500000m` hoặc `!rankup 500 1b`',
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
    }

    // 1. Phân tích rate
    const rawRate = parts[1].replace(/,/g, '').replace(/đ$/i, '').trim();
    const rateVal = parseFloat(rawRate);
    if (isNaN(rateVal) || rateVal <= 0) {
        return message.reply({
            content: '❌ Tỉ lệ `rate` không hợp lệ! Ví dụ: `500` hoặc `500đ`.',
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
    }

    // 2. Phân tích số lượng money
    const rawMoney = parts[2].replace(/,/g, '').trim();
    const moneyMatch = rawMoney.match(/^([0-9]+(?:\.[0-9]+)?)([mb]?)$/i);
    if (!moneyMatch) {
        return message.reply({
            content: '❌ Số tiền `money` không hợp lệ! Ví dụ: `500000`, `500000m`, `1b`.',
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
    }

    const numVal = parseFloat(moneyMatch[1]);
    const suffix = (moneyMatch[2] || 'm').toLowerCase();
    const mAmount = suffix === 'b' ? numVal * 1000 : numVal;
    const totalVnd = Math.round(rateVal * mAmount);

    const qtyDisplay = `${numVal}${suffix}`;

    // 3. Tìm khách hàng
    const targetUserId = await detectCustomerId(message, parts);
    if (!targetUserId) {
        return message.reply({
            content: '⚠️ Không thể tự nhận diện khách hàng trong kênh này. Vui lòng tag khách hàng: `!rankup <rate> <money> @user`',
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
    }

    // 4. Tạo Embed màu hồng cánh sen (#E0218A)
    const embed = new EmbedBuilder()
        .setColor(0xE0218A) // Màu hồng cánh sen
        .setTitle('NEM MARKET')
        .setDescription(
            `**Rate:**\n${rateVal.toLocaleString('vi-VN')}đ\n\n` +
            `**Qty:**\n${qtyDisplay} = ${totalVnd.toLocaleString('vi-VN')}đ`
        );

    // 5. Tạo 3 nút bấm (Rankup, Balance, History)
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`rkup_exec_${targetUserId}_${totalVnd}`)
            .setLabel('Rankup')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('rkup_bal')
            .setLabel('Balance')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('rkup_hist')
            .setLabel('History')
            .setStyle(ButtonStyle.Secondary)
    );

    try {
        await message.channel.send({ embeds: [embed], components: [row] });
    } catch (err) {
        logger.error(`[RankUp] Lỗi gửi tin nhắn !rankup: ${err.message}`);
    }
}

/**
 * Xử lý sự kiện nút bấm Rankup, Balance, History
 */
async function handleRankUpButton(interaction) {
    if (!interaction.isButton()) return false;
    const { customId } = interaction;

    if (!customId.startsWith('rkup_')) return false;

    // 1. Xử lý nút Balance (xem số tiền của chính người bấm)
    if (customId === 'rkup_bal') {
        const memberData = await Member.findOne({
            guildId: interaction.guildId,
            userId: interaction.user.id,
        });
        const total = memberData ? memberData.totalAmount : 0;
        const rank = getHighestMilestone(total);
        const rankStr = rank ? `${rank.name}` : 'Chưa có rank';

        await interaction.reply({
            content: `💵 **Số tiền đã giao dịch của bạn:** **${total.toLocaleString('vi-VN')}đ**\n` +
                     `🏆 **Hạng hiện tại:** **${rankStr}**`,
            ephemeral: true,
        });
        return true;
    }

    // 2. Xử lý nút History (xem lịch sử giao dịch của chính người bấm)
    if (customId === 'rkup_hist') {
        const memberData = await Member.findOne({
            guildId: interaction.guildId,
            userId: interaction.user.id,
        });
        const txs = memberData?.transactions || [];
        if (txs.length === 0) {
            await interaction.reply({
                content: '📭 Bạn chưa có lịch sử giao dịch nào được ghi nhận.',
                ephemeral: true,
            });
            return true;
        }

        const last5 = [...txs].reverse().slice(0, 5);
        const lines = last5.map(t => {
            const icon = t.type === 'SUB' ? '🔴 -' : '🟢 +';
            const dateStr = t.date ? new Date(t.date).toLocaleDateString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '';
            return `• ${icon}${t.amount.toLocaleString('vi-VN')}đ (${dateStr})`;
        });

        await interaction.reply({
            content: `📜 **Lịch sử 5 giao dịch gần đây của bạn:**\n${lines.join('\n')}`,
            ephemeral: true,
        });
        return true;
    }

    // 3. Xử lý nút Rankup (Chỉ dành cho Admin)
    if (customId.startsWith('rkup_exec_')) {
        const isAdmin = checkIsAdmin(interaction.user, interaction.member, interaction.guild);
        if (!isAdmin) {
            await interaction.reply({
                content: '❌ Chỉ Admin mới có quyền thực hiện Rankup!',
                ephemeral: true,
            });
            return true;
        }

        const parts = customId.split('_');
        const targetUserId = parts[2];
        const amount = parseInt(parts[3], 10);

        if (!targetUserId || isNaN(amount) || amount <= 0) {
            await interaction.reply({
                content: '❌ Dữ liệu đơn không hợp lệ.',
                ephemeral: true,
            });
            return true;
        }

        await interaction.deferUpdate();

        // Cập nhật database Member
        let memberData = await Member.findOne({ guildId: interaction.guildId, userId: targetUserId });
        if (!memberData) {
            memberData = new Member({
                guildId: interaction.guildId,
                userId: targetUserId,
                totalAmount: 0,
                transactions: [],
            });
        }

        const oldAmount = memberData.totalAmount;
        const newAmount = oldAmount + amount;

        memberData.totalAmount = newAmount;
        memberData.transactions.push({
            amount: amount,
            type: 'ADD',
            staffId: interaction.user.id,
            channelId: interaction.channel.id,
            date: new Date(),
        });

        await memberData.save();

        // Đồng bộ Role (chỉ giữ role cao nhất)
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
        if (targetMember) {
            await syncMemberRankRole(interaction.guild, targetMember, newAmount);
        }

        // Kiểm tra Rank Up mốc mới
        const oldMilestone = getHighestMilestone(oldAmount);
        const newMilestone = getHighestMilestone(newAmount);
        const isRankUp = newMilestone && (!oldMilestone || newMilestone.amount > oldMilestone.amount);

        // Vô hiệu hóa nút Rankup trên tin nhắn gốc
        const updatedRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('rkup_done')
                .setLabel('✅ Đã Rankup')
                .setStyle(ButtonStyle.Success)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId('rkup_bal')
                .setLabel('Balance')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('rkup_hist')
                .setLabel('History')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({ components: [updatedRow] }).catch(() => {});

        // Gửi thông báo trong kênh
        const formatNumber = (num) => num.toLocaleString('vi-VN');
        let replyContent = `💰 **Đã cộng ${formatNumber(amount)}đ** / Money ${formatNumber(amount)} added!\n` +
            `💵 **Số tiền đã giao dịch** / Total transacted: **${formatNumber(newAmount)}đ**`;

        if (isRankUp) {
            replyContent += `\n\n🎉 **CHÚC MỪNG! / CONGRATULATIONS!**\n` +
                `🏆 Bạn đã đạt mốc **${formatNumber(newMilestone.amount)}đ** và được cấp role!\n` +
                `✨ You reached **${formatNumber(newMilestone.amount)}đ** and got the role!`;
        }

        await interaction.channel.send({ content: replyContent }).catch(() => {});

        // Cập nhật Bảng Xếp Hạng thời gian thực tại kênh Admin
        updateLeaderboardMessage(interaction.client).catch(() => {});

        return true;
    }

    return false;
}

module.exports = {
    handleRankCommand,
    handleRankUpCommand,
    handleRankUpButton,
    parseAmount,
    detectCustomerId,
};


