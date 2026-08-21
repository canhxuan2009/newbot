'use strict';

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const { hasPermission } = require('../utils/permissions');
const { questSessionManager } = require('../services/questSessionManager');
const { buildQuestPanel } = require('../utils/questEmbeds');
const Setting = require('../models/setting');

function buildQuestComponents(available) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('quest:start')
            .setLabel('Bắt đầu')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!available),
        new ButtonBuilder()
            .setCustomId('quest:stat')
            .setLabel('Trạng thái')
            .setEmoji('📊')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('quest:stop')
            .setLabel('Dừng')
            .setEmoji('⏹️')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('quest:help')
            .setLabel('Hướng dẫn')
            .setEmoji('❔')
            .setStyle(ButtonStyle.Secondary),
    )];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('menuquest')
        .setDescription('Đăng bảng điều khiển Quest Assistant'),

    async execute(interaction) {
        if (!interaction.guildId) {
            return interaction.reply({ content: '❌ Lệnh này chỉ dùng trong server.', ephemeral: true });
        }

        if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({
                content: '❌ Bạn cần quyền Quản lý máy chủ để đăng bảng Quest.',
                ephemeral: true,
            });
        }

        await interaction.deferReply({ ephemeral: true });
        const available = questSessionManager.isAvailable();
        const configuredChannelId = process.env.QUEST_CHANNEL_ID?.trim();
        let channel = interaction.channel;

        if (configuredChannelId) {
            try {
                channel = await interaction.client.channels.fetch(configuredChannelId);
            } catch {
                return interaction.editReply(`❌ Không tìm thấy QUEST_CHANNEL_ID=${configuredChannelId}.`);
            }
        }

        if (!channel?.isTextBased() || typeof channel.send !== 'function') {
            return interaction.editReply('❌ Kênh Quest không hỗ trợ gửi tin nhắn.');
        }

        const settingKey = `quest_menu_message:${interaction.guildId}`;
        const previous = await Setting.findOne({ key: settingKey }).lean();
        if (previous?.value?.channelId && previous?.value?.messageId) {
            try {
                const previousChannel = await interaction.client.channels.fetch(previous.value.channelId);
                const previousMessage = await previousChannel?.messages?.fetch(previous.value.messageId);
                await previousMessage?.delete();
            } catch {
                // Missing channel/message or missing Manage Messages: post the new panel anyway.
            }
        }

        const menuMessage = await channel.send({
            embeds: [buildQuestPanel({ available })],
            components: buildQuestComponents(available),
        });

        await Setting.findOneAndUpdate(
            { key: settingKey },
            { $set: { value: { channelId: channel.id, messageId: menuMessage.id } } },
            { upsert: true, new: true, runValidators: true },
        );

        const providerNote = available
            ? ''
            : '\n⚠️ Nút Bắt đầu đang khóa vì chưa có provider API chính thức.';
        return interaction.editReply(`✅ Đã đăng bảng Quest tại ${channel}.${providerNote}`);
    },
};
