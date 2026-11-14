#!/usr/bin/env python3
"""Aggregate live eval results into a Markdown table without raw content.

Reads the per-attempt JSON reports written by eval_bugsjs.py and
eval_coding.py. Only outcome fields are used: no transcripts, prompts,
diffs, or reply text are read or printed. Each attempt gets a failure layer:

  pass        all criteria met
  client      Claude Code refused the action (e.g. permission or isolation)
  decode      the gateway could not decode or validate Meta AI's reply
  identity    an edit named a stale or unknown Read snapshot
  turn        the model ended its turn without a change, or without a passing
              native test after a correct change
  patch       the session ran, but the patch failed independent checks
  context     the prompt exceeded the WhatsApp limit or compaction thrashed
  timeout     the run hit its wall-clock budget
"""
import argparse
import collections
import json
from pathlib import Path


def layer(report):
    if report.get('passed'):
        return 'pass'
    # eval_coding.py stores test output in 'error' and the API error in 'api_error'.
    error = (report.get('api_error') if 'scenario' in report else report.get('error')) or ''
    final = report.get('final') or ''
    if report.get('timed_out'):
        return 'timeout'
    if 'Request too large' in error or 'thrashing' in error or 'Context is' in error:
        return 'context'
    if 'snapshot' in error or 'stale' in error.lower() or 'does not match this request' in error:
        return 'identity'
    if error:
        return 'decode'
    if 'worktree' in final.lower() or 'permission' in final.lower():
        return 'client'
    correct = report.get('patch_correct')
    edits = report.get('edits_ok', report.get('successful_line_edits'))
    if correct is None:  # eval_coding.py
        correct = report.get('visible') and report.get('held_out') and report.get('implementation_only')
    if correct or not edits:
        return 'turn'  # stopped without a change, or without a successful test after it
    return 'patch'


def load(paths):
    rows = []
    for root in paths:
        for path in sorted(Path(root).rglob('*.json')):
            if '.rescore' in path.name or path.name.startswith(('preflight', 'reference', 'manifest')):
                continue
            try:
                report = json.loads(path.read_text())
            except ValueError:
                continue
            if 'case' in report:
                rows.append(dict(batch=report.get('label'), case=report['case'], group=report.get('group') or 'dev',
                                 mode=report.get('mode'), seconds=report.get('seconds'),
                                 correct=bool(report.get('patch_correct')), passed=bool(report.get('passed')),
                                 native=bool(report.get('native_test_pass_after_edit')),
                                 edits=report.get('edits_ok'), compactions=report.get('compactions', 0),
                                 layer=layer(report)))
            elif 'scenario' in report:
                correct = bool(report.get('visible') and report.get('held_out') and report.get('implementation_only'))
                rows.append(dict(batch=path.parent.name, case=report['scenario'], group='synthetic', mode='print',
                                 seconds=report.get('seconds'), correct=correct, passed=bool(report.get('passed')),
                                 native=bool(report.get('passed_tests_after_edit')),
                                 edits=report.get('successful_line_edits'), compactions=0, layer=layer(report)))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('roots', nargs='+', help='result directories')
    args = parser.parse_args()
    rows = load(args.roots)
    print('| batch | case | group | mode | pass | patch correct | native test after edit | edits | compactions | seconds | layer |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for r in sorted(rows, key=lambda r: (str(r['batch']), r['case'])):
        print(f"| {r['batch']} | {r['case']} | {r['group']} | {r['mode']} | {'yes' if r['passed'] else 'no'} | "
              f"{'yes' if r['correct'] else 'no'} | {'yes' if r['native'] else 'no'} | {r['edits']} | "
              f"{r['compactions']} | {r['seconds']} | {r['layer']} |")
    print()
    print('| batch | attempts | pass | patch correct | median seconds | failure layers |')
    print('|---|---|---|---|---|---|')
    by = collections.defaultdict(list)
    for r in rows:
        by[r['batch']].append(r)
    for batch, items in sorted(by.items(), key=lambda kv: str(kv[0])):
        seconds = sorted(r['seconds'] for r in items if r['seconds'] is not None)
        median = seconds[len(seconds) // 2] if seconds else None
        layers = collections.Counter(r['layer'] for r in items if r['layer'] != 'pass')
        print(f"| {batch} | {len(items)} | {sum(r['passed'] for r in items)} | {sum(r['correct'] for r in items)} | "
              f"{median} | {', '.join(f'{k} {v}' for k, v in layers.most_common())} |")


if __name__ == '__main__':
    main()
