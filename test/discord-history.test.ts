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
  const fetched = await collectRecentBotMessages(async (size, before) => {
    pages.push({ ...(before ? { before } : {}), size });
    const start = before === undefined ? 0 : history.findIndex((message) => message.id === before) + 1;
    return history.slice(start, start + size);
  }, 'bot', 50);

  assert.equal(fetched.length, 50);
  assert.equal(fetched[0]?.id, 'crash-recovery-post');
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.size, 100);
  assert.equal(pages[1]?.before, 'user-99');
});
