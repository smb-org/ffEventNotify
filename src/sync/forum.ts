// Synchronizes event cards, status, tags, and reward continuations as forum posts.

import type { Store, StoreEvent } from '../store.ts';
import {
  ensureGuildEventFirstPostAttemptAt,
  getGuild,
  getGuildEventObject,
  setGuildDiscordIds,
  setGuildStatusMessage,
} from '../store.ts';
import { eventSourceLink, hasEventMarkerUrl } from '../event-identity.ts';
import { withGuildDiscordLock } from '../guild-lock.ts';
import { buildEventComponents, buildEventEmbed } from './embed.ts';
import type {
  DiscordEmbed,
  DiscordForumPostSnapshot,
  DiscordForumTag,
  DiscordForumTagData,
  DiscordMessagePayload,
  DiscordMessageSnapshot,
  DiscordPort,
} from '../types.ts';

export const FORUM_TAG_NAMES = [
  'Saison-Event', 'Kollabo', 'Mog Mog-Kollektion', 'Wartung', 'Notwartung', 'Welt-Wartung',
  'Live-Letter', 'Fan Festival', 'Patch', 'Kampagne', 'Angekündigt', 'Läuft', 'Beendet',
] as const;

export const FORUM_AUTO_ARCHIVE_DURATION = 10_080;
const MAX_EMBED_CHARACTERS = 5_500;
const MAX_FIELD_VALUE = 1_024;
const MAX_EMBED_DESCRIPTION = 4_096;

export interface ForumTagSetupResult {
  tags: DiscordForumTag[];
  missingNames: string[];
  createdNames: string[];
}

export async function ensureForumTags(
  discord: DiscordPort,
  channelId: string,
  canManageChannels: boolean,
): Promise<ForumTagSetupResult> {
  if (!discord.fetchForumTags) throw new Error('Forum-Tags werden von diesem Discord-Adapter nicht unterstützt.');
  let tags = await discord.fetchForumTags(channelId);
  let createdNames: string[] = [];
  if (canManageChannels && discord.setForumTags) {
    const knownNames = new Set(tags.map((tag) => tag.name));
    const additions = FORUM_TAG_NAMES.filter((name) => !knownNames.has(name)).slice(0, Math.max(0, 20 - tags.length));
    if (additions.length > 0) {
      const retained: DiscordForumTagData[] = tags.map(({ id, name, moderated, emoji }) => ({ id, name, moderated, emoji }));
      tags = await discord.setForumTags(channelId, [...retained, ...additions.map((name) => ({ name }))]);
      createdNames = additions.filter((name) => tags.some((tag) => tag.name === name));
    }
  }
  const names = new Set(tags.map((tag) => tag.name));
  return {
    tags,
    createdNames,
    missingNames: FORUM_TAG_NAMES.filter((name) => !names.has(name)),
  };
}

function hasPath(sourceUrls: readonly string[], fragment: string): boolean {
  return sourceUrls.some((source) => {
    try { return new URL(source).pathname.includes(fragment); } catch { return false; }
  });
}

export function classifyForumTypeTags(event: Pick<StoreEvent, 'eventType' | 'title' | 'titleStatus'>, sourceUrls: readonly string[]): string[] {
  const tags: string[] = [];
  if (hasPath(sourceUrls, '/lodestone/special/mogmog-collection/')) tags.push('Mog Mog-Kollektion');
  if (event.titleStatus !== 'ok') return tags;
  const title = event.title;
  if (event.eventType === 'maintenance') {
    const allWorlds = /aller\s+welten/i.test(title);
    if (/notwartung/i.test(title) && allWorlds) return [...tags, 'Notwartung'];
    if (/\[Wartung\]/i.test(title) && allWorlds && !/notwartung/i.test(title)) return [...tags, 'Wartung'];
    if (allWorlds) return tags;
    if (/\[(?:Wartung|Folge-News)\]/i.test(title) && /(\[[^\]]+\]|\b(?:der welt|des daten[z]?entrums|datenzentrum|welt)\b)/i.test(title)) {
      return [...tags, 'Welt-Wartung'];
    }
    return tags;
  }
  if (/kollabo(?:ration)?/i.test(title)) tags.push('Kollabo');
  if (/brief des produzenten\s+live/i.test(title)) tags.push('Live-Letter');
  if (/fan\s+festival/i.test(title)) tags.push('Fan Festival');
  if (/\bpatch\b/i.test(title)) tags.push('Patch');
  if (/kampagne/i.test(title)) tags.push('Kampagne');
  if (event.eventType === 'seasonal-special' && hasPath(sourceUrls, '/lodestone/special/')) {
    if (sourceUrls.some((source) => {
      try { return /^\/lodestone\/special\/\d{4}(?:\/|$)/.test(new URL(source).pathname); } catch { return false; }
    })) tags.push('Saison-Event');
  }
  return [...new Set(tags)].slice(0, 4);
}

