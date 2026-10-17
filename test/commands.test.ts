import assert from 'node:assert/strict';
import { ApplicationCommand, ChannelType, Client, InteractionContextType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import test from 'node:test';
import { commandDefinitionSignature, createFfEventsCommand, missingSetupPermissions, registerGlobalFfEventsCommand } from '../src/commands.ts';

test('/ffevents setup requires a forum event channel and a text log channel', () => {
  const command = createFfEventsCommand().toJSON();
  const setup = command.options?.find((option) => option.name === 'setup') as unknown as {
    options?: Array<{ name: string; required?: boolean; type: number; channel_types?: number[] }>;
  } | undefined;
  assert.equal(command.name, 'ffevents');
  assert.equal(command.default_member_permissions, undefined);
  assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
  assert.ok(setup);
  assert.deepEqual(setup.options?.map((option) => ({ name: option.name, required: 'required' in option ? option.required : false })), [
    { name: 'event-kanal', required: true },
    { name: 'log-kanal', required: true },
  ]);
  const eventChannel = setup.options?.find((option) => option.name === 'event-kanal');
  const logChannel = setup.options?.find((option) => option.name === 'log-kanal');
  assert.deepEqual(eventChannel?.channel_types, [ChannelType.GuildForum]);
  assert.deepEqual(logChannel?.channel_types, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
  const follow = command.options?.find((option) => option.name === 'folgen') as unknown as {
    options?: Array<{ name: string; type: number; required?: boolean; choices?: Array<{ name: string; value: string }> }>;
  } | undefined;
  assert.deepEqual(follow?.options?.map((option) => ({ name: option.name, required: option.required, choices: option.choices })), [
    { name: 'status', required: true, choices: [
      { name: 'an', value: 'an', name_localizations: undefined },
      { name: 'aus', value: 'aus', name_localizations: undefined },
    ] },
  ]);
});

test('registration compares a real discord.js ApplicationCommand without crashing on serialized permissions', async () => {
  const client = new Client({ intents: [] });
  const raw = {
    id: '123456789012345678',
    application_id: '234567890123456789',
    type: 1,
    name: 'ffevents',
    description: 'FFXIV-Events für diesen Server einrichten',
    contexts: [InteractionContextType.Guild],
    options: createFfEventsCommand().toJSON().options,
  };
  const existing = Reflect.construct(ApplicationCommand as unknown as Function, [client, raw]) as ApplicationCommand;
  let edits = 0;
  const manager = {
    fetch: async () => [existing],
    create: async () => assert.fail('an unchanged command must not be created'),
    edit: async () => { edits += 1; },
  };
  try {
    assert.equal(await registerGlobalFfEventsCommand(manager as never), 'unchanged');
    assert.equal(edits, 0);
  } finally {
    client.destroy();
  }
});

test('setup permission check requires forum management, thread sending, and Create Events; Manage Channels stays optional', () => {
  const channelPermissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.SendMessagesInThreads,
  ]);
  assert.deepEqual(missingSetupPermissions(
    new PermissionsBitField([PermissionFlagsBits.CreateEvents]), channelPermissions, channelPermissions,
  ), []);

  const missing = missingSetupPermissions(new PermissionsBitField(), channelPermissions, new PermissionsBitField());
  const missingEventChannel = missingSetupPermissions(
    new PermissionsBitField([PermissionFlagsBits.CreateEvents]), new PermissionsBitField(), channelPermissions,
  );
  assert.ok(missing.includes('Server: Events erstellen'));
  assert.ok(missing.includes('Log-Kanal: Nachrichten senden'));
  assert.ok(!missing.includes('Event-Kanal: Kanäle verwalten'));
  assert.ok(missingEventChannel.includes('Event-Kanal: Threads verwalten (anheften und archivieren)'));
  assert.ok(missingEventChannel.includes('Event-Kanal: Nachrichten in Threads senden'));
});

test('command signature changes only when the registered definition changes', () => {
  const command = createFfEventsCommand().toJSON();
  const same = { ...command };
  const changed = { ...command, description: 'Andere Beschreibung' };
  assert.equal(commandDefinitionSignature(command as never), commandDefinitionSignature(same as never));
  assert.notEqual(commandDefinitionSignature(command as never), commandDefinitionSignature(changed as never));
});

test('global command registration creates once, leaves the same definition alone, and edits a changed definition', async () => {
  const desired = createFfEventsCommand().toJSON();
  let saved: Record<string, unknown> | undefined;
  let creates = 0;
  let edits = 0;
  const manager = {
    fetch: async () => saved ? [{
      ...saved,
      equals: (data: unknown) => commandDefinitionSignature(data as never) === commandDefinitionSignature(saved as never),
      toJSON: () => saved,
      edit: async (data: unknown) => { saved = data as Record<string, unknown>; },
    }] : [],
    create: async (data: unknown) => {
      creates += 1;
      saved = (data as { toJSON?: () => Record<string, unknown> }).toJSON?.() ?? data as Record<string, unknown>;
    },
    edit: async (_command: unknown, data: unknown) => { edits += 1; saved = data as Record<string, unknown>; },
  };

  assert.equal(await registerGlobalFfEventsCommand(manager as never), 'created');
  assert.equal(await registerGlobalFfEventsCommand(manager as never), 'unchanged');
  saved = { ...saved, description: 'alte Version' };
  assert.equal(await registerGlobalFfEventsCommand(manager as never), 'updated');
  assert.equal(creates, 1);
  assert.equal(edits, 1);
  assert.equal((saved as { description: string }).description, desired.description);
});
