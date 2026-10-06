/**
 * The «Параметры» sidebar — Act 3's _HiddenFieldsPanel.
 *
 * Lists every hidden_number / hidden_bool field, grouped by `sidebar_group`
 * into collapsible sections. These controls share their value with the ghost
 * widgets drawn on the page itself, so both must be refreshed together.
 */

import { iconImg } from './icons.js';

const BOOL_TRUE = new Set(['1', 'true', 'True', 'yes']);

export class HiddenPanel {
  constructor(root, { onValueChanged } = {}) {
    this.root = root;
    this.onValueChanged = onValueChanged || (() => {});
    this.sheet = null;
    this.rows = [];
    this.collapsed = new Set();
  }

  setSheet(sheet) {
    this.sheet = sheet;
    this.render();
  }

  render() {
    this.root.textContent = '';
    this.rows = [];
    if (!this.sheet) return;

    const hidden = this.sheet.fields.filter((f) => f.isHidden());
    if (!hidden.length) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'Нет скрытых полей';
      this.root.append(empty);
      return;
    }

    // Preserve declaration order of the groups themselves.
    const groups = new Map();
    for (const f of hidden) {
      const key = f.sidebar_group || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }

    for (const [name, fields] of groups) {
      if (!name) {
        for (const f of fields) this.root.append(this._makeRow(f));
        continue;
      }

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'group-header';
      const chevron = iconImg(this.collapsed.has(name) ? 'tri_right_small' : 'tri_down_small', 10);
      header.append(chevron, document.createTextNode(name));

      const body = document.createElement('div');
      body.hidden = this.collapsed.has(name);
      for (const f of fields) body.append(this._makeRow(f));

      header.addEventListener('click', () => {
        const nowCollapsed = !this.collapsed.has(name);
        if (nowCollapsed) this.collapsed.add(name);
        else this.collapsed.delete(name);
        body.hidden = nowCollapsed;
        chevron.src = iconImg(nowCollapsed ? 'tri_right_small' : 'tri_down_small').src;
      });

      this.root.append(header, body);
    }
  }

  _makeRow(field) {
    const row = document.createElement('div');
    row.className = 'field-row';

    const dot = document.createElement('span');
    dot.className = `dot ${field.field_type}`;
    row.append(dot);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = field.displayName();
    name.title = field.displayName();
    row.append(name);

    let control;
    if (field.field_type === 'hidden_bool') {
      control = document.createElement('input');
      control.type = 'checkbox';
      control.checked = BOOL_TRUE.has(this.sheet.getRawValue(field.name));
      control.addEventListener('change', () => {
        this.sheet.setValue(field.name, control.checked ? '1' : '0');
        this.onValueChanged(field.name, control.value);
      });
    } else {
      control = document.createElement('input');
      control.type = 'number';
      control.min = '-999';
      control.max = '999';
      control.value = this.sheet.getRawValue(field.name) || '0';
      control.addEventListener('input', () => {
        this.sheet.setValue(field.name, control.value);
        this.onValueChanged(field.name, control.value);
      });
    }
    control.setAttribute('aria-label', field.displayName());
    row.append(control);

    this.rows.push({ field, control });
    return row;
  }

  /** Re-read values from the model, e.g. after the on-page twin changed. */
  refreshValues() {
    if (!this.sheet) return;
    for (const { field, control } of this.rows) {
      if (document.activeElement === control) continue;
      const raw = this.sheet.getRawValue(field.name);
      if (field.field_type === 'hidden_bool') control.checked = BOOL_TRUE.has(raw);
      else control.value = raw || '0';
    }
  }
}
