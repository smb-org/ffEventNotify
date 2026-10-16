// Parses Lodestone list and detail HTML without making network requests.

import { load } from 'cheerio';
import type { FetchText, ParsedListEntry, ParsedMaintenanceEntry } from '../types.ts';

export const LODESTONE_BASE_URL = 'https://de.finalfantasyxiv.com';

export interface ShortLinkResolution {
  /** One entry per input URL. Undefined means the short link could not be resolved. */
  links: Array<string | undefined>;
  unresolvedUrls: string[];
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function publishedEpochFrom(element: ReturnType<ReturnType<typeof load>>): number | undefined {
  const time = element.find('time').first();
  const dataEpoch = time.find('[data-epoch]').first().attr('data-epoch');
  if (dataEpoch !== undefined && /^\d+$/.test(dataEpoch)) return Number(dataEpoch);

  const markup = time.html() ?? '';
  const match = markup.match(/ldst_strftime(?:_dynamic_ymdhm)?\(\s*(\d+)/);
  if (match?.[1] !== undefined) return Number(match[1]);
  const text = time.text().match(/\b(\d{9,13})\b/);
  if (text?.[1] !== undefined) {
    const epoch = Number(text[1]);
    return epoch > 99_999_999_999 ? Math.floor(epoch / 1_000) : epoch;
  }
  return undefined;
}

function makeListEntry(
  title: string,
  href: string | undefined,
  epoch: number | undefined,
): ParsedListEntry | undefined {
  if (!title || !href) return undefined;
  const result: ParsedListEntry = { title, url: normalizeLodestoneUrl(href) };
  if (epoch !== undefined) result.publishedEpoch = epoch;
  return result;
}

export function parseTopicList(html: string): ParsedListEntry[] {
  const $ = load(html);
  const entries: ParsedListEntry[] = [];
  $('li.news__list--topics').each((_, element) => {
    const item = $(element);
    const link = item.find('header.news__list--header p.news__list--title > a[href]').first();
    const parsed = makeListEntry(
      normalizedText(link.text()),
      link.attr('href'),
      publishedEpochFrom(item),
    );
    if (parsed !== undefined) entries.push(parsed);
  });
  return entries;
}

export function parseMaintenanceList(html: string): ParsedMaintenanceEntry[] {
  const $ = load(html);
  const entries: ParsedMaintenanceEntry[] = [];
  $('li.news__list').each((_, element) => {
    const item = $(element);
    const link = item.find('a.news__list--link[href]').first();
    const titleNode = link.find('p.news__list--title').first();
    const tagText = normalizedText(titleNode.find('span.news__list--tag').first().text());
    const tag = tagText.replace(/^\[|\]$/g, '').trim();
    if (!tag || !titleNode.length) return;

    let titleText = titleNode.text().trim();
    const bracketedTag = `[${tag}]`;
    if (titleText.startsWith(bracketedTag)) titleText = titleText.slice(bracketedTag.length).trim();
    else if (titleText.startsWith(tag)) titleText = titleText.slice(tag.length).trim();
    const parsed = makeListEntry(`${bracketedTag}${titleText}`, link.attr('href'), publishedEpochFrom(item));
    if (parsed !== undefined) entries.push({ ...parsed, tag });
  });
  return entries;
}

export function parseBannerRail(html: string): string[] {
  const $ = load(html);
  const paths: string[] = [];
  const candidates = $('div.ldst__side > div.mb10 > a[href], ul.l__rside__bnr a[href*="/lodestone/special/"]');
  candidates.each((_, element) => {
    const href = $(element).attr('href');
    if (href === undefined) return;
    const path = new URL(normalizeLodestoneUrl(href)).pathname;
    if (!path.startsWith('/lodestone/special/') || paths.includes(path)) return;
    paths.push(path);
  });
  return paths;
}

export function articleBodyLinks(html: string): string[] {
  const $ = load(html);
  const links: string[] = [];
  $('article.news__detail > div.news__detail__wrapper a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (href !== undefined) links.push(href);
  });
  return links;
}

export function normalizeLodestoneUrl(value: string): string {
  const url = new URL(value, LODESTONE_BASE_URL);
  if (/^(?:de|eu|na|fr)\.finalfantasyxiv\.com$/i.test(url.hostname)) {
    url.hostname = 'de.finalfantasyxiv.com';
  }
  url.protocol = 'https:';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function resolveShortLinks(links: readonly string[], fetchText: FetchText): Promise<ShortLinkResolution> {
  const resolved = await Promise.all(links.map(async (link): Promise<string | undefined> => {
    let url: URL;
    try {
      url = new URL(link, LODESTONE_BASE_URL);
    } catch {
      return link;
    }
    if (url.hostname.toLocaleLowerCase('en') !== 'sqex.to') return link;
    const shortUrl = url.toString();
    try {
      const response = await fetchText(shortUrl, { priority: 'detail' });
      if (response.status < 200 || response.status >= 300) return undefined;
      const target = response.finalUrl || shortUrl;
      const targetUrl = new URL(target, shortUrl);
      if (targetUrl.hostname.toLocaleLowerCase('en') === 'sqex.to') return undefined;
      if (/^(?:de|eu|na|fr)\.finalfantasyxiv\.com$/i.test(targetUrl.hostname)) {
        return normalizeLodestoneUrl(targetUrl.toString());
      }
      return target;
    } catch {
      return undefined;
    }
  }));
  return {
    links: resolved,
    unresolvedUrls: links.filter((_, index) => resolved[index] === undefined),
  };
}

async function fetchPage(url: string, priority: 'list' | 'detail', fetchText: FetchText): Promise<string> {
  const response = await fetchText(url, { priority });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Lodestone request failed with status ${response.status}: ${url}`);
  }
  return response.body;
}

export function fetchTopicListPage(page: number, fetchText: FetchText): Promise<string> {
  const query = page > 1 ? `?page=${Math.trunc(page)}` : '';
  return fetchPage(`${LODESTONE_BASE_URL}/lodestone/topics/${query}`, 'list', fetchText);
}

export function fetchMaintenanceListPage(page: number, fetchText: FetchText): Promise<string> {
  const query = page > 1 ? `?page=${Math.trunc(page)}` : '';
  return fetchPage(`${LODESTONE_BASE_URL}/lodestone/news/category/2${query}`, 'list', fetchText);
}

export function fetchDetailPage(url: string, fetchText: FetchText): Promise<string> {
  return fetchPage(normalizeLodestoneUrl(url), 'detail', fetchText);
}

export function fetchSpecialPage(url: string, fetchText: FetchText): Promise<string> {
  return fetchPage(normalizeLodestoneUrl(url), 'detail', fetchText);
}

