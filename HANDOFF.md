# WhatsApp Meta AI → Claude Code

Use WhatsApp consumer Meta AI as the model behind Claude Code through an API. The target public repository is hetankevin/whatsapp-code. This is a provider gateway, not an MCP tool or a different model provider.

State: live integration verified on November 9, 2026. The paired WhatsApp Meta AI bot (867051314767696@bot) returned a text connectivity response and completed an actual Claude Code file-read/tool-result loop, reporting a random code that was present only in a disposable file. Nine local protocol tests pass, plus a separate actual Claude Code 2.1.317/fake-model tool test. Go build/vet pass locally. Initial public CI passed. Runtime credentials remain only in ignored .state/.

Scope: local authenticated gateway, serialized text/tool turns, JSON tool protocol, explicit errors for unsupported media and oversized context. Claude Code owns tool execution and permission checks. No global Claude settings changes.

Implementation notes: Baileys lacked the required bot handling; whatsmeow is used instead. Current Claude Code tools need JSON Schema 2020-12 support. Only known Meta AI bot addresses are accepted, history downloading is disabled, and ordinary messages are ignored. Full context is resent with a 60,000-character cap. No existing chat history is deleted; memory isolation is not guaranteed. Credentials and pairing artifacts stay in ignored .state/.

Bot routing: server discovery returned the retired phone address, whose sends failed with no LID found. Muse failed before sending with no active WASA root secret. The current non-Muse Meta AI bot succeeded. Default discovery now maps the retired address to that working bot; explicit WA_BOT_JID still wins. Intermediate first/inner bot edits never execute tools even if they contain complete JSON.

Next: keep integration-check claims modest; larger coding tasks and long-session reliability remain untested. Run npm test, npm run test:claude, and Go build/vet after changes. Do not commit runtime credentials, chat bodies, or pairing codes. No published binary or tagged release yet; source is on main.
