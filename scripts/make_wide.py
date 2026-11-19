#!/usr/bin/env python3
"""Build the "wide" task set: larger and different work than single-bug repairs.

  due       JavaScript feature across four modules (store, filter, format, CLI)
  slugs     JavaScript refactor: three private copies of slug logic into one shared module
  invoice   Python bug fixes across modules (discount and tax order, Decimal rounding, money format)
  grades    Python feature across three modules (median, letter grades, parse validation)

Each task gets <dir>/<task>/test (starting project with visible tests),
<dir>/<task>/full (reference, used only to validate) and a held-out judge in
<dir>/judges, run by eval_bugsjs.py as an extra check. Only existing files need
changing (the refactor's target module exists as a stub), as the scorer requires.
Writes <dir>/wide.json and validates: every start fails its visible tests and
its judge; every reference passes both.

    python3 scripts/make_wide.py <dir>
    python3 scripts/eval_bugsjs.py --manifest <dir>/wide.json --out <results> --label wide --budget 600
"""
import json
import subprocess
import sys
from pathlib import Path

NODE = ['node', '--test']
PYTEST = ['python3', '-m', 'pytest', '-q', '-p', 'no:cacheprovider']

DUE_TASK = (
    'Add due dates to this task tracker. (1) store.add(title, {tags, due}) accepts an optional due date in the form '
    'YYYY-MM-DD and keeps it as the task\'s `due` field; tasks without one have `due: null`. A due date that is not a '
    'real calendar date in that form throws an Error whose message contains "invalid date". (2) The list filter accepts '
    '`overdue: true` together with `today` (YYYY-MM-DD): it keeps open tasks whose due date is before today. A task due '
    'today is not overdue, and done tasks never are. (3) formatTask(task, {today}) appends " (due YYYY-MM-DD)" after the '
    'title and tags when the task has a due date, then " [overdue]" when today is given and the task is overdue. '
    '(4) The CLI accepts `add <title words> --due <date>` and `list --overdue --today <date>`; whenever --today is '
    'given, listed lines carry the [overdue] marker. Keep the existing exports and behavior.')

SLUG_TASK = (
    'src/posts.mjs, src/tags.mjs and src/users.mjs each build URL slugs with their own inconsistent copy of the same '
    'logic. Refactor: implement and export slugify(text) in src/slug.mjs, and make postSlug, tagSlug and userHandle use '
    'it, removing their private slug code. slugify trims, lowercases, turns every run of characters other than a-z and '
    '0-9 into a single "-", strips leading and trailing "-", and returns "untitled" when nothing is left. userHandle keeps '
    'its "@" prefix and its "@user<id>" fallback, used when slugify returns "untitled". Keep all exports and URL formats.')

INVOICE_TASK = (
    'Fix the invoice calculations and formatting. For each line: the discount applies to the subtotal first, and the '
    'discounted subtotal is rounded half-up to cents; tax is then computed on that rounded amount and rounded half-up '
    'to cents separately; the line total is their sum. Use Decimal arithmetic throughout (no floats). The invoice total '
    'is the sum of the line totals. An unknown region raises ValueError("unknown region: <code>"). money() renders '
    'amounts like $1,234.50, with a leading minus for negative amounts (-$5.00), always with two decimals, rounding '
    'half-up.')

GRADES_TASK = (
    'Extend the gradebook. (1) stats.median(scores) returns the middle value, or the mean of the two middle values for '
    'an even count, and raises ValueError for an empty list. (2) stats.letter(score) returns "A" for 90 and above, "B" '
    'for 80 and above, "C" for 70 and above, "D" for 60 and above, otherwise "F". (3) report() lists each student as '
    '"name: score (letter)" and ends with a "mean: X" line and then a "median: X" line, each with one decimal. '
    '(4) parse() skips blank lines and surrounding whitespace, and raises ValueError mentioning "line N" (1-based, '
    'counting blank lines) for a row that is not a name and a numeric score separated by a comma. Keep parse\'s '
    'return type (a list of (name, float) pairs).')

