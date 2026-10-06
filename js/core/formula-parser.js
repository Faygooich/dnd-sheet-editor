/**
 * Formula evaluator — a port of Act 3's core/formula_parser.py.
 *
 * Two syntaxes, chosen exactly the way Act 3 chooses them:
 *   bare expression   ceil((Ловкость - 10) / 2)
 *   template          +{ceil((Ловкость - 10) / 2)}   or   {Скорость} фт
 *
 * Python's `ast` module did the parsing there; here it is a hand-written
 * tokenizer plus a precedence-climbing parser over the same whitelisted
 * node set. Everything outside that set is an error, as before.
 *
 * Python semantics that JavaScript does NOT share, and which are implemented
 * explicitly below because formulas in the wild depend on them:
 *   - round()  is round-half-to-even  (round(0.5) === 0, round(1.5) === 2)
 *   - //       floors toward -Infinity, and %  takes the sign of the divisor
 *   - int()    truncates toward zero, while floor() floors
 *   - / // %   all yield 0 on division by zero instead of raising
 */

/** Carries a message that reaches the user verbatim inside "#ERR:". */
export class PyError extends Error {}

/** Mirrors the text Python's ast.parse puts in its SyntaxError. */
class SyntaxErr extends PyError {
  constructor() { super('invalid syntax (<unknown>, line 1)'); }
}

// ── Python-compatible numeric helpers ────────────────────────────────────────

/** Python 3 round(): half-to-even. With one argument it returns an integer. */
function pyRound(x, nd) {
  if (nd === undefined || nd === null) {
    if (!Number.isFinite(x)) return x;
    // x - floor(x) is exact for these magnitudes, so an exact .5 is detected.
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;   // exact .5 rounds to even
  }
  return pyRoundDigits(x, pyInt(nd));
}

/**
 * Two-argument round(), decided on the double's exact decimal expansion.
 *
 * Scaling by a power of ten instead (x * 100) introduces its own error and
 * flips results: 2.675 * 100 is exactly 267.5 in binary, which rounds to
 * 268 → 2.68, whereas the true value of 2.675 sits just below the midpoint,
 * so Python yields 2.67. toFixed() expands the real value, so comparing
 * digits gets the boundary right.
 */
function pyRoundDigits(x, nd) {
  if (!Number.isFinite(x) || nd < 0) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(Math.min(100, nd + 40));
  const dot = s.indexOf('.');
  const intPart = s.slice(0, dot);
  const frac = s.slice(dot + 1);
  const keep = frac.slice(0, nd);
  const rest = frac.slice(nd);

  const first = rest[0] || '0';
  let roundUp;
  if (first > '5') roundUp = true;
  else if (first < '5') roundUp = false;
  else if (rest.slice(1).replace(/0+$/, '').length) roundUp = true;  // above midpoint
  else {
    // Exactly on the midpoint: Python rounds to even.
    const lastKept = nd > 0 ? keep[nd - 1] : intPart[intPart.length - 1];
    roundUp = Number(lastKept) % 2 === 1;
  }

  let digits = intPart + keep;
  if (roundUp) {
    digits = (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
  }
  const cut = digits.length - nd;
  const out = Number(nd > 0 ? digits.slice(0, cut) + '.' + digits.slice(cut) : digits);
  return neg ? -out : out;
}

/** Python's repr for a float: an integral value still shows its ".0". */
function pyFloatRepr(v) {
  if (!Number.isFinite(v)) return String(v);
  return Number.isInteger(v) ? v + '.0' : String(v);
}

/** Python `%`: the result takes the sign of the divisor. */
function pyMod(a, b) {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INT_RE = /^[+-]?\d+$/;

/** Python float(str): tolerant of surrounding space and nan/inf spellings. */
function pyFloat(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  const low = s.toLowerCase().replace(/^[+-]/, '');
  if (low === 'nan') return NaN;
  if (low === 'inf' || low === 'infinity') return s.startsWith('-') ? -Infinity : Infinity;
  if (!FLOAT_RE.test(s)) throw new PyError('could not convert string to float: ' + quote(s));
  return parseFloat(s);
}

/** Python int(): truncates a number, rejects a non-integer string. */
function pyInt(v) {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  if (!INT_RE.test(s)) {
    throw new PyError('invalid literal for int() with base 10: ' + quote(s));
  }
  return parseInt(s, 10);
}

function quote(s) { return "'" + s + "'"; }

// ── Python truth, type names and comparison semantics ────────────────────────

function pyTruthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return Boolean(v);
}

function typeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'str';
  return Number.isInteger(v) ? 'int' : 'float';
}

