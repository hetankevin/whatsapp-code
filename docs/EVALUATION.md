# Live evaluation: WhatsApp Meta AI as the Claude Code model

This report measures whether consumer WhatsApp Meta AI, reached through this gateway, is a usable model for ordinary Claude Code coding sessions. Claude Code runs natively throughout: it executes every tool, applies its own permission rules (`dontAsk` with an explicit allow list), owns the transcript, and performs compaction and resume. Every scored attempt uses only Meta AI through `src/launch.mjs`.

Raw chats, prompts, transcripts, candidate diffs, fixture copies, reply diagnostics, credentials, and pairing material stay local and are not published. This page reports outcomes only.

## Setup

| Item | Value |
|---|---|
| Machine | macOS arm64 |
| Node | 22.23.2 |
| Claude Code | 2.1.325 (auto-updated from 2.1.322 before the first scored run; every scored run's init event reports 2.1.325) |
| Go (transport build) | 1.26.11 |
| Bot | 867051314767696@bot (Meta AI) |
| Baseline adapter | 7e33e34 |
| Frozen revisions | G = acc16dc, H = 08bda71 (default-mode gateway identical to 2337fbd); later revision I = 8736083 |
| Client context window | 26,000 tokens (launcher default) |
| WhatsApp prompt cap | 60,000 characters |

## Cases

Dev cases (used while fixing the gateway):

| Case | Project | Upstream fix | Target command |
|---|---|---|---|
| express-10, 11, 13, 14, 17, 20 | BugsJS Express | 1 file each | the affected Mocha file (Express 17 with `--grep`) |
| eslint-10 | BugsJS ESLint | 2 files | the two config test files with `--grep` |
| csv, cache | synthetic (`scripts/eval_coding.py`) | 1 file each | `node --test` plus held-out judges |
| synth-two | synthetic, both modules in one project | 2 files | `node --test` plus both held-out judges |

Sealed holdouts (prepared by a separate agent, run once after the gateway was frozen, never inspected during fixes): Express 1, 4, 23; ESLint 3, 19; hessian.js 2, 7 (the hessian.js fixes touch two files each). Their task text is generated from the failing test titles only.

Plain Q&A: four general questions with no tools, and two repository questions with read-only native tools.

## Scoring

`scripts/eval_bugsjs.py` scores each attempt independently of the session. The candidate diff is applied to a fresh copy of the buggy fixture. A pass requires all of:

- changes only to implementation files (no tests, package files, or new files);
- the exact target command passes on the fresh copy;
- the target test file has no new failing titles relative to the fixed revision (confirmed by a second run);
- the whole-suite preservation check has no regression: a title counts only if it fails in all three candidate runs and in at most one of three runs of the upstream fixed revision;
- extra checks pass (ESLint: inherited-config validation, cache population, relative and nested extends);
- a successful native Bash run of the target command after the last edit;
- no API error and no timeout (300 s per case, 900 s for the long task).

`patch correct` reports the independent checks alone. The scorer was validated on each change: upstream fixes pass, and a no-op `res.vary` regression is rejected even though its target test passes.

CSV and TTL use `scripts/eval_coding.py` unchanged (visible tests, held-out judge, implementation-only diff, a passing `node --test` after the last edit).

Failure layers (`scripts/summarize_evals.py`): decode (gateway could not decode or validate a reply), identity (stale or unknown Read snapshot), context (prompt over the WhatsApp cap or compaction thrash), turn (stopped without a change, or without a passing test after a correct change), patch (the session ran but the patch failed), client (Claude Code refused the action), timeout, blocked (gateway not ready; excluded).

## Reproducing

    npm ci && npm run build && npm start          # pair once, keep running
    python3 scripts/prepare_bugsjs.py cases.json --out <fixtures>
    python3 scripts/eval_bugsjs.py --manifest <fixtures>/manifest.json --out <results> --label run1
    python3 scripts/eval_bugsjs.py ... --mode bg      # background sessions
    python3 scripts/eval_bugsjs.py ... --mode tty     # interactive terminal UI in screen
    python3 scripts/eval_bugsjs.py ... --context-tokens 9000 --resume-prompt '...'
    python3 scripts/eval_coding.py --prompts compact --tasks csv cache
    python3 scripts/eval_qa.py --out <results> --label qa --repo <fixture>
    python3 scripts/summarize_evals.py <results>/run1 ...

Run one batch at a time: the gateway serializes requests through one WhatsApp chat. Keep fixtures outside `/tmp` (macOS deletes files there after three days without access) and keep the machine awake (`caffeinate -i`).

## Decision

**Not yet usable as the model for ordinary Claude Code coding sessions.** No tested configuration made repository repair reliable. Across every revision there is **one** passing BugsJS attempt (Express 20, background session), and **0 of 14** sealed holdout attempts passed on the two frozen revisions. Small self-contained fixes do work: the TTL fix passes end to end in 7 of 8 attempts on the frozen revisions. Asking for Meta AI's "think hard" mode had no measurable effect.

The native mechanics now run: background sessions in worktrees, the interactive terminal, native compaction and resume, plain Q&A, and a fresh install. They are not fully robust. Both default-window long sessions still ended on an undecodable reply, and undecodable replies still ended some attempts on every frozen revision. On revision I, no dev attempt ended in a gateway error, yet none produced a correct patch: under this adapter, the remaining failures are mostly wrong patches and an ineffective edit-and-test workflow (many edits, few tests, repeated changes). That does not separate the model's intrinsic ability from what further adapter work might recover.

## Results

All attempts are listed in the per-batch tables produced by `scripts/summarize_evals.py`; blocked and harness-invalid attempts are excluded from the counts below and listed separately.

### Repository repair (BugsJS, 7 dev cases)

| Revision | Mode | Attempts | Pass | Patch correct | Ending in a gateway error |
|---|---|---|---|---|---|
| baseline 7e33e34 | headless | 7 | 0 | 0 | 4 |
| baseline 7e33e34 | background | 4 | 0 | 0 | 3 (plus 1 refused by background isolation) |
| G acc16dc | headless | 8 | 0 | 0 | 4 |
| G acc16dc | background | 4 | 0 | 0 | 1 |
| G acc16dc | interactive terminal | 2 | 0 | 0 | 1 |
| H 08bda71 | headless (2 repeats) | 14 | 0 | 0 | 5 |
| H 08bda71 | background | 4 | **1** | 1 | 1 |
| H 08bda71 | interactive terminal | 2 | 0 | 0 | 1 |
| H 08bda71 | think-hard, headless | 7 | 0 | 0 | 1 |
| H 08bda71 | configured verification | 7 | 0 | 0 | 7 |
| I 8736083 | headless | I_HEADLESS |
| I 8736083 | background | I_BG |

Intermediate development revisions (afd4689, 3810f48, 97fab17, b3cd53b, 2a65a90) scored 0 on all 36 of their completed headless and background attempts; they are kept in the ledger, not in this table.

The passing attempt read the response module, made one edit inside its native background worktree, ran the exact target test natively, and passed the target, the target file, and the whole-suite preservation check in 30.9 seconds. Its patch throws a `TypeError` for an array `Content-Type`, as the upstream fix does.

### Sealed holdouts (Express 1, 4, 23; ESLint 3, 19; hessian.js 2, 7)

| Revision | Attempts | Pass | Patch correct | Typical ending |
|---|---|---|---|---|
| G | 7 | 0 | 0 | 6 of 7 used the full 300 s budget |
| H | 7 | 0 | 0 | 4 of 7 used the full 300 s budget |

### Synthetic tasks (end-to-end pass / correct but unverified)

| Batch | TTL cache | CSV parser |
|---|---|---|
| baseline | 0/2 (2 correct, untested after the last edit) | 0/2 |
| G | 2/2 | 0/2 |
| H default | 1/2 | 0/2 |
| H think-hard | 2/2 | 0/2 (1 correct, lost to a no-op edit loop fixed in I) |
| H configured | 2/2 | 0/2 |
| I | I_TTL | I_CSV |

### Long session, native compaction, and resume

The two-module task (fix TTL and implement CSV in one session) at the default client window compacted natively once and twice, was resumed with `--resume` for a follow-up turn, and kept working for 6.5 and 8 minutes (13 edits each, 4 and 20 native test runs). Neither final patch was correct and both ended on an undecodable reply. Native compaction also occurred on its own in 9 dev and holdout sessions. Runs with a client window below the default thrashed: Claude Code's compaction buffer leaves almost no room, so smaller windows are not a useful way to force compaction.

### Plain Q&A

| Batch | General (no tools) | Repository (read-only native tools) |
|---|---|---|
| H default | 3/4 | 2/2 |
| H think-hard | 3/4 | 2/2 |

The same general question (`[[1,[2]],3].flat()`) was answered wrong in every batch. Median latency 9.5 s.

### Reasoning mode ("think hard")

The transport attached WhatsApp's `BotModeSelectionMetadata` with `THINK_HARD_MODE` to every outgoing message (`WA_BOT_MODE=think_hard`, verified in the transport's environment). Across 1,000+ default replies and every think-hard reply, the reply metadata was identical: `modelType LLAMA_PROD`, `premiumModelStatus AVAILABLE`, no mode echo, no reasoning steps, no thinking flag. Q&A answers and latencies matched, and the matched dev batch scored the same (0/7). There is no evidence that this account's Meta AI bot honors the selection; it stays off by default.

