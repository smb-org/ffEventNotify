// Implements Design: seasonal periods, Berlin timezone checks, and reward completeness (N1/N2/O4).

import { load } from 'cheerio';
import { resolveItem, type ResolveItemOptions } from '../items.ts';
import { isAllowedSpecialImageUrl } from '../store.ts';
import { parseGermanDateTime, type BerlinTimezoneLabel } from '../time.ts';
import type {
  FieldStatus,
  Period,
  PeriodEvidence,
  Reward,
  SeasonalEventState,
  SeasonalExtractResult,
  SeasonalPeriod,
} from '../types.ts';

interface DateTimePrefix {
  date: string;
  time: string;
  label?: BerlinTimezoneLabel;
  length: number;
}

interface ParsedPeriods {
  periods: SeasonalPeriod[];
  problem?: string;
}

interface RewardGroup {
  node: any;
  section: string;
}

export type SeasonalPeriodExtraction = Pick<SeasonalExtractResult, 'period' | 'periods' | 'eventState'>;

const dateTimePrefix = /^(?:(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),?\s*)?(?:den\s+)?(\d{1,2})\.\s*([\p{L}]+)\.?\s+(\d{4})\s+um\s+(\d{1,2})(?::(\d{2}))?\s*(?:Uhr)?\s*(?:\((MESZ|MEZ)\))?/iu;
const itemHref = /\/lodestone\/playguide\/db\/item\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i;

function normalizedText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/Uhr(?=bis\b)/gi, 'Uhr ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nodeText(html: string): string {
  const separated = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li|section|tr|table)>/gi, ' ')
    .replace(/<(?:p|div|h[1-6]|li|section|tr|table)\b[^>]*>/gi, ' ');
  return normalizedText(load('<div>' + separated + '</div>').text());
}

function periodTexts(html: string): string[] {
  const $ = load(html);
  const texts: string[] = [];
  $('meta[name="description"], meta[property="og:description"]').each((_, element) => {
    const content = $(element).attr('content');
    if (content) texts.push(normalizedText(content));
  });
  $('.content__span__period, .content__span, .content__section, .fgs__contents, .fgs__history, .news__detail__wrapper').each((_, element) => {
    const markup = ($(element).html() ?? '').replace(/<br\s*\/?>/gi, ' ');
    const text = nodeText(markup);
    if (/\bVon\b/i.test(text)) texts.push(text);
  });

  if (texts.length === 0) {
    const body = $('body').clone();
    body.find('script, style, nav, header, footer, .ldst__side').remove();
    const text = nodeText(body.html() ?? '');
    if (/\bVon\b/i.test(text)) texts.push(text);
  }
  return texts;
}

function parseDateTimePrefix(value: string): DateTimePrefix | undefined {
  const match = dateTimePrefix.exec(value);
  if (!match) return undefined;
  const date = `${Number(match[1])}. ${match[2]} ${match[3]}`;
  const time = `${Number(match[4])}:${match[5] ?? '00'}`;
  const parsed: DateTimePrefix = { date, time, length: match[0].length };
  if (match[6] !== undefined) parsed.label = match[6] as BerlinTimezoneLabel;
  return parsed;
}

function toUtc(value: DateTimePrefix): FieldStatus<string> {
  const result = parseGermanDateTime(value.date, value.time, value.label);
  if (result.status === 'ok') return { status: 'ok', value: result.utc.replace('.000Z', 'Z') };
  if (result.status === 'label-mismatch') {
    return { status: 'unsicher', reason: `Die Zeitzonenangabe ${result.label} passt nicht zur Zeitzone Europe/Berlin.` };
  }
  if (result.status === 'ambiguous') {
    return { status: 'unsicher', reason: 'Die Ortszeit ist in Europe/Berlin ohne passende Zeitzonenangabe mehrdeutig.' };
  }
  return { status: 'unsicher', reason: result.reason };
}

