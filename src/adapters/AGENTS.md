# Adapter instructions

These instructions apply to `src/adapters/**`. Read the root [`AGENTS.md`](../../AGENTS.md) first. Consult [`ARCHITECTURE.md`](../../ARCHITECTURE.md) when the change affects lifecycle/session boundaries rather than only one provider.

## Scope

Adapters are the compatibility layer between the provider-neutral `AcpRunner` and one ACP CLI. Keep provider quirks here instead of branching on provider names inside the generic runner.

The current contract is `ProviderAdapter<I, R>` in `src/runner/types.ts`.

## What belongs in an adapter

An adapter may own:

- executable/argument construction;
- environment overlays needed by that provider;
- authentication-method selection;
- advertised ACP client capabilities;
- a non-interactive task preamble;
- provider-specific input validation;
- session metadata and load-vs-resume policy;
- mode/config-option selection after session creation/loading;
- deterministic permission handling;
- provider extension requests/notifications;
- bounded provider-specific summaries.

The adapter should not reimplement:

- child-process lifecycle or process-group cleanup;
- total/phase timeout orchestration;
- per-workspace locking;
- session-record I/O;
- common ACP initialize/new/load/resume/prompt flow;
- MCP tool registration/result conversion.

If a provider cannot fit the current hooks, first consider a narrow generic hook in `ProviderAdapter` rather than a provider-name conditional in `AcpRunner`.

## Adapter checklist

When changing an existing adapter, walk through the contract in this order:

1. **Input** — validate impossible option combinations before spawning the CLI.
2. **Command** — use `shell: false` assumptions; return executable + argument array, not a shell command string.
3. **Environment** — preserve the incoming environment and overlay only required keys.
4. **Authentication** — choose only a non-interactive method actually advertised by ACP initialization.
5. **Capabilities** — advertise only client features the relay really implements.
6. **Session policy** — decide new/load/resume behavior from advertised capabilities and user input.
7. **Stable session options** — reject conflicts with persisted metadata instead of silently changing session semantics.
8. **Configuration** — verify requested modes/config values exist before setting them; keep phase timeouts around ACP configuration calls.
9. **Permissions** — return a deterministic allow/reject/cancel response. Never block waiting for a UI.
10. **Extensions** — parse provider extension payloads defensively before adding them to summaries.
11. **Summaries** — bound all accumulated provider data and set truncation when dropping or shortening information.
12. **Errors** — use a specific `RelayFailure` code and include partial state when useful.

## Current provider invariants

### Grok

- Default command comes from `RelayConfig.command` (`grok` by default) with relay-owned safety/noninteractive arguments.
- Authentication prefers `xai.api_key` only when `XAI_API_KEY` exists and the method is advertised; otherwise it uses advertised `cached_token`.
- A permission request is unexpected because the CLI is launched with always-approve semantics; fail rather than inventing an interactive flow.
- No provider-specific structured summary is currently returned beyond the common text/session result.

### Cursor

- `CODEX_AGENT_RELAY_CURSOR_COMMAND` is required; do not silently guess an executable path.
- The CLI is launched with sandboxing enabled.
- Mode defaults to `agent`; `ask` and `model` are session-stable and persisted in the session record.
- Resuming with conflicting mode/model must fail with `SESSION_OPTION_CONFLICT`.
- Interactive question requests are skipped and plan approvals are rejected because delegated execution has no UI.
- Permission requests are rejected and surfaced as `PERMISSION_REQUIRED`, retaining a bounded interaction summary.
- Cursor extension notifications (todos/subagents/images) must remain bounded through `CursorSummaries`.

### OpenCode

- Command defaults to `opencode` and launches its ACP mode with the requested `cwd`.
- Preserve any existing `OPENCODE_PERMISSION` object while forcing `question: "deny"`.
- `resume` without `sessionId` is invalid.
- Existing sessions prefer ACP resume when available, then load; `resume: false` explicitly requires load support.
- `model`, `effort`, and `agent` map to advertised session config options and must be validated against available values before setting.
- An ACP permission may be accepted only through an offered `allow_once`; otherwise fail deterministically.
- Usage/tool-call summaries must remain bounded through `OpenCodeSummaries`.

## Adding a provider

Adding a provider is intentionally more than creating one adapter file. At minimum inspect/update these layers:

1. `src/types.ts` — provider-specific input/result types if the common shape is insufficient.
2. `src/runner/types.ts` — extend the `Provider` union and only add adapter hooks when they are generally useful.
3. `src/adapters/<provider>.ts` — implement policy using `AcpRunner`.
4. `src/runner.ts` — export the new runner if this remains the public runner barrel.
5. `src/config.ts` — add command/runtime configuration when needed.
6. `src/server.ts` — add MCP input/output schema, runner instance, tool registration, and error-result mapping.
7. `src/store.ts` — decide whether the provider needs a separate session namespace or new persisted metadata. Treat record-format changes as compatibility work.
8. `test/fixtures/` — add/extend a deterministic fake ACP agent when provider behavior differs.
9. `test/<provider>-runner.test.ts` and `test/server.test.ts` — cover adapter semantics and MCP wiring.
10. `README.md` and `README.zh-CN.md` — document the supported provider, tool name, setup, and examples.
11. `scripts/append-codex-agent-relay-instructions.mjs` and its tests — update only if the recommended Codex delegation guidance must mention the provider.

Prefer an isolated `SessionStore` namespace for a new provider unless compatibility with an existing namespace is intentional.

## Tests required for adapter work

Use hermetic fake-agent tests for the behavior contract. Cover the cases relevant to the change, especially:

- command construction / missing executable;
- authentication availability;
- new and existing session behavior;
- option conflicts and unsupported config values;
- permission outcomes;
- provider extension parsing/summarization;
- truncation;
- cancellation/timeout if the adapter changes lifecycle interaction;
- structured partial output on failure.

Run the provider test first, then the full default suite:

```bash
pnpm exec vitest run test/<provider>-runner.test.ts
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run a real-agent smoke test only when the local CLI and authentication are available and the change depends on real provider behavior.
