#!/usr/bin/env python3
"""Build tasks whose named test command is filtered by test name (like Express 23).

The task names a command that runs only the target tests (node --test-name-pattern). The same
file has neighbouring tests that the obvious quick fix breaks. Scoring runs the whole file
(parity and preservation against the reference) plus a held-out judge. Validation checks that
the start fails the target, the reference passes everything, and the quick fix ("naive") passes
the filtered command but fails the whole file, so a session that verifies only with the filtered
command can be fooled.

    python3 scripts/make_neighbour.py <dir>
    python3 scripts/eval_bugsjs.py --manifest <dir>/neighbour.json --out <results> --label <label>
"""
import json
import subprocess
import sys
from pathlib import Path

ROUTER_START = '''// A minimal middleware router.
export class Router {
  constructor() {
    this.stack = [];
  }

  // Register middleware functions; handle() runs them in order.
  use(...handlers) {
    if (handlers.length === 0) {
      throw new TypeError('Router.use() requires a middleware function');
    }
    for (const fn of handlers) {
      if (typeof fn !== 'function') {
        throw new TypeError('Router.use() requires a middleware function but got a ' + typeOf(fn));
      }
      this.stack.push(fn);
    }
    return this;
  }

  handle(req) {
    for (const fn of this.stack) fn(req);
    return req;
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
'''

ROUTER_REFERENCE = ROUTER_START.replace('''  use(...handlers) {
    if (handlers.length === 0) {
      throw new TypeError('Router.use() requires a middleware function');
    }
    for (const fn of handlers) {''', '''  use(...handlers) {
    const fns = handlers.flat(Infinity);
    if (fns.length === 0) {
      throw new TypeError('Router.use() requires a middleware function');
    }
    for (const fn of fns) {''')

ROUTER_NAIVE = ROUTER_START.replace('''    for (const fn of handlers) {
      if (typeof fn''', '''    for (const fn of handlers) {
      if (Array.isArray(fn)) {
        this.stack.push(...fn.flat(Infinity));
        continue;
      }
      if (typeof fn''')

ROUTER_TESTS = '''import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from './lib/router.mjs';

const tracer = () => {
  const seen = [];
  const mw = name => req => { seen.push(name); };
  return { seen, mw };
};

test('use accepts arrays of middleware', () => {
  const { seen, mw } = tracer();
  new Router().use([mw('a'), mw('b')]).handle({});
  assert.deepEqual(seen, ['a', 'b']);
});

test('use accepts nested arrays of middleware mixed with functions', () => {
  const { seen, mw } = tracer();
  new Router().use([mw('a'), [mw('b'), mw('c')]], mw('d')).handle({});
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
});

test('use rejects a call with no middleware', () => {
  assert.throws(() => new Router().use(), /requires a middleware function/);
  assert.throws(() => new Router().use([]), /requires a middleware function/);
});

test('use rejects values that are not functions', () => {
  assert.throws(() => new Router().use('x'), /got a string/);
  assert.throws(() => new Router().use([() => {}, 42]), /got a number/);
});

test('use returns the router for chaining', () => {
  const router = new Router();
  assert.equal(router.use(() => {}), router);
});
'''

ROUTER_JUDGE = '''const { Router } = await mod('lib/router.mjs');
const seen = [];
new Router().use([[[() => seen.push(1)]]], [() => seen.push(2)]).handle({});
check('deeply nested arrays', seen.join() === '1,2');
let message = '';
try { new Router().use([() => {}, [null]]); } catch (e) { message = e.message; }
check('null inside a nested array is rejected', /got a null/.test(message));
message = '';
try { new Router().use([[]], []); } catch (e) { message = e.message; }
check('only empty arrays is rejected', /requires a middleware function/.test(message));'''

FLAGS_START = '''// Parse command-line flags against a spec such as {color: 'boolean', name: 'string'}.
// Returns {flags, rest}: flag values by name, and the other arguments in order.
export function parseFlags(argv, spec) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    const kind = spec[name];
    if (!kind) throw new Error('unknown flag --' + name);
    if (kind === 'boolean') {
      if (inline !== undefined) throw new Error('--' + name + ' takes no value');
      flags[name] = true;
    } else {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error('--' + name + ' needs a value');
      flags[name] = value;
    }
  }
  return { flags, rest };
}
'''

FLAGS_REFERENCE = FLAGS_START.replace('''    const kind = spec[name];
    if (!kind) throw new Error('unknown flag --' + name);''', '''    if (!spec[name] && name.startsWith('no-') && spec[name.slice(3)] === 'boolean') {
      if (inline !== undefined) throw new Error('--' + name + ' takes no value');
      flags[name.slice(3)] = false;
      continue;
    }
    const kind = spec[name];
    if (!kind) throw new Error('unknown flag --' + name);''')

FLAGS_NAIVE = FLAGS_START.replace('''    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }''', '''    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    if (arg.startsWith('--no')) {
      flags[arg.slice(5)] = false;
      continue;
    }''')