function parsePeriods(html: string): ParsedPeriods {
  const result: SeasonalPeriod[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const startPattern = /\bVon\s+/giu;

  for (const sourceText of periodTexts(html)) {
    const text = normalizedText(sourceText);
    for (const startMatch of text.matchAll(startPattern)) {
      const startIndex = (startMatch.index ?? 0) + startMatch[0].length;
      const start = parseDateTimePrefix(text.slice(startIndex));
      if (!start) continue;

      const afterStartIndex = startIndex + start.length;
      const separator = /\bbis\b/i.exec(text.slice(afterStartIndex, afterStartIndex + 180));
      if (!separator) {
        errors.push('Die Trennung vor dem Zeitraumende fehlt.');
        continue;
      }
      const endIndex = afterStartIndex + separator.index + separator[0].length;
      const endText = text.slice(endIndex).trim();
      const startUtc = toUtc(start);
      if (startUtc.status === 'unsicher') {
        errors.push(`Zeitraumanfang: ${startUtc.reason}`);
        continue;
      }

      const end = parseDateTimePrefix(endText.replace(/^(?:(?:zu|zum|zur)\s+)+/i, ''));
      let endUtc: string | null = null;
      if (end) {
        const parsedEnd = toUtc(end);
        if (parsedEnd.status === 'unsicher') {
          errors.push(`Zeitraumende: ${parsedEnd.reason}`);
          continue;
        }
        endUtc = parsedEnd.value;
      } else if (!/^(?:zu|zum|zur)\s+/i.test(endText)) {
        errors.push('Das angegebene Zeitraumende konnte nicht gelesen werden.');
      }

      const key = `${startUtc.value}|${endUtc ?? '<open>'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ startUtc: startUtc.value, endUtc });
    }
  }

  if (errors.length > 0) return { periods: result, problem: [...new Set(errors)].join(' ') };
  return { periods: result };
}

function titleStatus(html: string): FieldStatus<string> {
  const $ = load(html);
  const raw = $('title').first().text().trim();
  const title = raw.replace(/\s*\|\s*FINAL FANTASY XIV(?:,\s*|\s*-\s*)Der Lodestone\s*$/i, '').trim();
  return title
    ? { status: 'ok', value: title }
    : { status: 'unsicher', reason: 'Auf der Sonderseite fehlt der Titel.' };
}

function contentRoot($: ReturnType<typeof load>): any {
  const fallGuys = $('.fgs').first();
  if (fallGuys.length) return fallGuys;
  const content = $('.content, .content__section, .content__wrapper, .content__main-art').filter((_, element) =>
    $(element).find('a[href*="/lodestone/playguide/db/item/"]').length > 0,
  ).first();
  if (content.length) return content;
  return $('main').first();
}

function rewardGroups($: ReturnType<typeof load>, root: any): RewardGroup[] {
  const groups: RewardGroup[] = [];
  root.find('.content__item__armor, .content__item__furnishing').each((_: number, element: any) => {
    const node = $(element);
    const section = normalizedText(node.find('.content__item__title').first().text());
    groups.push({ node, section });
  });
  root.find('.featured').each((_: number, element: any) => {
    const node = $(element);
    const heading = node.parent().children('h2, h3, h4').first();
    groups.push({ node, section: normalizedText(heading.text()) });
  });
  root.find('table.item__list').each((_: number, element: any) => {
    const node = $(element);
    const section = normalizedText(node.find('th.item__list__head_text').first().text());
    groups.push({ node, section });
  });
  root.find('.rewards__other').each((_: number, element: any) => {
    const node = $(element);
    const section = normalizedText(node.find('.rewards__other__title img[alt]').first().attr('alt') ?? '');
    groups.push({ node, section });
  });
  root.find('.fgs__contents').each((_: number, element: any) => {
    const node = $(element);
    if (node.find('a[href*="/lodestone/playguide/db/item/"]').length === 0) return;
    const section = normalizedText(node.find('.fgs__items__title').first().text());
    groups.push({ node, section });
  });
  return groups;
}

function rewardIds(html: string): FieldStatus<Array<{ itemId: string; section: string }>> {
  const $ = load(html);
  const root = contentRoot($);
  if (!root.length) return { status: 'unsicher', reason: 'Der Inhaltsbereich der Sonderseite wurde nicht gefunden.' };

  const groups = rewardGroups($, root);
  if (groups.length === 0) return { status: 'unsicher', reason: 'Es wurden keine erkennbaren Überschriften für Belohnungsabschnitte gefunden.' };
  const rewards: Array<{ itemId: string; section: string }> = [];
  const representedLinks = new Set<any>();
  const ids = new Set<string>();

  for (const group of groups) {
    if (!group.section) return { status: 'unsicher', reason: 'Ein Belohnungsabschnitt hat keine lesbare Überschrift.' };
    const links: any[] = [];
    group.node.find('a[href]').each((_: number, element: any) => {
      const href = $(element).attr('href') ?? '';
      if (itemHref.test(href)) {
        links.push(element);
        representedLinks.add(element);
      }
    });
    const iconCount = group.node.find('img[src*="/itemicon/"]').length;
    if (links.length === 0) return { status: 'unsicher', reason: `Der Belohnungsabschnitt „${group.section}“ enthält keine Gegenstände.` };
    if (links.length !== iconCount) {
      return { status: 'unsicher', reason: `Im Belohnungsabschnitt „${group.section}“ gibt es ${links.length} Gegenstandslinks, aber ${iconCount} Gegenstands-Icons.` };
    }

    for (const link of links) {
      const href = $(link).attr('href') ?? '';
      const itemId = itemHref.exec(href)?.[1];
      if (!itemId) return { status: 'unsicher', reason: 'Einem Gegenstandslink fehlt die Gegenstands-ID.' };
      if (ids.has(itemId)) return { status: 'unsicher', reason: `Die Gegenstands-ID ${itemId} kommt mehrfach vor.` };
      ids.add(itemId);
      rewards.push({ itemId, section: group.section });
    }
  }

  let outsideLink = false;
  $('body').find('a[href]').each((_: number, element: any) => {
    if ($(element).closest('nav, .ldst__side, [class*="sub-nav"]').length > 0) return;
    const href = $(element).attr('href') ?? '';
    if (itemHref.test(href) && !representedLinks.has(element)) outsideLink = true;
  });
  if (outsideLink) return { status: 'unsicher', reason: 'Ein Gegenstandslink steht außerhalb eines erkannten Belohnungsabschnitts.' };
  return { status: 'ok', value: rewards };
}

function selectPeriod(
  periods: readonly SeasonalPeriod[],
  now: Date,
): { period: FieldStatus<Period>; eventState: FieldStatus<SeasonalEventState> } {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) {
    return {
      period: { status: 'unsicher', reason: 'Der Bezugszeitpunkt ist ungültig.' },
      eventState: { status: 'unsicher', reason: 'Der Bezugszeitpunkt ist ungültig.' },
    };
  }

  const complete = periods.filter((period): period is Period => period.endUtc !== null);
  const running = complete.filter((period) => Date.parse(period.startUtc) <= timestamp && timestamp < Date.parse(period.endUtc));
  if (running.length > 1) {
    return {
      period: { status: 'unsicher', reason: 'Zum Bezugszeitpunkt laufen mehrere Zeiträume gleichzeitig.' },
      eventState: { status: 'ok', value: 'ambiguous' },
    };
  }
  if (running.length === 1) {
    return {
      period: { status: 'ok', value: running[0]! },
      eventState: { status: 'ok', value: 'active' },
    };
  }

  const upcoming = complete
    .filter((period) => Date.parse(period.startUtc) > timestamp)
    .sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc));
  if (upcoming.length > 0) {
    const earliest = upcoming[0]!;
    const openBeforeNext = periods.some((period) =>
      period.endUtc === null && Date.parse(period.startUtc) < Date.parse(earliest.startUtc),
    );
    if (openBeforeNext) {
      const reason = 'Der nächste Zeitraum hat kein bekanntes Ende.';
      return { period: { status: 'unsicher', reason }, eventState: { status: 'unsicher', reason } };
    }
    return {
      period: { status: 'ok', value: earliest },
      eventState: { status: 'ok', value: 'upcoming' },
    };
  }

  const openCouldBeCurrent = periods.some((period) => period.endUtc === null && Date.parse(period.startUtc) <= timestamp);
  if (openCouldBeCurrent) {
    const reason = 'Ein möglicherweise noch laufender Zeitraum hat kein bekanntes Ende.';
    return { period: { status: 'unsicher', reason }, eventState: { status: 'unsicher', reason } };
  }
  if (complete.length > 0) {
    return {
      period: { status: 'unsicher', reason: 'Alle bekannten Zeiträume sind beendet; dieses Ereignis wird nicht veröffentlicht.' },
      eventState: { status: 'ok', value: 'ended' },
    };
  }
  const reason = 'Es wurde kein vollständiger Zeitraum gefunden.';
  return { period: { status: 'unsicher', reason }, eventState: { status: 'unsicher', reason } };
}

async function resolveRewards(
  ids: readonly { itemId: string; section: string }[],
  options?: ResolveItemOptions,
): Promise<FieldStatus<Reward[]>> {
  if (!options) return { status: 'unsicher', reason: 'Die Abhängigkeiten zum Auflösen der Gegenstände fehlen.' };
  const rewards: Reward[] = [];
  for (const entry of ids) {
    const item = await resolveItem(entry.itemId, options);
    if (item.status === 'unsicher') {
      return { status: 'unsicher', reason: `Gegenstand ${entry.itemId}: ${item.reason}` };
    }
    rewards.push({ itemId: item.value.itemId, name: item.value.name, section: entry.section });
  }
  return { status: 'ok', value: rewards };
}

function hasDatedStart(texts: readonly string[]): boolean {
  for (const sourceText of texts) {
    const text = normalizedText(sourceText);
    for (const match of text.matchAll(/\bVon\s+/giu)) {
      const startIndex = (match.index ?? 0) + match[0].length;
      if (parseDateTimePrefix(text.slice(startIndex)) !== undefined) return true;
    }
  }
  return false;
}

export function hasPeriod(html: string, now: Date = new Date()): PeriodEvidence {
  const parsed = parsePeriods(html);
  const timestamp = now.getTime();
  const datedStart = hasDatedStart(periodTexts(html));
  if (parsed.problem !== undefined) return datedStart ? 'unsicher' : 'no';
  if (parsed.periods.some((period) => period.endUtc !== null && Date.parse(period.endUtc) > timestamp)) {
    return 'yes';
  }

  const upcoming = parsed.periods
    .filter((period) => period.endUtc !== null && Date.parse(period.startUtc) > timestamp)
    .sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc));
  if (upcoming.length > 0) {
    const earliestStart = Date.parse(upcoming[0]!.startUtc);
    if (parsed.periods.some((period) => period.endUtc === null && Date.parse(period.startUtc) < earliestStart)) {
      return 'unsicher';
    }
    return 'yes';
  }
  if (parsed.periods.some((period) => period.endUtc === null && Date.parse(period.startUtc) <= timestamp)) {
    return 'unsicher';
  }
  return datedStart ? 'unsicher' : 'no';
}

export function hasDeclaredPeriod(html: string, now: Date): PeriodEvidence {
  const extracted = extractSeasonalPeriod(html, now);
  if (extracted.periods.status === 'unsicher') return 'unsicher';
  return extracted.periods.value.length > 0 ? 'yes' : 'no';
}

export function extractSeasonalPeriod(html: string, now: Date): SeasonalPeriodExtraction {
  const parsedPeriods = parsePeriods(html);
  const periods: FieldStatus<SeasonalPeriod[]> = parsedPeriods.problem === undefined
    ? { status: 'ok', value: parsedPeriods.periods }
    : { status: 'unsicher', reason: parsedPeriods.problem };
  const selection = selectPeriod(parsedPeriods.periods, now);
  const period = parsedPeriods.problem === undefined
    ? selection.period
    : { status: 'unsicher' as const, reason: parsedPeriods.problem };

  let eventState: FieldStatus<SeasonalEventState>;
  if (parsedPeriods.periods.length === 0 && parsedPeriods.problem === undefined) {
    eventState = { status: 'ok', value: 'not-an-event' };
  } else if (parsedPeriods.problem !== undefined) {
    eventState = { status: 'unsicher', reason: parsedPeriods.problem };
  } else {
    eventState = selection.eventState;
  }

  return { period, periods, eventState };
}

export async function extractSeasonal(
  html: string,
  now: Date,
  options?: ResolveItemOptions,
): Promise<SeasonalExtractResult> {
  const periodResult = extractSeasonalPeriod(html, now);
  const ids = rewardIds(html);
  const rewards = ids.status === 'unsicher' ? ids : await resolveRewards(ids.value, options);
  const $ = load(html);
  const descriptionText = $('meta[name="description"]').first().attr('content')?.trim();
  const rawImageUrl = $('meta[property="og:image"]').first().attr('content')?.trim();
  let imageUrl: string | undefined;
  if (rawImageUrl) {
    try {
      const candidate = new URL(rawImageUrl, 'https://de.finalfantasyxiv.com').toString();
      if (isAllowedSpecialImageUrl(candidate)) imageUrl = candidate;
    } catch {
      // Invalid or unapproved image links are omitted from the public embed.
    }
  }
  const description: FieldStatus<string> = descriptionText
    ? { status: 'ok', value: descriptionText }
    : { status: 'unsicher', reason: 'Auf der Sonderseite fehlt eine Beschreibungsangabe.' };

  return {
    title: titleStatus(html),
    ...periodResult,
    rewards,
    description,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

