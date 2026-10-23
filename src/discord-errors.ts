export function discordErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

export function isUnknownDiscordResource(error: unknown): boolean {
  const code = discordErrorCode(error);
  return code === 10_003 || code === 10_008;
}

export function isDiscordNotFound(error: unknown): boolean {
  if (isUnknownDiscordResource(error)) return true;
  const code = discordErrorCode(error);
  if (code === 10_004 || code === 10_070) return true;
  if (typeof error !== 'object' || error === null) return false;
  return ('status' in error && error.status === 404)
    || ('statusCode' in error && error.statusCode === 404)
    || ('httpStatus' in error && error.httpStatus === 404);
}
