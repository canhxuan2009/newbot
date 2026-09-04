const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, PermissionFlagsBits } = require('discord.js');
const { hasPermission } = require('../utils/permissions');
const Product = require('../models/product');
const Setting = require('../models/setting');

function formatShortPrice(price) {
    const num = Number(price);
    if (isNaN(num) || num <= 0) return '0k';

    if (num >= 1_000_000) {
        const val = num / 1_000_000;
        const formatted = Number(val.toFixed(2)).toString().replace('.', ',');
        return `${formatted}M`;
    }

    if (num >= 1_000) {
        const val = num / 1_000;
        const formatted = Number(val.toFixed(2)).toString().replace('.', ',');
        return `${formatted}k`;
    }

    return String(num);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Mở bảng điều khiển Shop Bán Tài Khoản (Admin Only)'),
    formatShortPrice,

    async execute(interaction) {
        if (!hasPermission(interaction, PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ Bạn không có quyền sử dụng lệnh này.',
                ephemeral: true,
            });
        }

        // Đọc danh sách sản phẩm từ MongoDB
        const shopProducts = await Product.find().sort({ order: 1 });

        if (!shopProducts || shopProducts.length === 0) {
            return interaction.reply({
                content: '❌ Shop hiện tại chưa có sản phẩm nào. Vui lòng thêm sản phẩm thông qua Web Admin!',
                ephemeral: true,
            });
        }

        // Đọc cấu hình Embed Shop từ MongoDB
        const embedSetting = await Setting.findOne({ key: 'shop_embed_config' });
        const embedConfig = embedSetting?.value || {};

        const defaultDescription = '# <a:VerifedTick:1525861266000711700> BẢNG GIÁ PREMIER SERVICES\n <a:darkbluearrow:1525876310206054643> Nhấn vào menu bên dưới để xem chi tiết giá\n <a:darkbluearrow:1525876310206054643> Giá ưu đãi – Duyệt đơn nhanh chóng\n <a:darkbluearrow:1525876310206054643> Hỗ Trợ 24/7 – Giao Hàng Tận Tay';

        const embed = new EmbedBuilder()
            .setColor(embedConfig.color || '#1a1c23')
            .setDescription(embedConfig.description || defaultDescription);

        if (embedConfig.title) embed.setTitle(embedConfig.title);
        if (embedConfig.footer) embed.setFooter({ text: embedConfig.footer });
        if (embedConfig.image) embed.setImage(embedConfig.image);
        if (embedConfig.thumbnail) embed.setThumbnail(embedConfig.thumbnail);

        const options = shopProducts.map(product => {
            const shortPrice = formatShortPrice(product.price);
            const suffix = ` | ${shortPrice}`;
            const maxNameLen = 100 - suffix.length;
            const name = product.label.length > maxNameLen
                ? product.label.slice(0, maxNameLen - 1) + '…'
                : product.label;

            return {
                label: `${name}${suffix}`,
                value: product.id,
                emoji: product.emoji || '📦'
            };
        });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('shop_product_select')
            .setPlaceholder(embedConfig.placeholder || 'NHẤP VÀO ĐÂY ĐỂ CHỌN SẢN PHẨM')
            .addOptions(options.slice(0, 25));

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.channel.send({
            embeds: [embed],
            components: [row]
        });

        await interaction.reply({
            content: '✅ Đã gửi bảng điều khiển Shop thành công!',
            ephemeral: true
        });
    },
};