/** Ordering comparison. Python refuses to order a str against a number. */
function pyLt(a, b) {
  const sa = typeof a === 'string';
  const sb = typeof b === 'string';
  if (sa !== sb) {
    throw new PyError(
      quote('<') + ' not supported between instances of '
      + quote(typeName(a)) + ' and ' + quote(typeName(b)));
  }
  return a < b;
}

/** True/1 and False/0 compare equal in Python; strings never coerce. */
function looseNum(v) { return typeof v === 'number' || typeof v === 'boolean'; }

function pyCompare(op, a, b) {
  switch (op) {
    case '==':
      if (a === b) return true;
      return looseNum(a) && looseNum(b) && Number(a) === Number(b);
    case '!=': return !pyCompare('==', a, b);
    case '<': return pyLt(a, b);
    case '>': return pyLt(b, a);
    case '<=': return !pyLt(b, a);
    case '>=': return !pyLt(a, b);
    default: throw new PyError('Неподдерживаемое сравнение');
  }
}

// ── whitelisted namespace ────────────────────────────────────────────────────

function _signed(x) {
  let n;
  try { n = Math.trunc(pyFloat(x)); } catch (e) { return String(x); }
  return n >= 0 ? '+' + n : String(n);
}

function _yesno(x) { return pyTruthy(x) ? 'Да' : 'Нет'; }

function _percent(x, decimals = 0) {
  let val;
  try { val = pyFloat(x); } catch (e) { return String(x); }
  if (decimals) return pyRound(val, decimals).toFixed(decimals) + '%';
  return pyRound(val) + '%';
}

function _mean(...args) {
  const nums = [];
  for (const a of args) {
    try { nums.push(pyFloat(a)); }
    catch (e) { throw new PyError('mean: все аргументы должны быть числами'); }
  }
  if (!nums.length) throw new PyError('mean: требуется хотя бы один аргумент');
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function _log(x, base) {
  let v;
  try { v = pyFloat(x); }
  catch (e) { throw new PyError('log: первый аргумент должен быть числом'); }
  if (v <= 0) return 0.0;                 // safe fallback for age=0 or negatives
  if (base === undefined) return Math.log(v);
  let b;
  try { b = pyFloat(base); }
  catch (e) { throw new PyError('log: основание должно быть числом'); }
  if (b <= 0 || b === 1) throw new PyError('log: основание должно быть > 0 и ≠ 1');
  return Math.log(v) / Math.log(b);
}

function _sqrt(x) {
  const v = pyFloat(x);
  if (v < 0) throw new PyError('expected a nonnegative input, got ' + pyFloatRepr(v));
  return Math.sqrt(v);
}

const _min = (...a) => a.reduce((m, v) => (pyLt(v, m) ? v : m));
const _max = (...a) => a.reduce((m, v) => (pyLt(m, v) ? v : m));

export const SAFE_FUNCS = {
  signed: _signed,
  yesno: _yesno,
  percent: _percent,
  mean: _mean,
  ceil: (x) => Math.ceil(pyFloat(x)),
  floor: (x) => Math.floor(pyFloat(x)),
  round: (x, nd) => pyRound(pyFloat(x), nd),
  abs: (x) => Math.abs(pyFloat(x)),
  min: _min,
  max: _max,
  sqrt: _sqrt,
  log: _log,
  int: pyInt,
  float: pyFloat,
};

export const SAFE_CONSTS = { True: true, False: false, None: null };

// ── tokenizer ────────────────────────────────────────────────────────────────

// A name is any run of letters (any script — Cyrillic included), digits and _.
const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_]/u;

// ':' '[' ']' '{' '}' '.' are tokenized but never accepted. They exist so the
// parser can reject them by Python AST node name (Lambda, List, Subscript,
// Dict, Attribute) the way Act 3's generic_visit does, instead of failing
// earlier with a generic syntax error.
const PUNCT = [
  '**', '//', '<<', '>>', '<=', '>=', '==', '!=',
  '+', '-', '*', '/', '%', '(', ')', ',', '<', '>', '|', '^', '&', '~',
  ':', '[', ']', '{', '}', '.',
];

