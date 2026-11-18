# Live evaluation: WhatsApp Meta AI as the Claude Code model

This report measures whether consumer WhatsApp Meta AI, reached through this gateway, is a usable model for ordinary Claude Code coding sessions. Claude Code runs natively throughout: it executes every tool, applies its own permission rules (`dontAsk` with an explicit allow list), owns the transcript, and performs compaction and resume. Every scored attempt uses only Meta AI through `src/launch.mjs`.

Raw chats, prompts, transcripts, candidate diffs, fixture copies, reply diagnostics, credentials, and pairing material stay local and are not published. This page reports outcomes only.

## Setup

| Item | Value |
|---|---|
| Machine | macOS arm64 |
| Node | 22.23.2 |
| Claude Code | 2.1.325 (auto-updated from 2.1.322 before the first scored run) through November 16, 22:45 UTC; 2.1.326 (auto-updated) for the Y reruns, Z through Z3, the final sealed run on CLIPPY, and the first Z4 attempts; 2.1.327 (auto-updated on November 17 during the Z4 dev pass) for the rest of Z4 and all of Z5. Each run's init event records its version. |
| Go (transport build) | 1.26.11 |
| Bot | 867051314767696@bot (Meta AI) |
| Meta AI backend | `LLAMA_PROD` for every batch through revision O and the middle-tier comparisons; `CLIPPY` from revision Q (e8b7553) onward |
| Baseline adapter | 7e33e34 |
| Revisions (LLAMA_PROD) | G = acc16dc, H = 08bda71 (default-mode gateway identical to 2337fbd); later I 8736083, J 4039702, K ab3aeba, L 7ab101e, M a6e086a, N accb621, O 71ed115 |
| Revisions (CLIPPY) | Q e8b7553 (CLIPPY by default), S 74d0154 (Q + parallel read calls + silent-backend fallback), T/V 73b3f9e (S + read budget, READ_ID frames, long-output and post-compaction trimming), Y 87c4539 (V + short compaction summaries, tool-availability repair, placeholder-frame guard), Z a13e6cd (Y + 50,000-token client window, whole-transcript usage, trimmed compaction requests), Z2 100b3d9 (Z + reconnect handling, second Meta AI error text retried, fallback backoff and launcher warning; frozen for the final sealed run), Z3 9fee5fe (Z2 + no rerun of a passing test with nothing changed, room for a repair under the cap), Z4 beadc76 (Z3 + one repair for a reply that only announces its next step), Z5 4fe4ed2 (Z4 + resend a prompt whose send failed on a connection that had just dropped) |
| Client context window | 26,000 tokens through Y; 50,000 from Z (launcher default) |
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

Final sealed group: the six lowest-numbered unused ESLint bugs and the four lowest-numbered unused hessian.js bugs with exactly one regression test file and a separating upstream fix (ESLint 1, 2, 4, 6, 7, 8; hessian.js 3, 5, 8, 9; hessian.js 1 does not separate). Prepared and preflighted without inspecting the fixes. Its first run (frozen Y) went to the standard backend through a scripting error and is reported apart (see incidents); its CLIPPY measurement is one run on frozen Z2, the first time CLIPPY saw these cases. Later attempts on ESLint 7 and hessian.js 3 are unsealed: Z4 was informed by their failures.

Sealed group for the final revision (Z5): pre-registered in HANDOFF before any run, by the same rule: the lowest-numbered ESLint bugs not used anywhere, with exactly one test file changed between the `Bug-N` and `Bug-N-test` tags and a separating upstream fix: ESLint 9, 11, 12, 14, 16, 17, 18, 20, 21, 23 (ESLint 15 was skipped because its fixed revision fails its own target, and the first spare took its place). Fixtures were prepared outside `/tmp`; no fix or test content was inspected; run once on Z5 with no gateway change after preparation.

Long session: `synth-six` puts all six middle-tier modules (below) in one project with one task: fix all six, testing after each, then a `--resume` follow-up that reruns the tests. Validated: the buggy project fails 12 visible tests, the reference passes all 14, and each held-out judge passes the reference and fails the buggy code.

