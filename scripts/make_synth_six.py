#!/usr/bin/env python3
"""Build the six-module long-session fixture and its two manifests.

All six middle-tier modules (scripts/eval_midtier.py) go into one project:
  test/    buggy modules, visible tests, AGENTS.md (the agent's checkout)
  full/    reference modules (used only to validate the fixture)
  judges/  held-out judges, run by eval_bugsjs.py as extra checks
and two manifests for scripts/eval_bugsjs.py:
  long-six.json   one task to fix all six, then one --resume follow-up
  chain-six.json  one module per turn: the first task, five --resume
                  follow-ups, then a final test-and-summarize follow-up

    python3 scripts/make_synth_six.py <dir>
    python3 scripts/eval_bugsjs.py --manifest <dir>/chain-six.json --out <results> \
        --label chain6 --budget 1800 --max-turns 60
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_midtier import TASKS  # noqa: E402

SUFFIX = ' Inspect the project instructions, fix the implementation, and run its tests.'
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
    assert text.endswith(SUFFIX), name
    return text[:-len(SUFFIX)]


def build(root):
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
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = Path(sys.argv[1]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    build(root)
    sys.exit(0 if validate(root) else 1)


if __name__ == '__main__':
    main()
