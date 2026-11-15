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
| Frozen revisions | G = acc16dc, H = 08bda71 (default-mode gateway identical to 2337fbd); later revisions I 8736083, J 4039702, K ab3aeba, L 7ab101e, M a6e086a, N accb621, final O 71ed115 |
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

**Not yet usable as the model for ordinary Claude Code coding sessions.** No tested configuration made repository repair reliable. Across 13 gateway revisions with native runs and every invocation mode, **1 of 138** scored BugsJS dev attempts passed (Express 20, background session), and **0 of 21** holdout attempts passed (14 sealed on frozen revisions, 7 unsealed reruns). Small self-contained fixes work part of the time: the TTL fix passed end to end in 12 of 23 attempts (12 of 18 from revision G onward), six realistic small bug fixes passed in about 60 percent of matched default runs (29 of 48, after correcting one held-out judge), and the CSV parser passed once in 23. Plain Q&A works (5 of 6 on the final measurement). Neither reasoning lever helped: Meta AI's "think hard" mode and a prompt-level reasoning cue both had no measurable effect, and neither did testing after every edit or a requirements review after the tests pass.

The native mechanics run: background sessions in worktrees, the interactive terminal, native compaction and resume, plain Q&A, and a fresh install. They are not fully robust: undecodable replies still end some sessions, and the edit format matters (see the isolation experiment). A controlled comparison of a direct request against the gateway's presentation, with identical inputs, showed both failure kinds: Meta AI fails to infer correct ESLint and CSV fixes in either presentation, and for Express 20 the presentation itself blocked a change Meta AI could describe. Gateway changes made from that evidence raised correct first proposals on Express 20 from 0 of 9 to 2 of 3, but did not raise end-to-end repair rates in native sessions.

The one lever not yet tested needs the account owner: the Muse bot (which Meta presents as a stronger model) still refuses this linked device with "no active WASA root secret", exactly as on November 9.

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
| I 8736083 | headless | 7 | 0 | 0 | 0 |
| I 8736083 | background | 4 | 0 | 0 | 0 |
| J 4039702 | headless | 7 | 0 | 0 | 2 |
| M a6e086a | headless | 7 | 0 | 0 | 5 (new FILE-edit rejections) |
| N accb621 | headless | 7 | 0 | 0 | 3 |
| N accb621 | background | 4 | 0 | 0 | 2 |
| O 71ed115 | headless | 7 | 0 | 0 | 1 |

Intermediate development revisions (afd4689, 3810f48, 97fab17, b3cd53b, 2a65a90) scored 0 on all 36 of their completed headless and background attempts; they are kept in the ledger, not in this table.

The passing attempt read the response module, made one edit inside its native background worktree, ran the exact target test natively, and passed the target, the target file, and the whole-suite preservation check in 30.9 seconds. Its patch throws a `TypeError` for an array `Content-Type`, as the upstream fix does.

### Sealed holdouts (Express 1, 4, 23; ESLint 3, 19; hessian.js 2, 7)

| Revision | Attempts | Pass | Patch correct | Typical ending |
|---|---|---|---|---|
| G | 7 | 0 | 0 | 6 of 7 used the full 300 s budget |
| H | 7 | 0 | 0 | 4 of 7 used the full 300 s budget |
| N (unsealed rerun) | 7 | 0 | 0 | 4 ended on unmatched FILE-edit originals; Express 1 passed its target and preservation but broke another test in its file |

### Synthetic tasks (end-to-end pass / correct but unverified)

| Batch | TTL cache | CSV parser |
|---|---|---|
| baseline | 0/2 (2 correct, untested after the last edit) | 0/2 |
| G | 2/2 | 0/2 |
| H default | 1/2 | 0/2 |
| H think-hard | 2/2 | 0/2 (1 correct, lost to a no-op edit loop fixed in I) |
| H configured | 2/2 | 0/2 |
| I | 1/2 (1 more correct, untested) | 0/2 |
| J | 1/2 | 1/2 |
| M | 1/2 | 0/2 |
| N | 2/2 | 0/2 |
| O (final) | 0/2 (1 correct, untested) | 0/2 |

### Middle tier: small realistic bug fixes (`scripts/eval_midtier.py`)

Six self-contained modules, each with one or two real bugs (Roman numerals in the 400s and 900s, semantic-version ordering, LRU recency and capacity, non-mutating deep merge, word wrap, interval merging), visible tests that fail, and a held-out judge with further edge cases. Each task was validated: the buggy source fails the visible tests and a reference fix passes everything. Same pass criteria as the TTL and CSV tasks.

Scorer correction: the original deep-merge judge also required that the result share no nested arrays with its inputs, which the task text does not state. The judge now checks only the stated requirements (inputs unchanged, nested keys merged, arrays replaced), and every saved deep-merge patch was rescored (0 of 13 passed under the old judge, 8 of 13 under the corrected one). The numbers below use the corrected judge for all arms.