PACKAGE = '{"name": "%s", "private": true, "type": "module", "scripts": {"test": "node --test"}}\n'
PYPROJECT = '[project]\nname = "%s"\nversion = "0.1.0"\nrequires-python = ">=3.9"\n'
AGENTS_JS = 'Plain Node.js ES modules, no dependencies. Tests: node --test. Do not modify package.json or files under test/.\n'
AGENTS_PY = 'Plain Python 3, standard library only. Tests: python3 -m pytest -q. Do not modify pyproject.toml or files under tests/.\n'

TASKS = {}

TASKS['due'] = dict(kind='js', task=DUE_TASK, files={
    'src/store.mjs': ('''import { selectTasks } from './filter.mjs';

export function createStore() {
  const tasks = [];
  let next = 1;
  return {
    add(title, { tags = [] } = {}) {
      if (!title || !title.trim()) throw new Error('title required');
      const task = { id: next++, title: title.trim(), tags: [...tags], done: false };
      tasks.push(task);
      return { ...task };
    },
    complete(id) {
      const task = tasks.find(t => t.id === id);
      if (!task) throw new Error('no task ' + id);
      task.done = true;
    },
    list(filter = {}) {
      return selectTasks(tasks, filter).map(t => ({ ...t }));
    },
  };
}
''', '''import { selectTasks } from './filter.mjs';

function checkDate(value) {
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(typeof value === 'string' ? value : '');
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error('invalid date: ' + value);
  return value;
}

export function createStore() {
  const tasks = [];
  let next = 1;
  return {
    add(title, { tags = [], due = null } = {}) {
      if (!title || !title.trim()) throw new Error('title required');
      const task = { id: next++, title: title.trim(), tags: [...tags], done: false, due: due == null ? null : checkDate(due) };
      tasks.push(task);
      return { ...task };
    },
    complete(id) {
      const task = tasks.find(t => t.id === id);
      if (!task) throw new Error('no task ' + id);
      task.done = true;
    },
    list(filter = {}) {
      return selectTasks(tasks, filter).map(t => ({ ...t }));
    },
  };
}
'''),
    'src/filter.mjs': ('''export function selectTasks(tasks, { status = 'all', tag } = {}) {
  return tasks.filter(t =>
    (status === 'all' || (status === 'open' ? !t.done : t.done)) &&
    (tag === undefined || t.tags.includes(tag)));
}
''', '''export function isOverdue(task, today) {
  return !task.done && Boolean(task.due) && Boolean(today) && task.due < today;
}

export function selectTasks(tasks, { status = 'all', tag, overdue = false, today } = {}) {
  return tasks.filter(t =>
    (status === 'all' || (status === 'open' ? !t.done : t.done)) &&
    (tag === undefined || t.tags.includes(tag)) &&
    (!overdue || isOverdue(t, today)));
}
'''),
    'src/format.mjs': ('''export function formatTask(task) {
  const box = task.done ? '[x]' : '[ ]';
  const tags = task.tags.length ? ' #' + task.tags.join(' #') : '';
  return `${box} ${task.id}. ${task.title}${tags}`;
}
''', '''import { isOverdue } from './filter.mjs';

export function formatTask(task, { today } = {}) {
  const box = task.done ? '[x]' : '[ ]';
  const tags = task.tags.length ? ' #' + task.tags.join(' #') : '';
  const due = task.due ? ` (due ${task.due})` : '';
  const late = today && isOverdue(task, today) ? ' [overdue]' : '';
  return `${box} ${task.id}. ${task.title}${tags}${due}${late}`;
}
'''),
    'src/cli.mjs': ('''import { formatTask } from './format.mjs';

// run(store, argv) returns the output lines.
export function run(store, argv) {
  const [command, ...rest] = argv;
  if (command === 'add') {
    const tags = [];
    const words = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--tag') tags.push(rest[++i]);
      else words.push(rest[i]);
    }
    const task = store.add(words.join(' '), { tags });
    return [`added ${task.id}`];
  }
  if (command === 'done') {
    store.complete(Number(rest[0]));
    return [`completed ${rest[0]}`];
  }
  if (command === 'list') {
    const filter = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--open') filter.status = 'open';
      else if (rest[i] === '--done') filter.status = 'done';
      else if (rest[i] === '--tag') filter.tag = rest[++i];
    }
    return store.list(filter).map(task => formatTask(task));
  }
  throw new Error('unknown command ' + command);
}
''', '''import { formatTask } from './format.mjs';

// run(store, argv) returns the output lines.
export function run(store, argv) {
  const [command, ...rest] = argv;
  if (command === 'add') {
    const tags = [];
    const words = [];
    let due = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--tag') tags.push(rest[++i]);
      else if (rest[i] === '--due') due = rest[++i];
      else words.push(rest[i]);
    }
    const task = store.add(words.join(' '), { tags, due });
    return [`added ${task.id}`];
  }
  if (command === 'done') {
    store.complete(Number(rest[0]));
    return [`completed ${rest[0]}`];
  }
  if (command === 'list') {
    const filter = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--open') filter.status = 'open';
      else if (rest[i] === '--done') filter.status = 'done';
      else if (rest[i] === '--tag') filter.tag = rest[++i];
      else if (rest[i] === '--overdue') filter.overdue = true;
      else if (rest[i] === '--today') filter.today = rest[++i];
    }
    return store.list(filter).map(task => formatTask(task, { today: filter.today }));
  }
  throw new Error('unknown command ' + command);
}
'''),
}, tests={
    'test/basic.test.mjs': '''import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { run } from '../src/cli.mjs';

test('add, complete and filter by status and tag', () => {
  const s = createStore();
  s.add('write report', { tags: ['work'] });
  s.add('buy milk');
  s.complete(2);
  assert.deepEqual(s.list({ status: 'open' }).map(t => t.title), ['write report']);
  assert.deepEqual(s.list({ tag: 'work' }).map(t => t.id), [1]);
});

test('cli lists with tags and checkboxes', () => {
  const s = createStore();
  assert.deepEqual(run(s, ['add', 'call', 'mom', '--tag', 'home']), ['added 1']);
  run(s, ['done', '1']);
  assert.deepEqual(run(s, ['list']), ['[x] 1. call mom #home']);
});
''',
    'test/due.test.mjs': '''import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { formatTask } from '../src/format.mjs';

test('a due date is kept and shown', () => {
  const s = createStore();
  const t = s.add('pay rent', { due: '2026-03-01' });
  assert.equal(t.due, '2026-03-01');
  assert.equal(formatTask(t), '[ ] 1. pay rent (due 2026-03-01)');
});

test('an impossible date is rejected', () => {
  assert.throws(() => createStore().add('x', { due: '2026-02-30' }), /invalid date/);
});
''',
}, judge='''const s = (await mod('src/store.mjs')).createStore();
const { formatTask } = await mod('src/format.mjs');
const { run } = await mod('src/cli.mjs');
check('no due date gives null', s.add('a').due === null);
s.add('b', { due: '2026-01-10', tags: ['x'] });
s.add('c', { due: '2026-01-15' });
s.add('d', { due: '2026-01-05' });
s.complete(4);
const over = s.list({ overdue: true, today: '2026-01-15' }).map(t => t.id);
check('overdue: before today, open, has a due date', JSON.stringify(over) === '[2]');
check('overdue combines with tag', s.list({ overdue: true, today: '2026-01-15', tag: 'x' }).length === 1 &&
  s.list({ overdue: true, today: '2026-01-15', tag: 'y' }).length === 0);
const b = s.list({ tag: 'x' })[0];
check('format with tags, due and overdue', formatTask(b, { today: '2026-01-11' }) === '[ ] 2. b #x (due 2026-01-10) [overdue]');
check('format not overdue on the due date', formatTask(b, { today: '2026-01-10' }) === '[ ] 2. b #x (due 2026-01-10)');
check('format without today has no marker', formatTask(b) === '[ ] 2. b #x (due 2026-01-10)');
for (const bad of ['2026-2-03', '2026-13-01', 'tomorrow', '2025-02-29']) {
  let message = '';
  try { s.add('bad', { due: bad }); } catch (e) { message = String(e.message); }
  check('rejects ' + bad, /invalid date/.test(message));
}
check('accepts a leap day', s.add('leap', { due: '2028-02-29' }).due === '2028-02-29');
const c = (await mod('src/store.mjs')).createStore();
check('cli add --due', JSON.stringify(run(c, ['add', 'file', 'taxes', '--due', '2026-04-15', '--tag', 'money'])) === '["added 1"]');
run(c, ['add', 'later', '--due', '2026-05-01']);
check('cli list --overdue --today', JSON.stringify(run(c, ['list', '--overdue', '--today', '2026-04-20'])) ===
  '["[ ] 1. file taxes #money (due 2026-04-15) [overdue]"]');
check('cli list --today marks overdue lines', JSON.stringify(run(c, ['list', '--today', '2026-04-20'])) ===
  '["[ ] 1. file taxes #money (due 2026-04-15) [overdue]","[ ] 2. later (due 2026-05-01)"]');
check('list returns copies', (() => { const t = c.list()[0]; t.due = 'x'; return c.list()[0].due === '2026-04-15'; })());
''')

