'use strict';

const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const QuestProfile = require('../models/questProfile');
const logger = require('./logger');
const { questSessionManager } = require('../services/questSessionManager');
const { buildQuestControlPanel, buildQuestStatus, buildWayEmbed, buildMobileGuideEmbed, buildHypeSquadEmbed } = require('./questEmbeds');
const { getTaskType, getSecondsNeeded, getSecondsDone, isCompletable, isCompleted } = require('../services/questParser');

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
            

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('quest:change')
                    .setLabel('🔄 Change Token')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('quest:action_start')
                    .setLabel('▶ Start Session')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🚀')
            );
            const avatarUrl = interaction.user.displayAvatarURL({ dynamic: true });
            const isRunning = await questSessionManager.getStatus(context).then(s => s != null && s.status === 'running');
            return interaction.editReply({ 
                embeds: [buildQuestControlPanel(context.displayName, avatarUrl, isRunning), buildQuestStatus(session)], 
                components: [row] 
            });
        } catch (error) {
            logger.error(`[Quest] Modal submit error: ${error.stack || error}`);
            return interaction.editReply({ content: errorMessage(error) });
        }
    }
    
    if (interaction.isModalSubmit() && interaction.customId === 'quest_hs_modal') {
        const token = interaction.fields.getTextInputValue('hsToken');
        await interaction.deferReply({ ephemeral: true });
        try {
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


            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('quest:hs_1')
                    .setLabel('🦁 Bravery')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('quest:hs_2')
                    .setLabel('💡 Brilliance')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('quest:hs_3')
                    .setLabel('⚖️ Balance')
                    .setStyle(ButtonStyle.Primary)
            );

            return interaction.editReply({ embeds: [buildHypeSquadEmbed(context.displayName)], components: [row] });
        } catch (error) {
            logger.error(`[Quest] HS Modal submit error: ${error.stack || error}`);
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


                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('quest:change')
                        .setLabel('🔄 Change Token')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('quest:action_start')
                        .setLabel('▶ Start Session')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🚀')
                );

                const avatarUrl = interaction.user.displayAvatarURL({ dynamic: true });
                const isRunning = await questSessionManager.getStatus(context).then(s => s != null && s.status === 'running');
                await interaction.editReply({ 
                    embeds: [buildQuestControlPanel(context.displayName, avatarUrl, isRunning)], 
                    components: [row] 
                });
                break;
            }
            case 'quest:action_start': {
                await interaction.deferReply({ ephemeral: true });
                const profile = await QuestProfile.findOne({ guildId: context.guildId, requesterId: context.requesterId });
                if (!profile || !profile.discordToken) {
                    return interaction.editReply({ content: '❌ Bạn chưa nhập token. Vui lòng quay lại menu và chọn Quest.' });
                }

                const isValid = await questSessionManager.provider.validateToken(profile.discordToken);
                if (!isValid) {
                    await QuestProfile.updateOne({ _id: profile._id }, { $unset: { discordToken: 1 } });

                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ Token không còn hoạt động')
                        .setDescription('❌ Token của bạn đã hết hạn hoặc bị thu hồi.\n\nNhấn **🔄 Change Token** để nhập token mới.')
                        .setColor(0xFF5555)
                        .setFooter({ text: `Nem Quest Bot • ${context.displayName}` });
                    return interaction.editReply({ embeds: [embed] });
                }

                const quests = await questSessionManager.provider.listQuests({ profile });
                const actionable = quests.filter(q => isCompletable(q) && !isCompleted(q));

                if (actionable.length === 0) {

                    const embed = new EmbedBuilder()
                        .setTitle('🌸 Không có nhiệm vụ nào')
                        .setDescription('✅ Tất cả Discord Quest đã hoàn thành rồi!\n\nQuay lại khi Discord phát hành quest mới nhé 🎯')
                        .setColor(0x57F287)
                        .setFooter({ text: `💙 Nem Quest Bot • ${context.displayName}` });
                    return interaction.editReply({ embeds: [embed] });
                }

                const currentSession = await questSessionManager.getStatus(context);
                if (currentSession && currentSession.status === 'running') {
                    return interaction.editReply({ content: `⚠️ \`${context.displayName}\` đang chạy rồi! Dùng nút Stop trong menu để dừng.` });
                }

                await questSessionManager.start(context);
                

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('quest:change')
                        .setLabel('🔄 Change Token')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('quest:action_start')
                        .setLabel('▶ Start Session')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🚀')
                        .setDisabled(true)
                );

                const avatarUrl = interaction.user.displayAvatarURL({ dynamic: true });
                await interaction.editReply({ 
                    embeds: [buildQuestControlPanel(context.displayName, avatarUrl, true), buildQuestStatus(session)], 
                    components: [row] 
                });
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
            case 'quest:hypersquad': {
                const profile = await QuestProfile.findOne({ guildId: context.guildId, requesterId: context.requesterId });
                
                if (!profile || !profile.discordToken) {
                    const modal = new ModalBuilder()
                        .setCustomId('quest_hs_modal')
                        .setTitle('🏆 HypeSquad — Nhập Token');

                    const tokenInput = new TextInputBuilder()
                        .setCustomId('hsToken')
                        .setLabel('Discord Token')
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder('Nhập token của bạn tại đây...')
                        .setMinLength(50)
                        .setMaxLength(200)
                        .setRequired(true);

                    modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
                    await interaction.showModal(modal);
                    return true;
                }


                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('quest:hs_1')
                        .setLabel('🦁 Bravery')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('quest:hs_2')
                        .setLabel('💡 Brilliance')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('quest:hs_3')
                        .setLabel('⚖️ Balance')
                        .setStyle(ButtonStyle.Primary)
                );

                await interaction.reply({ embeds: [buildHypeSquadEmbed(context.displayName)], components: [row], ephemeral: true });
                break;
            }
            case 'quest:hs_1':
            case 'quest:hs_2':
            case 'quest:hs_3': {
                await interaction.deferReply({ ephemeral: true });
                const profile = await QuestProfile.findOne({ guildId: context.guildId, requesterId: context.requesterId });
                if (!profile || !profile.discordToken) {
                    return interaction.editReply({ content: '❌ Token không tồn tại.' });
                }

                const houseMap = {
                    'quest:hs_1': { id: 1, name: 'House of Bravery', emoji: '🦁', color: 0x9B59B6 },
                    'quest:hs_2': { id: 2, name: 'House of Brilliance', emoji: '💡', color: 0xF1C40F },
                    'quest:hs_3': { id: 3, name: 'House of Balance', emoji: '⚖️', color: 0x2ECC71 }
                };

                const house = houseMap[action];
                const res = await questSessionManager.provider.changeHypeSquad({ token: profile.discordToken, houseId: house.id });
                

                if (res.success) {
                    const embed = new EmbedBuilder()
                        .setTitle(`${house.emoji} HypeSquad ${house.name}`)
                        .setDescription(`✅ **Badge đã được đổi thành công!**\n\nTài khoản của bạn hiện là **${house.name}**\n👤 Người dùng: <@${interaction.user.id}>`)
                        .setColor(house.color)
                        .setFooter({ text: '💙 Nem Quest • HypeSquad' });

                    const channelId = process.env.QUEST_CHANNEL_ID?.trim();
                    if (channelId) {
                        try {
                            const channel = await interaction.client.channels.fetch(channelId);
                            await channel.send({ embeds: [embed] });
                        } catch (e) {
                            await interaction.editReply({ embeds: [embed] });
                        }
                    } else {
                        await interaction.editReply({ embeds: [embed] });
                    }
                    
                    if (interaction.message && interaction.message.deletable) {
                        try { await interaction.message.delete(); } catch(e) {}
                    }
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: '✅ Xong.', ephemeral: true });
                    }
                } else {
                    const embed = new EmbedBuilder()
                        .setTitle(`❌ Thất bại — ${house.emoji} ${house.name}`)
                        .setDescription(`**${res.msg}**\n\nKiểm tra lại token và thử lại.`)
                        .setColor(0xFF0000)
                        .setFooter({ text: '💙 Nem Quest • HypeSquad' });
                    await interaction.editReply({ embeds: [embed] });
                }
                break;
            }
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