Chained session: `chain-six` uses the same project, but hands over the modules one at a time in one native session: the first task, then five `--resume` follow-ups ("Next: (2) ...", each asking for `node --test` after the fix), then a last follow-up: "Run exactly: node --test. If anything fails, fix it and run it again, then summarize what changed in this session." It is scored like the long session, after the last follow-up.

Eight-task chained session: `chain-eight` adds the TTL cache fix and the CSV parser feature (`scripts/eval_coding.py`) to the same project as tasks 7 and 8, each with its held-out judge, and hands all eight over one per turn the same way. Validated: the buggy project fails its visible tests and all eight judges; the reference passes all of them. It is long enough that Claude Code compacts natively at the launcher's default 50,000-token window.

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

Fixture correction (November 17). ESLint 7's whole-suite preservation command named `tests/lib/ast-utils.js`, which does not exist at that revision, so mocha exited before running anything and the check could never pass for that case. It surfaced when both Z4 attempts on ESLint 7 passed the target and failed only that check. The command now runs `tests/lib/rules/` (4,147 tests pass on the fixed revision); the preparation script refuses cases whose test paths are missing, and the scorer labels a preservation run that executed no tests as a harness error (failure layer "harness") while still failing it. A scan of every other manifest found no other missing path. All saved ESLint 7 attempts were rescored: the two earlier ones made no edit and stay failures; both Z4 attempts pass.

Runner correction (November 17). The runner copied each checkout into `$TMPDIR` before waiting for quota. One Z4 attempt (ESLint 19, round 1) waited 19.5 hours, and macOS's daily cleaner deleted 824 of the checkout's files during the wait, since the copies keep the fixture's 2018 timestamps. The session found the target files missing and reported that as a blocker. The runner now copies the checkout after all waits; the attempt is kept, marked harness-invalid with its reason, and replaced by one more attempt. A scan of every saved attempt found no other checkout with missing files.

Backend and quota: with `WA_EVAL_REPLY_LOG` set, each attempt records which Meta AI backend answered each reply. Attempts with any standard-backend reply (the gateway fell back while CLIPPY was quiet) are reported separately and rerun. From Z on, `--require-clippy` sends a one-line probe before each attempt and stops the batch if the probe or the attempt got a standard-backend reply, so no batch can drift onto the other backend. `WA_EVAL_CLIPPY_PER_HOUR` (150 from Y on) and `WA_EVAL_CLIPPY_PER_DAY` (700, raised to 800-820 for the last reruns) make the runner wait before an attempt while the account's CLIPPY replies in the trailing hour or 24 hours are at that budget.

CSV and TTL use `scripts/eval_coding.py` unchanged (visible tests, held-out judge, implementation-only diff, a passing `node --test` after the last edit).

Failure layers (`scripts/summarize_evals.py`): decode (gateway could not decode or validate a reply), identity (stale or unknown Read snapshot), context (prompt over the WhatsApp cap or compaction thrash), no reply (Meta AI sent nothing, or WhatsApp disconnected), fallback (part of the session ran on the standard backend), turn (stopped without a change, or without a passing test after a correct change), patch (the session ran but the patch failed), client (Claude Code refused the action), timeout, blocked (gateway not ready; excluded), harness (the fixture or runner failed, not the model or the gateway: a preservation command that ran no tests, or an attempt listed with its reason in `harness-notes.json` next to the results).

