#!/usr/bin/env python3
"""Build the six-module long-session fixture and its two manifests.

With --eight, also add the TTL cache fix and the CSV parser feature
(scripts/eval_coding.py) as tasks (7) and (8) and write chain-eight.json:
eight tasks, one per turn, long enough that Claude Code compacts natively at
the launcher's default window.

All six middle-tier modules (scripts/eval_midtier.py) go into one project:
  test/    buggy modules, visible tests, AGENTS.md (the agent's checkout)
  full/    reference modules (used only to validate the fixture)
  judges/  held-out judges, run by eval_bugsjs.py as extra checks
and two manifests for scripts/eval_bugsjs.py:
  long-six.json   one task to fix all six, then one --resume follow-up
  chain-six.json  one module per turn: the first task, five --resume
                  follow-ups, then a final test-and-summarize follow-up

    python3 scripts/make_synth_six.py [--eight] <dir>
    python3 scripts/eval_bugsjs.py --manifest <dir>/chain-six.json --out <results> \
        --label chain6 --budget 1800 --max-turns 60
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_midtier import TASKS as MIDTIER  # noqa: E402
from eval_coding import SCENARIOS  # noqa: E402

# Reference solutions for the two eval_coding scenarios, used only to validate
# the fixture (the agent never sees full/).
REFERENCES = {
    'cache': '''export class TTLCache {
  constructor(now = Date.now) { this.now = now; this.entries = new Map(); }
  set(key, value, ttl) {
    this.entries.set(key, { value, expires: this.now() + ttl });
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expires) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
}
''',
    'csv': '''export function parseCSV(text) {
  if (text === '') return [];
  const rows = [];
  let row = [], field = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (ch === '\\r' && text[i + 1] === '\\n') continue;
    if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = ''; started = false; continue; }
    started = true;
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else field += ch;
  }
  if (quoted) throw new Error('Unclosed quoted field');
  if (started) { row.push(field); rows.push(row); }
  return rows;
}
''',
}
TASKS = dict(MIDTIER)

SUFFIXES = (' Inspect the project instructions, fix the implementation, and run its tests.',
            ' Inspect project instructions, implement the feature, and run tests.')
AGENTS = ('Keep the existing named exports. Add no dependencies. Do not modify package.json or *.test.mjs files. '
          'Run node --test before reporting completion.\n')
PACKAGE = '{"private":true,"type":"module","scripts":{"test":"node --test"}}\n'
JUDGE_HEADER = '''import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const MODULE_PATH = pathToFileURL(path.resolve(process.argv[2], "%s")).href;
'''
AFTER_EACH = ' Run node --test after the fix; tests for modules not fixed yet may still fail.'
FINAL = 'Run exactly: node --test. If anything fails, fix it and run it again, then summarize what changed in this session.'
LONG_FOLLOW_UP = 'Continue the same task. Run exactly: node --test. If anything fails, fix it and run it again, then summarize what changed.'


def issue(name):
    text = TASKS[name]['task']
    suffix = next(s for s in SUFFIXES if text.endswith(s))
    return text[:-len(suffix)]


def build(root, eight=False):
    if eight:
        for name in ('cache', 'csv'):
            TASKS[name] = {**SCENARIOS[name], 'reference': REFERENCES[name]}
    for variant, key in (('test', 'source'), ('full', 'reference')):
        project = root / variant
        (project / 'node_modules').mkdir(parents=True, exist_ok=True)
        (project / 'package.json').write_text(PACKAGE)
        (project / 'AGENTS.md').write_text(AGENTS)
        for spec in TASKS.values():
            (project / spec['module']).write_text(spec[key])
            (project / spec['module'].replace('.mjs', '.test.mjs')).write_text(spec['visible'])
    (root / 'judges').mkdir(exist_ok=True)
    for name, spec in TASKS.items():
        (root / 'judges' / f'{name}.mjs').write_text(
            JUDGE_HEADER % spec['module'] + spec['judge'].replace('import(MODULE)', 'import(MODULE_PATH)'))

    names = list(TASKS)
    issues = [f'({i}) {issue(name)}' for i, name in enumerate(names, 1)]
    case = {
        'group': 'dev-long', 'test_dir': str(root / 'test'), 'full_dir': str(root / 'full'),
        'cmd': ['node', '--test'], 'broader': ['node', '--test'], 'preserve': ['node', '--test'],
        'extra': [['node', str(root / 'judges' / f'{name}.mjs'), '{project}'] for name in names],
    }
    long_six = {'id': 'synth-six', **case, 'task': (
        'This project has six modules with bugs. Fix all six, one at a time, running node --test after each fix and '
        'again at the end. ' + ' '.join(issues) + ' Inspect the project instructions first.'),
        'resume_prompts': [LONG_FOLLOW_UP]}
    chain_six = {'id': 'chain-six', **case, 'task': (
        'This project has six modules with bugs. I will give you one at a time in this session. Inspect the project '
        'instructions first. Then fix this one: ' + issues[0] + AFTER_EACH),
        'resume_prompts': ['Next: ' + text + AFTER_EACH for text in issues[1:]] + [FINAL]}
    if eight:
        chain_eight = {'id': 'chain-eight', **case, 'task': (
            'This project has eight modules to fix or finish. I will give you one at a time in this session. Inspect '
            'the project instructions first. Then do this one: ' + issues[0] + AFTER_EACH),
            'resume_prompts': ['Next: ' + text + AFTER_EACH for text in issues[1:]] + [FINAL]}
        (root / 'chain-eight.json').write_text(json.dumps([chain_eight], indent=1) + '\n')
        return
    (root / 'long-six.json').write_text(json.dumps([long_six], indent=1) + '\n')
    (root / 'chain-six.json').write_text(json.dumps([chain_six], indent=1) + '\n')


def validate(root):
    """The buggy project fails its visible tests and every judge; the reference passes all of them."""
    ok = True
    for variant in ('test', 'full'):
        project = root / variant
        visible = subprocess.run(['node', '--test'], cwd=project, capture_output=True).returncode == 0
        judges = [subprocess.run(['node', str(judge), str(project)], capture_output=True).returncode == 0
                  for judge in sorted((root / 'judges').glob('*.mjs'))]
        print(variant, 'visible', visible, 'judges', sum(judges), 'of', len(judges))
        ok &= (visible and all(judges)) if variant == 'full' else (not visible and not any(judges))
    return ok


def main():
    args = sys.argv[1:]
    eight = '--eight' in args
    args = [a for a in args if a != '--eight']
    if len(args) != 1:
        sys.exit(__doc__)
    root = Path(args[0]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    build(root, eight)
    sys.exit(0 if validate(root) else 1)


if __name__ == '__main__':
    main()
