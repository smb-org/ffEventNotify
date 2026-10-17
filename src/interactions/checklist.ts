// Handles the per-guild, per-player reward checklist and its ephemeral controls.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { stableEventIdentity } from '../event-identity.ts';
import {
  ensureChecklistItems,
  ensureChecklistReminderPreference,
  getAllEvents,
  getChecklistDoneItemIds,
  getChecklistReminderPreference,
  saveChecklistSelection as saveSelection,
  setChecklistReminderPreference,
  type Store,
  type StoreEvent,
} from '../store.ts';

export interface ChecklistSelection {
  guildId: string;
  eventKey: string;
  userId: string;
  itemIds: readonly string[];
  doneItemIds: readonly string[];
}

export function saveChecklistSelection(store: Store, selection: ChecklistSelection): void {
  saveSelection(store, selection);
}

export type ChecklistCustomId =
  | { action: 'open'; eventHash: string }
  | { action: 'select'; eventHash: string; panelToken: string; page: number }
  | { action: 'page'; eventHash: string; panelToken: string; role: 'prev' | 'cur' | 'next'; page: number }
  | { action: 'save'; eventHash: string; panelToken: string }
  | { action: 'reminder'; eventHash: string; panelToken: string };

export function parseChecklistCustomId(customId: string): ChecklistCustomId | undefined {
  const parts = customId.split(':');
  if (parts[0] !== 'ffe') return undefined;
  const action = parts[1];
  const eventHash = parts[2];
  if (!eventHash || !/^[a-f0-9]{32}$/.test(eventHash)) return undefined;
  if (action === 'cl' && parts.length === 3) return { action: 'open', eventHash };
  const panelToken = parts[3];
  if (!panelToken) return undefined;
  if (action === 'save' && parts.length === 4) return { action, eventHash, panelToken };
  if (action === 'reminder' && parts.length === 4) return { action, eventHash, panelToken };
  if (action === 'select' && parts.length === 5) {
    const page = Number(parts[4]);
    if (Number.isSafeInteger(page) && page >= 1) return { action, eventHash, panelToken, page };
  }
  if (action === 'page' && parts.length === 6) {
    const role = parts[4];
    const page = Number(parts[5]);
    if ((role === 'prev' || role === 'cur' || role === 'next') && Number.isSafeInteger(page) && page >= 1) {
      return { action, eventHash, panelToken, role, page };
    }
  }
  return undefined;
}

interface ChecklistSession {
  guildId: string;
  userId: string;
  eventKey: string;
  eventHash: string;
  panelToken: string;
  itemIds: string[];
  fingerprint: string;
  doneItemIds: Set<string>;
  page: number;
  remindersEnabled: boolean;
  expiresAt: number;
}

type ChecklistInteraction = ButtonInteraction | StringSelectMenuInteraction;
type ChecklistRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

const PAGE_SIZE = 25;
const sessions = new Map<string, ChecklistSession>();
const SESSION_TTL_MS = 60 * 60 * 1_000;
const MAX_SESSIONS = 500;

function eventForHash(store: Store, eventHash: string): StoreEvent | undefined {
  const matches = getAllEvents(store).filter((event) => stableEventIdentity(event.eventKey).slice(0, 32) === eventHash);
  return matches.length === 1 ? matches[0] : undefined;
}

function expireSessions(nowMs: number): void {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= nowMs) sessions.delete(token);
  }
}

function createPanelToken(): string {
  let token = randomUUID().replaceAll('-', '');
  while (sessions.has(token)) token = randomUUID().replaceAll('-', '');
  return token;
}

function eventFingerprint(event: StoreEvent): string {
  return JSON.stringify(event.rewards.map(({ itemId, name, section }) => ({ itemId, name, section })));
}

function checkEvent(store: Store, eventKey: string, now: Date): StoreEvent | undefined {
  const event = getAllEvents(store).find((candidate) => candidate.eventKey === eventKey);
  if (!event || event.eventType !== 'seasonal-special' || event.rewardsStatus !== 'ok' || event.rewards.length === 0) return undefined;
  if (event.endStatus === 'ok' && event.endUtc && Date.parse(event.endUtc) <= now.getTime()) return undefined;
  return event;
}

function errorForEvent(store: Store, eventKey: string, now: Date): string {
  const event = getAllEvents(store).find((candidate) => candidate.eventKey === eventKey);
  if (event?.endStatus === 'ok' && event.endUtc && Date.parse(event.endUtc) <= now.getTime()) {
    return 'Dieses Event ist bereits beendet. Die Checkliste ist nicht mehr verfügbar.';
  }
  return 'Diese Checkliste ist nicht mehr verfügbar.';
}

