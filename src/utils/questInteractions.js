'use strict';

const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const QuestProfile = require('../models/questProfile');
const logger = require('./logger');
const { questSessionManager } = require('../services/questSessionManager');
const { buildQuestStatus, buildQuestHelp, buildWayEmbed, buildMobileGuideEmbed, buildHypeSquadEmbed } = require('./questEmbeds');

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

    const isQuestButton = interaction.isButton() && interaction.customId.startsWith(QUEST_PREFIX);
    const isQuestMenu = interaction.isStringSelectMenu() && interaction.customId === 'menu_select';
    if (!isQuestButton && !isQuestMenu) return false;

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
        let action = interaction.customId;
        if (isQuestMenu) {
            const choice = interaction.values[0];
            const actionMap = {
                quest: 'quest:start',
                change: 'quest:change',
                stat: 'quest:stat',
                stop: 'quest:stop',
                hypersquad: 'quest:hypersquad',
                way: 'quest:way',
            };
            action = actionMap[choice] || choice;

            // Optional: reset dropdown visually
            try {
                if (interaction.message) {
                    const row = ActionRowBuilder.from(interaction.message.components[0]);
                    await interaction.message.edit({ components: [row] });
                }
            } catch (err) { /* ignore */ }
        }

        switch (action) {
            case 'quest:start': {
                const profile = await QuestProfile.findOne({ guildId: context.guildId, requesterId: context.requesterId });
                
                if (!profile || !profile.discordToken) {
                    const modal = new ModalBuilder()
                        .setCustomId('quest_token_modal')
                        .setTitle('🔑 Nhập Discord Token');

                    const tokenInput = new TextInputBuilder()
                        .setCustomId('discordToken')
                        .setLabel('Discord Token')
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder('Nhập token tại đây...')
                        .setMinLength(50)
                        .setMaxLength(200)
                        .setRequired(true);

                    modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
                    await interaction.showModal(modal);
                    return true;
                }

                await interaction.deferReply({ ephemeral: true });
                const isValid = await questSessionManager.provider.validateToken(profile.discordToken);
                if (!isValid) {
                    await QuestProfile.updateOne({ _id: profile._id }, { $unset: { discordToken: 1 } });
                    return interaction.editReply({ content: '❌ Token của bạn đã hết hạn hoặc không hợp lệ. Vui lòng chọn Bắt đầu lại để nhập token mới.' });
                }

                const session = await questSessionManager.start(context);
                await interaction.editReply({ content: `✅ Đã bắt đầu session \`${session._id}\`.` });
                break;
            }
            case 'quest:change': {
                const modal = new ModalBuilder()
                    .setCustomId('quest_token_modal')
                    .setTitle('🔑 Đổi Token Discord');

                const tokenInput = new TextInputBuilder()
                    .setCustomId('discordToken')
                    .setLabel('Discord Token')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Nhập token mới tại đây...')
                    .setMinLength(50)
                    .setMaxLength(200)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
                await interaction.showModal(modal);
                return true;
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
            case 'quest:way': {
                const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('Hướng dẫn PC')
                        .setStyle(ButtonStyle.Link)
                        .setURL('https://www.youtube.com/watch?v=sPKJOYXQdPw')
                        .setEmoji('💻'),
                    new ButtonBuilder()
                        .setCustomId('quest:mobile_guide')
                        .setLabel('Hướng dẫn Mobile')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('📱')
                );
                await interaction.reply({ embeds: [buildWayEmbed()], components: [row], ephemeral: true });
                break;
            }
            case 'quest:mobile_guide': {
                const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('▶ Xem video Mobile')
                        .setStyle(ButtonStyle.Link)
                        .setURL('https://www.youtube.com/watch?v=mJKpmX6w9Z0')
                        .setEmoji('📺'),
                    new ButtonBuilder()
                        .setCustomId('quest:mobile_script')
                        .setLabel('📋 Sao chép Script')
                        .setStyle(ButtonStyle.Primary)
                );
                await interaction.reply({ embeds: [buildMobileGuideEmbed()], components: [row], ephemeral: true });
                break;
            }
            case 'quest:mobile_script': {
                const scriptText = 'tự edit';
                await interaction.reply({ 
                    content: `**📋 Script lấy token — copy toàn bộ:**\n\`\`\`\n${scriptText}\n\`\`\`\n**Cách dùng:**\n1. Copy đoạn script trên\n2. Mở Chrome → vào Discord Web\n3. Dán vào thanh địa chỉ → Enter\n4. Token sẽ tự copy vào clipboard\n\n⚠️ **Bắt buộc dùng Chrome** nếu dùng Android`, 
                    ephemeral: true 
                });
                break;
            }
            case 'quest:hypersquad':
                await interaction.reply({ embeds: [buildHypeSquadEmbed(context.displayName)], ephemeral: true });
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
