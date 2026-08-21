'use strict';

const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const QuestProfile = require('../models/questProfile');
const logger = require('./logger');
const { questSessionManager } = require('../services/questSessionManager');
const { buildQuestStatus, buildQuestHelp } = require('./questEmbeds');

const QUEST_PREFIX = 'quest:';

async function respond(interaction, payload) {
    if (interaction.deferred || interaction.replied) {
        const { ephemeral, ...editPayload } = payload;
        return interaction.editReply(editPayload);
    }
    return interaction.reply(payload);
}

function errorMessage(error) {
    switch (error?.code) {
        case 'QUEST_FEATURE_DISABLED':
            return '⚠️ Tính năng Quest hiện đang tắt.';
        case 'QUEST_PROVIDER_UNAVAILABLE':
            return '⚠️ Chưa có Quest API/OAuth2 provider chính thức, nên Start Session đang bị khóa.';
        case 'QUEST_ALREADY_RUNNING':
            return '⚠️ Bạn đã có một session Quest đang chạy.';
        default:
            return '❌ Đã xảy ra lỗi khi xử lý Quest. Vui lòng thử lại sau.';
    }
}

async function handleQuestInteraction(interaction) {
    if (interaction.isModalSubmit() && interaction.customId === 'quest_token_modal') {
        const token = interaction.fields.getTextInputValue('discordToken');
        
        await interaction.deferReply({ ephemeral: true });
        try {
            // Validate token using provider
            const isValid = await questSessionManager.provider.validateToken(token);
            if (!isValid) {
                return interaction.editReply({ content: '❌ Token không hợp lệ. Vui lòng kiểm tra lại.' });
            }

            const context = {
                guildId: interaction.guildId,
                requesterId: interaction.user.id,
                displayName: interaction.user.displayName || interaction.user.username,
            };

            await QuestProfile.findOneAndUpdate(
                { guildId: context.guildId, requesterId: context.requesterId },
                { $set: { discordToken: token, displayName: context.displayName } },
                { upsert: true }
            );

            const session = await questSessionManager.start(context);
            return interaction.editReply({ content: `✅ Đã lưu token và bắt đầu session \`${session._id}\`.` });
        } catch (error) {
            logger.error(`[Quest] Modal submit error: ${error.stack || error}`);
            return interaction.editReply({ content: errorMessage(error) });
        }
    }

    if (!interaction.isButton() || !interaction.customId.startsWith(QUEST_PREFIX)) return false;

    if (!interaction.guildId) {
        await interaction.reply({ content: '❌ Quest chỉ hoạt động trong server.', ephemeral: true });
        return true;
    }

    const context = {
        guildId: interaction.guildId,
        requesterId: interaction.user.id,
        displayName: interaction.user.displayName || interaction.user.username,
    };

    try {
        switch (interaction.customId) {
            case 'quest:start': {
                const profile = await QuestProfile.findOne({ guildId: context.guildId, requesterId: context.requesterId });
                
                if (!profile || !profile.discordToken) {
                    const modal = new ModalBuilder()
                        .setCustomId('quest_token_modal')
                        .setTitle('Nhập Discord Token');

                    const tokenInput = new TextInputBuilder()
                        .setCustomId('discordToken')
                        .setLabel('Vui lòng nhập Token Discord của bạn')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Nhập token tại đây...')
                        .setRequired(true);

                    modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
                    await interaction.showModal(modal);
                    return true;
                }

                await interaction.deferReply({ ephemeral: true });
                const isValid = await questSessionManager.provider.validateToken(profile.discordToken);
                if (!isValid) {
                    await QuestProfile.updateOne({ _id: profile._id }, { $unset: { discordToken: 1 } });
                    return interaction.editReply({ content: '❌ Token của bạn đã hết hạn hoặc không hợp lệ. Vui lòng bấm Bắt đầu lại để nhập token mới.' });
                }

                const session = await questSessionManager.start(context);
                await interaction.editReply({ content: `✅ Đã bắt đầu session \`${session._id}\`.` });
                break;
            }
            case 'quest:stat': {
                await interaction.deferReply({ ephemeral: true });
                const session = await questSessionManager.getStatus(context);
                await interaction.editReply({ embeds: [buildQuestStatus(session)] });
                break;
            }
            case 'quest:stop': {
                await interaction.deferReply({ ephemeral: true });
                const stopped = await questSessionManager.stop(context);
                await interaction.editReply({
                    content: stopped
                        ? '✅ Đã gửi yêu cầu dừng session Quest.'
                        : '⚠️ Bạn không có session Quest nào đang chạy.',
                });
                break;
            }
            case 'quest:help':
                await interaction.reply({ embeds: [buildQuestHelp()], ephemeral: true });
                break;
            default:
                await interaction.reply({ content: '❌ Thao tác Quest không hợp lệ.', ephemeral: true });
        }
    } catch (error) {
        if (!error?.code?.startsWith('QUEST_')) {
            logger.error(`[Quest] Interaction ${interaction.customId}: ${error.stack || error}`);
        }
        await respond(interaction, { content: errorMessage(error), embeds: [], ephemeral: true });
    }

    return true;
}

module.exports = { handleQuestInteraction };
