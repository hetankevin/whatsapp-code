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
| Meta AI backend | `LLAMA_PROD` for every batch through revision O and the middle-tier comparisons; `CLIPPY` from revision Q (e8b7553) onward |
| Baseline adapter | 7e33e34 |
| Revisions (LLAMA_PROD) | G = acc16dc, H = 08bda71 (default-mode gateway identical to 2337fbd); later I 8736083, J 4039702, K ab3aeba, L 7ab101e, M a6e086a, N accb621, O 71ed115 |
| Revisions (CLIPPY) | Q e8b7553 (CLIPPY by default), S 74d0154 (Q + parallel read calls + silent-backend fallback), T/V 73b3f9e (S + read budget, READ_ID frames, long-output and post-compaction trimming), final Y 87c4539 (V + short compaction summaries, tool-availability repair, placeholder-frame guard) |
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

Fresh held-out group (CLIPPY era): the eight lowest-numbered Express bugs not used anywhere else with exactly one regression test file, selected by that rule before any run; bugs whose upstream fix fails its own target here were replaced by the next by the same rule. Seven ran (3, 5, 8, 9, 24, 26, 27); bug 18 was excluded because its fixed revision fails its own target intermittently. Their first attempt on revision S is the sealed measurement; two gateway fixes (T, V) were later informed by two of those failures, so later attempts are reported as unsealed reruns.

Final sealed group: the six lowest-numbered unused ESLint bugs and the four lowest-numbered unused hessian.js bugs with exactly one regression test file and a separating upstream fix (ESLint 1, 2, 4, 6, 7, 8; hessian.js 3, 5, 8, 9; hessian.js 1 does not separate). Prepared and preflighted without inspecting the fixes, and run exactly once on the final revision.

Long session: `synth-six` puts all six middle-tier modules (below) in one project with one task: fix all six, testing after each. Validated: the buggy project fails 12 visible tests, the reference passes all 14, and each held-out judge passes the reference and fails the buggy code.

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

Scorer corrections (November 15-16, CLIPPY era). Revision 5: Mocha prefixes failure lines with an ANSI reset even when writing to a file, so 137 saved scoring logs had failing titles the scorer could not read, and the whole-suite check could not see regressions (only false passes were possible). Titles are now read after stripping ANSI codes. Making titles visible exposed noise that had been hidden: several Express acceptance tests fail on Node 22 in every revision, and whether they appear in a whole-suite run depends on test order. Revision 6 confirms a suspected whole-suite regression against three runs of the fixed revision made at the same time; revision 7 also requires that the test pass on the fixed revision when its own file runs alone, and lets the target-file count check use the confirming rerun; revision 8 counts a failing target command only if a second run also fails (the one LLAMA-era BugsJS pass flaked once in a rescore, then passed 5 of 5, as did the fixed revision, while the buggy revision failed 5 of 5). Validated on Express 11: the saved correct patch scores correct; the same patch with `res.json` made to throw fails the target, parity names the broken `res.send` tests, and the whole-suite check flags the content-negotiation and error-page JSON tests. Every saved attempt from both backends was rescored with revision 8 on an otherwise idle machine: 158 LLAMA_PROD-era attempts with no verdict change, and 84 CLIPPY-era attempts with two (one fail became a pass where the live score had flagged environment failures; one pass became a fail where the target failed twice in a row). One environment limit remains: `test/res.links.js` has a `beforeEach` that throws on Node 22 in every Express revision, so the tests in that suite never run, on the reference or the candidate.

Backend and quota: with `WA_EVAL_REPLY_LOG` set, each attempt records which Meta AI backend answered each reply. Attempts with any non-CLIPPY reply (the gateway fell back while CLIPPY was quiet) are reported separately and rerun. `WA_EVAL_CLIPPY_PER_HOUR=200` makes the runner wait before an attempt while the account's CLIPPY replies in the past hour are at that budget.

CSV and TTL use `scripts/eval_coding.py` unchanged (visible tests, held-out judge, implementation-only diff, a passing `node --test` after the last edit).

