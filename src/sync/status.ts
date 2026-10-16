// Keeps the single pinned live status message current without needless edits.

import type { Store, StoreEvent } from '../store.ts';
import { deliverWarning, getGuild, setGuildStatusMessage } from '../store.ts';
import type { DiscordEmbed, DiscordMessageSnapshot, DiscordPort } from '../types.ts';

export interface SyncLiveStatusOptions {
  guildId: string;
  channelId: string;
  logChannelId?: string;
  events: readonly StoreEvent[];
  discord: DiscordPort;
  store: Store;
  now?: Date;
  suppressLogs?: boolean;
}

function statusEmbed(events: readonly StoreEvent[], now: Date): DiscordEmbed {
  const nowMs = now.getTime();
  const running = events
    .filter((event) => event.startStatus === 'ok' && event.endStatus === 'ok' && event.startUtc !== null && event.endUtc !== null)
    .filter((event) => Date.parse(event.startUtc!) <= nowMs && nowMs < Date.parse(event.endUtc!))
    .sort((left, right) => Date.parse(left.endUtc!) - Date.parse(right.endUtc!) || left.title.localeCompare(right.title));
  const lines = running.map((event) => `• **${event.title.slice(0, 256)}** — endet <t:${Math.floor(Date.parse(event.endUtc!) / 1_000)}:R>`);
  const overflow = '… Weitere Events sind im Event-Kanal aufgeführt.';
  let description = lines.join('\n');
  if (description.length > 4096) {
    while (lines.length > 0 && `${lines.join('\n')}\n${overflow}`.length > 4096) lines.pop();
    description = lines.length > 0 ? `${lines.join('\n')}\n${overflow}` : overflow;
  }
  if (!description) description = 'Gerade läuft kein Event.';
  return { title: 'Läuft gerade', description };
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
  suppressLogs = false,
  guildId,
}: SyncLiveStatusOptions): Promise<void> {
  const desired = statusEmbed(events, now);
  const payload = { embeds: [desired] };
  const guild = getGuild(store, guildId);
  let existing: DiscordMessageSnapshot | null = null;
  if (guild?.statusMessageId) {
    try {
      const fetched = await discord.fetchMessage(channelId, guild.statusMessageId);
      if (fetched?.authorIsBot && fetched.embeds.some((embed) => embed.title === 'Läuft gerade')) existing = fetched;
    } catch {
      // A removed status message falls back to pinned-message recovery.
    }
  }
  if (!existing) {
    const pinned = await discord.fetchPinnedBotMessages(channelId);
    existing = pinned.find((message) => message.authorIsBot && message.embeds.some((embed) => embed.title === 'Läuft gerade')) ?? null;
  }
  if (!existing) {
    const recent = await discord.fetchRecentBotMessages(channelId, 50);
    existing = recent.find((message) => message.authorIsBot && message.embeds.some((embed) => embed.title === 'Läuft gerade')) ?? null;
  }

  if (!existing) {
    const created = await discord.createMessage(channelId, payload);
    await discord.pinMessage(channelId, created.id);
    setGuildStatusMessage(store, guildId, created.id);
    if (!suppressLogs) {
      await deliverWarning(store, guildId, logChannelId, 'status-post:recreated',
        'Die Statusmeldung „Läuft gerade“ wurde neu erstellt und angeheftet.',
        (target, content) => discord.sendLog(target, content));
    }
    return;
  }

  const current = existing.embeds.find((embed) => embed.title === 'Läuft gerade');
  if (!existing.pinned) await discord.pinMessage(channelId, existing.id);
  setGuildStatusMessage(store, guildId, existing.id);
  if (current && !sameEmbed(current, desired)) {
    await discord.editMessage(channelId, existing.id, payload);
  }
}
