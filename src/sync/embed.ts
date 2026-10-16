// Renders player-facing German event embeds and synchronizes one message per event.

import type { Store, StoreEvent } from '../store.ts';
import { setDiscordIds, warnOnce } from '../store.ts';
import type { DiscordEmbed, DiscordPort } from '../types.ts';

export interface SyncEventEmbedOptions {
  event: StoreEvent;
  sourceUrls: readonly string[];
  channelId: string;
  logChannelId?: string;
  discord: DiscordPort;
  store: Store;
  now?: Date;
}

interface EmbedField {
  name: string;
  value: string;
}

const MAX_FIELD_VALUE = 1_024;
const MAX_FIELDS = 25;
const MAX_EMBED_CHARACTERS = 5_500;

function sourceUrl(sourceUrls: readonly string[]): string | undefined {
  const urls = [...new Set(sourceUrls)].filter((url) => {
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  });
  const specialPages = urls.filter((url) => new URL(url).pathname.startsWith('/lodestone/special/'));
  return [...(specialPages.length > 0 ? specialPages : urls)].sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
}

function berlinDateTime(utc: string): string {
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${formatter.format(new Date(utc))} Uhr`;
}

function timestamp(utc: string, style: 'F' | 'R'): string {
  return `<t:${Math.floor(Date.parse(utc) / 1_000)}:${style}>`;
}

function eventDescription(event: StoreEvent, link?: string): string {
  if (event.startStatus === 'ok' && event.endStatus === 'ok' && event.startUtc && event.endUtc) {
    const localPeriod = `${berlinDateTime(event.startUtc)} – ${berlinDateTime(event.endUtc)}`;
    return `${localPeriod}\n${timestamp(event.startUtc, 'F')} (${timestamp(event.startUtc, 'R')}) – ${timestamp(event.endUtc, 'F')} (${timestamp(event.endUtc, 'R')})`;
  }
  if (event.startStatus === 'ok' && event.startUtc) {
    const verifiedStart = `Beginn: ${berlinDateTime(event.startUtc)}\n${timestamp(event.startUtc, 'F')} (${timestamp(event.startUtc, 'R')})`;
    const sourceLink = link ? `\n[Zur Ankündigung](${link})` : '';
    return `${verifiedStart}\nEnde: siehe Lodestone${sourceLink}`;
  }
  return link ? `Zeitraum: siehe Lodestone\n[Zur Ankündigung](${link})` : 'Zeitraum: siehe Lodestone';
}

function rewardLine(itemId: string, name: string): string {
  const url = `https://de.finalfantasyxiv.com/lodestone/playguide/db/item/${encodeURIComponent(itemId)}/`;
  const maxNameLength = MAX_FIELD_VALUE - url.length - 4;
  const safeName = name.length > maxNameLength ? `${name.slice(0, Math.max(0, maxNameLength - 1))}…` : name;
  return `[${safeName}](${url})`;
}

function groupedFields(rewards: StoreEvent['rewards'], included: number): EmbedField[] {
  const groups = new Map<string, string[]>();
  for (const reward of rewards.slice(0, included)) {
    const group = groups.get(reward.section) ?? [];
    group.push(rewardLine(reward.itemId, reward.name));
    groups.set(reward.section, group);
  }

  const fields: EmbedField[] = [];
  for (const [section, lines] of groups) {
    const chunks: string[] = [];
    let value = '';
    for (const line of lines) {
      const next = value ? `${value}\n${line}` : line;
      if (next.length > MAX_FIELD_VALUE && value) {
        chunks.push(value);
        value = line;
      } else {
        value = next;
      }
    }
    if (value) chunks.push(value);
    const safeSection = section.slice(0, 256);
    chunks.forEach((chunk, index) => fields.push({
      name: chunks.length === 1 ? safeSection : `${safeSection} (${index + 1}/${chunks.length})`.slice(0, 256),
      value: chunk,
    }));
  }
  return fields;
}

