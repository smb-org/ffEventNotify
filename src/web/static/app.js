'use strict';
(() => {
  const token = location.pathname.split('/')[2];
  const toastEl = document.getElementById('toast');
  let toastTimer;

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
  }

  async function post(path, body) {
    let response;
    try {
      response = await fetch(`/c/${token}/api/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-FFE': '1' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Keine Verbindung. Bitte versuche es erneut.');
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Das hat nicht geklappt.');
    }
  }

  // Structural char changes reload the page; keep the reading position.
  function reload() {
    try { sessionStorage.setItem('ffe-scroll', String(window.scrollY)); if (document.getElementById('chars').open) sessionStorage.setItem('ffe-chars', '1'); } catch { /* optional */ }
    location.reload();
  }
  try {
    const saved = sessionStorage.getItem('ffe-scroll');
    if (sessionStorage.getItem('ffe-chars')) { sessionStorage.removeItem('ffe-chars'); document.getElementById('chars').open = true; }
    if (saved) { sessionStorage.removeItem('ffe-scroll'); window.scrollTo(0, Number(saved)); }
  } catch { /* optional */ }

  // "N offen" on the tab: open items of the chars with erinnern on.
  function updateOpen(event) {
    const panel = event.closest('[role=tabpanel]');
    const label = panel && document.querySelector(`#${panel.getAttribute('aria-labelledby')} [data-open]`);
    if (!label) return;
    let open = 0;
    for (const th of panel.querySelectorAll('thead th[data-char]')) {
      if (!th.querySelector('input[data-remind]').checked) continue;
      const prog = th.querySelector('.prog');
      open += Number(prog.dataset.total) - Number(prog.querySelector('b').textContent);
    }
    label.textContent = `${open} offen`;
  }

  function updateProgress(table, charId) {
    const cells = [...table.querySelectorAll('.cell')].filter((cell) => cell.dataset.char === String(charId));
    const relevant = cells.filter((cell) => cell.closest('tr').dataset.globalSkip !== 'true' && cell.dataset.skip !== 'true');
    const done = relevant.filter((cell) => cell.getAttribute('aria-pressed') === 'true').length;
    const prog = table.querySelector(`thead th[data-char="${charId}"] .prog`);
    if (prog) {
      prog.dataset.total = String(relevant.length);
      prog.querySelector('b').textContent = String(done);
      prog.lastChild.textContent = `/${relevant.length}`;
    }
    updateOpen(table);
  }

  function updateRowState(row) {
    const globalSkip = row.dataset.globalSkip === 'true';
    const cells = [...row.querySelectorAll('.cell')];
    row.classList.toggle('skip-row', globalSkip || (cells.length > 0 && cells.every((cell) => cell.dataset.skip === 'true')));
    for (const cell of cells) cell.disabled = globalSkip;
  }

  function setCellState(cell, done, skipped) {
    cell.setAttribute('aria-pressed', String(done));
    if (skipped) cell.dataset.skip = 'true';
    else delete cell.dataset.skip;
    cell.setAttribute('aria-label', `${cell.dataset.label}${skipped ? ' – nicht relevant' : ''}`);
    updateRowState(cell.closest('tr'));
    updateProgress(cell.closest('table'), cell.dataset.char);
  }

  async function toggleCell(cell) {
    if (cell.getAttribute('aria-busy') === 'true' || cell.disabled) return;
    const next = cell.getAttribute('aria-pressed') !== 'true';
    const oldDone = cell.getAttribute('aria-pressed') === 'true';
    const oldSkipped = cell.dataset.skip === 'true';
    setCellState(cell, next, false);
    cell.setAttribute('aria-busy', 'true');
    try {
      await post('toggle', {
        charId: Number(cell.dataset.char),
        eventKey: cell.closest('.event').dataset.event,
        itemId: cell.dataset.item,
        done: next,
      });
    } catch (error) {
      setCellState(cell, oldDone, oldSkipped);
      toast(error.message);
    } finally {
      cell.removeAttribute('aria-busy');
    }
  }

  async function toggleSkipCell(cell) {
    if (cell.getAttribute('aria-busy') === 'true' || cell.disabled) return;
    const oldDone = cell.getAttribute('aria-pressed') === 'true';
    const oldSkipped = cell.dataset.skip === 'true';
    const next = !oldSkipped;
    setCellState(cell, next ? false : oldDone, next);
    cell.setAttribute('aria-busy', 'true');
    try {
      await post('skip', {
        charId: Number(cell.dataset.char),
        eventKey: cell.closest('.event').dataset.event,
        itemId: cell.dataset.item,
        skip: next,
      });
    } catch (error) {
      setCellState(cell, oldDone, oldSkipped);
      toast(error.message);
    } finally {
      cell.removeAttribute('aria-busy');
    }
  }

  async function toggleSkipAll(button) {
    if (button.getAttribute('aria-busy') === 'true') return;
    const row = button.closest('tr');
    const old = button.getAttribute('aria-pressed') === 'true';
    const next = !old;
    const table = button.closest('table');
    const set = (value) => {
      button.setAttribute('aria-pressed', String(value));
      row.dataset.globalSkip = String(value);
      updateRowState(row);
      for (const header of table.querySelectorAll('thead th[data-char]')) updateProgress(table, header.dataset.char);
    };
    set(next);
    button.setAttribute('aria-busy', 'true');
    try {
      await post('skip-all', {
        eventKey: button.closest('.event').dataset.event,
        itemId: button.dataset.item,
        skip: next,
      });
    } catch (error) {
      set(old);
      toast(error.message);
    } finally {
      button.removeAttribute('aria-busy');
    }
  }

  async function action(path, body) {
    try {
      await post(path, body);
      reload();
    } catch (error) {
      toast(error.message);
    }
  }

  document.querySelector('.chars-link').addEventListener('click', (event) => {
    event.preventDefault();
    const box = document.getElementById('chars');
    box.open = true;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const list = document.querySelector('.char-list');
  list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const item = button.closest('li');
    const id = Number(item.dataset.char);
    const mode = (name) => { item.classList.remove('mode-rename', 'mode-delete'); if (name) item.classList.add(name); };
    switch (button.dataset.act) {
      case 'rename': mode('mode-rename'); item.querySelector('.rename-in').focus(); break;
      case 'ask-delete': mode('mode-delete'); break;
      case 'cancel': mode(); item.querySelector('.rename-in').value = item.querySelector('.name').textContent; break;
      case 'save-rename': action('chars/rename', { charId: id, name: item.querySelector('.rename-in').value }); break;
      case 'delete': action('chars/delete', { charId: id }); break;
      case 'left':
      case 'right': {
        const ids = [...list.querySelectorAll('li')].map((li) => Number(li.dataset.char));
        const at = ids.indexOf(id);
        const to = button.dataset.act === 'left' ? at - 1 : at + 1;
        [ids[at], ids[to]] = [ids[to], ids[at]];
        action('chars/reorder', { ids });
        break;
      }
    }
  });
  list.addEventListener('keydown', (event) => {
    if (event.target.matches('.rename-in') && event.key === 'Enter') event.target.closest('li').querySelector('[data-act=save-rename]').click();
    if (event.target.matches('.rename-in') && event.key === 'Escape') event.target.closest('li').querySelector('.a-rename [data-act=cancel]').click();
  });

  document.querySelector('.add').addEventListener('submit', (event) => {
    event.preventDefault();
    action('chars', { name: event.target.elements.name.value });
  });

  const main = document.querySelector('main');
  let activePress;
  let suppressedCell;
  let ignoreContextCell;
  let suppressTimer;
  let contextTimer;
  const suppressCellClick = (cell) => {
    suppressedCell = cell;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      if (suppressedCell === cell) suppressedCell = undefined;
    }, 800);
  };

  main.addEventListener('pointerdown', (event) => {
    const cell = event.target.closest('.cell');
    if (!cell || cell.disabled || event.button !== 0 || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    const press = { cell, pointerId: event.pointerId, x: event.clientX, y: event.clientY, fired: false, timer: undefined };
    activePress = press;
    press.timer = setTimeout(() => {
      if (activePress !== press) return;
      press.fired = true;
      toggleSkipCell(cell);
    }, 500);
  });
  window.addEventListener('pointermove', (event) => {
    if (!activePress || activePress.pointerId !== event.pointerId || activePress.fired) return;
    if (Math.hypot(event.clientX - activePress.x, event.clientY - activePress.y) <= 10) return;
    clearTimeout(activePress.timer);
    activePress = undefined;
  });
  window.addEventListener('pointerup', (event) => {
    if (!activePress || activePress.pointerId !== event.pointerId) return;
    const press = activePress;
    clearTimeout(press.timer);
    activePress = undefined;
    if (!press.fired) return;
    ignoreContextCell = press.cell;
    clearTimeout(contextTimer);
    suppressCellClick(press.cell);
    contextTimer = setTimeout(() => { ignoreContextCell = undefined; }, 800);
  });
  window.addEventListener('pointercancel', (event) => {
    if (!activePress || activePress.pointerId !== event.pointerId) return;
    clearTimeout(activePress.timer);
    activePress = undefined;
  });
  main.addEventListener('contextmenu', (event) => {
    const cell = event.target.closest('.cell');
    if (!cell) return;
    event.preventDefault();
    suppressCellClick(cell);
    if (activePress?.cell === cell) {
      if (activePress.fired) return;
      clearTimeout(activePress.timer);
      activePress.fired = true;
      toggleSkipCell(cell);
      return;
    }
    if (ignoreContextCell === cell) return;
    toggleSkipCell(cell);
  });
  main.addEventListener('keydown', (event) => {
    const cell = event.target.closest('.cell');
    if (!cell || !event.shiftKey || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    toggleSkipCell(cell);
  });
  main.addEventListener('click', (event) => {
    const clickedCell = event.target.closest('.cell');
    if (clickedCell && suppressedCell === clickedCell) {
      event.preventDefault();
      event.stopPropagation();
      suppressedCell = undefined;
      clearTimeout(suppressTimer);
      return;
    }
    if (clickedCell && event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const skipAll = event.target.closest('.skip-all');
    if (skipAll) { toggleSkipAll(skipAll); return; }
    const cell = event.target.closest('.cell');
    if (cell) toggleCell(cell);
  });
  main.addEventListener('change', async (event) => {
    const box = event.target.closest('input[data-remind]');
    if (!box) return;
    const id = box.dataset.remind;
    const value = box.checked;
    const all = () => document.querySelectorAll(`input[data-remind="${id}"]`);
    const sync = () => document.querySelectorAll('.event').forEach(updateOpen);
    all().forEach((other) => { other.checked = value; });
    sync();
    try {
      await post('remind', { charId: Number(id), remind: value });
    } catch (error) {
      all().forEach((other) => { other.checked = !value; });
      sync();
      toast(error.message);
    }
  });

  // Tabs: all panels are in the HTML, switching only toggles `hidden` and the URL.
  const tablist = document.querySelector('[role=tablist]');
  const tabs = [...tablist.querySelectorAll('[role=tab]')];
  const base = `/c/${token}`;
  const pathOf = (tab) => (tab.dataset.slug ? `${base}/${tab.dataset.slug}` : base);

  function select(tab, focus) {
    for (const other of tabs) {
      const on = other === tab;
      other.setAttribute('aria-selected', String(on));
      other.tabIndex = on ? 0 : -1;
      document.getElementById(other.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
    const left = tab.offsetLeft - tablist.offsetLeft;
    if (left < tablist.scrollLeft || left + tab.offsetWidth > tablist.scrollLeft + tablist.clientWidth) {
      tablist.scrollLeft = left - (tablist.clientWidth - tab.offsetWidth) / 2;
    }
  }

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role=tab]');
    if (!tab || tab.getAttribute('aria-selected') === 'true') return;
    select(tab, false);
    history.pushState(null, '', pathOf(tab));
  });
  tablist.addEventListener('keydown', (event) => {
    const at = tabs.indexOf(event.target.closest('[role=tab]'));
    const to = { ArrowRight: (at + 1) % tabs.length, ArrowLeft: (at - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (at < 0 || to === undefined) return;
    event.preventDefault();
    select(tabs[to], true);
    history.pushState(null, '', pathOf(tabs[to]));
  });
  window.addEventListener('popstate', () => {
    const slug = location.pathname.slice(base.length + 1);
    select(tabs.find((tab) => tab.dataset.slug === slug) || tabs[0], false);
  });
  const current = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
  if (current) select(current, false);
})();
