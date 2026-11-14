#!/usr/bin/env python3
"""Controlled isolation experiment: direct Meta AI request versus gateway presentation.

For each task, both arms get the same task text, the same implementation files
(those the upstream fix changes, in full), and the same failing output of the
exact target command on a clean buggy copy. Nothing else: no reference fix and
no diagnosis.

  A (direct):  one plain WhatsApp message, no coding protocol and no Claude Code
               prompt, asking for each change as a file path, the exact original
               lines, and the replacement lines. Applied only by exact unique
               match; anything else is recorded as not applicable. A whitespace-
               normalized match is recorded as a diagnostic and never scored.
  B (gateway): the gateway's normal rendering of a Claude Code request, using the
               system prompt and tool schemas captured from the real launcher, with
               the transcript pre-seeded with native-format Read results and the
               failing Bash result. The first proposal is every edit the model
               makes (each answered with Claude Code's normal Edit result) until it
               asks for anything else or ends, capped at 6 edits.

Both arms are scored on clean copies with the same scorer as the live runs. Needs
the paired gateway started with WA_EXPERIMENT_RAW=1. Prompts and replies are saved
under --out with owner-only permissions; publish only the outcome table.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import eval_bugsjs as eb  # noqa: E402

FILES = {'eslint-10': ['lib/config.js', 'lib/config/config-file.js'], 'express-20': ['lib/response.js'],
         'csv': ['csv.mjs']}
MAX_EDITS = 6


def private_write(path, text):
    path.write_text(text)
    os.chmod(path, 0o600)


def gateway(path, body, headers=None, timeout=200):
    state = Path(os.environ.get('WA_STATE_DIR') or Path.home() / 'Library/Application Support/whatsapp-code')
    token = (state / 'gateway-token').read_text().strip()
    request = urllib.request.Request('http://127.0.0.1:' + os.environ.get('WA_PORT', '8787') + path,
                                     data=json.dumps(body).encode(), method='POST',
                                     headers={'content-type': 'application/json', 'x-api-key': token, **(headers or {})})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        return {'type': 'error', 'status': error.code, 'error': json.loads(error.read() or b'{}').get('error')}


def readable(text):
    # The same cleanup the gateway applies to tool output in its WhatsApp view.
    script = ("import {readableOutput} from " + json.dumps(str(ROOT / 'src/failed-tests.mjs')) +
              "; let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(readableOutput(s)));")
    return subprocess.run(['node', '--input-type=module', '-e', script], input=text, text=True,
                          capture_output=True, check=True).stdout


def csv_case(work):
    sys.path.insert(0, str(ROOT / 'scripts'))
    import eval_coding as ec
    spec = ec.SCENARIOS['csv']
    project = work / 'csv-fixture'
    if not project.exists():
        project.mkdir()
        files = {'AGENTS.md': 'Keep the existing named exports. Add no dependencies. Do not modify package.json or supplied *.test.mjs files. Change only the supplied implementation files. Run node --test before reporting completion.\n',
                 'package.json': '{"private":true,"type":"module"}\n', 'behavior.test.mjs': spec['visible'],
                 'csv.mjs': spec['source']}
        for name, text in files.items():
            (project / name).write_text(text)
        (project / 'node_modules').mkdir()
    return {'id': 'csv', 'test_dir': str(project), 'cmd': ['node', '--test'], 'task': spec['task'],
            'judge': spec['judge'], 'synthetic': True}


def fresh_copy(case, holder):
    project = holder / case['id']
    eb.copy_tree(Path(case['test_dir']), project)
    if not (project / 'node_modules').exists():
        (project / 'node_modules').symlink_to(Path(case['test_dir']) / 'node_modules')
    eb.init_git(project)
    return project


def failing_output(case, work):
    with tempfile.TemporaryDirectory(prefix='wa-iso-fail-') as tmp:
        project = fresh_copy(case, Path(tmp))
        done = subprocess.run(case['cmd'], cwd=project, capture_output=True, text=True, timeout=120)
    assert done.returncode != 0, 'target must fail on the buggy copy'
    return done.returncode, readable(done.stdout + done.stderr).strip()


def capture_claude_request(case, work):
    """Run the real launcher against a local stand-in to capture Claude Code's request."""
    cache = work / f"captured-{case['id']}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    helper = work / 'capture.mjs'
    helper.write_text("""
import { once } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { createGateway } from %s;
import { parseReply } from %s;
const [state, out] = process.argv.slice(2);
await mkdir(state, {recursive: true});
await writeFile(state + '/gateway-token', 'z'.repeat(64));
let captured;
const parse = JSON.parse;
JSON.parse = (text, ...rest) => { const value = parse(text, ...rest);
  if (!captured && value && Array.isArray(value.tools) && value.tools.length && Array.isArray(value.messages)) captured = value;
  return value; };
const backend = {ready: true, status: 'ready', bot: 'capture', async complete(request) {
  await writeFile(out, JSON.stringify(captured)); return parseReply('captured', request, {matchedTurn: true}); }};
const server = createGateway({backend, token: 'z'.repeat(64)});
server.prependListener('request', req => { if (!captured) process.env.CAPTURED_CLASS = req.headers['x-claude-code-request-class'] ?? ''; });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
console.log(server.address().port);
""" % (json.dumps(str(ROOT / 'src/server.mjs')), json.dumps(str(ROOT / 'src/protocol.mjs'))))
    holder = Path(tempfile.mkdtemp(prefix='wa-iso-cap-'))
    try:
        project = fresh_copy(case, holder)
        config = holder / 'claude'
        config.mkdir()
        (config / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True,
                                                         'projects': {str(project): {'hasTrustDialogAccepted': True}}}))
        out = holder / 'body.json'
        mock = subprocess.Popen(['node', str(helper), str(holder / 'state'), str(out)], stdout=subprocess.PIPE, text=True)
        port = mock.stdout.readline().strip()
        prompt = case['prompt']
        tools = ['--permission-mode', 'dontAsk', '--allowedTools', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
                 f"Bash({shlex.join(case['cmd'])})"]
        env = {**os.environ, 'WA_STATE_DIR': str(holder / 'state'), 'WA_PORT': port, 'CLAUDE_CONFIG_DIR': str(config)}
        for key in ('WA_EDIT_FILE', 'WA_EDIT_FILES', 'WA_TEST_COMMAND'):
            env.pop(key, None)
        subprocess.run(['node', str(ROOT / 'src/launch.mjs'), '--print', *tools, '--', prompt], cwd=project, env=env,
                       capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
        mock.terminate()
        body = json.loads(out.read_text())
        body['project'] = str(project)
        private_write(cache, json.dumps(body))
        return body
    finally:
        shutil.rmtree(holder, ignore_errors=True)


def task_prompt(case):
    if case.get('synthetic'):
        return case['task']
    return eb.TEMPLATE.format(task=case['task'], command=shlex.join(case['cmd']))


def direct_prompt(case, sources, code, output):
    parts = ['Ignore earlier messages in this chat.', '', case['task'], '',
             'Here are the relevant files and the failing test output. Reply with a concrete patch. For each change, '
             'write the file path on a line starting with FILE:, then the exact original lines in one code block, '
             'then the replacement lines in a second code block.', '']
    for name, text in sources.items():
        parts += [f'FILE: {name}', '```', text.rstrip('\n'), '```', '']
    parts += [f'Running `{shlex.join(case["cmd"])}` fails with exit code {code}:', '```', output, '```']
    return '\n'.join(parts)


def gateway_body(captured, case, project, sources, code, output):
    messages = list(captured['messages'])
    reads = [{'type': 'tool_use', 'id': f'toolu_seed_read_{i}', 'name': 'Read',
              'input': {'file_path': str(project / name), 'offset': 1, 'limit': len(text.splitlines())}}
             for i, (name, text) in enumerate(sources.items())]
    messages.append({'role': 'assistant', 'content': reads})
    messages.append({'role': 'user', 'content': [
        {'type': 'tool_result', 'tool_use_id': call['id'],
         'content': '\n'.join(f'{n}\t{line}' for n, line in enumerate(sources[name].split('\n')[:-1] if sources[name].endswith('\n') else sources[name].split('\n'), 1))}
        for call, name in zip(reads, sources)]})
    messages.append({'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'toolu_seed_test', 'name': 'Bash',
                                                       'input': {'command': shlex.join(case['cmd']), 'description': 'Run the failing test'}}]})
    messages.append({'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'toolu_seed_test', 'is_error': True,
                                                  'content': f'Exit code {code}\n{output}'}]})
    body = {key: value for key, value in captured.items() if key not in ('messages', 'project')}
    body.update(messages=messages, stream=False)
    return body


