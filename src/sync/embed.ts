// Renders player-facing German event embeds and synchronizes one message per event.

import type { Store, StoreEvent } from '../store.ts';
import { ensureGuildEventFirstPostAttemptAt, getGuildEventObject, isAllowedSpecialImageUrl, setGuildDiscordIds } from '../store.ts';
import { withGuildDiscordLock } from '../guild-lock.ts';
import {
  bestEventSourceUrl,
  eventSourceLink,
  hasEventMarkerUrl,
  stableEventIdentity,
} from '../event-identity.ts';
import type { DiscordActionRow, DiscordEmbed, DiscordMessagePayload, DiscordMessageSnapshot, DiscordPort } from '../types.ts';

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
  inline?: boolean;
}

const MAX_FIELD_VALUE = 1_024;
const MAX_FIELDS = 25;
const MAX_EMBED_CHARACTERS = 5_500;

function timestamp(utc: string, style: 'f' | 'R'): string {
  return `<t:${Math.floor(Date.parse(utc) / 1_000)}:${style}>`;
}

function timeFields(event: StoreEvent): EmbedField[] {
  if (!event.startUtc) return [];
  const fields: EmbedField[] = [{ name: 'Beginn', value: timestamp(event.startUtc, 'f'), inline: true }];
  if (event.endUtc) {
    fields.push(
      { name: 'Ende', value: timestamp(event.endUtc, 'f'), inline: true },
      { name: 'Endet', value: timestamp(event.endUtc, 'R'), inline: true },
    );
  } else if (event.endStatus === 'unsicher' && event.endPatch) {
    fields.push({ name: 'Ende', value: `mit der Wartung zu Patch ${event.endPatch} (Datum folgt)`, inline: true });
  }
  return fields;
}

function eventDescription(event: StoreEvent): string | undefined {
  if (event.startStatus !== 'ok' || !event.startUtc) return 'Zeitraum: siehe Lodestone';
  if (event.endStatus !== 'ok' || !event.endUtc) return 'Ende: siehe Lodestone';
  return undefined;
}

function eventPresentation(event: StoreEvent, sourceUrl: string | undefined): { author: string; color: number } {
  if (event.eventType === 'seasonal-special') {
    let isMogMog = false;
    try {
      isMogMog = new URL(sourceUrl ?? '').pathname.includes('mogmog-collection');
    } catch {
      isMogMog = false;
    }
    return isMogMog
      ? { author: 'Mog Mog-Kollektion · Lodestone', color: 0xF1C40F }
      : { author: 'Saison-Event · Lodestone', color: 0xE67E22 };
  }
  if (event.eventType === 'maintenance') return { author: 'Wartung · Lodestone', color: 0x95A5A6 };
  return { author: 'News · Lodestone', color: 0x5865F2 };
}

function itemUrl(itemId: string): string {
  return `https://de.finalfantasyxiv.com/lodestone/playguide/db/item/${encodeURIComponent(itemId)}/`;
}

function rewardLine(itemId: string, name: string, maxNameLength: number): string {
  const url = itemUrl(itemId);
  const safeName = name.length > maxNameLength
    ? `${name.slice(0, Math.max(0, maxNameLength - 1))}…`
    : name;
  return `[${safeName}](${url})`;
}

function rewardGroups(rewards: StoreEvent['rewards']): Array<{ section: string; rewards: StoreEvent['rewards'] }> {
  const groups = new Map<string, StoreEvent['rewards']>();
  for (const reward of rewards) {
    const section = groups.get(reward.section) ?? [];
    section.push(reward);
    groups.set(reward.section, section);
  }
  return [...groups].map(([section, grouped]) => ({ section, rewards: grouped }));
}

