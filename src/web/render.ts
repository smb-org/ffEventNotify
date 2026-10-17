// Server-side HTML for the checklist page. Every dynamic value goes through esc().

import { stableEventIdentity } from '../event-identity.ts';
import { getCachedItem, getEventSources, isAllowedSpecialImageUrl, type Store, type StoreEvent } from '../store.ts';
import { BERLIN_TIME_ZONE } from '../time.ts';
import { MAX_CHARS, MAX_NAME_LENGTH, type EventDiscordLink, type WebChar } from './data.ts';

const ARCHIVE_DAYS = 60;
const ITEM_DB = 'https://de.finalfantasyxiv.com/lodestone/playguide/db/item/';

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

const LODESTONE_HOST = 'de.finalfantasyxiv.com';
const DISCORD_ID = /^\d{1,25}$/;
const SOURCE_RANK = ['special', 'topic', 'followup', 'feed'];

function httpsUrlOn(url: string, host: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === host && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Best Lodestone page of the event: special page first, then topic/news. */
function lodestoneUrl(store: Store, event: StoreEvent): string | undefined {
  const ranked = getEventSources(store, event.id)
    .filter((source) => SOURCE_RANK.includes(source.kind))
    .sort((a, b) => SOURCE_RANK.indexOf(a.kind) - SOURCE_RANK.indexOf(b.kind));
  for (const source of ranked) {
    const safe = httpsUrlOn(source.url, LODESTONE_HOST);
    if (safe) return safe;
  }
  return undefined;
}

const externalLink = (href: string, label: string, cls = 'xlink') =>
  `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;

export function eventHash(eventKey: string): string {
  return stableEventIdentity(eventKey).slice(0, 32);
}

export function hasChecklist(event: StoreEvent): boolean {
  return event.eventType === 'seasonal-special' && event.rewardsStatus === 'ok' && event.rewards.length > 0;
}

function hasEnded(event: StoreEvent, nowMs: number): boolean {
  return event.endStatus === 'ok' && event.endUtc !== null && Date.parse(event.endUtc) <= nowMs;
}

export function splitEvents(events: readonly StoreEvent[], now: Date): { current: StoreEvent[]; archive: StoreEvent[] } {
  const nowMs = now.getTime();
  const usable = events.filter(hasChecklist);
  const endOf = (event: StoreEvent) => (event.endUtc ? Date.parse(event.endUtc) : Number.POSITIVE_INFINITY);
  const current = usable.filter((event) => !hasEnded(event, nowMs)).sort((a, b) => endOf(a) - endOf(b));
  const archive = usable
    .filter((event) => hasEnded(event, nowMs) && endOf(event) > nowMs - ARCHIVE_DAYS * 86_400_000)
    .sort((a, b) => endOf(b) - endOf(a));
  return { current, archive };
}

const dateFormat = new Intl.DateTimeFormat('de-DE', {
  timeZone: BERLIN_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function period(event: StoreEvent): string {
  const format = (iso: string | null, status: string) => (iso && status === 'ok' ? dateFormat.format(new Date(iso)) : undefined);
  const start = format(event.startUtc, event.startStatus);
  const end = format(event.endUtc, event.endStatus);
  if (start && end) return `${start} – ${end} Uhr`;
  if (end) return `bis ${end} Uhr`;
  if (start) return `ab ${start} Uhr, Ende offen`;
  return 'Zeitraum offen';
}

function stateLabel(event: StoreEvent, nowMs: number): string {
  if (hasEnded(event, nowMs)) return 'beendet';
  if (event.startStatus === 'ok' && event.startUtc && Date.parse(event.startUtc) > nowMs) return 'angekündigt';
  return 'läuft';
}

export interface PageInput {
  store: Store;
  events: readonly StoreEvent[];
  chars: readonly WebChar[];
  done: ReadonlySet<string>;
  /** Forum posts of the user's guilds (see listEventDiscordLinks). */
  discord?: readonly EventDiscordLink[] | undefined;
  /** Selected event (32-char hash) from /e/<hash>; unknown values fall back to the first tab. */
  focusHash?: string | undefined;
  /** True for /archiv. */
  archiveTab?: boolean | undefined;
  now: Date;
}

const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="9.5"/><path class="tick" d="M7 12.6l3.3 3.3L17 9"/></svg>';

function eventSection(input: PageInput, event: StoreEvent, mode: 'panel' | 'closed' | 'open'): string {
  const nowMs = input.now.getTime();
  const hash = eventHash(event.eventKey);
  const seen = new Set<string>();
  const rewards = event.rewards.filter((reward) => !seen.has(reward.itemId) && seen.add(reward.itemId));
  const total = rewards.length;
  const progress = (char: WebChar) => rewards.filter((reward) => input.done.has(`${char.id}|${event.eventKey}|${reward.itemId}`)).length;
  const banner = event.imageUrl && isAllowedSpecialImageUrl(event.imageUrl)
    ? `<img class="banner" src="${esc(event.imageUrl)}" alt="" width="96" height="54" loading="lazy" referrerpolicy="no-referrer">`
    : '<span class="banner"></span>';
  const columns = input.chars.length + 1;
  const head = input.chars.map((char) => `<th class="char" scope="col" data-char="${char.id}">
      <span class="cn" title="${esc(char.name)}">${esc(char.name)}</span>
      <span class="prog" data-total="${total}"><b>${progress(char)}</b>/${total}</span>
      <label class="rem"><input type="checkbox" data-remind="${char.id}"${char.remind ? ' checked' : ''}><span>erinnern</span></label></th>`).join('');

  const rows: string[] = [];
  let section: string | undefined;
  for (const reward of rewards) {
    if (reward.section !== section) {
      section = reward.section;
      if (section) rows.push(`<tr class="sec"><th colspan="${columns}" scope="colgroup"><span>${esc(section)}</span></th></tr>`);
    }
    const cached = getCachedItem(input.store, reward.itemId);
    const icon = cached?.iconUrl && isAllowedSpecialImageUrl(cached.iconUrl)
      ? `<img class="ico" src="${esc(cached.iconUrl)}" alt="" width="32" height="32" loading="lazy" referrerpolicy="no-referrer">`
      : '<span class="ico"></span>';
    const cost = reward.cost ? `<span class="cost">${esc(reward.cost)}</span>` : '';
    const cells = input.chars.map((char) => {
      const on = input.done.has(`${char.id}|${event.eventKey}|${reward.itemId}`);
      return `<td><button type="button" class="cell" aria-pressed="${on}" data-char="${char.id}" data-item="${esc(reward.itemId)}" aria-label="${esc(reward.name)} – ${esc(char.name)}">${MARK}</button></td>`;
    }).join('');
    rows.push(`<tr><th class="item" scope="row"><div class="itemcell">${icon}<span class="iname"><a href="${ITEM_DB}${encodeURIComponent(reward.itemId)}/" target="_blank" rel="noopener noreferrer">${esc(reward.name)}</a>${cost}</span></div></th>${cells}</tr>`);
  }
  const empty = input.chars.length === 0 ? '<p class="hint">Lege unten deinen ersten Char an, dann kannst du hier Belohnungen abhaken.</p>' : '';
  const title = esc(event.titleStatus === 'ok' ? event.title : 'FFXIV-Event');
  const lodestone = lodestoneUrl(input.store, event);
  const posts = (input.discord ?? []).filter((link) => link.eventKey === event.eventKey && DISCORD_ID.test(link.guildId) && DISCORD_ID.test(link.threadId));
  const named = posts.length > 1;
  const links = [
    lodestone ? externalLink(lodestone, 'Lodestone') : '',
    ...posts.map((link) => externalLink(`https://discord.com/channels/${link.guildId}/${link.threadId}`, named && link.guildName ? `Discord: ${link.guildName}` : 'Discord-Beitrag')),
  ].join('');
  const linkBox = links ? `<span class="links">${links}</span>` : '';
  const titleHtml = lodestone ? `<a href="${esc(lodestone)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
  const head2 = `${banner}<span class="meta"><span class="title">${titleHtml}</span><span class="period">${esc(period(event))}</span></span>${linkBox}<span class="state s-${hasEnded(event, nowMs) ? 'ended' : 'live'}">${stateLabel(event, nowMs)}</span>`;
  const body = `${empty}<div class="tablewrap"><table><thead><tr><th class="item" scope="col">Belohnung</th>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  if (mode === 'panel') return `<div class="event" data-event="${hash}"><div class="evhead">${head2}</div>
  ${body}
</div>`;
  return `<details class="event" id="e-${hash}" data-event="${hash}"${mode === 'open' ? ' open' : ''}>
  <summary>${head2}</summary>
  ${body}
</details>`;
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: BERLIN_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const shortDate = new Intl.DateTimeFormat('de-DE', { timeZone: BERLIN_TIME_ZONE, day: '2-digit', month: '2-digit' });
const dayNumber = (date: Date) => Date.parse(`${dayFormat.format(date)}T00:00:00Z`) / 86_400_000;