Failure layers (`scripts/summarize_evals.py`): decode (gateway could not decode or validate a reply), identity (stale or unknown Read snapshot), context (prompt over the WhatsApp cap or compaction thrash), no reply (Meta AI sent nothing, or WhatsApp disconnected), fallback (part of the session ran on the standard backend), turn (stopped without a change, or without a passing test after a correct change), patch (the session ran but the patch failed), client (Claude Code refused the action), timeout, blocked (gateway not ready; excluded).

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
    WA_EVAL_REPLY_LOG=<server WA_REPLY_LOG> WA_EVAL_DEFAULT_BACKEND=1 WA_EVAL_CLIPPY_PER_HOUR=200 \
      python3 scripts/eval_bugsjs.py ... --pause 30   # record backends, pace under the CLIPPY quota
    python3 scripts/eval_bugsjs.py --manifest ... --label x --rescore <labels>   # re-judge saved diffs

Run one batch at a time: the gateway serializes requests through one WhatsApp chat. Keep fixtures outside `/tmp` (macOS deletes files there after three days without access) and keep the machine awake (`caffeinate -i`).

## Decision

**Update, November 15 (in progress): a different Meta AI backend changes the picture.** Every result below this update was measured on Meta AI's `LLAMA_PROD` backend. Declaring one client capability in the outgoing bot metadata (`RICH_RESPONSE_UR_REASONING`) routes replies to a backend the bot reports as `CLIPPY`; it is now the default (revision e8b7553, transport switch `WA_BOT_CAPS`). On CLIPPY so far:

| Suite | LLAMA_PROD | CLIPPY |
|---|---|---|
| Six small realistic fixes, matched A-B-B-A ×2, same binary | 13/24 end to end | **24/24** end to end (median 14.5 s vs 27.2 s per task) |
| BugsJS dev cases (same 7 cases, same scorer) | 1/138 over all revisions; 0/7 on O | **6/7** (all six Express cases; ESLint 10 passed its target and suite but failed one held-out ESLint contract check) |
| Sealed holdouts (same 7 cases) | 0/21 | **3/4** completed (Express 1, Express 4, ESLint 3; Express 23 broke another test in its file); 3 more ended in the CLIPPY outage below and are not counted |

**Limit found:** after about 250 CLIPPY replies in 33 minutes (peak 66 in five minutes), CLIPPY stopped answering this account entirely (no reply, no notice), while `LLAMA_PROD` kept answering. The gateway now detects 60 s of silence, resends the same prompt through the standard backend, and stays there for 20 minutes (`WA_FALLBACK`, revision 74d0154); a live check recovered in 64 s instead of a five-minute hang. How long the limit lasts is being measured. The remaining batch (synthetic tasks, background and terminal modes, Q&A, long session with compaction and resume, repeats, and a fresh held-out group of eight never-run Express bugs) resumes when CLIPPY answers again.

### Before the backend switch

**Not yet usable as the model for ordinary Claude Code coding sessions.** No tested configuration made repository repair reliable. Across 13 gateway revisions with native runs and every invocation mode, **1 of 138** scored BugsJS dev attempts passed (Express 20, background session), and **0 of 21** holdout attempts passed (14 sealed on frozen revisions, 7 unsealed reruns). Small self-contained fixes work part of the time: the TTL fix passed end to end in 12 of 23 attempts (12 of 18 from revision G onward), six realistic small bug fixes passed in about 60 percent of matched default runs (29 of 48, after correcting one held-out judge), and the CSV parser passed once in 23. Plain Q&A works (5 of 6 on the final measurement). Neither reasoning lever helped: Meta AI's "think hard" mode and a prompt-level reasoning cue both had no measurable effect, and neither did testing after every edit or a requirements review after the tests pass.

The native mechanics run: background sessions in worktrees, the interactive terminal, native compaction and resume, plain Q&A, and a fresh install. They are not fully robust: undecodable replies still end some sessions, and the edit format matters (see the isolation experiment). A controlled comparison of a direct request against the gateway's presentation, with identical inputs, showed both failure kinds: Meta AI fails to infer correct ESLint and CSV fixes in either presentation, and for Express 20 the presentation itself blocked a change Meta AI could describe. Gateway changes made from that evidence raised correct first proposals on Express 20 from 0 of 9 to 2 of 3, but did not raise end-to-end repair rates in native sessions.

