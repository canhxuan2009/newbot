'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { toQuestSnapshot } = require('../src/services/questParser');
const { planQuestCycle, areAllDiscordQuestsDone } = require('../src/services/questPlanner');

const fixturePath = path.join(__dirname, 'fixtures', 'python-quest-cases.json');
const goldenPath = path.join(__dirname, 'fixtures', 'python-quest-golden.json');
const oraclePath = path.join(__dirname, 'oracle', 'python_quest_oracle.py');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

function evaluateNode(payload) {
    const now = new Date(payload.now);
    const plan = planQuestCycle(payload.quests, {
        completedIds: new Set(payload.completedIds),
        now,
    });

    return {
        cases: payload.quests.map((quest) => toQuestSnapshot(quest, now)),
        plan: {
            stats: plan.stats,
            questMap: plan.questMap,
            unacceptedIds: plan.unaccepted.map((quest) => quest.id),
            videoIds: plan.videoQuests.map((quest) => quest.id),
            otherIds: plan.otherQuests.map((quest) => quest.id),
            actionableIds: plan.actionable.map((quest) => quest.id),
            allDone: areAllDiscordQuestsDone(payload.quests, now),
        },
    };
}

function findPython() {
    const candidates = process.platform === 'win32'
        ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] }]
        : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];

    for (const candidate of candidates) {
        const result = spawnSync(candidate.command, [...candidate.args, '--version'], { encoding: 'utf8' });
        if (result.status === 0) return candidate;
    }
    return null;
}

test('Node matches the checked-in Python reference golden output', () => {
    assert.deepEqual(evaluateNode(fixture), golden);
});

const python = findPython();
test('Node matches the live Python oracle', { skip: !python && 'Python 3 is not installed' }, () => {
    const result = spawnSync(
        python.command,
        [...python.args, oraclePath],
        { input: JSON.stringify(fixture), encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(evaluateNode(fixture), JSON.parse(result.stdout));
});
