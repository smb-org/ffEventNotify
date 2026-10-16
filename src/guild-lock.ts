// Serializes Discord writes per guild while allowing the same sync path to call locked helpers.

import { AsyncLocalStorage } from 'node:async_hooks';

const activeGuilds = new AsyncLocalStorage<ReadonlySet<string>>();
const guildTails = new Map<string, Promise<void>>();

export async function withGuildDiscordLock<T>(guildId: string, action: () => Promise<T> | T): Promise<T> {
  const active = activeGuilds.getStore();
  if (active?.has(guildId)) return action();

  const previous = guildTails.get(guildId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  guildTails.set(guildId, current);
  await previous;

  try {
    const nextActive = new Set(active ?? []);
    nextActive.add(guildId);
    return await activeGuilds.run(nextActive, action);
  } finally {
    release();
    if (guildTails.get(guildId) === current) guildTails.delete(guildId);
  }
}
