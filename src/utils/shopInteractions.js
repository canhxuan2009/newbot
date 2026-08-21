const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ChannelType,
    PermissionFlagsBits,
} = require('discord.js');
const ShopTicket = require('../models/shopTicket');
const Product = require('../models/product');
const Setting = require('../models/setting');
const { createAndSendTranscript } = require('./transcript');
const logger = require('./logger');

const SHOP_ADMIN_ID = process.env.SHOP_ADMIN_ID || '1053646107785302069';

function generateTicketId() {
    const num = Math.floor(1000 + Math.random() * 9000);
    return `SHOP-${num}`;
}

const STATUS_LABELS = {
    WAITING_PAYMENT: '⏳ Chờ chuyển khoản',
    PAID: '💵 Đã chuyển khoản (Chờ kiểm tra)',
    DELIVERED: '📦 Đã giao hàng',
    COMPLETED: '✅ Hoàn tất',
    CANCELLED: '❌ Đã huỷ',
};

async function getBankSettings() {
    let bankId = process.env.ESCROW_BANK_ID || 'BIDV';
    let bankAccount = process.env.ESCROW_BANK_ACCOUNT || '';
    let bankName = process.env.ESCROW_BANK_NAME || '';
    let staffId = '';

    try {
        const setting = await Setting.findOne({ key: 'bank_config' });
        if (setting && setting.value) {
            bankId = setting.value.bankId || bankId;
            bankAccount = setting.value.bankAccount || bankAccount;
            bankName = setting.value.bankName || bankName;
            staffId = setting.value.staffId || '';
        }
    } catch (e) {
        logger.error('Lỗi khi lấy bank settings: ' + e);
    }
    return { bankId, bankAccount, bankName, staffId };
}

function buildShopEmbed(ticket, guild, product) {
    const statusLabel = STATUS_LABELS[ticket.status] || ticket.status;

    const embed = new EmbedBuilder()
        .setColor(ticket.status === 'COMPLETED' ? 0x2ecc71 : ticket.status === 'CANCELLED' ? 0xe74c3c : 0xf1c40f)
        .setTitle(`🛒 Giao Dịch Mua Hàng — #${ticket.ticketId}`)
        .addFields(
            { name: '👤 Người Mua', value: `<@${ticket.buyerId}>`, inline: true },
            { name: '🛡️ Nhân Viên Xử Lý', value: `<@${SHOP_ADMIN_ID}>`, inline: true },
            { name: '📦 Sản Phẩm', value: `**${product && product.emoji ? product.emoji + ' ' : ''}${ticket.productName}**${product && product.description ? `\n*${product.description.trim()}*` : ''}`, inline: false },
            { name: '💰 Số Tiền Cần Thanh Toán', value: `**${ticket.price.toLocaleString('vi-VN')} VND**`, inline: false },
        );

    if (product && product.image) {
        embed.setThumbnail(product.image);
    }

    let statusNote = '';
    switch (ticket.status) {
        case 'WAITING_PAYMENT':
            statusNote = `Vui lòng chuyển khoản **${ticket.price.toLocaleString('vi-VN')} VND** theo thông tin bên dưới.\nSau khi chuyển khoản thành công, hãy bấm nút **✅ Đã chuyển khoản**.`;
            break;
        case 'PAID':
            statusNote = `Người mua đã xác nhận chuyển khoản. Chờ <@${SHOP_ADMIN_ID}> kiểm tra và giao hàng.`;
            break;
        case 'DELIVERED':
            statusNote = `Hàng đã được giao. Vui lòng kiểm tra.`;
            break;
        case 'COMPLETED':
            statusNote = '🎉 Giao dịch hoàn tất! Cảm ơn bạn đã mua hàng.';
            break;
        case 'CANCELLED':
            statusNote = 'Giao dịch đã bị huỷ.';
            break;
    }

    embed.addFields({ name: `Trạng Thái: ${statusLabel}`, value: statusNote });
    embed.setFooter({ text: `Ticket #${ticket.ticketId} • ${guild.name}` });
    embed.setTimestamp();

    return embed;
}

