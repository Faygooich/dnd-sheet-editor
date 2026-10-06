/**
 * Format sniffing — by content, not extension, as in Act 3's
 * MainWindow._detect_format.
 *
 * Order matters: an LSS export and an Act 2 sheet are both plain `.json`,
 * and a native sheet may be `.ddsg` or legacy `.json`.
 */

/** Long Story Short: a character envelope whose `data` is a JSON *string*. */
export function looksLikeLss(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.jsonType === 'character' && typeof obj.data === 'string') return true;
  const keys = new Set(Object.keys(obj));
  return keys.has('data') && keys.has('version') && keys.has('edition')
    && typeof obj.data === 'string';
}

/** The previous version of this program: a flat sheet with character_info. */
export function looksLikeAct2(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // Reject the other two formats first.
  if (obj.jsonType === 'character' || typeof obj.data === 'string') return false;
  if ('fields' in obj || 'note_instances' in obj || obj.format === 'ddsg') return false;
  return obj.character_info && typeof obj.character_info === 'object'
    && obj.abilities && typeof obj.abilities === 'object'
    && obj.skills && typeof obj.skills === 'object';
}

/** Native `.ddsg`, or a legacy `.json` written by an older build. */
export function looksLikeDdsg(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return obj.format === 'ddsg' || 'fields' in obj || 'note_instances' in obj;
}

/** @returns {"lss"|"act2"|"ddsg"|"unknown"} */
export function detectFormat(obj) {
  if (looksLikeLss(obj)) return 'lss';
  if (looksLikeAct2(obj)) return 'act2';
  if (looksLikeDdsg(obj)) return 'ddsg';
  return 'unknown';
}

/** Parse sheet text, tolerating a UTF-8 BOM the way Python's utf-8-sig does. */
export function parseSheetText(text) {
  return JSON.parse(String(text).replace(/^﻿/, ''));
}

export const FORMAT_LABELS = {
  ddsg: 'DDSG — Disco & Dragons',
  lss: 'LSS json — Long Story Short',
  act2: 'Старый формат DDSG Act 2',
  unknown: 'неизвестный формат',
};
