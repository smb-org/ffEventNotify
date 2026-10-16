// Implements Design: single-server configuration from .env through process.env.

import { existsSync } from 'node:fs';

export interface AppConfig {
  discordToken: string;
  guildId: string;
  eventChannelId: string;
  logChannelId: string;
  dbPath: string;
  fixtureDumpDir: string;
}

export function readConfig(): AppConfig {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const missing: string[] = [];
  const readRequired = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) {
      missing.push(name);
      return '';
    }
    return value;
  };

  const config: AppConfig = {
    discordToken: readRequired('DISCORD_TOKEN'),
    guildId: readRequired('GUILD_ID'),
    eventChannelId: readRequired('EVENT_CHANNEL_ID'),
    logChannelId: readRequired('LOG_CHANNEL_ID'),
    dbPath: readRequired('DB_PATH'),
    fixtureDumpDir: readRequired('FIXTURE_DUMP_DIR'),
  };

  if (missing.length > 0) {
    throw new Error('Missing required environment variables: ' + missing.join(', '));
  }

  return config;
}
