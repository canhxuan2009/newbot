'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const menuQuestCommand = require('../src/commands/menuquest');

test('menuquest command builds select menu with exactly 6 python options', async () => {
    // We mock interaction, Setting, etc. but actually we just need to test if the components generated are correct.
    // However, the command only exports execute(). We can mock interaction and check the components sent.
    let sentPayload;
    
    const mockInteraction = {
        guildId: '123',
        client: {
            channels: {
                fetch: async () => ({
                    isTextBased: () => true,
                    send: async (payload) => {
                        sentPayload = payload;
                        return { id: 'msg456' };
                    },
                    id: 'channel789'
                })
            }
        },
        channel: {
            isTextBased: () => true,
            send: async (payload) => {
                sentPayload = payload;
                return { id: 'msg456' };
            },
            id: 'channel789'
        },
        deferReply: async () => {},
        reply: async () => {},
        editReply: async () => {},
        member: {
            permissions: {
                has: () => true // has ManageGuild
            }
        }
    };
    
    // We also need to mock Setting model and process.env.QUEST_CHANNEL_ID
    const originalEnv = process.env.QUEST_CHANNEL_ID;
    delete process.env.QUEST_CHANNEL_ID;
    
    const Setting = require('../src/models/setting');
    const originalFindOne = Setting.findOne;
    const originalFindOneAndUpdate = Setting.findOneAndUpdate;
    
    Setting.findOne = () => ({ lean: async () => null });
    Setting.findOneAndUpdate = async () => ({});
    
    try {
        await menuQuestCommand.execute(mockInteraction);
        
        assert.ok(sentPayload, 'Command should send a payload');
        assert.equal(sentPayload.components.length, 1, 'Should have exactly 1 ActionRow');
        
        const actionRow = sentPayload.components[0].toJSON();
        assert.equal(actionRow.components.length, 1, 'ActionRow should have 1 component (the select menu)');
        
        const selectMenu = actionRow.components[0];
        assert.equal(selectMenu.type, 3, 'Component type 3 is StringSelectMenu');
        assert.equal(selectMenu.custom_id, 'menu_select');
        assert.equal(selectMenu.options.length, 6, 'Should have 6 options');
        
        const options = selectMenu.options;
        assert.equal(options[0].value, 'quest');
        assert.equal(options[0].label, 'Quest');
        assert.equal(options[0].emoji.name, '🚀');
        
        assert.equal(options[1].value, 'change');
        assert.equal(options[1].label, 'Change');
        
        assert.equal(options[2].value, 'stat');
        assert.equal(options[3].value, 'stop');
        assert.equal(options[4].value, 'hypersquad');
        assert.equal(options[5].value, 'way');
        
    } finally {
        // Restore mocks
        process.env.QUEST_CHANNEL_ID = originalEnv;
        Setting.findOne = originalFindOne;
        Setting.findOneAndUpdate = originalFindOneAndUpdate;
    }
});