## Reproducing

    npm ci && npm run build && npm start          # pair once, keep running
    python3 scripts/prepare_bugsjs.py cases.json --out <fixtures>
    python3 scripts/eval_bugsjs.py --manifest <fixtures>/manifest.json --out <results> --label run1
    python3 scripts/eval_bugsjs.py ... --mode bg      # background sessions
    python3 scripts/eval_bugsjs.py ... --mode tty     # interactive terminal UI in screen
    python3 scripts/eval_bugsjs.py ... --context-tokens 9000 --resume-prompt '...'
    python3 scripts/make_synth_six.py <fixtures>/synth-six   # long-six.json and chain-six.json, validated
    python3 scripts/make_synth_six.py --eight <fixtures>/synth-eight   # chain-eight.json, validated
    python3 scripts/eval_bugsjs.py --manifest <fixtures>/synth-six/chain-six.json ... --budget 1800 --max-turns 60
    python3 scripts/eval_coding.py --prompts compact --tasks csv cache
    python3 scripts/eval_qa.py --out <results> --label qa --repo <fixture>
    python3 scripts/eval_queue_cancel.py --out <results> --label q1 --reply-log <server WA_REPLY_LOG>
    python3 scripts/summarize_evals.py <results>/run1 ...
    WA_EVAL_REPLY_LOG=<server WA_REPLY_LOG> WA_EVAL_DEFAULT_BACKEND=1 WA_EVAL_CLIPPY_PER_HOUR=150 WA_EVAL_CLIPPY_PER_DAY=700 \
      python3 scripts/eval_bugsjs.py ... --pause 60 --require-clippy   # record backends, pace under the CLIPPY quota
    python3 scripts/eval_bugsjs.py --manifest ... --label x --rescore <labels>   # re-judge saved diffs

Run one batch at a time: the gateway serializes requests through one WhatsApp chat. Keep fixtures outside `/tmp` (macOS deletes files there after three days without access) and keep the machine awake (`caffeinate -i`).

## Decision

**Usable for ordinary Claude Code coding sessions, on Meta AI's CLIPPY backend and within its daily quota.** Claude Code stays native throughout: it runs every tool under its own permissions and owns the transcript, compaction, and resume. Coding results below are end-to-end passes judged by the independent scorer (revision 8), on CLIPPY replies only; the queue and cancellation checks are scored by their own tokens.

| Evidence (CLIPPY) | Result |
|---|---|
| Sealed group for the final revision: 10 ESLint bugs never used before, pre-registered, first contact, frozen Z5 | **10/10** (median 52 s; 15-210 s; 105 CLIPPY replies) |
| Final sealed group: 10 BugsJS bugs in ESLint and hessian.js never used before, first CLIPPY contact, frozen Z2 | **8/10** (median 51 s); both failures ended on a reply that only announced its next step (fixed in Z4; those cases then passed 6/6, unsealed) |
| Fresh sealed group: 7 never-used Express bugs, first contact, S | 5/7 (both failures were 413s fixed in V) |
| Original sealed holdouts (7 bugs), first complete CLIPPY run, S | 4/7 |
| BugsJS dev cases (7), regression passes on Z2 / Z4 / Z5 | 7/7 / 6/7 / 7/7 (the Z4 failure was a WhatsApp drop during a send after a correct edit; fixed in Z5, and that case then passed 3/3) |
| Cases that failed on Y (thrash, disconnect), same cases rerun on Z2 | 8/8 (were 2/8) |
| Six small realistic fixes, A-B-B-A against the old backend, same binary | 24/24 (old backend 13/24) |
| Six-module single session with a `--resume` follow-up, Z2 | 2/2 (about 95 s each) |
| Six modules handed over one per turn through six `--resume` follow-ups, Z2 / Z3 / Z4 | 2/2 / 2/2 / 2/2 (200-250 s each on Z3-Z4, no test loop) |
| Eight tasks (six fixes, the TTL fix, the CSV parser feature) handed over one per turn in one native session, Z4 | 2/2 (285 and 320 s); each session compacted natively once and finished after resuming |
| The three sealed-group and holdout stalls (announced next step), same cases rerun on Z4 | 6/6 |
| Plain Q&A; interactive terminal; fresh bot session per task (empty chat) | 6/6; 2/2; 12/12 (same as the shared chat) |
| Three sessions at once through the one WhatsApp chat; Ctrl-C on a queued session; Ctrl-C mid-reply, then a new session, Z5 | 7/7; 4/4; 6/6 (no reply reached the wrong session) |

