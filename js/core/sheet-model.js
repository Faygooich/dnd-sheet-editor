/**
 * SheetModel / NoteInstance — a port of Act 3's core/sheet_model.py.
 *
 * The on-disk shape is byte-compatible with Act 3's `.ddsg`, including the
 * legacy mirror keys (`page_count`, `page_backgrounds`, `exclude_page2_from_pdf`)
 * that exist purely so older builds can still open files written here.
 *
 * Two deliberate differences from Act 3, both forced by the browser:
 *
 *  1. Backgrounds. Act 3 stores absolute filesystem paths and anchors relative
 *     ones under its install directory. Here a built-in template is stored as
 *     the *relative* path "assets/themes/main_default.pdf" — which Act 3
 *     resolves correctly against its own install dir, so this is strictly more
 *     portable — and a user-supplied background is stored as a data: URI.
 *  2. Photos. Field values that hold an image are data: URIs rather than paths.
 *     See io/asset-paths.js for how legacy paths are resolved on load.
 */

import {
  FieldConfig,
  PAGE_KIND_MAIN, PAGE_KIND_LONGPLAY, PAGE_KIND_NOTE_TEMPLATE,
  ALL_PAGE_KINDS, uuid4,
} from './field-model.js';
import { FormulaParser } from './formula-parser.js';

export { PAGE_KIND_MAIN, PAGE_KIND_LONGPLAY, PAGE_KIND_NOTE_TEMPLATE, ALL_PAGE_KINDS };

export const A4_W = 595.276;
export const A4_H = 841.890;

export const DDSG_EXT = '.ddsg';
export const DDSG_FORMAT = 'ddsg';
export const DDSG_FORMAT_VERSION = 1;

export const DEFAULT_BG = 'assets/themes/main_default.pdf';
export const DEFAULT_BG2 = 'assets/themes/second_default.pdf';
export const DEFAULT_BG_NOTE = 'assets/themes/note_default.pdf';

export const PAGE_KIND_TEMPLATES = {
  [PAGE_KIND_MAIN]: DEFAULT_BG,
  [PAGE_KIND_LONGPLAY]: DEFAULT_BG2,
  [PAGE_KIND_NOTE_TEMPLATE]: DEFAULT_BG_NOTE,
};

const STAT_KEY_TO_ATTR = {
  str: 'stat_str',
  dex: 'stat_dex',
  con: 'stat_con',
  int: 'stat_int',
  wis: 'stat_wis',
  cha: 'stat_cha',
};

export const STAT_DISPLAY_NAMES = {
  str: 'Сила',
  dex: 'Ловкость',
  con: 'Телосложение',
  int: 'Интеллект',
  wis: 'Мудрость',
  cha: 'Харизма',
};

export const STAT_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/** Values Act 3 treats as a true hidden_bool. Any other string is "0". */
const BOOL_TRUE = new Set(['1', 'true', 'True', 'yes']);

/**
 * Normalise a background reference read from JSON. Act 3 additionally
 * anchored relative paths under its install directory; that is a filesystem
 * concept, so here the string is kept as-is and turned into a URL later by
 * io/asset-paths.js.
 */
function resolveBgPath(raw) {
  if (!raw) return raw;
  if (typeof raw === 'string' && raw.startsWith('data:')) return raw;
  return String(raw).replace(/\\/g, '/');
}

function templateForKind(kind) {
  return PAGE_KIND_TEMPLATES[kind] || DEFAULT_BG;
}

// ── Note instance ────────────────────────────────────────────────────────────

