#!/usr/bin/env python3
"""Run a two-task Exercism pilot with the local edit-and-test harness."""

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

from eval_coding import ROOT, exercise

REVISION = "7b49ec415e9169cce4aa0206d2b51ce66d98b9aa"
UPSTREAM = f"https://raw.githubusercontent.com/exercism/problem-specifications/{REVISION}"

TASKS = {
    "alphametics": {
        "task": "Implement solve(puzzle) in alphametics.mjs. Parse a puzzle like SEND + MORE == MONEY. Assign a distinct digit to every letter so the addition holds. Multi-letter words cannot start with zero. Return an object mapping letters to digits, or null if no solution exists. Inputs can contain up to ten letters and hundreds of addends. Keep the named export and use no dependencies.",
        "module": "alphametics.mjs",
        "sources": {"alphametics.mjs": "export function solve(puzzle) {\n  throw new Error('TODO');\n}\n"},
        "entry": "solve",
        "input": "puzzle",
        "visible_cases": {0, 1, 2, 7},
    },
    "book-store": {
        "task": "Implement both book-store.mjs and discount.mjs. A basket is an array of book IDs from 1 through 5. Partition it into groups with distinct IDs and minimize the total price in cents. A book costs 800 cents. Discounts for groups of 1 through 5 are 0%, 5%, 10%, 20%, and 25%. An empty basket costs 0. Implement groupPrice(size) in discount.mjs and use it from cost(basket) in book-store.mjs. Preserve both named exports and use no dependencies.",
        "module": "book-store.mjs",
        "sources": {
            "book-store.mjs": "import { groupPrice } from './discount.mjs';\n\nexport function cost(basket) {\n  throw new Error('TODO');\n}\n",
            "discount.mjs": "export function groupPrice(size) {\n  throw new Error('TODO');\n}\n",
        },
        "entry": "cost",
        "input": "basket",
        "visible_cases": {0, 2, 3, 6, 7, 14},
    },
}


def flatten(cases):
    for case in cases:
        if "cases" in case:
            yield from flatten(case["cases"])
        else:
            yield case


def fixture(name):
    task = TASKS[name]
    with urlopen(f"{UPSTREAM}/exercises/{name}/canonical-data.json", timeout=20) as response:
        cases = list(flatten(json.load(response)["cases"]))
    entry = task["entry"]
    visible = [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        f"import {{ {entry} }} from './{task['module']}';",
    ]
    held_out = [f"const {{ {entry} }} = await import(MODULE);"]
    if name == "book-store":
        visible += [
            "import { groupPrice } from './discount.mjs';",
            "test('group prices by size', () => assert.deepEqual([1,2,3,4,5].map(groupPrice), [800,1520,2160,2560,3000]));",
        ]
    for index, case in enumerate(cases):
        value = json.dumps(case["input"][task["input"]])
        expected = json.dumps(case["expected"])
        assertion = f"assert.deepEqual({entry}({value}), {expected});"
        if index in task["visible_cases"]:
            visible.append(f"test({json.dumps(case['description'])}, () => {{ {assertion} }});")
        else:
            held_out.append(assertion)
    return {**task, "visible": "\n".join(visible) + "\n", "judge": "\n".join(held_out)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", nargs="+", choices=TASKS, default=list(TASKS))
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--output", type=Path, default=ROOT / ".work" / "coding-evals-exercism")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    passed = 0
    for name in args.tasks:
        result = exercise(name, "compact", args.timeout, args.output, "Read,Edit,Bash", True, spec=fixture(name))
        passed += result["passed"]
    print(f"Exercism pilot: {passed}/{len(args.tasks)} passed")


if __name__ == "__main__":
    main()
