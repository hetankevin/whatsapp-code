#!/usr/bin/env python3
"""Prepare BugsJS fixtures and a case manifest for eval_bugsjs.py.

Input: a JSON list of cases, for example
  {"id": "express-11", "repo": "express", "bug": 11,
   "tests": ["test/res.send.js"], "grep": null,
   "preserve": ["test/", "test/acceptance/"]}
Repositories come from https://github.com/BugsJS/<repo>. Each case gets the
Bug-N-test tag (buggy source with the upstream regression tests) and the
Bug-N-full tag (upstream fix), dependencies installed with
`npm install --ignore-scripts --no-package-lock`, and a preflight that the
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
    out = done.stdout + done.stderr
    titles = sorted(set(re.findall(r'^\s*\d+\) ([^\n]+)', out, re.M)))
    return done.returncode, titles


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
        if not (dirs['test'] / 'node_modules').exists():
            subprocess.run(['npm', 'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
                            '--loglevel', 'error'], cwd=dirs['test'], check=True)
        if not (dirs['full'] / 'node_modules').exists():
            (dirs['full'] / 'node_modules').symlink_to(dirs['test'] / 'node_modules', target_is_directory=True)
        base = MOCHA[repo]
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