export class NoteInstance {
  /**
   * @param {object} opts
   *   id, title, values (legacy only), content, export_enabled
   *
   * `content` is a flat list of either
   *   {type:"stroke", points:[[x,y],…], width:N, color:"#rrggbb"}
   * or
   *   {type:"text", x,y,w,h, kind:"body"|"header", html:"<…>"}
   * in A4 PDF points with a top-left origin.
   */
  constructor({ id = '', title = '', values = null, content = null, export_enabled = true } = {}) {
    this.id = id || uuid4();
    this.title = title;
    // Legacy: older files stored note-template field values here. Nothing
    // writes to it any more, but it round-trips.
    this.values = values ? { ...values } : {};
    this.content = Array.isArray(content) ? content.slice() : [];
    // When false the page stays in the app but is skipped on PDF export.
    this.export_enabled = Boolean(export_enabled);
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      values: this.values,
      content: this.content,
      export_enabled: this.export_enabled,
    };
  }

  static fromJSON(data) {
    const d = data || {};
    return new NoteInstance({
      id: d.id || '',
      title: d.title || '',
      values: d.values && typeof d.values === 'object' ? d.values : {},
      content: Array.isArray(d.content) ? d.content : [],
      // Absent in files written before the per-note export toggle existed.
      export_enabled: d.export_enabled === undefined ? true : Boolean(d.export_enabled),
    });
  }

  /** True when the page would put anything on the PDF. */
  hasContent() {
    return this.content.length > 0;
  }
}

// ── Sheet model ──────────────────────────────────────────────────────────────

export class SheetModel {
  constructor() {
    this.title = 'Новая Анкета';

    this.longplay_enabled = true;
    /** @type {NoteInstance[]} — list order *is* the page order. */
    this.note_instances = [];

    this._bgByKind = {
      [PAGE_KIND_MAIN]: DEFAULT_BG,
      [PAGE_KIND_LONGPLAY]: DEFAULT_BG2,
      [PAGE_KIND_NOTE_TEMPLATE]: DEFAULT_BG_NOTE,
    };

    // Legacy mirrors — written on save so older builds can open the file.
    this.page_count = 2;
    this.page_backgrounds = { 1: DEFAULT_BG, 2: DEFAULT_BG2 };

    /** @type {FieldConfig[]} — list order is z-order. */
    this.fields = [];
    /** Flat value store for main + longplay, keyed by field NAME, not id. */
    this._values = {};
    this._parser = new FormulaParser();

    /** Original Long Story Short envelope, when this sheet came from one. */
    this.lss_source = null;
  }

  // ── backward-compat accessors ──────────────────────────────────────────

  get background_path() { return this._bgByKind[PAGE_KIND_MAIN] || DEFAULT_BG; }
  set background_path(v) {
    this._bgByKind[PAGE_KIND_MAIN] = v;
    this.page_backgrounds[1] = v;
  }

  get background_path_page2() { return this._bgByKind[PAGE_KIND_LONGPLAY] || DEFAULT_BG2; }
  set background_path_page2(v) {
    this._bgByKind[PAGE_KIND_LONGPLAY] = v;
    this.page_backgrounds[2] = v;
  }

  get exclude_page2_from_pdf() { return !this.longplay_enabled; }
  set exclude_page2_from_pdf(v) { this.longplay_enabled = !v; }

  // ── kind-aware background API ──────────────────────────────────────────

  backgroundForKind(kind) {
    return this._bgByKind[kind] || templateForKind(kind);
  }

  setBackgroundForKind(kind, path) {
    this._bgByKind[kind] = path;
    if (kind === PAGE_KIND_MAIN) this.page_backgrounds[1] = path;
    else if (kind === PAGE_KIND_LONGPLAY) this.page_backgrounds[2] = path;
  }

  resetBackgroundToDefault(kind) {
    this.setBackgroundForKind(kind, templateForKind(kind));
  }

  /** True when this kind still uses the bundled template. */
  isDefaultBackground(kind) {
    return this.backgroundForKind(kind) === templateForKind(kind);
  }

  // ── note-instance management ───────────────────────────────────────────

  addNoteInstance(title = '') {
    const n = this.note_instances.length + 1;
    const note = new NoteInstance({ title: title || `Заметка ${n}` });
    this.note_instances.push(note);
    return note;
  }

  removeNoteInstance(id) {
    this.note_instances = this.note_instances.filter((n) => n.id !== id);
  }

  /**
   * Act 3 copies the title and the legacy `values` but NOT `content`, so a
   * duplicated page comes up blank. Kept as-is rather than silently changed.
   */
  duplicateNoteInstance(id) {
    const i = this.note_instances.findIndex((n) => n.id === id);
    if (i < 0) return null;
    const src = this.note_instances[i];
    const dup = new NoteInstance({ title: src.title + ' (копия)', values: src.values });
    this.note_instances.splice(i + 1, 0, dup);
    return dup;
  }

