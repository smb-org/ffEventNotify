// Classifies Lodestone entries using article content and stable title rules.

import type { Classification, FetchText, ListEntry, PeriodEvidence } from './types.ts';
import {
  articleBodyLinks,
  normalizeLodestoneUrl,
  resolveShortLinks,
  type ShortLinkResolution,
} from './sources/lodestone.ts';

export interface ClassificationOptions {
  fetchText?: FetchText;
  hasPeriod: (specialPath: string) => PeriodEvidence;
  topicPeriod?: PeriodEvidence;
  resolvedLinks?: ShortLinkResolution;
}

const keywords = [
  'Brief des Produzenten LIVE',
  'Fan Festival',
  'Patch',
  'Kampagne',
  'Kollaboration',
];

const maintenanceNames = new Set([
  'Aether', 'Crystal', 'Chaos', 'Light', 'Shadow', 'Riverside', 'Materia',
  'Primal', 'Dynamis', 'Elemental', 'Gaia', 'Mana', 'Meteor',
  'Adamantoise', 'Cactuar', 'Faerie', 'Gilgamesh', 'Jenova', 'Midgardsormr', 'Sargatanas', 'Siren',
  'Balmung', 'Brynhildr', 'Coeurl', 'Diabolos', 'Goblin', 'Malboro', 'Mateus', 'Zalera',
  'Behemoth', 'Excalibur', 'Exodus', 'Famfrit', 'Hyperion', 'Lamia', 'Leviathan', 'Ultros',
  'Cuchulainn', 'Golem', 'Halicarnassus', 'Kraken', 'Maduin', 'Marilith', 'Seraph', 'Rafflesia',
  'Cerberus', 'Louisoix', 'Moogle', 'Omega', 'Phantom', 'Sagittarius', 'Spriggan',
  'Alpha', 'Lich', 'Odin', 'Phoenix', 'Raiden', 'Shiva', 'Twintania', 'Zodiark',
  'Aegis', 'Atomos', 'Carbuncle', 'Garuda', 'Gungnir', 'Kujata', 'Tonberry', 'Typhon',
  'Alexander', 'Bahamut', 'Durandal', 'Fenrir', 'Ifrit', 'Ridill', 'Tiamat', 'Ultima',
  'Anima', 'Asura', 'Chocobo', 'Hades', 'Ixion', 'Masamune', 'Pandaemonium', 'Titan',
  'Belias', 'Mandragora', 'Ramuh', 'Shinryu', 'Unicorn', 'Valefor', 'Yojimbo', 'Zeromus',
  'Bismarck', 'Ravana', 'Sephirot', 'Sophia', 'Zurvan',
]);

const maintenanceNamesLower = new Set([...maintenanceNames].map((name) => name.toLocaleLowerCase('en')));

function containsWorldOrDataCenter(title: string): boolean {
  if (/aller\s+welten/i.test(title)) return true;
  return [...maintenanceNames].some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(title);
  });
}

function normalizeSpecialPath(link: string): string | undefined {
  try {
    const url = new URL(normalizeLodestoneUrl(link));
    if (url.hostname !== 'de.finalfantasyxiv.com') return undefined;
    return url.pathname.startsWith('/lodestone/special/') ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

export async function classifyEntry(
  entry: ListEntry,
  detailHtml: string | undefined,
  options: ClassificationOptions,
): Promise<Classification> {
  if ((entry.source === 'maintenance' || entry.source === 'feed') && /^\[(?:Wartung|Folge-News)\]/i.test(entry.title)) {
    if (containsWorldOrDataCenter(entry.title)) {
      return { status: 'classified', eventType: 'maintenance' };
    }
    return { status: 'ignored', reason: 'Die Wartung betrifft weder alle Welten noch einen bekannten Datenzentren- oder Weltnamen.' };
  }

  if (entry.source === 'banner') {
    const path = normalizeSpecialPath(entry.url);
    if (path === undefined) {
      return { status: 'unclassified', reason: 'Der Banner-Link führt nicht zu einer Lodestone-Sonderseite: ' + entry.url };
    }
    if (options.hasPeriod(path) !== 'no') {
      return { status: 'classified', eventType: 'seasonal-special' };
    }
    return { status: 'ignored', reason: 'Auf der Sonderseite steht kein Zeitraum.' };
  }

  if (entry.source === 'topic' && detailHtml !== undefined) {
    const links = articleBodyLinks(detailHtml);
    const resolution = options.resolvedLinks ?? await resolveShortLinks(
      links,
      options.fetchText ?? (async () => { throw new Error('No short-link resolver was provided'); }),
    );
    if (resolution.unresolvedUrls.length > 0) {
      return { status: 'unclassified', reason: 'Ein Kurzlink konnte nicht aufgelöst werden.' };
    }
    for (const link of resolution.links) {
      if (link === undefined) continue;
      const path = normalizeSpecialPath(link);
      if (path !== undefined && (options.hasPeriod(path) !== 'no' || options.topicPeriod !== undefined && options.topicPeriod !== 'no')) {
        return { status: 'classified', eventType: 'seasonal-special' };
      }
    }
  }

  if (entry.source === 'topic' && keywords.some((keyword) => entry.title.includes(keyword))) {
    // Community contest announcements reuse event keywords ("Fan Festival") but are no in-game events.
    if (/gewinnspiel|wettbewerb/i.test(entry.title)) {
      return { status: 'ignored', reason: 'Der Beitrag kündigt ein Community-Gewinnspiel an.' };
    }
    // Shop announcements reuse event keywords ("Neue Gegenstände zum Fan Festival …") but are no in-game events.
    // Only pure shop posts link the store itself; patch notes merely mention it.
    if (detailHtml !== undefined && articleBodyLinks(detailHtml).some((link) => /sqex\.to\/ffxivstore|store\.finalfantasyxiv\.com/i.test(link))) {
      return { status: 'ignored', reason: 'Der Beitrag bewirbt Artikel aus dem Online Store.' };
    }
    return { status: 'classified', eventType: 'topic-generic' };
  }

  return { status: 'unclassified', reason: `Keine Klassifikationsregel passt auf „${entry.title}“.` };
}

export function maintenanceStem(title: string): string {
  return title
    .replace(/^\[(?:Wartung|Folge-News)\]\s*/i, '')
    .replace(/^\[([^\]]+)\]\s*/, (tag, name: string) => maintenanceNamesLower.has(name.toLocaleLowerCase('en')) ? '' : tag)
    .replace(/\s*:\s*Folgenews\s*$/i, '')
    // Step 5: normalize the approved dotted date range form, such as 12.-13. to 12-13.
    .replace(/(\d+)\.-(\d+)\./g, '$1-$2.')
    // Finally, collapse whitespace after all stem normalizations.
    .replace(/\s+/g, ' ')
    .trim();
}

export function maintenanceTarget(title: string): string | undefined {
  const withoutType = title.replace(/^\[(?:Wartung|Folge-News)\]\s*/i, '');
  const bracketed = /^\[([^\]]+)\]/.exec(withoutType)?.[1];
  if (bracketed && maintenanceNamesLower.has(bracketed.toLocaleLowerCase('en'))) {
    return bracketed.toLocaleLowerCase('en');
  }
  if (/aller\s+welten/i.test(withoutType)) return 'all-worlds';
  return [...maintenanceNames].find((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(withoutType);
  })?.toLocaleLowerCase('en');
}

