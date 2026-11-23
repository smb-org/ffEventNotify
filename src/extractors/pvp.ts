// Extracts stable PvP season identities and the date evidence present in topic articles.

import { load } from 'cheerio';
import { parseGermanDateTime, type BerlinTimezoneLabel } from '../time.ts';

export interface PvpSeasonUpdate {
  eventKey: string;
  title: string;
  startUtc?: string;
  endUtc?: string;
  endPatch?: string;
  /** Local calendar date stated alongside a patch-bound end, used only as a cross-check. */
  expectedEndDate?: string;
}

interface ParsedDateTime {
  utc: string;
  localDate: string;
  length: number;
}

const dateTimePrefix = /^(?:(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),?\s*)?(?:den\s+)?(\d{1,2})\.\s*([\p{L}]+)\.?(?:\s+(\d{4}))?\s+um\s+(?:ca\.\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:Uhr)?\s*(?:\((MESZ|MEZ)\))?/iu;
const dateOnlyPrefix = /^(?:(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),?\s*)?(?:den\s+)?(\d{1,2})\.\s*([\p{L}]+)\.?(?:\s+(\d{4}))?/iu;
const months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function articleText(html: string): string {
  const $ = load(html);
  const body = $('article.news__detail > div.news__detail__wrapper').first();
  const node = body.length ? body : $('body');
  const separated = (node.html() ?? '')
    .replace(/<br\s*\/?\s*>/giu, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li|section|tr|table)>/giu, ' ')
    .replace(/<(?:p|div|h[1-6]|li|section|tr|table)\b[^>]*>/giu, ' ');
  return load(`<div>${separated}</div>`).text().replace(/\s+/g, ' ').trim();
}

function berlinDateParts(publishedAt: string): { year: number; month: number; day: number } | undefined {
  const time = Date.parse(publishedAt);
  if (!Number.isFinite(time)) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(time));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function localDate(day: string, month: string, year: string | undefined, publishedAt: string): string | undefined {
  const normalizedMonth = months.find((candidate) => candidate.toLocaleLowerCase('de-DE') === month.replace(/\.$/, '').toLocaleLowerCase('de-DE'));
  if (!normalizedMonth) return undefined;
  const monthNumber = months.indexOf(normalizedMonth) + 1;
  const dayNumber = Number(day);
  if (year) return dateInYear(dayNumber, normalizedMonth, monthNumber, Number(year));
  const publication = berlinDateParts(publishedAt);
  if (!publication) return undefined;
  let candidateYear = publication.year;
  if (monthNumber < publication.month || monthNumber === publication.month && dayNumber < publication.day) candidateYear += 1;
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = dateInYear(dayNumber, normalizedMonth, monthNumber, candidateYear + offset);
    if (candidate) return candidate;
  }
  return undefined;
}