  moveNoteInstance(id, delta) {
    const i = this.note_instances.findIndex((n) => n.id === id);
    if (i < 0) return;
    const j = Math.max(0, Math.min(this.note_instances.length - 1, i + delta));
    if (j === i) return;
    const [n] = this.note_instances.splice(i, 1);
    this.note_instances.splice(j, 0, n);
  }

  getNoteInstance(id) {
    return this.note_instances.find((n) => n.id === id) || null;
  }

  noteTemplateFields() {
    return this.fields.filter((f) => f.page_kind === PAGE_KIND_NOTE_TEMPLATE);
  }

  // ── fields management ──────────────────────────────────────────────────

  addField(field) { this.fields.push(field); }

  removeField(id) {
    const f = this.getField(id);
    this.fields = this.fields.filter((x) => x.id !== id);
    if (f) {
      delete this._values[f.name];
      for (const n of this.note_instances) delete n.values[f.name];
    }
  }

  getField(id) { return this.fields.find((f) => f.id === id) || null; }

  getFieldByName(name) { return this.fields.find((f) => f.name === name) || null; }

  fieldsForKind(kind) { return this.fields.filter((f) => f.page_kind === kind); }

  fieldNames() { return this.fields.map((f) => f.name); }

  editableFields() { return this.fields.filter((f) => f.isEditable()); }

  formulaFields() { return this.fields.filter((f) => f.field_type === 'formula'); }

  // ── values management ──────────────────────────────────────────────────

  setValue(name, value) { this._values[name] = value; }

  /** Drop every filled-in value, keeping the field layout. */
  clearValues() {
    this._values = {};
    for (const n of this.note_instances) n.values = {};
  }

  getRawValue(name) {
    const v = this._values[name];
    return v === undefined || v === null ? '' : v;
  }

  get values() { return this._values; }

  setNoteValue(instanceId, name, value) {
    const n = this.getNoteInstance(instanceId);
    if (n) n.values[name] = value;
  }

  getNoteRawValue(instanceId, name) {
    const n = this.getNoteInstance(instanceId);
    if (!n) return '';
    const v = n.values[name];
    return v === undefined || v === null ? '' : v;
  }

  getDisplayValue(name) {
    const field = this.getFieldByName(name);
    if (!field) return '';
    if (field.field_type === 'formula') {
      return this._parser.evaluate(field.formula, this._allNumericValues());
    }
    return this.getRawValue(name);
  }

  /**
   * A `stats` field's own value is a stat key; the matching stat_* attribute
   * names another field, and that field's value is what gets displayed.
   */
  resolveStatsFieldValue(field) {
    const selectedKey = this.getRawValue(field.name);
    const attr = STAT_KEY_TO_ATTR[selectedKey] || '';
    const linkedName = attr ? field[attr] || '' : '';
    if (linkedName) {
      const raw = this.getRawValue(linkedName);
      return raw ? raw : '0';
    }
    return '0';
  }

  /** Raw values with hidden_bool coerced to "1"/"0"; everything else verbatim. */
  _allNumericValues() {
    const out = {};
    for (const [name, val] of Object.entries(this._values)) {
      const field = this.getFieldByName(name);
      if (field && field.field_type === 'hidden_bool') {
        out[name] = BOOL_TRUE.has(val) ? '1' : '0';
      } else {
        out[name] = val;
      }
    }
    return out;
  }

  /**
   * Resolve every formula field against main + longplay values.
   *
   * Four passes, breaking early once nothing changes. This is a fixed-point
   * loop rather than a dependency sort, so a chain of formulas deeper than
   * four links does not fully converge — Act 3 behaves the same way, and the
   * pass limit is reproduced rather than "fixed" so both apps agree.
   */
  evaluateAllFormulas() {
    const raw = this._allNumericValues();
    const result = {};

    for (const field of this.fields) {
      if (field.field_type === 'stats') {
        result[field.name] = this.resolveStatsFieldValue(field);
      } else if (field.field_type !== 'formula') {
        result[field.name] = raw[field.name] === undefined ? '' : raw[field.name];
      }
    }

    for (let pass = 0; pass < 4; pass++) {
      const combined = Object.assign({}, raw, result);
      let changed = false;
      for (const field of this.fields) {
        if (field.field_type !== 'formula') continue;
        const next = this._parser.evaluate(field.formula, combined);
        if (result[field.name] !== next) changed = true;
        result[field.name] = next;
      }
      if (!changed) break;
    }

    return result;
  }

