// Server-side HTML for the checklist page. Every dynamic value goes through esc().

import { stableEventIdentity } from '../event-identity.ts';
import { getCachedItem, isAllowedSpecialImageUrl, type Store, type StoreEvent } from '../store.ts';
import { BERLIN_TIME_ZONE } from '../time.ts';
import { MAX_CHARS, MAX_NAME_LENGTH, type WebChar } from './data.ts';

const ARCHIVE_DAYS = 60;
const ITEM_DB = 'https://de.finalfantasyxiv.com/lodestone/playguide/db/item/';

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

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
  focusHash?: string | undefined;
  now: Date;
}

const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="9.5"/><path class="tick" d="M7 12.6l3.3 3.3L17 9"/></svg>';

function eventSection(input: PageInput, event: StoreEvent, open: boolean): string {
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
  const empty = input.chars.length === 0 ? '<p class="hint">Lege oben einen Char an, dann kannst du hier Belohnungen abhaken.</p>' : '';
  return `<details class="event" id="e-${hash}" data-event="${hash}"${open ? ' open' : ''}>
  <summary>${banner}<span class="meta"><span class="title">${esc(event.titleStatus === 'ok' ? event.title : 'FFXIV-Event')}</span><span class="period">${esc(period(event))}</span></span><span class="state s-${hasEnded(event, nowMs) ? 'ended' : 'live'}">${stateLabel(event, nowMs)}</span></summary>
  ${empty}<div class="tablewrap"><table><thead><tr><th class="item" scope="col">Belohnung</th>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>
</details>`;
}

function charManager(chars: readonly WebChar[]): string {
  const items = chars.map((char, index) => `<li data-char="${char.id}">
      <span class="who"><span class="name" title="${esc(char.name)}">${esc(char.name)}</span>
        <input class="rename-in" type="text" value="${esc(char.name)}" maxlength="${MAX_NAME_LENGTH}" aria-label="Neuer Name" autocomplete="off"></span>
      <span class="actions">
        <span class="a-normal"><button type="button" data-act="left" aria-label="Nach links"${index === 0 ? ' disabled' : ''}>‹</button><button type="button" data-act="right" aria-label="Nach rechts"${index === chars.length - 1 ? ' disabled' : ''}>›</button><button type="button" data-act="rename">Umbenennen</button><button type="button" data-act="ask-delete">Löschen</button></span>
        <span class="a-rename"><button type="button" data-act="save-rename">Speichern</button><button type="button" data-act="cancel">Abbrechen</button></span>
        <span class="a-delete"><span class="ask">Wirklich löschen?</span><button type="button" class="danger" data-act="delete">Ja</button><button type="button" data-act="cancel">Nein</button></span>
      </span></li>`).join('');
  return `<section class="chars" aria-labelledby="chars-h">
  <div class="chars-head"><h2 id="chars-h">Deine Chars</h2><span class="count">${chars.length} von ${MAX_CHARS}</span></div>
  <form class="add" autocomplete="off"><input type="text" name="name" maxlength="${MAX_NAME_LENGTH}" placeholder="Neuer Char" aria-label="Neuer Char" required><button type="submit">Hinzufügen</button></form>
  <ul class="char-list">${items}</ul>
</section>`;
}

export function renderPage(input: PageInput): string {
  const { current, archive } = splitEvents(input.events, input.now);
  const focus = input.focusHash ? [...current, ...archive].find((event) => eventHash(event.eventKey) === input.focusHash) : undefined;
  const shown = focus ? [focus, ...current.filter((event) => event !== focus)] : current;
  const archived = focus ? archive.filter((event) => event !== focus) : archive;
  const main = shown.length === 0
    ? '<p class="hint">Zurzeit gibt es keine laufenden Events mit Belohnungsliste.</p>'
    : shown.map((event) => eventSection(input, event, focus ? event === focus : true)).join('\n');
  const archiveHtml = archived.length === 0 ? '' : `<details class="archive"><summary>Archiv <span class="count">${archived.length}</span></summary>
${archived.map((event) => eventSection(input, event, false)).join('\n')}</details>`;
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="color-scheme" content="light dark">
<title>Event-Checkliste</title><link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head>
<body>
<header class="top"><h1>Event-Checkliste</h1><p>Dein persönlicher Link – bitte nicht weitergeben.</p></header>
${charManager(input.chars)}
<main>
${main}
${archiveHtml}
</main>
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