function dateInYear(day: number, month: string, monthNumber: number, year: number): string | undefined {
  const date = `${day}. ${month} ${year}`;
  if (parseGermanDateTime(date, '12:00').status !== 'ok') return undefined;
  return `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateTime(value: string, publishedAt: string): ParsedDateTime | undefined {
  const match = dateTimePrefix.exec(value);
  if (!match) return undefined;
  const date = localDate(match[1]!, match[2]!, match[3], publishedAt);
  if (!date) return undefined;
  const month = months[Number(date.slice(5, 7)) - 1]!;
  const dateText = `${Number(match[1])}. ${month} ${date.slice(0, 4)}`;
  const timeText = `${Number(match[4])}:${match[5] ?? '00'}`;
  const label = match[6] as BerlinTimezoneLabel | undefined;
  const parsed = parseGermanDateTime(dateText, timeText, label);
  if (parsed.status !== 'ok') return undefined;
  return { utc: parsed.utc.replace('.000Z', 'Z'), localDate: date, length: match[0].length };
}

function parseDate(value: string, publishedAt: string): { localDate: string; length: number } | undefined {
  const match = dateOnlyPrefix.exec(value);
  if (!match) return undefined;
  const date = localDate(match[1]!, match[2]!, match[3], publishedAt);
  return date ? { localDate: date, length: match[0].length } : undefined;
}

function titleFor(kind: 'cc' | 'series' | 'crucible', season: string): { eventKey: string; title: string } {
  if (kind === 'cc') return { eventKey: `pvp:cc:${season}`, title: `Crystalline Conflict – ${season}. Saison` };
  if (kind === 'series') return { eventKey: `pvp:series:${season}`, title: `PvP-Serie ${season}` };
  return { eventKey: `pvp:crucible:${season}`, title: `Brett der Bestie – ${season}. Saison` };
}

function addUpdate(
  updates: Map<string, PvpSeasonUpdate>,
  kind: 'cc' | 'series' | 'crucible',
  season: string,
  fields: Omit<PvpSeasonUpdate, 'eventKey' | 'title'>,
): void {
  const identity = titleFor(kind, season);
  const previous = updates.get(identity.eventKey);
  updates.set(identity.eventKey, { ...previous, ...identity, ...fields });
}

function extractPatchEnd(text: string, publishedAt: string): { patch: string; expectedDate?: string } | undefined {
  const match = /bis\s+zum\s+Beginn\s+der\s+Wartungsarbeiten\s+für\s+Patch\s+(\d+\.\d+)(?:\s+am\s+)?/iu.exec(text);
  if (!match) return undefined;
  const date = /\bam\s+$/iu.test(match[0])
    ? parseDate(text.slice(match.index + match[0].length), publishedAt)
    : undefined;
  return { patch: match[1]!, ...(date ? { expectedDate: date.localDate } : {}) };
}

function extractBrettPeriods(text: string, publishedAt: string, updates: Map<string, PvpSeasonUpdate>): void {
  const blocks = [...text.matchAll(/(Zeitraum|Ende)\s+der\s+(\d+)\.\s*Saison\s*:?\s*/giu)];
  for (let index = 0; index < blocks.length; index += 1) {
    const match = blocks[index]!;
    const blockStart = (match.index ?? 0) + match[0].length;
    const block = text.slice(blockStart, blocks[index + 1]?.index ?? text.length).trim();
    const season = match[2]!;

    if (match[1]!.toLocaleLowerCase('de-DE') === 'ende') {
      const end = parseDateTime(block, publishedAt);
      if (end) addUpdate(updates, 'crucible', season, { endUtc: end.utc });
      continue;
    }

    const from = /\bVon\s+/iu.exec(block);
    if (!from) continue;
    const start = parseDateTime(block.slice(from.index + from[0].length), publishedAt);
    if (!start) continue;
    const afterStart = from.index + from[0].length + start.length;
    const separator = /\bbis\b/iu.exec(block.slice(afterStart));
    if (!separator) {
      addUpdate(updates, 'crucible', season, { startUtc: start.utc });
      continue;
    }

    const endText = block.slice(afterStart + separator.index + separator[0].length).trimStart();
    const exactEnd = parseDateTime(endText.replace(/^(?:zu|zum|zur)\s+/iu, ''), publishedAt);
    if (exactEnd) {
      addUpdate(updates, 'crucible', season, { startUtc: start.utc, endUtc: exactEnd.utc });
      continue;
    }

    const patchEnd = extractPatchEnd(`bis ${endText}`, publishedAt);
    addUpdate(updates, 'crucible', season, {
      startUtc: start.utc,
      ...(patchEnd ? { endPatch: patchEnd.patch, ...(patchEnd.expectedDate ? { expectedEndDate: patchEnd.expectedDate } : {}) } : {}),
    });
  }

  const titleSeason = /(?:Saison\s+(\d+)|(\d+)\.\s*Saison)/iu.exec(text)?.[1]
    ?? /(?:Saison\s+(\d+)|(\d+)\.\s*Saison)/iu.exec(text)?.[2];
  if (titleSeason && /hat\s+begonnen|ist\s+geöffnet|läuft\s+bis/iu.test(text)) {
    const identity = titleFor('crucible', titleSeason);
    const previous = updates.get(identity.eventKey);
    if (!previous?.startUtc && /hat\s+begonnen/iu.test(text)) {
      addUpdate(updates, 'crucible', titleSeason, { startUtc: publishedAt });
    } else if (!previous) {
      addUpdate(updates, 'crucible', titleSeason, {});
    }
  }
}

export function extractPvpSeasonUpdates(title: string, html: string, publishedAt: string): PvpSeasonUpdate[] {
  const text = articleText(html);
  const updates = new Map<string, PvpSeasonUpdate>();

  const ccChange = /Die\s+(\d+)\.\s*Saison\s+von\s+Crystalline Conflict\s+ist abgeschlossen.*?\b(\d+)\.\s*Saison/iu.exec(title);
  if (ccChange) {
    addUpdate(updates, 'cc', ccChange[1]!, { endUtc: publishedAt });
    addUpdate(updates, 'cc', ccChange[2]!, { startUtc: publishedAt });
    return [...updates.values()];
  }
  const ccEnd = /letzte Phase der\s+(\d+)\.\s*Saison von Crystalline Conflict/iu.exec(title);
  if (ccEnd) {
    const end = extractPatchEnd(text, publishedAt);
    addUpdate(updates, 'cc', ccEnd[1]!, end ? {
      endPatch: end.patch,
      ...(end.expectedDate ? { expectedEndDate: end.expectedDate } : {}),
    } : {});
    return [...updates.values()];
  }

  const seriesChange = /Die PvP-Serie\s+(\d+)\s+ist zu Ende und Serie\s+(\d+)\s+hat begonnen/iu.exec(title);
  if (seriesChange) {
    addUpdate(updates, 'series', seriesChange[1]!, { endUtc: publishedAt });
    addUpdate(updates, 'series', seriesChange[2]!, { startUtc: publishedAt });
    return [...updates.values()];
  }
  const seriesEnd = /Die PvP-Serie\s+(\d+)\s+endet mit der Veröffentlichung von Patch\s+(\d+\.\d+)/iu.exec(title);
  if (seriesEnd) {
    const end = extractPatchEnd(text, publishedAt);
    addUpdate(updates, 'series', seriesEnd[1]!, end ? {
      endPatch: end.patch,
      ...(end.expectedDate ? { expectedEndDate: end.expectedDate } : {}),
    } : { endPatch: seriesEnd[2]! });
    return [...updates.values()];
  }

  if (/Brett der Bestie/iu.test(title) || /Brett der Bestie/iu.test(text)) {
    extractBrettPeriods(text, publishedAt, updates);
    const successorMatch = /\bEnde\b.*?\bStart\s+(?:(?:von|der)\s+)?(?:Saison\s+(\d+)|(\d+)\.\s*Saison)/iu.exec(title);
    const successorSeason = successorMatch?.[1] ?? successorMatch?.[2];
    if (successorSeason) addUpdate(updates, 'crucible', successorSeason, {});
    const started = /(?:Saison\s+(\d+)|(\d+)\.\s*Saison)/iu.exec(title);
    if (started && /hat begonnen/iu.test(title)) {
      const season = started[1] ?? started[2]!;
      if (!updates.get(titleFor('crucible', season).eventKey)?.startUtc) {
        addUpdate(updates, 'crucible', season, { startUtc: publishedAt });
      }
    }
    return [...updates.values()].sort((left, right) => Number(left.eventKey.split(':').at(-1)) - Number(right.eventKey.split(':').at(-1)));
  }
  return [...updates.values()];
}
