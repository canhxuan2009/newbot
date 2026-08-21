const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const logger = require('./logger');

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.*?)_/g, '<em>$1</em>');
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    html = html.replace(/`(.*?)`/g, '<code>$1</code>');
    html = html.replace(/\n/g, '<br>');
    return html;
}

/**
 * Tạo file HTML Transcript và gửi vào các kênh log archive tương ứng
 */
async function createAndSendTranscript(channel, ticket, logChannelId, isShop = false) {
    try {
        const client = channel.client;
        const logChannel = logChannelId ? await client.channels.fetch(logChannelId).catch(() => null) : null;

        const attachmentChannel = (process.env.ESCROW_ATTACHMENT_CHANNEL_ID ? await client.channels.fetch(process.env.ESCROW_ATTACHMENT_CHANNEL_ID).catch(() => null) : null) || logChannel;
        const htmlChannel = (process.env.ESCROW_HTML_CHANNEL_ID ? await client.channels.fetch(process.env.ESCROW_HTML_CHANNEL_ID).catch(() => null) : null) || logChannel;
        const summaryChannel = (process.env.ESCROW_SUMMARY_CHANNEL_ID ? await client.channels.fetch(process.env.ESCROW_SUMMARY_CHANNEL_ID).catch(() => null) : null) || logChannel;

        await channel.send('⏳ *Đang sao lưu lịch sử chat...*');

        let allMessages = [];
        let lastId = null;

        while (true) {
            const options = { limit: 100 };
            if (lastId) options.before = lastId;

            const fetched = await channel.messages.fetch(options);
            if (fetched.size === 0) break;

            allMessages.push(...fetched.values());
            lastId = fetched.lastKey();

            if (fetched.size < 100 || allMessages.length >= 200) break;
        }

        allMessages.reverse();

        const attachmentsToUpload = [];
        for (const msg of allMessages) {
            if (msg.author.id === client.user.id) continue;

            if (msg.attachments.size > 0) {
                for (const [, att] of msg.attachments) {
                    try {
                        logger.info(`[Transcript] Đang tải file đính kèm: ${att.name}`);
                        const response = await fetch(att.url);
                        if (response.ok) {
                            const arrayBuffer = await response.arrayBuffer();
                            const buffer = Buffer.from(arrayBuffer);
                            attachmentsToUpload.push({
                                originalUrl: att.url,
                                name: att.name,
                                buffer: buffer
                            });
                        }
                    } catch (err) {
                        logger.error(`[Transcript] Lỗi tải file đính kèm ${att.name}: ${err.message}`);
                    }
                }
            }
        }

        const reuploadedUrls = {};
        if (attachmentsToUpload.length > 0 && attachmentChannel) {
            const files = attachmentsToUpload.map(item => new AttachmentBuilder(item.buffer, { name: item.name }));
            const chunkedFiles = [];
            for (let i = 0; i < files.length; i += 10) {
                chunkedFiles.push(files.slice(i, i + 10));
            }

            const newAttachments = [];
            for (const chunk of chunkedFiles) {
                const sentMsg = await attachmentChannel.send({
                    content: `📎 **Tệp đính kèm giao dịch #${ticket.dealId}**`,
                    files: chunk
                });
                sentMsg.attachments.forEach(newAtt => {
                    newAttachments.push(newAtt);
                });
            }

            for (let i = 0; i < attachmentsToUpload.length; i++) {
                const original = attachmentsToUpload[i];
                const newAtt = newAttachments[i];
                if (newAtt) {
                    reuploadedUrls[original.originalUrl] = newAtt.url;
                }
            }
        }

        const buyer = await client.users.fetch(ticket.buyerId).catch(() => null);
        const buyerTag = buyer ? `${buyer.tag}` : ticket.buyerId;

        let htmlContent = `
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lịch sử ${isShop ? 'Mua Hàng' : 'Giao Dịch'} #${ticket.dealId}</title>
    <style>
        body { background-color: #313338; color: #dbdee1; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; }
        .header { background-color: #1e1f22; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 5px solid #2ecc71; }
        .header h1 { margin-top: 0; color: #ffffff; font-size: 24px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
        .grid-item { background: #2b2d31; padding: 10px 15px; border-radius: 6px; border: 1px solid #3f4147; }
        .grid-item span { display: block; font-size: 12px; color: #949ba4; text-transform: uppercase; font-weight: bold; }
        .grid-item strong { font-size: 15px; color: #f2f3f5; }
        .chat-container { background-color: #2b2d31; border-radius: 8px; padding: 20px; }
        .message { display: flex; margin-bottom: 20px; border-bottom: 1px solid #3f4147; padding-bottom: 15px; }
        .avatar { width: 40px; height: 40px; border-radius: 50%; margin-right: 15px; background-color: #5865f2; }
        .message-content { flex: 1; }
        .username { font-weight: bold; color: #f2f3f5; margin-right: 10px; }
        .timestamp { font-size: 12px; color: #949ba4; }
        .text { font-size: 15px; line-height: 1.5; word-break: break-word; }
        .attachment-img { max-width: 500px; max-height: 400px; border-radius: 8px; border: 1px solid #3f4147; }
        .bot-tag { background-color: #5865f2; color: #ffffff; font-size: 10px; padding: 2px 5px; border-radius: 3px; margin-left: 5px; }
        code { background-color: #1e1f22; padding: 2px 4px; border-radius: 4px; font-family: monospace; }
        pre { background-color: #1e1f22; padding: 15px; border-radius: 6px; overflow-x: auto; }
    </style>
</head>
<body>
    <div class="header">
        <h1>${isShop ? '🛒 Lịch sử Mua Hàng' : '🤝 Lịch sử Giao Dịch'} — #${ticket.dealId}</h1>
        <div class="grid">
            <div class="grid-item"><span>Trạng thái</span><strong>${ticket.status}</strong></div>
            <div class="grid-item"><span>Số tiền</span><strong>${ticket.amount.toLocaleString('vi-VN')} ${ticket.currency}</strong></div>
            <div class="grid-item"><span>Người mua</span><strong>${buyerTag}</strong></div>
            <div class="grid-item"><span>Ngày tạo</span><strong>${new Date(ticket.createdAt).toLocaleString('vi-VN')}</strong></div>
        </div>
    </div>
    <div class="chat-container">
        <h2>💬 Nội dung thảo luận</h2>
`;

        for (const msg of allMessages) {
            if (msg.author.id === client.user.id) continue;

            const userAvatar = msg.author.displayAvatarURL({ size: 64 }) || '';
            const isBot = msg.author.bot ? '<span class="bot-tag">BOT</span>' : '';
            const msgTime = new Date(msg.createdAt).toLocaleString('vi-VN');
            const parsedText = formatMarkdown(msg.content);

            htmlContent += `
        <div class="message">
            <img class="avatar" src="${userAvatar}" alt="Avatar">
            <div class="message-content">
                <div class="message-header">
                    <span class="username">${escapeHtml(msg.author.displayName || msg.author.username)}</span>${isBot}
                    <span class="timestamp">${msgTime}</span>
                </div>
                <div class="text">${parsedText}</div>
`;

            if (msg.attachments.size > 0) {
                htmlContent += `<div class="attachments">`;
                for (const [, att] of msg.attachments) {
                    const savedUrl = reuploadedUrls[att.url] || att.url;
                    const isImg = att.contentType && att.contentType.startsWith('image/');
                    if (isImg) {
                        htmlContent += `<div class="attachment"><a href="${savedUrl}" target="_blank"><img class="attachment-img" src="${savedUrl}" alt="${escapeHtml(att.name)}"></a></div>`;
                    } else {
                        htmlContent += `<div class="attachment"><a href="${savedUrl}" target="_blank">📁 Tải xuống: ${escapeHtml(att.name)}</a></div>`;
                    }
                }
                htmlContent += `</div>`;
            }

            htmlContent += `</div></div>`;
        }

        htmlContent += `</div></body></html>`;

        const buffer = Buffer.from(htmlContent, 'utf-8');
        const fileAttachment = new AttachmentBuilder(buffer, { name: `transcript-${ticket.dealId}.html` });

        let htmlFileUrl = null;
        if (htmlChannel) {
            try {
                const sentHtmlMsg = await htmlChannel.send({
                    content: `📂 **Transcript HTML cho ${isShop ? 'Đơn Mua Hàng' : 'Deal'} #${ticket.dealId}**`,
                    files: [fileAttachment]
                });
                htmlFileUrl = sentHtmlMsg.attachments.first()?.url;
            } catch (err) {
                logger.error(`[Transcript] Lỗi gửi file HTML: ${err.message}`);
            }
        }

        if (summaryChannel) {
            const summaryEmbed = new EmbedBuilder()
                .setColor(ticket.status === 'COMPLETED' ? 0x2ecc71 : 0xe74c3c)
                .setTitle(`${isShop ? '🛒 Sao lưu Mua Hàng' : '🤝 Sao lưu Giao Dịch'} #${ticket.dealId}`)
                .setDescription(`**Chi tiết ${isShop ? 'đơn mua hàng' : 'giao dịch'} đã kết thúc và được lưu trữ an toàn.**`)
                .addFields(
                    { name: '👤 Người Mua', value: `<@${ticket.buyerId}>`, inline: true },
                    { name: '💰 Số tiền', value: `**${ticket.amount.toLocaleString('vi-VN')} ${ticket.currency}**`, inline: true },
                    { name: '📊 Trạng thái', value: `\`${ticket.status}\``, inline: true },
                    { name: '📦 Sản phẩm', value: ticket.description || '_Không có_' }
                );

            if (htmlFileUrl) {
                summaryEmbed.addFields({ name: '📄 Lịch sử Chat', value: `[📥 Bấm vào đây để tải/xem Transcript HTML](${htmlFileUrl})` });
            }

            summaryEmbed.setFooter({ text: `Kênh ticket đã xoá thành công` }).setTimestamp();

            await summaryChannel.send({ embeds: [summaryEmbed] });
        }

        if (buyer) {
            try {
                const dmFileAttachmentBuyer = new AttachmentBuilder(buffer, { name: `transcript-${ticket.dealId}.html` });
                const dmEmbed = new EmbedBuilder()
                    .setColor(ticket.status === 'COMPLETED' ? 0x2ecc71 : 0xe74c3c)
                    .setTitle(`🛒 Bản Sao Mua Hàng #${ticket.dealId}`)
                    .setDescription(`**Đơn mua hàng của bạn đã kết thúc. Dưới đây là tóm tắt và file lịch sử chat (Transcript) đính kèm.**`)
                    .addFields(
                        { name: '👤 Người Mua', value: `<@${ticket.buyerId}>`, inline: true },
                        { name: '💰 Số tiền', value: `**${ticket.amount.toLocaleString('vi-VN')} ${ticket.currency}**`, inline: true },
                        { name: '📊 Trạng thái', value: `\`${ticket.status}\``, inline: true },
                        { name: '📦 Sản phẩm', value: ticket.description || '_Không có_' }
                    )
                    .setTimestamp();

                await buyer.send({
                    content: `🔔 **Thông báo:** Đơn mua hàng #${ticket.dealId} đã kết thúc.`,
                    embeds: [dmEmbed],
                    files: [dmFileAttachmentBuyer]
                });
            } catch (err) {
                logger.warn(`[Transcript] Không thể gửi DM cho Buyer ${buyer.tag}: ${err.message}`);
            }
        }

        logger.info(`[Transcript] Đã gửi lưu trữ Transcript Deal #${ticket.dealId} thành công.`);
        return true;

    } catch (err) {
        logger.error(`[Transcript] Lỗi tạo và gửi transcript: ${err.message}`);
        return false;
    }
}

module.exports = { createAndSendTranscript };