TASKS['slugs'] = dict(kind='js', task=SLUG_TASK, files={
    'src/slug.mjs': ('''// Shared text helpers.
export {};
''', '''// Shared text helpers.
export function slugify(text) {
  const slug = String(text ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}
'''),
    'src/posts.mjs': ('''export function postSlug(post) {
  return post.title.toLowerCase().split(' ').join('-');
}

export function postUrl(post) {
  return `/posts/${post.id}/${postSlug(post)}`;
}
''', '''import { slugify } from './slug.mjs';

export function postSlug(post) {
  return slugify(post.title);
}

export function postUrl(post) {
  return `/posts/${post.id}/${postSlug(post)}`;
}
'''),
    'src/tags.mjs': ('''export function tagSlug(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '-');
}

export function tagUrl(name) {
  return '/tags/' + tagSlug(name);
}
''', '''import { slugify } from './slug.mjs';

export function tagSlug(name) {
  return slugify(name);
}

export function tagUrl(name) {
  return '/tags/' + tagSlug(name);
}
'''),
    'src/users.mjs': ('''export function userHandle(user) {
  const base = (user.displayName || '').toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return '@' + (base || 'user' + user.id);
}
''', '''import { slugify } from './slug.mjs';

export function userHandle(user) {
  const slug = slugify(user.displayName);
  return '@' + (slug === 'untitled' ? 'user' + user.id : slug);
}
'''),
}, tests={
    'test/slug.test.mjs': '''import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.mjs';
import { postUrl } from '../src/posts.mjs';
import { tagUrl } from '../src/tags.mjs';
import { userHandle } from '../src/users.mjs';

test('slugify basics', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  A  B '), 'a-b');
});

test('modules keep their formats', () => {
  assert.equal(postUrl({ id: 4, title: 'First Post' }), '/posts/4/first-post');
  assert.equal(tagUrl('news'), '/tags/news');
  assert.equal(userHandle({ id: 1, displayName: 'Ann' }), '@ann');
});
''',
}, judge='''const { slugify } = await mod('src/slug.mjs');
const { postSlug, postUrl } = await mod('src/posts.mjs');
const { tagSlug } = await mod('src/tags.mjs');
const { userHandle } = await mod('src/users.mjs');
const cases = [['C++ & Rust!', 'c-rust'], ['---', 'untitled'], ['', 'untitled'], ['  Two   Spaces  ', 'two-spaces'], ['a_b.c', 'a-b-c'], ['Version 2.0', 'version-2-0']];
for (const [input, want] of cases) check(`slugify(${JSON.stringify(input)})`, slugify(input) === want);
check('postSlug uses the shared rules', postSlug({ title: '  Hello,  World ' }) === 'hello-world');
check('postUrl', postUrl({ id: 7, title: 'Why?' }) === '/posts/7/why');
check('tagSlug uses the shared rules', tagSlug('Node.js') === 'node-js' && tagSlug(' -x- ') === 'x');
check('userHandle', userHandle({ id: 3, displayName: 'Ann  Lee!' }) === '@ann-lee');
check('userHandle fallback', userHandle({ id: 7, displayName: '!!!' }) === '@user7' && userHandle({ id: 9 }) === '@user9');
for (const file of ['src/posts.mjs', 'src/tags.mjs', 'src/users.mjs']) {
  const text = source(file);
  check(file + ' imports slugify from ./slug.mjs', /import\\s*\\{[^}]*\\bslugify\\b[^}]*\\}\\s*from\\s*['"]\\.\\/slug\\.mjs['"]/.test(text));
  check(file + ' has no private slug code', !/toLowerCase|\\.replace\\(|\\.split\\(/.test(text));
}
''')