def parse_direct(reply):
    """FILE: path, then two fenced blocks (original, replacement), repeated."""
    changes = []
    for match in re.finditer(r'^FILE:\s*`?([^\s`]+)`?\s*$', reply, re.M):
        rest = reply[match.end():]
        nxt = re.search(r'^FILE:', rest, re.M)
        section = rest[:nxt.start()] if nxt else rest
        blocks = re.findall(r'```[^\n]*\n(.*?)\n```', section, re.S)
        if len(blocks) >= 2:
            changes.append((match[1], blocks[0], blocks[1]))
    return changes


def apply_direct(project, changes):
    strict, normalized, notes = True, True, []
    for path, original, replacement in changes:
        target = project / path
        if not target.exists():
            notes.append(f'missing file {path}')
            return False, False, notes
        text = target.read_text()
        count = text.count(original)
        if count == 1:
            target.write_text(text.replace(original, replacement, 1))
            continue
        strict = False
        lines, want = text.split('\n'), [line.strip() for line in original.split('\n')]
        hits = [i for i in range(len(lines) - len(want) + 1) if [l.strip() for l in lines[i:i + len(want)]] == want]
        notes.append(f'{path}: exact matches {count}, whitespace-normalized matches {len(hits)}')
        if len(hits) != 1:
            normalized = False
    return strict, strict or normalized, notes


