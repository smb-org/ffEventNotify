export interface HistoryMessageLike {
  id: string;
  authorId: string;
  createdAt?: string;
}

export async function collectRecentBotMessages<T extends HistoryMessageLike>(
  fetchPage: (limit: number, before?: string) => Promise<readonly T[]>,
  botId: string,
  limit: number,
  options: { pageSize?: number; maxPages?: number; olderThan?: string; requireChannelStart?: boolean } = {},
): Promise<{ messages: T[]; complete: boolean; pagesFetched: number }> {
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100));
  const maxPages = Math.max(1, options.maxPages ?? 20);
  const desired = Math.max(0, Math.trunc(limit));
  const olderThan = options.olderThan === undefined ? Number.NaN : Date.parse(options.olderThan);
  const requireBoundary = options.requireChannelStart === true || Number.isFinite(olderThan);
  const botMessages: T[] = [];
  let before: string | undefined;
  let complete = desired === 0 && !requireBoundary;
  let pagesFetched = 0;

  for (let pageNumber = 0; pageNumber < maxPages && (requireBoundary || botMessages.length < desired); pageNumber += 1) {
    const page = await fetchPage(pageSize, before);
    pagesFetched += 1;
    if (page.length === 0) {
      complete = true;
      break;
    }
    let reachedAttemptBoundary = false;
    for (const message of page) {
      if (message.authorId === botId && botMessages.length < desired) botMessages.push(message);
      const createdAt = message.createdAt === undefined ? Number.NaN : Date.parse(message.createdAt);
      if (Number.isFinite(olderThan) && Number.isFinite(createdAt) && createdAt < olderThan) {
        reachedAttemptBoundary = true;
        break;
      }
      if (!requireBoundary && botMessages.length >= desired) break;
      if (Number.isFinite(olderThan) && botMessages.length >= desired) break;
    }
    if (reachedAttemptBoundary) {
      complete = true;
      break;
    }
    if (page.length < pageSize) {
      complete = true;
      break;
    }
    before = page.at(-1)?.id;
    if (!before) {
      complete = true;
      break;
    }
    if (!options.requireChannelStart && Number.isFinite(olderThan) && botMessages.length >= desired) break;
    if (!requireBoundary && botMessages.length >= desired) {
      complete = true;
      break;
    }
  }
  return { messages: botMessages.slice(0, desired), complete, pagesFetched };
}
