/**
 * Fill-mode widgets, one per field_type.
 *
 * Act 3 embedded real Qt widgets in the QGraphicsScene; here they are plain
 * DOM controls positioned with the field's raw model geometry, which works
 * because the page is 1 CSS px per PDF point.
 *
 * Each factory returns { el, setDisplay(text)?, refresh()? }.
 */

import { STAT_DISPLAY_NAMES, STAT_KEYS } from '../core/sheet-model.js';
import { hasVisibleBg, FIELD_DEFAULT_LINE_HEIGHT_MULT } from '../export/text-layout.js';
import { GLYPH_EM } from './metrics.js';
import { resolveRef, fileToDataUri } from '../io/asset-paths.js';

/** Types the user can never type into. */
const READONLY_TYPES = new Set(['formula', 'photo_static']);

function px(v) { return `${v}px`; }

function applyBox(el, field) {
  el.style.left = px(field.x);
  el.style.top = px(field.y);
  el.style.width = px(field.width);
  el.style.height = px(field.height);
}

function applyTextStyle(el, field) {
  el.style.fontSize = px(field.font_size);
  el.style.fontWeight = field.bold ? '700' : '400';
  el.style.fontStyle = field.italic ? 'italic' : 'normal';
  el.style.color = field.text_color;
  el.style.textAlign = field.alignment || 'left';
}

function applyChrome(el, field) {
  if (hasVisibleBg(field.bg_color)) {
    const alpha = Math.max(0, Math.min(255, field.bg_opacity)) / 255;
    el.style.background = hexToRgba(field.bg_color, alpha);
  }
  if (field.show_border) el.style.boxShadow = `inset 0 0 0 1px ${field.border_color}`;
}