function sectionField(
  section: string,
  rewards: StoreEvent['rewards'],
  maxVisible: number,
  additionallyOmitted: number,
): EmbedField {
  let visible = Math.min(8, maxVisible, rewards.length);
  while (visible > 0) {
    const omitted = rewards.length - visible + additionallyOmitted;
    const overflow = omitted > 0 ? `… und ${omitted} weitere auf der Sonderseite` : '';
    const selected = rewards.slice(0, visible);
    const linkOverhead = selected.reduce((sum, reward) => sum + itemUrl(reward.itemId).length + 4, 0);
    const separators = Math.max(0, visible - 1) + (overflow && visible > 0 ? 1 : 0);
    const nameBudget = MAX_FIELD_VALUE - linkOverhead - separators - overflow.length;
    if (nameBudget >= 0) {
      const nameLength = Math.floor(nameBudget / visible);
      const lines = selected.map((reward) => rewardLine(reward.itemId, reward.name, nameLength));
      const value = [...lines, ...(overflow ? [overflow] : [])].join('\n');
      return { name: section.slice(0, 256), value };
    }
    visible -= 1;
  }
  const omitted = rewards.length + additionallyOmitted;
  return {
    name: section.slice(0, 256),
    value: `… und ${omitted} weitere auf der Sonderseite`.slice(0, MAX_FIELD_VALUE),
  };
}

