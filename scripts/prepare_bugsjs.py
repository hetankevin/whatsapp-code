#!/usr/bin/env python3
"""Prepare BugsJS fixtures and a case manifest for eval_bugsjs.py.

Input: a JSON list of cases, for example
  {"id": "express-11", "repo": "express", "bug": 11,
   "tests": ["test/res.send.js"], "grep": null,
   "preserve": ["test/", "test/acceptance/"]}
Repositories come from https://github.com/BugsJS/<repo>. Each case gets the
Bug-N-test tag (buggy source with the upstream regression tests) and the
Bug-N-full tag (upstream fix), dependencies installed with
`npm install --ignore-scripts --no-package-lock --legacy-peer-deps` (these projects
predate npm 7's peer-dependency enforcement), and a preflight that the
target command fails on the buggy revision and passes on the fixed one.

The task text is derived only from the failing test titles:
  'The regression test "<title>" in <file> fails. Make it pass.'

Keep fixtures out of directories that are cleaned automatically: macOS
deletes files under /tmp that have not been accessed for three days.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tarfile

MOCHA = {
    'express': ['node_modules/.bin/_mocha', '--require', 'test/support/env', '--reporter', 'dot'],
    'eslint': ['node_modules/.bin/_mocha', '--reporter', 'dot'],
    'hessian.js': ['node_modules/.bin/mocha', '-t', '15000', '-r', 'should', '--reporter', 'dot'],
}


def run(cmd, cwd):
    done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=300)
    out = re.sub(r'\x1b\[[0-9;]*m', '', done.stdout + done.stderr)
    # Mocha prints nested suite titles on indented continuation lines and ends
    # the full title with a colon: '1) suite' / 'nested' / 'test title:'.
    titles = set()
    lines = out.split("\n")  # not splitlines(): titles may contain U+2028
    for i, line in enumerate(lines):
        match = re.match(r'^(\s*)\d+\) (.+)$', line)
        if not match:
            continue
        parts, j = [match.group(2).strip()], i + 1
        while not parts[-1].endswith(':') and j < len(lines) and lines[j].strip() and \
                len(lines[j]) - len(lines[j].lstrip()) > len(match.group(1)):
            parts.append(lines[j].strip())
            j += 1
        titles.add(' '.join(parts))
    return done.returncode, sorted(titles)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('cases', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for case in json.loads(args.cases.read_text()):
        repo, bug = case['repo'], case['bug']
        source = args.out / (repo + '-src')
        if not source.exists():
            subprocess.run(['git', 'clone', '-q', f'https://github.com/BugsJS/{repo}.git', str(source)], check=True)
        dirs = {}
        for rev in ('test', 'full'):
            target = args.out / f"{case['id']}-{rev}"
            if not target.exists():
                target.mkdir()
                archive = args.out / f"{case['id']}-{rev}.tar"
                subprocess.run(['git', '-C', str(source), 'archive', '--output', str(archive), f'Bug-{bug}-{rev}'], check=True)
                with tarfile.open(archive) as tar:
                    tar.extractall(target, filter='data')
                archive.unlink()
            dirs[rev] = target
        install = ['npm', 'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', '--legacy-peer-deps',
                   '--loglevel', 'error']
        if not (dirs['test'] / 'node_modules').exists():
            subprocess.run(install, cwd=dirs['test'], check=True)
        if not (dirs['test'] / MOCHA[repo][0]).exists():
            # Old checkouts that ask for "mocha": "*" get today's mocha, which no
            # longer ships the runner they need. Install what was current when
            # the buggy commit was written instead.
            date = subprocess.run(['git', '-C', str(source), 'log', '-1', '--format=%aI', f'Bug-{bug}'],
                                  capture_output=True, text=True, check=True).stdout.strip()
            subprocess.run(['rm', '-rf', str(dirs['test'] / 'node_modules')], check=True)
            subprocess.run(install + ['--before', date], cwd=dirs['test'], check=True)
            print('installed', case['id'], 'dependencies as of', date)
        if not (dirs['full'] / 'node_modules').exists():
            (dirs['full'] / 'node_modules').symlink_to(dirs['test'] / 'node_modules', target_is_directory=True)
        base = MOCHA[repo]
        # A missing test path makes mocha exit before running anything, so a
        # preservation check that names one can never pass. Refuse the case.
        missing = [p for p in case['tests'] + case.get('preserve', []) for rev in ('test', 'full')
                   if not (dirs[rev] / p).exists()]
        if missing:
            print('skip', case['id'], 'test paths missing from the checkout:', sorted(set(missing)))
            continue
        cmd = base + case['tests'] + (['--grep', case['grep']] if case.get('grep') else [])
        code_test, failing = run(cmd, dirs['test'])
        code_full, _ = run(cmd, dirs['full'])
        if code_test == 0 or code_full != 0:
            print('skip', case['id'], 'target does not separate the revisions', code_test, code_full)
            continue
        names = [title.rstrip(':') for title in failing]
        files = ' and '.join(case['tests'])
        task = (f'The regression test "{names[0]}" in {files} fails. Make it pass.' if len(names) == 1 else
                'The regression tests ' + ', '.join(f'"{n}"' for n in names) + f' in {files} fail. Make them pass.')
        manifest.append({'id': case['id'], 'group': case.get('group', 'dev'), 'test_dir': str(dirs['test']),
                         'full_dir': str(dirs['full']), 'cmd': cmd, 'broader': base + case['tests'],
                         'preserve': base + case.get('preserve', case['tests']), 'task': task})
        print('ready', case['id'], 'failing on buggy revision:', len(names))
    (args.out / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')


if __name__ == '__main__':
    main()