export function classifyForumTypeTag(event: Pick<StoreEvent, 'eventType' | 'title' | 'titleStatus'>, sourceUrls: readonly string[]): string | undefined {
  return classifyForumTypeTags(event, sourceUrls)[0];
}

export function forumEventStatus(event: Pick<StoreEvent, 'startUtc' | 'endUtc'>, now: Date): 'Angekündigt' | 'Läuft' | 'Beendet' {
  if (event.endUtc && Date.parse(event.endUtc) <= now.getTime()) return 'Beendet';
  if (event.startUtc && Date.parse(event.startUtc) > now.getTime()) return 'Angekündigt';
  return 'Läuft';
}

export function forumTagIdsForEvent(
  event: StoreEvent,
  sourceUrls: readonly string[],
  now: Date,
  tags: readonly DiscordForumTag[],
): string[] {
  const byName = new Map(tags.map((tag) => [tag.name, tag.id]));
  const statusId = byName.get(forumEventStatus(event, now));
  const typeIds = classifyForumTypeTags(event, sourceUrls).map((name) => byName.get(name));
  return [statusId, ...typeIds].filter((id): id is string => id !== undefined).slice(0, 5);
}

function rewardGroups(rewards: StoreEvent['rewards']): Array<{ section: string; rewards: StoreEvent['rewards'] }> {
  const groups = new Map<string, StoreEvent['rewards']>();
  for (const reward of rewards) {
    const group = groups.get(reward.section) ?? [];
    group.push(reward);
    groups.set(reward.section, group);
  }
  return [...groups].map(([section, items]) => ({ section, rewards: items }));
}

function itemUrl(itemId: string): string {
  return `https://de.finalfantasyxiv.com/lodestone/playguide/db/item/${encodeURIComponent(itemId)}/`;
}

function rewardLine(reward: StoreEvent['rewards'][number]): string {
  return `[${reward.name}](${itemUrl(reward.itemId)})${reward.cost ? ` — ${reward.cost}` : ''}`;
}

