#!/usr/bin/env python3
"""Small live integration exercises, not a coding benchmark.
Uses the paired WhatsApp account. Projects and logs are disposable/ignored.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = {
    "cache": {
        "task": "Fix TTLCache so all stored values (including false and zero) work, expiration happens at the exact deadline, and setting an existing key refreshes its deadline. Preserve the API. Inspect the project instructions, fix the implementation, and run its tests.",
        "module": "cache.mjs",
        "source": '''export class TTLCache {
  constructor(now = Date.now) { this.now = now; this.entries = new Map(); }
  set(key, value, ttl) {
    if (!this.entries.has(key)) this.entries.set(key, { value, expires: this.now() + ttl });
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry || !entry.value) return undefined;
    if (this.now() > entry.expires) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
}
''',
        "visible": '''import test from 'node:test';
import assert from 'node:assert/strict';
import { TTLCache } from './cache.mjs';
test('falsy values', () => {
 const c = new TTLCache(() => 0); c.set('x', false, 10);
 assert.equal(c.get('x'), false);
});
test('expires at deadline', () => {
 let now = 0; const c = new TTLCache(() => now); c.set('x', 4, 10);
 now = 10; assert.equal(c.get('x'), undefined);
});
test('replacement refreshes deadline', () => {
 let now = 0; const c = new TTLCache(() => now); c.set('x', 1, 10);
 now = 5; c.set('x', 2, 20); now = 15; assert.equal(c.get('x'), 2);
});
''',
        "judge": '''const {TTLCache} = await import(MODULE);
for (const value of [false,0,'',null]) {
 let now=100; const c=new TTLCache(()=>now);
 c.set('x',value,5); assert.deepEqual(c.get('x'),value);
 now=105; assert.equal(c.get('x'),undefined);
}
let now=0; const c=new TTLCache(()=>now); c.set('x',7,20);
now=3; c.set('x',8,2); now=5; assert.equal(c.get('x'),undefined);
c.set('zero',1,0); assert.equal(c.get('zero'),undefined);
assert.equal(c.get('missing'),undefined);
''',
    },
    "csv": {
        "task": "Implement parseCSV with comma-separated fields, quoted commas, doubled quote escapes, CRLF or LF row endings, and newlines inside quoted fields. Preserve empty fields and omit the extra row after a final newline. Empty input returns []; an unclosed quoted field throws. Keep the existing named export and add no dependencies. Inspect project instructions, implement the feature, and run tests.",
        "module": "csv.mjs",
        "source": '''export function parseCSV(text) {
  return text.split('\\n').map(line => line.split(','));
}
''',
        "visible": '''import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from './csv.mjs';
test('plain rows',()=>assert.deepEqual(parseCSV('a,b\\nc,d'),[['a','b'],['c','d']]));
test('quoted comma',()=>assert.deepEqual(parseCSV('"a,b",c'),[['a,b','c']]));
test('escaped quotes',()=>assert.deepEqual(parseCSV('"say ""hi""",x'),[['say "hi"','x']]));
test('final newline',()=>assert.deepEqual(parseCSV('a,b\\n'),[['a','b']]));
''',
        "judge": '''const {parseCSV} = await import(MODULE);