const KEYWORDS = new Set(['and', 'or', 'not', 'if', 'else', 'in', 'is', 'lambda']);

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    // number literal
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j])) j++;
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/\d/.test(src[k] || '')) {
          j = k;
          while (j < src.length && /\d/.test(src[j])) j++;
        }
      }
      const text = src.slice(i, j);
      if ((text.match(/\./g) || []).length > 1) throw new SyntaxErr();
      toks.push({ t: 'num', v: parseFloat(text) });
      i = j;
      continue;
    }

    // string literal
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      if (j >= src.length) throw new SyntaxErr();
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }

    // name or keyword
    if (NAME_START.test(c)) {
      let j = i;
      while (j < src.length && NAME_PART.test(src[j])) j++;
      const text = src.slice(i, j);
      toks.push({ t: KEYWORDS.has(text) ? text : 'name', v: text });
      i = j;
      continue;
    }

    // punctuation, longest match first
    const p = PUNCT.find((s) => src.startsWith(s, i));
    if (!p) throw new SyntaxErr();
    toks.push({ t: p });
    i += p.length;
  }
  toks.push({ t: 'eof' });
  return toks;
}

// ── parser → AST ─────────────────────────────────────────────────────────────
//
// Precedence, lowest first:  ternary · or · and · not · comparison
//                            · bitwise (rejected) · + - · * / // %
//                            · unary + - · ** · call · atom

// Bitwise operators parse but are rejected at eval time, exactly as Act 3's
// visit_BinOp rejects them (they are absent from its _BINOPS table).
const BITOPS = { '|': 'BitOr', '^': 'BitXor', '&': 'BitAnd', '<<': 'LShift', '>>': 'RShift' };
const CMP = ['==', '!=', '<', '<=', '>', '>='];

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const at = (t) => toks[p].t === t;
  const eat = (t) => { if (!at(t)) throw new SyntaxErr(); return toks[p++]; };

  function ternary() {
    const body = orExpr();
    if (at('if')) {
      p++;
      const test = orExpr();
      eat('else');
      const orelse = ternary();
      return { k: 'IfExp', body, test, orelse };
    }
    return body;
  }

  function orExpr() {
    let n = andExpr();
    if (at('or')) {
      const values = [n];
      while (at('or')) { p++; values.push(andExpr()); }
      n = { k: 'BoolOp', op: 'or', values };
    }
    return n;
  }

  function andExpr() {
    let n = notExpr();
    if (at('and')) {
      const values = [n];
      while (at('and')) { p++; values.push(notExpr()); }
      n = { k: 'BoolOp', op: 'and', values };
    }
    return n;
  }

  function notExpr() {
    if (at('not')) { p++; return { k: 'Not', operand: notExpr() }; }
    return comparison();
  }

  // `is` and `in` are accepted here only so they become Compare operators, as
  // Python parses them. Act 3 evaluates the right-hand operand *before*
  // checking the operator, so `1 in [1]` reports the List as invalid rather
  // than the `in`; keeping them in the ops list preserves that order.
  function comparison() {
    const left = bitwise();
    const ops = [];
    const comparators = [];
    while (CMP.includes(peek().t) || at('is') || at('in')) {
      ops.push(toks[p++].t);
      comparators.push(bitwise());
    }
    if (!ops.length) return left;
    return { k: 'Compare', left, ops, comparators };
  }

  function bitwise() {
    let n = additive();
    while (BITOPS[peek().t]) {
      const name = BITOPS[toks[p++].t];
      n = { k: 'BadBinOp', name, left: n, right: additive() };
    }
    return n;
  }

  function additive() {
    let n = multiplicative();
    while (at('+') || at('-')) {
      const op = toks[p++].t;
      n = { k: 'BinOp', op, left: n, right: multiplicative() };
    }
    return n;
  }

  function multiplicative() {
    let n = unary();
    while (at('*') || at('/') || at('//') || at('%')) {
      const op = toks[p++].t;
      n = { k: 'BinOp', op, left: n, right: unary() };
    }
    return n;
  }

  function unary() {
    if (at('-')) { p++; return { k: 'USub', operand: unary() }; }
    if (at('+')) { p++; return { k: 'UAdd', operand: unary() }; }
    if (at('~')) { p++; return { k: 'BadUnary', operand: unary() }; }
    return power();
  }

  // ** binds tighter than unary minus on its left but allows one on its right,
  // so -2 ** 2 === -4 and 2 ** -1 === 0.5, as in Python.
  function power() {
    const base = postfix();
    if (at('**')) { p++; return { k: 'BinOp', op: '**', left: base, right: unary() }; }
    return base;
  }

  function postfix() {
    let n = atom();
    for (;;) {
      if (at('(')) {
        p++;
        const args = [];
        if (!at(')')) {
          args.push(ternary());
          while (at(',')) { p++; if (at(')')) break; args.push(ternary()); }
        }
        eat(')');
        n = { k: 'Call', func: n, args };
      } else if (at('.')) {
        throw new PyError('Недопустимое выражение: Attribute');
      } else if (at('[')) {
        throw new PyError('Недопустимое выражение: Subscript');
      } else break;
    }
    return n;
  }

  function atom() {
    if (at('num') || at('str')) return { k: 'Const', v: toks[p++].v };
    if (at('name')) return { k: 'Name', id: toks[p++].v };
    if (at('(')) { p++; const n = ternary(); eat(')'); return n; }
    if (at('lambda')) throw new PyError('Недопустимое выражение: Lambda');
    if (at('[')) throw new PyError('Недопустимое выражение: List');
    if (at('{')) throw new PyError('Недопустимое выражение: Dict');
    if (at(')')) throw new PyError("unmatched ')' (<unknown>, line 1)");
    throw new SyntaxErr();
  }

  const tree = ternary();
  if (!at('eof')) throw new SyntaxErr();
  return tree;
}