function embedCharacters(embed: DiscordEmbed): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.author?.name.length ?? 0) +
    (embed.footer?.text.length ?? 0) + (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

interface EventCard {
  embed: DiscordEmbed;
  continuationBodies: string[];
}

function eventCard(event: StoreEvent, sourceUrls: readonly string[]): EventCard {
  const noInlineRewards: StoreEvent = { ...event, rewards: [], rewardsStatus: 'n/a' };
  const embed = buildEventEmbed(noInlineRewards, sourceUrls);
  const continuation: Array<{ section: string; line: string }> = [];
  if (event.rewardsStatus === 'unsicher' && event.rewards.length === 0) {
    embed.fields = [...(embed.fields ?? []), { name: 'Belohnungen', value: 'Belohnungen: siehe Sonderseite' }];
  } else if (event.rewardsStatus === 'ok') {
    for (const group of rewardGroups(event.rewards)) {
      const accepted: string[] = [];
      let fieldBudget = 0;
      for (const reward of group.rewards) {
        const line = rewardLine(reward);
        const nextBudget = fieldBudget + (accepted.length > 0 ? 1 : 0) + line.length;
        const nextField: DiscordEmbed['fields'] = [...(embed.fields ?? []), { name: group.section.slice(0, 256), value: [...accepted, line].join('\n') }];
        const nextEmbed = { ...embed, fields: nextField };
        if (line.length > MAX_FIELD_VALUE || nextBudget > MAX_FIELD_VALUE || (embed.fields?.length ?? 0) >= 25 || embedCharacters(nextEmbed) > MAX_EMBED_CHARACTERS) {
          continuation.push({ section: group.section, line });
        } else {
          accepted.push(line);
          fieldBudget = nextBudget;
        }
      }
      if (accepted.length > 0) embed.fields = [...(embed.fields ?? []), { name: group.section.slice(0, 256), value: accepted.join('\n') }];
    }
  }

  const continuationBodies: string[] = [];
  let lines: string[] = [];
  let currentSection = '';
  const flush = () => {
    if (lines.length > 0) continuationBodies.push(lines.join('\n'));
    lines = [];
    currentSection = '';
  };
  for (const reward of continuation) {
    const sectionLine = currentSection === reward.section ? undefined : `**${reward.section}**`;
    const next = [...lines, ...(sectionLine ? [sectionLine] : []), reward.line];
    const description = next.join('\n');
    if (lines.length > 0 && description.length > MAX_EMBED_DESCRIPTION) flush();
    const nextSectionLine = currentSection === reward.section ? undefined : `**${reward.section}**`;
    lines.push(...(nextSectionLine ? [nextSectionLine] : []), reward.line);
    currentSection = reward.section;
  }
  flush();
  return { embed, continuationBodies };
}

function continuationPayload(event: StoreEvent, sourceUrls: readonly string[], body: string, index: number): DiscordMessagePayload {
  const markerUrl = eventSourceLink(event.eventKey, sourceUrls);
  const embed: DiscordEmbed = {
    title: index === 0 ? 'Belohnungen (Fortsetzung)' : `Belohnungen (Fortsetzung ${index + 1})`,
    ...(markerUrl ? { url: markerUrl } : {}),
    description: body,
  };
  return { embeds: [embed] };
}

function messageHasEventMarker(message: DiscordMessageSnapshot, event: StoreEvent): boolean {
  return message.authorIsBot && message.embeds.some((embed) => embed.url !== undefined && hasEventMarkerUrl(embed.url, event.eventKey));
}

function isContinuation(message: DiscordMessageSnapshot, event: StoreEvent): boolean {
  return messageHasEventMarker(message, event) && message.embeds.some((embed) => /^Belohnungen \(Fortsetzung(?: \d+)?\)$/.test(embed.title ?? ''));
}

function eventTitle(event: StoreEvent): string {
  const title = event.titleStatus === 'ok' ? event.title : 'FFXIV-Event';
  return Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, 100).join('') || 'FFXIV-Event';
}

function starterMatches(post: DiscordForumPostSnapshot, event: StoreEvent): boolean {
  return messageHasEventMarker(post.starterMessage, event);
}

async function findForumPost(
  channelId: string,
  event: StoreEvent,
  objectThreadId: string | null,
  discord: DiscordPort,
): Promise<DiscordForumPostSnapshot | undefined> {
  if (!discord.fetchForumPost || !discord.listForumPosts) throw new Error('Forum-Post-Recovery wird von diesem Discord-Adapter nicht unterstützt.');
  if (objectThreadId) {
    const stored = await discord.fetchForumPost(channelId, objectThreadId);
    if (stored && starterMatches(stored, event)) return stored;
  }
  const allPosts = await discord.listForumPosts(channelId);
  const matches = allPosts.filter((post) => starterMatches(post, event));
  if (matches.length > 1) throw new Error(`Mehrere Forum-Posts tragen dieselbe Quellenmarkierung für ${event.title}.`);
  return matches[0];
}

async function syncContinuations(
  threadId: string,
  event: StoreEvent,
  sourceUrls: readonly string[],
  desiredBodies: readonly string[],
  discord: DiscordPort,
  store: Store,
  guildId: string,
): Promise<void> {
  if (!discord.sendToThread || !discord.fetchRecentBotMessages) throw new Error('Forum-Fortsetzungen werden von diesem Discord-Adapter nicht unterstützt.');
  const object = getGuildEventObject(store, guildId, event.eventKey);
  const stored = object?.continuationMessageIds ?? [];
  const byId: DiscordMessageSnapshot[] = [];
  for (const messageId of stored) {
    const message = await discord.fetchMessage(threadId, messageId);
    if (message && isContinuation(message, event)) byId.push(message);
  }

  let recovered = byId;
  if (byId.length < desiredBodies.length || stored.length === 0) {
    const history = await discord.fetchRecentBotMessages(threadId, 2_000, { requireChannelStart: true });
    if (!history.complete) throw new Error('Die Suche nach vorhandenen Belohnungs-Fortsetzungen ist unvollständig.');
    const marked = history.messages.filter((message) => isContinuation(message, event));
    const seen = new Set(byId.map((message) => message.id));
    recovered = [...byId, ...marked.filter((message) => !seen.has(message.id))];
  }
  recovered.sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id));

  const nextIds: string[] = [];
  for (let index = 0; index < desiredBodies.length; index += 1) {
    const desired = continuationPayload(event, sourceUrls, desiredBodies[index]!, index);
    const existing = recovered[index];
    if (existing) {
      if (JSON.stringify(existing.embeds) !== JSON.stringify(desired.embeds)) {
        await discord.editMessage(threadId, existing.id, desired);
      }
      nextIds.push(existing.id);
    } else {
      const created = await discord.sendToThread(threadId, desired);
      nextIds.push(created.id);
    }
  }
  for (const extra of recovered.slice(desiredBodies.length)) {
    if (discord.deleteThreadMessage) await discord.deleteThreadMessage(threadId, extra.id);
  }
  setGuildDiscordIds(store, guildId, event.eventKey, { continuationMessageIds: nextIds });
}