On Meta AI's default backend (`LLAMA_PROD`) the same gateway passed 1 of 138 dev attempts and 0 of 21 holdout attempts: the backend, not the adapter alone, decides usability. The gateway reaches CLIPPY by declaring one client capability (`RICH_RESPONSE_UR_REASONING`) in its WhatsApp bot metadata.

**Limits a user will meet:**

- **Quota.** CLIPPY answers about 830 replies per account in a rolling 24 hours, and it also went quiet for 17-50 minutes twice after about 250 replies within an hour. A BugsJS attempt used a median of 8 CLIPPY replies (2-30; 90th percentile 15, over 102 attempts), so that is roughly 100 repository fixes a day. CLIPPY gives no notice when it stops; the gateway falls back to the standard backend after 60 s of silence (much weaker at coding), backs off up to 4 hours while the silence continues, and the launcher warns at startup when that fallback is active.
- **Not versioned.** Meta can change or withdraw CLIPPY, the capability route, or the quota without notice. Nothing here identifies the model behind CLIPPY.
- **Remaining failures.** Wrong patches (Express 23 in every attempt; one ESLint 10 attempt). The turn-handling stalls found here were fixed and their cases rerun: a reply that only announces its next step (3 cases, 6/6 on Z4), a passing test rerun 48 times (2/2 on Z3), and a WhatsApp drop during a send (Z5). A dropped connection can still cost a session time; Meta AI can also go quiet for minutes, after which the gateway falls back to the weaker backend.

### Before the backend switch (LLAMA_PROD, November 13-15)

**Not yet usable as the model for ordinary Claude Code coding sessions.** No tested configuration made repository repair reliable. Across 13 gateway revisions with native runs and every invocation mode, **1 of 138** scored BugsJS dev attempts passed (Express 20, background session), and **0 of 21** holdout attempts passed (14 sealed on frozen revisions, 7 unsealed reruns). Small self-contained fixes work part of the time: the TTL fix passed end to end in 12 of 23 attempts (12 of 18 from revision G onward), six realistic small bug fixes passed in about 60 percent of matched default runs (29 of 48, after correcting one held-out judge), and the CSV parser passed once in 23. Plain Q&A works (5 of 6 on the final measurement). Neither reasoning lever helped: Meta AI's "think hard" mode and a prompt-level reasoning cue both had no measurable effect, and neither did testing after every edit or a requirements review after the tests pass.

The native mechanics run: background sessions in worktrees, the interactive terminal, native compaction and resume, plain Q&A, and a fresh install. They are not fully robust: undecodable replies still end some sessions, and the edit format matters (see the isolation experiment). A controlled comparison of a direct request against the gateway's presentation, with identical inputs, showed both failure kinds: Meta AI fails to infer correct ESLint and CSV fixes in either presentation, and for Express 20 the presentation itself blocked a change Meta AI could describe. Gateway changes made from that evidence raised correct first proposals on Express 20 from 0 of 9 to 2 of 3, but did not raise end-to-end repair rates in native sessions.

At the time, the one untested lever needed the account owner: the Muse bot, which refuses this linked device with "no active WASA root secret". It was not pursued; the CLIPPY backend changed the picture instead.

## Results

Every attempt, with its wall time and failure layer, is listed in [ATTEMPTS.md](ATTEMPTS.md) (generated by `scripts/summarize_evals.py`); blocked and harness-invalid attempts are excluded from the counts below and listed separately.

