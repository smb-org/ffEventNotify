import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRecentBotMessages } from '../src/discord-history.ts';

test('history pagination collects bot messages beyond interleaved user posts', async () => {
  const history = [
    ...Array.from({ length: 100 }, (_, index) => ({ id: `user-${index}`, authorId: 'user' })),
    { id: 'crash-recovery-post', authorId: 'bot' },
    ...Array.from({ length: 55 }, (_, index) => ({ id: `bot-${index}`, authorId: 'bot' })),
  ];
  const pages: Array<{ before?: string; size: number }> = [];
  const result = await collectRecentBotMessages(async (size, before) => {
    pages.push({ ...(before ? { before } : {}), size });
    const start = before === undefined ? 0 : history.findIndex((message) => message.id === before) + 1;
    return history.slice(start, start + size);
  }, 'bot', 50);

  assert.equal(result.messages.length, 50);
  assert.equal(result.messages[0]?.id, 'crash-recovery-post');
  assert.equal(result.complete, true);
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.size, 100);
  assert.equal(pages[1]?.before, 'user-99');
});

test('history recovery crosses ten pages of user messages before finding its bot boundary', async () => {
  const history = [
    ...Array.from({ length: 1_000 }, (_, index) => ({ id: `user-${index}`, authorId: 'user' })),
    { id: 'older-bot-post', authorId: 'bot' },
    ...Array.from({ length: 55 }, (_, index) => ({ id: `bot-${index}`, authorId: 'bot' })),
  ];
  const result = await collectRecentBotMessages(async (size, before) => {
    const start = before === undefined ? 0 : history.findIndex((message) => message.id === before) + 1;
    return history.slice(start, start + size);
  }, 'bot', 50);

  assert.equal(result.complete, true);
  assert.equal(result.messages[0]?.id, 'older-bot-post');
  assert.equal(result.pagesFetched, 11);
});

test('history search reports inconclusive when its page cap arrives before the recovery boundary', async () => {
  const result = await collectRecentBotMessages(async (size, before) => {
    const page = Number(before ?? 0);
    return Array.from({ length: size }, (_, index) => ({ id: String(page * size + index + 1), authorId: 'user' }));
  }, 'bot', 200, { pageSize: 100, maxPages: 20 });

  assert.deepEqual(result.messages, []);
  assert.equal(result.complete, false);
  assert.equal(result.pagesFetched, 20);
});

test('history search confirms absence after exhausting a short channel', async () => {
  const result = await collectRecentBotMessages(async () => [
    { id: 'user-1', authorId: 'user' },
    { id: 'user-2', authorId: 'user' },
  ], 'bot', 200);
  assert.equal(result.complete, true);
  assert.equal(result.pagesFetched, 1);
});

test('history cutoff stays inconclusive when 200 newer bot posts hide the target and precede the attempt boundary', async () => {
  const firstAttemptAt = '2026-10-16T12:00:00.000Z';
  const history = [
    ...Array.from({ length: 201 }, (_, index) => ({
      id: `newer-${index}`,
      authorId: 'bot',
      createdAt: '2026-10-16T12:01:00.000Z',
    })),
    { id: 'target', authorId: 'bot', createdAt: '2026-10-16T12:00:01.000Z' },
    { id: 'before-attempt', authorId: 'bot', createdAt: '2026-10-16T11:59:00.000Z' },
  ];
  const result = await collectRecentBotMessages(async (size, before) => {
    const start = before === undefined ? 0 : history.findIndex((message) => message.id === before) + 1;
    return history.slice(start, start + size);
  }, 'bot', 200, { pageSize: 100, maxPages: 20, olderThan: firstAttemptAt });

  assert.equal(result.messages.some((message) => message.id === 'target'), false);
  assert.equal(result.complete, false);
});