The one lever not yet tested needs the account owner: the Muse bot (which Meta presents as a stronger model) still refuses this linked device with "no active WASA root secret", exactly as on November 9.

## Results

All attempts are listed in the per-batch tables produced by `scripts/summarize_evals.py`; blocked and harness-invalid attempts are excluded from the counts below and listed separately.

## Results on the CLIPPY backend (November 15-16)

Counts use scorer revision 8. "No reply" attempts (CLIPPY silent, or Meta AI refusing to generate) and attempts that fell back to the standard backend are listed but not counted as CLIPPY results.

### Matched comparison of the two backends (middle tier)

Same binary and gateway revision; only the declared capability differs. A-B-B-A twice, six tasks per round.

| Backend | End to end | Correct patch | Tested after last edit | Median time per task |
|---|---|---|---|---|
| LLAMA_PROD | 13/24 | 13/24 | 23/24 | 27.2 s |
| CLIPPY | **24/24** | **24/24** | 24/24 | 14.5 s |

Per task (LLAMA_PROD / CLIPPY): deep merge 2/4 and 4/4, intervals 0/4 and 4/4, LRU 4/4 and 4/4, Roman numerals 3/4 and 4/4, semver 0/4 and 4/4, word wrap 4/4 and 4/4. Every reply's backend was checked from its metadata (109 LLAMA_PROD, 114 CLIPPY).

### Repository repair (BugsJS)

| Set | Revision | Attempts | Pass | Patch correct | Not counted |
|---|---|---|---|---|---|
| Dev (Express 10, 11, 13, 14, 17, 20; ESLint 10) | Q e8b7553 | 7 | **6** | 6 | |
| Dev, two more attempts each | T/V 73b3f9e | 14 | **13** | 13 | 1 fallback |
| Original sealed holdouts (Express 1, 4, 23; ESLint 3, 19; hessian.js 2, 7) | Q | 4 | 3 | 3 | 3 no reply |
| Same holdouts | S 74d0154 | 7 | **4** | 4 | |
| Same holdouts, two more attempts each (unsealed: V was informed by two S failures) | T/V | 14 | 8 | 8 | |
| Fresh group (Express 3, 5, 8, 9, 24, 26, 27), first contact, sealed | S | 7 | **5** | 6 | |
| Fresh group, two more attempts each (unsealed) | T/V | 12 | 11 | 11 | Express 27: 1 no reply, 1 fallback |
| Final sealed group (ESLint 1, 2, 4, 6, 7, 8; hessian.js 3, 5, 8, 9), run once | Y 87c4539 | not yet run (waiting for CLIPPY) | | | |

Old backend for comparison: 1 of 138 dev attempts and 0 of 21 holdout attempts, with the same cases and scorer.

Failures on CLIPPY, by cause:
- **413 after native compaction** (S: fresh Express 26 and 27, holdouts ESLint 19 and hessian.js 7, dev Express 10). Claude Code re-attaches files read earlier as text after compacting; the gateway could not trim them and the WhatsApp view exceeded 60,000 characters. Fixed in V (with the parallel-read budget in T); none of the T attempts hit a 413.
- **Compaction thrash** (T: Express 13, ESLint 19, hessian.js 7, one attempt each). CLIPPY's summaries ran to 15,000-20,000 characters and the context refilled within three turns. W asks for summaries under 6,000 characters (measured in the long-session and final runs).
- **Wrong patch**: Express 23 in all four attempts on S and T (the patch passes the target but breaks `app should reject missing functions` in the same file); Express 8 once; ESLint 10 once on Q (fails a held-out ESLint contract check).
- **Agent behavior**: hessian.js 2 failed twice on T: once CLIPPY tried to run the listed tools itself and answered that they were unavailable (repaired by X), once it spent its 300 s paging through files with placeholder edit frames (guarded by Y).

### Synthetic tasks, modes, and Q&A (revision T/V)