function characterCount(embed: DiscordEmbed): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) + (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

function fieldsWithOverflow(
  rewards: StoreEvent['rewards'],
  included: number,
  link?: string,
): EmbedField[] | undefined {
  const fields = groupedFields(rewards, included);
  const remaining = rewards.length - included;
  if (remaining === 0) return fields;

  const destination = link ? `[Sonderseite](${link})` : 'Sonderseite';
  const line = `… und ${remaining} weitere Belohnungen auf der ${destination}`;
  const last = fields.at(-1);
  if (last && last.value.length + 1 + line.length <= MAX_FIELD_VALUE) {
    last.value += `\n${line}`;
    return fields;
  }
  if (fields.length < MAX_FIELDS && line.length <= MAX_FIELD_VALUE) {
    fields.push({ name: 'Weitere Belohnungen', value: line });
    return fields;
  }
  return undefined;
}

function isUnverifiedPathFragment(event: StoreEvent): boolean {
  const prefix = 'seasonal-special:';
  if (event.titleStatus !== 'unsicher' || !event.eventKey.startsWith(prefix)) return false;
  const fragment = event.eventKey.slice(prefix.length).split('/').filter(Boolean).at(-1);
  return fragment !== undefined && event.title === fragment.replace(/[_-]+/g, ' ');
}

export function buildEventEmbed(event: StoreEvent, sourceUrls: readonly string[], now = new Date()): DiscordEmbed {
  void now;
  const link = sourceUrl(sourceUrls);
  const embed: DiscordEmbed = {
    description: eventDescription(event, link),
    footer: { text: String(event.id) },
  };
  if (event.title.length > 0 && !isUnverifiedPathFragment(event)) embed.title = event.title.slice(0, 256);

  if (event.rewardsStatus === 'n/a') return embed;

  if (event.rewardsStatus === 'unsicher') {
    const value = link
      ? `Belohnungen: siehe Sonderseite\n[Zur Sonderseite](${link})`
      : 'Belohnungen: siehe Sonderseite';
    embed.fields = [{ name: 'Belohnungen', value: value.slice(0, MAX_FIELD_VALUE) }];
    return embed;
  }

  let included = event.rewards.length;
  let fields = fieldsWithOverflow(event.rewards, included, link);
  if (fields === undefined || fields.length > MAX_FIELDS || characterCount({ ...embed, fields }) > MAX_EMBED_CHARACTERS) {
    for (included = event.rewards.length - 1; included >= 0; included -= 1) {
      fields = fieldsWithOverflow(event.rewards, included, link);
      if (fields !== undefined && fields.length <= MAX_FIELDS && characterCount({ ...embed, fields }) <= MAX_EMBED_CHARACTERS) break;
    }
  }
  if (fields !== undefined && fields.length > 0) embed.fields = fields;
  return embed;
}

function samePayload(left: DiscordEmbed, right: DiscordEmbed): boolean {
  const normalized = (embed: DiscordEmbed) => ({
    title: embed.title ?? null,
    description: embed.description ?? null,
    fields: (embed.fields ?? []).map((field) => ({
      name: field.name,
      value: field.value,
      inline: field.inline ?? false,
    })),
    footer: embed.footer?.text ?? null,
  });
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

export async function syncEventEmbed({
  event,
  sourceUrls,
  channelId,
  logChannelId = channelId,
  discord,
  store,
  now,
}: SyncEventEmbedOptions): Promise<string> {
  const embed = buildEventEmbed(event, sourceUrls, now);
  const payload = { embeds: [embed] };
  const recent = await discord.fetchRecentBotMessages(channelId, 50);
  const matched = recent.find((message) => message.authorIsBot && message.embeds.some((candidate) => candidate.footer?.text === String(event.id)));
  const stored = event.discordMessageId === null
    ? undefined
    : recent.find((message) => message.id === event.discordMessageId);
  const existing = stored ?? matched;

  if (existing) {
    setDiscordIds(store, event.id, { discordMessageId: existing.id });
    const currentEmbed = existing.embeds.find((candidate) => candidate.footer?.text === String(event.id));
    if (!currentEmbed || !samePayload(currentEmbed, embed)) {
      try {
        await discord.editMessage(channelId, existing.id, payload);
      } catch (error) {
        if (warnOnce(store, `event-message:edit-failed:${event.id}`)) {
          await discord.sendLog(logChannelId, `Die Meldung zu „${event.title}“ konnte nicht bearbeitet werden.`);
        }
      }
    }
    return existing.id;
  }

  if (event.discordMessageId !== null) {
    try {
      await discord.editMessage(channelId, event.discordMessageId, payload);
    } catch (error) {
      if (warnOnce(store, `event-message:edit-failed:${event.id}`)) {
        await discord.sendLog(logChannelId, `Die Meldung zu „${event.title}“ konnte nicht bearbeitet werden.`);
      }
    }
    return event.discordMessageId;
  }

  const created = await discord.createMessage(channelId, payload);
  setDiscordIds(store, event.id, { discordMessageId: created.id });
  return created.id;
}
