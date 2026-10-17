// Identifies the running build: package version plus commit and build time baked into the image.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unbekannt';
  } catch {
    return 'unbekannt';
  }
}

function localGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 }).toString().trim() || 'unbekannt';
  } catch {
    return 'unbekannt';
  }
}

export function versionLine(
  env: NodeJS.ProcessEnv = process.env,
  version: string = packageVersion(),
  gitSha: () => string = localGitSha,
): string {
  const sha = env.FFE_GIT_SHA?.trim();
  const built = env.FFE_BUILD_TIME?.trim();
  if (sha) return `ffEventNotify ${version} (sha-${sha.slice(0, 7)}${built ? `, gebaut ${built}` : ''})`;
  return `ffEventNotify ${version} (lokal, ${gitSha()})`;
}
