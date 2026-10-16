export interface HistoryMessageLike {
  id: string;
  authorId: string;
}

export async function collectRecentBotMessages<T extends HistoryMessageLike>(
  fetchPage: (limit: number, before?: string) => Promise<readonly T[]>,
  botId: string,
  limit: number,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<{ messages: T[]; complete: boolean; pagesFetched: number }> {
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100));
  const maxPages = Math.max(1, options.maxPages ?? 20);
  const desired = Math.max(0, Math.trunc(limit));
  const botMessages: T[] = [];
  let before: string | undefined;
  let complete = desired === 0;
  let pagesFetched = 0;

  for (let pageNumber = 0; pageNumber < maxPages && botMessages.length < desired; pageNumber += 1) {
    const page = await fetchPage(pageSize, before);
    pagesFetched += 1;
    if (page.length === 0) {
      complete = true;
      break;
    }
    for (const message of page) {
      if (message.authorId === botId) botMessages.push(message);
      if (botMessages.length >= desired) break;
    }
    if (botMessages.length >= desired) {
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
  }
  return { messages: botMessages.slice(0, desired), complete, pagesFetched };
}
