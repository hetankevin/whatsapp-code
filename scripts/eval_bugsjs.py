#!/usr/bin/env python3
"""Live BugsJS-style repository repair runs through the normal launcher.

Each case is a buggy checkout (upstream tests included) plus the upstream fixed
revision. The agent receives the task text and an exact test command, and runs
with native Claude Code tools under dontAsk permissions. Scoring is independent
of the session: the candidate diff is applied to a fresh copy of the buggy
fixture, then the targeted command, the broader suite, and optional extra
checks run there. A pass requires all of:
  - changes confined to implementation files (no tests, package files, or new files)
  - the targeted command passes on the fresh copy
  - the broader suite has no failing test titles beyond the fixed revision's
  - optional extra checks pass
  - a successful native Bash run of the targeted command after the last edit
  - no API error and no timeout

Manifest (JSON list, kept outside the repository):
  {"id", "group", "test_dir", "full_dir", "cmd": [...], "broader": [...],
   "task", "extra": [[...], ...] (optional, run from the scoring copy)}
Raw transcripts and diffs stay under --out. Only aggregate tables are published.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ('{task}\n\nFix the implementation in this checkout. Preserve the supplied tests, '
            'package files, public API, and existing behavior. Locate the relevant code with Grep, '
            'read bounded ranges, edit, and then run exactly: {command}\n'
            'If it fails, use the output to revise the patch and run it again.')
CONTEXT_TOKENS = None
EXCLUDED = re.compile(r'^(tests?/|package(-lock)?\.json$|npm-shrinkwrap\.json$|node_modules/)')


def copy_tree(src, dst):
    subprocess.run(['cp', '-cR', str(src), str(dst)], check=True)
    shutil.rmtree(dst / '.git', ignore_errors=True)


def init_git(project):
    for args in (['init', '-q'], ['add', '-A'],
                 ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
                  'commit', '-qm', 'baseline']):
        if args[0] == 'add':
            (project / '.git/info/exclude').write_text('node_modules\n')
        subprocess.run(['git', *args], cwd=project, check=True)


def run_cmd(project, cmd, log, timeout=120):
    try:
        with log.open('w') as out:
            child = subprocess.run(cmd, cwd=project, stdout=out, stderr=out, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {'code': None, 'timeout': True}
    data = log.read_text(errors='replace')
    count = lambda word: int((re.findall(r'(\d+) ' + word, data) or ['0'])[-1])
    if re.search(r'^# (pass|fail) \d+', data, re.M):  # node --test TAP output
        tap = lambda word: int((re.findall(r'^# ' + word + r' (\d+)', data, re.M) or ['0'])[-1])
        return {'code': child.returncode, 'passing': tap('pass'), 'failing': tap('fail'),
                'failure_titles': sorted(set(re.findall(r'^\s*not ok \d+ - ([^\n]+)', data, re.M)))}
    return {'code': child.returncode, 'passing': count('passing'), 'failing': count('failing'),
            'failure_titles': sorted(set(re.findall(r'^\s*\d+\) ([^\n]+)', data, re.M)))}


def preflight(case, out):
    cache = out / f"preflight-{case['id']}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    for key in ('test_dir', 'full_dir'):
        if not any(Path(case[key]).iterdir()) or not (Path(case[key]) / 'package.json').exists():
            raise SystemExit(f"fixture {case['id']} {key} is empty or damaged: {case[key]}")
    with tempfile.TemporaryDirectory(prefix='wa-eval-pre-') as tmp:
        result = {}
        for rev in ('test', 'full'):
            project = Path(tmp) / rev
            copy_tree(Path(case[rev + '_dir']), project)
            if not (project / 'node_modules').exists():
                (project / 'node_modules').symlink_to(Path(case['test_dir']) / 'node_modules')
            result[rev] = {'target': run_cmd(project, case['cmd'], out / f"pre-{case['id']}-{rev}-target.log"),
                           'broader': run_cmd(project, case['broader'], out / f"pre-{case['id']}-{rev}-broader.log")}
    result['valid'] = result['test']['target']['code'] not in (0, None) and result['full']['target']['code'] == 0
    cache.write_text(json.dumps(result, indent=2) + '\n')
    return result


def events_of(lines):
    for line in lines:
        try:
            yield json.loads(line)
        except ValueError:
            continue


def analyse(events, cmd):
    calls, results = {}, []
    denials = 0
    for idx, event in enumerate(events):
        message = event.get('message')
        if event.get('subtype') == 'permission_denied':
            denials += 1
        # Some system events (for example permission_denied) carry a string message.
        content = message.get('content') if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') == 'tool_use':
                calls[block['id']] = block
            if block.get('type') == 'tool_result':
                results.append((idx, calls.get(block.get('tool_use_id'), {}), block))

    def is_target(call):
        try:
            return shlex.split(call.get('input', {}).get('command', '')) == cmd
        except ValueError:
            return False
    edits = [i for i, c, b in results if c.get('name') in ('Edit', 'Write') and not b.get('is_error')]
    tests = [(i, b) for i, c, b in results if c.get('name') == 'Bash' and is_target(c)]
    return {
        'tools': [c['name'] for c in calls.values()],
        'edits_ok': len(edits),
        'edits_failed': sum(1 for _, c, b in results if c.get('name') in ('Edit', 'Write') and b.get('is_error')),
        'bash_calls': sum(1 for c in calls.values() if c['name'] == 'Bash'),
        'native_tests': len(tests),
        'native_test_pass_after_edit': bool(edits) and any(i > max(edits) and not b.get('is_error') for i, b in tests),
        'read_limits': [c['input'].get('limit') for c in calls.values() if c['name'] == 'Read'],
        'permission_denials': denials,
    }


def wait_ready(limit=600):
    """Wait for the paired gateway to report WhatsApp ready. Returns seconds waited or None."""
    import urllib.request
    state = Path(os.environ.get('WA_STATE_DIR') or Path.home() / 'Library/Application Support/whatsapp-code')
    token = (state / 'gateway-token').read_text().strip()
    port = os.environ.get('WA_PORT', '8787')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    begin = time.time()
    while time.time() - begin < limit:
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{port}/health', headers={'x-api-key': token})
            if json.loads(opener.open(request, timeout=5).read()).get('ready'):
                return round(time.time() - begin, 1)
        except Exception:
            pass
        time.sleep(5)
    return None


def gateway_log_delta(log, start):
    if not log or not log.exists():
        return []
    with log.open('rb') as handle:
        handle.seek(start)
        text = handle.read().decode(errors='replace')
    # Keep only the gateway's own one-line status messages, never reply bodies.
    return [line[:160] for line in text.splitlines() if line and not line.startswith('{')][:40]


def runner_prefix(cmd):
    # A generic interpreter needs its subcommand too (node --test, npm test).
    return shlex.join(cmd[:2] if cmd[0] in ('node', 'npm', 'npx', 'yarn', 'pnpm', 'python', 'python3') else cmd[:1])


def launch(case, project, config, mode, budget, max_turns, out_stem, resume=None):
    command = shlex.join(case['cmd'])
    prompt = TEMPLATE.format(task=case['task'], command=command)
    env = {**os.environ, 'CLAUDE_CONFIG_DIR': str(config)}
    for key in ('WA_EDIT_FILE', 'WA_EDIT_FILES', 'WA_EDIT_RANGES', 'WA_TEST_COMMAND'):
        env.pop(key, None)
    env.update(case.get('env', {}))
    if CONTEXT_TOKENS:
        env['CLAUDE_CODE_MAX_CONTEXT_TOKENS'] = str(CONTEXT_TOKENS)
    # Allow the exact command plus the project's test runner as a prefix rule,
    # so a re-quoted or narrowed test invocation is not denied. Nothing else.
    tools = ['--permission-mode', 'dontAsk', '--allowedTools', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
             f'Bash({command})', f'Bash({runner_prefix(case["cmd"])}:*)', *[f'Bash({c})' for c in case.get('allow_bash', [])]]
    launcher = str(Path(os.environ.get('WA_EVAL_LAUNCHER', ROOT / 'src/launch.mjs')))
    begin = time.time()
    timed_out, session, exit_code = False, None, None
    if mode == 'print':
        args = ['node', launcher, '--print', '--verbose', '--output-format', 'stream-json',
                '--max-turns', str(max_turns), *tools, '--', prompt]
        with open(out_stem + '.jsonl', 'w') as stream, open(out_stem + '.stderr', 'w') as stderr:
            child = subprocess.Popen(args, cwd=project, env=env, stdout=stream, stderr=stderr, start_new_session=True)
            try:
                child.wait(timeout=budget)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            exit_code = child.returncode
        events = list(events_of(Path(out_stem + '.jsonl').read_text(errors='replace').splitlines()))
        result = next((e for e in reversed(events) if e.get('type') == 'result'), {})
        session = result.get('session_id')
        error = str(result.get('result') or '')[:300] if (result.get('is_error') or exit_code) else None
        final = str(result.get('result') or '')
        if resume and session and not timed_out:
            # Continue the same native session; Claude Code restores the transcript.
            args = ['node', launcher, '--print', '--verbose', '--output-format', 'stream-json',
                    '--max-turns', str(max_turns), '--resume', session, *tools, '--', resume]
            remaining = max(30, budget - (time.time() - begin))
            with open(out_stem + '-resume.jsonl', 'w') as stream, open(out_stem + '-resume.stderr', 'w') as stderr:
                child = subprocess.Popen(args, cwd=project, env=env, stdout=stream, stderr=stderr, start_new_session=True)
                try:
                    child.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                exit_code = child.returncode
            later = list(events_of(Path(out_stem + '-resume.jsonl').read_text(errors='replace').splitlines()))
            result = next((e for e in reversed(later) if e.get('type') == 'result'), {})
            error = str(result.get('result') or '')[:300] if (result.get('is_error') or exit_code) else None
            final = str(result.get('result') or '')
            events += later
        compactions = sum(1 for e in events if e.get('type') == 'system' and e.get('subtype') == 'compact_boundary')
    elif mode == 'tty':
        # The ordinary interactive terminal UI, detached in screen.
        import uuid
        session = str(uuid.uuid4())
        name = 'wa-eval-' + session[:8]
        script = Path(out_stem + '.tty.sh')
        script.write_text('cd ' + shlex.quote(str(project)) + ' && exec ' + shlex.join(
            ['node', launcher, '--session-id', session, *tools, '--', prompt]) + '\n')
        subprocess.run(['screen', '-dmS', name, '/bin/zsh', str(script)], env={**env, 'TERM': 'xterm-256color'}, check=True)

        def transcript():
            for path in (config / 'projects').glob('*/' + session + '.jsonl'):
                yield from events_of(path.read_text(errors='replace').splitlines())
        finished, stable = None, 0
        while time.time() - begin < budget:
            history = [e for e in transcript() if e.get('type') in ('assistant', 'user')]
            last = history[-1] if history else None
            blocks = (last or {}).get('message', {}).get('content') or []
            done = last and last.get('type') == 'assistant' and isinstance(blocks, list) and not any(
                isinstance(b, dict) and b.get('type') == 'tool_use' for b in blocks)
            stable = stable + 1 if done else 0
            if stable >= 5:
                finished = last
                break
            time.sleep(2)
        timed_out = finished is None
        subprocess.run(['screen', '-S', name, '-X', 'quit'], capture_output=True)
        time.sleep(2)
        events = [e for e in transcript() if e.get('type') in ('assistant', 'user', 'system')]
        with open(out_stem + '.jsonl', 'w') as handle:
            for e in events:
                handle.write(json.dumps(e) + '\n')
        blocks = ((finished or {}).get('message') or {}).get('content') or []
        final = ' '.join(b.get('text', '') for b in blocks if isinstance(b, dict) and b.get('type') == 'text') if isinstance(blocks, list) else str(blocks)
        error = next((line[:300] for line in final.splitlines() if 'API Error' in line or 'Request too large' in line), None)
        compactions = 0
    else:
        args = ['node', launcher, '--bg', '--name', f"eval {case['id']}", *tools, '--', prompt]
        started = subprocess.run(args, cwd=project, env=env, text=True, capture_output=True, timeout=30)
        Path(out_stem + '.launch').write_text(started.stdout + started.stderr)
        match = re.search(r'claude attach ([a-z0-9-]+)', started.stdout + started.stderr)
        if started.returncode or not match:
            return dict(seconds=round(time.time() - begin, 1), error='launch failed: ' + (started.stderr or started.stdout)[-300:],
                        timed_out=False, exit_code=started.returncode, events=[], session=None, final='')
        session = match[1]

        def transcript():
            for path in (config / 'projects').glob('*/' + session + '*.jsonl'):
                yield from events_of(path.read_text(errors='replace').splitlines())
        finished = None
        while time.time() - begin < budget:
            history = list(transcript())
            final_event = next((e for e in reversed(history) if e.get('type') == 'assistant'), None)
            blocks = (final_event or {}).get('message', {}).get('content') or []
            if final_event and isinstance(blocks, list) and not any(b.get('type') == 'tool_use' for b in blocks if isinstance(b, dict)):
                agents = subprocess.run(['claude', 'agents', '--json', '--all'], env=env, text=True, capture_output=True)
                try:
                    agent = next((a for a in json.loads(agents.stdout) if a.get('id') == session), {})
                except ValueError:
                    agent = {}
                if agent.get('status') not in ('busy', 'running'):
                    finished = final_event
                    break
            time.sleep(2)
        timed_out = finished is None
        if timed_out:
            subprocess.run(['claude', 'stop', session], env=env, capture_output=True)
            time.sleep(3)
        events = [e for e in transcript() if e.get('type') in ('assistant', 'user')]
        with open(out_stem + '.jsonl', 'w') as handle:
            for e in events:
                handle.write(json.dumps(e) + '\n')
        blocks = ((finished or {}).get('message') or {}).get('content') or []
        final = ' '.join(b.get('text', '') for b in blocks if isinstance(b, dict) and b.get('type') == 'text')
        error = next((line[:300] for line in final.splitlines() if 'API Error' in line or 'Request too large' in line), None)
        compactions = sum(1 for e in events if e.get('type') == 'system' and e.get('subtype') == 'compact_boundary')
    return dict(compactions=compactions, resumed=bool(resume), seconds=round(time.time() - begin, 1), timed_out=timed_out, exit_code=exit_code,
                events=events, session=session, error=error, final=final[:300])


SCORER_REVISION = 4


def reference_failures(case, out, runs=3):
    """Per-title failure counts over repeated runs of the FIXED revision only.
    Buggy-revision failures are never forgiven, and the target command must
    pass separately."""
    if not case.get('preserve'):
        return None
    cache = out / f"reference3-{case['id']}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    counts, passing = {}, []
    with tempfile.TemporaryDirectory(prefix='wa-eval-ref-') as tmp:
        project = Path(tmp) / 'full'
        copy_tree(Path(case['full_dir']), project)
        if not (project / 'node_modules').exists():
            (project / 'node_modules').symlink_to(Path(case['test_dir']) / 'node_modules')
        for i in range(runs):
            result = run_cmd(project, case['preserve'], out / f"reference-{case['id']}-{i}.log")
            for title in result.get('failure_titles', []):
                counts[title] = counts.get(title, 0) + 1
            passing.append(result.get('passing', 0))
    reference = {'counts': counts, 'min_passing': min(passing), 'max_passing': max(passing), 'runs': runs}
    cache.write_text(json.dumps(reference, indent=2) + '\n')
    return reference


def score(case, pre, patch, out_stem, reference=None):
    with tempfile.TemporaryDirectory(prefix='wa-eval-score-') as tmp:
        project = Path(tmp) / 'p'
        copy_tree(Path(case['test_dir']), project)
        applied = subprocess.run(['git', 'apply', '--whitespace=nowarn', '-'], input=patch, cwd=project,
                                 text=True, capture_output=True)
        if applied.returncode:
            return {'applied': False, 'error': applied.stderr[-300:], 'scorer': SCORER_REVISION}
        target = run_cmd(project, case['cmd'], Path(out_stem + '-score-target.log'))
        broader = run_cmd(project, case['broader'], Path(out_stem + '-score-broader.log'))
        known = set(pre['full']['broader']['failure_titles'])
        new_failures = set(broader.get('failure_titles', [])) - known
        if new_failures:  # confirm before counting a regression
            again = run_cmd(project, case['broader'], Path(out_stem + '-score-broader2.log'))
            new_failures &= set(again.get('failure_titles', []))
        new_failures = sorted(new_failures)
        parity = (broader.get('code') is not None and not new_failures and
                  broader.get('passing', 0) >= pre['full']['broader']['passing'] - len(known))
        preserve = None
        if reference is not None:
            # A regression must fail in every candidate run and in at most one
            # reference run. Titles flaky on the reference are reported, not scored.
            runs = reference['runs']
            counts = reference['counts']
            first = run_cmd(project, case['preserve'], Path(out_stem + '-score-preserve.log'))
            seen = {t: 1 for t in first.get('failure_titles', []) if counts.get(t, 0) < runs}
            for i in range(1, runs if seen else 1):
                again = set(run_cmd(project, case['preserve'], Path(out_stem + f'-score-preserve{i + 1}.log')).get('failure_titles', []))
                for t in seen:
                    seen[t] += t in again
            regressions = sorted(t for t, n in seen.items() if n == runs and counts.get(t, 0) <= 1)
            unscored = sorted(t for t, n in seen.items() if n == runs and counts.get(t, 0) > 1)
            preserve = {'ok': first.get('code') is not None and not regressions and first.get('passing', 0) > 0,
                        'passing': first.get('passing'), 'failing': first.get('failing'),
                        'new_failures': regressions[:10], 'flaky_unscored': unscored[:10]}
        extra = []
        for i, cmd in enumerate(case.get('extra', [])):
            cmd = [str(project) if part == '{project}' else part for part in cmd]
            extra.append(run_cmd(project, cmd, Path(out_stem + f'-score-extra{i}.log')).get('code') == 0)
    correct = bool(target.get('code') == 0 and parity and all(extra) and (preserve is None or preserve['ok']))
    return {'applied': True, 'scorer': SCORER_REVISION, 'target_pass': target.get('code') == 0, 'target': target,
            'broader_passing': broader.get('passing'), 'broader_failing': broader.get('failing'),
            'new_failures': new_failures[:10], 'parity': parity, 'preserve': preserve, 'extra': extra,
            'correct': correct}


def rescore(cases, out, labels):
    """Re-judge saved candidate diffs with the current scorer. Originals stay untouched."""
    for label in labels:
        for case in cases:
            for path in sorted((out / label).glob(case['id'] + '-r*.json')):
                if '.rescore' in path.name:
                    continue
                report = json.loads(path.read_text())
                stem = str(path)[:-5]
                patch = Path(stem + '.diff').read_text() if Path(stem + '.diff').exists() else ''
                judged = score(case, preflight(case, out), patch, stem + '.rescore', reference_failures(case, out)) \
                    if patch.strip() else {'applied': False, 'scorer': SCORER_REVISION}
                correct = bool(report.get('scope') and judged.get('correct'))
                passed = bool(correct and report.get('native_test_pass_after_edit') and
                              not report.get('timed_out') and not report.get('error'))
                Path(stem + f'.rescore{SCORER_REVISION}.json').write_text(json.dumps(
                    {'case': case['id'], 'label': label, 'original_passed': report.get('passed'),
                     'patch_correct': correct, 'passed': passed, 'score': judged}, indent=2) + '\n')
                print('rescore', label, path.name, 'PASS' if passed else 'fail', 'correct', correct, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--cases', nargs='*')
    parser.add_argument('--repeat', type=int, default=1)
    parser.add_argument('--mode', choices=['print', 'bg', 'tty'], default='print')
    parser.add_argument('--budget', type=int, default=300)
    parser.add_argument('--max-turns', type=int, default=40)
    parser.add_argument('--gateway-log', type=Path)
    parser.add_argument('--resume-prompt', help='print mode: resume the session once with this follow-up')
    parser.add_argument('--context-tokens', type=int, help='client context window, to force native compaction')
    parser.add_argument('--rescore', nargs='*', help='re-judge saved runs under these labels, then exit')
    args = parser.parse_args()
    global CONTEXT_TOKENS
    CONTEXT_TOKENS = args.context_tokens
    cases = json.loads(args.manifest.read_text())
    if args.cases:
        cases = [c for c in cases if c['id'] in args.cases]
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    if args.rescore is not None:
        rescore(cases, out, args.rescore or [args.label])
        return
    runs = out / args.label
    runs.mkdir(exist_ok=True)
    for case in cases:
        pre = preflight(case, out)
        reference = reference_failures(case, out)
        if not pre['valid']:
            print('skip invalid fixture', case['id'], flush=True)
            continue
        for k in range(1, args.repeat + 1):
            stem = str(runs / f"{case['id']}-r{k}")
            if Path(stem + '.json').exists():
                continue
            holder = Path(tempfile.mkdtemp(prefix='wa-eval-run-'))
            project = holder / case['id']
            copy_tree(Path(case['test_dir']), project)
            if not (project / 'node_modules').exists():
                (project / 'node_modules').symlink_to(Path(case['test_dir']) / 'node_modules')
            init_git(project)
            config = holder / 'claude'
            config.mkdir(mode=0o700)
            (config / '.claude.json').write_text(json.dumps(
                {'hasCompletedOnboarding': True, 'projects': {str(project): {'hasTrustDialogAccepted': True},
                                                              str(project.resolve()): {'hasTrustDialogAccepted': True}}}))
            log_start = args.gateway_log.stat().st_size if args.gateway_log and args.gateway_log.exists() else 0
            waited = wait_ready()
            if waited is None:
                Path(stem + '.json').write_text(json.dumps(dict(case=case['id'], label=args.label, repeat=k,
                    blocked='gateway not ready for 600 s', passed=False)) + '\n')
                print('blocked', case['id'], k, 'gateway not ready', flush=True)
                continue
            print('running', args.label, case['id'], k, args.mode, 'waited', waited, flush=True)
            run = launch(case, project, config, args.mode, args.budget, args.max_turns, stem, args.resume_prompt)
            facts = analyse(run.pop('events'), case['cmd'])
            # Background sessions edit inside a native worktree under .claude/worktrees.
            worktrees = [Path(line[9:]) for line in subprocess.check_output(
                ['git', 'worktree', 'list', '--porcelain'], cwd=project, text=True).splitlines()
                if line.startswith('worktree ') and '/.claude/worktrees/' in line]
            source = worktrees[0] if len(worktrees) == 1 else project
            status = [line for line in subprocess.check_output(
                ['git', 'status', '--porcelain', '--untracked-files=all'], cwd=source, text=True).splitlines()
                if not line[3:].startswith('.claude/')]
            if source != project:
                status += [line for line in subprocess.check_output(
                    ['git', 'status', '--porcelain', '--untracked-files=all'], cwd=project, text=True).splitlines()
                    if not line[3:].startswith('.claude/')]
            paths = [line[3:] for line in status]
            scope = bool(paths) and all(line.startswith(' M ') for line in status) and not any(EXCLUDED.match(p) for p in paths)
            patch = subprocess.check_output(['git', 'diff', '--binary', 'HEAD'], cwd=source, text=True)
            Path(stem + '.diff').write_text(patch)
            judged = score(case, pre, patch, stem, reference) if paths else {'applied': False, 'scorer': SCORER_REVISION}
            passed = bool(scope and judged.get('correct') and facts['native_test_pass_after_edit']
                          and not run['timed_out'] and not run['error'])
            report = dict(case=case['id'], group=case.get('group'), label=args.label, repeat=k, mode=args.mode,
                          changed=paths, scope=scope, **run, **facts, score=judged,
                          worktree=source != project, patch_correct=bool(scope and judged.get('correct')),
                          passed=passed, gateway=gateway_log_delta(args.gateway_log, log_start))
            Path(stem + '.json').write_text(json.dumps(report, indent=2) + '\n')
            print('result', case['id'], k, 'PASS' if passed else 'fail', run['seconds'], 's',
                  'edits', facts['edits_ok'], 'tests', facts['native_tests'], 'target', judged.get('target_pass'),
                  'parity', judged.get('parity'), 'preserve', (judged.get('preserve') or {}).get('ok'),
                  'err', run['error'], flush=True)
            # Background sessions leave a transient Claude Code daemon tied to
            # this run's private config directory. Stop it before cleanup.
            subprocess.run(['pkill', '-f', str(holder)], capture_output=True)
            shutil.rmtree(holder, ignore_errors=True)


if __name__ == '__main__':
    main()
