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
    try { sessionStorage.setItem('ffe-scroll', String(window.scrollY)); } catch { /* optional */ }
    location.reload();
  }
  try {
    const saved = sessionStorage.getItem('ffe-scroll');
    if (saved) { sessionStorage.removeItem('ffe-scroll'); window.scrollTo(0, Number(saved)); }
  } catch { /* optional */ }

  function updateProgress(table, charId) {
    const done = table.querySelectorAll(`.cell[data-char="${charId}"][aria-pressed="true"]`).length;
    const prog = table.querySelector(`thead th[data-char="${charId}"] .prog`);
    if (prog) prog.querySelector('b').textContent = String(done);
  }

  async function toggleCell(cell) {
    if (cell.getAttribute('aria-busy') === 'true') return;
    const next = cell.getAttribute('aria-pressed') !== 'true';
    const table = cell.closest('table');
    const set = (value) => { cell.setAttribute('aria-pressed', String(value)); updateProgress(table, cell.dataset.char); };
    set(next);
    cell.setAttribute('aria-busy', 'true');
    try {
      await post('toggle', {
        charId: Number(cell.dataset.char),
        eventKey: cell.closest('.event').dataset.event,
        itemId: cell.dataset.item,
        done: next,
      });
    } catch (error) {
      set(!next);
      toast(error.message);
    } finally {
      cell.removeAttribute('aria-busy');
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

  document.querySelector('main').addEventListener('click', (event) => {
    const cell = event.target.closest('.cell');
    if (cell) toggleCell(cell);
  });
  document.querySelector('main').addEventListener('change', async (event) => {
    const box = event.target.closest('input[data-remind]');
    if (!box) return;
    const id = box.dataset.remind;
    const value = box.checked;
    const all = () => document.querySelectorAll(`input[data-remind="${id}"]`);
    all().forEach((other) => { other.checked = value; });
    try {
      await post('remind', { charId: Number(id), remind: value });
    } catch (error) {
      all().forEach((other) => { other.checked = !value; });
      toast(error.message);
    }
  });
})();