| Check | Result |
|---|---|
| TTL cache fix | 2/2 (12-14 s) |
| CSV parser (quoted empty fields, delimiter-only rows, spaces) | 2/2 (13-24 s); 1 of 23 on LLAMA_PROD |
| Background sessions (`--bg`, native worktree) | 2/4: Express 13 and 20 pass; ESLint 10 fails; Express 11's patch is correct but its Edit is missing from Claude Code's background transcript, so the runner cannot confirm a test after it (the gateway log shows the Edit before the test) |
| Interactive terminal UI | 2/2 (Express 13, 20) |
| Two-module task with `--resume` follow-up | 2/2 (33 and 48 s; finished before any compaction) |
| Six-module long session with compaction and resume | not yet run (waiting for CLIPPY) |
| Plain Q&A | 6/6, including the `[[1,[2]],3].flat()` question every LLAMA_PROD batch got wrong |
| Fresh clone: `npm ci`, launcher, live reply | works (Q); to be repeated on the final revision |

### CLIPPY's usage limit and the fallback

CLIPPY stopped answering this account three times: after 250 replies in 33 minutes, after 263 in 52 minutes, and after 190 in the preceding hour. There is no reply and no notice; the standard backend keeps answering, and a brand-new bot session gets no CLIPPY reply either, so the limit is per account. The silences lasted between 17 and over 50 minutes. Pacing to about 200 replies an hour did not prevent the third one. A typical repository fix uses 5 to 20 replies, so ordinary interactive use stays well inside the limit; batch evaluation does not.

When CLIPPY is silent for 60 s, the gateway resends the same prompt through the standard backend and keeps using it for 20 minutes (`/health` reports this). A session therefore continues instead of hanging, but at the old backend's quality.

### Fresh install and chat history (CLIPPY)

Not yet measured (waiting for CLIPPY): one A-B-B-A block of the middle tier in the shared chat versus a new bot session per task, which approximates a fresh install's empty chat.

## Results on the LLAMA_PROD backend (November 13-15)

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

A middle ground keeps history within one coding session but not across sessions: one bot session per Claude Code session (`WA_BOT_SESSION=task`, f120ed7). The first matched pair already showed the isolation failure: per-task sessions produced 4 of 6 correct patches but 0 end-to-end passes and never ran a test (only Read and Edit), against 3 correct, 3 end-to-end, and 5 tested runs for the shared chat in the same window. The remaining rounds were stopped to limit load on the account. Within one task, the session's own history does not teach Meta AI to test; only the long shared chat does.

### Long session, native compaction, and resume

The two-module task (fix TTL and implement CSV in one session) at the default client window compacted natively once and twice, was resumed with `--resume` for a follow-up turn, and kept working for 6.5 and 8 minutes (13 edits each, 4 and 20 native test runs). Neither final patch was correct and both ended on an undecodable reply. Native compaction also occurred on its own in 9 dev and holdout sessions. Runs with a client window below the default thrashed: Claude Code's compaction buffer leaves almost no room, so smaller windows are not a useful way to force compaction.

### Plain Q&A

| Batch | General (no tools) | Repository (read-only native tools) |
|---|---|---|
| H default | 3/4 | 2/2 |
| H think-hard | 3/4 | 2/2 |

The same general question (`[[1,[2]],3].flat()`) was answered wrong in every batch. Median latency 9.5 s.

### Reasoning mode ("think hard")

The transport attached WhatsApp's `BotModeSelectionMetadata` with `THINK_HARD_MODE` to every outgoing message (`WA_BOT_MODE=think_hard`, verified in the transport's environment). Across 1,000+ default replies and every think-hard reply, the reply metadata was identical: `modelType LLAMA_PROD`, `premiumModelStatus AVAILABLE`, no mode echo, no reasoning steps, no thinking flag. Q&A answers and latencies matched, and the matched dev batch scored the same (0/7). There is no evidence that this account's Meta AI bot honors the selection; it stays off by default. Correction (November 15): the selection was ignored because the client never declared that it can show reasoning. Declaring `RICH_RESPONSE_UR_REASONING`, with or without think-hard, switches the backend to CLIPPY (see the decision update); think-hard is not needed for the switch, and its effect on top of CLIPPY was not measured.

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