FLAGS_TESTS = '''import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from './lib/flags.mjs';

const spec = { color: 'boolean', notify: 'boolean', name: 'string' };

test('negated boolean flags are false', () => {
  assert.deepEqual(parseFlags(['--no-color', 'a.txt'], spec), { flags: { color: false }, rest: ['a.txt'] });
});

test('the later of a flag and its negation wins', () => {
  assert.deepEqual(parseFlags(['--color', '--no-color'], spec).flags, { color: false });
  assert.deepEqual(parseFlags(['--no-color', '--color'], spec).flags, { color: true });
});

test('flags whose names start with no stay ordinary flags', () => {
  assert.deepEqual(parseFlags(['--notify'], spec).flags, { notify: true });
});

test('unknown flags throw', () => {
  assert.throws(() => parseFlags(['--bogus'], spec), /unknown flag --bogus/);
  assert.throws(() => parseFlags(['--no-bogus'], spec), /unknown flag --no-bogus/);
});

test('string flags take the next argument, whatever it looks like', () => {
  assert.deepEqual(parseFlags(['--name', '--no-color'], spec).flags, { name: '--no-color' });
  assert.deepEqual(parseFlags(['--name=x'], spec).flags, { name: 'x' });
});
'''

FLAGS_JUDGE = '''const { parseFlags } = await mod('lib/flags.mjs');
const spec = { color: 'boolean', name: 'string' };
let message = '';
try { parseFlags(['--no-name'], spec); } catch (e) { message = e.message; }
check('only boolean flags negate', /unknown flag --no-name/.test(message));
message = '';
try { parseFlags(['--no-color=yes'], spec); } catch (e) { message = e.message; }
check('a negated flag takes no value', /takes no value/.test(message));
check('rest keeps order', parseFlags(['a', '--no-color', 'b'], spec).rest.join() === 'a,b');'''

TASKS = {
    'router': {
        'files': {'lib/router.mjs': (ROUTER_START, ROUTER_REFERENCE, ROUTER_NAIVE)},
        'tests': {'router.test.mjs': ROUTER_TESTS},
        'judge': ROUTER_JUDGE,
        'cmd': ['node', '--test', '--test-name-pattern', 'accepts', 'router.test.mjs'],
        'whole': ['node', '--test', 'router.test.mjs'],
        'task': 'Router.use() should accept arrays of middleware functions, including nested arrays, '
                'mixed with plain functions: use([a, b], c) registers a, b and then c, in that order.',
    },
    'flags': {
        'files': {'lib/flags.mjs': (FLAGS_START, FLAGS_REFERENCE, FLAGS_NAIVE)},
        'tests': {'flags.test.mjs': FLAGS_TESTS},
        'judge': FLAGS_JUDGE,
        'cmd': ['node', '--test', '--test-name-pattern', 'negat', 'flags.test.mjs'],
        'whole': ['node', '--test', 'flags.test.mjs'],
        'task': 'parseFlags should support negated boolean flags: --no-color sets color to false. '
                'When a flag and its negation both appear, the later one wins.',
    },
}

PACKAGE = '{"name": "%s", "private": true, "type": "module"}\n'
AGENTS = 'Keep the exported names. Add no dependencies. Do not modify package.json or the supplied *.test.mjs files.\n'
JUDGE = '''// Held-out judge. Usage: node <this file> <project>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const project = process.argv[2];
const mod = file => import(pathToFileURL(join(project, file)).href + '?' + Math.random());
let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.log('FAIL', name); } };
try {
%s
} catch (e) { failed++; console.log('FAIL error', e && e.message); }
console.log(failed ? `${failed} checks failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
'''


def build(root):
    (root / 'judges').mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, spec in TASKS.items():
        for index, variant in enumerate(('test', 'full', 'naive')):
            project = root / name / variant
            (project / 'node_modules').mkdir(parents=True, exist_ok=True)
            (project / 'package.json').write_text(PACKAGE % name)
            (project / 'AGENTS.md').write_text(AGENTS)
            for path, versions in spec['files'].items():
                (project / path).parent.mkdir(parents=True, exist_ok=True)
                (project / path).write_text(versions[index])
            for path, text in spec['tests'].items():
                (project / path).write_text(text)
        judge = root / 'judges' / (name + '.mjs')
        judge.write_text(JUDGE % '\n'.join('  ' + line if line else '' for line in spec['judge'].split('\n')))
        manifest.append({'id': 'neighbour-' + name, 'group': 'neighbour', 'test_dir': str(root / name / 'test'),
                         'full_dir': str(root / name / 'full'), 'cmd': spec['cmd'], 'broader': spec['whole'],
                         'preserve': spec['whole'], 'extra': [['node', str(judge), '{project}']], 'task': spec['task']})
    (root / 'neighbour.json').write_text(json.dumps(manifest, indent=1) + '\n')
    return manifest


def validate(manifest):
    ok = True
    want = {'test': (False, False, False), 'full': (True, True, True), 'naive': (True, False, None)}
    for case in manifest:
        for variant, expected in want.items():
            project = str(Path(case['test_dir']).parent / variant)
            run = lambda cmd: subprocess.run(cmd, cwd=project, capture_output=True).returncode == 0
            got = (run(case['cmd']), run(case['broader']), run([p.replace('{project}', project) for p in case['extra'][0]]))
            print(case['id'], variant, 'filtered', got[0], 'whole file', got[1], 'judge', got[2])
            ok &= all(e is None or e == g for e, g in zip(expected, got))
    return ok


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = Path(sys.argv[1]).resolve()
    sys.exit(0 if validate(build(root)) else 1)


if __name__ == '__main__':
    main()