def score_project(case, project, holder, stem):
    patch = subprocess.check_output(['git', 'diff', '--binary'], cwd=project, text=True)
    if not patch.strip():
        return {'changed': False, 'correct': False}
    status = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=project, text=True).splitlines()
    scope = all(line.startswith(' M ') and not eb.EXCLUDED.match(line[3:]) for line in status)
    if case.get('synthetic'):
        visible = subprocess.run(['node', '--test'], cwd=project, capture_output=True).returncode == 0
        judge = "import assert from 'node:assert/strict';\n" + case['judge'].replace('MODULE', json.dumps((project / 'csv.mjs').as_uri()))
        held = subprocess.run(['node', '--input-type=module', '-e', judge], cwd=project, capture_output=True).returncode == 0
        return {'changed': True, 'scope': scope, 'visible': visible, 'held_out': held, 'correct': bool(scope and visible and held)}
    pre = eb.preflight(case, holder)
    judged = eb.score(case, pre, patch, stem, eb.reference_failures(case, holder))
    return {'changed': True, 'scope': scope, **{k: judged.get(k) for k in ('target_pass', 'parity', 'extra', 'correct')},
            'preserve': (judged.get('preserve') or {}).get('ok'), 'correct': bool(scope and judged.get('correct'))}


def run_direct(case, sources, code, output, out, stem):
    prompt = direct_prompt(case, sources, code, output)
    private_write(Path(stem + '-prompt.txt'), prompt)
    begin = time.time()
    reply = gateway('/v1/messages', {'prompt': prompt}, {'x-wa-raw': '1'})
    seconds = round(time.time() - begin, 1)
    text = ''.join(block.get('text', '') for block in reply.get('content', []) if isinstance(block, dict))
    private_write(Path(stem + '-reply.txt'), text or json.dumps(reply))
    holder = Path(tempfile.mkdtemp(prefix='wa-iso-a-'))
    try:
        project = fresh_copy(case, holder)
        changes = parse_direct(text)
        strict, normalized, notes = apply_direct(project, changes) if changes else (False, False, ['no FILE/original/replacement triple'])
        scored = score_project(case, project, out, stem) if strict else {'changed': False, 'correct': False}
        return {'arm': 'A', 'seconds': seconds, 'error': reply.get('error'), 'changes': len(changes),
                'applicable': strict, 'applicable_whitespace_normalized': normalized, 'notes': notes, **scored}
    finally:
        shutil.rmtree(holder, ignore_errors=True)