- **Backend (CLIPPY era):** the transport declares the client capability `RICH_RESPONSE_UR_REASONING`, which routes replies to Meta AI's CLIPPY backend (e8b7553). When a prompt gets no bot event for 60 s, the gateway resends it through the standard backend and stays there for 20 minutes (74d0154).
- **CLIPPY reply shapes:** back-to-back JSON envelopes become parallel read-only tool calls (other combinations keep the first call); `EDIT READ_ID <id> <start> <end>` headers are accepted; a plain answer claiming the offered tools are unavailable gets one repair (CLIPPY sometimes tries its own internal tools); a one-line placeholder replacing 15 or more lines is read, never applied (CLIPPY used such frames to page through files).
- **Context under CLIPPY:** parallel Reads share the 400-line budget; one huge search or command output is shortened (start and end kept, with a note) instead of failing the request; file contents Claude Code re-attaches after a native compaction leave the WhatsApp view first; compaction requests ask for a summary under 6,000 characters (CLIPPY's ran to 20,000).

## Exclusions and incidents

- The machine slept mid-batch and WhatsApp disconnected; 11 attempts were blocked and excluded. Later batches ran under `caffeinate` and the runner waits for gateway readiness.
- The macOS daily `/tmp` cleanup deleted the dev fixtures and part of the paired runtime. Fixtures were rebuilt at the same tag commits (preflights identical except one previously flaky test), the runtime was restored, and all saved patches were rescored with no outcome change.
- Harness defects found during the run were fixed and the affected attempts excluded: the interactive-terminal runner (launcher session variables), the repository Q&A copy (no `.git`, so Grep searched `node_modules`), a runner crash on Claude Code's `permission_denied` event (interrupted holdouts were rerun on the same gateway), and a forced-compaction window that was too small.
- An external Q&A request from an earlier session shared the WhatsApp chat once during the baseline; the overlapped attempt is labeled.
- CLIPPY stopped answering this account twice (21:51-22:39 and 23:33-23:50 UTC, November 15) after about 250 replies in the preceding hour. Attempts that ended in that silence (ESLint 19, hessian.js 2 and 7 on Q) are reported as "no reply"; one attempt that ran on the standard backend after the fallback (Express 10 on T) is kept apart and was rerun. A brand-new bot session got no reply during the silence either, so the limit is per account.
- Batch S was stopped after its dev stage began, once the 413 failures it was producing had a known cause (fixed in V); its fresh-group and holdout results are reported, the dev stage is not.
- A zsh word-splitting bug in one batch script skipped three stages instantly; no attempt was made, and the batch was restarted.

## Limitations

- One linked account, one bot address, one machine; Meta AI's model and behavior can change without notice and are not versioned.
- Each case ran once or twice per configuration, so small differences between arms are within noise.
- The BugsJS tasks are real upstream bugs and were hard for this backend; the synthetic tasks are small. There is no middle tier of ordinary feature work in this evaluation.
- The remaining failures are mostly wrong patches and an ineffective edit-and-test workflow under this adapter. These results do not show whether further adapter work (for example different context or verification strategies) could raise success, and they do not measure the model's ability apart from this adapter. Reply metadata (`LLAMA_PROD`) does not identify the model or its size.

## Next steps

- **Muse bot (needs the account owner).** Discovery prefers the Muse bot (1807055946647697@bot), which Meta presents as a stronger model, but sends to it fail on this linked device with "no active WASA root secret". Every scored run here used the regular Meta AI bot. Establishing Muse's encryption state on the account (for example by opening a Muse chat on the phone) and rerunning the same cases with `WA_BOT_JID=1807055946647697@bot` is the most direct test of whether a different model changes the repair results.
- **Workflow.** Sessions still make many edits per test and repeat ineffective changes. The configured verification path runs the test after every edit but decodes worse under its separate prompt; making the default mode run the model's own last test after each edit is the next candidate, measured as its own arm.
- **Middle-tier tasks.** Add ordinary feature and refactoring tasks between the synthetic fixes and real upstream bugs, to see where usefulness ends.
