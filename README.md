# whatsapp-code

An experimental adapter that uses WhatsApp's consumer Meta AI as the model behind Claude Code.

Claude Code sends Anthropic Messages requests to a local gateway. The gateway sends the request through WhatsApp, returns Meta AI's text answers or validates its structured tool calls. Claude Code executes tools under its own permission rules.

**Status:** verified a live WhatsApp → Meta AI → Claude Code tool round trip on November 9, 2026. Meta AI requested a file read, Claude Code executed it, and Meta AI returned the random verification code from the file. Twenty-six local tests and four Claude Code smoke tests also pass. This is a small integration check, not evidence of reliable long coding sessions.

The transport uses [whatsmeow](https://github.com/tulir/whatsmeow), an **unofficial linked-device API**, not the WhatsApp Business API. Unofficial clients can stop working or lead to account restrictions. Check WhatsApp's current terms before using it. This project is not affiliated with Meta, WhatsApp, or Anthropic.

## Setup

Install from source with Node 22+, Go 1.26+, a C compiler (for SQLite), Claude Code on PATH, and WhatsApp with Meta AI available. The build creates `bin/whatsapp-transport`. The launcher uses the local gateway token, so inference requires only the linked WhatsApp account. Tested locally with Claude Code 2.1.321 on macOS arm64.

    git clone https://github.com/hetankevin/whatsapp-code.git
    cd whatsapp-code
    npm ci
    npm run build
    npm start

Open the pairing.html path printed by the gateway in a browser. On your phone, open **WhatsApp → Settings → Linked devices → Link a device**, then scan the QR. The page refreshes as QR codes rotate. If pairing expires, restart the gateway and reload the page. Wait for the terminal to report WhatsApp ready.

Keep the gateway running. From the project you want to work on:

    node /path/to/whatsapp-code/src/launch.mjs

For a first check:

    node /path/to/whatsapp-code/src/launch.mjs -p 'Reply with hello.'

To start an attachable Claude Code session in a trusted project, pass an initial task with `--bg`:

    node /path/to/whatsapp-code/src/launch.mjs --bg -- 'Run the test suite.'
    claude attach <session-id>

Use the session ID printed by the launcher. Claude Code manages the background session and terminal interface.

The launcher uses a compact coding prompt, disables Claude Code session recaps for that launch, and requests the Read, Write, Edit, Glob, Grep, and Bash tools. Claude Code selects which tools appear in the request. The default launcher uses Claude Code's safe mode to expose native tools while disabling ordinary hooks, plugins, and MCP servers. The fixed-file verification modes use bare mode. The launcher supplies the actual working directory, a root file listing, and root AGENTS.md/CLAUDE.md contents to Meta AI; it does not read unrelated file contents. Global Claude Code settings are not changed. Interactive tool permissions remain with Claude Code; the adapter never executes commands itself.

## Data and access

**Prompts, code, and tool results are sent to Meta AI through your WhatsApp account**, and may appear in the Meta AI chat on other devices. Consumer Meta AI's policies apply. Do not assume ordinary person-to-person WhatsApp privacy protections apply to data sent to Meta AI.

WhatsApp grants a paired device account-level access. This implementation disables history downloads and ignores messages except replies from the selected Meta AI bot. That filter does not narrow the underlying credential's permissions.

The device database, gateway token, and pairing page stay in local application storage, outside the checkout: ~/Library/Application Support/whatsapp-code on macOS, or $XDG_STATE_HOME/whatsapp-code (default ~/.local/state/whatsapp-code) on Linux, with restrictive filesystem permissions. Never share that directory. Revoke the linked device from your phone when finished. The gateway listens on 127.0.0.1, requires its local token, and rejects browser-origin API requests. Do not expose it publicly.

## Limits

- The gateway sends one request to WhatsApp at a time and queues overlapping requests in arrival order. Streaming requests receive keepalives while they wait.
- The normal launcher uses Claude Code's native compaction. It defaults to a 26,000-token client window and a 2,048-token output setting to leave room for the compaction request. The gateway sends that request to Meta AI as text. Each WhatsApp prompt still has a 60,000-character cap, so large individual reads or tool outputs can exceed it.
- Recognized Claude Code background notification checks fall back to Claude Code’s local status heuristic. The gateway keeps those requests out of WhatsApp.
- Existing Meta AI chat history is not reset or deleted. Prompt instructions cannot guarantee isolation from Meta AI's existing memory.
- Text and ordinary client tools only. Unsupported media, server tools, extended thinking, and structured-output API settings are rejected.
- For coding requests with Read and Edit, Meta AI sends a standalone EDIT frame with a short handle from the current Read snapshot and an inclusive line range. The matching WhatsApp turn supplies the request identity. Each replacement line can encode its leading whitespace before a vertical bar, so the gateway can restore indentation even if chat strips it. The gateway builds the exact match from the Read result and sends a regular Edit to Claude Code. In later WhatsApp prompts, that edit is shown as changed lines with the linked tool result. A fresh Read is required after a file mutation or shell command. The gateway matches the WhatsApp reply to its outbound turn and validates tool arguments before returning them to Claude Code. An explicit request ID must match.
- Replies are buffered, then emitted as Anthropic SSE events. This is not native token streaming.
- Token counts are character-based estimates, not tokenizer or billing data.
- No model-version pinning, sampling controls, or enforceable output-token limit.
- A malformed reply, an explicit stale request ID, or an immediate repeat of a failed standalone test gets at most one repair request. A stale ID triggers a fresh copy of the current prompt and the stale content is discarded. For test retries, the repair includes the failing output. The guard uses the tool history and clears after a new user turn or a potentially mutating tool. No tool executes before the repaired reply passes validation. Unknown tools are rejected. Network failures and cancellations end the request.
- Known rich text/code fields are decoded. New binary formats or WhatsApp protocol changes may require updates.
- Discovery chooses a known Meta AI bot returned by the account, preferring Muse. Retired phone-number discovery results map to the current Meta AI bot address. Different bot addresses/surfaces need not use the same model.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| WA_PORT | 8787 | Loopback port; set on server and launcher |
| WA_STATE_DIR | local application storage | Private runtime directory; set on server and launcher |
| WA_BOT_JID | discovered | Explicit known Meta AI address; set on server |
| WA_SNAPSHOT_CONTEXT | off | Set to 1 on the server to try single-file snapshot context |
| WA_EDIT_FILE | unset | Single file to edit with automatic Node test runs. Set on the launcher. |
| WA_EDIT_FILES | unset | JSON array of up to eight existing file paths for automatic verification. Set on the launcher. |
| WA_TEST_COMMAND | node --test in fixed-file mode | Run the exact command before editing and after each successful edit. With no fixed files, Meta AI discovers the files through Claude Code’s tools. Claude Code applies its Bash permissions. |
| WA_EDIT_RANGES | unset | JSON array in edit target order. Use a one-based [offset, limit] pair to read a fixed excerpt or null to read the whole file. |
| GO_BINARY | go | Compiler for npm run build |

Supported explicit bot addresses are defined by whatsmeow: 1807055946647697@bot (Muse), 867051314767696@bot (Meta AI), and 13135550002@s.whatsapp.net (legacy). An override does not establish account eligibility.

The live test used 867051314767696@bot. The legacy phone address failed, and Muse required encryption state that was not present on the newly linked device. If you see “no active WASA root secret,” this is missing Muse session state, not a Claude Code error. Do not assume that pairing alone makes Muse available.

## Tests

    npm test
    npm run test:claude

The second command runs Claude Code in a temporary directory against a local fake model. It checks a model-directed edit, automatic verification across one and two files, and native Glob, Grep, and automatic compaction. It does not establish live Meta AI compatibility. CI tests the protocol and Go build; live account tests are excluded.

Dependencies are pinned in package-lock.json and transport/go.sum. Original code is MIT licensed; dependencies retain their licenses.

## References

- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [whatsmeow API](https://pkg.go.dev/go.mau.fi/whatsmeow)
- [Meta AI on WhatsApp](https://ai.meta.com/learn/ai-basics/how-to-use-meta-ai-on-whatsapp/)

Existing checkouts from the initial version used .state/. Stop the gateway and move that directory to the platform storage location above, or set WA_STATE_DIR to its absolute path on both server and launcher. Keep credentials outside synced project folders.

## Coding-harness development

Select a prompt with --harness-prompt compact, --harness-prompt coding, or --harness-prompt native. Compact is the initial bootstrap prompt; coding supplies fuller project-inspection, edit, test, and permission guidance; native uses Claude Code's own default prompt. All three receive project context and the WhatsApp JSON protocol. Native may exceed the gateway context limit.

For a single-file task, start the gateway with `WA_SNAPSHOT_CONTEXT=1 npm start` to try sending less context. Each primary WhatsApp prompt includes the latest task, at most one current numbered Read snapshot, the latest test failure, and the status of the most recent tools. Claude Code keeps the full transcript and still handles tools and permissions. A shell command or edit invalidates the snapshot, so a fresh Read may be needed. This mode omits other tool output and is intended for experiments on bounded tasks.

For a single-file Node task, set `WA_EDIT_FILE` on the launcher from the project root:

    WA_EDIT_FILE=csv.mjs node /path/to/whatsapp-code/src/launch.mjs -p 'Fix empty fields in parseCSV.'

The gateway asks Claude Code to run `node --test` and read that file before the first proposal and after every successful edit. Meta AI receives the task, numbered source, and latest failure, and supplies replacement source. The gateway ties it to the current file snapshot and Claude Code checks the old text before editing. Claude Code still applies its normal permissions. The harness stops when the project tests pass or after five edits with failing tests. To run the live CSV fixture in this mode:

    python3 scripts/eval_coding.py --verify-edits --prompts compact --tasks csv

For a task that spans files, set `WA_EDIT_FILES` to a JSON array:

    WA_EDIT_FILES='["book-store.mjs","discount.mjs"]' node /path/to/whatsapp-code/src/launch.mjs -p 'Fix basket pricing.'

Meta AI selects one of those files per proposal. Claude Code tests and rereads all selected files before the next proposal. The same five-edit budget applies to the whole task.

Run the two-task Exercism pilot with:

    python3 -B scripts/eval_exercism.py

The runner downloads canonical cases from a pinned revision of [Exercism's problem specifications](https://github.com/exercism/problem-specifications/tree/7b49ec415e9169cce4aa0206d2b51ce66d98b9aa). It supplies some cases during the edit loop and reserves the rest for scoring. Book Store uses a two-file adaptation, with a separate test for the discount helper. In the first live run, Alphametics passed all cases in 10.5 seconds. Book Store changed both files but passed only five of seven visible tests within the five-edit budget. Its greedy grouping missed cases where two groups of four cost less than groups of five and three. Results are stored in ignored `.work/coding-evals-exercism`.

The live development exercises run with:

    python3 scripts/eval_coding.py --prompts compact coding native

This sends prompts and disposable example code through your paired WhatsApp account. It tests a TTL cache fix and CSV parsing against visible and held-out checks. A pass requires changes confined to the implementation file and a successful test command after the last edit. The runner records how many translated line edits Claude Code executed successfully. Results and traces stay under ignored .work/coding-evals. These are small development exercises, not a general coding benchmark.

The first three-prompt comparison completed one of six runs. Compact passed the cache task, and all three prompts failed CSV. Follow-up runs on the two tasks also failed. The observed problems include malformed tool replies, edits that differ from the file's exact whitespace, and ending a turn after a failed test. The compact prompt remains the default. These runs are too small to rank the prompts reliably.

With EditLines, the compact prompt applied two cache changes successfully. The deadline boundary test still failed when a later model reply could not be decoded. The CSV run read the file and ran the tests but made no edit before hitting the same reply error. Both runs failed the end-to-end criteria. The line-range translation itself passed the local Claude Code integration test.

The short EDIT header and test recovery guard produced one pair that passed the original fixture checks. A separate review found that its CSV patch missed a standalone quoted empty field. In the final rerun, cache passed in 35.1 seconds with one translated edit and a successful test run. CSV failed in 34.6 seconds when a reply could not be decoded, before any edit applied. Explicit indentation remains available in the repair format. The fixture runs still show variable live reliability.

The CSV fixture now requires a standalone quoted empty field in the visible tests and two such rows in the held-out tests. The decoder recovered the captured EDIT frames with literal newlines and quotes inside malformed JSON. In the expanded live run, three edits applied, then the model sent a stale request ID. It did not pass both the quoted-empty and final-newline tests on the same patch. A separate retry with a row-state hint also failed.

In the first live snapshot-mode CSV run, all visible tests passed, including the standalone quoted empty field. The held-out suite failed because the patch dropped a delimiter-only row. A retry with explicit fence-free edits and better syntax-error feedback ended on an undecodable reply before editing. Neither run met the full pass criteria.

With automatic verification and source-only proposals, a live CSV run passed all six visible tests and the held-out checks in 20.7 seconds. The first edit passed the quoted-empty test and failed the delimiter-only test. The harness supplied the failure and fresh source, and the second edit passed. A separate probe found the generated parser dropped unquoted whitespace.

The next run added a visible regression for spaces in unquoted fields and kept the quoted-empty and delimiter-only tests. The same automatic verification harness passed all seven visible tests and the held-out suite in 20.0 seconds.
