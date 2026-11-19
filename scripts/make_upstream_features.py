#!/usr/bin/env python3
"""Build feature tasks from real upstream ESLint commits (a large repository with its dependencies).

Each case is one upstream feature commit that changes several existing files under lib/ and adds no
dependency. The starting checkout is the parent commit plus the commit's own test changes (so the
new tests are visible, as in BugsJS); the reference is the commit itself. The task text is the
commit's subject and body plus the documentation it added. The target runs the commit's changed
test files; preservation runs the whole tests/lib suite and is scored against the fixed revision,
like the BugsJS cases. Only existing implementation files need changing.

    python3 scripts/make_upstream_features.py <eslint clone> <dir>
    python3 scripts/eval_bugsjs.py --manifest <dir>/features.json --out <results> --label feat --budget 900
"""
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

COMMITS = ['13ef1c72', 'c693be52', '673a58bc', '3f2b9087']
MOCHA = ['node_modules/.bin/_mocha', '--reporter', 'dot']


def git(repo, *args, binary=False):
    return subprocess.run(['git', '-C', str(repo), *args], capture_output=True, check=True,
                          text=not binary).stdout


def export(repo, rev, target):
    target.mkdir(parents=True)
    tarfile.open(fileobj=io.BytesIO(git(repo, 'archive', rev, binary=True))).extractall(target, filter='data')


def task_text(repo, commit):
    subject, _, body = git(repo, 'log', '-1', '--format=%B', commit).strip().partition('\n')
    docs = [line[1:] for line in git(repo, 'diff', commit + '~1', commit, '--', 'docs/').splitlines()
            if line.startswith('+') and not line.startswith('+++')]
    doc = '\n'.join(docs).strip()
    if len(doc) > 2500:
        doc = doc[:2500].rsplit('\n', 1)[0] + '\n[...]'
    text = f'Implement this ESLint change: "{subject}".'
    if body.strip():
        text += ' ' + ' '.join(body.split())
    if doc:
        text += '\n\nDocumentation written for it:\n' + doc
    return text


def reference_failures(full, target):
    out = subprocess.run(target, cwd=full, capture_output=True, text=True)
    text = re.sub(r'\x1b\[[0-9;]*m', '', out.stdout + out.stderr)
    return sorted({m.rstrip(':') for m in re.findall(r'^\s+\d+\) (.+)$', text, re.M)})


def build(repo, root):
    manifest = []
    for commit in COMMITS:
        case_id = 'feat-' + commit
        start, full = root / (case_id + '-test'), root / (case_id + '-full')
        changed = [line.split('\t') for line in git(repo, 'diff-tree', '--no-commit-id', '--name-status', '-r', commit).splitlines()]
        tests = [path for status, path in changed if path.startswith('tests/')]
        if not start.exists():
            export(repo, commit + '~1', start)
            for path in tests:  # the commit's own tests, visible from the start
                (start / path).parent.mkdir(parents=True, exist_ok=True)
                (start / path).write_bytes(git(repo, 'show', f'{commit}:{path}', binary=True))
            subprocess.run(['npm', 'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
                            '--legacy-peer-deps', '--loglevel', 'error'], cwd=start, check=True)
        if not full.exists():
            export(repo, commit, full)
            (full / 'node_modules').symlink_to(start / 'node_modules', target_is_directory=True)
        target = MOCHA + [p for p in tests if p.startswith('tests/lib/')]
        # Tests that fail on the reference itself under this Node version (error-message wording
        # changed since 2016-17) are excluded from the target by title and recorded; preservation
        # still runs the whole suite and is scored against the reference.
        broken = reference_failures(full, target)
        if broken:
            target = target + ['--grep', '|'.join(re.escape(title) for title in broken), '--invert']
        manifest.append({'id': case_id, 'group': 'feature-upstream', 'test_dir': str(start), 'full_dir': str(full),
                         'cmd': target, 'broader': target, 'preserve': MOCHA + ['--recursive', 'tests/lib'],
                         'excluded_from_target': broken, 'task': task_text(repo, commit)})
        print('built', case_id, 'implementation files:',
              [p for s, p in changed if not p.startswith(('tests/', 'docs/'))])
    (root / 'features.json').write_text(json.dumps(manifest, indent=1) + '\n')
    return manifest


def validate(manifest):
    ok = True
    for case in manifest:
        codes = {rev: subprocess.run(case['cmd'], cwd=case[rev], capture_output=True).returncode
                 for rev in ('test_dir', 'full_dir')}
        print(case['id'], 'target on start', codes['test_dir'], 'on reference', codes['full_dir'])
        ok &= codes['test_dir'] != 0 and codes['full_dir'] == 0
    return ok


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    root = Path(sys.argv[2]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    sys.exit(0 if validate(build(Path(sys.argv[1]).resolve(), root)) else 1)


if __name__ == '__main__':
    main()