export interface SyncForumEventOptions {
  guildId: string;
  channelId: string;
  event: StoreEvent;
  sourceUrls: readonly string[];
  discord: DiscordPort;
  store: Store;
  now?: Date;
}

async function syncForumEventUnlocked({ guildId, channelId, event, sourceUrls, discord, store, now = new Date() }: SyncForumEventOptions): Promise<string> {
  if (!discord.createForumPost || !discord.editForumStarter || !discord.fetchForumTags) {
    throw new Error('Forum-Synchronisierung wird von diesem Discord-Adapter nicht unterstützt.');
  }
  const eventObject = getGuildEventObject(store, guildId, event.eventKey);
  let post = await findForumPost(channelId, event, eventObject?.messageId ?? null, discord);
  const card = eventCard(event, sourceUrls);
  const payload: DiscordMessagePayload = { embeds: [card.embed], components: buildEventComponents(event, sourceUrls) };
  const tags = await discord.fetchForumTags(channelId);
  const appliedTags = forumTagIdsForEvent(event, sourceUrls, now, tags);

  if (!post) {
    const firstPostAttemptAt = ensureGuildEventFirstPostAttemptAt(store, guildId, event.eventKey, now.toISOString());
    if (!firstPostAttemptAt) throw new Error('Der erste Forum-Post-Versuch konnte nicht gespeichert werden.');
    post = await discord.createForumPost(channelId, eventTitle(event), payload, appliedTags, FORUM_AUTO_ARCHIVE_DURATION);
  } else {
    if (!starterMatches(post, event)) throw new Error('Der gespeicherte Forum-Post trägt nicht die Event-Markierung.');
    if (forumEventStatus(event, now) !== 'Beendet' && discord.keepForumPostActive) {
      await discord.keepForumPostActive(post.id, FORUM_AUTO_ARCHIVE_DURATION);
    }
    if (post.name !== eventTitle(event) && discord.setForumPostName) await discord.setForumPostName(post.id, eventTitle(event));
    if (JSON.stringify([...post.appliedTags].sort()) !== JSON.stringify([...appliedTags].sort()) && discord.setForumPostTags) {
      await discord.setForumPostTags(post.id, appliedTags);
    }
    if (JSON.stringify(post.starterMessage.embeds) !== JSON.stringify(payload.embeds) ||
      JSON.stringify(post.starterMessage.components ?? []) !== JSON.stringify(payload.components ?? [])) {
      await discord.editForumStarter(post.id, payload);
    }
  }

  setGuildDiscordIds(store, guildId, event.eventKey, {
    messageId: post.id,
    messageChannelId: channelId,
    reminderThreadId: null,
  });
  await syncContinuations(post.id, event, sourceUrls, card.continuationBodies, discord, store, guildId);
  if (forumEventStatus(event, now) === 'Beendet') {
    if (!post.archived && discord.setForumPostArchived) await discord.setForumPostArchived(post.id, true);
  } else if (post.archived && discord.keepForumPostActive) {
    await discord.keepForumPostActive(post.id, FORUM_AUTO_ARCHIVE_DURATION);
  }
  return post.id;
}

export function syncForumEvent(options: SyncForumEventOptions): Promise<string> {
  return withGuildDiscordLock(options.guildId, () => syncForumEventUnlocked(options));
}

