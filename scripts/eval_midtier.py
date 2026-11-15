#!/usr/bin/env python3
"""Middle-tier live exercises: small, realistic bug fixes in self-contained modules.

Each task is an existing module with one or two bugs, visible tests that fail,
and a held-out judge with further edge cases. Runs through the normal launcher
with scripts/eval_coding.py (same pass criteria: visible and held-out pass,
only the implementation changed, a passing `node --test` after the last edit).
Reference fixes are used only by --validate to check each task; the model never
sees them.
"""
import argparse
import time
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_coding as ec  # noqa: E402

TASKS = {
    'roman': {
        'task': 'toRoman returns wrong numerals for some numbers in the 400s and 900s (for example 400 and 944). Fix toRoman so it returns standard Roman numerals for 1 to 3999, and keep fromRoman working. Inspect the project instructions, fix the implementation, and run its tests.',
        'module': 'roman.mjs',
        'source': '''const TABLE = [[1000, 'M'], [500, 'D'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];

export function toRoman(n) {
  let out = '';
  for (const [value, symbol] of TABLE) {
    while (n >= value) { out += symbol; n -= value; }
  }
  return out;
}

export function fromRoman(text) {
  const values = {I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000};
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const current = values[text[i]];
    const next = values[text[i + 1]] ?? 0;
    total += current < next ? -current : current;
  }
  return total;
}
''',
        'reference': '''const TABLE = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function toRoman(n) { let out = ''; for (const [v, s] of TABLE) { while (n >= v) { out += s; n -= v; } } return out; }
export function fromRoman(text) { const values = {I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000}; let t = 0;
  for (let i = 0; i < text.length; i++) { const c = values[text[i]], n = values[text[i + 1]] ?? 0; t += c < n ? -c : c; } return t; }
''',
        'visible': '''import test from 'node:test';
import assert from 'node:assert/strict';
import { toRoman, fromRoman } from './roman.mjs';
test('basic numerals', () => assert.equal(toRoman(1994), 'MCMXCIV'));
test('four hundreds', () => assert.equal(toRoman(400), 'CD'));
test('round trip', () => assert.equal(fromRoman(toRoman(2024)), 2024));
''',
        'judge': '''const {toRoman, fromRoman} = await import(MODULE);
for (const [n, r] of [[3999, 'MMMCMXCIX'], [944, 'CMXLIV'], [444, 'CDXLIV'], [9, 'IX'], [1, 'I'], [900, 'CM']]) {
  assert.equal(toRoman(n), r); assert.equal(fromRoman(r), n);
}
for (let n = 1; n <= 3999; n += 37) assert.equal(fromRoman(toRoman(n)), n);
''',
    },
    'semver': {
        'task': 'compareVersions orders versions incorrectly: 1.10.0 sorts before 1.9.0, and a prerelease such as 2.0.0-beta should come before 2.0.0. Fix compareVersions so it returns a negative number, zero, or a positive number by semantic-version precedence. Inspect the project instructions, fix the implementation, and run its tests.',
        'module': 'semver.mjs',
        'source': '''export function compareVersions(a, b) {
  const [coreA] = a.split('-');
  const [coreB] = b.split('-');
  const partsA = coreA.split('.');
  const partsB = coreB.split('.');
  for (let i = 0; i < 3; i++) {
    if (partsA[i] < partsB[i]) return -1;
    if (partsA[i] > partsB[i]) return 1;
  }
  return 0;
}
''',
        'reference': '''export function compareVersions(a, b) {
  const [coreA, preA] = a.split('-'); const [coreB, preB] = b.split('-');
  const pa = coreA.split('.').map(Number), pb = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1; if (preB === undefined) return -1;
  const xa = preA.split('.'), xb = preB.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1; if (xb[i] === undefined) return 1;
    const na = /^\\d+$/.test(xa[i]), nb = /^\\d+$/.test(xb[i]);
    if (na && nb) { const d = Number(xa[i]) - Number(xb[i]); if (d) return d < 0 ? -1 : 1; continue; }
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}
''',
        'visible': '''import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from './semver.mjs';
test('numeric parts', () => assert.ok(compareVersions('1.10.0', '1.9.0') > 0));
test('equal', () => assert.equal(compareVersions('2.1.3', '2.1.3'), 0));
test('prerelease before release', () => assert.ok(compareVersions('2.0.0-beta', '2.0.0') < 0));
''',
        'judge': '''const {compareVersions} = await import(MODULE);
const sign = x => Math.sign(x);
assert.equal(sign(compareVersions('0.0.10', '0.0.9')), 1);
assert.equal(sign(compareVersions('10.0.0', '9.99.99')), 1);
assert.equal(sign(compareVersions('1.0.0', '1.0.0-rc.1')), 1);
assert.equal(sign(compareVersions('1.0.0-alpha', '1.0.0-beta')), -1);
assert.equal(sign(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')), -1);
assert.equal(sign(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')), -1);
assert.equal(compareVersions('3.4.5', '3.4.5'), 0);
''',
    },
    'lru': {
        'task': 'LRUCache evicts the wrong entry: reading a key with get should make it most recently used, and the cache should hold exactly capacity entries before evicting. Fix the implementation without changing its API. Inspect the project instructions, fix the implementation, and run its tests.',
        'module': 'lru.mjs',
        'source': '''export class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    return this.map.get(key);
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  get size() {
    return this.map.size;
  }
}
''',
        'reference': '''export class LRUCache {
  constructor(capacity) { this.capacity = capacity; this.map = new Map(); }
  get(key) { if (!this.map.has(key)) return undefined; const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return v; }
  set(key, value) { this.map.delete(key); this.map.set(key, value); if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value); }
  get size() { return this.map.size; }
}
''',
        'visible': '''import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from './lru.mjs';
test('holds capacity entries', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); assert.equal(c.size, 2); assert.equal(c.get('a'), 1); });
test('get refreshes recency', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 1); });
''',
        'judge': '''const {LRUCache} = await import(MODULE);
const c = new LRUCache(3);
c.set('a', 1); c.set('b', 2); c.set('c', 3); c.set('a', 10); c.set('d', 4);
assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 10); assert.equal(c.size, 3);
const z = new LRUCache(1); z.set('x', 0); assert.equal(z.get('x'), 0); z.set('y', false); assert.equal(z.get('x'), undefined); assert.equal(z.get('y'), false);
assert.equal(new LRUCache(2).get('missing'), undefined);
''',
    },
    'deepmerge': {
        'task': 'deepMerge changes its inputs and loses nested keys: merging {a: {x: 1}} with {a: {y: 2}} should give {a: {x: 1, y: 2}} without modifying either argument. Arrays from the second object replace arrays from the first. Fix deepMerge. Inspect the project instructions, fix the implementation, and run its tests.',
        'module': 'merge.mjs',
        'source': '''export function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    target[key] = source[key];
  }
  return target;
}
''',
        'reference': '''const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(target, source) {
  const out = {...target};
  for (const key of Object.keys(source)) {
    out[key] = plain(out[key]) && plain(source[key]) ? deepMerge(out[key], source[key]) : (Array.isArray(source[key]) ? [...source[key]] : source[key]);
  }
  return out;
}
''',
        'visible': '''import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from './merge.mjs';
test('nested keys merge', () => assert.deepEqual(deepMerge({a: {x: 1}}, {a: {y: 2}}), {a: {x: 1, y: 2}}));
test('inputs unchanged', () => { const t = {a: {x: 1}}; deepMerge(t, {a: {y: 2}, b: 3}); assert.deepEqual(t, {a: {x: 1}}); });
''',
        'judge': '''const {deepMerge} = await import(MODULE);
assert.deepEqual(deepMerge({a: [1, 2]}, {a: [3]}), {a: [3]});
const s = {deep: {list: [1]}}; const before = JSON.stringify(s); deepMerge({deep: {k: 1}}, s); assert.equal(JSON.stringify(s), before);
assert.deepEqual(deepMerge({a: {b: {c: 1, d: 2}}}, {a: {b: {d: 3}}}), {a: {b: {c: 1, d: 3}}});
assert.deepEqual(deepMerge({a: 1}, {a: null}), {a: null});
assert.deepEqual(deepMerge({a: {x: 1}}, {a: 5}), {a: 5});
''',
    },
    'wordwrap': {
        'task': 'wrap(text, width) should break text into lines of at most width characters at spaces, without trailing spaces, keeping a single word longer than width on its own line. It currently leaves trailing spaces and can produce empty lines. Fix wrap. Inspect the project instructions, fix the implementation, and run its tests.',
        'module': 'wrap.mjs',
        'source': '''export function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line.length + word.length > width) {
      lines.push(line);
      line = '';
    }
    line += word + ' ';
  }
  lines.push(line);
  return lines.join('\\n');
}
''',
        'reference': '''export function wrap(text, width) {
  const lines = []; let line = '';
  for (const word of text.split(/\\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) lines.push(line);
  return lines.join('\\n');
}
''',
        'visible': '''import test from 'node:test';
import assert from 'node:assert/strict';
import { wrap } from './wrap.mjs';
test('breaks at spaces', () => assert.equal(wrap('the quick brown fox', 10), 'the quick\\nbrown fox'));
test('long word alone', () => assert.equal(wrap('a extraordinarily b', 5), 'a\\nextraordinarily\\nb'));
''',
        'judge': '''const {wrap} = await import(MODULE);
assert.equal(wrap('one two three', 13), 'one two three');
assert.equal(wrap('one two three', 7), 'one two\\nthree');
assert.equal(wrap('', 5), '');
assert.equal(wrap('abc', 3), 'abc');
for (const line of wrap('lorem ipsum dolor sit amet consectetur adipiscing', 12).split('\\n')) {
  assert.ok(line.length <= 12 || !line.includes(' ')); assert.equal(line, line.trim());
}
''',
    },
    'intervals': {
        'task': 'mergeIntervals should merge overlapping or touching [start, end] intervals given in any order and return them sorted by start. It currently assumes sorted input and does not merge touching intervals such as [1, 2] and [2, 3]. Fix mergeIntervals without modifying its input. Inspect the project instructions, fix the implementation, and run its tests.',
        'module': 'intervals.mjs',
        'source': '''export function mergeIntervals(intervals) {
  const out = [];
  for (const [start, end] of intervals) {
    const last = out[out.length - 1];
    if (last && start < last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}
''',
        'reference': '''export function mergeIntervals(intervals) {
  const sorted = intervals.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]); const out = [];
  for (const [s, e] of sorted) { const last = out[out.length - 1]; if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]); }
  return out;
}
''',
        'visible': '''import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeIntervals } from './intervals.mjs';
test('unsorted input', () => assert.deepEqual(mergeIntervals([[5, 6], [1, 3], [2, 4]]), [[1, 4], [5, 6]]));
test('touching intervals', () => assert.deepEqual(mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]));
''',
        'judge': '''const {mergeIntervals} = await import(MODULE);
const input = [[3, 4], [1, 2]]; mergeIntervals(input); assert.deepEqual(input, [[3, 4], [1, 2]]);
assert.deepEqual(mergeIntervals([]), []);
assert.deepEqual(mergeIntervals([[1, 10], [2, 3], [4, 5]]), [[1, 10]]);
assert.deepEqual(mergeIntervals([[10, 12], [-5, -1], [-1, 0]]), [[-5, 0], [10, 12]]);
assert.deepEqual(mergeIntervals([[1, 5], [1, 2]]), [[1, 5]]);
''',
    },
}


