const mongoose = require('mongoose');

const shopTicketSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    ticketId: { type: String, required: true, unique: true }, // VD: SHOP-1234
    buyerId: { type: String, required: true },
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, default: 'VND' },
    status: {
        type: String,
        enum: ['WAITING_PAYMENT', 'PAID', 'DELIVERED', 'COMPLETED', 'CANCELLED'],
        default: 'WAITING_PAYMENT',
    },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ShopTicket', shopTicketSchema);
