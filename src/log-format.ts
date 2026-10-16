export const UNCLASSIFIED_NOTICE_HEADER = 'Neue Lodestone-News ohne Event:';
export const MAX_LOG_MESSAGE_LENGTH = 2_000;

export interface UnclassifiedNoticeItem {
  title: string;
  url: string;
}

export function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[\\[\]()*_~`|]/g, '\\$&');
}

function unclassifiedNoticeLine(item: UnclassifiedNoticeItem, maxLength: number): string {
  const prefix = '• [';
  const suffix = `](<${item.url}>)`;
  const titleRoom = Math.max(0, maxLength - prefix.length - suffix.length - 1);
  const titleText = item.title.replace(/\s+/g, ' ').trim();
  let title = '';
  for (const character of titleText) {
    const escaped = escapeMarkdownLinkText(character);
    if (title.length + escaped.length + 1 > titleRoom) break;
    title += escaped;
  }
  if (title.length < escapeMarkdownLinkText(titleText).length && titleRoom > title.length) title += '…';
  return `${prefix}${title || '…'}${suffix}`;
}

export function splitUnclassifiedNotices(
  items: readonly UnclassifiedNoticeItem[],
  maxLength = MAX_LOG_MESSAGE_LENGTH,
): string[] {
  const lines: string[] = [];
  const lineLimit = maxLength - UNCLASSIFIED_NOTICE_HEADER.length - 1;
  for (const item of items) lines.push(unclassifiedNoticeLine(item, lineLimit));

  const messages: string[] = [];
  let currentLines: string[] = [];
  const flush = () => {
    if (currentLines.length === 0) return;
    messages.push(`${UNCLASSIFIED_NOTICE_HEADER}\n${currentLines.join('\n')}`);
    currentLines = [];
  };
  for (const line of lines) {
    const proposedLength = UNCLASSIFIED_NOTICE_HEADER.length + 1
      + currentLines.reduce((length, current) => length + current.length + 1, 0) + line.length;
    if (currentLines.length > 0 && proposedLength > maxLength) flush();
    currentLines.push(line);
  }
  flush();
  return messages;
}

function wrapBareUrls(value: string): string {
  return value.replace(/(?<!<)https?:\/\/[^\s<>]+/gi, (match) => {
    const trailing = match.match(/[.,;:!?)]*$/)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return `${url ? `<${url}>` : ''}${trailing}`;
  });
}

export function formatLogContent(content: string): string {
  const isUnclassifiedNotice = content.startsWith(`${UNCLASSIFIED_NOTICE_HEADER}\n`);
  const oneLine = isUnclassifiedNotice ? content : content.replace(/[\r\n]+/g, ' ');
  return wrapBareUrls(oneLine);
}
