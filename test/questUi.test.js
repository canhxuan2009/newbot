'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { progressBar, buildQuestPanel, buildQuestStatus } = require('../src/utils/questEmbeds');
const menuQuestCommand = require('../src/commands/menuquest');

test('renders the same ten-cell progress convention as the Python UI', () => {
    assert.equal(progressBar(0, 100), '`░░░░░░░░░░` 0%');
    assert.equal(progressBar(45, 100), '`████░░░░░░` 45%');
    assert.equal(progressBar(150, 100), '`██████████` 100%');
});

test('builds valid Discord payloads for panel and status', () => {
    const panel = buildQuestPanel({ available: false }).toJSON();
    const status = buildQuestStatus({
        status: 'running',
        pollCount: 2,
        quests: [{ name: 'Video', status: 'running', secondsDone: 30, secondsNeeded: 60 }],
    }).toJSON();

    assert.equal(panel.title, '🌸 Drix bot — MENUQUEST');
    assert.equal(status.title, '📊 Trạng thái Quest');
    assert.match(status.fields.at(-1).value, /50%/);
});

test('exports a deployable menuquest slash command', () => {
    const json = menuQuestCommand.data.toJSON();
    assert.equal(json.name, 'menuquest');
    assert.equal(typeof menuQuestCommand.execute, 'function');
});