function tabNote(event: StoreEvent, now: Date): string {
  const nowMs = now.getTime();
  if (event.startStatus === 'ok' && event.startUtc && Date.parse(event.startUtc) > nowMs) return `ab ${shortDate.format(new Date(event.startUtc))}`;
  if (event.endStatus !== 'ok' || !event.endUtc) return 'Ende offen';
  const days = dayNumber(new Date(event.endUtc)) - dayNumber(now);
  if (days <= 0) return 'endet heute';
  return `noch ${days} ${days === 1 ? 'Tag' : 'Tage'}`;
}

function shorten(title: string): string {
  const chars = [...title];
  return chars.length <= 28 ? title : `${chars.slice(0, 27).join('').trimEnd()}…`;
}

function openCount(input: PageInput, event: StoreEvent): number | undefined {
  const reminding = input.chars.filter((char) => char.remind);
  if (reminding.length === 0) return undefined;
  const ids = [...new Set(event.rewards.map((reward) => reward.itemId))];
  return reminding.reduce((sum, char) => sum + ids.filter((id) => !input.done.has(`${char.id}|${event.eventKey}|${id}`)).length, 0);
}

function charManager(chars: readonly WebChar[]): string {
  // Collapsed once the user has chars; open for the first one.
  const items = chars.map((char, index) => `<li data-char="${char.id}">
      <span class="who"><span class="name" title="${esc(char.name)}">${esc(char.name)}</span>
        <input class="rename-in" type="text" value="${esc(char.name)}" maxlength="${MAX_NAME_LENGTH}" aria-label="Neuer Name" autocomplete="off"></span>
      <span class="actions">
        <span class="a-normal"><button type="button" data-act="left" aria-label="Nach links"${index === 0 ? ' disabled' : ''}>‹</button><button type="button" data-act="right" aria-label="Nach rechts"${index === chars.length - 1 ? ' disabled' : ''}>›</button><button type="button" data-act="rename">Umbenennen</button><button type="button" data-act="ask-delete">Löschen</button></span>
        <span class="a-rename"><button type="button" data-act="save-rename">Speichern</button><button type="button" data-act="cancel">Abbrechen</button></span>
        <span class="a-delete"><span class="ask">Wirklich löschen?</span><button type="button" class="danger" data-act="delete">Ja</button><button type="button" data-act="cancel">Nein</button></span>
      </span></li>`).join('');
  return `<details class="chars" id="chars"${chars.length === 0 ? ' open' : ''}>
  <summary><h2 id="chars-h">Chars verwalten</h2><span class="count">${chars.length} von ${MAX_CHARS}</span></summary>
  <form class="add" autocomplete="off"><input type="text" name="name" maxlength="${MAX_NAME_LENGTH}" placeholder="Neuer Char" aria-label="Neuer Char" required><button type="submit">Hinzufügen</button></form>
  <ul class="char-list">${items}</ul>
</details>`;
}

