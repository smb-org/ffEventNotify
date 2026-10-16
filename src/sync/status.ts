// Keeps the single pinned live status message current without needless edits.

import type { Store, StoreEvent } from '../store.ts';
import { warnOnce } from '../store.ts';
import type { DiscordEmbed, DiscordPort } from '../types.ts';

export interface SyncLiveStatusOptions {
  guildId: string;
  channelId: string;
  logChannelId?: string;
  events: readonly StoreEvent[];
  discord: DiscordPort;
  store: Store;
  now?: Date;
}

function statusEmbed(events: readonly StoreEvent[], now: Date): DiscordEmbed {
  const nowMs = now.getTime();
  const running = events
    .filter((event) => event.startStatus === 'ok' && event.endStatus === 'ok' && event.startUtc !== null && event.endUtc !== null)
    .filter((event) => Date.parse(event.startUtc!) <= nowMs && nowMs < Date.parse(event.endUtc!))
    .sort((left, right) => Date.parse(left.endUtc!) - Date.parse(right.endUtc!) || left.title.localeCompare(right.title));
  const lines = running.map((event) => `• **${event.title}** — endet <t:${Math.floor(Date.parse(event.endUtc!) / 1_000)}:R>`);
  return { title: 'Läuft gerade', description: lines.length > 0 ? lines.join('\n') : 'Gerade läuft kein Event.' };
}

function sameEmbed(left: DiscordEmbed, right: DiscordEmbed): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function syncLiveStatusPost({
  channelId,
  logChannelId = channelId,
  events,
  discord,
  store,
  now = new Date(),
}: SyncLiveStatusOptions): Promise<void> {
  const desired = statusEmbed(events, now);
  const payload = { embeds: [desired] };
  const recent = await discord.fetchRecentBotMessages(channelId, 50);
  const existing = recent.find((message) => message.authorIsBot && message.embeds.some((embed) => embed.title === 'Läuft gerade'));

  if (!existing) {
    const created = await discord.createMessage(channelId, payload);
    await discord.pinMessage(channelId, created.id);
    if (warnOnce(store, 'status-post:recreated')) {
      await discord.sendLog(logChannelId, 'Die Statusmeldung „Läuft gerade“ wurde neu erstellt und angeheftet.');
    }
    return;
  }

  const current = existing.embeds.find((embed) => embed.title === 'Läuft gerade');
  if (!existing.pinned) await discord.pinMessage(channelId, existing.id);
  if (current && !sameEmbed(current, desired)) {
    try {
      await discord.editMessage(channelId, existing.id, payload);
    } catch (error) {
      if (warnOnce(store, 'status-post:edit-failed')) {
        await discord.sendLog(logChannelId, `Die Statusmeldung „Läuft gerade“ konnte nicht bearbeitet werden: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