def validate():
    """Buggy source must fail visible or held-out checks; the reference must pass both."""
    ok = True
    for name, spec in TASKS.items():
        for variant in ('source', 'reference'):
            with tempfile.TemporaryDirectory() as tmp:
                project = Path(tmp)
                (project / 'package.json').write_text('{"private":true,"type":"module"}\n')
                (project / 'behavior.test.mjs').write_text(spec['visible'])
                (project / spec['module']).write_text(spec[variant])
                result = ec.run_test(project, spec)
                good = result['visible'] and result['held_out']
                print(name, variant, 'visible', result['visible'], 'held_out', result['held_out'])
                ok &= good if variant == 'reference' else not result['visible']
    return ok


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--validate', action='store_true')
    parser.add_argument('--tasks', nargs='+', choices=list(TASKS), default=list(TASKS))
    parser.add_argument('--repeat', type=int, default=1)
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--pause', type=int, default=0, help='seconds to wait after each task (pacing)')
    args = parser.parse_args()
    if args.validate:
        sys.exit(0 if validate() else 1)
    args.output.mkdir(parents=True, exist_ok=True)
    for k in range(1, args.repeat + 1):
        out = args.output / f'r{k}'
        out.mkdir(exist_ok=True)
        for name in args.tasks:
            if (out / f'compact-{name}.json').exists():
                continue
            spec = {key: value for key, value in TASKS[name].items() if key != 'reference'}
            ec.exercise(name, 'compact', args.timeout, out, 'Read,Edit,Write,Glob,Grep,Bash', spec=spec)
            time.sleep(args.pause)


if __name__ == '__main__':
    main()
