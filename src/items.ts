// Implements Design: Eorzea DB item resolution and persistent cache.

import { load } from 'cheerio';
import { cacheItem, getCachedItem, type Store } from './store.ts';
import type { FetchText, FieldStatus, ResolvedItem } from './types.ts';

export interface ResolveItemOptions {
  fetchText: FetchText;
  store: Store;
}

function resolvedItem(itemId: string, name: string, iconUrl: string): ResolvedItem {
  return { itemId, name, iconUrl };
}

export async function resolveItem(
  itemId: string,
  { fetchText, store }: ResolveItemOptions,
): Promise<FieldStatus<ResolvedItem>> {
  const cached = getCachedItem(store, itemId);
  if (cached) {
    if (!cached.iconUrl) return { status: 'unsicher', reason: 'Beim gespeicherten Gegenstand fehlt die Icon-Adresse.' };
    return { status: 'ok', value: resolvedItem(itemId, cached.name, cached.iconUrl) };
  }

  const url = `https://de.finalfantasyxiv.com/lodestone/playguide/db/item/${encodeURIComponent(itemId)}/`;
  try {
    const response = await fetchText(url, { priority: 'item' });
    if (response.status < 200 || response.status >= 300) {
      return { status: 'unsicher', reason: `Die Gegenstandsseite antwortete mit Status ${response.status}.` };
    }

    const $ = load(response.body);
    const rawTitle = $('title').first().text().trim();
    const titleMatch = /^Eorzea-Datenbank\s+(.+?)\s*\|\s*FINAL FANTASY XIV(?:,\s*|\s*-\s*)Der Lodestone$/.exec(rawTitle);
    const name = titleMatch?.[1]?.trim();
    if (!name) return { status: 'unsicher', reason: 'Der Seitentitel entspricht nicht dem erwarteten Format der Eorzea-Datenbank.' };

    const iconUrl = $('meta[property="og:image"]').first().attr('content')?.trim() ||
      $('img[src*="/itemicon/"]').first().attr('src')?.trim();
    if (!iconUrl) return { status: 'unsicher', reason: 'Auf der Gegenstandsseite fehlt die Icon-Adresse.' };

    cacheItem(store, { itemId, name, iconUrl });
    return { status: 'ok', value: resolvedItem(itemId, name, iconUrl) };
  } catch (error) {
    void error;
    return { status: 'unsicher', reason: 'Die Gegenstandsseite konnte nicht abgerufen werden.' };
  }
}
