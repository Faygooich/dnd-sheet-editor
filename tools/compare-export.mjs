/**
 * Pixel-compare this web build's PDF export against the desktop Act 3.
 *
 * This is the regression check behind the fidelity claims in the README. It
 * exports the same sheets with both versions and diffs the rendered pages.
 *
 * Requirements
 *   - Node (any recent version)
 *   - the Act 3 folder next to this one, with its Python deps installed:
 *     reportlab, pymupdf, Pillow, pikepdf
 *
 * Usage
 *   node compare-export.mjs [path-to-act3] [work-dir]
 *
 * Defaults: Act 3 is looked for as a sibling folder named
 * "Disco&Dragons Sheet Generator Act 3"; the work dir is ./.compare
 *
 * Exits non-zero if any page differs by more than antialiasing noise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');

const act3 = path.resolve(process.argv[2]
  || path.join(APP, '..', 'Disco&Dragons Sheet Generator Act 3'));
const work = path.resolve(process.argv[3] || path.join(HERE, '.compare'));

if (!fs.existsSync(path.join(act3, 'core', 'sheet_model.py'))) {
  console.error(`Не найден Act 3: ${act3}\nУкажите путь первым аргументом.`);
  process.exit(2);
}
fs.mkdirSync(work, { recursive: true });

const python = process.platform === 'win32' ? 'python' : 'python3';

function run(cmd, args) {
  // Windows consoles default to a legacy codepage, which turns the scripts'
  // Russian output into mojibake; force UTF-8 for the child.
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  const r = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (r.error) throw r.error;
  return r.status;
}

console.log('--- 1/3  эталонный экспорт из Act 3 ---');
if (run(python, [path.join(HERE, 'export-reference.py'), act3, work]) !== 0) {
  console.error('Не удалось получить эталон.');
  process.exit(2);
}

console.log('\n--- 2/3  экспорт из веб-сборки ---');

// The app fetches its assets by URL; in Node, point fetch at the files.
globalThis.fetch = async (input) => {
  const raw = String(input);
  const p = raw.startsWith('file:') ? fileURLToPath(raw) : path.join(APP, raw);
  const buf = fs.readFileSync(p);
  return {
    ok: true,
    status: 200,
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};
globalThis.PDFLib = require(path.join(APP, 'js/vendor/pdf-lib.min.js'));
globalThis.fontkit = require(path.join(APP, 'js/vendor/fontkit.umd.min.js'));

const { SheetModel } = await import(pathToFileURL(path.join(APP, 'js/core/sheet-model.js')));
const { exportSheetToPdf } = await import(pathToFileURL(path.join(APP, 'js/export/pdf-export.js')));

for (const file of fs.readdirSync(work)) {
  const m = file.match(/^case_(.+)\.ddsg$/);
  if (!m) continue;
  const name = m[1];
  const sheet = SheetModel.parse(fs.readFileSync(path.join(work, file), 'utf8'));
  const bytes = await exportSheetToPdf(sheet);
  fs.writeFileSync(path.join(work, `web_${name}.pdf`), bytes);
  console.log(`${name}: ${sheet.iterPdfPages().length} стр. -> ${bytes.length} байт`);
}

console.log('\n--- 3/3  попиксельное сравнение ---');
process.exit(run(python, [path.join(HERE, 'compare-pixels.py'), work]) || 0);