function statusEmbed(events: readonly StoreEvent[], now: Date, guildId: string, store: Store): DiscordEmbed {
  const running = events
    .filter((event) => event.startStatus === 'ok' && event.endStatus === 'ok' && event.startUtc && event.endUtc)
    .filter((event) => Date.parse(event.startUtc!) <= now.getTime() && now.getTime() < Date.parse(event.endUtc!))
    .sort((left, right) => Date.parse(left.endUtc!) - Date.parse(right.endUtc!) || left.title.localeCompare(right.title));
  const lines: string[] = [];
  for (const event of running) {
    const object = getGuildEventObject(store, guildId, event.eventKey);
    const title = (event.titleStatus === 'ok' ? event.title : 'FFXIV-Event').slice(0, 200).replace(/[\[\]()*_~`|>]/g, '\\$&');
    const link = object?.messageId ? `https://discord.com/channels/${guildId}/${object.messageId}` : undefined;
    lines.push(`• ${link ? `[${title}](<${link}>)` : title} — endet <t:${Math.floor(Date.parse(event.endUtc!) / 1_000)}:R>`);
  }
  const overflow = '… Weitere Events sind im Event-Kanal aufgeführt.';
  while (lines.join('\n').length > MAX_EMBED_DESCRIPTION - overflow.length - 1) lines.pop();
  const description = lines.length === running.length
    ? (lines.join('\n') || 'Gerade läuft kein Event.')
    : `${lines.join('\n')}${lines.length ? '\n' : ''}${overflow}`;
  return { title: 'Läuft gerade', description };
}

function statusPostMatches(post: DiscordForumPostSnapshot): boolean {
  return post.starterMessage.authorIsBot && post.starterMessage.embeds.some((embed) => embed.title === 'Läuft gerade');
}

export interface SyncForumStatusOptions {
  guildId: string;
  channelId: string;
  logChannelId?: string;
  events: readonly StoreEvent[];
  discord: DiscordPort;
  store: Store;
  now?: Date;
}

async function syncForumStatusUnlocked({ guildId, channelId, events, discord, store, now = new Date() }: SyncForumStatusOptions): Promise<void> {
  if (!discord.fetchForumPost || !discord.listForumPosts || !discord.createForumPost || !discord.editForumStarter || !discord.fetchForumTags) {
    throw new Error('Forum-Status wird von diesem Discord-Adapter nicht unterstützt.');
  }
  const current = statusEmbed(events, now, guildId, store);
  const payload: DiscordMessagePayload = { embeds: [current] };
  const guild = getGuild(store, guildId);
  let post = guild?.statusMessageId ? await discord.fetchForumPost(channelId, guild.statusMessageId) : null;
  if (post && !statusPostMatches(post)) post = null;
  if (!post) {
    const matches = (await discord.listForumPosts(channelId)).filter(statusPostMatches);
    if (matches.length > 1) throw new Error('Mehrere angeheftete Forum-Posts heißen „Läuft gerade“.');
    post = matches[0] ?? null;
  }
  const statusTagId = (await discord.fetchForumTags(channelId)).find((tag) => tag.name === 'Läuft')?.id;
  if (!post) {
    post = await discord.createForumPost(channelId, 'Läuft gerade', payload, statusTagId ? [statusTagId] : [], FORUM_AUTO_ARCHIVE_DURATION);
    setGuildStatusMessage(store, guildId, post.id);
    if (discord.pinForumPost) await discord.pinForumPost(post.id);
  } else {
    if (discord.keepForumPostActive) await discord.keepForumPostActive(post.id, FORUM_AUTO_ARCHIVE_DURATION);
    if (post.name !== 'Läuft gerade' && discord.setForumPostName) await discord.setForumPostName(post.id, 'Läuft gerade');
    if (statusTagId && !post.appliedTags.includes(statusTagId) && discord.setForumPostTags) await discord.setForumPostTags(post.id, [statusTagId]);
    if (!post.pinned && discord.pinForumPost) await discord.pinForumPost(post.id);
    if (JSON.stringify(post.starterMessage.embeds) !== JSON.stringify(payload.embeds)) await discord.editForumStarter(post.id, payload);
    setGuildStatusMessage(store, guildId, post.id);
  }
  // Forum thread auto-archive duration is reset above on each sync; status posts are never archived.
}

export function syncForumStatus(options: SyncForumStatusOptions): Promise<void> {
  return withGuildDiscordLock(options.guildId, () => syncForumStatusUnlocked(options));
}