  /** Same, but per-note values win over document-scope ones. */
  evaluateAllFormulasForNote(instanceId) {
    const note = this.getNoteInstance(instanceId);
    if (!note) return this.evaluateAllFormulas();

    const raw = {};
    for (const [name, val] of Object.entries(this._values)) {
      const field = this.getFieldByName(name);
      if (field && field.field_type === 'hidden_bool') {
        raw[name] = BOOL_TRUE.has(val) ? '1' : '0';
      } else {
        raw[name] = val;
      }
    }
    for (const [name, val] of Object.entries(note.values)) raw[name] = val;

    const result = {};
    for (const field of this.fields) {
      if (field.field_type === 'stats') {
        result[field.name] = this.resolveStatsFieldValue(field);
      } else if (field.field_type !== 'formula') {
        if (field.page_kind === PAGE_KIND_NOTE_TEMPLATE) {
          const v = note.values[field.name];
          result[field.name] = v === undefined ? '' : v;
        } else {
          result[field.name] = raw[field.name] === undefined ? '' : raw[field.name];
        }
      }
    }

    for (let pass = 0; pass < 4; pass++) {
      const combined = Object.assign({}, raw, result);
      let changed = false;
      for (const field of this.fields) {
        if (field.field_type !== 'formula') continue;
        const next = this._parser.evaluate(field.formula, combined);
        if (result[field.name] !== next) changed = true;
        result[field.name] = next;
      }
      if (!changed) break;
    }

    return result;
  }

  // ── PDF page order ─────────────────────────────────────────────────────

  /** [kind, instanceOrNull] for every page the PDF should contain, in order. */
  iterPdfPages() {
    const out = [[PAGE_KIND_MAIN, null]];
    if (this.longplay_enabled) out.push([PAGE_KIND_LONGPLAY, null]);
    for (const n of this.note_instances) {
      if (n.export_enabled) out.push([PAGE_KIND_NOTE_TEMPLATE, n]);
    }
    return out;
  }

  /** Legacy 1-based page numbering, kept for tooling parity. */
  pages() {
    const out = [1];
    if (this.longplay_enabled) out.push(2);
    for (let i = 0; i < this.note_instances.length; i++) out.push(3 + i);
    return out;
  }

  // ── serialisation ──────────────────────────────────────────────────────

  toJSON() {
    // Resync the legacy mirror before serialising, as Act 3 does.
    this.page_backgrounds[1] = this._bgByKind[PAGE_KIND_MAIN] || DEFAULT_BG;
    this.page_backgrounds[2] = this._bgByKind[PAGE_KIND_LONGPLAY] || DEFAULT_BG2;

    const legacyBgs = {};
    for (const [k, v] of Object.entries(this.page_backgrounds)) legacyBgs[String(k)] = v;

    const out = {
      format: DDSG_FORMAT,
      format_version: DDSG_FORMAT_VERSION,
      title: this.title,
      // Legacy mirrors — older builds read these.
      page_count: this.page_count,
      page_backgrounds: legacyBgs,
      exclude_page2_from_pdf: !this.longplay_enabled,
      // Authoritative model.
      longplay_enabled: this.longplay_enabled,
      background_by_kind: { ...this._bgByKind },
      note_instances: this.note_instances.map((n) => n.toJSON()),
      fields: this.fields.map((f) => f.toJSON()),
      values: this._values,
    };
    if (this.lss_source) out.lss_source = this.lss_source;
    return out;
  }