// ── evaluator ────────────────────────────────────────────────────────────────

/** Python refuses arithmetic between str and number; surface the same error. */
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new PyError(
    'unsupported operand type(s) for arithmetic: ' + quote(typeName(v)));
}

function pyAdd(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a + b;   // concatenation
  if (typeof a === 'string') {
    throw new PyError('can only concatenate str (not "' + typeName(b) + '") to str');
  }
  if (typeof b === 'string') {
    throw new PyError(
      'unsupported operand type(s) for +: '
      + quote(typeName(a)) + ' and ' + quote(typeName(b)));
  }
  return num(a) + num(b);
}

function pyMul(a, b) {
  if (typeof a === 'string') return a.repeat(Math.max(0, pyInt(b)));  // "ab" * 3
  if (typeof b === 'string') return b.repeat(Math.max(0, pyInt(a)));
  return num(a) * num(b);
}

function evalNode(n, ns) {
  switch (n.k) {
    case 'Const':
      return n.v;

    case 'Name':
      if (Object.prototype.hasOwnProperty.call(ns, n.id)) return ns[n.id];
      throw new PyError('Неизвестное поле или функция: ' + quote(n.id));

    case 'BinOp': {
      const a = evalNode(n.left, ns);
      const b = evalNode(n.right, ns);
      switch (n.op) {
        case '+': return pyAdd(a, b);
        case '-': return num(a) - num(b);
        case '*': return pyMul(a, b);
        case '/': return num(b) !== 0 ? num(a) / num(b) : 0;
        case '//': return num(b) !== 0 ? Math.floor(num(a) / num(b)) : 0;
        case '%': return num(b) !== 0 ? pyMod(num(a), num(b)) : 0;
        case '**': return Math.pow(num(a), num(b));
        default: throw new PyError('Неподдерживаемый оператор: ' + n.op);
      }
    }

    case 'BadBinOp':
      // Reached for | ^ & << >> — absent from Act 3's operator table.
      evalNode(n.left, ns);
      evalNode(n.right, ns);
      throw new PyError('Неподдерживаемый оператор: ' + n.name);

    case 'USub': return -num(evalNode(n.operand, ns));
    case 'UAdd': return +num(evalNode(n.operand, ns));

    case 'BadUnary':
    case 'Not':
      // `not x` is UnaryOp(Not) in Python, which Act 3's visit_UnaryOp rejects.
      evalNode(n.operand, ns);
      throw new PyError('Неподдерживаемый унарный оператор');

    case 'Compare': {
      let left = evalNode(n.left, ns);
      for (let i = 0; i < n.ops.length; i++) {
        const right = evalNode(n.comparators[i], ns);
        if (!pyCompare(n.ops[i], left, right)) return false;
        left = right;
      }
      return true;
    }

    case 'IfExp':
      return pyTruthy(evalNode(n.test, ns))
        ? evalNode(n.body, ns)
        : evalNode(n.orelse, ns);

    case 'Call': {
      if (n.func.k !== 'Name') throw new PyError('Допускаются только прямые вызовы функций');
      const fn = ns[n.func.id];
      if (typeof fn !== 'function') {
        throw new PyError('Неизвестная функция: ' + quote(n.func.id));
      }
      return fn(...n.args.map((a) => evalNode(a, ns)));
    }

    case 'BoolOp': {
      if (n.op === 'and') {
        for (const v of n.values) if (!pyTruthy(evalNode(v, ns))) return false;
        return true;
      }
      for (const v of n.values) if (pyTruthy(evalNode(v, ns))) return true;
      return false;
    }

    default:
      throw new PyError('Недопустимое выражение: ' + n.k);
  }
}

