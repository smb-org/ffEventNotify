import assert from 'node:assert/strict';
import test from 'node:test';
import { handleChecklistInteraction, parseChecklistCustomId } from '../src/interactions/checklist.ts';
import { stableEventIdentity } from '../src/event-identity.ts';
import {
  applyField,
  createEvent,
  getChecklistDoneItemIds,
  getChecklistReminderRecipients,
  getChecklistReminderPreference,
  openDb,
  upsertGuildSetup,
} from '../src/store.ts';

function rewardEvent(db: ReturnType<typeof openDb>, count: number, endUtc = '2026-11-02T14:59:00.000Z') {
  upsertGuildSetup(db, { guildId: 'guild-1', eventChannelId: 'events', logChannelId: 'logs' });
  const eventKey = 'seasonal-special:/lodestone/special/mogmog/';
  const eventId = createEvent(db, { eventKey, eventType: 'seasonal-special', title: 'Mog Mog-Kollektion 2026' });
  const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/special/mogmog/';
  const rewards = Array.from({ length: count }, (_, index) => ({
    itemId: `item-${index + 1}`,
    name: `Belohnung ${index + 1}`,
    section: 'Belohnungen',
  }));
  db.prepare('INSERT INTO event_sources (url, event_id, kind) VALUES (?, ?, ?)').run(sourceUrl, eventId, 'special');
  applyField(db, eventId, 'start', { status: 'ok', value: '2026-10-15T08:00:00.000Z' }, sourceUrl);
  applyField(db, eventId, 'end', { status: 'ok', value: endUtc }, sourceUrl);
  applyField(db, eventId, 'rewards', { status: 'ok', value: rewards }, sourceUrl);
  return { eventKey, eventId, itemIds: rewards.map((reward) => reward.itemId) };
}

class FakeInteraction {
  readonly user = { id: 'user-1' };
  readonly guildId = 'guild-1';
  readonly replies: Array<Record<string, unknown>> = [];
  readonly updates: Array<Record<string, unknown>> = [];
  customId: string;
  values: string[];
  private kind: 'button' | 'select';

  constructor(kind: 'button' | 'select', customId: string, values: string[] = []) {
    this.kind = kind;
    this.customId = customId;
    this.values = values;
  }

  isButton(): boolean { return this.kind === 'button'; }
  isStringSelectMenu(): boolean { return this.kind === 'select'; }
  inGuild(): boolean { return true; }
  async reply(options: Record<string, unknown>): Promise<void> { this.replies.push(options); }
  async update(options: Record<string, unknown>): Promise<void> { this.updates.push(options); }
}

function componentJson(reply: Record<string, unknown>): Array<Record<string, any>> {
  const components = reply.components as Array<{ toJSON?: () => Record<string, any> }>;
  return components.map((component) => component.toJSON?.() ?? component);
}

test('checklist button custom id round-trips event keys with colons and slashes', () => {
  const eventKey = 'seasonal-special:/lodestone/special/mogmog/';
  assert.deepEqual(parseChecklistCustomId(`ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`), {
    action: 'open', eventHash: stableEventIdentity(eventKey).slice(0, 32),
  });
});

