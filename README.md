# whatsapp-code

An experimental adapter that uses WhatsApp's consumer Meta AI as the model behind Claude Code.

Claude Code sends Anthropic Messages requests to a local gateway. The gateway sends the request through WhatsApp, validates Meta AI's JSON reply, and returns text or tool calls. Claude Code executes tools under its own permission rules.

**Status:** verified a live WhatsApp → Meta AI → Claude Code tool round trip on November 9, 2026. Meta AI requested a file read, Claude Code executed it, and Meta AI returned the random verification code from the file. Nineteen local tests and a separate fake-model integration test also pass. This is a small integration check, not evidence of reliable long coding sessions.

The transport uses [whatsmeow](https://github.com/tulir/whatsmeow), an **unofficial linked-device API**, not the WhatsApp Business API. Unofficial clients can stop working or lead to account restrictions. Check WhatsApp's current terms before using it. This project is not affiliated with Meta, WhatsApp, or Anthropic.

## Setup

Requires Node 22+, Go 1.26+, a C compiler (for SQLite), Claude Code on PATH, and WhatsApp with Meta AI available. Tested locally with Claude Code 2.1.317 on macOS arm64.

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

The launcher uses a compact coding prompt and requests the Read, Write, Edit, Glob, Grep, and Bash tools. Claude Code selects which tools appear in the request. Claude Code's bare mode avoids importing ordinary hooks and MCP servers. The launcher supplies the actual working directory, a root file listing, and root AGENTS.md/CLAUDE.md contents to Meta AI; it does not read unrelated file contents. Global Claude Code settings are not changed. Interactive tool permissions remain with Claude Code; the adapter never executes commands itself.

## Data and access

**Prompts, code, and tool results are sent to Meta AI through your WhatsApp account**, and may appear in the Meta AI chat on other devices. Consumer Meta AI's policies apply. Do not assume ordinary person-to-person WhatsApp privacy protections apply to data sent to Meta AI.

WhatsApp grants a paired device account-level access. This implementation disables history downloads and ignores messages except replies from the selected Meta AI bot. That filter does not narrow the underlying credential's permissions.

The device database, gateway token, and pairing page stay in local application storage, outside the checkout: ~/Library/Application Support/whatsapp-code on macOS, or $XDG_STATE_HOME/whatsapp-code (default ~/.local/state/whatsapp-code) on Linux, with restrictive filesystem permissions. Never share that directory. Revoke the linked device from your phone when finished. The gateway listens on 127.0.0.1, requires its local token, and rejects browser-origin API requests. Do not expose it publicly.

## Limits

- One active request at a time; no parallel sessions or agents.
- Full supplied context is resent, up to a 60,000-character limit. Oversized requests fail rather than silently truncating code.
- Existing Meta AI chat history is not reset or deleted. Prompt instructions cannot guarantee isolation from Meta AI's existing memory.
- Text and ordinary client tools only. Unsupported media, server tools, extended thinking, and structured-output API settings are rejected.
- For coding requests with Read and Edit, Meta AI sees EditLines. It supplies a recent read ID, an inclusive line range, and literal replacement source. The gateway builds the exact match from the Read result and sends a regular Edit to Claude Code. A fresh Read is required after a file mutation or shell command. The gateway checks the request ID and validates tool arguments before returning them to Claude Code.
- Replies are buffered, then emitted as Anthropic SSE events. This is not native token streaming.
- Token counts are character-based estimates, not tokenizer or billing data.
- No model-version pinning, sampling controls, or enforceable output-token limit.
- A malformed reply gets at most one formatting repair request. No tool executes before the repaired reply passes validation. Wrong request IDs and invalid tools are rejected without repair. Failed/cancelled task requests are not automatically resent; manual retries may duplicate a WhatsApp message.
- Known rich text/code fields are decoded. New binary formats or WhatsApp protocol changes may require updates.
- Discovery chooses a known Meta AI bot returned by the account, preferring Muse. Retired phone-number discovery results map to the current Meta AI bot address. Different bot addresses/surfaces need not use the same model.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| WA_PORT | 8787 | Loopback port; set on server and launcher |
| WA_STATE_DIR | local application storage | Private runtime directory; set on server and launcher |
| WA_BOT_JID | discovered | Explicit known Meta AI address; set on server |
| GO_BINARY | go | Compiler for npm run build |

Supported explicit bot addresses are defined by whatsmeow: 1807055946647697@bot (Muse), 867051314767696@bot (Meta AI), and 13135550002@s.whatsapp.net (legacy). An override does not establish account eligibility.

The live test used 867051314767696@bot. The legacy phone address failed, and Muse required encryption state that was not present on the newly linked device. If you see “no active WASA root secret,” this is missing Muse session state, not a Claude Code error. Do not assume that pairing alone makes Muse available.

## Tests

    npm test
    npm run test:claude

The second command runs Claude Code in a temporary directory against a local fake model. It reads a fixture, applies a line-range edit, runs it, and verifies the output. It does not establish live Meta AI compatibility. CI tests the protocol and Go build; live account tests are excluded.

Dependencies are pinned in package-lock.json and transport/go.sum. Original code is MIT licensed; dependencies retain their licenses.

## References

- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [whatsmeow API](https://pkg.go.dev/go.mau.fi/whatsmeow)
- [Meta AI on WhatsApp](https://ai.meta.com/learn/ai-basics/how-to-use-meta-ai-on-whatsapp/)

Existing checkouts from the initial version used .state/. Stop the gateway and move that directory to the platform storage location above, or set WA_STATE_DIR to its absolute path on both server and launcher. Keep credentials outside synced project folders.

## Coding-harness development

Select a prompt with --harness-prompt compact, --harness-prompt coding, or --harness-prompt native. Compact is the initial bootstrap prompt; coding supplies fuller project-inspection, edit, test, and permission guidance; native uses Claude Code's own default prompt. All three receive project context and the WhatsApp JSON protocol. Native may exceed the gateway context limit.

The live development exercises run with:

    python3 scripts/eval_coding.py --prompts compact coding native

This sends prompts and disposable example code through your paired WhatsApp account. It tests a TTL cache fix and CSV parsing against visible and held-out checks. A pass requires changes confined to the implementation file and a successful test command after the last edit. The runner records how many translated line edits Claude Code executed successfully. Results and traces stay under ignored .work/coding-evals. These are small development exercises, not a general coding benchmark.

The first three-prompt comparison completed one of six runs. Compact passed the cache task, and all three prompts failed CSV. Follow-up runs on the two tasks also failed. The observed problems include malformed tool replies, edits that differ from the file's exact whitespace, and ending a turn after a failed test. The compact prompt remains the default. These runs are too small to rank the prompts reliably.

With EditLines, the compact prompt applied two cache changes successfully. The deadline boundary test still failed when a later model reply could not be decoded. The CSV run read the file and ran the tests but made no edit before hitting the same reply error. Both runs failed the end-to-end criteria. The line-range translation itself passed the local Claude Code integration test.
