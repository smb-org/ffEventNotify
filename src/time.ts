// Converts Lodestone German date/time text using the IANA Europe/Berlin zone.

export type BerlinTimezoneLabel = 'MESZ' | 'MEZ';

export const BERLIN_TIME_ZONE = 'Europe/Berlin';

export type GermanDateTimeResult =
  | { status: 'ok'; utc: string }
  | { status: 'ambiguous'; candidatesUtc: string[] }
  | { status: 'invalid'; reason: string }
  | { status: 'label-mismatch'; label: BerlinTimezoneLabel; actualLabels: BerlinTimezoneLabel[] };

interface DateTimePieces {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

interface ZonedParts extends DateTimePieces {
  second: number;
}

const monthNumbers: Readonly<Record<string, number>> = {
  januar: 1,
  februar: 2,
  märz: 3,
  maerz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12,
};

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BERLIN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parseDate(dateText: string): Omit<DateTimePieces, 'hour' | 'minute'> | undefined {
  const normalized = dateText.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };

  const german = /^(?:[\p{L}]+,\s*)?(?:den\s+)?(\d{1,2})\.\s*([\p{L}]+)\s+(\d{4})$/iu.exec(normalized);
  if (!german) return undefined;
  const month = monthNumbers[german[2]!.toLocaleLowerCase('de-DE')];
  if (month === undefined) return undefined;
  return { year: Number(german[3]), month, day: Number(german[1]) };
}

function parseTime(timeText: string): Pick<DateTimePieces, 'hour' | 'minute'> | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeText.trim());
  if (!match) return undefined;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function validPieces(pieces: DateTimePieces): boolean {
  if (
    !Number.isInteger(pieces.year) || pieces.year < 100 || pieces.year > 9999 ||
    !Number.isInteger(pieces.month) || pieces.month < 1 || pieces.month > 12 ||
    !Number.isInteger(pieces.day) || pieces.day < 1 || pieces.day > 31 ||
    !Number.isInteger(pieces.hour) || pieces.hour < 0 || pieces.hour > 23 ||
    !Number.isInteger(pieces.minute) || pieces.minute < 0 || pieces.minute > 59
  ) return false;

  const normalized = new Date(Date.UTC(pieces.year, pieces.month - 1, pieces.day, pieces.hour, pieces.minute));
  return normalized.getUTCFullYear() === pieces.year &&
    normalized.getUTCMonth() === pieces.month - 1 &&
    normalized.getUTCDate() === pieces.day &&
    normalized.getUTCHours() === pieces.hour &&
    normalized.getUTCMinutes() === pieces.minute;
}

function localParts(instant: number): ZonedParts {
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  } as ZonedParts;
}

function sameLocalMinute(actual: ZonedParts, expected: DateTimePieces): boolean {
  return actual.year === expected.year && actual.month === expected.month && actual.day === expected.day &&
    actual.hour === expected.hour && actual.minute === expected.minute && actual.second === 0;
}

function offsetAt(instant: number): number {
  const parts = localParts(instant);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
}

function labelForOffset(offsetMilliseconds: number): BerlinTimezoneLabel | undefined {
  if (offsetMilliseconds === 2 * 60 * 60 * 1_000) return 'MESZ';
  if (offsetMilliseconds === 60 * 60 * 1_000) return 'MEZ';
  return undefined;
}

export function parseGermanDateTime(
  dateText: string,
  timeText: string,
  label?: BerlinTimezoneLabel,
): GermanDateTimeResult {
  const date = parseDate(dateText);
  const time = parseTime(timeText);
  if (!date || !time) return { status: 'invalid', reason: 'Datum oder Uhrzeit ist ungültig.' };

  const pieces = { ...date, ...time };
  if (!validPieces(pieces)) return { status: 'invalid', reason: 'Datum oder Uhrzeit liegt außerhalb des gültigen Kalenderbereichs.' };

  const localAsUtc = Date.UTC(pieces.year, pieces.month - 1, pieces.day, pieces.hour, pieces.minute);
  const possibleOffsets = new Set<number>();
  for (let deltaHours = -36; deltaHours <= 36; deltaHours += 3) {
    possibleOffsets.add(offsetAt(localAsUtc + deltaHours * 60 * 60 * 1_000));
  }

  const candidates = [...possibleOffsets]
    .map((offset) => ({ instant: localAsUtc - offset, offset }))
    .filter(({ instant }) => sameLocalMinute(localParts(instant), pieces))
    .sort((left, right) => left.instant - right.instant);

  if (candidates.length === 0) {
    return { status: 'invalid', reason: 'Diese Ortszeit gibt es in Europe/Berlin nicht.' };
  }

  const actualLabels = [...new Set(candidates.map(({ offset }) => labelForOffset(offset)))]
    .filter((value): value is BerlinTimezoneLabel => value !== undefined);
  if (label !== undefined) {
    const matchingCandidate = candidates.find(({ offset }) => labelForOffset(offset) === label);
    if (!matchingCandidate) return { status: 'label-mismatch', label, actualLabels };
    return { status: 'ok', utc: new Date(matchingCandidate.instant).toISOString() };
  }

  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidatesUtc: candidates.map(({ instant }) => new Date(instant).toISOString()),
    };
  }

  return { status: 'ok', utc: new Date(candidates[0]!.instant).toISOString() };
}

export function berlinDateTimeToUtc(
  localDate: string,
  localTime: string,
  label?: BerlinTimezoneLabel,
): string {
  const result = parseGermanDateTime(localDate, localTime, label);
  if (result.status === 'ok') return result.utc;
  if (result.status === 'ambiguous') {
    throw new RangeError('Local time is ambiguous in Europe/Berlin; provide MESZ or MEZ.');
  }
  if (result.status === 'label-mismatch') {
    throw new RangeError(`Timezone label ${result.label} does not match Europe/Berlin (${result.actualLabels.join(', ')}).`);
  }
  throw new RangeError(result.reason);
}