| Comparison (A-B-B-A, same revision except where noted) | Off / baseline | On / variant |
|---|---|---|
| O (71ed115) vs P (519a86c): rerun the model's own test after each edit | 8/12 | 7/12 |
| Prompt-level reasoning cue (94230df) | 6/12 | 6/12 |
| Requirements review after the first passing test (WA_REVIEW_AFTER_PASS, f76ead6) | 15/24 | 14/24 |

Before the outage, O also had a first round of 3/6. Across the matched default arms (O, cue off, review off) the pass rate is 29 of 48, about 60 percent. Per task in the review comparison (off / on): Roman numerals 4/4 and 4/4, LRU 4/4 and 4/4, deep merge 2/4 and 2/4, word wrap 3/4 and 1/4, intervals 2/4 and 1/4, semver 0/4 and 2/4. No variant changed the overall rate beyond noise; all three stay off by default. The remaining failures are patches that pass the visible tests but miss stated edge cases (semver prerelease ordering, touching intervals, arrays replaced rather than merged).

### Chat history and session isolation

All requests share one WhatsApp chat with Meta AI. A code-word probe through the raw path showed that, by default, Meta AI answers with words from earlier messages rather than the latest one: chat history leaks into replies, unreliably. Sending each message as its own bot session (`WA_BOT_SESSION=random`, transport d81136e) removed that: it answered "NONE" in all five trials. An incognito thread type did not isolate.

Isolation made coding worse. On the middle tier, A-B-B-A twice (24 runs per arm): the shared chat produced 17 correct patches and 15 end-to-end passes, and ran the test after its last edit in 20 runs; isolated sessions produced 12 correct patches, 0 end-to-end passes, and never ran a test. The long chat history, full of earlier exchanges that read, edited, and tested, was teaching Meta AI the workflow. **The numbers in this report were measured on a heavily used chat; a fresh install with an empty Meta AI chat is likely to perform worse.**

Adding one complete worked exchange to the prompt (`WA_FEWSHOT=1`, f4c53a6) did not replace that history. Isolated sessions with the example against the shared chat, A-B-B-A twice: 8 versus 17 correct patches, 0 versus 16 end-to-end passes, and a test after the last edit in 1 versus 22 runs. The shared chat stays the default; both options stay off.

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

### Prompt-level reasoning cue

The terminal findings also proposed a prompt-level "think before acting" cue. With `WA_REASONING_CUE=1`, the gateway adds one instruction: check each stated or implied requirement and edge case against the code before editing. A-B-B-A on the middle tier, same revision (94230df), only the flag changed (verified from prompt sizes): cue off 5/12, cue on 4/12. No measurable gain; it stays off by default.

### Setup

A fresh clone from GitHub, `npm ci`, the Go build, `go vet`, and the unit tests took about 40 seconds; the launcher from that clone answered through the paired gateway in 5 to 11 seconds on each frozen revision. Rough edges: Go is not preinstalled on macOS; Claude Code prints a harmless `unrecognized_model` notice; `-p` waits three seconds for piped stdin unless it gets `< /dev/null`; Claude Code auto-updated during the evaluation.

## Isolation experiment: direct request versus gateway presentation

Approved after the poor repair scores, pre-registered in HANDOFF.md, and run with `scripts/eval_isolation.py`. Tasks: eslint-10, express-20, csv; 3 repeats per arm, arm order alternating per repeat; matched inputs (task text, the implementation files changed upstream in full, the same failing test output); no reference fix or diagnosis. Arm A is one plain WhatsApp message asking for each change as file, exact original lines, and replacement lines, applied only by exact unique match. Arm B is the gateway's real rendering of a Claude Code request (captured system prompt and tool schemas, transcript pre-seeded with native Read and failing Bash results); its first proposal is every edit until it asks for anything else (cap 6). Both are scored on clean copies with the live-run scorer. These are first-proposal results, not end-to-end tool-loop results.

| Task | A applicable | A correct | B made edits | B correct | B endings |
|---|---|---|---|---|---|
| eslint-10 | 0/3 | 0/3 | 2/3 | 0/3 | 1 undecodable reply |
| express-20 | 0/3 | 0/3 | 0/3 | 0/3 | 3 Meta AI generation failures |
| csv | 3/3 | 0/3 | 0/3 | 0/3 | 2 undecodable, 1 text |

What it shows, within its limits:

- **Failure to infer a correct change is real.** The direct CSV patches applied cleanly but were wrong (4 of 7 visible tests, or a syntax error), and no ESLint proposal in either arm was correct.
- **Presentation also causes failures.** All three direct express-20 replies proposed the right change (a `TypeError` for an array `Content-Type`; checked by reading, not scored) but quoted an "original" that merged two source lines, so none applied. The gateway arm never answered that task: Meta AI returned its generation-failure message 3 of 3 times. A follow-up diagnostic sent the same 54,000-character gateway prompt twice (failed twice) and a version with the numbered source moved out of the JSON payload into a plain section (answered twice). JSON-escaped source in the prompt, not its size, was the trigger.
- **Copying exact text is unreliable** in the direct arm: Meta AI paraphrases or merges the lines it claims to replace. The gateway's line-range edits avoid that, which is why arm B applied edits where arm A could not.