function characterCount(embed: DiscordEmbed): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.author?.name.length ?? 0) +
    (embed.footer?.text.length ?? 0) + (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

function rewardFields(event: StoreEvent, baseEmbed: DiscordEmbed, fixedFields: EmbedField[]): EmbedField[] {
  if (event.rewardsStatus === 'n/a') return [];
  if (event.rewardsStatus === 'unsicher' && event.rewards.length === 0) {
    return [{ name: 'Belohnungen', value: 'Belohnungen: siehe Sonderseite' }];
  }
  if (event.rewards.length === 0) return [];

  const groups = rewardGroups(event.rewards);
  const availableSlots = Math.max(0, MAX_FIELDS - fixedFields.length);
  for (let groupCount = Math.min(groups.length, availableSlots); groupCount >= 1; groupCount -= 1) {
    const omittedLater = groups.slice(groupCount).reduce((sum, group) => sum + group.rewards.length, 0);
    const fields = groups.slice(0, groupCount).map((group, index) => sectionField(
      group.section,
      group.rewards,
      8,
      index === groupCount - 1 ? omittedLater : 0,
    ));
    const allFields = [...fixedFields, ...fields];
    if (allFields.length <= MAX_FIELDS && characterCount({ ...baseEmbed, fields: allFields }) <= MAX_EMBED_CHARACTERS) return fields;
  }

  const total = event.rewards.length;
  const value = `… und ${total} weitere auf der Sonderseite`;
  if (availableSlots > 0 && characterCount({ ...baseEmbed, fields: [...fixedFields, { name: 'Belohnungen', value }] }) <= MAX_EMBED_CHARACTERS) {
    return [{ name: 'Belohnungen', value }];
  }
  return [];
}

function isUnverifiedPathFragment(event: StoreEvent): boolean {
  const prefix = 'seasonal-special:';
  if (event.titleStatus !== 'unsicher' || !event.eventKey.startsWith(prefix)) return false;
  const fragment = event.eventKey.slice(prefix.length).split('/').filter(Boolean).at(-1);
  return fragment !== undefined && event.title === fragment.replace(/[_-]+/g, ' ');
}

export function buildEventComponents(event: StoreEvent, sourceUrls: readonly string[]): DiscordActionRow[] {
  const sourceUrl = bestEventSourceUrl(sourceUrls);
  const buttons: DiscordActionRow['components'] = [];
  if (event.rewardsStatus === 'ok' && event.rewards.length > 0) {
    buttons.push({
      type: 'button',
      style: 'primary',
      label: 'Meine Checkliste',
      customId: `ffe:cl:${stableEventIdentity(event.eventKey).slice(0, 32)}`,
    });
  }
  if (sourceUrl) {
    const isSpecial = new URL(sourceUrl).pathname.startsWith('/lodestone/special/');
    buttons.push({
      type: 'button',
      style: 'link',
      label: isSpecial ? 'Zur Sonderseite' : 'Zur Ankündigung',
      url: sourceUrl,
    });
  }
  return buttons.length > 0 ? [{ components: buttons }] : [];
}

export function buildEventEmbed(event: StoreEvent, sourceUrls: readonly string[], _now = new Date()): DiscordEmbed {
  const sourceUrl = bestEventSourceUrl(sourceUrls);
  const sourceLink = eventSourceLink(event.eventKey, sourceUrls);
  const presentation = eventPresentation(event, sourceUrl);
  const fixedFields = timeFields(event);
  const embed: DiscordEmbed = {
    author: { name: presentation.author },
    color: presentation.color,
    footer: { text: 'Quelle: Lodestone' },
    ...(sourceLink ? { url: sourceLink } : {}),
  };
  if (event.title.length > 0 && !isUnverifiedPathFragment(event)) embed.title = event.title.slice(0, 256);
  const description = eventDescription(event);
  if (description) embed.description = description;
  if (event.imageUrl && isAllowedSpecialImageUrl(event.imageUrl)) embed.image = { url: event.imageUrl };
  const fields = [...fixedFields, ...rewardFields(event, embed, fixedFields)];
  if (fields.length > 0) embed.fields = fields;
  return embed;
}

export function samePayload(
  left: Pick<DiscordMessagePayload, 'content' | 'embeds' | 'components'>,
  right: Pick<DiscordMessagePayload, 'content' | 'embeds' | 'components'>,
): boolean {
  const normalizeEmbed = (embed: DiscordEmbed) => ({
    title: embed.title ?? null,
    url: embed.url ?? null,
    description: embed.description ?? null,
    color: embed.color ?? null,
    author: embed.author?.name ?? null,
    image: embed.image?.url ?? null,
    fields: (embed.fields ?? []).map((field) => ({
      name: field.name,
      value: field.value,
      inline: field.inline ?? false,
    })),
    footer: embed.footer?.text ?? null,
  });
  const normalizeComponent = (component: DiscordActionRow['components'][number]) => component.type === 'button'
    ? {
      type: component.type,
      style: component.style,
      label: component.label,
      customId: component.customId ?? null,
      url: component.url ?? null,
      disabled: component.disabled ?? false,
    }
    : {
      type: component.type,
      customId: component.customId,
      placeholder: component.placeholder || null,
      minValues: component.minValues ?? 1,
      maxValues: component.maxValues ?? 1,
      options: component.options.map((option) => ({
        label: option.label,
        value: option.value,
        description: option.description || null,
        default: option.default ?? false,
      })),
    };
  const normalize = (payload: Pick<DiscordMessagePayload, 'content' | 'embeds' | 'components'>) => ({
    content: payload.content ?? '',
    embeds: (payload.embeds ?? []).map(normalizeEmbed),
    components: (payload.components ?? []).map((row) => row.components.map(normalizeComponent)),
  });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function exactSourceInDescription(description: string, sourceUrls: readonly string[]): boolean {
  const links = [...description.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]);
  return links.some((link) => sourceUrls.includes(link ?? ''));
}

function hasLegacyMarker(embed: DiscordEmbed, event: StoreEvent, sourceUrls: readonly string[]): boolean {
  const footer = embed.footer?.text;
  if (footer === `Event-ID: ${stableEventIdentity(event.eventKey)}`) return true;
  const legacyNumeric = footer === String(event.id) || footer === `Event-ID: ${event.id}`;
  if (!legacyNumeric || embed.title !== event.title) return false;
  let embedUrlMatches = false;
  if (embed.url !== undefined) {
    try {
      const url = new URL(embed.url);
      url.hash = '';
      embedUrlMatches = sourceUrls.includes(url.toString().replace(/\/$/, '') === embed.url.replace(/\/$/, '')
        ? url.toString()
        : `${url.origin}${url.pathname}`);
    } catch {
      embedUrlMatches = false;
    }
  }
  return exactSourceInDescription(embed.description ?? '', sourceUrls) || embedUrlMatches;
}

function embedHasMarker(embed: DiscordEmbed, event: StoreEvent): boolean {
  return embed.url !== undefined && hasEventMarkerUrl(embed.url, event.eventKey);
}

async function syncEventEmbedUnlocked({
  event,
  sourceUrls,
  guildId = 'guild',
  channelId,
  discord,
  store,
  now,
}: SyncEventEmbedOptions): Promise<string> {
  const syncNow = now ?? new Date();
  const embed = buildEventEmbed(event, sourceUrls);
  const components = buildEventComponents(event, sourceUrls);
  const payload = { embeds: [embed], components };
  const object = getGuildEventObject(store, guildId, event.eventKey);
  let stored: DiscordMessageSnapshot | null = null;
  if (object?.messageId && object.messageChannelId === channelId) {
    const fetched = await discord.fetchMessage(channelId, object.messageId);
    if (fetched?.authorIsBot && fetched.embeds.some((candidate) => embedHasMarker(candidate, event) || hasLegacyMarker(candidate, event, sourceUrls))) {
      stored = fetched;
    }
  }

  let recent: DiscordMessageSnapshot[] = [];
  let recoveryComplete = true;
  if (!stored) {
    const firstPostAttemptAt = object?.firstPostAttemptAt;
    const hasAttemptBoundary = firstPostAttemptAt !== null && firstPostAttemptAt !== undefined
      && Number.isFinite(Date.parse(firstPostAttemptAt));
    const search = hasAttemptBoundary
      ? await discord.fetchRecentBotMessages(channelId, 200, { olderThan: firstPostAttemptAt })
      : await discord.fetchRecentBotMessages(channelId, 2_000, { requireChannelStart: true });
    recent = search.messages;
    recoveryComplete = search.complete;
  }
  const stableMatches = recent.filter((message) => message.authorIsBot && message.embeds.some((candidate) => embedHasMarker(candidate, event)));
  if (stableMatches.length > 1) throw new Error(`Mehrere Discord-Meldungen tragen dieselbe Quellenmarkierung für ${event.title}.`);
  const stableMatch = stableMatches[0];
  const legacyMatches = recent.filter((message) => message.authorIsBot && message.embeds.some((candidate) => hasLegacyMarker(candidate, event, sourceUrls)));
  if (legacyMatches.length > 1) throw new Error(`Mehrere ältere Discord-Meldungen passen zu ${event.title}.`);
  const legacyMatch = legacyMatches[0];
  const existing = stored ?? stableMatch ?? legacyMatch;

  if (!existing && !recoveryComplete) throw new Error('Die Suche nach vorhandenen Meldungen ist unvollständig.');

  if (existing) {
    setGuildDiscordIds(store, guildId, event.eventKey, { messageId: existing.id, messageChannelId: channelId });
    const currentEmbed = existing.embeds.find((candidate) => embedHasMarker(candidate, event) || hasLegacyMarker(candidate, event, sourceUrls));
    if (!currentEmbed || !samePayload({ embeds: [currentEmbed], components: existing.components }, payload)) {
      await discord.editMessage(channelId, existing.id, payload);
    }
    return existing.id;
  }

  const firstPostAttemptAt = ensureGuildEventFirstPostAttemptAt(store, guildId, event.eventKey, syncNow.toISOString());
  if (!firstPostAttemptAt) throw new Error('Der erste Post-Versuch konnte nicht gespeichert werden.');
  const created = await discord.createMessage(channelId, payload);
  setGuildDiscordIds(store, guildId, event.eventKey, { messageId: created.id, messageChannelId: channelId });
  return created.id;
}

export function syncEventEmbed(options: SyncEventEmbedOptions): Promise<string> {
  return withGuildDiscordLock(options.guildId ?? 'guild', () => syncEventEmbedUnlocked(options));
}
