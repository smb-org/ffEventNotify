import { createHash } from 'node:crypto';

export function stableEventIdentity(eventKey: string): string {
  return createHash('sha256').update(eventKey, 'utf8').digest('hex');
}

export function eventMarkerFragment(eventKey: string): string {
  return `ffe-${stableEventIdentity(eventKey)}`;
}

export function bestEventSourceUrl(sourceUrls: readonly string[]): string | undefined {
  const valid = [...new Set(sourceUrls)].filter((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  });
  const special = valid.filter((value) => {
    try {
      return new URL(value).pathname.startsWith('/lodestone/special/');
    } catch {
      return false;
    }
  });
  const preferred = special.length > 0 ? special : valid;
  return preferred.sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
}

export function markedEventSourceUrl(sourceUrl: string, eventKey: string): string {
  const url = new URL(sourceUrl);
  url.hash = eventMarkerFragment(eventKey);
  return url.toString();
}

export function eventSourceLink(eventKey: string, sourceUrls: readonly string[]): string | undefined {
  const best = bestEventSourceUrl(sourceUrls);
  return best === undefined ? undefined : markedEventSourceUrl(best, eventKey);
}

export function hasEventMarkerUrl(value: string, eventKey: string): boolean {
  try {
    return new URL(value).hash === `#${eventMarkerFragment(eventKey)}`;
  } catch {
    return false;
  }
}