Limits: one shared WhatsApp chat (both diagnostic replies used arm A's reply format, so carryover between arms is real); arm B is a constructed transcript sent through the live gateway, not a live interactive session, and its captured system prompt names a different project root than its seeded Reads; 3 repeats per cell.

Actions and reruns. Each change was rerun with the identical design and inputs (correct first proposals, with applied counts in parentheses):

| Gateway revision | A eslint-10 | A express-20 | A csv | B eslint-10 | B express-20 | B csv |
|---|---|---|---|---|---|---|
| J (pre-registered run) | 0/3 (0) | 0/3 (0) | 0/3 (3) | 0/3 (2) | 0/3 (0) | 0/3 (0) |
| K: long tool outputs as plain sections | 0/3 (0) | 0/3 (0) | 0/3 (3) | 0/3 (2) | 0/3 (2) | 0/3 (1) |
| L: FILE search-and-replace edits | 0/3 (0) | 0/3 (0) | 0/3 (1) | 0/3 (0) | 0/3 (1) | 0/3 (1) |
| M: L plus fixes for copied placeholders, line numbers, and mixed replies | 0/3 (0) | 0/3 (0) | 0/3 (3) | 0/3 (1) | **2/3** (3) | 0/3 (2) |

Arm A does not depend on the gateway revision and stayed at 0 throughout. In arm B, K removed the generation failures, and M produced the first correct first proposals: Express 20 in 2 of 3 repeats, independently passing the target, the target file, and whole-suite preservation. ESLint and CSV stayed at 0 in both arms, which points to failure to infer those changes rather than presentation. With 3 repeats per cell and one shared chat, these counts are small; the Express 20 change from 0/9 to 2/3 is the clearest effect.

## What changed in the gateway

Baseline failures were classified by layer and fixed at the layer they came from. Most fixes recover reply shapes Meta AI actually produced, always on the matched WhatsApp turn and always followed by the native schema, snapshot, and range checks:

- **Reply decoding:** missing closing brackets; repeated END lines (`END\nEND`, `END END`); code fences glued inside edit frames; bare tool arrays and arrays wrapping the envelope; JSON line edits with alias field names; the transcript's own `changed_lines` form used as an edit; literal regex backslashes in JSON strings; an edit or a single tool call after prose; commentary after a complete edit frame.
- **Read identity:** snapshots survive shell commands; a successful line edit becomes a fresh excerpt; offset-0 reads are requested from line 1 so labels match file lines; an edit outside the excerpt becomes a native Read of those lines; unknown handles bind only to a unique containing excerpt that shares source; after a failed repair (including after compaction) the gateway reads the most relevant file instead of failing.
- **Turn handling:** one reminder when a turn ends after a failed command or an untested edit; a repeated untested success claim reruns the failing test natively; a no-op edit runs the untested change or stops plainly; the configured edit budget ends as an answer, not a 502.
- **Context:** tiny targeted reads widen to 40 lines, reads cap at 400 lines, terminal styling and dependency stack frames are removed from the WhatsApp view, and the oldest tool outputs are omitted from that view instead of returning a 413.
- **Edit quality:** flush-left replacements regain indentation in brace languages; a line edit that changes bracket balance gets one repair.
- **Launcher:** background sessions start in a native worktree with `node_modules` linked; parent Claude Code session variables are dropped (they disabled transcript saving in the interactive UI).
- **Presentation (after the isolation experiment):** long tool outputs are shown as plain text sections referenced from the JSON transcript (escaped source triggered Meta AI generation failures); a `FILE:` search-and-replace edit (original and replacement code blocks) is accepted and anchored in the current Read ignoring whitespace, with copied placeholders and line numbers removed; edited excerpts keep 12 lines of context; an unmatched original first gets one wider native Read.

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

## Next steps

- **Muse bot (needs the account owner).** Discovery prefers the Muse bot (1807055946647697@bot), which Meta presents as a stronger model, but sends to it fail on this linked device with "no active WASA root secret". Every scored run here used the regular Meta AI bot. Establishing Muse's encryption state on the account (for example by opening a Muse chat on the phone) and rerunning the same cases with `WA_BOT_JID=1807055946647697@bot` is the most direct test of whether a different model changes the repair results.
- **Workflow.** Sessions still make many edits per test and repeat ineffective changes. The configured verification path runs the test after every edit but decodes worse under its separate prompt; making the default mode run the model's own last test after each edit is the next candidate, measured as its own arm.
- **Middle-tier tasks.** Add ordinary feature and refactoring tasks between the synthetic fixes and real upstream bugs, to see where usefulness ends.
