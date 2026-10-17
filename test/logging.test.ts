import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import {
  createCoalescedCycleRunner,
  createQueuedFetchText,
  createSyncCooldown,
  handleFfEventsAbgleichen,
} from '../src/main.ts';
import { countAction, log } from '../src/log.ts';
import { openDb, upsertGuildSetup } from '../src/store.ts';
import { versionLine } from '../src/version.ts';
import { captureLog } from './log-capture.ts';

test('the Discord token never appears in captured log lines', () => {
  const captured = captureLog('debug');
  const previous = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = 'tok-secret-123';
  try {
    log.info('Anmeldung mit tok-secret-123');
    log.error('Fehler:', new Error('boom tok-secret-123'));
    log.debug('Detail tok-secret-123');
    log.stack(new Error('stack tok-secret-123'));
    assert.equal(captured.lines.length, 4);
    assert.equal(captured.lines.some((line) => line.includes('tok-secret-123')), false);
    assert.ok(captured.lines.every((line) => !/[\r\n]/.test(line)));
  } finally {
    if (previous === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = previous;
    captured.restore();
  }
});

test('debug level logs every Lodestone request with status, duration and 304 cache hits', async () => {
  const responses: Array<Response | { status: 304 }> = [
    new Response('<html></html>', { status: 200, headers: { etag: '"a"' } }),
    { status: 304 },
  ];
  const queue = { fetch: async () => responses.shift()! };
  const stats = { notModified: 0 };
  const fetchText = createQueuedFetchText(queue as never, stats);
  for (const level of ['info', 'debug'] as const) {
    const captured = captureLog(level);
    try {
      responses.splice(0, responses.length, new Response('<html></html>', { status: 200, headers: { etag: '"a"' } }), { status: 304 });
      await fetchText('https://example.test/a', { priority: 'list' });
      await fetchText('https://example.test/a', { priority: 'list' });
      if (level === 'info') assert.deepEqual(captured.lines, []);
      else {
        const lines = captured.messages();
        assert.match(lines[0]!, /^DEBUG Lodestone-Anfrage: https:\/\/example\.test\/a → 200 in \d+ ms$/);
        assert.match(lines[1]!, /→ 304 in \d+ ms, aus Cache$/);
      }
    } finally {
      captured.restore();
    }
  }
  assert.equal(stats.notModified, 2);
});

test('version line shows commit and build time, or the local git state', () => {
  assert.equal(versionLine({ FFE_GIT_SHA: '713348e1234567890', FFE_BUILD_TIME: '2026-10-17T00:58Z' }, '0.1.0'),
    'ffEventNotify 0.1.0 (sha-713348e, gebaut 2026-10-17T00:58Z)');
  assert.equal(versionLine({}, '0.1.0', () => 'abc1234'), 'ffEventNotify 0.1.0 (lokal, abc1234)');
  assert.equal(versionLine({}, '0.1.0', () => 'unbekannt'), 'ffEventNotify 0.1.0 (lokal, unbekannt)');
  assert.match(versionLine({}), /^ffEventNotify \d+\.\d+\.\d+ \(lokal, \S+\)$/);
});

function abgleichenInteraction(guildId: string, name: string, replies: string[]) {
  return {
    guildId,
    guild: { name },
    user: { username: 'tester', id: 'u1' },
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    inGuild: () => true,
    reply: async (options: { content: string }) => { replies.push(options.content); },
    editReply: async (options: { content: string }) => { replies.push(options.content); },
  } as never;
}

test('/ffevents abgleichen answers with this server result, cooldowns and cycle coalescing', async () => {
  const db = openDb(':memory:');
  upsertGuildSetup(db, { guildId: 'g1', eventChannelId: 'e1', logChannelId: 'l1' });
  upsertGuildSetup(db, { guildId: 'g2', eventChannelId: 'e2', logChannelId: 'l2' });
  let clock = 1_000_000;
  const cooldown = createSyncCooldown(() => clock);
  let cycles = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runCycle = createCoalescedCycleRunner(async () => {
    cycles += 1;
    await gate;
    countAction('g1', 'postCreated');
    countAction('g1', 'postEdited');
    countAction('g1', 'postEdited');
    return { syncedGuildIds: ['g1', 'g2'] } as never;
  });
  const deps = { runCycle, runGuildSync: async () => assert.fail('cycle already synced the server'), cooldown };
  try {
    const first: string[] = [];
    const running = handleFfEventsAbgleichen(abgleichenInteraction('g1', 'Eins', first), db, deps);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first[0], 'Abgleich gestartet …');

    const blockedGlobal: string[] = [];
    await handleFfEventsAbgleichen(abgleichenInteraction('g2', 'Zwei', blockedGlobal), db, deps);
    assert.match(blockedGlobal[0]!, /in 5 Min 0 s erneut/);

    clock += 5 * 60_000;
    const second: string[] = [];
    const secondRun = handleFfEventsAbgleichen(abgleichenInteraction('g2', 'Zwei', second), db, deps);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cycles, 1, 'a running cycle is joined instead of started twice');

    release();
    await Promise.all([running, secondRun]);
    assert.match(first[1]!, /^Fertig: 1 Beitrag neu angelegt, 2 bearbeitet\.\nVersion: ffEventNotify /);

    const blockedGuild: string[] = [];
    await handleFfEventsAbgleichen(abgleichenInteraction('g1', 'Eins', blockedGuild), db, deps);
    assert.match(blockedGuild[0]!, /in 5 Min 0 s erneut/);
    clock += 10 * 60_000;
    assert.equal(cooldown.remaining('g1'), 0);
  } finally {
    db.close();
  }
});