### Setup

A fresh clone from GitHub, `npm ci`, the Go build, `go vet`, and the unit tests took about 40 seconds; the launcher from that clone answered through the paired gateway in 5 to 11 seconds on each frozen revision. Rough edges: Go is not preinstalled on macOS; Claude Code prints a harmless `unrecognized_model` notice; `-p` waits three seconds for piped stdin unless it gets `< /dev/null`; Claude Code auto-updated during the evaluation.

## What changed in the gateway

Baseline failures were classified by layer and fixed at the layer they came from. Most fixes recover reply shapes Meta AI actually produced, always on the matched WhatsApp turn and always followed by the native schema, snapshot, and range checks:

- **Reply decoding:** missing closing brackets; repeated END lines (`END\nEND`, `END END`); code fences glued inside edit frames; bare tool arrays and arrays wrapping the envelope; JSON line edits with alias field names; the transcript's own `changed_lines` form used as an edit; literal regex backslashes in JSON strings; an edit or a single tool call after prose; commentary after a complete edit frame.
- **Read identity:** snapshots survive shell commands; a successful line edit becomes a fresh excerpt; offset-0 reads are requested from line 1 so labels match file lines; an edit outside the excerpt becomes a native Read of those lines; unknown handles bind only to a unique containing excerpt that shares source; after a failed repair (including after compaction) the gateway reads the most relevant file instead of failing.
- **Turn handling:** one reminder when a turn ends after a failed command or an untested edit; a repeated untested success claim reruns the failing test natively; a no-op edit runs the untested change or stops plainly; the configured edit budget ends as an answer, not a 502.
- **Context:** tiny targeted reads widen to 40 lines, reads cap at 400 lines, terminal styling and dependency stack frames are removed from the WhatsApp view, and the oldest tool outputs are omitted from that view instead of returning a 413.
- **Edit quality:** flush-left replacements regain indentation in brace languages; a line edit that changes bracket balance gets one repair.
- **Launcher:** background sessions start in a native worktree with `node_modules` linked; parent Claude Code session variables are dropped (they disabled transcript saving in the interactive UI).

