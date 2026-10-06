/**
 * Shared font constants for on-screen layout.
 *
 * Both bundled Segoe Script faces report hhea ascent 2230 / descent -1014
 * over a 2048 unitsPerEm, giving a glyph box of 1.583984 em. The exporter
 * centres field text in that box (see export/font-metrics.js), so the screen
 * uses the same number as its line-height and the two agree.
 */

export const HHEA_ASCENT_EM = 2230 / 2048;      //  1.088867
export const HHEA_DESCENT_EM = -1014 / 2048;    // -0.495117
export const GLYPH_EM = HHEA_ASCENT_EM - HHEA_DESCENT_EM;   // 1.583984

/**
 * Note-page text sizes, in A4 points.
 *
 * Act 3's note editor lays text out in Qt *pixels* inside a point-based
 * scene, and its exporter compensates with a x1.35 factor. The products are
 * what actually lands on the page, so the web app uses them directly and
 * needs no compensation of its own.
 */
export const NOTE_SCALE = 1.35;
export const NOTE_BODY_PT = 8 * NOTE_SCALE;      // 10.8
export const NOTE_HEADER_PT = 14 * NOTE_SCALE;   // 18.9

/** Baseline pitch: Qt's 1.625 x the nominal 8 pt, i.e. 13 pt. */
export const NOTE_LEADING_PT = 8 * 1.625;        // 13
export const NOTE_LINE_HEIGHT = NOTE_LEADING_PT / NOTE_BODY_PT;   // ~1.2037
