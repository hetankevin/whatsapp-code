#!/usr/bin/env python3
"""Plain Q&A through the normal launcher, scored against expected answers.

General questions run with no tools. Repository questions run in a copy of
a project with native read-only tools (Glob, Grep, Read). Uses the paired
WhatsApp account. Results go to --out; only outcomes are meant for publishing.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
GENERAL = [
    ('arith', 'What is 37 * 43? Reply with the number only.', r'\b1591\b'),
    ('http', 'Which HTTP status code means Unprocessable Content? Reply with the number only.', r'\b422\b'),
    ('git', 'Which git subcommand shows, for each line of a file, the commit that last changed it? Reply with the subcommand only.', r'\bblame\b'),
    ('flat', 'In JavaScript, what does [[1, [2]], 3].flat() return? Reply with the array literal only.', r'\[\s*1\s*,\s*\[\s*2\s*\]\s*,\s*3\s*\]'),
]
REPO = [
    ('send-file', 'Which file in this checkout defines res.send? Reply with the path relative to the project root.', r'lib/response\.js'),
    ('param-file', 'Which file in this checkout defines the router prototype method that registers parameter callbacks (proto.param)? Reply with the path relative to the project root.', r'lib/router/index\.js'),
]


def ask(prompt, cwd, env, tools, timeout):
    args = ['node', str(ROOT / 'src/launch.mjs'), '--print', '--output-format', 'json', '--no-session-persistence',
            '--permission-mode', 'dontAsk', '--tools', tools]
    if tools:
        args += ['--allowedTools', *tools.split(',')]
    args += ['--', prompt]
    begin = time.monotonic()
    try:
        done = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        out = json.loads(done.stdout or '{}')
    except (subprocess.TimeoutExpired, ValueError) as error:
        return {'seconds': round(time.monotonic() - begin, 1), 'error': type(error).__name__, 'answer': ''}
    return {'seconds': round(time.monotonic() - begin, 1), 'error': out.get('result') if out.get('is_error') else None,
            'answer': str(out.get('result') or ''), 'turns': out.get('num_turns')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--repo', type=Path, help='project to copy for repository questions')
    parser.add_argument('--timeout', type=int, default=150)
    args = parser.parse_args()
    out = args.out / args.label
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='wa-qa-') as tmp:
        holder = Path(tmp)
        config = holder / 'claude'
        config.mkdir(mode=0o700)
        plain = holder / 'plain'
        plain.mkdir()
        projects = {str(plain): {'hasTrustDialogAccepted': True}}
        repo = None
        if args.repo:
            repo = holder / 'repo'
            subprocess.run(['cp', '-cR', str(args.repo), str(repo)], check=True)
            shutil.rmtree(repo / '.git', ignore_errors=True)
            # A normal checkout is a git repository, so native Grep honors
            # .gitignore and skips node_modules.
            (repo / '.gitignore').exists() or (repo / '.gitignore').write_text('node_modules\n')
            for git in (['init', '-q'], ['add', '-A'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']):
                subprocess.run(['git', *git], cwd=repo, check=True, capture_output=True)
            projects[str(repo)] = {'hasTrustDialogAccepted': True}
        (config / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True, 'projects': projects}))
        env = {**os.environ, 'CLAUDE_CONFIG_DIR': str(config)}
        cases = [(name, prompt, pattern, plain, '') for name, prompt, pattern in GENERAL]
        if repo:
            cases += [(name, prompt, pattern, repo, 'Glob,Grep,Read') for name, prompt, pattern in REPO]
        for name, prompt, pattern, cwd, tools in cases:
            result = ask(prompt, cwd, env, tools, args.timeout)
            result.update(case=name, label=args.label, tools=tools or 'none',
                          correct=bool(re.search(pattern, result['answer'], re.I)) and not result['error'])
            (out / f'{name}.json').write_text(json.dumps(result, indent=2) + '\n')
            print('qa', args.label, name, 'ok' if result['correct'] else 'WRONG', result['seconds'], 's',
                  repr(result['answer'][:80]), result['error'] or '', flush=True)


if __name__ == '__main__':
    main()