assert.deepEqual(parseCSV(''),[]);
assert.deepEqual(parseCSV(',,'),[['','','']]);
assert.deepEqual(parseCSV('a,b\\r\\nc,d\\r\\n'),[['a','b'],['c','d']]);
assert.deepEqual(parseCSV('"first\\nsecond",x\\n'),[['first\\nsecond','x']]);
assert.deepEqual(parseCSV('"","a""b",'),[['','a"b','']]);
assert.throws(()=>parseCSV('"unterminated'));
''',
    },
}

def run_test(project, spec):
    visible = subprocess.run(["node", "--test"], cwd=project, capture_output=True, text=True, timeout=20)
    judge = "import assert from 'node:assert/strict';\n" + spec["judge"].replace("MODULE", json.dumps((project / spec["module"]).as_uri()))
    hidden = subprocess.run(["node", "--input-type=module", "-e", judge], cwd=project, capture_output=True, text=True, timeout=20)
    return {"visible": visible.returncode == 0, "held_out": hidden.returncode == 0,
            "error": (visible.stderr + hidden.stderr)[-2000:]}

def exercise(name, mode, timeout, output):
    spec = SCENARIOS[name]
    holder = Path(tempfile.mkdtemp(prefix="whatsapp-code-eval-"))
    project = holder / "project"; project.mkdir()
    instructions = "Keep the existing named exports. Add no dependencies. Do not modify package.json or supplied *.test.mjs files. Change only the implementation module. Run node --test before reporting completion.\n"
    fixed = {"AGENTS.md": instructions, "package.json": '{"private":true,"type":"module"}\n', "behavior.test.mjs": spec["visible"]}
    for filename, content in {**fixed, spec["module"]: spec["source"]}.items():
        (project / filename).write_text(content)
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    subprocess.run(["git", "add", "."], cwd=project, check=True)
    subprocess.run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], cwd=project, check=True)
    baseline = run_test(project, spec)
    assert not (baseline["visible"] and baseline["held_out"]), "fixture must fail before edits"
    env = os.environ.copy(); env["CLAUDE_CONFIG_DIR"] = str(holder / "claude-config")
    command = ["node", str(ROOT / "src/launch.mjs"), "--harness-prompt", mode,
               "--print", "--verbose", "--output-format", "stream-json",
               "--no-session-persistence", "--restricted", "--permission-mode", "dontAsk",
               "--tools", "Read,Edit,Write,Glob,Grep,Bash",
               "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep",
               "Bash(node --test*)", "Bash(git diff*)", "Bash(ls*)", "Bash(pwd)",
               "--", spec["task"]]
    start = time.monotonic()
    timed_out = False
    try:
        print('running ' + mode + '/' + name, flush=True)
        proc = subprocess.Popen(command, cwd=project, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                stdout, stderr = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                stdout, stderr = proc.communicate()
        code = proc.returncode
        events = []
        for line in stdout.splitlines():
            try: events.append(json.loads(line))
            except json.JSONDecodeError: pass
        calls = []
        for event in events:
            if event.get("type") == "assistant":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "tool_use":
                        calls.append({"name": block["name"], "input": block.get("input", {})})
        checked = run_test(project, spec)
        instructions_kept = all((project / f).read_text() == text for f, text in fixed.items())
        tested = any(c["name"] == "Bash" and "node --test" in c["input"].get("command", "") for c in calls)
        read_instructions = any(c["name"] == "Read" and str(c["input"].get("file_path", "")).endswith("AGENTS.md") for c in calls)
        usage = [e.get("message", {}).get("usage", {}).get("input_tokens", 0) for e in events if e.get("type") == "assistant"]
        result = {
            "scenario": name, "prompt": mode, "exit_code": code, "timed_out": timed_out,
            "seconds": round(time.monotonic() - start, 1), **checked,
            "instructions_kept": instructions_kept, "read_instructions": read_instructions,
            "ran_tests": tested, "tool_calls": [c["name"] for c in calls],
            "max_estimated_input_tokens": max(usage, default=0),
            "passed": code == 0 and checked["visible"] and checked["held_out"] and instructions_kept and tested,
            "stderr_tail": stderr[-1800:],
        }
        stem = mode + "-" + name
        (output / (stem + ".json")).write_text(json.dumps(result, indent=2) + "\n")
        (output / (stem + ".jsonl")).write_text(stdout)
        (output / (stem + ".diff")).write_text(subprocess.run(["git", "diff"], cwd=project, capture_output=True, text=True).stdout)
        print(json.dumps({k:v for k,v in result.items() if k not in ["error", "stderr_tail"]}), flush=True)
        if not result["passed"]:
            print("failure detail: " + (stderr[-700:] or stdout[-1000:]), flush=True)
        return result
    finally:
        shutil.rmtree(holder)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompts", nargs="+", choices=["compact", "coding", "native"], default=["compact", "coding"])
    parser.add_argument("--tasks", nargs="+", choices=list(SCENARIOS), default=list(SCENARIOS))
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--output", type=Path, default=ROOT / ".work" / "coding-evals")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for mode in args.prompts:
        for name in args.tasks:
            exercise(name, mode, args.timeout, args.output)