## Results on the CLIPPY backend (November 15-17)

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
| Cases that thrashed or failed on T, rerun (Express 13; ESLint 19; hessian.js 2, 7; two each) | Y 87c4539 | 8 | 2 | 2 | 1 no reply (disconnect) |
| ESLint 19 again | Z a13e6cd | 2 | 1 | 1 | |
| Same eight attempts | Z2 100b3d9 | 8 | **8** | 8 | |
| **Final sealed group** (ESLint 1, 2, 4, 6, 7, 8; hessian.js 3, 5, 8, 9), first CLIPPY contact, run once | Z2 | 10 | **8** | 8 | |
| Dev regression pass | Z2 | 7 | **7** | 7 | |
| ESLint 7 and hessian.js 3 (unsealed now), ESLint 19; two each | Z4 beadc76 | 6 | **6** | 6 | ESLint 19 round 1: harness (checkout damaged before launch), replaced by a third attempt |
| Dev regression pass | Z4 | 7 | **6** | 7 | |
| Express 17 (the Z4 dev failure), two attempts | Z5 4fe4ed2 | 2 | **2** | 2 | |
| Dev regression pass | Z5 | 7 | **7** | 7 | |
| **Sealed group for the final revision** (ESLint 9, 11, 12, 14, 16, 17, 18, 20, 21, 23), pre-registered, first contact, run once | Z5 4fe4ed2 | 10 | **10** | 10 | |

The final sealed group's first run (on Y) went to the standard backend through a scripting error: 1 of 10, not a CLIPPY result (see incidents). In the final sealed run every one of the 94 replies came from CLIPPY.

Old backend for comparison: 1 of 138 dev attempts and 0 of 21 holdout attempts, with the same cases and scorer.

Failures on CLIPPY, by cause:
- **413 after native compaction** (S: fresh Express 26 and 27, holdouts ESLint 19 and hessian.js 7, dev Express 10). Claude Code re-attaches files read earlier as text after compacting; the gateway could not trim them and the WhatsApp view exceeded 60,000 characters. Fixed in V (with the parallel-read budget in T); none of the T attempts hit a 413.
- **Compaction thrash** (T: Express 13, ESLint 19, hessian.js 7, one attempt each; Y: 4 of 8 reruns). Claude Code stops a session with "Autocompact is thrashing" when the context refills within three turns of a compaction, three times in a row. W's shorter summaries did not fix it. Root cause, traced on hessian.js 2: with the launcher's 26,000-token window, Claude Code compacts at about 11,400 tokens and the compacted session restarts at 9,500-11,200 (summary, kept recent turns, re-attached files), so two file reads trigger the next compaction. Z raised the window to 50,000 tokens, reports the untrimmed transcript size as usage so Claude Code's own accounting decides when to compact, and trims compaction requests to the WhatsApp cap like any other request. The same eight attempts then passed 8/8 on Z2.
- **WhatsApp disconnect** (Y: Express 13, one attempt). A transport disconnect failed the pending request, and Claude Code ended the session. Z2 keeps the request across the reconnect, resends a send that never left, and lets new requests wait up to 30 s for the connection.
- **Meta AI error text as the answer** (Z: ESLint 19, one attempt). "Something went wrong. Please try again." came back as the final answer. Z2 retries it once, as it already did for the other error message.
- **Announced next step** (Y: ESLint 19; Z2: sealed ESLint 7 and hessian.js 3). A short reply such as "Fixing always-multiline to compare the last item against the closing bracket, not the whole node." with no tool call ends the Claude Code turn, so the session stopped before any edit. Z4 asks once for the tool. Across all 858 logged text replies, the check matches exactly these three replies and one LLAMA_PROD-era reply of the same kind.
- **Send on a connection that had just dropped** (Z4: dev Express 17, after a correct edit). The WhatsApp socket closed while a prompt was being sent; the transport reported the failed send before its disconnect event, so the gateway, still marked ready, failed the request with a 502 instead of resending it after the reconnect, and Claude Code ended the session before running the test. Z5 resends a prompt whose send failed on a dropped connection whichever event comes first (up to three times per request), and resends after 5 s if no disconnect event follows.
- **Passing-test loop** (Z2: chain-six round 1). After the last follow-up ("Run exactly: node --test. ..."), CLIPPY ran the passing suite 48 times; the request still read as an order after it ran. Claude Code compacted natively once in that run (35,009 to 3,069 tokens) and the session then ended correctly, after 440 s. Z3 states beside the request that the passing result is current, and asks once more before a rerun with nothing changed. It also trims long WhatsApp views 2,000 characters below the cap, so a repair always fits (one near-cap repair had been dropped on J).
- **Wrong patch**: Express 23 in all four attempts on S and T (the patch passes the target but breaks `app should reject missing functions` in the same file); Express 8 once; ESLint 10 once on Q (fails a held-out ESLint contract check).
- **Agent behavior**: hessian.js 2 failed twice on T: once CLIPPY tried to run the listed tools itself and answered that they were unavailable (repaired by X), once it spent its 300 s paging through files with placeholder edit frames (guarded by Y).