function buildShopButtons(ticket) {
    const rows = [];

    switch (ticket.status) {
        case 'WAITING_PAYMENT': {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('shop_payment_done')
                    .setLabel('✅ Đã chuyển khoản')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('shop_cancel')
                    .setLabel('❌ Huỷ đơn')
                    .setStyle(ButtonStyle.Danger),
            );
            rows.push(row);
            break;
        }
        case 'PAID': {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('shop_delivered')
                    .setLabel('📦 Đã giao hàng (Admin)')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('shop_cancel')
                    .setLabel('❌ Huỷ đơn (Admin)')
                    .setStyle(ButtonStyle.Danger),
            );
            rows.push(row);
            break;
        }
        case 'DELIVERED': {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('shop_complete')
                    .setLabel('⭐ Hoàn tất & Đóng')
                    .setStyle(ButtonStyle.Success),
            );
            rows.push(row);
            break;
        }
        case 'COMPLETED':
        case 'CANCELLED': {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('shop_close')
                    .setLabel('🗑️ Đóng Kênh')
                    .setStyle(ButtonStyle.Danger),
            );
            rows.push(row);
            break;
        }
    }

    return rows;
}

async function updateShopChannelName(channel, ticket) {
    try {
        const STATUS_EMOJIS = {
            WAITING_PAYMENT: '⏳',
            PAID: '💵',
            DELIVERED: '📦',
            COMPLETED: '⭐',
            CANCELLED: '🔴',
        };
        const emoji = STATUS_EMOJIS[ticket.status];
        const cleanName = channel.name.replace(/^[^a-zA-Z0-9]+/, '');
        const newName = emoji ? `${emoji}-${cleanName}` : cleanName;

        if (channel.name !== newName) {
            await channel.setName(newName);
            logger.info(`[Shop] Đổi tên kênh #${ticket.ticketId} thành: ${newName}`);
        }
    } catch (err) {
        logger.error(`[Shop] Lỗi đổi tên kênh #${ticket.ticketId}: ${err.message}`);
    }
}

async function refreshShopMessage(channel, ticket, guild) {
    const product = await Product.findOne({ id: ticket.productId });
    const embed = buildShopEmbed(ticket, guild, product);
    const components = buildShopButtons(ticket);

    updateShopChannelName(channel, ticket);

    try {
        const messages = await channel.messages.fetch({ limit: 20 });
        const botMsg = messages.find(m =>
            m.author.id === channel.client.user.id && m.embeds.length > 0
            && m.embeds[0]?.title?.includes('Giao Dịch Mua Hàng')
        );

        if (botMsg) {
            await botMsg.edit({ embeds: [embed], components });
        } else {
            await channel.send({ embeds: [embed], components });
        }
    } catch (err) {
        logger.error(`[Shop] Lỗi refreshShopMessage: ${err.message}`);
        await channel.send({ embeds: [embed], components });
    }
}

