'use strict';

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require('discord.js');
const { hasPermission } = require('../utils/permissions');
const { questSessionManager } = require('../services/questSessionManager');
const { buildQuestPanel } = require('../utils/questEmbeds');
const Setting = require('../models/setting');

function buildQuestComponents() {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('menu_select')
        .setPlaceholder('Chọn danh mục...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Quest')
                .setValue('quest')
                .setDescription('Thêm token & bắt đầu auto quest')
                .setEmoji('🚀'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Change')
                .setValue('change')
                .setDescription('Đổi token Discord của bạn')
                .setEmoji('🔄'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Stat')
                .setValue('stat')
                .setDescription('Xem tiến độ quest thời gian thực')
                .setEmoji('📊'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Stop')
                .setValue('stop')
                .setDescription('Dừng auto quest của tài khoản')
                .setEmoji('⏹️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Hypersquad')
                .setValue('hypersquad')
                .setDescription('Đổi HypeSquad Badge Discord')
                .setEmoji('🏆'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Way')
                .setValue('way')
                .setDescription('Hướng dẫn lấy Discord Token')
                .setEmoji('🔑')
        );

    return [new ActionRowBuilder().addComponents(selectMenu)];
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

        const { AttachmentBuilder } = require('discord.js');
        const path = require('path');
        const gifPath = path.join(__dirname, '..', '..', 'assets', 'menu.gif');
        const attachment = new AttachmentBuilder(gifPath, { name: 'menu.gif' });

        const menuMessage = await channel.send({
            embeds: [buildQuestPanel()],
            components: buildQuestComponents(),
            files: [attachment]
        });

        await Setting.findOneAndUpdate(
            { key: settingKey },
            { $set: { value: { channelId: channel.id, messageId: menuMessage.id } } },
            { upsert: true, new: true, runValidators: true },
        );

        return interaction.editReply(`✅ Đã đăng bảng Quest tại ${channel}.`);
    },
};