TASKS['invoice'] = dict(kind='py', task=INVOICE_TASK, files={
    'invoice/__init__.py': ('', ''),
    'invoice/models.py': ('''from dataclasses import dataclass
from decimal import Decimal


@dataclass
class Line:
    description: str
    quantity: int
    unit_price: Decimal
    discount: Decimal = Decimal("0")  # a fraction: Decimal("0.10") is 10 percent

    def subtotal(self):
        return self.quantity * self.unit_price
''', None),
    'invoice/tax.py': ('''from decimal import Decimal

RATES = {"CA": Decimal("0.0725"), "NY": Decimal("0.04"), "OR": Decimal("0")}


def line_total(line, region):
    """Total for one line, tax included."""
    rate = RATES[region]
    taxed = float(line.subtotal()) * (1 + float(rate))
    return Decimal(str(round(taxed * (1 - float(line.discount)), 2)))


def invoice_total(lines, region):
    return sum((line_total(line, region) for line in lines), Decimal("0"))
''', '''from decimal import Decimal, ROUND_HALF_UP

RATES = {"CA": Decimal("0.0725"), "NY": Decimal("0.04"), "OR": Decimal("0")}
CENT = Decimal("0.01")


def cents(amount):
    return Decimal(amount).quantize(CENT, rounding=ROUND_HALF_UP)


def line_total(line, region):
    """Total for one line, tax included."""
    if region not in RATES:
        raise ValueError(f"unknown region: {region}")
    discounted = cents(line.subtotal() * (1 - line.discount))
    return discounted + cents(discounted * RATES[region])


def invoice_total(lines, region):
    return sum((line_total(line, region) for line in lines), Decimal("0"))
'''),
    'invoice/render.py': ('''from .tax import invoice_total, line_total


def money(amount):
    return "$" + format(amount, ".2f")


def render(lines, region):
    out = [f"{line.description}: {money(line_total(line, region))}" for line in lines]
    out.append("Total: " + money(invoice_total(lines, region)))
    return "\\n".join(out)
''', '''from .tax import cents, invoice_total, line_total


def money(amount):
    sign = "-" if amount < 0 else ""
    return f"{sign}${cents(abs(amount)):,.2f}"


def render(lines, region):
    out = [f"{line.description}: {money(line_total(line, region))}" for line in lines]
    out.append("Total: " + money(invoice_total(lines, region)))
    return "\\n".join(out)
'''),
}, tests={
    'tests/test_invoice.py': '''from decimal import Decimal

from invoice.models import Line
from invoice.render import money
from invoice.tax import line_total


def test_simple_line():
    assert line_total(Line("pen", 2, Decimal("1.50")), "OR") == Decimal("3.00")


def test_half_up_to_cents():
    assert line_total(Line("a", 1, Decimal("2.675")), "OR") == Decimal("2.68")


def test_money_groups_thousands():
    assert money(Decimal("1234.5")) == "$1,234.50"
''',
}, judge='''from decimal import Decimal
from invoice.models import Line
from invoice.tax import line_total, invoice_total
from invoice.render import money, render
D = Decimal
check("discount then tax, each rounded", line_total(Line("a", 3, D("9.99"), D("0.10")), "CA") == D("28.93"))
check("tax on the rounded discounted amount", line_total(Line("b", 1, D("0.15"), D("0.5")), "CA") == D("0.09"))
check("half-up on discounted subtotal", line_total(Line("c", 1, D("1.01"), D("0.5")), "OR") == D("0.51"))
check("half-up tax", line_total(Line("d", 1, D("10.10")), "NY") == D("10.50"))
check("total is the sum of rounded lines", invoice_total([Line("e", 1, D("0.07"))] * 3, "CA") == D("0.24"))
check("result is a Decimal", isinstance(line_total(Line("f", 1, D("1")), "NY"), Decimal))
try:
    line_total(Line("g", 1, D("1")), "TX")
    check("unknown region raises ValueError", False)
except ValueError as e:
    check("unknown region message", str(e) == "unknown region: TX")
except Exception:
    check("unknown region raises ValueError", False)
check("money negative", money(D("-5")) == "-$5.00")
check("money millions", money(D("1234567.891")) == "$1,234,567.89")
check("money half-up", money(D("0.125")) == "$0.13")
check("money zero", money(D("0")) == "$0.00")
check("render", render([Line("Widget", 2, D("600.00"))], "NY") == "Widget: $1,248.00\\nTotal: $1,248.00")
''')