## Exclusions and incidents

- The machine slept mid-batch and WhatsApp disconnected; 11 attempts were blocked and excluded. Later batches ran under `caffeinate` and the runner waits for gateway readiness.
- The macOS daily `/tmp` cleanup deleted the dev fixtures and part of the paired runtime. Fixtures were rebuilt at the same tag commits (preflights identical except one previously flaky test), the runtime was restored, and all saved patches were rescored with no outcome change.
- Harness defects found during the run were fixed and the affected attempts excluded: the interactive-terminal runner (launcher session variables), the repository Q&A copy (no `.git`, so Grep searched `node_modules`), a runner crash on Claude Code's `permission_denied` event (interrupted holdouts were rerun on the same gateway), and a forced-compaction window that was too small.
- An external Q&A request from an earlier session shared the WhatsApp chat once during the baseline; the overlapped attempt is labeled.

## Limitations

- One linked account, one bot address, one machine; Meta AI's model and behavior can change without notice and are not versioned.
- Each case ran once or twice per configuration, so small differences between arms are within noise.
- The BugsJS tasks are real upstream bugs and were hard for this backend; the synthetic tasks are small. There is no middle tier of ordinary feature work in this evaluation.
- The remaining failures are mostly wrong patches and an ineffective edit-and-test workflow under this adapter. These results do not show whether further adapter work (for example different context or verification strategies) could raise success, and they do not measure the model's ability apart from this adapter. Reply metadata (`LLAMA_PROD`) does not identify the model or its size.
