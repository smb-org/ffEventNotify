// Parses the official Lodestone Atom feed.

import { load } from 'cheerio';
import type { FetchText, NewsFeedEntry } from '../types.ts';
import { LODESTONE_BASE_URL, normalizeLodestoneUrl } from './lodestone.ts';

export const LODESTONE_NEWS_FEED_URL = `${LODESTONE_BASE_URL}/lodestone/news/news.xml`;

export async function fetchNewsFeed(fetchText: FetchText): Promise<string> {
  const response = await fetchText(LODESTONE_NEWS_FEED_URL, { priority: 'list' });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Lodestone news feed request failed with status ${response.status}`);
  }
  return response.body;
}

export function parseNewsFeed(xml: string): NewsFeedEntry[] {
  const $ = load(xml, { xmlMode: true });
  const entries: NewsFeedEntry[] = [];
  $('feed > entry').each((_, element) => {
    const entry = $(element);
    const title = entry.children('title').first().text().trim();
    const link = entry.children('link[rel="alternate"]').first().attr('href')
      ?? entry.children('link[href]').first().attr('href');
    const publishedText = entry.children('published').first().text().trim();
    const category = entry.children('category').first().attr('term');
    const publishedDate = new Date(publishedText);
    if (!title || !link || !category || !Number.isFinite(publishedDate.getTime())) return;
    const published = publishedDate.toISOString().replace(/\.000Z$/, 'Z');
    entries.push({ title, url: normalizeLodestoneUrl(link), published, category });
  });
  return entries;
}