TASKS['grades'] = dict(kind='py', task=GRADES_TASK, files={
    'gradebook/__init__.py': ('', ''),
    'gradebook/parse.py': ('''def parse(text):
    """Rows of "name,score" -> list of (name, float)."""
    rows = []
    for line in text.splitlines():
        name, score = line.split(",")
        rows.append((name.strip(), float(score)))
    return rows
''', '''def parse(text):
    """Rows of "name,score" -> list of (name, float)."""
    rows = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        parts = line.split(",")
        try:
            if len(parts) != 2 or not parts[0].strip():
                raise ValueError
            rows.append((parts[0].strip(), float(parts[1])))
        except ValueError:
            raise ValueError(f"line {number}: expected name,score") from None
    return rows
'''),
    'gradebook/stats.py': ('''def mean(scores):
    return sum(scores) / len(scores)
''', '''def mean(scores):
    return sum(scores) / len(scores)


def median(scores):
    if not scores:
        raise ValueError("median of no scores")
    ordered = sorted(scores)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def letter(score):
    for cutoff, grade in ((90, "A"), (80, "B"), (70, "C"), (60, "D")):
        if score >= cutoff:
            return grade
    return "F"
'''),
    'gradebook/report.py': ('''from .parse import parse
from .stats import mean


def report(text):
    rows = parse(text)
    lines = [f"{name}: {score:g}" for name, score in rows]
    lines.append(f"mean: {mean([s for _, s in rows]):.1f}")
    return "\\n".join(lines)
''', '''from .parse import parse
from .stats import letter, mean, median


def report(text):
    rows = parse(text)
    scores = [s for _, s in rows]
    lines = [f"{name}: {score:g} ({letter(score)})" for name, score in rows]
    lines.append(f"mean: {mean(scores):.1f}")
    lines.append(f"median: {median(scores):.1f}")
    return "\\n".join(lines)
'''),
}, tests={
    'tests/test_grades.py': '''from gradebook.report import report
from gradebook.stats import median


def test_median_odd_and_even():
    assert median([3, 1, 2]) == 2
    assert median([4, 1, 3, 2]) == 2.5


def test_report():
    assert report("ann,91\\nbob,78") == "ann: 91 (A)\\nbob: 78 (C)\\nmean: 84.5\\nmedian: 84.5"
''',
}, judge='''from gradebook.parse import parse
from gradebook.stats import letter, median, mean
from gradebook.report import report
check("median single", median([7]) == 7)
check("median unsorted even", median([10, 2, 8, 4]) == 6)
try:
    median([])
    check("median empty raises ValueError", False)
except ValueError:
    check("median empty raises ValueError", True)
for score, grade in ((100, "A"), (90, "A"), (89.99, "B"), (80, "B"), (79.5, "C"), (70, "C"), (60, "D"), (59.9, "F"), (0, "F")):
    check(f"letter({score})", letter(score) == grade)
check("parse skips blanks and spaces", parse("  ann , 90 \\n\\n bob,70.5\\n") == [("ann", 90.0), ("bob", 70.5)])
for text, number in (("ann,90\\n\\ncat,abc", 3), ("ann,90\\nbob", 2), ("ann,90,1", 1), (",80", 1)):
    try:
        parse(text)
        check(f"parse error for {text!r}", False)
    except ValueError as e:
        check(f"parse error names line {number}", f"line {number}" in str(e))
check("report", report("ann,95\\n\\nbob,61\\ncy,82.5\\n") ==
      "ann: 95 (A)\\nbob: 61 (D)\\ncy: 82.5 (B)\\nmean: 79.5\\nmedian: 82.5")
check("mean unchanged", mean([1, 2]) == 1.5)
''')

