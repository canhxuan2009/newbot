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

module.exports = {
    handleRankCommand,
    parseAmount,
    detectCustomerId,
};

