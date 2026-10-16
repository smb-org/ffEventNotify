// Renders player-facing German event embeds and synchronizes one message per event.

import type { Store, StoreEvent } from '../store.ts';
import { getGuildEventObject, setGuildDiscordIds } from '../store.ts';
import { stableEventIdentity } from '../event-identity.ts';
import type { DiscordEmbed, DiscordMessageSnapshot, DiscordPort } from '../types.ts';

export interface SyncEventEmbedOptions {
  event: StoreEvent;
  sourceUrls: readonly string[];
  guildId?: string;
  channelId: string;
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
  if (event.startUtc && event.endUtc) {
    const localPeriod = `${berlinDateTime(event.startUtc)} – ${berlinDateTime(event.endUtc)}`;
    return `${localPeriod}\n${timestamp(event.startUtc, 'F')} (${timestamp(event.startUtc, 'R')}) – ${timestamp(event.endUtc, 'F')} (${timestamp(event.endUtc, 'R')})`;
  }
  if (event.startUtc) {
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
    footer: { text: `Event-ID: ${stableEventIdentity(event.eventKey)}` },
  };
  if (event.title.length > 0 && !isUnverifiedPathFragment(event)) embed.title = event.title.slice(0, 256);

  if (event.rewardsStatus === 'n/a') return embed;

  if (event.rewardsStatus === 'unsicher' && event.rewards.length === 0) {
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

function hasExactSourceLink(description: string, sourceUrls: readonly string[]): boolean {
  const links = [...description.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]);
  return links.some((link) => sourceUrls.includes(link ?? ''));
}

export async function syncEventEmbed({
  event,
  sourceUrls,
  guildId = 'guild',
  channelId,
  discord,
  store,
  now,
}: SyncEventEmbedOptions): Promise<string> {
  const embed = buildEventEmbed(event, sourceUrls, now);
  const payload = { embeds: [embed] };
  const recent = await discord.fetchRecentBotMessages(channelId, 50);
  const marker = embed.footer!.text;
  const stableMatches = recent.filter((message) => message.authorIsBot && message.embeds.some((candidate) => candidate.footer?.text === marker));
  if (stableMatches.length > 1) throw new Error(`Mehrere Discord-Meldungen tragen dieselbe Event-ID ${marker}.`);
  const stableMatch = stableMatches[0];
  const legacyMatches = recent.filter((message) => message.authorIsBot && message.embeds.some((candidate) =>
    candidate.footer?.text === String(event.id) && candidate.title === event.title &&
    hasExactSourceLink(candidate.description ?? '', sourceUrls),
  ));
  if (legacyMatches.length > 1) throw new Error(`Mehrere ältere Discord-Meldungen passen zu Event-ID ${event.id}.`);
  const legacyMatch = legacyMatches[0];
  const object = getGuildEventObject(store, guildId, event.eventKey);
  let stored: DiscordMessageSnapshot | null = null;
  if (object?.messageId && object.messageChannelId === channelId) {
    try {
      const fetched = await discord.fetchMessage(channelId, object.messageId);
      if (fetched?.authorIsBot && fetched.embeds.some((candidate) => candidate.footer?.text === marker)) stored = fetched;
    } catch {
      // A deleted message is treated as missing; the marker search below can still recover it.
    }
  }
  const existing = stored ?? stableMatch ?? legacyMatch;

  if (existing) {
    setGuildDiscordIds(store, guildId, event.eventKey, { messageId: existing.id, messageChannelId: channelId });
    const currentEmbed = existing.embeds.find((candidate) => candidate.footer?.text === marker) ?? existing.embeds.find((candidate) =>
      candidate.footer?.text === String(event.id) && candidate.title === event.title &&
      hasExactSourceLink(candidate.description ?? '', sourceUrls),
    );
    if (!currentEmbed || !samePayload(currentEmbed, embed)) {
      await discord.editMessage(channelId, existing.id, payload);
    }
    return existing.id;
  }

  const created = await discord.createMessage(channelId, payload);
  setGuildDiscordIds(store, guildId, event.eventKey, { messageId: created.id, messageChannelId: channelId });
  return created.id;
}
