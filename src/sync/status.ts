// Keeps the single pinned live status message current without needless edits.

import type { StoreEvent } from '../store.ts';
import { deliverWarning, getGuild, getGuildEventObject, setGuildStatusMessage, type Store } from '../store.ts';
import { withGuildDiscordLock } from '../guild-lock.ts';
import { hasEventMarkerUrl } from '../event-identity.ts';
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

async function statusEmbed(
  events: readonly StoreEvent[],
  now: Date,
  guildId: string,
  channelId: string,
  store: Store,
  discord: DiscordPort,
): Promise<DiscordEmbed> {
  const nowMs = now.getTime();
  const running = events
    .filter((event) => event.startStatus === 'ok' && event.startUtc !== null && (
      event.endStatus === 'ok' && event.endUtc !== null || event.endStatus === 'unsicher' && event.endPatch !== null
    ))
    .filter((event) => Date.parse(event.startUtc!) <= nowMs && (
      event.endStatus === 'ok' && event.endUtc ? nowMs < Date.parse(event.endUtc) : true
    ))
    .sort((left, right) => (left.endStatus === 'ok' && left.endUtc ? Date.parse(left.endUtc) : Number.POSITIVE_INFINITY) -
      (right.endStatus === 'ok' && right.endUtc ? Date.parse(right.endUtc) : Number.POSITIVE_INFINITY) || left.title.localeCompare(right.title));
  const lines: string[] = [];
  for (const event of running) {
    const displayTitle = event.titleStatus === 'ok' ? event.title : 'FFXIV-Event';
    const title = displayTitle.slice(0, 256).replace(/[\\[\]()*_~`|>]/g, '\\$&');
    const guildEvent = getGuildEventObject(store, guildId, event.eventKey);
    const storedGuild = getGuild(store, guildId);
    let cardLink: string | undefined;
    if (guildEvent?.messageId && guildEvent.messageChannelId === channelId && storedGuild?.eventChannelId === channelId) {
      const card = await discord.fetchMessage(channelId, guildEvent.messageId);
      if (card?.authorIsBot && card.embeds.some((embed) => embed.url && hasEventMarkerUrl(embed.url, event.eventKey))) {
        cardLink = `https://discord.com/channels/${guildId}/${channelId}/${guildEvent.messageId}`;
      }
    }
    const linkedTitle = cardLink ? `[${title}](<${cardLink}>)` : title;
    const ending = event.endStatus === 'ok' && event.endUtc
      ? `endet <t:${Math.floor(Date.parse(event.endUtc) / 1_000)}:R>`
      : `bis Patch ${event.endPatch}`;
    lines.push(`• ${linkedTitle} — ${ending}`);
  }
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

async function syncLiveStatusPostUnlocked({
  channelId,
  logChannelId = channelId,
  events,
  discord,
  store,
  now = new Date(),
  suppressLogs = false,
  guildId,
}: SyncLiveStatusOptions): Promise<void> {
  const desired = await statusEmbed(events, now, guildId, channelId, store, discord);
  const payload = { embeds: [desired] };
  const guild = getGuild(store, guildId);
  let existing: DiscordMessageSnapshot | null = null;
  if (guild?.statusMessageId) {
    const fetched = await discord.fetchMessage(channelId, guild.statusMessageId);
    if (fetched?.authorIsBot && fetched.embeds.some((embed) => embed.title === 'Läuft gerade')) existing = fetched;
  }
  if (!existing) {
    const pinned = await discord.fetchPinnedBotMessages(channelId);
    existing = pinned.find((message) => message.authorIsBot && message.embeds.some((embed) => embed.title === 'Läuft gerade')) ?? null;
  }
  if (!existing) {
    const history = await discord.fetchRecentBotMessages(channelId, 2_000, { requireChannelStart: true });
    if (!history.complete) {
      if (!suppressLogs) {
        await deliverWarning(store, guildId, logChannelId, 'status-post:recovery-incomplete',
          'Die vorhandene Statusmeldung konnte nicht vollständig gesucht werden. Es wurde keine neue erstellt; der Bot versucht es erneut.',
          (target, content) => discord.sendLog(target, content));
      }
      return;
    }
    existing = history.messages.find((message) => message.authorIsBot && message.embeds.some((embed) => embed.title === 'Läuft gerade')) ?? null;
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

export function syncLiveStatusPost(options: SyncLiveStatusOptions): Promise<void> {
  return withGuildDiscordLock(options.guildId, () => syncLiveStatusPostUnlocked(options));
}