### Synthetic tasks, modes, and Q&A (revision T/V unless noted)

| Check | Result |
|---|---|
| TTL cache fix | 2/2 (12-14 s) |
| CSV parser (quoted empty fields, delimiter-only rows, spaces) | 2/2 (13-24 s); 1 of 23 on LLAMA_PROD |
| Background sessions (`--bg`, native worktree) | 2/4: Express 13 and 20 pass; ESLint 10 fails; Express 11's patch is correct but its Edit is missing from Claude Code's background transcript, so the runner cannot confirm a test after it (the gateway log shows the Edit before the test). Rerun of ESLint 10 and Express 11 on Y: 2/2 |
| Interactive terminal UI | 2/2 (Express 13, 20) |
| Two-module task with `--resume` follow-up | 2/2 (33 and 48 s; finished before any compaction) |
| Six-module session, one task, then a `--resume` follow-up | Y: 1/1 counted (77 s; the other attempt ran on the standard backend and is excluded). Z2: 2/2 (96 and 93 s, seven edits each; it fixed all six modules in one pass, so no compaction was needed) |
| Six modules handed over one per turn (`chain-six`, six `--resume` follow-ups in one native session) | Z2: 2/2 (440 and 252 s). Round 1 hit the passing-test loop above and compacted natively once, then finished correctly. Z3 (matched rerun): 2/2 (249 and 252 s, six edits each, no repeated passing test; the new repair never fired). Z4: 2/2 (196 and 217 s) |
| Plain Q&A | 6/6, including the `[[1,[2]],3].flat()` question every LLAMA_PROD batch got wrong |
| Eight tasks one per turn (`chain-eight`: the six modules, the TTL cache fix, the CSV parser feature; eight `--resume` follow-ups), Z4 | 2/2 (285 and 320 s, nine edits each). Each session compacted natively once at the default 50,000-token window and finished after it. Round 2's final summary said nothing had changed "in this session", describing only the last turn; the code was correct. |
| Fresh clone: `npm ci`, launcher, live reply | works: a new clone from GitHub at 9f4fbf0 (gateway source identical to Z5) installs with `npm ci`, builds the Go transport from source (vet clean), passes all 101 unit tests and the five Claude Code smoke tests, and its launcher gets a live reply ("Hello", 3 s). The same held for a clone at 3ab597b (Z4 source). |

### Queue and cancellation (Z5, CLIPPY)

`scripts/eval_queue_cancel.py` runs real launcher sessions against the paired gateway, each prompt carrying a random token so a reply delivered to the wrong session is visible. Seven rounds:

| Check | Result |
|---|---|
| Three sessions started together (a word, a product, a native Read of a file); the gateway sends one at a time | 7/7 rounds, every session got its own answer (all three done in 7-15 s) |
| Ctrl-C (SIGINT to the process group) on a session waiting in the gateway queue behind a long answer | 4/4 valid rounds: its prompt never reached Meta AI and the other session's answer was correct. In 3 rounds the "queued" session had already finished before the interrupt (the first design held the chat with too short an answer); they are not counted |
| Ctrl-C mid-reply, then a new session at once | 6/6 valid rounds: the new session got its own answer (4-39 s, waiting out the cancelled reply), and the cancelled reply arrived later and was dropped as unmatched. In 1 round the reply finished before the interrupt; not counted |

### CLIPPY's usage limit and the fallback

