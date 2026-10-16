import assert from 'node:assert/strict';
import test from 'node:test';
import { handleChecklistInteraction, parseChecklistCustomId } from '../src/interactions/checklist.ts';
import { stableEventIdentity } from '../src/event-identity.ts';
import { assertDiscordComponentPayload } from './component-invariants.ts';
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
  failNextUpdate: Error | undefined;

  constructor(kind: 'button' | 'select', customId: string, values: string[] = []) {
    this.kind = kind;
    this.customId = customId;
    this.values = values;
  }

  isButton(): boolean { return this.kind === 'button'; }
  isStringSelectMenu(): boolean { return this.kind === 'select'; }
  inGuild(): boolean { return true; }
  async reply(options: Record<string, unknown>): Promise<void> {
    this.replies.push(options);
    if (Array.isArray(options.components)) assertDiscordComponentPayload(options.components as never);
  }
  async update(options: Record<string, unknown>): Promise<void> {
    if (this.failNextUpdate) {
      const error = this.failNextUpdate;
      this.failNextUpdate = undefined;
      throw error;
    }
    this.updates.push(options);
    if (Array.isArray(options.components)) assertDiscordComponentPayload(options.components as never);
  }
}

function componentJson(reply: Record<string, unknown>): Array<Record<string, any>> {
  const components = reply.components as Array<{ toJSON?: () => Record<string, any> }>;
  return assertDiscordComponentPayload(components as never) as Array<Record<string, any>>;
}

test('checklist button custom id round-trips event keys with colons and slashes', () => {
  const eventKey = 'seasonal-special:/lodestone/special/mogmog/';
  assert.deepEqual(parseChecklistCustomId(`ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`), {
    action: 'open', eventHash: stableEventIdentity(eventKey).slice(0, 32),
  });
});

test('pagination component ids encode their distinct roles', () => {
  const eventHash = 'a'.repeat(32);
  const panelToken = 'b'.repeat(32);
  for (const role of ['prev', 'cur', 'next'] as const) {
    assert.deepEqual(parseChecklistCustomId(`ffe:page:${eventHash}:${panelToken}:${role}:2`), {
      action: 'page', eventHash, panelToken, role, page: 2,
    });
  }
});

test('checklist panels satisfy Discord component constraints for one, two, and three pages', async () => {
  for (const [count, pageCount] of [[1, 1], [26, 2], [51, 3]] as const) {
    const db = openDb(':memory:');
    const { eventKey } = rewardEvent(db, count);
    const now = new Date('2026-10-16T12:00:00.000Z');
    try {
      const opened = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
      await handleChecklistInteraction(opened as never, db, now);
      const firstPage = componentJson(opened.replies[0]!);
      const rows = firstPage as Array<{ components: Array<Record<string, any>> }>;
      const pageRow = rows.find((row) => row.components.some((component) => component.label?.startsWith('Seite ')));

      if (pageCount === 1) {
        assert.equal(rows.length, 2);
        assert.equal(pageRow, undefined);
        assert.deepEqual(rows.flatMap((row) => row.components).map((component) => component.label).filter(Boolean), [
          'Erinnerungen an/aus', 'Speichern',
        ]);
      } else {
        assert.equal(rows.length, 3);
        assert.ok(pageRow);
        const [previous, indicator, next] = pageRow.components;
        assert.equal(previous?.disabled, true);
        assert.equal(indicator?.disabled, true);
        assert.equal(next?.disabled, false);
        assert.equal(indicator?.label, `Seite 1/${pageCount}`);
        const parsedPrevious = parseChecklistCustomId(previous!.custom_id);
        assert.equal(parsedPrevious?.action, 'page');
        if (parsedPrevious?.action === 'page') {
          assert.equal(parsedPrevious.role, 'prev');
          assert.equal(parsedPrevious.page, 1);
        }

        let nextButton = next!;
        for (let page = 2; page <= pageCount; page += 1) {
          const nextInteraction = new FakeInteraction('button', nextButton.custom_id);
          await handleChecklistInteraction(nextInteraction as never, db, now);
          const rendered = componentJson(nextInteraction.updates[0]!);
          const renderedRows = rendered as Array<{ components: Array<Record<string, any>> }>;
          const renderedPageRow = renderedRows.find((row) => row.components.some((component) => component.label?.startsWith('Seite ')))!;
          const [renderedPrevious, renderedIndicator, renderedNext] = renderedPageRow.components;
          assert.equal(renderedPrevious?.disabled, page === 1);
          assert.equal(renderedIndicator?.disabled, true);
          assert.equal(renderedNext?.disabled, page === pageCount);
          assert.equal(renderedIndicator?.label, `Seite ${page}/${pageCount}`);
          nextButton = renderedNext!;
        }
      }
    } finally {
      db.close();
    }
  }
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

test('checklist failures are logged and only return a generic player-facing error', async () => {
  const db = openDb(':memory:');
  const { eventKey } = rewardEvent(db, 1);
  const now = new Date('2026-10-16T12:00:00.000Z');
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const opened = new FakeInteraction('button', `ffe:cl:${stableEventIdentity(eventKey).slice(0, 32)}`);
    await handleChecklistInteraction(opened as never, db, now);
    const saveId = componentJson(opened.replies[0]!).flatMap((row) => row.components)
      .find((component) => component.label === 'Speichern')!.custom_id as string;
    const failure = new Error('private database detail');
    const save = new FakeInteraction('button', saveId);
    save.failNextUpdate = failure;
    await handleChecklistInteraction(save as never, db, now);

    assert.deepEqual(logged, [['Checkliste fehlgeschlagen:', failure]]);
    assert.equal(save.replies.length, 1);
    assert.match(String(save.replies[0]?.content), /konnte gerade nicht gespeichert werden/i);
    assert.doesNotMatch(String(save.replies[0]?.content), /private database detail/);
  } finally {
    console.error = originalError;
    db.close();
  }
});
