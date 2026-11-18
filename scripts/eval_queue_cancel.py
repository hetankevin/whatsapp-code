#!/usr/bin/env python3
"""Live queue and cancellation checks through the normal launcher.

Each prompt carries a random token, so a reply that reaches the wrong session is visible.

  queue          three sessions start together (a word, a product, a native Read of a file);
                 each must get its own answer
  cancel-queued  session B is interrupted (SIGINT to its process group, like Ctrl-C) while a long
                 answer to session A holds the WhatsApp chat; A must answer, and B's prompt must never
                 reach Meta AI (no reply carries B's token)
  cancel-flight  session A asks for a long answer and is interrupted mid-reply; session C
                 starts at once and must get its own answer, while A's late reply is dropped
                 (the gateway logs it as unmatched)

Needs the paired gateway started with WA_REPLY_LOG=<--reply-log>. Writes outcomes to --out.
"""
import argparse
import json
import os
from pathlib import Path
import random
import signal
import string
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def token():
    return 'tok' + ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(10))


def start(prompt, cwd, env, tools=''):
    args = ['node', str(ROOT / 'src/launch.mjs'), '--print', '--output-format', 'json', '--no-session-persistence',
            '--permission-mode', 'dontAsk', '--tools', tools]
    if tools:
        args += ['--allowedTools', *tools.split(',')]
    args += ['--', prompt]
    proc = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            stdin=subprocess.DEVNULL, start_new_session=True)
    proc.began = time.monotonic()
    return proc


def finish(proc, timeout=240):
    try:
        stdout, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        stdout, _ = proc.communicate()
        return {'seconds': round(time.monotonic() - proc.began, 1), 'error': 'timeout', 'answer': ''}
    seconds = round(time.monotonic() - proc.began, 1)
    try:
        out = json.loads(stdout or '{}')
    except ValueError:
        return {'seconds': seconds, 'error': 'no json', 'answer': '', 'code': proc.returncode}
    return {'seconds': seconds, 'error': out.get('result') if out.get('is_error') else None,
            'answer': str(out.get('result') or '').strip(), 'code': proc.returncode}


def interrupt(proc):
    finished = proc.poll() is not None
    if not finished:
        os.killpg(proc.pid, signal.SIGINT)
    try:
        stdout, _ = proc.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        stdout, _ = proc.communicate()
    return {'seconds': round(time.monotonic() - proc.began, 1), 'code': proc.returncode,
            'finished_before_interrupt': finished}


def replies(log, offset):
    if not log.exists():
        return []
    with log.open() as f:
        f.seek(offset)
        return [json.loads(line) for line in f if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--reply-log', type=Path, required=True)
    args = parser.parse_args()
    out = args.out / args.label
    out.mkdir(parents=True, exist_ok=True)
    results = {}
    with tempfile.TemporaryDirectory(prefix='wa-queue-') as tmp:
        holder = Path(tmp)
        config = holder / 'claude'
        config.mkdir(mode=0o700)
        dirs = {name: holder / name for name in ('a', 'b', 'c')}
        for d in dirs.values():
            d.mkdir()
        (config / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True, 'projects': {
            str(d): {'hasTrustDialogAccepted': True} for d in dirs.values()}}))
        env = {**os.environ, 'CLAUDE_CONFIG_DIR': str(config)}

        # queue: three sessions at once.
        word, code = token(), token()
        x, y = random.randint(101, 999), random.randint(101, 999)
        (dirs['c'] / 'code.txt').write_text(f'The release code is {code}.\n')
        began = time.monotonic()
        procs = {'word': start(f'Reply with exactly this word and nothing else: {word}', dirs['a'], env),
                 'product': start(f'What is {x} * {y}? Reply with the number only.', dirs['b'], env),
                 'read': start('Read code.txt in this directory and reply with the release code only.', dirs['c'], env,
                               'Read')}
        got = {name: finish(proc) for name, proc in procs.items()}
        expected = {'word': word, 'product': str(x * y), 'read': code}
        for name, result in got.items():
            result['correct'] = result['error'] is None and expected[name] in result['answer'] and \
                not any(other in result['answer'] for key, other in expected.items() if key != name)
        results['queue'] = {'passed': all(r['correct'] for r in got.values()), 'sessions': got,
                            'total_seconds': round(time.monotonic() - began, 1)}
        print('queue', results['queue']['passed'], {k: (v['correct'], v['seconds']) for k, v in got.items()}, flush=True)
        time.sleep(10)

        # cancel-queued: interrupt B while A holds the chat.
        tok_a, tok_b = token(), token()
        offset = args.reply_log.stat().st_size if args.reply_log.exists() else 0
        # A long answer keeps the chat busy, so B's request waits in the gateway queue.
        a = start('Write a 1500-word story about a tide pool. End the story with exactly this word: ' + tok_a,
                  dirs['a'], env)
        time.sleep(4)
        b = start(f'Reply with exactly this word and nothing else: {tok_b}', dirs['b'], env)
        time.sleep(4)
        stopped = interrupt(b)
        answer = finish(a)
        time.sleep(45)
        texts = [r.get('text') or '' for r in replies(args.reply_log, offset)]
        b_sent = any(tok_b in t for t in texts)
        a_ok = answer['error'] is None and tok_a in answer['answer'] and tok_b not in answer['answer']
        results['cancel-queued'] = {'passed': a_ok and not b_sent and not stopped['finished_before_interrupt'],
                                    'a': answer, 'b_interrupted': stopped,
                                    'b_reached_meta_ai': b_sent}
        print('cancel-queued', results['cancel-queued']['passed'], 'a', a_ok, answer['seconds'], 'b reached Meta AI',
              b_sent, flush=True)
        time.sleep(10)

        # cancel-flight: interrupt A mid-reply, start C at once.
        tok_a, tok_c = token(), token()
        offset = args.reply_log.stat().st_size if args.reply_log.exists() else 0
        a = start('Write a 1500-word story about a lighthouse keeper. End the story with exactly this word: ' + tok_a,
                  dirs['a'], env)
        time.sleep(9)
        stopped = interrupt(a)
        c = start(f'Reply with exactly this word and nothing else: {tok_c}', dirs['c'], env)
        answer = finish(c)
        time.sleep(60)
        records = replies(args.reply_log, offset)
        late = [r for r in records if tok_a in (r.get('text') or '')]
        c_ok = answer['error'] is None and tok_c in answer['answer'] and tok_a not in answer['answer'] \
            and 'lighthouse' not in answer['answer'].lower()
        results['cancel-flight'] = {'passed': c_ok and not stopped['finished_before_interrupt'], 'c': answer,
                                    'a_interrupted': stopped,
                                    'a_late_reply_seen': bool(late),
                                    'a_late_reply_unmatched': bool(late) and all(r.get('unmatched') for r in late)}
        print('cancel-flight', c_ok, 'c', answer['seconds'], 'late A reply seen', bool(late), 'dropped as unmatched',
              results['cancel-flight']['a_late_reply_unmatched'], flush=True)
    (out / 'results.json').write_text(json.dumps(results, indent=1) + '\n')


if __name__ == '__main__':
    main()
