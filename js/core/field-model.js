/**
 * FieldConfig — one absolutely-positioned field on a character sheet.
 *
 * Ported attribute-for-attribute from Act 3's core/field_model.py. The key
 * order in DEFAULTS is the Python dataclass declaration order, which is also
 * the serialisation order, so a round-tripped .ddsg keeps its original shape.
 *
 * field_type values:
 *   "text"          – editable text input
 *   "number"        – editable numeric input
 *   "formula"       – read-only, computed from `formula`
 *   "photo_user"    – photo slot: user picks the image at fill-time
 *   "photo_static"  – photo slot: fixed image from `static_image_path`
 *   "hidden_number" – editable number, sidebar only, never on the PDF
 *   "hidden_bool"   – editable boolean ("0"/"1"), sidebar only, 0/1 in formulas
 *   "stats"         – links 6 number fields; its own value is the selected key
 *   "ability"       – stack of title/text blocks stored as JSON
 *
 * The legacy "note" type is gone: note pages are free-form canvases now. Any
 * "note" field in an older file is dropped on load (see sheet-model.js).
 *
 * Geometry is in A4 PDF points with a top-left origin.
 */

export const PAGE_KIND_MAIN = 'main';
export const PAGE_KIND_LONGPLAY = 'longplay';
export const PAGE_KIND_NOTE_TEMPLATE = 'note_template';

export const ALL_PAGE_KINDS = [PAGE_KIND_MAIN, PAGE_KIND_LONGPLAY, PAGE_KIND_NOTE_TEMPLATE];

export const PAGE_KIND_TITLES = {
  [PAGE_KIND_MAIN]: 'Основная',
  [PAGE_KIND_LONGPLAY]: 'Лонгплей лист',
  [PAGE_KIND_NOTE_TEMPLATE]: 'Шаблон заметки',
};

/** Declaration-ordered defaults. All 47 serialised attributes. */
export const DEFAULTS = {
  // Identity
  id: '',
  name: 'Поле',
  label: '',
  // Type
  field_type: 'text',
  formula: '',
  // Geometry (PDF points, top-left origin)
  x: 100.0,
  y: 100.0,
  width: 160.0,
  height: 28.0,
  // Typography (unused by photo fields)
  font_family: 'Arial',
  font_size: 11,
  bold: false,
  italic: false,
  text_color: '#111111',
  alignment: 'left',
  valign: 'center',
  // Text behaviour
  allow_multiline: false,
  line_height: 1.3,
  // Constraints
  max_chars: 0,
  wrap_width: 0.0,
  // Appearance
  show_border: true,
  border_color: '#888888',
  bg_color: '#ffffff',
  bg_opacity: 200,
  placeholder: '',
  // Label
  label_font_size: 8,
  label_bold: false,
  label_color: '#444444',
  label_position: 'top',
  // Photo fields
  static_image_path: '',
  fit_mode: 'cover',
  placeholder_icon: true,
  // Legacy numeric page — still serialised so old builds can open new files
  page: 1,
  page_kind: PAGE_KIND_MAIN,
  // Sidebar grouping for hidden fields
  sidebar_group: '',
  // Ability title block
  ability_title_default: 'Название способности',
  ability_title_font_size: 13,
  ability_title_bold: true,
  ability_title_italic: false,
  ability_title_color: '#111111',
  ability_title_alignment: 'left',
  // Stats field — each holds the *name* of another field
  stat_str: '',
  stat_dex: '',
  stat_con: '',
  stat_int: '',
  stat_wis: '',
  stat_cha: '',
};

const VALID_KEYS = new Set(Object.keys(DEFAULTS));

const EDITABLE_TYPES = new Set([
  'text', 'number', 'photo_user', 'hidden_number', 'hidden_bool', 'stats', 'ability',
]);

export function uuid4() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts (plain http:// on a LAN address).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export class FieldConfig {
  constructor(data = {}) {
    for (const [k, v] of Object.entries(DEFAULTS)) this[k] = v;
    for (const [k, v] of Object.entries(data)) {
      if (VALID_KEYS.has(k)) this[k] = v;  // unknown keys ignored, like Python
    }
    if (!this.id) this.id = uuid4();
  }

  /** Plain object in declaration order, ready for JSON.stringify. */
  toJSON() {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = this[k];
    return out;
  }

  static fromJSON(data) {
    return new FieldConfig(data);
  }

  clone() {
    return new FieldConfig(this.toJSON());
  }

  isEditable() { return EDITABLE_TYPES.has(this.field_type); }
  isHidden() { return this.field_type === 'hidden_number' || this.field_type === 'hidden_bool'; }
  isPhoto() { return this.field_type === 'photo_user' || this.field_type === 'photo_static'; }
  isStats() { return this.field_type === 'stats'; }
  isAbility() { return this.field_type === 'ability'; }

  /** The "note" field type was removed; always false, like Act 3's shim. */
  isNote() { return false; }

  isOnMain() { return this.page_kind === PAGE_KIND_MAIN; }
  isOnLongplay() { return this.page_kind === PAGE_KIND_LONGPLAY; }
  isOnNoteTemplate() { return this.page_kind === PAGE_KIND_NOTE_TEMPLATE; }

  displayName() { return this.label ? this.label : this.name; }

  /** [abbrev, linkedFieldName] for the 6 D&D stats, in fixed order. */
  statLinks() {
    return [
      ['СИЛ', this.stat_str],
      ['ЛОВ', this.stat_dex],
      ['ТЕЛ', this.stat_con],
      ['ИНТ', this.stat_int],
      ['МДР', this.stat_wis],
      ['ХАР', this.stat_cha],
    ];
  }
}

/** Per-type accent colours, mirrored from ui/styles.py TYPE_COLORS. */
export const TYPE_COLORS = {
  text: '#BA4FC2',
  number: '#06b6d4',
  formula: '#DC74D2',
  photo_user: '#0891b2',
  photo_static: '#9A35AA',
  hidden_number: '#f59e0b',
  hidden_bool: '#d97706',
  stats: '#10b981',
  ability: '#e11d48',
  note: '#a78bfa',
};

/** Per-type Russian labels, mirrored from ui/styles.py TYPE_LABELS. */
export const TYPE_LABELS = {
  text: 'Текст',
  number: 'Число',
  formula: 'Формула',
  photo_user: 'Фото (польз.)',
  photo_static: 'Фото (статич.)',
  hidden_number: 'Скрытое число',
  hidden_bool: 'Скрытый булеан',
  stats: 'Характеристики',
  ability: 'Способность',
  note: 'Заметка',
};