async function handleShopInteraction(interaction) {
    // 1. Khi người dùng chọn sản phẩm trong Select Menu -> Hiển thị Embed Xác Nhận Mở Ticket (Ephemeral)
    if (interaction.isStringSelectMenu() && interaction.customId === 'shop_product_select') {
        const productId = interaction.values[0];
        const product = await Product.findOne({ id: productId });

        if (!product) {
            return interaction.reply({ content: '❌ Không tìm thấy sản phẩm này trong hệ thống.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('XÁC NHẬN MỞ TICKET')
            .setDescription(
                `Bạn có chắc chắn muốn mở phòng giao dịch để mua sản phẩm **${product.label}**?\n\n` +
                `*Lưu ý: Vui lòng nhấn nút dưới đây để tiếp tục.*`
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`shop_confirm_create_${product.id}`)
                .setLabel('Xác nhận tạo phòng')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('shop_cancel_confirm')
                .setLabel('Hủy yêu cầu')
                .setStyle(ButtonStyle.Danger)
        );

        return interaction.reply({
            embeds: [embed],
            components: [row],
            ephemeral: true
        });
    }

    // 2. Nút "Hủy yêu cầu" trong Embed Xác Nhận
    if (interaction.isButton() && interaction.customId === 'shop_cancel_confirm') {
        return interaction.update({
            content: '❌ Đã hủy yêu cầu mở phòng giao dịch.',
            embeds: [],
            components: []
        });
    }

    // 3. Nút "Xác nhận tạo phòng" trong Embed Xác Nhận -> Tạo Ticket thực sự
    if (interaction.isButton() && interaction.customId.startsWith('shop_confirm_create_')) {
        const productId = interaction.customId.replace('shop_confirm_create_', '');
        const product = await Product.findOne({ id: productId });

        if (!product) {
            return interaction.update({ content: '❌ Sản phẩm không còn tồn tại.', embeds: [], components: [] });
        }

        await interaction.update({ content: '⏳ Đang tạo phòng giao dịch...', embeds: [], components: [] });

        const guild = interaction.guild;
        const buyer = interaction.member;
        const categoryId = process.env.ESCROW_CATEGORY_ID;

        let ticketId;
        let attempts = 0;
        do {
            ticketId = generateTicketId();
            const existing = await ShopTicket.findOne({ guildId: guild.id, ticketId });
            if (!existing) break;
            attempts++;
        } while (attempts < 10);

        if (attempts >= 10) {
            return interaction.editReply({ content: '❌ Không thể tạo mã ticket. Vui lòng thử lại!' });
        }

        try {
            const bankConfig = await getBankSettings();
            const staffIdToUse = bankConfig.staffId || SHOP_ADMIN_ID;

            const channelOptions = {
                name: `nem-${buyer.displayName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${ticketId.toLowerCase()}`,
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    {
                        id: guild.id,
                        type: 0,
                        deny: [PermissionFlagsBits.ViewChannel],
                    },
                    {
                        id: buyer.id,
                        type: 1,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory],
                    },
                    {
                        id: staffIdToUse,
                        type: 1,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory],
                    },
                    {
                        id: interaction.client.user.id,
                        type: 1,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory],
                    },
                ],
            };

            if (categoryId) {
                channelOptions.parent = categoryId;
            }

            const ticketChannel = await guild.channels.create(channelOptions);

            const ticket = await ShopTicket.create({
                guildId: guild.id,
                channelId: ticketChannel.id,
                ticketId,
                buyerId: buyer.id,
                productId: product.id,
                productName: product.label,
                price: product.price,
                status: 'WAITING_PAYMENT',
            });

            await updateShopChannelName(ticketChannel, ticket);

            const embed = buildShopEmbed(ticket, guild, product);
            const components = buildShopButtons(ticket);

            const qrUrl = `https://img.vietqr.io/image/${bankConfig.bankId}-${bankConfig.bankAccount}-compact.png?amount=${product.price}&addInfo=${ticketId}&accountName=${encodeURIComponent(bankConfig.bankName)}`;

            const bankInfo = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle('💳 Thông Tin Thanh Toán')
                .setDescription(`Vui lòng chuyển khoản số tiền **${product.price.toLocaleString('vi-VN')} VND**.\n\n` +
                    `🏦 **Ngân hàng:** ${bankConfig.bankId || 'Chưa cập nhật'}\n` +
                    `🔢 **Số tài khoản:** \`${bankConfig.bankAccount || 'Chưa cập nhật'}\`\n` +
                    `👤 **Chủ tài khoản:** ${bankConfig.bankName || 'Chưa cập nhật'}\n` +
                    `📝 **Nội dung CK:** \`${ticketId}\`\n\n` +
                    `*Nếu đã chuyển khoản thành công, vui lòng gửi ảnh bill vào đây và bấm nút xác nhận.*`
                )
                .setImage(qrUrl);

            await ticketChannel.send({
                content: `🛒 **Ticket Mua Hàng — #${ticketId}**\nNgười mua: ${buyer}\nNhân viên xử lý: <@${staffIdToUse}>`,
                embeds: [embed, bankInfo],
                components,
            });

            await interaction.editReply({
                content: `✅ Đã tạo ticket mua hàng thành công!\n👉 Vào <#${ticketChannel.id}> để tiếp tục.`,
            });

            logger.info(`[Shop] Ticket #${ticketId} được tạo bởi ${buyer.user.tag}, Sản phẩm: ${product.label}`);

        } catch (err) {
            logger.error(`[Shop] Lỗi tạo ticket: ${err.message}`);
            await interaction.editReply({ content: `❌ Lỗi khi tạo ticket: ${err.message}` });
        }
        return true;
    }

    // 4. Xử lý Các Nút Điều Khiển Ticket (Đã chuyển khoản, Giao hàng, Hoàn tất, Hủy, Đóng)
    const shopButtons = [
        'shop_payment_done',
        'shop_delivered',
        'shop_complete',
        'shop_cancel',
        'shop_close'
    ];

    if (interaction.isButton() && shopButtons.includes(interaction.customId)) {
        const ticket = await ShopTicket.findOne({ channelId: interaction.channel.id });
        if (!ticket) return false;

        const isBuyer = interaction.user.id === ticket.buyerId;
        const isAdmin = interaction.user.id === SHOP_ADMIN_ID || interaction.guild.ownerId === interaction.user.id;

        switch (interaction.customId) {
            case 'shop_payment_done': {
                if (!isBuyer && !isAdmin) return interaction.reply({ content: '❌ Bạn không có quyền thao tác.', ephemeral: true });
                if (ticket.status !== 'WAITING_PAYMENT') return interaction.reply({ content: '❌ Trạng thái không hợp lệ.', ephemeral: true });

                await interaction.deferUpdate();
                ticket.status = 'PAID';
                await ticket.save();

                await refreshShopMessage(interaction.channel, ticket, interaction.guild);
                await interaction.channel.send(`🔔 <@${SHOP_ADMIN_ID}> Người mua đã xác nhận chuyển khoản. Vui lòng kiểm tra và giao hàng.`);
                break;
            }
            case 'shop_delivered': {
                if (!isAdmin) return interaction.reply({ content: '❌ Chỉ Admin mới có quyền thao tác.', ephemeral: true });
                if (ticket.status !== 'PAID') return interaction.reply({ content: '❌ Trạng thái không hợp lệ.', ephemeral: true });

                await interaction.deferUpdate();
                ticket.status = 'DELIVERED';
                await ticket.save();

                await refreshShopMessage(interaction.channel, ticket, interaction.guild);
                await interaction.channel.send(`📦 Hàng đã được giao. <@${ticket.buyerId}> vui lòng kiểm tra và nếu không có vấn đề gì, admin sẽ đóng ticket.`);
                break;
            }
            case 'shop_complete': {
                if (!isAdmin) return interaction.reply({ content: '❌ Chỉ Admin mới có quyền thao tác.', ephemeral: true });
                if (ticket.status !== 'DELIVERED') return interaction.reply({ content: '❌ Trạng thái không hợp lệ.', ephemeral: true });

                await interaction.deferUpdate();
                ticket.status = 'COMPLETED';
                await ticket.save();

                await refreshShopMessage(interaction.channel, ticket, interaction.guild);
                await interaction.channel.send(`🎉 Ticket đã hoàn tất. Bạn có thể bấm Đóng Kênh.`);
                break;
            }
            case 'shop_cancel': {
                if (!isAdmin && !isBuyer) return interaction.reply({ content: '❌ Bạn không có quyền thao tác.', ephemeral: true });

                await interaction.deferUpdate();
                ticket.status = 'CANCELLED';
                await ticket.save();

                await refreshShopMessage(interaction.channel, ticket, interaction.guild);
                await interaction.channel.send(`❌ Ticket đã bị huỷ.`);
                break;
            }
            case 'shop_close': {
                if (!isAdmin) return interaction.reply({ content: '❌ Chỉ Admin mới có quyền đóng kênh.', ephemeral: true });

                await interaction.deferUpdate();

                const logChannelId = process.env.ESCROW_LOG_CHANNEL_ID;
                ticket.dealId = ticket.ticketId;
                ticket.amount = ticket.price;
                ticket.fee = 0;
                ticket.feePayer = 'BUYER';
                ticket.description = ticket.productName;

                await createAndSendTranscript(interaction.channel, ticket, logChannelId, true);

                setTimeout(() => {
                    interaction.channel.delete().catch(() => { });
                }, 5000);
                break;
            }
        }
        return true;
    }

    return false;
}

module.exports = { handleShopInteraction };
