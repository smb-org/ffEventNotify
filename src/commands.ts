import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApplicationCommandManager } from 'discord.js';

export function createFfEventsCommand() {
  return new SlashCommandBuilder()
    .setName('ffevents')
    .setDescription('FFXIV-Events für diesen Server einrichten')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) => subcommand
      .setName('setup')
      .setDescription('Event- und Log-Kanal für diesen Server festlegen')
      .addChannelOption((option) => option
        .setName('event-kanal')
        .setDescription('Hier veröffentlicht der Bot Events und den Live-Status')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true))
      .addChannelOption((option) => option
        .setName('log-kanal')
        .setDescription('Hier erscheinen Warnungen und der Erststart-Bericht')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)));
}

export function commandDefinitionSignature(command: {
  name: string;
  description: string;
  options?: readonly unknown[];
  default_member_permissions?: string | null;
  defaultMemberPermissions?: { bitfield: bigint } | null;
}): string {
  const permissions = command.default_member_permissions ?? command.defaultMemberPermissions?.bitfield.toString() ?? null;
  return JSON.stringify({
    name: command.name,
    description: command.description,
    options: command.options ?? [],
    default_member_permissions: permissions,
  });
}

const channelRequirements: Array<[bigint, string]> = [
  [PermissionFlagsBits.ViewChannel, 'Kanal ansehen'],
  [PermissionFlagsBits.SendMessages, 'Nachrichten senden'],
  [PermissionFlagsBits.EmbedLinks, 'Links einbetten'],
  [PermissionFlagsBits.ReadMessageHistory, 'Nachrichtenverlauf lesen'],
];

export function missingSetupPermissions(
  guildPermissions: PermissionsBitField | null,
  eventChannelPermissions: PermissionsBitField | null,
  logChannelPermissions: PermissionsBitField | null,
): string[] {
  const missing: string[] = [];
  for (const [permission, label] of channelRequirements) {
    if (!eventChannelPermissions?.has(permission)) missing.push(`Event-Kanal: ${label}`);
    if (!logChannelPermissions?.has(permission)) missing.push(`Log-Kanal: ${label}`);
  }
  const canPinEvent = eventChannelPermissions?.has(PermissionFlagsBits.PinMessages) || eventChannelPermissions?.has(PermissionFlagsBits.ManageMessages);
  if (!canPinEvent) missing.push('Event-Kanal: Nachrichten anheften oder Nachrichten verwalten');
  const canPinLog = logChannelPermissions?.has(PermissionFlagsBits.PinMessages) || logChannelPermissions?.has(PermissionFlagsBits.ManageMessages);
  if (!canPinLog) missing.push('Log-Kanal: Nachrichten anheften oder Nachrichten verwalten');
  if (!guildPermissions?.has(PermissionFlagsBits.CreateEvents)) missing.push('Server: Events erstellen');
  return missing;
}

export async function registerGlobalFfEventsCommand(
  commands: ApplicationCommandManager,
): Promise<'created' | 'updated' | 'unchanged'> {
  const definition = createFfEventsCommand();
  const registered = await commands.fetch();
  const existing = registered.find((command) => command.name === 'ffevents');
  if (!existing) {
    await commands.create(definition);
    return 'created';
  }
  if (commandDefinitionSignature(existing.toJSON() as never) === commandDefinitionSignature(definition.toJSON() as never)) {
    return 'unchanged';
  }
  await commands.edit(existing, definition.toJSON() as never);
  return 'updated';
}
