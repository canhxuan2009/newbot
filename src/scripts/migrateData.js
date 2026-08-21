require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/product');
const Setting = require('../models/setting');
const shopProducts = require('../config/shopProducts');

async function migrate() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB.');

        console.log('📦 Migrating Products...');
        let order = 0;
        for (const p of shopProducts) {
            await Product.findOneAndUpdate(
                { id: p.id },
                {
                    label: p.label,
                    price: p.price,
                    emoji: p.emoji || '📦',
                    description: p.description || '',
                    image: p.image || '',
                    order: order++
                },
                { upsert: true }
            );
            console.log(`- Upserted: ${p.label}`);
        }
        console.log('✅ Products migrated successfully.');

        console.log('🏦 Migrating Bank Settings...');
        const bankId = process.env.ESCROW_BANK_ID || 'BIDV';
        const bankAccount = process.env.ESCROW_BANK_ACCOUNT || '';
        const bankName = process.env.ESCROW_BANK_NAME || '';

        await Setting.findOneAndUpdate(
            { key: 'bank_config' },
            { value: { bankId, bankAccount, bankName } },
            { upsert: true }
        );
        console.log('✅ Bank Settings migrated successfully.');

        console.log('🎉 Migration completed!');
    } catch (error) {
        console.error('❌ Migration failed:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB.');
    }
}

migrate();
