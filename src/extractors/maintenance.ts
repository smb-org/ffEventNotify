// Implements Design: maintenance and follow-up notice extraction.

import { load } from 'cheerio';
import { parseGermanDateTime, type BerlinTimezoneLabel } from '../time.ts';
import type { ExtractResult, FieldStatus, Period } from '../types.ts';

const weekday = '(?:(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),?\\s*)?';
const datePart = `${weekday}(?:(?:den|dem)\\s+)?\\d{1,2}\\.\\s*[\\p{L}]+\\.?\\s+\\d{4}`;
const timePart = '\\d{1,2}(?::\\d{2})?';

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

function normalizeDate(value: string): string | undefined {
  const match = /(?:(?:den|dem)\s+)?(\d{1,2})\.\s*([\p{L}]+)\.?\s+(\d{4})/iu.exec(value);
  if (!match) return undefined;
  const monthName = match[2]!.replace(/\.$/, '').toLocaleLowerCase('de-DE');
  const months: Readonly<Record<string, string>> = {
    jan: 'Januar', januar: 'Januar', feb: 'Februar', februar: 'Februar', mar: 'März', märz: 'März',
    apr: 'April', april: 'April', mai: 'Mai', jun: 'Juni', juni: 'Juni', jul: 'Juli', juli: 'Juli',
    aug: 'August', august: 'August', sep: 'September', sept: 'September', september: 'September',
    okt: 'Oktober', oktober: 'Oktober', nov: 'November', november: 'November', dez: 'Dezember', dezember: 'Dezember',
  };
  const month = months[monthName];
  if (!month) return undefined;
  return `${Number(match[1])}. ${month} ${match[3]}`;
}

function normalizeTime(value: string): string | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return undefined;
  return `${Number(match[1])}:${match[2] ?? '00'}`;
}

function toUtc(dateText: string, timeText: string, label?: string): FieldStatus<string> {
  const date = normalizeDate(dateText);
  const time = normalizeTime(timeText);
  if (!date || !time) return { status: 'unsicher', reason: 'Maintenance date or time could not be parsed.' };
  const result = parseGermanDateTime(date, time, label as BerlinTimezoneLabel | undefined);
  if (result.status === 'ok') return { status: 'ok', value: result.utc.replace('.000Z', 'Z') };
  if (result.status === 'label-mismatch') {
    return { status: 'unsicher', reason: `Timezone label ${result.label} does not match Europe/Berlin.` };
  }
  return { status: 'unsicher', reason: result.status === 'ambiguous'
    ? 'Maintenance local time is ambiguous without a timezone label.'
    : result.reason };
}

function parseMaintenanceWindow(text: string): FieldStatus<Period> {
  const range = new RegExp(
    `(?:Vom|Von)\\s+(?<startDate>${datePart})\\s+um\\s+(?<startTime>${timePart})\\s*(?:Uhr)?\\s*(?:\\((?<startLabel>MESZ|MEZ)\\))?\\s*bis\\s+(?:zu(?:m|r)?\\s+)?(?<endDate>${datePart})\\s+um\\s+(?<endTime>${timePart})\\s*(?:Uhr)?\\s*(?:\\((?<endLabel>MESZ|MEZ)\\))?`,
    'iu',
  ).exec(text);

  let startDate: string;
  let endDate: string;
  let startTime: string;
  let endTime: string;
  let startLabel: string | undefined;
  let endLabel: string | undefined;
  if (range?.groups) {
    ({ startDate, endDate, startTime, endTime, startLabel, endLabel } = range.groups as {
      startDate: string; endDate: string; startTime: string; endTime: string;
      startLabel?: string; endLabel?: string;
    });
  } else {
    const singleDay = new RegExp(
      `Am\\s+(?<date>${datePart})\\s+von\\s+(?<startTime>${timePart})\\s*(?:Uhr)?\\s*(?:\\((?<startLabel>MESZ|MEZ)\\))?\\s*bis\\s+(?<endTime>${timePart})\\s*(?:Uhr)?\\s*(?:\\((?<endLabel>MESZ|MEZ)\\))?`,
      'iu',
    ).exec(text);
    if (!singleDay?.groups) return { status: 'unsicher', reason: 'No complete maintenance window follows the [Datum & Uhrzeit] label.' };
    startDate = singleDay.groups.date!;
    endDate = startDate;
    startTime = singleDay.groups.startTime!;
    endTime = singleDay.groups.endTime!;
    startLabel = singleDay.groups.startLabel;
    endLabel = singleDay.groups.endLabel;
  }

  const start = toUtc(startDate, startTime, startLabel);
  if (start.status === 'unsicher') return start;
  const end = toUtc(endDate, endTime, endLabel);
  if (end.status === 'unsicher') return end;
  return { status: 'ok', value: { startUtc: start.value, endUtc: end.value } };
}

export function extractMaintenance(html: string, fallbackTitle?: string): ExtractResult {
  const $ = load(html);
  const titleText = normalizedText($('article.news__detail > header.news__header h1').first().text()) || fallbackTitle || '';
  const bodyText = articleBodyText($);
  const title: FieldStatus<string> = titleText
    ? { status: 'ok', value: titleText }
    : { status: 'unsicher', reason: 'Maintenance title is missing from the article header.' };

  const labeledBlock = /\[Datum\s*&\s*Uhrzeit\]\s*(.*?)(?=\[[^\]]+\]|$)/i.exec(bodyText)?.[1];
  const period = labeledBlock === undefined
    ? { status: 'unsicher' as const, reason: 'The article has no [Datum & Uhrzeit] block.' }
    : parseMaintenanceWindow(labeledBlock);

  return {
    title,
    period,
    rewards: { status: 'unsicher', reason: 'Rewards are not extracted from maintenance notices.' },
    description: bodyText
      ? { status: 'ok', value: bodyText }
      : { status: 'unsicher', reason: 'Maintenance article body is missing.' },
  };
}