def run_gateway(case, captured, sources, code, output, out, stem):
    holder = Path(tempfile.mkdtemp(prefix='wa-iso-b-'))
    try:
        project = fresh_copy(case, holder)
        body = gateway_body(captured, case, project, sources, code, output)
        headers = {'x-claude-code-request-class': 'main', 'anthropic-version': '2023-06-01'}
        turns, edits, failed_edits, ended, error = [], 0, 0, None, None
        begin = time.time()
        for _ in range(MAX_EDITS + 1):
            reply = gateway('/v1/messages', body, headers)
            turns.append(reply)
            if reply.get('type') == 'error':
                ended, error = 'gateway error', (reply.get('error') or {}).get('message')
                break
            blocks = reply.get('content', [])
            calls = [b for b in blocks if b.get('type') == 'tool_use']
            if not calls or any(c['name'] not in ('Edit', 'Write') for c in calls) or edits >= MAX_EDITS:
                ended = 'text' if not calls else ('edit cap' if edits >= MAX_EDITS else 'requested ' + calls[0]['name'])
                break
            results = []
            for call in calls:
                path = Path(call['input'].get('file_path', ''))
                path = path if path.is_absolute() else project / path
                ok, message = False, 'File does not exist.'
                if path.exists() and call['name'] == 'Edit':
                    text = path.read_text()
                    count = text.count(call['input'].get('old_string', ''))
                    if count == 1 and call['input']['old_string'] != call['input'].get('new_string'):
                        path.write_text(text.replace(call['input']['old_string'], call['input']['new_string'], 1))
                        ok, message = True, f'The file {path} has been updated successfully.'
                    else:
                        message = 'String to replace not found in file.' if count == 0 else (
                            'No changes to make: old_string and new_string are exactly the same.' if count == 1 else
                            f'Found {count} matches of the string to replace.')
                elif call['name'] == 'Write':
                    path.write_text(call['input'].get('content', ''))
                    ok, message = True, f'File created successfully at: {path}'
                edits += ok
                failed_edits += not ok
                results.append({'type': 'tool_result', 'tool_use_id': call['id'], 'content': message, 'is_error': not ok})
            body['messages'] = body['messages'] + [{'role': 'assistant', 'content': blocks}, {'role': 'user', 'content': results}]
        seconds = round(time.time() - begin, 1)
        private_write(Path(stem + '-turns.json'), json.dumps(turns))
        scored = score_project(case, project, out, stem)
        return {'arm': 'B', 'seconds': seconds, 'error': error, 'ended': ended, 'edits': edits,
                'failed_edits': failed_edits, 'applicable': edits > 0, **scored}
    finally:
        shutil.rmtree(holder, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest', type=Path, required=True, help='dev manifest with eslint-10 and express-20')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--dry-run', action='store_true', help='render both arms and report prompt sizes only')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    os.chmod(args.out, 0o700)
    cases = {c['id']: c for c in json.loads(args.manifest.read_text()) if c['id'] in FILES}
    cases['csv'] = csv_case(args.out)
    for case in cases.values():
        case['prompt'] = task_prompt(case)
    order = ['eslint-10', 'express-20', 'csv']
    inputs = {}
    for cid in order:
        case = cases[cid]
        sources = {name: (Path(case['test_dir']) / name).read_text() for name in FILES[cid]}
        code, output = failing_output(case, args.out)
        captured = capture_claude_request(case, args.out)
        inputs[cid] = (sources, code, output, captured)
        if args.dry_run:
            direct = direct_prompt(case, sources, code, output)
            body = gateway_body(captured, case, Path(captured['project']), sources, code, output)
            rendered = subprocess.run(['node', '--input-type=module', '-e',
                "import {prepare} from " + json.dumps(str(ROOT / 'src/protocol.mjs')) +
                "; let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{try{const r=prepare(JSON.parse(s)); console.log(r.prompt.length)}catch(e){console.log('ERR '+e.message)}});"],
                input=json.dumps(body), text=True, capture_output=True).stdout.strip()
            print(cid, 'direct prompt chars', len(direct), 'gateway prompt chars', rendered, flush=True)
    if args.dry_run:
        return
    for k in range(1, args.repeats + 1):
        for cid in order:
            case = cases[cid]
            sources, code, output, captured = inputs[cid]
            arms = ['A', 'B'] if k % 2 else ['B', 'A']
            for arm in arms:
                stem = str(args.out / f'{cid}-{arm}-r{k}')
                if Path(stem + '.json').exists():
                    continue
                result = (run_direct(case, sources, code, output, args.out, stem) if arm == 'A'
                          else run_gateway(case, captured, sources, code, output, args.out, stem))
                result.update(case=cid, repeat=k, order=''.join(arms))
                private_write(Path(stem + '.json'), json.dumps(result, indent=2))
                print('iso', cid, arm, k, 'applicable', result['applicable'], 'correct', result['correct'],
                      result['seconds'], 's', result.get('ended') or '', (result.get('error') or '')[:80], flush=True)


if __name__ == '__main__':
    main()
