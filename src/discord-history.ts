export interface HistoryMessageLike {
  id: string;
  authorId: string;
}

export async function collectRecentBotMessages<T extends HistoryMessageLike>(
  fetchPage: (limit: number, before?: string) => Promise<readonly T[]>,
  botId: string,
  limit: number,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100));
  const maxPages = Math.max(1, options.maxPages ?? 10);
  const desired = Math.max(0, Math.trunc(limit));
  const botMessages: T[] = [];
  let before: string | undefined;

  for (let pageNumber = 0; pageNumber < maxPages && botMessages.length < desired; pageNumber += 1) {
    const page = await fetchPage(pageSize, before);
    if (page.length === 0) break;
    for (const message of page) {
      if (message.authorId === botId) botMessages.push(message);
      if (botMessages.length >= desired) break;
    }
    if (page.length < pageSize) break;
    before = page.at(-1)?.id;
    if (!before) break;
  }
  return botMessages.slice(0, desired);
}
