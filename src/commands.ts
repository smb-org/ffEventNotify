import {
  ChannelType,
  InteractionContextType,
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
    .setContexts(InteractionContextType.Guild)
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
  type?: number;
  options?: readonly unknown[];
  default_member_permissions?: string | null;
  defaultMemberPermissions?: bigint | { bitfield: bigint } | null;
  contexts?: readonly number[] | null;
}): string {
  const serializedPermissions = command.defaultMemberPermissions;
  const permissions = command.default_member_permissions ?? (
    typeof serializedPermissions === 'bigint'
      ? serializedPermissions.toString()
      : serializedPermissions?.bitfield.toString()
  ) ?? null;
  const normalizeOption = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalizeOption);
    if (value === null || typeof value !== 'object') return value;
    const input = value as Record<string, unknown>;
    const aliases: Record<string, string> = {
      channelTypes: 'channel_types',
      minValue: 'min_value',
      maxValue: 'max_value',
      minLength: 'min_length',
      maxLength: 'max_length',
      nameLocalizations: 'name_localizations',
      descriptionLocalizations: 'description_localizations',
    };
    return Object.fromEntries(Object.entries(input)
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .map(([key, entry]) => [aliases[key] ?? key, normalizeOption(entry)])
      .sort(([left], [right]) => String(left).localeCompare(String(right))));
  };
  return JSON.stringify({
    name: command.name,
    description: command.description,
    type: command.type ?? 1,
    contexts: command.contexts ?? [],
    options: normalizeOption(command.options ?? []),
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
  const desired = definition.toJSON();
  if ((typeof existing.equals === 'function' && existing.equals(desired as never))
    || commandDefinitionSignature(existing) === commandDefinitionSignature(desired)) {
    return 'unchanged';
  }
  await commands.edit(existing, desired as never);
  return 'updated';
}