function validateSession(store: Store, session: ChecklistSession, now: Date): StoreEvent | undefined {
  const event = checkEvent(store, session.eventKey, now);
  if (!event || eventFingerprint(event) !== session.fingerprint) return undefined;
  return event;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function checklistRows(session: ChecklistSession, event: StoreEvent): ChecklistRow[] {
  const pageCount = Math.max(1, Math.ceil(session.itemIds.length / PAGE_SIZE));
  const start = session.page * PAGE_SIZE;
  const pageRewards = event.rewards.slice(start, start + PAGE_SIZE);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`ffe:select:${session.eventHash}:${session.panelToken}:${session.page + 1}`)
    .setPlaceholder('Wähle deine erledigten Belohnungen')
    .setMinValues(0)
    .setMaxValues(pageRewards.length)
    .addOptions(pageRewards.map((reward) => {
      const option = new StringSelectMenuOptionBuilder()
        .setLabel(truncate(reward.name, 100))
        .setValue(reward.itemId);
      if (reward.section) option.setDescription(truncate(reward.section, 100));
      if (session.doneItemIds.has(reward.itemId)) option.setDefault(true);
      return option;
    }));
  const rows: ChecklistRow[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];

  if (pageCount > 1) {
    const previous = new ButtonBuilder()
      .setCustomId(`ffe:page:${session.eventHash}:${session.panelToken}:prev:${Math.max(1, session.page)}`)
      .setLabel('Zurück')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.page === 0);
    const indicator = new ButtonBuilder()
      .setCustomId(`ffe:page:${session.eventHash}:${session.panelToken}:cur:${session.page + 1}`)
      .setLabel(`Seite ${session.page + 1}/${pageCount}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
    const next = new ButtonBuilder()
      .setCustomId(`ffe:page:${session.eventHash}:${session.panelToken}:next:${Math.min(pageCount, session.page + 2)}`)
      .setLabel('Weiter')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.page + 1 >= pageCount);
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(previous, indicator, next));
  }

  const reminder = new ButtonBuilder()
    .setCustomId(`ffe:reminder:${session.eventHash}:${session.panelToken}`)
    .setLabel('Erinnerungen an/aus')
    .setStyle(session.remindersEnabled ? ButtonStyle.Success : ButtonStyle.Secondary);
  const save = new ButtonBuilder()
    .setCustomId(`ffe:save:${session.eventHash}:${session.panelToken}`)
    .setLabel('Speichern')
    .setStyle(ButtonStyle.Primary);
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(reminder, save));
  return rows;
}

function viewContent(session: ChecklistSession, event: StoreEvent, message?: string): string {
  const pages = Math.max(1, Math.ceil(session.itemIds.length / PAGE_SIZE));
  return `${message ? `${message}\n` : ''}Meine Checkliste: ${event.title}\nSeite ${session.page + 1}/${pages} · Erinnerungen: ${session.remindersEnabled ? 'an' : 'aus'}`;
}

function interactionOptions(session: ChecklistSession, event: StoreEvent, message?: string) {
  return { content: viewContent(session, event, message), components: checklistRows(session, event) };
}

async function replyError(interaction: ChecklistInteraction, content: string, updateCurrent = false): Promise<void> {
  try {
    if (updateCurrent) await interaction.update({ content, components: [] });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {
    // Expired and stale Discord interactions are expected and should never escape the handler.
  }
}

export async function handleChecklistInteraction(
  interaction: ChecklistInteraction,
  store: Store,
  now = new Date(),
): Promise<void> {
  const parsed = parseChecklistCustomId(interaction.customId);
  if (!parsed) return;
  expireSessions(now.getTime());
  if (!interaction.inGuild() || !interaction.guildId) {
    await replyError(interaction, 'Die Checkliste funktioniert nur auf einem Server.');
    return;
  }

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  try {
    if (parsed.action === 'open') {
      const event = eventForHash(store, parsed.eventHash);
      const eventKey = event?.eventKey ?? parsed.eventHash;
      const checkedEvent = checkEvent(store, eventKey, now);
      if (!checkedEvent) {
        await replyError(interaction, errorForEvent(store, eventKey, now));
        return;
      }
      const sessionEvent = checkedEvent;
      ensureChecklistItems(store, guildId, userId, sessionEvent.eventKey, sessionEvent.rewards.map((reward) => reward.itemId));
      const remindersEnabled = ensureChecklistReminderPreference(store, guildId, userId, sessionEvent.eventKey);
      const validIds = new Set(sessionEvent.rewards.map((reward) => reward.itemId));
      const doneItemIds = new Set(getChecklistDoneItemIds(store, guildId, userId, sessionEvent.eventKey).filter((itemId) => validIds.has(itemId)));
      const panelToken = createPanelToken();
      const session: ChecklistSession = {
        guildId,
        userId,
        eventKey: sessionEvent.eventKey,
        eventHash: parsed.eventHash,
        panelToken,
        itemIds: sessionEvent.rewards.map((reward) => reward.itemId),
        fingerprint: eventFingerprint(sessionEvent),
        doneItemIds,
        page: 0,
        remindersEnabled,
        expiresAt: now.getTime() + SESSION_TTL_MS,
      };
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      sessions.set(panelToken, session);
      await interaction.reply({ ...interactionOptions(session, sessionEvent), flags: MessageFlags.Ephemeral });
      return;
    }

    const session = sessions.get(parsed.panelToken);
    if (!session || session.eventHash !== parsed.eventHash || session.guildId !== guildId || session.userId !== userId) {
      await replyError(interaction, 'Diese Checkliste ist abgelaufen. Bitte öffne sie erneut.', true);
      return;
    }
    if (session.expiresAt <= now.getTime()) {
      sessions.delete(parsed.panelToken);
      await replyError(interaction, 'Diese Checkliste ist abgelaufen. Bitte öffne sie erneut.', true);
      return;
    }
    const event = validateSession(store, session, now);
    if (!event) {
      sessions.delete(parsed.panelToken);
      await replyError(interaction, 'Die Belohnungsliste hat sich geändert oder das Event ist beendet. Bitte öffne die Checkliste erneut.', true);
      return;
    }

    if (parsed.action === 'select') {
      if (!interaction.isStringSelectMenu()) {
        await replyError(interaction, 'Diese Checklisten-Auswahl ist abgelaufen. Bitte öffne die Checkliste erneut.', true);
        return;
      }
      const selectedPage = parsed.page - 1;
      if (selectedPage !== session.page) {
        await replyError(interaction, 'Diese Checklisten-Seite ist abgelaufen. Bitte öffne die Checkliste erneut.', true);
        return;
      }
      const pageIds = new Set(session.itemIds.slice(selectedPage * PAGE_SIZE, (selectedPage + 1) * PAGE_SIZE));
      for (const itemId of pageIds) session.doneItemIds.delete(itemId);
      for (const itemId of interaction.values) if (pageIds.has(itemId)) session.doneItemIds.add(itemId);
      await interaction.update(interactionOptions(session, event, 'Auswahl geändert. Mit „Speichern“ übernimmst du deine Checkliste.'));
      return;
    }

    if (parsed.action === 'page') {
      const pageCount = Math.max(1, Math.ceil(session.itemIds.length / PAGE_SIZE));
      if (parsed.page > pageCount) {
        await replyError(interaction, 'Diese Checklisten-Seite gibt es nicht mehr.', true);
        return;
      }
      session.page = parsed.page - 1;
      await interaction.update(interactionOptions(session, event));
      return;
    }

    if (parsed.action === 'reminder') {
      session.remindersEnabled = !getChecklistReminderPreference(store, guildId, userId, session.eventKey);
      setChecklistReminderPreference(store, guildId, userId, session.eventKey, session.remindersEnabled);
      const state = session.remindersEnabled ? 'an' : 'aus';
      await interaction.update(interactionOptions(session, event, `Erinnerungen sind jetzt ${state}.`));
      return;
    }

    if (parsed.action === 'save') {
      saveSelection(store, {
        guildId,
        userId,
        eventKey: session.eventKey,
        itemIds: session.itemIds,
        doneItemIds: [...session.doneItemIds],
      });
      await interaction.update(interactionOptions(session, event,
        `Gespeichert: ${session.doneItemIds.size} von ${session.itemIds.length} erledigt.`));
    }
  } catch (error) {
    console.error('Checkliste fehlgeschlagen:', error);
    await replyError(interaction, 'Die Checkliste konnte gerade nicht gespeichert werden. Bitte versuche es erneut.', interaction.isStringSelectMenu());
  }
}
