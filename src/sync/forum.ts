// Synchronizes event cards, status, tags, and reward continuations as forum posts.

import type { Store, StoreEvent } from '../store.ts';
import {
  deliverWarning,
  ensureGuildEventFirstPostAttemptAt,
  getGuild,
  getGuildEventObject,
  setGuildEventLastKeepaliveAt,
  setGuildDiscordIds,
  setGuildStatusLastKeepaliveAt,
  setGuildStatusMessage,
} from '../store.ts';
import { eventSourceLink, hasEventMarkerUrl } from '../event-identity.ts';
import { discordErrorCode } from '../discord-errors.ts';
import { withGuildDiscordLock } from '../guild-lock.ts';
import { briefError, guildLabel, log, logAction } from '../log.ts';
import { buildEventComponents, buildEventEmbed, samePayload } from './embed.ts';
import { addSidebarFollowersToEventPost, sidebarFollowCustomId } from '../sidebar-follow.ts';
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
const FORUM_KEEPALIVE_WINDOW_MS = 6 * 24 * 60 * 60 * 1_000;
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

function forumEventContent(event: StoreEvent, status: ReturnType<typeof forumEventStatus>): string {
  if (status === 'Beendet') {
    if (event.endStatus !== 'ok' || !event.endUtc) return '✅ Beendet';
    return `✅ Beendet <t:${Math.floor(Date.parse(event.endUtc) / 1_000)}:f>`;
  }
  if (status === 'Angekündigt') {
    if (event.startStatus !== 'ok' || !event.startUtc) return '';
    const start = Math.floor(Date.parse(event.startUtc) / 1_000);
    return `🗓️ Beginnt <t:${start}:R> · <t:${start}:f>`;
  }
  if ((event.endStatus !== 'ok' || !event.endUtc) && event.endPatch) return `⏳ Läuft bis Patch ${event.endPatch}`;
  if (event.endStatus !== 'ok' || !event.endUtc) return '⏳ Ende unbekannt – siehe Sonderseite';
  const end = Math.floor(Date.parse(event.endUtc) / 1_000);
  return `⏳ Endet <t:${end}:R> · <t:${end}:f>`;
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

function latestActivityAt(post: DiscordForumPostSnapshot, lastKeepaliveAt: string | null): number | undefined {
  const timestamps = [post.archiveTimestamp, post.lastMessageAt, lastKeepaliveAt]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

interface KeepForumPostVisibleOptions {
  guildId: string;
  threadId: string;
  title: string;
  post: DiscordForumPostSnapshot;
  lastKeepaliveAt: string | null;
  saveLastKeepaliveAt(value: string): void;
  logChannelId?: string;
  discord: DiscordPort;
  store: Store;
  now: Date;
}

async function logForumUnarchiveFailure(
  { guildId, threadId, title, logChannelId, discord, store }: KeepForumPostVisibleOptions,
): Promise<void> {
  if (!logChannelId) return;
  try {
    await deliverWarning(
      store,
      guildId,
      logChannelId,
      `forum-unarchive-failed:${threadId}`,
      `Der Forum-Post für „${title}“ konnte nicht entarchiviert werden. Der Bot versucht es im nächsten Zyklus erneut.`,
      (channelId, content) => discord.sendLog(channelId, content),
    );
  } catch (error) {
    log.error(`Die Log-Meldung für den nicht entarchivierten Forum-Post ${threadId} konnte nicht gesendet werden:`, error);
  }
}

async function keepForumPostVisible(options: KeepForumPostVisibleOptions): Promise<boolean> {
  const { post, discord, now, saveLastKeepaliveAt } = options;
  let lastKeepaliveAt = options.lastKeepaliveAt;
  if (post.archived) {
    try {
      if (!discord.setForumPostArchived) throw new Error('Dieser Discord-Adapter kann Forum-Posts nicht entarchivieren.');
      await discord.setForumPostArchived(post.id, false);
      logAction(options.guildId, 'postUnarchived', `Beitrag „${options.title}“ entarchiviert`);
      lastKeepaliveAt = now.toISOString();
      saveLastKeepaliveAt(lastKeepaliveAt);
    } catch (error) {
      log.warn(`${guildLabel(options.guildId)}: Beitrag „${options.title}“ konnte nicht entarchiviert werden: ${briefError(error)}`);
      await logForumUnarchiveFailure(options);
      return false;
    }
  }

  const lastActivityAt = latestActivityAt(post, lastKeepaliveAt);
  const keepaliveIsDue = lastActivityAt === undefined || now.getTime() - lastActivityAt >= FORUM_KEEPALIVE_WINDOW_MS;
  if (keepaliveIsDue) {
    try {
      if (discord.refreshForumPostKeepAlive) {
        await discord.refreshForumPostKeepAlive(post.id, FORUM_AUTO_ARCHIVE_DURATION);
      } else if (discord.setForumPostAutoArchiveDuration) {
        await discord.setForumPostAutoArchiveDuration(post.id, 4_320);
        await discord.setForumPostAutoArchiveDuration(post.id, FORUM_AUTO_ARCHIVE_DURATION);
      } else if (discord.keepForumPostActive) {
        await discord.keepForumPostActive(post.id, 4_320);
        await discord.keepForumPostActive(post.id, FORUM_AUTO_ARCHIVE_DURATION);
      } else {
        throw new Error('Dieser Discord-Adapter kann Forum-Posts nicht aktualisieren.');
      }
      saveLastKeepaliveAt(now.toISOString());
      return true;
    } catch (error) {
      throw new Error(`Der Keep-alive für den Forum-Post ${post.id} ist fehlgeschlagen.`, { cause: error });
    }
  }

  if (post.autoArchiveDuration !== FORUM_AUTO_ARCHIVE_DURATION) {
    if (discord.setForumPostAutoArchiveDuration) {
      await discord.setForumPostAutoArchiveDuration(post.id, FORUM_AUTO_ARCHIVE_DURATION);
    } else if (discord.keepForumPostActive) {
      await discord.keepForumPostActive(post.id, FORUM_AUTO_ARCHIVE_DURATION);
    }
    saveLastKeepaliveAt(now.toISOString());
  }
  return true;
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

type ForumContinuationAction =
  | { kind: 'edit'; messageId: string; payload: DiscordMessagePayload; index: number }
  | { kind: 'create'; payload: DiscordMessagePayload; index: number };

interface ForumContinuationPlan {
  actions: ForumContinuationAction[];
  deletes: string[];
  nextIds: Array<string | undefined>;
}

type ForumThreadEdit = <T>(edit: () => Promise<T>) => Promise<T>;

async function planContinuations(
  threadId: string,
  event: StoreEvent,
  sourceUrls: readonly string[],
  desiredBodies: readonly string[],
  discord: DiscordPort,
  store: Store,
  guildId: string,
): Promise<ForumContinuationPlan> {
  if (!discord.sendToThread || !discord.fetchRecentBotMessages) throw new Error('Forum-Fortsetzungen werden von diesem Discord-Adapter nicht unterstützt.');
  const object = getGuildEventObject(store, guildId, event.eventKey);
  const stored = object?.continuationMessageIds ?? [];
  const byId: DiscordMessageSnapshot[] = [];
  for (const messageId of stored) {
    const message = await discord.fetchMessage(threadId, messageId);
    if (message && isContinuation(message, event)) byId.push(message);
  }

  let recovered = byId;
  if (byId.length < desiredBodies.length || stored.length === 0 || byId.length !== stored.length) {
    const history = await discord.fetchRecentBotMessages(threadId, 2_000, { requireChannelStart: true });
    if (!history.complete) throw new Error('Die Suche nach vorhandenen Belohnungs-Fortsetzungen ist unvollständig.');
    const marked = history.messages.filter((message) => isContinuation(message, event));
    const seen = new Set(byId.map((message) => message.id));
    recovered = [...byId, ...marked.filter((message) => !seen.has(message.id))];
  }
  recovered.sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id));

  const plan: ForumContinuationPlan = { actions: [], deletes: [], nextIds: [] };
  for (let index = 0; index < desiredBodies.length; index += 1) {
    const desired = continuationPayload(event, sourceUrls, desiredBodies[index]!, index);
    const existing = recovered[index];
    if (existing) {
      if (!samePayload(existing, desired)) {
        plan.actions.push({ kind: 'edit', messageId: existing.id, payload: desired, index });
      }
      plan.nextIds[index] = existing.id;
    } else {
      plan.actions.push({ kind: 'create', payload: desired, index });
    }
  }
  for (const extra of recovered.slice(desiredBodies.length)) {
    if (discord.deleteThreadMessage) plan.deletes.push(extra.id);
  }
  return plan;
}

async function applyContinuationPlan(
  threadId: string,
  event: StoreEvent,
  plan: ForumContinuationPlan,
  discord: DiscordPort,
  store: Store,
  guildId: string,
  editThread: ForumThreadEdit,
): Promise<void> {
  for (const action of plan.actions) {
    if (action.kind === 'edit') {
      await editThread(() => discord.editMessage(threadId, action.messageId, action.payload));
    } else {
      const created = await discord.sendToThread!(threadId, action.payload);
      plan.nextIds[action.index] = created.id;
    }
  }
  for (const messageId of plan.deletes) {
    await discord.deleteThreadMessage!(threadId, messageId);
  }
  const nextIds = plan.nextIds.map((id) => {
    if (!id) throw new Error(`Die Belohnungs-Fortsetzung für ${event.eventKey} wurde nicht gespeichert.`);
    return id;
  });
  setGuildDiscordIds(store, guildId, event.eventKey, { continuationMessageIds: nextIds });
}

export interface SyncForumEventOptions {
  guildId: string;
  channelId: string;
  logChannelId?: string;
  event: StoreEvent;
  sourceUrls: readonly string[];
  discord: DiscordPort;
  store: Store;
  now?: Date;
}

async function syncForumEventUnlocked({ guildId, channelId, logChannelId, event, sourceUrls, discord, store, now = new Date() }: SyncForumEventOptions): Promise<string> {
  if (!discord.createForumPost || !discord.editForumStarter || !discord.fetchForumTags) {
    throw new Error('Forum-Synchronisierung wird von diesem Discord-Adapter nicht unterstützt.');
  }
  const eventObject = getGuildEventObject(store, guildId, event.eventKey);
  let post = await findForumPost(channelId, event, eventObject?.messageId ?? null, discord);
  const card = eventCard(event, sourceUrls);
  const eventStatus = forumEventStatus(event, now);
  const payload: DiscordMessagePayload = {
    content: forumEventContent(event, eventStatus),
    embeds: [card.embed],
    components: buildEventComponents(event, sourceUrls),
    allowedMentions: { parse: [], users: [] },
  };
  const tags = await discord.fetchForumTags(channelId);
  const appliedTags = forumTagIdsForEvent(event, sourceUrls, now, tags);
  let createdPost = false;

  if (!post) {
    const firstPostAttemptAt = ensureGuildEventFirstPostAttemptAt(store, guildId, event.eventKey, now.toISOString());
    if (!firstPostAttemptAt) throw new Error('Der erste Forum-Post-Versuch konnte nicht gespeichert werden.');
    post = await discord.createForumPost(channelId, eventTitle(event), payload, appliedTags, FORUM_AUTO_ARCHIVE_DURATION);
    createdPost = true;
    if (eventObject?.messageId) logAction(guildId, 'postRecreated', `Beitrag „${eventTitle(event)}“ neu angelegt (vorher gelöscht)`);
    else logAction(guildId, 'postCreated', `Beitrag „${eventTitle(event)}“ angelegt`);
  } else {
    if (!starterMatches(post, event)) throw new Error('Der gespeicherte Forum-Post trägt nicht die Event-Markierung.');
  }

  setGuildDiscordIds(store, guildId, event.eventKey, {
    messageId: post.id,
    messageChannelId: channelId,
    reminderThreadId: null,
  });
  const eventKeepaliveAt = getGuildEventObject(store, guildId, event.eventKey)?.lastKeepaliveAt ?? null;
  if (createdPost && !eventKeepaliveAt) {
    setGuildEventLastKeepaliveAt(store, guildId, event.eventKey, now.toISOString());
  }

  let currentArchived = post.archived;
  let unarchivedForUpdate = false;
  let retriedArchivedEdit = false;
  const editThread = async <T>(edit: () => Promise<T>): Promise<T> => {
    try {
      return await edit();
    } catch (error) {
      if (discordErrorCode(error) !== 50_083 || retriedArchivedEdit || !discord.setForumPostArchived) throw error;
      await discord.setForumPostArchived(post.id, false);
      currentArchived = false;
      unarchivedForUpdate = true;
      retriedArchivedEdit = true;
      return edit();
    }
  };

  if (eventStatus !== 'Beendet') {
    const visible = await keepForumPostVisible({
      guildId,
      threadId: post.id,
      title: eventTitle(event),
      post,
      lastKeepaliveAt: getGuildEventObject(store, guildId, event.eventKey)?.lastKeepaliveAt ?? null,
      saveLastKeepaliveAt: (value) => setGuildEventLastKeepaliveAt(store, guildId, event.eventKey, value),
      logChannelId,
      discord,
      store,
      now,
    });
    if (!visible) return post.id;
    currentArchived = false;
  }

  if (createdPost) {
    await addSidebarFollowersToEventPost({ db: store, discord, guildId, threadId: post.id, event, now });
  }

  const nameChanged = !createdPost && post.name !== eventTitle(event) && Boolean(discord.setForumPostName);
  const tagsChanged = !createdPost && JSON.stringify([...post.appliedTags].sort()) !== JSON.stringify([...appliedTags].sort()) && Boolean(discord.setForumPostTags);
  const starterChanged = !createdPost && !samePayload(post.starterMessage, payload);
  const continuationPlan = await planContinuations(post.id, event, sourceUrls, card.continuationBodies, discord, store, guildId);
  const durationChanged = eventStatus === 'Beendet' && post.autoArchiveDuration !== FORUM_AUTO_ARCHIVE_DURATION && Boolean(discord.setForumPostAutoArchiveDuration);
  const continuationChanged = continuationPlan.actions.length > 0 || continuationPlan.deletes.length > 0;
  const hasPostChanges = nameChanged || tagsChanged || starterChanged || continuationChanged || durationChanged;

  if (eventStatus === 'Beendet' && post.archived && hasPostChanges) {
    if (!discord.setForumPostArchived) throw new Error('Dieser Discord-Adapter kann Forum-Posts nicht entarchivieren.');
    await discord.setForumPostArchived(post.id, false);
    currentArchived = false;
    unarchivedForUpdate = true;
  }

  let edited = false;
  if (!createdPost) {
    if (nameChanged && discord.setForumPostName) {
      await editThread(() => discord.setForumPostName!(post.id, eventTitle(event)));
      edited = true;
    }
    if (tagsChanged && discord.setForumPostTags) {
      await editThread(() => discord.setForumPostTags!(post.id, appliedTags));
      edited = true;
    }
    if (starterChanged) {
      await editThread(() => discord.editForumStarter!(post.id, payload));
      edited = true;
    }
  }

  await applyContinuationPlan(post.id, event, continuationPlan, discord, store, guildId, editThread);
  if (continuationChanged && !createdPost) edited = true;
  if (durationChanged && discord.setForumPostAutoArchiveDuration) {
    await editThread(() => discord.setForumPostAutoArchiveDuration!(post.id, FORUM_AUTO_ARCHIVE_DURATION));
    edited ||= !createdPost;
  }
  if (edited) logAction(guildId, 'postEdited', `Beitrag „${eventTitle(event)}“ bearbeitet`);

  if (eventStatus === 'Beendet') {
    if (!currentArchived && discord.setForumPostArchived) {
      await discord.setForumPostArchived(post.id, true);
      currentArchived = true;
      if (!unarchivedForUpdate) logAction(guildId, 'postArchived', `Beitrag „${eventTitle(event)}“ archiviert`);
    }
  }
  return post.id;
}

export function syncForumEvent(options: SyncForumEventOptions): Promise<string> {
  return withGuildDiscordLock(options.guildId, () => syncForumEventUnlocked(options));
}

function statusEmbed(events: readonly StoreEvent[], now: Date, guildId: string, store: Store): DiscordEmbed {
  const running = events
    .filter((event) => event.startStatus === 'ok' && event.startUtc && (
      event.endStatus === 'ok' && event.endUtc || event.endStatus === 'unsicher' && event.endPatch
    ))
    .filter((event) => Date.parse(event.startUtc!) <= now.getTime() && (
      event.endStatus === 'ok' && event.endUtc ? now.getTime() < Date.parse(event.endUtc) : true
    ))
    .sort((left, right) => (left.endStatus === 'ok' && left.endUtc ? Date.parse(left.endUtc) : Number.POSITIVE_INFINITY) -
      (right.endStatus === 'ok' && right.endUtc ? Date.parse(right.endUtc) : Number.POSITIVE_INFINITY) || left.title.localeCompare(right.title));
  const lines: string[] = [];
  for (const event of running) {
    const object = getGuildEventObject(store, guildId, event.eventKey);
    const title = (event.titleStatus === 'ok' ? event.title : 'FFXIV-Event').slice(0, 200).replace(/[\[\]()*_~`|>]/g, '\\$&');
    const link = object?.messageId ? `https://discord.com/channels/${guildId}/${object.messageId}` : undefined;
    const ending = event.endStatus === 'ok' && event.endUtc
      ? `endet <t:${Math.floor(Date.parse(event.endUtc) / 1_000)}:R>`
      : `bis Patch ${event.endPatch}`;
    lines.push(`• ${link ? `[${title}](<${link}>)` : title} — ${ending}`);
  }
  const overflow = '… Weitere Events sind im Event-Kanal aufgeführt.';
  while (lines.join('\n').length > MAX_EMBED_DESCRIPTION - overflow.length - 1) lines.pop();
  const description = lines.length === running.length
    ? (lines.join('\n') || 'Gerade läuft kein Event.')
    : `${lines.join('\n')}${lines.length ? '\n' : ''}${overflow}`;
  return { title: 'Läuft gerade', description };
}

export function buildForumStatusComponents(guildId: string): NonNullable<DiscordMessagePayload['components']> {
  return [{ components: [{
    type: 'button',
    style: 'secondary',
    label: 'Alle Events in meiner Seitenleiste',
    customId: sidebarFollowCustomId(guildId),
  }] }];
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

async function syncForumStatusUnlocked({ guildId, channelId, logChannelId, events, discord, store, now = new Date() }: SyncForumStatusOptions): Promise<void> {
  if (!discord.fetchForumPost || !discord.listForumPosts || !discord.createForumPost || !discord.editForumStarter || !discord.fetchForumTags) {
    throw new Error('Forum-Status wird von diesem Discord-Adapter nicht unterstützt.');
  }
  const current = statusEmbed(events, now, guildId, store);
  const payload: DiscordMessagePayload = { embeds: [current], components: buildForumStatusComponents(guildId) };
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
    logAction(guildId, 'statusEdited', 'Status-Beitrag „Läuft gerade“ angelegt');
    setGuildStatusMessage(store, guildId, post.id);
    setGuildStatusLastKeepaliveAt(store, guildId, now.toISOString());
  } else {
    setGuildStatusMessage(store, guildId, post.id);
  }
  const latestGuild = getGuild(store, guildId);
  const visible = await keepForumPostVisible({
    guildId,
    threadId: post.id,
    title: 'Läuft gerade',
    post,
    lastKeepaliveAt: latestGuild?.statusLastKeepaliveAt ?? null,
    saveLastKeepaliveAt: (value) => setGuildStatusLastKeepaliveAt(store, guildId, value),
    logChannelId,
    discord,
    store,
    now,
  });
  if (!visible) return;

  if (post.name !== 'Läuft gerade' && discord.setForumPostName) await discord.setForumPostName(post.id, 'Läuft gerade');
  if (statusTagId && !post.appliedTags.includes(statusTagId) && discord.setForumPostTags) await discord.setForumPostTags(post.id, [statusTagId]);
  if (!post.pinned && discord.pinForumPost) await discord.pinForumPost(post.id);
  if (!samePayload(post.starterMessage, payload)) {
    await discord.editForumStarter(post.id, payload);
    logAction(guildId, 'statusEdited', 'Status-Beitrag „Läuft gerade“ bearbeitet');
  }
  // The status forum post is always kept active and uses Discord's maximum archive duration.
}

export function syncForumStatus(options: SyncForumStatusOptions): Promise<void> {
  return withGuildDiscordLock(options.guildId, () => syncForumStatusUnlocked(options));
}

