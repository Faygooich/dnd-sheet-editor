/**
 * Modal dialogs, replacing QMessageBox / QInputDialog.
 *
 * Every function resolves a promise, so callers read like the Qt originals.
 * Escape cancels, Enter confirms, and focus is restored on close.
 */

const KEEP_OPEN = Symbol('keep-open');

function buildModal({ title, body, actions, onOpen }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    backdrop.append(modal);

    if (title) {
      const h = document.createElement('div');
      h.className = 'modal-title';
      h.textContent = title;
      modal.append(h);
    }

    const bodyEl = document.createElement('div');
    bodyEl.className = 'modal-body';
    if (typeof body === 'string') bodyEl.textContent = body;
    else if (body) bodyEl.append(body);
    modal.append(bodyEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'modal-actions';
    modal.append(actionsEl);

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('shown');
      document.removeEventListener('keydown', onKey, true);
      const finish = () => {
        backdrop.remove();
        if (previous && previous.focus) previous.focus();
        resolve(value);
      };
      // Let the fade-out play, but never hang if transitions are disabled.
      backdrop.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 260);
    };

    let defaultAction = null;
    for (const spec of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = spec.label;
      if (spec.primary) btn.className = 'btn-primary';
      if (spec.danger) btn.className = 'btn-danger';
      btn.addEventListener('click', () => {
        const v = spec.value instanceof Function ? spec.value() : spec.value;
        if (v !== KEEP_OPEN) close(v);
      });
      if (spec.primary) defaultAction = btn;
      actionsEl.append(btn);
    }

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && defaultAction && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault(); e.stopPropagation();
        defaultAction.click();
      }
    };
    document.addEventListener('keydown', onKey, true);

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(null);
    });

    document.body.append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('shown'));

    if (onOpen) onOpen({ body: bodyEl, close });
    else if (defaultAction) defaultAction.focus();
  });
}

/** Informational dialog with a single OK button. */
export function info(title, text) {
  return buildModal({
    title, body: text,
    actions: [{ label: 'ОК', value: true, primary: true }],
  });
}

/** Error dialog. Same shape as info(), kept separate for call-site clarity. */
export function error(title, text) {
  return buildModal({
    title, body: text,
    actions: [{ label: 'ОК', value: true, primary: true }],
  });
}

/** Yes/No question. Resolves true only on «Да». */
export function confirm(title, text, { yes = 'Да', no = 'Нет', danger = false } = {}) {
  return buildModal({
    title, body: text,
    actions: [
      { label: no, value: false },
      { label: yes, value: true, primary: !danger, danger },
    ],
  }).then((v) => v === true);
}

/**
 * Single-line text prompt. Resolves the string, or null if cancelled.
 * `password: true` masks the input.
 */
export function prompt(title, label, {
  value = '', placeholder = '', password = false, ok = 'ОК',
} = {}) {
  let input;
  const body = document.createElement('div');
  body.style.display = 'contents';

  const lab = document.createElement('label');
  lab.textContent = label;
  input = document.createElement('input');
  input.type = password ? 'password' : 'text';
  input.value = value;
  input.placeholder = placeholder;
  lab.append(input);
  lab.style.display = 'grid';
  lab.style.gap = '6px';
  body.append(lab);

  return buildModal({
    title,
    body,
    actions: [
      { label: 'Отмена', value: null },
      { label: ok, value: () => input.value, primary: true },
    ],
    onOpen: () => {
      input.focus();
      input.select();
    },
  });
}

/**
 * Settings dialog. Resolves `{autosave}` on OK, or null on cancel.
 * `onClearRecent` is invoked immediately when the button is pressed, matching
 * Act 3 where the button acts at once and relabels itself.
 */
export function settings({ autosave, onClearRecent }) {
  const body = document.createElement('div');
  body.style.display = 'contents';

  const head = document.createElement('div');
  head.className = 'heading';
  head.textContent = 'Настройки приложения';
  body.append(head);

  const row = document.createElement('div');
  row.className = 'modal-row';
  const lab = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = Boolean(autosave);
  lab.append(cb, document.createTextNode('Автосохранение'));
  row.append(lab);
  body.append(row);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Сохраняет анкету в браузере через ~1.5 секунды после '
    + 'изменения, чтобы работа не потерялась при закрытии вкладки. Файл на '
    + 'диске при этом не перезаписывается — для него используйте «Сохранить».';
  body.append(hint);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = 'Очистить список недавних файлов';
  clear.addEventListener('click', async () => {
    clear.disabled = true;
    clear.textContent = 'Список очищен';
    if (onClearRecent) await onClearRecent();
  });
  body.append(clear);

  return buildModal({
    title: 'Настройки',
    body,
    actions: [
      { label: 'Отмена', value: null },
      { label: 'ОК', value: () => ({ autosave: cb.checked }), primary: true },
    ],
  });
}

/** The About box. */
export function about() {
  const body = document.createElement('div');
  body.style.display = 'grid';
  body.style.justifyItems = 'center';
  body.style.gap = '10px';
  body.style.textAlign = 'center';

  const logo = document.createElement('img');
  logo.src = new URL('../../assets/DnD.png', import.meta.url).href;
  logo.alt = '';
  logo.width = 128;
  logo.height = 128;
  logo.style.objectFit = 'contain';

  const name = document.createElement('div');
  name.textContent = 'Disco&Dragons Sheet Generator';
  name.style.cssText = 'color:#00ffff;font-weight:700;font-size:13px';

  const ver = document.createElement('div');
  ver.textContent = 'веб-версия — Act 4';
  ver.style.cssText = 'color:#00ffff;font-size:12px';

  const author = document.createElement('div');
  author.textContent = '~ made by Faygooich ~';
  author.style.cssText = 'color:#7f7ff2;font-size:11px';

  const year = document.createElement('div');
  year.textContent = '2026';
  year.style.cssText = 'color:#ff00e6;font-size:11px';

  body.append(logo, name, ver, author, year);

  return buildModal({
    title: 'О программе',
    body,
    actions: [{ label: 'ОК', value: true, primary: true }],
  });
}

export { KEEP_OPEN };
