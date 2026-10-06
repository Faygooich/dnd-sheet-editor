/**
 * TrueType metrics read straight out of the font file.
 *
 * Act 3 deliberately positions field text with the **hhea** ascent/descent
 * rather than the OS/2 typographic metrics, because that is what Qt uses on
 * screen, and the two disagree badly on a decorative face: for Segoe Script at
 * 13 pt it is a 20.59 pt glyph box versus 12.82 pt. Using the wrong pair
 * shifts the text in every single field, so the same table is read here.
 *
 * This mirrors utils/pdf_utils.py's `_read_ttf_metrics` /
 * `_qt_compatible_ascent_descent`, in ~40 lines of DataView instead of struct.
 */

/** Both bundled faces measure identically; used when a font can't be parsed. */
export const FALLBACK_METRICS = {
  unitsPerEm: 2048,
  ascent: 2230,
  descent: -1014,
  lineGap: 0,
};

/**
 * @param {ArrayBuffer|Uint8Array} buf  raw .ttf bytes
 * @returns {{unitsPerEm:number, ascent:number, descent:number, lineGap:number}}
 */
export function readTtfMetrics(buf) {
  try {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const numTables = dv.getUint16(4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(
        bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3],
      );
      tables[tag] = dv.getUint32(rec + 8);
    }
    if (tables.head === undefined || tables.hhea === undefined) return FALLBACK_METRICS;

    return {
      unitsPerEm: dv.getUint16(tables.head + 18),
      ascent: dv.getInt16(tables.hhea + 4),
      descent: dv.getInt16(tables.hhea + 6),   // already negative
      lineGap: dv.getInt16(tables.hhea + 8),
    };
  } catch (e) {
    return FALLBACK_METRICS;
  }
}

/**
 * Ascent and descent in points for a given size. Descent stays NEGATIVE,
 * following the ReportLab convention Act 3's layout math assumes.
 */
export function ascentDescent(metrics, size) {
  const m = metrics || FALLBACK_METRICS;
  const upem = m.unitsPerEm || 2048;
  return {
    ascent: (m.ascent / upem) * size,
    descent: (m.descent / upem) * size,
  };
}

/** Full glyph box height: ascender top to descender bottom. */
export function glyphHeight(metrics, size) {
  const { ascent, descent } = ascentDescent(metrics, size);
  return ascent - descent;
}
