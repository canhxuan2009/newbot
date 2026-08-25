const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('./questDb');
const { workerStart, workerStop, workerGet, workerGetAll, fetchCompletableActionable } = require('./questWorker');

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const BLUE = 0x00BFFF;
const MOBILE_TOKEN_SCRIPT = "nem quest";

const HYPESQUAD_HOUSES = {
    "1": { name: "Bravery", emoji: "🦁", color: 0xE77035 },
    "2": { name: "Brilliance", emoji: "💡", color: 0xF37B68 },
    "3": { name: "Balance", emoji: "⚖️", color: 0x45B384 },
};

function findGif() {
    const assetsDir = path.join(__dirname, '..', '..', 'assets');
    const gifPath = path.join(assetsDir, 'menu.gif');
    if (fs.existsSync(gifPath)) {
        return gifPath;
    }
    return null;
}

async function changeHypesquad(token, houseId) {
    try {
        const r = await axios.post("https://discord.com/api/v9/hypesquad/online", 
            { house_id: parseInt(houseId) },
            {
                headers: {
                    "Authorization": token,
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9127 Chrome/127.0.6533.99 Electron/32.0.1 Safari/537.36"
                },
                validateStatus: () => true
            }
        );
        if ([200, 204].includes(r.status)) return { ok: true, msg: "Thành công" };
        if (r.status === 401) return { ok: false, msg: "Token không hợp lệ" };
        if (r.status === 429) return { ok: false, msg: `Rate limit — chờ ${r.data?.retry_after}s rồi thử lại` };
        return { ok: false, msg: `Lỗi HTTP ${r.status}` };
    } catch (e) {
        return { ok: false, msg: `Lỗi kết nối: ${e.message}` };
    }
}

function buildQuestPanel(username, user, running) {
    const embed = new EmbedBuilder()
        .setTitle("♟ Nem Quest Bot")
        .setColor(BLUE)
        .addFields({ name: "farm discord quests · session runs `5s`", value: "use `/stat` to check progress", inline: true });
    
    if (user.avatarURL()) embed.setThumbnail(user.avatarURL());
    embed.addFields({ name: "\u200b", value: "\u200b" });
    
    if (running) {
        embed.addFields({ name: "⚡ **session running** — farming quests", value: "use **Stop** in menu to end · check DMs for live status" });
    } else {
        embed.addFields({ name: "♥ **token linked** — ready to start", value: "click start to begin your session" });
    }
    embed.addFields({ name: "want to use a different token?", value: "your token = safe with us" });
    embed.setFooter({ text: `Yêu cầu bởi ${username}` });
    return embed;
}

function buildLiveProgressEmbed(workers) {
    const embed = new EmbedBuilder()
        .setTitle("💙 Tiến độ Quest — Thời gian thực")
        .setColor(BLUE)
        .setTimestamp();
        
    const keys = Object.keys(workers);
    if (!keys.length) {
        embed.setDescription("⚠️ Không có tài khoản nào đang chạy.");
        return embed;
    }
    
    let totalRunning = 0, totalWaiting = 0, totalDone = 0;
    
    for (const uid of keys) {
        const w = workers[uid];
        const questMap = w.questMap || {};
        const questKeys = Object.keys(questMap);
        
        if (!questKeys.length) {
            embed.addFields({ name: `👤 ${w.username}`, value: "🔄 Đang khởi động..." });
            continue;
        }
        
        const done = Object.values(questMap).filter(v => v.status === "done").length;
        const total = questKeys.length;
        totalDone += done;
        
        const lines = [];
        for (const info of Object.values(questMap)) {
            const { name, status, seconds_done: sd = 0, seconds_needed: sn = 0 } = info;
            if (status === "done") continue;
            else if (status === "running") {
                totalRunning++;
                if (sn > 0) {
                    const pct = Math.min(sd / sn, 1.0);
                    const filled = Math.floor(pct * 10);
                    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
                    const tStr = sn >= 60 ? `${Math.floor(sd/60)}/${Math.floor(sn/60)} min` : `${Math.floor(sd)}/${Math.floor(sn)}s`;
                    lines.push(`⚡ **${name}**\n\`${bar}\` ${(pct*100).toFixed(0)}% · ${tStr}`);
                } else {
                    lines.push(`⚡ **${name}** · đang chạy...`);
                }
            } else {
                totalWaiting++;
                lines.push(`⏳ ${name}`);
            }
        }
        
        const header = `✅ ${done}/${total} xong`;
        if (!lines.length) lines.push("🎉 Tất cả quest hoàn thành!");
        embed.addFields({ name: `👤 ${w.username}  —  ${header}`, value: lines.slice(0, 6).join('\n') });
    }
    embed.setFooter({ text: `Nem Quest  •  ⚡${totalRunning} chạy  ⏳${totalWaiting} chờ  ✅${totalDone} xong` });
    return embed;
}