CLIPPY stopped answering this account three times within an hour of heavy use: after 250 replies in 33 minutes, after 263 in 52 minutes, and after 190 in the preceding hour. There is no reply and no notice; the standard backend keeps answering, and a brand-new bot session gets no CLIPPY reply either, so the limit is per account. The first two silences lasted 17 to 50 minutes. The third lasted 20 hours (01:22 to about 21:46 UTC, November 16): CLIPPY had answered 833 replies in the 24 hours before it, and it came back 24.5 hours after its first use that day. So besides the short hourly silences there is a daily limit of roughly 830 replies, apparently over a rolling 24 hours. Declaring Meta's subscription-metering capabilities brought no notice or different behavior during the silence, only the same silence. Later batches paced to 150 CLIPPY replies an hour and 700 a day (800-820 for the last reruns) and met no further silence. A BugsJS attempt used a median of 8 replies, so ordinary interactive use stays inside the limit; batch evaluation does not.

When CLIPPY is silent for 60 s, the gateway resends the same prompt through the standard backend and keeps using it for 20 minutes (`/health` reports this). A session therefore continues instead of hanging, but at the old backend's quality.

### Fresh install and chat history (CLIPPY)

On LLAMA_PROD a fresh chat was much worse than the long shared chat (below). On CLIPPY it makes no difference: the middle tier in the shared chat versus a new bot session per task (an empty chat, as on a fresh install), A-B-B-A twice on Y, each round checked to start on CLIPPY: 12/12 and 12/12 end to end, every run tested after its last edit.

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

Isolation made coding worse. On the middle tier, A-B-B-A twice (24 runs per arm): the shared chat produced 17 correct patches and 15 end-to-end passes, and ran the test after its last edit in 20 runs; isolated sessions produced 12 correct patches, 0 end-to-end passes, and never ran a test. The long chat history, full of earlier exchanges that read, edited, and tested, was teaching Meta AI the workflow. **These LLAMA_PROD numbers were measured on a heavily used chat; a fresh install with an empty chat would likely have done worse.** On CLIPPY an empty chat made no difference (12/12 in both arms; see above).

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
- **Native compaction (Z):** the launcher's client window is 50,000 tokens (26,000 thrashed); usage reports the size of Claude Code's whole transcript rather than the trimmed WhatsApp view, so Claude Code decides when to compact from what it actually holds; compaction requests are trimmed for WhatsApp like other requests instead of being refused. The mock smoke test now requires at least two compactions with no thrash.
- **Transport and backend robustness (Z2):** a WhatsApp disconnect no longer fails the pending request; a send that failed while disconnected is resent after the reconnect, and new requests wait up to 30 s. Both Meta AI error texts are retried once. While CLIPPY stays silent, the fallback period doubles up to 4 hours, and `/health` and the launcher report it.
- **Turn handling (Z3, Z4):** a test command that already passed in the current task, with nothing changed since, is reported as current beside the request and is not rerun without one more ask; a short reply that only announces its next step gets one request for the tool; long WhatsApp views are trimmed 2,000 characters below the cap so that a repair always fits.

## Exclusions and incidents

