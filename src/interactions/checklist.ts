// The "Meine Checkliste" button and /ffevents neuer-link hand out the personal web checklist link.

import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { getAllEvents, type Store } from '../store.ts';
import { getOrCreateToken, recordUserGuild, rotateToken } from '../web/data.ts';
import { eventHash, hasChecklist } from '../web/render.ts';
import type { TokenCodec } from '../web/token.ts';

export interface WebLinkContext {
  codec: TokenCodec;
  /** Public base URL without trailing slash. */
  baseUrl: string;
}

export type ChecklistCustomId = { action: 'open'; eventHash: string };

export function parseChecklistCustomId(customId: string): ChecklistCustomId | undefined {
  const match = /^ffe:cl:([a-f0-9]{32})$/.exec(customId);
  return match ? { action: 'open', eventHash: match[1]! } : undefined;
}

const EPHEMERAL = MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds;

export async function handleChecklistInteraction(interaction: ButtonInteraction, store: Store, web: WebLinkContext): Promise<void> {
  const parsed = parseChecklistCustomId(interaction.customId);
  if (!parsed) return;
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: 'Die Checkliste funktioniert nur auf einem Server.', flags: EPHEMERAL });
    return;
  }
  const event = getAllEvents(store).find((entry) => hasChecklist(entry) && eventHash(entry.eventKey) === parsed.eventHash);
  if (!event) {
    await interaction.reply({ content: 'Diese Checkliste ist nicht mehr verfügbar.', flags: EPHEMERAL });
    return;
  }
  const userId = interaction.user.id;
  recordUserGuild(store, userId, interaction.guildId);
  const token = getOrCreateToken(store, web.codec, userId);
  await interaction.reply({
    content: `Deine Checkliste für „${event.title}“: ${web.baseUrl}/c/${token}/e/${parsed.eventHash} — nur für dich, bitte nicht teilen.`,
    flags: EPHEMERAL,
    allowedMentions: { parse: [] },
  });
}

export async function handleNewLinkCommand(interaction: ChatInputCommandInteraction, store: Store, web: WebLinkContext): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: 'Dieser Befehl funktioniert nur auf einem Server.', flags: EPHEMERAL });
    return;
  }
  recordUserGuild(store, interaction.user.id, interaction.guildId);
  const token = rotateToken(store, web.codec, interaction.user.id);
  await interaction.reply({
    content: `Dein neuer Link: ${web.baseUrl}/c/${token} — der alte Link funktioniert nicht mehr. Nur für dich, bitte nicht teilen.`,
    flags: EPHEMERAL,
  });
}