function buildMenuEmbed() {
    const embed = new EmbedBuilder()
        .setTitle("🌸 Nem Quest — MENUQUEST")
        .setDescription("Chọn danh mục bên dưới để xem lệnh chi tiết.")
        .setColor(BLUE)
        .setFooter({ text: "Nem Quest" });
    const gif = findGif();
    if (gif) {
        embed.setImage(`attachment://${path.basename(gif)}`);
    }
    return embed;
}

function buildMenuView() {
    const select = new StringSelectMenuBuilder()
        .setCustomId('menu_select')
        .setPlaceholder('Chọn danh mục...')
        .addOptions([
            { label: 'Quest', value: 'quest', description: 'Thêm token & bắt đầu auto quest', emoji: '🚀' },
            { label: 'Change', value: 'change', description: 'Đổi token Discord của bạn', emoji: '🔄' },
            { label: 'Stat', value: 'stat', description: 'Xem tiến độ quest thời gian thực', emoji: '📊' },
            { label: 'Stop', value: 'stop', description: 'Dừng auto quest của tài khoản', emoji: '⏹️' },
            { label: 'Hypersquad', value: 'hypersquad', description: 'Đổi HypeSquad Badge Discord', emoji: '🏆' },
            { label: 'Way', value: 'way', description: 'Hướng dẫn lấy Discord Token', emoji: '🔑' }
        ]);
    return new ActionRowBuilder().addComponents(select);
}

async function sendMenuToChannel(client, fallbackChannel = null) {
    const doSend = async (ch) => {
        const oldId = db.dbGetSetting("sticky_menu_msg_id");
        if (oldId) {
            try {
                const oldMsg = await ch.messages.fetch(oldId);
                if (oldMsg) await oldMsg.delete();
            } catch(e) {}
        }
        
        const embed = buildMenuEmbed();
        const gif = findGif();
        const payload = { embeds: [embed], components: [buildMenuView()] };
        if (gif) {
            payload.files = [new AttachmentBuilder(gif)];
        }
        const msg = await ch.send(payload);
        db.dbSetSetting("sticky_menu_msg_id", msg.id);
    };

    try {
        let ch = client.channels.cache.get(CHANNEL_ID) || await client.channels.fetch(CHANNEL_ID);
        await doSend(ch);
        return { success: true, err_type: null };
    } catch (e) {
        if (e.code === 50013 || e.code === 50001) {
            if (fallbackChannel) {
                try {
                    await doSend(fallbackChannel);
                    return { success: true, err_type: "fallback" };
                } catch(err) {
                    return { success: false, err_type: "403" };
                }
            }
            return { success: false, err_type: "403" };
        }
        return { success: false, err_type: "other" };
    }
}