JS_JUDGE = '''// Held-out judge. Usage: node <this file> <project>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const project = process.argv[2];
const mod = file => import(pathToFileURL(join(project, file)).href + '?' + Math.random());
const source = file => readFileSync(join(project, file), 'utf8');
let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.log('FAIL', name); } };
try {
%s
} catch (e) { failed++; console.log('FAIL error', e && e.message); }
console.log(failed ? `${failed} checks failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
'''

PY_JUDGE = '''# Held-out judge. Usage: python3 <this file> <project>
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
failed = 0


def check(name, ok):
    global failed
    if not ok:
        failed += 1
        print("FAIL", name)


try:
%s
except Exception as e:  # an import or API error fails the judge
    failed += 1
    print("FAIL error", type(e).__name__, e)
print(f"{failed} checks failed" if failed else "all checks passed")
sys.exit(1 if failed else 0)
'''


def build(root):
    (root / 'judges').mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, spec in TASKS.items():
        js = spec['kind'] == 'js'
        for variant in ('test', 'full'):
            project = root / name / variant
            (project / 'node_modules').mkdir(parents=True, exist_ok=True)
            (project / ('package.json' if js else 'pyproject.toml')).write_text((PACKAGE if js else PYPROJECT) % name)
            (project / 'AGENTS.md').write_text(AGENTS_JS if js else AGENTS_PY)
            if not js:
                (project / '.gitignore').write_text('__pycache__/\n')
            for path, (start, reference) in {**spec['files'], **{p: (t, t) for p, t in spec['tests'].items()}}.items():
                text = start if variant == 'test' or reference is None else reference
                (project / path).parent.mkdir(parents=True, exist_ok=True)
                (project / path).write_text(text)
        body = '\n'.join(('' if not line else '  ' if js else '    ') + line for line in spec['judge'].strip('\n').split('\n'))
        judge = root / 'judges' / (name + ('.mjs' if js else '.py'))
        judge.write_text((JS_JUDGE if js else PY_JUDGE) % body)
        cmd = NODE if js else PYTEST
        manifest.append({'id': 'wide-' + name, 'group': 'wide', 'test_dir': str(root / name / 'test'),
                         'full_dir': str(root / name / 'full'), 'cmd': cmd, 'broader': cmd, 'preserve': cmd,
                         'extra': [['node' if js else 'python3', str(judge), '{project}']], 'task': spec['task']})
    (root / 'wide.json').write_text(json.dumps(manifest, indent=1) + '\n')
    return manifest


def validate(manifest):
    ok = True
    for case in manifest:
        for variant, want in (('test_dir', False), ('full_dir', True)):
            project = case[variant]
            visible = subprocess.run(case['cmd'], cwd=project, capture_output=True).returncode == 0
            judge = subprocess.run([part.replace('{project}', project) for part in case['extra'][0]],
                                   capture_output=True, text=True)
            fails = judge.stdout.count('FAIL')
            print(case['id'], variant.split('_')[0], 'visible', visible, 'judge', judge.returncode == 0, f'({fails} failed checks)')
            ok &= visible == want and (judge.returncode == 0) == want
    return ok


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = Path(sys.argv[1]).resolve()
    sys.exit(0 if validate(build(root)) else 1)


if __name__ == '__main__':
    main()
