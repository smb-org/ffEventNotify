import assert from 'node:assert/strict';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
} from 'discord.js';
import type { DiscordActionRow } from '../src/types.ts';

type ComponentRowBuilder = {
  toJSON(): APIActionRowComponent<APIComponentInMessageActionRow>;
};

export function assertDiscordComponentPayload(rows: readonly ComponentRowBuilder[]) {
  const serialized = rows.map((row) => row.toJSON());
  assert.ok(serialized.length <= 5, 'a message may contain at most 5 component rows');

  const customIds: string[] = [];
  for (const row of serialized) {
    assert.ok(row.components.length <= 5, 'a component row may contain at most 5 components');
    for (const component of row.components) {
      if ('custom_id' in component && component.custom_id !== undefined) {
        assert.ok(component.custom_id.length <= 100, 'custom_id must be at most 100 characters');
        customIds.push(component.custom_id);
      }
      if ('label' in component && component.label !== undefined) {
        assert.ok(component.label.length <= 100, 'component labels must be at most 100 characters');
      }
      if (component.type === 3) {
        assert.ok(component.options.length <= 25, 'a select menu may contain at most 25 options');
        for (const option of component.options) {
          assert.ok(option.label.length <= 100, 'select option labels must be at most 100 characters');
          assert.ok(option.value.length <= 100, 'select option values must be at most 100 characters');
        }
      }
      if (component.type === 2 && component.style === ButtonStyle.Link) {
        assert.ok(component.url, 'a link button must have a URL');
        assert.equal('custom_id' in component ? component.custom_id : undefined, undefined, 'a link button must not have a custom_id');
      }
    }
  }
  assert.equal(new Set(customIds).size, customIds.length, 'custom_ids must be unique within a message');
  return serialized;
}

export function assertDiscordActionRows(rows: readonly DiscordActionRow[]) {
  const builders = rows.map((row) => {
    const first = row.components[0];
    if (!first) return new ActionRowBuilder<ButtonBuilder>();
    if (first.type === 'string-select') {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(first.customId)
        .setMinValues(first.minValues)
        .setMaxValues(first.maxValues)
        .addOptions(first.options.map((option) => {
          const builder = new StringSelectMenuOptionBuilder()
            .setLabel(option.label)
            .setValue(option.value);
          if (option.description !== undefined) builder.setDescription(option.description);
          if (option.default !== undefined) builder.setDefault(option.default);
          return builder;
        }));
      if (first.placeholder !== undefined) menu.setPlaceholder(first.placeholder);
      return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    }

    const buttons = row.components.map((component) => {
      assert.equal(component.type, 'button', 'Discord rows cannot mix component types');
      const button = new ButtonBuilder().setLabel(component.label).setStyle(
        component.style === 'primary' ? ButtonStyle.Primary
          : component.style === 'secondary' ? ButtonStyle.Secondary
            : ButtonStyle.Link,
      );
      if (component.style === 'link') {
        if (component.url !== undefined) button.setURL(component.url);
      } else if (component.customId !== undefined) {
        button.setCustomId(component.customId);
      }
      if (component.disabled !== undefined) button.setDisabled(component.disabled);
      return button;
    });
    return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
  });
  return assertDiscordComponentPayload(builders);
}