async function handleQuestInteraction(interaction, client) {
    if (interaction.isStringSelectMenu() && interaction.customId === 'menu_select') {
        const choice = interaction.values[0];
        const requesterId = interaction.user.id;
        
        if (choice === 'change') {
            const modal = new ModalBuilder().setCustomId('token_modal_change').setTitle('🔑 Đổi Token Discord');
            const ti = new TextInputBuilder().setCustomId('token_input').setLabel('Discord Token').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(50).setMaxLength(200);
            modal.addComponents(new ActionRowBuilder().addComponents(ti));
            await interaction.showModal(modal);
            return;
        }
        if (choice === 'quest') {
            const existing = db.dbGetAccountByRequester(requesterId);
            if (!existing || !existing.token) {
                const modal = new ModalBuilder().setCustomId('token_modal_add').setTitle('🔑 Nhập Discord Token');
                const ti = new TextInputBuilder().setCustomId('token_input').setLabel('Discord Token').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(50).setMaxLength(200);
                modal.addComponents(new ActionRowBuilder().addComponents(ti));
                await interaction.showModal(modal);
                return;
            }
        }
        if (choice === 'hypersquad') {
            const existing = db.dbGetAccountByRequester(requesterId);
            if (!existing || !existing.token) {
                const modal = new ModalBuilder().setCustomId('hs_token_modal').setTitle('🏆 HypeSquad — Nhập Token');
                const ti = new TextInputBuilder().setCustomId('token_input').setLabel('Discord Token').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(50).setMaxLength(200);
                modal.addComponents(new ActionRowBuilder().addComponents(ti));
                await interaction.showModal(modal);
                return;
            }
        }

        await interaction.deferReply({ flags: 64 });

        if (choice === 'quest') {
            const existing = db.dbGetAccountByRequester(requesterId);
            const username = existing.username || "User";
            const userId = existing.user_id;
            const running = !!workerGet(userId);
            
            const embed = buildQuestPanel(username, interaction.user, running);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`change_token_${userId}`).setLabel('🔄 Change Token').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`start_sess_${userId}`).setLabel('▶ Start Session').setStyle(ButtonStyle.Primary).setEmoji('🚀').setDisabled(running)
            );
            if (running) row.components[1].setLabel('✅ Running...');
            
            await interaction.followUp({ embeds: [embed], components: [row] });
        }
        else if (choice === 'hypersquad') {
            const existing = db.dbGetAccountByRequester(requesterId);
            const username = existing.username || "User";
            const embed = new EmbedBuilder()
                .setTitle("🏆 HypeSquad Badge Changer")
                .setDescription(`Tài khoản: **${username}**\nChọn HypeSquad House muốn đổi sang:`)
                .setColor(0x7289DA)
                .addFields(
                    { name: "🦁 Bravery", value: "House of Bravery", inline: true },
                    { name: "💡 Brilliance", value: "House of Brilliance", inline: true },
                    { name: "⚖️ Balance", value: "House of Balance", inline: true }
                )
                .setFooter({text: "💙 Nem Quest • HypeSquad"});
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`hs_1_${existing.user_id}`).setLabel('🦁 Bravery').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`hs_2_${existing.user_id}`).setLabel('💡 Brilliance').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`hs_3_${existing.user_id}`).setLabel('⚖️ Balance').setStyle(ButtonStyle.Primary)
            );
            await interaction.followUp({ embeds: [embed], components: [row] });
        }
        else if (choice === 'stat') {
            const workers = workerGetAll();
            await interaction.followUp({ embeds: [buildLiveProgressEmbed(workers)] });
        }
        else if (choice === 'stop') {
            const acc = db.dbGetAccountByRequester(requesterId);
            const targetUid = acc ? acc.user_id : requesterId;
            const workers = workerGetAll();
            const filtered = Object.keys(workers).filter(uid => uid === targetUid);
            
            if (!filtered.length) {
                await interaction.followUp({ content: "⚠️ Tài khoản của bạn không đang chạy quest." });
            } else {
                const stopped = [];
                for (const uid of filtered) {
                    const w = workers[uid];
                    if (w) {
                        stopped.push(w.username);
                        workerStop(uid);
                        db.dbSetManuallyStopped(uid, true);
                    }
                }
                const embed = new EmbedBuilder()
                    .setTitle("⏹ Đã dừng session")
                    .setDescription(`✅ Đã dừng: **${stopped.join(', ')}**\n*Sẽ không tự chạy lại khi bot restart.*`)
                    .setColor(BLUE);
                
                try {
                    let ch = client.channels.cache.get(CHANNEL_ID) || await client.channels.fetch(CHANNEL_ID);
                    await ch.send({ content: `${interaction.user.toString()}`, embeds: [embed] });
                } catch(e) {
                    await interaction.followUp({ embeds: [embed] });
                }
            }
            await sendMenuToChannel(client);
        }
        else if (choice === 'way') {
            const embed = new EmbedBuilder()
                .setTitle("🔑 Hướng dẫn lấy Discord Token")
                .setDescription("Chọn hướng dẫn phù hợp với thiết bị của bạn.")
                .setColor(BLUE)
                .addFields(
                    { name: "💻 PC / Desktop", value: "Nhấn nút **Hướng dẫn PC**.", inline: true },
                    { name: "📱 Mobile", value: "Nhấn nút **Hướng dẫn Mobile** → script + video.", inline: true },
                    { name: "⚠️ Lưu ý", value: "Token = mật khẩu tài khoản Discord. **Không chia sẻ với ai.**" }
                )
                .setFooter({text: "Nem Quest"});
                
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('💻 Hướng dẫn PC').setStyle(ButtonStyle.Link).setURL("https://www.youtube.com/watch?v=sPKJOYXQdPw").setEmoji('💻'),
                new ButtonBuilder().setCustomId('mobile_guide').setLabel('📱 Hướng dẫn Mobile').setStyle(ButtonStyle.Primary)
            );
            await interaction.followUp({ embeds: [embed], components: [row] });
        }
        
        try { await interaction.message.edit({ components: [buildMenuView()] }); } catch(e) {}
    }
    
    else if (interaction.isModalSubmit()) {
        const requesterId = interaction.user.id;
        
        if (interaction.customId === 'token_modal_add' || interaction.customId === 'token_modal_change') {
            const token = interaction.fields.getTextInputValue('token_input').trim();
            await interaction.deferReply({ flags: 64 });
            const account = await db.dbAddAccount(token, requesterId);
            if (!account) {
                await interaction.followUp({ content: "❌ Token không hợp lệ! Kiểm tra lại token Discord của bạn." });
                return;
            }
            
            if (interaction.customId === 'token_modal_change') {
                workerStop(account.user_id);
            }
            db.dbSetManuallyStopped(account.user_id, false);
            
            const embed = buildQuestPanel(account.username || "User", interaction.user, false);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`change_token_${account.user_id}`).setLabel('🔄 Change Token').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`start_sess_${account.user_id}`).setLabel('▶ Start Session').setStyle(ButtonStyle.Primary).setEmoji('🚀')
            );
            await interaction.followUp({ embeds: [embed], components: [row] });
        }
        else if (interaction.customId === 'hs_token_modal') {
            const token = interaction.fields.getTextInputValue('token_input').trim();
            await interaction.deferReply({ flags: 64 });
            const embed = new EmbedBuilder()
                .setTitle("🏆 HypeSquad Badge Changer")
                .setDescription(`Chọn HypeSquad House muốn đổi sang:`)
                .setColor(0x7289DA)
                .addFields(
                    { name: "🦁 Bravery", value: "House of Bravery", inline: true },
                    { name: "💡 Brilliance", value: "House of Brilliance", inline: true },
                    { name: "⚖️ Balance", value: "House of Balance", inline: true }
                )
                .setFooter({text: "💙 Nem Quest • HypeSquad"});
            
            const account = await db.dbAddAccount(token, requesterId);
            if (!account) {
                await interaction.followUp({ content: "❌ Token không hợp lệ!" });
                return;
            }
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`hs_1_${account.user_id}`).setLabel('🦁 Bravery').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`hs_2_${account.user_id}`).setLabel('💡 Brilliance').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`hs_3_${account.user_id}`).setLabel('⚖️ Balance').setStyle(ButtonStyle.Primary)
            );
            await interaction.followUp({ embeds: [embed], components: [row] });
        }
    }
    
    else if (interaction.isButton()) {
        const requesterId = interaction.user.id;
        
        if (interaction.customId.startsWith('change_token_')) {
            const modal = new ModalBuilder().setCustomId('token_modal_change').setTitle('🔑 Đổi Token Discord');
            const ti = new TextInputBuilder().setCustomId('token_input').setLabel('Discord Token').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(50).setMaxLength(200);
            modal.addComponents(new ActionRowBuilder().addComponents(ti));
            await interaction.showModal(modal);
        }
        else if (interaction.customId.startsWith('start_sess_')) {
            const userId = interaction.customId.replace('start_sess_', '');
            if (workerGet(userId)) {
                await interaction.reply({ content: `⚠️ Tài khoản đang chạy rồi! Dùng nút Stop trong menu để dừng.`, flags: 64 });
                return;
            }
            
            await interaction.deferReply({ flags: 64 });
            const acc = db.dbGetAccountByRequester(requesterId);
            if (!acc || acc.user_id !== userId) {
                await interaction.followUp({ content: "❌ Không tìm thấy account!" });
                return;
            }
            
            const actionable = await fetchCompletableActionable(acc.token);
            if (actionable === "DEAD_TOKEN") {
                const em = new EmbedBuilder().setTitle("⚠️ Token không còn hoạt động").setDescription("❌ Token của bạn đã hết hạn hoặc bị thu hồi.\n\nNhấn **🔄 Change Token** để nhập token mới.").setColor(0xFF5555).setFooter({text: `Nem Quest  •  ${acc.username}`});
                await interaction.followUp({ embeds: [em] });
                return;
            }
            if (actionable && actionable.length === 0) {
                const em = new EmbedBuilder().setTitle("🌸 Không có nhiệm vụ nào").setDescription("✅ Tất cả Discord Quest đã hoàn thành rồi!\n\nQuay lại khi Discord phát hành quest mới nhé 🎯").setColor(0x57F287).setFooter({text: `💙 Nem Quest  •  ${acc.username}`});
                await interaction.followUp({ embeds: [em] });
                return;
            }
            
            db.dbSetManuallyStopped(userId, false);
            const avatarUrl = interaction.user.avatarURL() || null;
            
            let statusMsg = null;
            try {
                let ch = client.channels.cache.get(CHANNEL_ID) || await client.channels.fetch(CHANNEL_ID);
                const initEm = new EmbedBuilder().setTitle("🚀 Nem Quest — Đang khởi động...").setDescription("⏳ Đang kết nối và tải danh sách quest...").setColor(0x00BFFF).setFooter({text: `💙 Nem Quest  •  ${acc.username}`});
                if (avatarUrl) initEm.setThumbnail(avatarUrl);
                statusMsg = await ch.send({ content: `<@${requesterId}>`, embeds: [initEm] });
            } catch(e) {}
            
            workerStart(acc.token, userId, acc.username || "User", {
                pollInterval: 5, autoAccept: true, botClient: client, channelId: CHANNEL_ID,
                requesterDiscordId: requesterId, avatarUrl: avatarUrl, silent: false,
                onCompleteCallback: async () => { await sendMenuToChannel(client); },
                preChannelMsg: statusMsg
            });
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`change_token_${userId}`).setLabel('🔄 Change Token').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`start_sess_${userId}`).setLabel('✅ Running...').setStyle(ButtonStyle.Primary).setEmoji('🚀').setDisabled(true)
            );
            await interaction.editReply({ embeds: [buildQuestPanel(acc.username || "User", interaction.user, true)], components: [row] });
            await sendMenuToChannel(client);
        }
        else if (interaction.customId.startsWith('hs_')) {
            const parts = interaction.customId.split('_');
            const houseId = parts[1];
            
            await interaction.deferReply({ flags: 64 });
            const acc = db.dbGetAccountByRequester(requesterId);
            if (!acc) return await interaction.followUp({ content: "Lỗi: Không tìm thấy account!" });
            
            const house = HYPESQUAD_HOUSES[houseId];
            const res = await changeHypesquad(acc.token, houseId);
            
            let embed;
            if (res.ok) {
                embed = new EmbedBuilder()
                    .setTitle(`${house.emoji} HypeSquad ${house.name}`)
                    .setDescription(`✅ **Badge đã được đổi thành công!**\n\nTài khoản của bạn hiện là **${house.name}**\n👤 Người dùng: <@${requesterId}>`)
                    .setColor(house.color);
            } else {
                embed = new EmbedBuilder()
                    .setTitle(`❌ Thất bại — ${house.emoji} ${house.name}`)
                    .setDescription(`**${res.msg}**\n\nKiểm tra lại token và thử lại.`)
                    .setColor(0xFF0000);
            }
            embed.setFooter({text: "💙 Nem Quest • HypeSquad"});
            
            try {
                let ch = client.channels.cache.get(CHANNEL_ID) || await client.channels.fetch(CHANNEL_ID);
                await ch.send({ embeds: [embed] });
                await interaction.followUp({ content: "Đã gửi vào kênh chung." });
            } catch(e) {
                await interaction.followUp({ embeds: [embed] });
            }
            await sendMenuToChannel(client);
        }
        else if (interaction.customId === 'mobile_guide') {
            const embed = new EmbedBuilder()
                .setTitle("📱 Hướng dẫn lấy Token trên Mobile")
                .setColor(BLUE)
                .addFields(
                    { name: "📋 Bước 1: Lấy Script", value: "Nhấn nút **Sao chép Script** bên dưới." },
                    { name: "▶️ Bước 2: Xem video", value: "[Xem video hướng dẫn](https://www.youtube.com/watch?v=mJKpmX6w9Z0)" },
                    { name: "⚠️ Lưu ý", value: "• Android → phải dùng **Chrome**\n• Token = mật khẩu, **không chia sẻ**\n• Lộ token → đổi mật khẩu Discord ngay" }
                )
                .setFooter({text: "Nem Quest"});
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('▶ Xem video Mobile').setStyle(ButtonStyle.Link).setURL("https://www.youtube.com/watch?v=mJKpmX6w9Z0").setEmoji('📺'),
                new ButtonBuilder().setCustomId('copy_script').setLabel('📋 Sao chép Script').setStyle(ButtonStyle.Primary)
            );
            await interaction.reply({ embeds: [embed], components: [row], flags: 64 });
        }
        else if (interaction.customId === 'copy_script') {
            await interaction.reply({ 
                content: `**📋 Script lấy token — copy toàn bộ:**\n\`\`\`\n${MOBILE_TOKEN_SCRIPT}\n\`\`\`\n**Cách dùng:**\n1. Copy đoạn script trên\n2. Mở Chrome → vào Discord Web\n3. Dán vào thanh địa chỉ → Enter\n4. Token sẽ tự copy vào clipboard\n\n⚠️ **Bắt buộc dùng Chrome** nếu dùng Android`,
                flags: 64 
            });
        }
    }
}

async function autoResumeQuests(client) {
    const accounts = await db.dbGetAccountsForResume();
    if (accounts && accounts.length > 0) {
        console.log(`🔄 Auto-resume: ${accounts.length} tài khoản quest...`);
        for (const acc of accounts) {
            const { token, user_id, username, requester_id } = acc;
            const uname = username || user_id;
            if (!token || !user_id) continue;
            if (workerGet(user_id)) continue;
            
            console.log(`   ▶ Resuming: ${uname}`);
            workerStart(token, user_id, uname, {
                pollInterval: 5,
                autoAccept: true,
                botClient: client,
                channelId: CHANNEL_ID,
                requesterDiscordId: requester_id,
                silent: false,
                onCompleteCallback: async () => { await sendMenuToChannel(client); }
            });
        }
        console.log("✅ Auto-resume quest xong.");
    }
}

module.exports = {
    handleQuestInteraction,
    sendMenuToChannel,
    autoResumeQuests,
    CHANNEL_ID
};
