import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { getGuild, isGuildSidebarFollowEnabled, setGuildSidebarFollow, type Store } from '../store.ts';
import { syncSidebarFollowForUser, sidebarFollowCustomId } from '../sidebar-follow.ts';
import { withGuildDiscordLock } from '../guild-lock.ts';
import type { DiscordPort } from '../types.ts';

const ENABLED_REPLY = 'Aktiviert: du siehst jetzt alle laufenden Events links in der Kanalliste.';
const DISABLED_REPLY = 'Deaktiviert: du siehst jetzt keine Events mehr links in der Kanalliste.';

async function updateSidebarFollow(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  store: Store,
  enabled: boolean | 'toggle',
  discordPort: DiscordPort,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: 'Dieser Befehl funktioniert nur auf einem Server.', flags: MessageFlags.Ephemeral });
    return;
  }
  const guildId = interaction.guildId;
  const guild = getGuild(store, guildId);
  if (!guild?.eventChannelId || guild.needsSetup) {
    await interaction.reply({ content: 'Der Bot ist auf diesem Server noch nicht eingerichtet. Bitte richte ihn mit `/ffevents setup` ein.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let isEnabled = false;
  try {
    await withGuildDiscordLock(guildId, async () => {
      isEnabled = enabled === 'toggle'
        ? !isGuildSidebarFollowEnabled(store, guildId, interaction.user.id)
        : enabled;
      setGuildSidebarFollow(store, guildId, interaction.user.id, isEnabled);
      await syncSidebarFollowForUser({
        db: store,
        discord: discordPort,
        guildId,
        eventChannelId: guild.eventChannelId!,
        userId: interaction.user.id,
        enabled: isEnabled,
      });
    });
    await interaction.editReply({ content: isEnabled ? ENABLED_REPLY : DISABLED_REPLY });
  } catch (error) {
    console.error(`Die Seitenleisten-Einstellung für Server ${guildId} konnte nicht vollständig synchronisiert werden.`, error);
    await interaction.editReply({ content: 'Deine Einstellung wurde gespeichert, aber die Events konnten gerade nicht vollständig aktualisiert werden.' });
  }
}

export async function handleSidebarFollowCommand(
  interaction: ChatInputCommandInteraction,
  store: Store,
  discordPort: DiscordPort,
): Promise<void> {
  const status = interaction.options.getString('status', true);
  if (status !== 'an' && status !== 'aus') {
    await interaction.reply({ content: 'Bitte wähle „an“ oder „aus“.', flags: MessageFlags.Ephemeral });
    return;
  }
  await updateSidebarFollow(interaction, store, status === 'an', discordPort);
}

export async function handleSidebarFollowButton(
  interaction: ButtonInteraction,
  store: Store,
  discordPort: DiscordPort,
): Promise<void> {
  if (!interaction.guildId || interaction.customId !== sidebarFollowCustomId(interaction.guildId)) {
    await interaction.reply({ content: 'Diese Schaltfläche gehört zu einem anderen Server.', flags: MessageFlags.Ephemeral });
    return;
  }
  await updateSidebarFollow(interaction, store, 'toggle', discordPort);
}