// ── public API ───────────────────────────────────────────────────────────────

export class FormulaParser {
  /** Returns the display string, or "#ERR: …" — never throws. */
  evaluate(formula, fieldValues) {
    const src = String(formula == null ? '' : formula).trim();
    if (!src) return '';
    try {
      if (src.includes('{') && src.includes('}')) {
        return this._evalTemplate(src, fieldValues);
      }
      return FormulaParser.fmt(this._evalExpr(src, fieldValues));
    } catch (exc) {
      return '#ERR: ' + exc.message;
    }
  }

  /**
   * Build the evaluation namespace and the field-name → identifier map.
   *
   * Act 3's sanitising regex is literally `r"\\W+"` — an escaped backslash —
   * so it matches the two characters "\W" and never fires on a real field
   * name. Names therefore reach the parser verbatim, with only leading and
   * trailing underscores stripped. That is reproduced here rather than
   * "fixed": every field name in the shipped template and in real sheets is
   * already a valid identifier, so both readings agree on all real data, and
   * a formula that errors out in Act 3 must keep erroring out here.
   */
  _buildNamespace(fieldValues) {
    const ns = Object.assign({}, SAFE_FUNCS, SAFE_CONSTS);
    const nameMap = new Map();
    let anon = 0;
    for (const [rawName, rawValue] of Object.entries(fieldValues || {})) {
      let safe = String(rawName).replace(/^_+|_+$/g, '') || 'f_' + (++anon);
      if (safe in SAFE_FUNCS || safe in SAFE_CONSTS) safe = 'field_' + safe;
      nameMap.set(rawName, safe);
      const s = String(rawValue == null ? '' : rawValue);
      let val;
      if (s.trim() === '') val = 0.0;
      else {
        try { val = pyFloat(s); } catch (e) { val = s; }
      }
      ns[safe] = val;
    }
    return { ns, nameMap };
  }

  /** Plain string replace, longest original name first, as in Act 3. */
  _substitute(expr, nameMap) {
    const originals = [...nameMap.keys()].sort((a, b) => b.length - a.length);
    for (const original of originals) {
      const safe = nameMap.get(original);
      if (original !== safe && expr.includes(original)) {
        expr = expr.split(original).join(safe);
      }
    }
    return expr;
  }

  _evalExpr(expr, fieldValues) {
    const { ns, nameMap } = this._buildNamespace(fieldValues);
    return evalNode(parse(this._substitute(expr, nameMap)), ns);
  }

  /**
   * Each {...} block is evaluated independently: a failing block inlines
   * "#ERR:<msg>" (no space — the bare-expression path uses "#ERR: " with one)
   * while the rest of the template still renders.
   */
  _evalTemplate(template, fieldValues) {
    const { ns, nameMap } = this._buildNamespace(fieldValues);
    return template.replace(/\{([^}]+)\}/g, (_m, expr) => {
      try {
        return FormulaParser.fmt(evalNode(parse(this._substitute(expr, nameMap)), ns));
      } catch (e) {
        return '#ERR:' + e.message;
      }
    });
  }

  static fmt(val) {
    if (typeof val === 'boolean') return val ? 'Да' : 'Нет';
    if (typeof val === 'number') return String(val);
    if (val === null || val === undefined) return 'None';
    return String(val);
  }
}

/** Returns null when the formula is valid, else a Russian error message. */
export function validateFormula(formula, dummyFields = null) {
  if (!String(formula == null ? '' : formula).trim()) return 'Формула не может быть пустой';
  try {
    const result = new FormulaParser().evaluate(formula, dummyFields || {});
    if (result.startsWith('#ERR:')) return result.slice(5);
    return null;
  } catch (e) {
    return String(e.message);
  }
}
