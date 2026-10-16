// Parses community-wiki data for log-only event cross-checks.

import { load } from 'cheerio';
import type { FetchText, KnownEventTitle, WikiEvent } from '../types.ts';

export const WIKI_EVENT_URLS = [
  'https://ffxiv.consolegameswiki.com/wiki/Seasonal_Events',
  'https://ffxiv.consolegameswiki.com/wiki/Moogle_Treasure_Trove_Events',
] as const;

export type WikiParseResult =
  | { ok: true; events: WikiEvent[]; unparsed: WikiEvent[] }
  | { ok: false; reason: string };

export type WikiComparisonResult =
  | {
      ok: true;
      unmatched: WikiEvent[];
      unparsed: WikiEvent[];
      missingEventTitles: string[];
      checkedAtUtc: string;
    }
  | { ok: false; reason: string; checkedAtUtc: string };

const monthNumbers: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

const monthNamePattern = Object.keys(monthNumbers).join('|');

interface ParsedRange {
  startUtc: string;
  endUtc: string;
}

function parseDateRange(text: string): ParsedRange | undefined {
  const match = text.trim().match(new RegExp(
    `^(${monthNamePattern})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\s*[-–]\\s*(${monthNamePattern})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?$`,
    'i',
  ));
  if (match === null) return undefined;
  const startMonthName = match[1]!;
  const startDay = Number(match[2]);
  const endMonthName = match[4]!;
  const endDay = Number(match[5]);
  const endYear = Number(match[6] ?? match[3]);
  if (!Number.isInteger(endYear)) return undefined;
  let startYear = Number(match[3] ?? endYear);
  const startMonth = monthNumbers[Object.keys(monthNumbers).find((month) => month.toLowerCase() === startMonthName.toLowerCase())!]!;
  const endMonth = monthNumbers[Object.keys(monthNumbers).find((month) => month.toLowerCase() === endMonthName.toLowerCase())!]!;
  if (match[3] === undefined && startMonth > endMonth) startYear -= 1;

  const start = new Date(Date.UTC(startYear, startMonth - 1, startDay));
  const end = new Date(Date.UTC(endYear, endMonth - 1, endDay, 23, 59, 59, 999));
  if (start.getUTCMonth() !== startMonth - 1 || start.getUTCDate() !== startDay
    || end.getUTCMonth() !== endMonth - 1 || end.getUTCDate() !== endDay || start > end) return undefined;
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

function isInRange(now: Date, range: ParsedRange): boolean {
  const instant = now.getTime();
  return instant >= Date.parse(range.startUtc) && instant <= Date.parse(range.endUtc);
}

function parseSeasonalPage(html: string, now: Date): WikiParseResult | undefined {
  const $ = load(html);
  const content = $('#mw-content-text');
  if (!content.length) return undefined;
  const month = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(now);
  let foundMonth = false;
  const unparsed: WikiEvent[] = [];
  content.find('h2, h3').each((_, element) => {
    const heading = $(element).text().replace(/\s+/g, ' ').trim();
    const match = heading.match(new RegExp(`^${month}\\s*:\\s*(.+)$`, 'i'));
    if (match === null) return;
    foundMonth = true;
    const name = match[1]!.trim();
    if (!name || /^no regularly scheduled special events\.?$/i.test(name)) return;
    unparsed.push({ name, unparsedReason: 'Seasonal event page has no reliable event date range' });
  });
  return foundMonth ? { ok: true, events: [], unparsed } : undefined;
}

function parseMooglePage(html: string, now: Date): WikiParseResult | undefined {
  const $ = load(html);
  const content = $('#mw-content-text');
  if (!content.length) return undefined;
  let eventTable: ReturnType<typeof content.find> | undefined;
  content.find('table').each((_, table) => {
    const firstRow = $(table).find('tr').first().children('th, td').map((__, cell) => $(cell).text().trim()).get();
    if (/^name$/i.test(firstRow[0] ?? '') && /^event period$/i.test(firstRow[1] ?? '')) {
      eventTable = $(table);
      return false;
    }
    return undefined;
  });
  if (eventTable === undefined) return undefined;

  const events: WikiEvent[] = [];
  const unparsed: WikiEvent[] = [];
  eventTable.find('tr').slice(1).each((_, row) => {
    const cells = $(row).children('td');
    const name = $(cells[0]).text().replace(/\s+/g, ' ').trim();
    const periodText = $(cells[1]).text().replace(/\s+/g, ' ').trim();
    if (!name || !periodText) return;
    const range = parseDateRange(periodText);
    if (range === undefined) {
      if (periodText.includes(String(now.getUTCFullYear()))) {
        unparsed.push({ name, unparsedReason: 'Moogle event period could not be parsed' });
      }
      return;
    }
    if (isInRange(now, range)) events.push({ name, ...range });
  });
  return { ok: true, events, unparsed };
}

export function parseWikiEvents(html: string, now: Date): WikiParseResult {
  try {
    return parseMooglePage(html, now) ?? parseSeasonalPage(html, now) ?? {
      ok: false,
      reason: 'No supported wiki event structure found',
    };
  } catch {
    return { ok: false, reason: 'Wiki event structure could not be parsed' };
  }
}

function overlapsWithOneDayTolerance(wikiEvent: WikiEvent, known: KnownEventTitle): boolean {
  if (wikiEvent.startUtc === undefined || wikiEvent.endUtc === undefined
    || known.startUtc === undefined || known.endUtc === undefined) return false;
  const wikiStart = Date.parse(wikiEvent.startUtc);
  const wikiEnd = Date.parse(wikiEvent.endUtc);
  const knownStart = Date.parse(known.startUtc);
  const knownEnd = Date.parse(known.endUtc);
  if (![wikiStart, wikiEnd, knownStart, knownEnd].every(Number.isFinite)) return false;
  const tolerance = 86_400_000;
  return wikiStart <= knownEnd + tolerance && wikiEnd >= knownStart - tolerance;
}

export function compareWithKnown(
  wikiEvents: readonly WikiEvent[],
  knownEventTitles: readonly KnownEventTitle[],
): WikiEvent[] {
  return wikiEvents.filter((wikiEvent) =>
    wikiEvent.startUtc !== undefined && wikiEvent.endUtc !== undefined
      && !knownEventTitles.some((known) => overlapsWithOneDayTolerance(wikiEvent, known)),
  );
}

export async function runDailyWikiCrossCheck(
  fetchText: FetchText,
  knownEventTitles: readonly KnownEventTitle[],
  now: Date,
): Promise<WikiComparisonResult> {
  const checkedAtUtc = now.toISOString();
  try {
    const parsed: Extract<WikiParseResult, { ok: true }>[] = [];
    for (const url of WIKI_EVENT_URLS) {
      const response = await fetchText(url, { priority: 'wiki' });
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: `Wiki request failed with status ${response.status}`, checkedAtUtc };
      }
      const result = parseWikiEvents(response.body, now);
      if (!result.ok) return { ok: false, reason: result.reason, checkedAtUtc };
      parsed.push(result);
    }
    const events = parsed.flatMap((result) => result.events);
    const unparsed = parsed.flatMap((result) => result.unparsed);
    const unmatched = compareWithKnown(events, knownEventTitles);
    return {
      ok: true,
      unmatched,
      unparsed,
      missingEventTitles: unmatched.map((event) => event.name),
      checkedAtUtc,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Wiki request failed',
      checkedAtUtc,
    };
  }
}
