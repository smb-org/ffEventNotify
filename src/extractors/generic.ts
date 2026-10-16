// Implements Design: generic topic extraction and event-key merging (O5).

import { load } from 'cheerio';
import { parseGermanDateTime, type BerlinTimezoneLabel } from '../time.ts';
import type { FieldStatus, GenericExtractResult, ListEntry } from '../types.ts';

const weekdays = 'Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag';
const months = 'Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember';
const scheduleDatePattern = new RegExp(
  `(?<date>(?:${weekdays}),?\\s*(?:den\\s+)?\\d{1,2}\\.\\s*(?:${months})\\s+\\d{4})\\s+um\\s+(?<time>\\d{1,2}(?::\\d{2})?)\\s*(?:Uhr)?\\s*(?:\\((?<label>MESZ|MEZ)\\))?`,
  'giu',
);

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function articleBodyText($: ReturnType<typeof load>): string {
  const body = $('article.news__detail > div.news__detail__wrapper').first();
  if (!body.length) return '';
  const html = (body.html() ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li|section|tr|table)>/gi, ' ')
    .replace(/<(?:p|div|h[1-6]|li|section|tr|table)\b[^>]*>/gi, ' ');
  return normalizedText(load(`<div>${html}</div>`).text());
}

function pageTitle($: ReturnType<typeof load>): string {
  const header = $('article.news__detail > header.news__header h1').first();
  const titleText = normalizedText(header.text()) || header.find('img[alt]').first().attr('alt')?.trim() || '';
  if (titleText) return titleText;
  return $('title').first().text()
    .replace(/\s*\|\s*FINAL FANTASY XIV(?:,\s*|\s*-\s*)Der Lodestone\s*$/i, '')
    .trim();
}

function eventDate(bodyText: string): FieldStatus<string> {
  if (!bodyText) return { status: 'unsicher', reason: 'Generic article body is missing.' };
  const label = /Datum\s+und\s+Uhrzeit/i.exec(bodyText);
  if (!label) return { status: 'unsicher', reason: 'No labeled event date and time was found in the article body.' };
  const scope = bodyText.slice(label.index + label[0].length);
  const matches = [...scope.matchAll(scheduleDatePattern)];
  if (matches.length !== 1 || !matches[0]?.groups) {
    return { status: 'unsicher', reason: 'No unique, reliable event date and time was found in the article body.' };
  }

  const { date, time, label: timezoneLabel } = matches[0].groups as {
    date: string; time: string; label?: string;
  };
  const parsed = parseGermanDateTime(date, time, timezoneLabel as BerlinTimezoneLabel | undefined);
  if (parsed.status === 'ok') return { status: 'ok', value: parsed.utc.replace('.000Z', 'Z') };
  if (parsed.status === 'label-mismatch') {
    return { status: 'unsicher', reason: `Timezone label ${parsed.label} does not match Europe/Berlin.` };
  }
  return { status: 'unsicher', reason: parsed.status === 'ambiguous'
    ? 'Event local time is ambiguous without a timezone label.'
    : parsed.reason };
}

export function extractGeneric(detailHtml: string): GenericExtractResult {
  const $ = load(detailHtml);
  const titleText = pageTitle($);
  const bodyText = articleBodyText($);
  const title: FieldStatus<string> = titleText
    ? { status: 'ok', value: titleText }
    : { status: 'unsicher', reason: 'Generic article title is missing from the header.' };

  return {
    title,
    date: eventDate(bodyText),
    period: { status: 'unsicher', reason: 'A generic topic date does not provide a start and end period.' },
    rewards: { status: 'unsicher', reason: 'Rewards are not extracted from generic topics.' },
    description: bodyText
      ? { status: 'ok', value: bodyText }
      : { status: 'unsicher', reason: 'Generic article body is missing.' },
  };
}

export function extractGenericTopic(entry: ListEntry, detailHtml: string): GenericExtractResult {
  const result = extractGeneric(detailHtml);
  if (result.title.status === 'ok' || !entry.title.trim()) return result;
  return { ...result, title: { status: 'ok', value: entry.title.trim() } };
}

export function deriveGenericEventKey(entry: ListEntry, detailHtml: string): string {
  const title = entry.title.trim();
  const liveLetter = title.match(/Brief des Produzenten LIVE\s+Teil\s*(\d+)/i);
  if (liveLetter) return `Brief des Produzenten LIVE Teil ${liveLetter[1]}`;

  const extractedDate = extractGeneric(detailHtml).date;
  const datePart = extractedDate.status === 'ok' ? extractedDate.value.slice(0, 10) : undefined;
  const cleanTitle = title.replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return [cleanTitle, datePart].filter((part): part is string => Boolean(part)).join(' ');
}