test('checklist opens with 25 options per page and persists selections across pages on save', async () => {
  const db = openDb(':memory:');
  const { eventKey, itemIds } = rewardEvent(db, 30);
  try {
    const opened = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
    await handleChecklistInteraction(opened as never, db, new Date('2026-10-16T12:00:00.000Z'));
    assert.equal(opened.replies[0]?.flags, 64);
    const firstPage = componentJson(opened.replies[0]!);
    const firstSelect = firstPage.flatMap((row) => row.components).find((component) => component.type === 3);
    assert.equal(firstSelect.options.length, 25);
    assert.ok(firstPage.flatMap((row) => row.components).some((component) => component.label === 'Seite 1/2'));

    const firstSelectId = firstSelect.custom_id as string;
    const selectionOnFirst = new FakeInteraction('select', firstSelectId, itemIds.slice(0, 2));
    await handleChecklistInteraction(selectionOnFirst as never, db, new Date('2026-10-16T12:00:00.000Z'));
    const pageTwoId = firstPage.flatMap((row) => row.components).find((component) => component.label === 'Weiter')!.custom_id as string;
    const next = new FakeInteraction('button', pageTwoId);
    await handleChecklistInteraction(next as never, db, new Date('2026-10-16T12:00:00.000Z'));
    const secondPage = componentJson(next.updates[0]!);
    const secondSelect = secondPage.flatMap((row) => row.components).find((component) => component.type === 3);
    assert.equal(secondSelect.options.length, 5);

    const selectionOnSecond = new FakeInteraction('select', secondSelect.custom_id as string, [itemIds[25]!]);
    await handleChecklistInteraction(selectionOnSecond as never, db, new Date('2026-10-16T12:00:00.000Z'));
    const saveId = secondPage.flatMap((row) => row.components).find((component) => component.label === 'Speichern')!.custom_id as string;
    const save = new FakeInteraction('button', saveId);
    await handleChecklistInteraction(save as never, db, new Date('2026-10-16T12:00:00.000Z'));

    assert.match(String(save.updates[0]?.content), /^Gespeichert: 3 von 30 erledigt\./);
    assert.deepEqual(getChecklistDoneItemIds(db, 'guild-1', 'user-1', eventKey), itemIds.slice(0, 2).concat(itemIds[25]!));
  } finally {
    db.close();
  }
});

test('opening a checklist opts into reminders and the reminder button toggles the preference', async () => {
  const db = openDb(':memory:');
  const { eventKey } = rewardEvent(db, 1);
  try {
    const opened = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
    await handleChecklistInteraction(opened as never, db, new Date('2026-10-16T12:00:00.000Z'));
    assert.equal(getChecklistReminderPreference(db, 'guild-1', 'user-1', eventKey), true);
    assert.deepEqual(getChecklistReminderRecipients(db, 'guild-1', eventKey, ['item-1']), [
      { userId: 'user-1', openItemIds: ['item-1'] },
    ]);

    const reminderId = componentJson(opened.replies[0]!).flatMap((row) => row.components).find((component) => component.label === 'Erinnerungen an/aus')!.custom_id as string;
    const toggle = new FakeInteraction('button', reminderId);
    await handleChecklistInteraction(toggle as never, db, new Date('2026-10-16T12:00:00.000Z'));
    assert.equal(getChecklistReminderPreference(db, 'guild-1', 'user-1', eventKey), false);
    assert.match(String(toggle.updates[0]?.content), /Erinnerungen sind jetzt aus/);
  } finally {
    db.close();
  }
});

