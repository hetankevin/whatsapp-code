# WhatsApp Meta AI → Claude Code

Use WhatsApp consumer Meta AI as the model behind Claude Code through an API. The target public repository is hetankevin/whatsapp-code. This is a provider gateway, not an MCP tool or a different model provider.

State: Node gateway, Go whatsmeow transport, launcher, and pairing page implemented. Eight local protocol tests pass. Actual Claude Code 2.1.317 completed two requests against a fake model, including a real Read call and tool_result. Transport builds on macOS arm64. No live Meta AI round trip verified yet. The user reported linking, but the device database was still empty on the subsequent check; clarification is pending.

Scope: local authenticated gateway, serialized text/tool turns, JSON tool protocol, explicit errors for unsupported media and oversized context. Claude Code owns tool execution and permission checks. No global Claude settings changes.

Implementation notes: Baileys lacked the required bot handling; whatsmeow is used instead. Current Claude Code tools need JSON Schema 2020-12 support. Only known Meta AI bot addresses are accepted, history downloading is disabled, and ordinary messages are ignored. Full context is resent with a 60,000-character cap. No existing chat history is deleted; memory isolation is not guaranteed. Credentials and pairing artifacts stay in ignored .state/.

Next: resolve pairing, verify one live text prompt, then a real Claude Code file-read/tool-result round trip on a disposable fixture. Keep fake-model tests clearly separate from live verification in README. Run npm test, npm run test:claude, and Go build/vet after changes. Do not commit runtime credentials, chat bodies, or pairing codes.