export function renderPage(input: PageInput): string {
  const { current, archive } = splitEvents(input.events, input.now);
  const hashOf = (event: StoreEvent) => eventHash(event.eventKey);
  const archivedFocus = input.focusHash ? archive.find((event) => hashOf(event) === input.focusHash) : undefined;
  const currentFocus = input.focusHash ? current.findIndex((event) => hashOf(event) === input.focusHash) : -1;
  // Tab ids: one per current event, then 'archiv'.
  const archiveSelected = Boolean(input.archiveTab || archivedFocus) || (current.length === 0);
  const selected = archiveSelected ? current.length : Math.max(currentFocus, 0);
  const tabs = current.map((event, index) => {
    const hash = hashOf(event);
    const full = event.titleStatus === 'ok' ? event.title : 'FFXIV-Event';
    const open = openCount(input, event);
    const hint = open === undefined ? '' : `<span class="tab-open" data-open>${open} offen</span>`;
    return `<button type="button" role="tab" class="tab" id="t-${hash}" aria-controls="p-${hash}" aria-selected="${index === selected}" tabindex="${index === selected ? 0 : -1}" data-slug="${index === 0 ? '' : `e/${hash}`}" title="${esc(full)}"><span class="tab-title">${esc(shorten(full))}</span><span class="tab-note">${esc(tabNote(event, input.now))}${hint ? ' · ' : ''}${hint}</span></button>`;
  });
  tabs.push(`<button type="button" role="tab" class="tab" id="t-archiv" aria-controls="p-archiv" aria-selected="${archiveSelected}" tabindex="${archiveSelected ? 0 : -1}" data-slug="archiv"><span class="tab-title">Archiv</span><span class="tab-note">${archive.length} beendet</span></button>`);
  const panels = current.map((event, index) => {
    const hash = hashOf(event);
    return `<section role="tabpanel" class="panel" id="p-${hash}" aria-labelledby="t-${hash}"${index === selected ? '' : ' hidden'}>
${eventSection(input, event, 'panel')}
</section>`;
  });
  const archiveBody = archive.length === 0
    ? '<p class="hint">Keine beendeten Events in den letzten 60 Tagen.</p>'
    : archive.map((event) => eventSection(input, event, event === archivedFocus ? 'open' : 'closed')).join('\n');
  const noCurrent = current.length === 0 ? '<p class="hint">Zurzeit gibt es keine laufenden Events mit Belohnungsliste.</p>\n' : '';
  panels.push(`<section role="tabpanel" class="panel" id="p-archiv" aria-labelledby="t-archiv"${archiveSelected ? '' : ' hidden'}>
${noCurrent}${archiveBody}
</section>`);
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="color-scheme" content="light dark">
<title>Event-Checkliste</title><link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head>
<body>
<header class="top"><div class="toprow"><h1>Event-Checkliste</h1><a class="chars-link" href="#chars">Chars verwalten ↓</a></div><p>Dein persönlicher Link – bitte nicht weitergeben.</p></header>
<div class="tabbar"><div class="tabs" role="tablist" aria-label="Events">${tabs.join('')}</div></div>
<main>
${panels.join('\n')}
</main>
${charManager(input.chars)}
<div id="toast" role="status" aria-live="polite"></div>
</body></html>`;
}

export function renderNotFound(): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="color-scheme" content="light dark">
<title>Nicht gefunden</title><link rel="stylesheet" href="/static/app.css"></head>
<body><main class="gone"><h1>Link ungültig oder erneuert</h1></main></body></html>`;
}
