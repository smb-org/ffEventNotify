// Reads process configuration shared by the public multi-server bot.

import { existsSync } from 'node:fs';
import { parseLogLevel, type LogLevel } from './log.ts';

export interface AppConfig {
  discordToken: string;
  dbPath: string;
  fixtureDumpDir?: string;
  logLevel: LogLevel;
}

export interface DryRunConfig {
  dbPath: string;
  fixtureDumpDir?: string;
}

export interface ReadConfigOptions {
  dryRun?: boolean;
  dbPath?: string;
  dumpDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function readConfig(options: ReadConfigOptions & { dryRun: true }): DryRunConfig;
export function readConfig(options?: ReadConfigOptions & { dryRun?: false }): AppConfig;
export function readConfig(options: ReadConfigOptions = {}): AppConfig | DryRunConfig {
  if (options.dryRun) {
    return {
      dbPath: options.dbPath ?? ':memory:',
      ...(options.dumpDir ? { fixtureDumpDir: options.dumpDir } : {}),
    };
  }

  if (options.env === undefined && existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const environment = options.env ?? process.env;

  const missing: string[] = [];
  const readRequired = (name: string): string => {
    const value = environment[name]?.trim();
    if (!value) {
      missing.push(name);
      return '';
    }
    return value;
  };

  const config: AppConfig = {
    discordToken: readRequired('DISCORD_TOKEN'),
    dbPath: environment.DB_PATH?.trim() || './data/ffeventnotify.sqlite',
    logLevel: parseLogLevel(environment.LOG_LEVEL),
    ...(environment.FIXTURE_DUMP_DIR?.trim() ? { fixtureDumpDir: environment.FIXTURE_DUMP_DIR.trim() } : {}),
  };

  if (missing.length > 0) {
    throw new Error('Missing required environment variables: ' + missing.join(', '));
  }

  return config;
}