  static fromJSON(data) {
    const model = new SheetModel();
    const d = data || {};
    model.title = d.title === undefined ? 'Анкета' : d.title;

    // longplay: prefer the new key, else invert the legacy one.
    if ('longplay_enabled' in d) model.longplay_enabled = Boolean(d.longplay_enabled);
    else if ('exclude_page2_from_pdf' in d) {
      model.longplay_enabled = !d.exclude_page2_from_pdf;
    }

    // Backgrounds, three tiers: by-kind → legacy numbered → oldest scalars.
    const byKind = d.background_by_kind || {};
    if ('background_by_kind' in d) {
      for (const [k, v] of Object.entries(byKind)) {
        if (ALL_PAGE_KINDS.includes(k)) model._bgByKind[k] = resolveBgPath(v);
      }
    }

    if ('page_backgrounds' in d) {
      const legacy = {};
      for (const [k, v] of Object.entries(d.page_backgrounds || {})) {
        legacy[parseInt(k, 10)] = resolveBgPath(v);
      }
      model.page_backgrounds = legacy;
      // Only backfill a kind the authoritative map did not already declare.
      if (1 in legacy && !(PAGE_KIND_MAIN in byKind)) {
        model._bgByKind[PAGE_KIND_MAIN] = legacy[1];
      }
      if (2 in legacy && !(PAGE_KIND_LONGPLAY in byKind)) {
        model._bgByKind[PAGE_KIND_LONGPLAY] = legacy[2];
      }
    } else {
      const bg1 = resolveBgPath(d.background_path || DEFAULT_BG);
      const bg2 = resolveBgPath(d.background_path_page2 || DEFAULT_BG2);
      model._bgByKind[PAGE_KIND_MAIN] = bg1;
      model._bgByKind[PAGE_KIND_LONGPLAY] = bg2;
      model.page_backgrounds = { 1: bg1, 2: bg2 };
    }

    // Fields.
    const rawFields = Array.isArray(d.fields) ? d.fields : [];
    model.fields = rawFields.map((fd) => FieldConfig.fromJSON(fd));

    // Migrate the legacy numeric `page` to `page_kind` where needed, then
    // always resync `page` from `page_kind` for serialisation symmetry.
    const newKindSet = rawFields.some((fd) => 'page_kind' in fd);
    for (const f of model.fields) {
      const legacyPage = f.page || 1;
      if (!newKindSet || !ALL_PAGE_KINDS.includes(f.page_kind)) {
        if (legacyPage <= 1) f.page_kind = PAGE_KIND_MAIN;
        else if (legacyPage === 2) f.page_kind = PAGE_KIND_LONGPLAY;
        else f.page_kind = PAGE_KIND_NOTE_TEMPLATE;
      }
      if (f.page_kind === PAGE_KIND_MAIN) f.page = 1;
      else if (f.page_kind === PAGE_KIND_LONGPLAY) f.page = 2;
      else f.page = 3;
    }

    // The developer note-template editor and the "note" field type are gone;
    // fields that lived there have nowhere to go, so they are dropped. Note
    // pages are free-form canvases on NoteInstance.content now.
    model.fields = model.fields.filter(
      (f) => f.page_kind !== PAGE_KIND_NOTE_TEMPLATE && f.field_type !== 'note',
    );

    if (Array.isArray(d.note_instances)) {
      model.note_instances = d.note_instances.map((n) => NoteInstance.fromJSON(n));
    }

    model.page_count = d.page_count === undefined
      ? (model.longplay_enabled ? 2 : 1)
      : d.page_count;

    model._values = Object.assign({}, d.values || {});

    if (d.lss_source && typeof d.lss_source === 'object') model.lss_source = d.lss_source;

    return model;
  }

  /** Parse a .ddsg / legacy .json payload. Tolerates a UTF-8 BOM. */
  static parse(text) {
    return SheetModel.fromJSON(JSON.parse(String(text).replace(/^﻿/, '')));
  }

  serialize() {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  /** "«Название» - Disco&Dragons.ddsg", with path separators neutralised. */
  generateFilename(ext = 'ddsg') {
    const safe = String(this.title || 'Анкета').replace(/[/\\]/g, '-');
    return `${safe} - Disco&Dragons.${ext}`;
  }

  defaultSaveName() { return this.generateFilename('ddsg'); }
}
