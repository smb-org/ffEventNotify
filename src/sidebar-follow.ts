// Keeps guild opt-ins synchronized with their event forum posts.

import {
  deleteGuildSidebarFollow,
  getGuildEventPosts,
  getGuildSidebarFollowUserIds,
  type GuildEventPost,
  type Store,
  type StoreEvent,
} from './store.ts';
import type { DiscordPort } from './types.ts';

export const SIDEBAR_FOLLOW_CUSTOM_ID_PREFIX = 'ffe:sidebar-follow:';

export function sidebarFollowCustomId(guildId: string): string {
  return `${SIDEBAR_FOLLOW_CUSTOM_ID_PREFIX}${guildId}`;
}

function isEnded(post: Pick<GuildEventPost, 'endStatus' | 'endUtc'>, now: Date): boolean {
  return post.endStatus === 'ok' && post.endUtc !== null && Date.parse(post.endUtc) <= now.getTime();
}

function discordErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

async function runMemberOperation(
  db: Store,
  guildId: string,
  userId: string,
  action: 'add' | 'remove',
  threadId: string,
  discord: DiscordPort,
): Promise<'ok' | 'left'> {
  const operation = action === 'add' ? discord.addThreadMember : discord.removeThreadMember;
  if (!operation) return 'ok';
  try {
    await operation.call(discord, threadId, userId);
    return 'ok';
  } catch (error) {
    const code = discordErrorCode(error);
    if (code === 10_007) {
      deleteGuildSidebarFollow(db, guildId, userId);
      return 'left';
    }
    if (code !== 50_001) {
      console.warn(`Thread-Mitglied ${userId} konnte in ${threadId} nicht ${action === 'add' ? 'hinzugefügt' : 'entfernt'} werden.`, error);
    }
    return 'ok';
  }
}

export async function syncSidebarFollowForUser(options: {
  db: Store;
  discord: DiscordPort;
  guildId: string;
  eventChannelId: string;
  userId: string;
  enabled: boolean;
  now?: Date;
}): Promise<void> {
  const { db, discord, guildId, eventChannelId, userId, enabled } = options;
  const now = options.now ?? new Date();
  if (!discord.addThreadMember || !discord.removeThreadMember) return;

  for (const post of getGuildEventPosts(db, guildId)) {
    const ended = isEnded(post, now);
    if (enabled && ended) continue;
    if (!enabled && ended) {
      const snapshot = await discord.fetchForumPost?.(eventChannelId, post.messageId);
      if (!snapshot || snapshot.archived) continue;
    }
    const result = await runMemberOperation(db, guildId, userId, enabled ? 'add' : 'remove', post.messageId, discord);
    if (result === 'left') break;
  }
}

export async function addSidebarFollowersToEventPost(options: {
  db: Store;
  discord: DiscordPort;
  guildId: string;
  threadId: string;
  event: Pick<StoreEvent, 'endStatus' | 'endUtc'>;
  now?: Date;
}): Promise<void> {
  const { db, discord, guildId, threadId, event } = options;
  const now = options.now ?? new Date();
  if (!discord.addThreadMember || isEnded(event, now)) return;

  for (const userId of getGuildSidebarFollowUserIds(db, guildId)) {
    const result = await runMemberOperation(db, guildId, userId, 'add', threadId, discord);
    if (result === 'left') continue;
  }
}
