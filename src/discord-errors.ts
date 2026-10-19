export function discordErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

export function isUnknownDiscordResource(error: unknown): boolean {
  const code = discordErrorCode(error);
  return code === 10_003 || code === 10_008;
}