function hexToRgba(hex, alpha) {
  const s = String(hex || '#ffffff').replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full.slice(0, 6) || 'ffffff', 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Shell div carrying position, chrome and the data-valign hook. */
function makeShell(field, extraClass = '') {
  const el = document.createElement('div');
  el.className = `field ${extraClass}`.trim();
  el.dataset.type = field.field_type;
  el.dataset.valign = field.valign || 'center';
  el.dataset.name = field.name;
  applyBox(el, field);
  applyChrome(el, field);
  if (field.placeholder) el.title = field.placeholder;
  return el;
}

// ── text / number ────────────────────────────────────────────────────────────

function makeSingleLine(field, ctx) {
  const el = makeShell(field, 'single-line');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'control';
  input.value = ctx.getValue(field.name);
  if (field.placeholder) input.placeholder = field.placeholder;
  if (field.max_chars > 0) input.maxLength = field.max_chars;
  applyTextStyle(input, field);
  // Match the exporter's glyph box so flex centring lands on the same baseline.
  input.style.lineHeight = String(GLYPH_EM);
  if (field.valign === 'top') input.style.marginTop = '1px';
  if (field.valign === 'bottom') input.style.marginBottom = '1px';

  input.addEventListener('input', () => ctx.setValue(field.name, input.value));
  el.append(input);
  return { el, control: input, setDisplay: (v) => { input.value = v; } };
}

function makeMultiline(field, ctx) {
  const el = makeShell(field);
  const ta = document.createElement('textarea');
  ta.className = 'control';
  ta.value = ctx.getValue(field.name);
  if (field.placeholder) ta.placeholder = field.placeholder;
  if (field.max_chars > 0) ta.maxLength = field.max_chars;
  applyTextStyle(ta, field);
  const lh = field.font_size * (field.line_height || FIELD_DEFAULT_LINE_HEIGHT_MULT);
  ta.style.lineHeight = px(lh);
  // wrap_width > 0 pins the wrap column regardless of the box width.
  if (field.wrap_width > 0) ta.style.width = px(field.wrap_width);

  ta.addEventListener('input', () => ctx.setValue(field.name, ta.value));
  el.append(ta);
  return { el, control: ta, setDisplay: (v) => { ta.value = v; } };
}

function makeReadonly(field) {
  const el = makeShell(field);
  const div = document.createElement('div');
  div.className = 'control readonly';
  applyTextStyle(div, field);
  const lh = field.font_size * (field.line_height || FIELD_DEFAULT_LINE_HEIGHT_MULT);
  div.style.lineHeight = px(lh);
  // The flex parent handles vertical alignment; this centres the text inside.
  const inner = document.createElement('span');
  inner.style.width = '100%';
  inner.style.display = 'block';
  div.append(inner);
  el.append(div);
  return { el, control: div, setDisplay: (v) => { inner.textContent = v; } };
}

// ── photo ───────────────────────────────────────────────────────────────────

const CAMERA_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.6" aria-hidden="true">
  <rect x="2.5" y="6.5" width="19" height="13" rx="2"/>
  <circle cx="12" cy="13" r="3.4"/>
  <path d="M9 6.5l1.2-2h3.6L15 6.5"/>
</svg>`;

function makePhoto(field, ctx) {
  const isUser = field.field_type === 'photo_user';
  const el = makeShell(field, `photo${isUser ? ' clickable' : ''}`);

  const img = document.createElement('img');
  img.alt = '';
  img.dataset.fit = field.fit_mode || 'cover';
  img.hidden = true;
  el.append(img);

  const ph = document.createElement('div');
  ph.className = 'photo-placeholder';
  // Act 3's on-screen widget honours placeholder_icon (its PDF path does not).
  if (field.placeholder_icon) ph.innerHTML = CAMERA_SVG;
  el.append(ph);

  const show = (ref) => {
    const url = resolveRef(ref);
    if (url) {
      img.src = url;
      img.hidden = false;
      ph.hidden = true;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      ph.hidden = false;
    }
  };

  show(isUser ? ctx.getValue(field.name) : field.static_image_path);

  if (isUser) {
    el.title = 'Нажмите, чтобы выбрать фотографию';
    el.addEventListener('click', async () => {
      const file = await pickImageFile();
      if (!file) return;
      // Stored inline as a data: URI — a browser has no path to remember.
      const dataUri = await fileToDataUri(file);
      ctx.setValue(field.name, dataUri);
      show(dataUri);
    });
  }

  return { el, refresh: () => show(isUser ? ctx.getValue(field.name) : field.static_image_path) };
}

function pickImageFile() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/bmp,image/webp,image/tiff';
    inp.addEventListener('change', () => resolve(inp.files && inp.files[0]));
    inp.addEventListener('cancel', () => resolve(null));
    inp.click();
  });
}

// ── hidden number / bool, drawn on the page itself ───────────────────────────

const BOOL_TRUE = new Set(['1', 'true', 'True', 'yes']);

function makeHidden(field, ctx) {
  const el = makeShell(field, 'hidden-field');
  el.style.boxShadow = 'none';
  el.style.background = 'transparent';

  let control;
  if (field.field_type === 'hidden_bool') {
    control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = BOOL_TRUE.has(ctx.getValue(field.name));
    control.addEventListener('change', () => {
      ctx.setValue(field.name, control.checked ? '1' : '0');
    });
  } else {
    control = document.createElement('input');
    control.type = 'number';
    control.min = '-9999';
    control.max = '9999';
    control.value = ctx.getValue(field.name) || '0';
    control.addEventListener('input', () => ctx.setValue(field.name, control.value));
  }
  control.title = field.displayName();
  el.append(control);

  return {
    el,
    control,
    refresh() {
      const raw = ctx.getValue(field.name);
      if (field.field_type === 'hidden_bool') control.checked = BOOL_TRUE.has(raw);
      else if (document.activeElement !== control) control.value = raw || '0';
    },
  };
}

// ── stats ───────────────────────────────────────────────────────────────────

function makeStats(field, ctx) {
  const el = makeShell(field, 'stats');
  const label = document.createElement('div');
  label.className = 'control';
  applyTextStyle(label, field);
  label.style.lineHeight = String(GLYPH_EM);
  el.append(label);

  const paint = () => {
    const key = ctx.getValue(field.name);
    const name = STAT_DISPLAY_NAMES[key];
    label.textContent = name || field.placeholder || 'Выбрать характеристику…';
    label.classList.toggle('unset', !name);
    // Preview every linked stat, the way Act 3's tooltip does.
    el.title = field.statLinks()
      .map(([abbr, linked], i) => {
        const v = linked ? ctx.getValue(linked) : '';
        return `${STAT_DISPLAY_NAMES[STAT_KEYS[i]]} (${abbr}): ${v || '—'}`;
      })
      .join('\n');
  };
  paint();

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openStatsMenu(el, field, ctx, (key) => {
      ctx.setValue(field.name, key);
      paint();
    });
  });

  return { el, control: label, refresh: paint };
}

function openStatsMenu(anchor, field, ctx, onPick) {
  document.querySelector('.stats-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'stats-menu';
  const current = ctx.getValue(field.name);

  field.statLinks().forEach(([, linked], i) => {
    const key = STAT_KEYS[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    if (key === current) btn.classList.add('checked');
    const name = document.createElement('span');
    name.textContent = STAT_DISPLAY_NAMES[key];
    const val = document.createElement('span');
    val.className = 'linked';
    val.textContent = `[${(linked && ctx.getValue(linked)) || '—'}]`;
    btn.append(name, val);
    btn.addEventListener('click', () => {
      onPick(key);
      close();
    });
    menu.append(btn);
  });

  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight;
  const top = r.bottom + mh > window.innerHeight ? Math.max(4, r.top - mh) : r.bottom;
  menu.style.left = px(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8));
  menu.style.top = px(top);

  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDown = (e) => { if (!menu.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

// ── ability ─────────────────────────────────────────────────────────────────

function parseBlocks(raw) {
  try {
    const b = JSON.parse(raw || '[]');
    if (Array.isArray(b) && b.length) return b;
  } catch (e) { /* fall through */ }
  return raw ? [{ type: 'text', content: raw }] : [{ type: 'title', content: '' }];
}

function makeAbility(field, ctx) {
  const el = makeShell(field, 'ability');
  const list = document.createElement('div');
  list.className = 'blocks';
  el.append(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'add-block';
  addBtn.textContent = '+  Добавить блок';
  el.append(addBtn);

  let blocks = parseBlocks(ctx.getValue(field.name));

  const commit = () => ctx.setValue(field.name, JSON.stringify(blocks));

  const styleFor = (ta, type) => {
    if (type === 'title') {
      ta.style.fontSize = px(field.ability_title_font_size);
      ta.style.fontWeight = field.ability_title_bold ? '700' : '400';
      ta.style.fontStyle = field.ability_title_italic ? 'italic' : 'normal';
      ta.style.color = field.ability_title_color;
      ta.style.textAlign = field.ability_title_alignment || 'left';
      ta.style.lineHeight = px(field.ability_title_font_size * 1.25);
      ta.placeholder = 'Заголовок…';
    } else {
      ta.style.fontSize = px(field.font_size);
      ta.style.fontWeight = field.bold ? '700' : '400';
      ta.style.fontStyle = field.italic ? 'italic' : 'normal';
      ta.style.color = field.text_color;
      ta.style.textAlign = field.alignment || 'left';
      ta.style.lineHeight = px(field.font_size
        * (field.line_height || FIELD_DEFAULT_LINE_HEIGHT_MULT));
      ta.placeholder = field.placeholder || 'Текст…';
    }
  };

  const autosize = (ta) => {
    ta.style.height = 'auto';
    ta.style.height = px(ta.scrollHeight);
  };

  const render = () => {
    list.textContent = '';
    blocks.forEach((block, i) => {
      const row = document.createElement('div');
      row.className = 'ability-block';

      const bar = document.createElement('div');
      bar.className = 'bar';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      const isTitle = (block.type || 'text') === 'title';
      toggle.textContent = isTitle
        ? 'Заголовок  →  Переключить на текст'
        : 'Текст  →  Переключить на заголовок';
      toggle.addEventListener('click', () => {
        block.type = isTitle ? 'text' : 'title';
        commit();
        render();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Удалить блок';
      // At least one block always remains, as in Act 3.
      del.disabled = blocks.length <= 1;
      del.addEventListener('click', () => {
        if (blocks.length <= 1) return;
        blocks.splice(i, 1);
        commit();
        render();
      });

      bar.append(toggle, del);

      const ta = document.createElement('textarea');
      ta.rows = 1;
      ta.value = block.content || '';
      styleFor(ta, block.type || 'text');
      ta.addEventListener('input', () => {
        block.content = ta.value;
        autosize(ta);
        commit();
      });

      row.append(bar, ta);
      list.append(row);
      requestAnimationFrame(() => autosize(ta));
    });
  };

  addBtn.addEventListener('click', () => {
    blocks.push({ type: 'text', content: '' });
    commit();
    render();
    const last = list.querySelector('.ability-block:last-child textarea');
    if (last) last.focus();
  });

  render();

  return {
    el,
    refresh() {
      blocks = parseBlocks(ctx.getValue(field.name));
      render();
    },
  };
}

// ── factory ─────────────────────────────────────────────────────────────────

/**
 * Build the widget for a field.
 *
 * @param {FieldConfig} field
 * @param {{getValue:Function, setValue:Function}} ctx
 */
export function createFieldWidget(field, ctx) {
  switch (field.field_type) {
    case 'photo_user':
    case 'photo_static':
      return makePhoto(field, ctx);
    case 'hidden_number':
    case 'hidden_bool':
      return makeHidden(field, ctx);
    case 'stats':
      return makeStats(field, ctx);
    case 'ability':
      return makeAbility(field, ctx);
    case 'formula':
      return makeReadonly(field);
    case 'text':
      return field.allow_multiline ? makeMultiline(field, ctx) : makeSingleLine(field, ctx);
    case 'number':
      // Act 3 uses a plain line edit here too — no numeric validator.
      return makeSingleLine(field, ctx);
    default:
      return makeSingleLine(field, ctx);
  }
}

export { READONLY_TYPES };
