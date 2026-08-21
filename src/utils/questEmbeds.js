'use strict';

const { EmbedBuilder } = require('discord.js');

const COLORS = Object.freeze({
    primary: 0x00BFFF,
    success: 0x57F287,
    warning: 0xFEE75C,
    error: 0xED4245,
    muted: 0x5865F2,
});

const STATUS_LABELS = Object.freeze({
    starting: 'Đang khởi động',
    running: 'Đang theo dõi',
    stopping: 'Đang dừng',
    completed: 'Hoàn thành',
    stopped: 'Đã dừng',
    failed: 'Thất bại',
    interrupted: 'Bị gián đoạn',
});

function progressBar(done, total, width = 10) {
    const safeDone = Number.isFinite(done) ? done : 0;
    const safeTotal = Number.isFinite(total) ? total : 0;
    if (safeTotal <= 0) return '`░░░░░░░░░░` 0%';

    const ratio = Math.max(0, Math.min(safeDone / safeTotal, 1));
    const filled = Math.floor(ratio * width);
    const percent = Math.round(ratio * 100);
    return `\`${'█'.repeat(filled)}${'░'.repeat(width - filled)}\` ${percent}%`;
}

function buildQuestPanel({ available = false } = {}) {
    return new EmbedBuilder()
        .setColor(available ? COLORS.primary : COLORS.warning)
        .setTitle('🌸 Quest Assistant')
        .setDescription('Theo dõi trạng thái Quest bằng kết nối Discord được cấp quyền chính thức.')
        .addFields(
            {
                name: '▶ Bắt đầu',
                value: available
                    ? 'Tạo một session theo dõi Quest cho tài khoản của bạn.'
                    : 'Đang khóa: chưa có Quest API/OAuth2 provider chính thức.',
                inline: false,
            },
            { name: '📊 Trạng thái', value: 'Xem session gần nhất và snapshot tiến độ.', inline: true },
            { name: '⏹ Dừng', value: 'Dừng session hiện tại của chính bạn.', inline: true },
        )
        .setFooter({ text: 'Không nhập hoặc lưu Discord user token' });
}

function buildQuestStatus(session) {
    if (!session) {
        return new EmbedBuilder()
            .setColor(COLORS.muted)
            .setTitle('📊 Trạng thái Quest')
            .setDescription('Bạn chưa có session Quest nào.');
    }

    const quests = Array.isArray(session.quests) ? session.quests : [];
    const done = quests.filter((quest) => quest.status === 'done').length;
    const active = quests.filter((quest) => quest.status === 'running').length;
    const waiting = quests.filter((quest) => quest.status === 'waiting').length;
    const color = session.status === 'completed'
        ? COLORS.success
        : session.status === 'failed'
            ? COLORS.error
            : COLORS.primary;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('📊 Trạng thái Quest')
        .addFields(
            { name: 'Session', value: `**${STATUS_LABELS[session.status] || session.status}**`, inline: true },
            { name: 'Lần quét', value: String(session.pollCount || 0), inline: true },
            { name: 'Tổng quan', value: `⚡ ${active} · ⏳ ${waiting} · ✅ ${done}`, inline: true },
        );

    const lines = quests.slice(0, 10).map((quest) => {
        if (quest.status === 'done') return `✅ **${quest.name}**`;
        if (quest.status === 'expired') return `⌛ **${quest.name}** · hết hạn`;
        if (quest.status === 'unsupported') return `➖ **${quest.name}** · không hỗ trợ`;
        if (quest.status === 'running') {
            return `⚡ **${quest.name}**\n${progressBar(quest.secondsDone, quest.secondsNeeded)}`;
        }
        return `⏳ **${quest.name}** · chờ xử lý`;
    });

    if (lines.length > 0) {
        embed.addFields({ name: 'Nhiệm vụ', value: lines.join('\n').slice(0, 1024), inline: false });
    }
    if (session.lastError) {
        embed.addFields({ name: 'Lỗi gần nhất', value: String(session.lastError).slice(0, 1024), inline: false });
    }
    if (session.updatedAt) embed.setTimestamp(new Date(session.updatedAt));
    return embed;
}

function buildQuestHelp() {
    return new EmbedBuilder()
        .setColor(COLORS.muted)
        .setTitle('❔ Hướng dẫn Quest Assistant')
        .setDescription([
            '• **Bắt đầu:** mở một session theo dõi bằng provider được Discord cấp quyền.',
            '• **Trạng thái:** xem tiến độ gần nhất đã lưu trong MongoDB.',
            '• **Dừng:** hủy session của chính bạn bằng cơ chế abort an toàn.',
            '',
            'Bot không yêu cầu mật khẩu hoặc Discord user token.',
        ].join('\n'));
}

module.exports = { buildQuestPanel, buildQuestStatus, buildQuestHelp, progressBar };