- The machine slept mid-batch and WhatsApp disconnected; 11 attempts were blocked and excluded. Later batches ran under `caffeinate` and the runner waits for gateway readiness.
- The macOS daily `/tmp` cleanup deleted the dev fixtures and part of the paired runtime. Fixtures were rebuilt at the same tag commits (preflights identical except one previously flaky test), the runtime was restored, and all saved patches were rescored with no outcome change.
- Harness defects found during the run were fixed and the affected attempts excluded: the interactive-terminal runner (launcher session variables), the repository Q&A copy (no `.git`, so Grep searched `node_modules`), a runner crash on Claude Code's `permission_denied` event (interrupted holdouts were rerun on the same gateway), and a forced-compaction window that was too small.
- An external Q&A request from an earlier session shared the WhatsApp chat once during the baseline; the overlapped attempt is labeled.
- CLIPPY stopped answering this account twice (21:51-22:39 and 23:33-23:50 UTC, November 15) after about 250 replies in the preceding hour. Attempts that ended in that silence (ESLint 19, hessian.js 2 and 7 on Q) are reported as "no reply"; one attempt that ran on the standard backend after the fallback (Express 10 on T) is kept apart and was rerun. A brand-new bot session got no reply during the silence either, so the limit is per account.
- Batch S was stopped after its dev stage began, once the 413 failures it was producing had a known cause (fixed in V); its fresh-group and holdout results are reported, the dev stage is not.
- A zsh word-splitting bug in one batch script skipped three stages instantly; no attempt was made, and the batch was restarted.
- **Runner checkout and `/tmp` cleanup (November 17-18).** One Z4 attempt ran on a checkout that the macOS `$TMPDIR` cleaner had emptied during a 19.5-hour quota wait (see the runner correction); it is listed as harness-invalid and was replaced. At midnight on November 18 a cleanup of `/tmp` deleted files untouched for about three days: the working clone's git metadata (restored from GitHub; nothing unpushed was lost), the original holdout fixtures (rebuildable with `prepare_bugsjs.py`; no further holdout runs were planned), the gateway reload script (restored), and the raw records of 16 LLAMA_PROD-era attempts from November 13 (batches pre, pre-bg, c2, c2-bg, all failures). Their outcomes are kept from a summary taken six hours earlier, so the counts above are unchanged. It also deleted ESLint 10's held-out contract check, so the Z5 dev attempt on ESLint 10 first scored as a failure ("Cannot find module"). The check was rebuilt from its recorded edit history; it reproduces the saved verdict and failure lines of all 22 earlier ESLint 10 attempts, and the Z5 attempt passes it on rescoring. It is now kept in the repository (`scripts/checks/`), and the runner checks fixtures and check scripts before every batch, not only before the first preflight. Private records now also live outside `/tmp`.
- **Final sealed group on the wrong backend (scripting error, November 16).** The chain script meant to wait for CLIPPY probed 60 times during the 20-hour silence and then started the final sealed run anyway, so it ran entirely on the standard backend (1 of 10: ESLint 1 passed; hessian.js 3 hit a disconnect). No transcript from it was inspected and no gateway change came from it. The runner now has `--require-clippy`, and the group's CLIPPY measurement is its single run on frozen Z2, the first time CLIPPY saw those cases. The same silence put one Y long-session attempt on the standard backend; it is excluded.

## Limitations

- One linked account, one bot address, one machine. Meta AI's backends are not versioned and can change without notice; CLIPPY is reached through a client capability Meta could stop honoring.
- Quota: about 830 CLIPPY replies a day per account, plus short silences after heavy hourly use. Beyond it, sessions continue on the standard backend at much lower quality.
- Each case ran once to a few times per revision, so differences of one or two attempts are within noise. The sealed groups (7 fresh Express bugs on S, 10 ESLint and hessian.js bugs on Z2, 10 ESLint bugs on Z5) are the least biased numbers; reruns after a fix informed by a failure are labeled unsealed. The Z5 sealed group is one project (ESLint), each bug with a single regression test file, so 10/10 there does not carry over to every kind of repository change.
- The tasks are real single-bug repairs in three JavaScript projects (some needing edits in two files), small synthetic modules, and one small feature (the CSV parser). Larger feature work, refactoring, other languages, and very large repositories were not measured.

## Next steps

- **Quota-aware use.** A per-user daily budget and a clearer warning before CLIPPY goes quiet would help heavy users; the gateway already detects the silence and falls back.
- **Wrong patches.** The remaining failures are mostly patches that pass the target but break a neighboring test (Express 23). Running the whole affected test file after a passing target is a candidate change, measured as its own arm.
- **Wider tasks.** Add feature and refactoring tasks and a non-JavaScript project to see where usefulness ends.
- **Muse.** Not pursued (owner's decision). Sends to the Muse bot still fail on this linked device with "no active WASA root secret".