test('unknown and expired checklists return German ephemeral errors', async () => {
  const db = openDb(':memory:');
  const { eventKey: expiredKey } = rewardEvent(db, 1, '2026-10-15T00:00:00.000Z');
  try {
    const unknown = new FakeInteraction('button', `ffe:cl:${'f'.repeat(32)}`);
    await handleChecklistInteraction(unknown as never, db, new Date('2026-10-16T12:00:00.000Z'));
    assert.equal(unknown.replies[0]?.flags, 64);
    assert.match(String(unknown.replies[0]?.content), /nicht mehr verfügbar/i);

    const expired = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(expiredKey).slice(0, 32)}`);
    await handleChecklistInteraction(expired as never, db, new Date('2026-10-16T12:00:00.000Z'));
    assert.equal(expired.replies[0]?.flags, 64);
    assert.match(String(expired.replies[0]?.content), /beendet/i);
  } finally {
    db.close();
  }
});

test('a checklist with changed rewards asks the player to reopen it', async () => {
  const db = openDb(':memory:');
  const { eventKey, eventId } = rewardEvent(db, 1);
  const sourceUrl = 'https://de.finalfantasyxiv.com/lodestone/special/mogmog/';
  try {
    const opened = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
    await handleChecklistInteraction(opened as never, db, new Date('2026-10-16T12:00:00.000Z'));
    applyField(db, eventId, 'rewards', { status: 'ok', value: [{ itemId: 'item-1', name: 'Neuer Name', section: 'Belohnungen' }] }, sourceUrl);

    const saveId = componentJson(opened.replies[0]!).flatMap((row) => row.components).find((component) => component.label === 'Speichern')!.custom_id as string;
    const save = new FakeInteraction('button', saveId);
    await handleChecklistInteraction(save as never, db, new Date('2026-10-16T12:00:00.000Z'));

    assert.match(String(save.updates[0]?.content), /Belohnungsliste hat sich geändert/);
  } finally {
    db.close();
  }
});

test('two ephemeral checklist panels keep independent drafts and use bounded custom ids', async () => {
  const db = openDb(':memory:');
  const { eventKey, itemIds } = rewardEvent(db, 2);
  const now = new Date('2026-10-16T12:00:00.000Z');
  try {
    const first = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
    await handleChecklistInteraction(first as never, db, now);
    const firstComponents = componentJson(first.replies[0]!);
    const firstSelectId = firstComponents.flatMap((row) => row.components).find((component) => component.type === 3)!.custom_id as string;
    const firstSaveId = firstComponents.flatMap((row) => row.components).find((component) => component.label === 'Speichern')!.custom_id as string;

    const select = new FakeInteraction('select', firstSelectId, [itemIds[0]!]);
    await handleChecklistInteraction(select as never, db, now);

    const second = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
    await handleChecklistInteraction(second as never, db, now);
    const allIds = [firstSelectId, firstSaveId, ...componentJson(second.replies[0]!).flatMap((row) => row.components.map((component: { custom_id?: string }) => component.custom_id).filter(Boolean) as string[])];
    assert.ok(allIds.every((id) => id.length <= 100));
    assert.ok(allIds.every((id) => id.includes(stableEventIdentity(eventKey).slice(0, 32))));

    const save = new FakeInteraction('button', firstSaveId);
    await handleChecklistInteraction(save as never, db, now);
    assert.deepEqual(getChecklistDoneItemIds(db, 'guild-1', 'user-1', eventKey), [itemIds[0]]);
  } finally {
    db.close();
  }
});

test('checklist panel sessions are bounded to 500 live panels', async () => {
  const db = openDb(':memory:');
  const { eventKey } = rewardEvent(db, 1);
  const now = new Date('2026-10-16T12:00:00.000Z');
  try {
    const first = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
    await handleChecklistInteraction(first as never, db, now);
    const oldSaveId = componentJson(first.replies[0]!).flatMap((row) => row.components).find((component) => component.label === 'Speichern')!.custom_id as string;
    for (let index = 0; index < 500; index += 1) {
      const panel = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
      await handleChecklistInteraction(panel as never, db, now);
    }

    const oldSave = new FakeInteraction('button', oldSaveId);
    await handleChecklistInteraction(oldSave as never, db, now);
    assert.match(String(oldSave.updates[0]?.content), /abgelaufen/i);
  } finally {
    db.close();
  }
});

test('checklist panel sessions expire after one hour', async () => {
  const db = openDb(':memory:');
  const { eventKey } = rewardEvent(db, 1);
  const openedAt = new Date('2026-10-16T12:00:00.000Z');
  try {
    const opened = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
    await handleChecklistInteraction(opened as never, db, openedAt);
    const saveId = componentJson(opened.replies[0]!).flatMap((row) => row.components).find((component) => component.label === 'Speichern')!.custom_id as string;
    const expired = new FakeInteraction('button', saveId);
    await handleChecklistInteraction(expired as never, db, new Date(openedAt.getTime() + 60 * 60 * 1_000 + 1));
    assert.match(String(expired.updates[0]?.content), /abgelaufen/i);
  } finally {
    db.close();
  }
});
