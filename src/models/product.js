const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    price: { type: Number, required: true },
    emoji: { type: String, default: '📦' },
    description: { type: String, default: '' },
    image: { type: String, default: '' },
    order: { type: Number, default: 0 },
});

module.exports = mongoose.model('Product', productSchema);
