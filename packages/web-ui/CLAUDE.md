# Web UI Package

Opt-in Svelte 5 SPA served by the IronCurtain daemon via `--web-ui`. Communicates with the daemon over a WebSocket JSON-RPC protocol with bearer token auth.

## Tech Stack

- **Svelte 5** with runes (`$state`, `$derived`, `$effect`, `$props`, `$bindable`)
- **Vite** for dev server and production builds
- **Tailwind CSS v3** with CSS custom properties for theming
- **shadcn-svelte pattern** -- custom UI components in `src/lib/components/ui/` built with `clsx` + `tailwind-merge`
- **phosphor-svelte** for icons (tree-shaken via `sveltePhosphorOptimize` Vite plugin)
- **marked** + **DOMPurify** for markdown rendering with a strict profile (`src/lib/markdown.ts`): raw HTML is shown as text, images become `[image: alt] url` text, and only `http:`, `https:` and `mailto:` links stay clickable (new tab). Every markdown view renders agent-written text (workflow artifacts at gates, transition messages, the message log, persona constitutions, workflow READMEs).

## Architecture & Design Principles

### Layer structure

```
src/lib/components/ui/       -- Reusable UI primitives (Button, Badge, Card, etc.)
                                No domain imports. Only cn(), svelte, third-party.
src/lib/components/features/ -- Domain-specific components (EscalationCard, TerminalConsole, etc.)
                                May import from types.ts and ui/ components.
src/lib/                     -- State, logic, utilities
                                types.ts, stores.svelte.ts, event-handler.ts, etc.
src/routes/                  -- Page-level views
                                Orchestrate features + state. Thin coordinators.
src/App.svelte               -- Root layout, routing, global concerns
```

### Dependency rules

- `ui/` components MUST NOT import from `types.ts`, `stores.svelte.ts`, or any domain module
- `ui/` components accept data through props with generic types
- `features/` components MAY import from `types.ts` and `ui/` components
- `features/` components MUST NOT import from `stores.svelte.ts` (receive data via props/callbacks)
- Route views MAY import from `stores.svelte.ts`, `types.ts`, and any component
- Route views MUST NOT import `getWsClient` directly -- use named action functions from stores
- `event-handler.ts` depends only on `types.ts` via the `AppStateLike` interface
- No circular imports

### RPC abstraction

All WebSocket RPC calls go through named functions in `stores.svelte.ts` (e.g., `createSession()`, `runJob()`, `resolveEscalation()`). Route views call these functions, never raw `getWsClient().request()`. This keeps network logic centralized and testable.

### State management

- `appState` is the single reactive store (Svelte 5 runes)
- Event handling is in pure `event-handler.ts` via `AppStateLike` interface
- Map mutations always create new Map instances for Svelte reactivity
- Refresh domains fail independently. Failed RPCs retain held reviews and show an error until recovery; unreadable workflow details block approval while denial/abort remain available.

## Directory Structure

```
src/
  App.svelte              -- Root component: auth gate, sidebar nav, theme picker, view switch
  main.ts                 -- Svelte mount point
  app.css                 -- Tailwind directives, theme variables, prose styles
  lib/
    utils.ts              -- cn() utility (clsx + tailwind-merge)
    stores.svelte.ts      -- AppState class (Svelte 5 runes), WS client wiring, RPC actions
    event-handler.ts      -- Pure event reducer over the AppStateLike interface
    types.ts              -- Frontend DTO types mirroring daemon types
    ws-client.ts          -- Typed WebSocket client with auto-reconnect
    markdown.ts           -- Strict marked + DOMPurify rendering (renderMarkdown, sanitizeMarkdownHtml)
    unicode-display.ts    -- Pure segmentation of untrusted text into visible escapes (used by SafeText)
    escalation-groups.ts  -- Groups pending escalations that share one whitelist pattern (`groupKey`)
    pty-codec.ts          -- base64 <-> bytes for PTY frames
    components/
      ui/                 -- Reusable UI primitives (see below)
      features/           -- Domain-specific components, among them:
        escalation-card.svelte            -- Single escalation with approve/deny/whitelist
        escalation-modal.svelte           -- Tabbed modal for pending escalations
        escalation-review-context.svelte  -- Trusted/untrusted reviewer context of an escalation
        escalation-group-confirm.svelte   -- Confirmation step for approving an escalation group
        session-sidebar.svelte            -- Session list with container launch options
        terminal-console.svelte           -- xterm terminal for web-pty sessions
        gate-review-panel.svelte          -- Workflow human gate: artifacts, APPROVE/FORCE_REVISION/REPLAN/ABORT
        workflow-escalation-panel.svelte  -- Tool-call escalations raised inside workflows
        message-log-timeline.svelte, file-tree.svelte, file-viewer.svelte, state-machine-graph.svelte,
        resource-budget-panel.svelte, statistics/ ...
  routes/
    Dashboard.svelte      -- Overview cards, active sessions table, upcoming jobs
    Statistics.svelte     -- Observed LLM exchange statistics (series, distributions, models)
    Sessions.svelte       -- Thin coordinator: wires sidebar + terminal to store
    Escalations.svelte    -- Pending escalation cards with approve/deny and group approval
    Jobs.svelte           -- Job table with run/enable/disable/recompile/remove
    Workflows.svelte      -- Workflow runs and definitions; opens WorkflowDetail.svelte for one run
    Personas.svelte       -- Personas: create/delete, constitution editing, policy compiles, memory and broad-policy opt-ins
    Settings.svelte       -- Model provider profiles, statistics settings, resource limits
```

## UI Components (`src/lib/components/ui/`)

Each component lives in its own directory with an `index.ts` barrel export. All components use the `cn()` utility for class merging and accept a `class` prop for overrides.

| Component        | Path             | Usage                                                                                                                               |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Button**       | `button/`        | Variants: default, destructive, outline, ghost, secondary, success. Sizes: default, sm, lg, icon. `loading` prop shows spinner.     |
| **Badge**        | `badge/`         | Variants: default, secondary, destructive, outline, success, warning. For status indicators.                                        |
| **Card**         | `card/`          | Card, CardHeader, CardTitle, CardContent. Wraps content in bordered rounded container.                                              |
| **Table**        | `table/`         | Table, TableHeader, TableBody, TableRow, TableHead, TableCell. `clickable` and `muted` props on rows.                               |
| **Input**        | `input/`         | Styled input with consistent focus ring. Supports `bind:value`.                                                                     |
| **Alert**        | `alert/`         | Variants: default, destructive. `dismissible` + `ondismiss` for closeable alerts.                                                   |
| **DropdownMenu** | `dropdown-menu/` | DropdownMenu (container with backdrop) + DropdownMenuItem. `align` prop: bottom-left/right, top-left/right. Uses `trigger` snippet. |
| **Spinner**      | `spinner/`       | Animated loading spinner. Sizes: xs, sm, md.                                                                                        |
| **Modal**        | `modal/`         | Dialog with document-level Escape. `focusOnOpen` and `bind:dialog`, see below.                                                      |
| **SafeText**     | `safe-text/`     | Untrusted text with invisible and direction-changing code points shown as `\u` escapes, see below.                                  |

**Modal focus.** `focusOnOpen: 'dialog'` (default) moves focus into the dialog but never onto an action control: the first text field gets it, otherwise the dialog container. `'none'` keeps focus where it is, for modals that open without a user action (the escalation modal), so keystrokes meant for the terminal never reach the dialog. `bind:dialog` exposes the `role="dialog"` element.

**SafeText.** Renders untrusted text with every invisible or direction-changing code point shown as a highlighted escape (U+202E appears as `\u202e`), using the pure segmentation in `$lib/unicode-display.ts`. Use it for agent-influenced values in approval views.

### Adding a New Component

1. Create `src/lib/components/ui/{name}/` with `{name}.svelte` and `index.ts`
2. Follow existing patterns: accept `class` prop, use `cn()` for merging, export from index
3. Add export to `src/lib/components/ui/index.ts` barrel
4. Import in route files from `$lib/components/ui/{name}/index.js`

## Theme System

Three themes selected via `data-theme` attribute on `<html>`:

- **Iron** (default dark) -- charcoal background, amber accents
- **Daylight** (light) -- warm white background, teal accents
- **Midnight** (dark) -- deep navy background, blue accents

Theme variables are defined in `app.css` as HSL values (e.g., `--primary: 38 92% 55%`) and consumed via Tailwind's `hsl(var(--primary))` pattern in `tailwind.config.js`. All UI components inherit theme colors automatically.

Theme preference is stored in `localStorage` under `ic-theme`.

## Icons

Icons use [phosphor-svelte](https://phosphor-icons.com/) v3. Import pattern:

```svelte
<script>
  import ShieldCheck from 'phosphor-svelte/lib/ShieldCheck';
</script>

<ShieldCheck size={16} class="text-primary" weight="duotone" />
```

**Do not** append `.svelte` to the import path -- the package exports map handles the resolution. The `sveltePhosphorOptimize` Vite plugin ensures only used icons are bundled.

## Development

### With the real daemon

```bash
# Terminal 1: Start daemon with web UI dev mode
ironcurtain daemon --web-ui --web-ui-dev

# Terminal 2: Start Vite dev server with HMR
cd packages/web-ui && npm run dev
```

Open `http://localhost:5173?token=<TOKEN>` (copy the token from Terminal 1's output). Vite's dev server runs on port 5173 and proxies `/ws` to the daemon on port 7400.

### With the mock server (no Docker/LLM needed)

```bash
# Terminal 1: Start the mock WebSocket server
cd packages/web-ui && npm run mock-server

# Terminal 2: Start Vite dev server with HMR
cd packages/web-ui && npm run dev
```

Open `http://localhost:5173?token=mock-dev-token` in your browser. The mock server simulates the full JSON-RPC protocol with canned data:

- **PTY terminal (Container Agent Mode)**: `sessions.create` returns a `web-pty` session that renders a live xterm terminal (canned replay banner + fake-TUI frames; type or prompt "escalate" to raise an escalation)
- **Escalations**: Send PTY input/prompt containing the word "escalate" to trigger an escalation
- **Jobs**: Three canned jobs with working enable/disable/remove actions
- **Personas**: Canned personas in the session launch selector
- **Dashboard**: Live status updates every 10 seconds

## Testing

### Unit tests

```bash
npm test -w packages/web-ui       # Run the vitest unit suite
npm run test:watch -w packages/web-ui  # Watch mode during development
```

The suite (`vitest.config.ts` includes `src/**/*.test.ts`) has tests next to the components and routes they cover, plus shared ones in `src/lib/__tests__/`. Among them:

- **`event-handler.test.ts`** -- All WebSocket event types, state mutations, edge cases
- **`ws-client.test.ts`** -- Request correlation, event dispatch, reconnect, timeouts
- **`stores-pty.test.ts`** -- PTY store actions + the buffering sink registry (frames that arrive before the terminal connects are held and drained in order; see "PTY terminal streaming" below)
- **`stores-escalations.test.ts`**, **`stores-gates.test.ts`**, **`escalation-modal.test.ts`**, **`escalation-groups.test.ts`** -- escalation and gate state, the armed approval modal, group approval
- **`markdown.test.ts`**, **`unicode-display.test.ts`** -- the strict markdown profile and visible escapes
- **`routes/Sessions.reattach.test.ts`** -- PTY reattach after a reconnect (real store, mocked ws-client)

Root `npm test` also runs the web-ui tests after the main test suite. `npm run check -w packages/web-ui` runs `svelte-check`; `lint` and `format:check` exist per package as well.

### Architecture for testability

Event handling is extracted into a pure, non-Svelte module:

- `src/lib/event-handler.ts` -- `handleEvent(state, effects, event, payload)` with `AppStateLike` interface

This can be tested without any Svelte, DOM, or WebSocket dependency.

### E2E tests (Playwright)

```bash
npx playwright install chromium   # One-time: install browser
npm run e2e                       # Auto-starts mock server + Vite, runs all specs
npm run e2e:headed                # Run with visible browser for debugging
```

Playwright auto-starts both the mock WS server (port 7400) and Vite dev server (port 5173) via the `webServer` config in `playwright.config.ts`. Tests reset mock state via `POST http://localhost:7401/__reset` in `beforeEach`.

Tests cover: Dashboard stats, container terminal session lifecycle (create/prompt/end), escalation approve/deny, job actions, theme switching, error states, and the PTY terminal (`pty-terminal.spec.ts`).

**Container Agent Mode in E2E** — the mock defaults to `web-pty` sessions and returns `sessionMode: 'container'`. Tests reset mutable state with `resetMockServer(request)` and read xterm output via `getByTestId('pty-terminal').locator('.xterm-rows')`.

## Keeping the Mock WS Server in Sync

The mock server (`scripts/mock-ws-server.ts`) must stay in sync with the real daemon's WebSocket protocol (`src/web-ui/`). When making protocol changes:

1. **New JSON-RPC method** — Add the method to `MethodName` in `src/web-ui/web-ui-types.ts`, implement in `src/web-ui/json-rpc-dispatch.ts`, then add a corresponding handler in the mock server's `handleMethod` switch. Add the frontend type in `src/lib/types.ts`.
2. **New event type** — Add to `WebEventMap` in `src/web-ui/web-event-bus.ts`, emit from the appropriate transport/dispatch code, add a handler in `src/lib/event-handler.ts`, then emit the event from the mock server where appropriate.
3. **Changed DTO shape** — Update both `src/web-ui/web-ui-types.ts` (backend) and `src/lib/types.ts` (frontend), then update the mock server's canned data to match.
4. **After any protocol change** — Run `npm run e2e` to verify the E2E tests still pass against the updated mock. If a new feature is untestable with the mock, add a handler or canned data.

The mock server is the source of truth for E2E tests — if it diverges from the real protocol, tests pass but don't validate real behavior.

## PTY terminal streaming (Container Agent Mode)

A `web-pty` session (`source.kind === 'web-pty'`) renders a live xterm.js terminal. The web UI supports container terminal sessions; non-PTY legacy session types render an unsupported-state panel.

**Protocol.** Methods (client → daemon): `sessions.ptyAttach` / `ptyDetach` / `ptyInput { data }` / `ptyResize { cols, rows }` / `ptyPrompt { text }`. Events (daemon → client): `session.pty_replay { label, snapshot }` (one-shot full-screen snapshot on attach) and `session.pty_output { label, data }` (incremental deltas). `data`/`snapshot` are base64 of the UTF-8 bytes of the terminal stream — the component decodes to a `Uint8Array` and lets xterm own UTF-8 (never `atob`-to-string, which corrupts multibyte codepoints split across chunks). Codec: `src/lib/pty-codec.ts`.

**Trusted-message bar (mux parity).** A docked input row below the terminal (in `Sessions.svelte`, subordinate to the terminal) sends a TRUSTED message via `sessions.ptyPrompt { label, text }` → `{ accepted: true }`. Unlike `ptyInput` (raw keystrokes, base64, **never** trusted), `text` is PLAIN text: the daemon records it as trusted user-context (authorizing auto-approval) and injects it into the child PTY. This bar is the ONLY path to auto-approval from the browser. Store action: `sendPtyPrompt(label, text)`.

**Launch options (`sessions.create`).** In Container Agent Mode `sessions.create` accepts optional `persona` / `workspacePath` / `providerProfileName` / `model` (mux `/new` parity). The New-session sidebar always surfaces these launch fields plus a "Start session" button (`launch-*` test ids); selecting a persona does not start a session. The provider dropdown is populated from `config.getModelProviders`. `createSession(opts?: CreateSessionOptions)` sends only the provided keys.

**Session mode (`DaemonStatusDto.sessionMode`).** The daemon status carries `sessionMode: 'builtin' | 'container'`. The backend maps internal `SessionMode.kind === 'docker'` to the public `container` value so the UI does not expose a Docker-only label when Apple Container is the active runtime.

**Component (`features/terminal-console.svelte`).** Presentational: no store import (route wiring only). Creates the xterm terminal in **`onMount`, not `$effect`** — the route passes inline callback props whose identity changes on every parent re-render, and a reactive `$effect` re-runs on that churn, disposing and recreating the terminal and **dropping the one-shot replay** (the bug the E2E caught: reconnect to an idle session blanked). On mount it hands the route a live `{ write, reset }` handle via `onready`. Input is keyboard-only (mux parity: no `onBinary`/app-mouse forwarding; wheel = local scrollback; Ctrl+C stays SIGINT).

**Buffering sink (`stores.svelte.ts`).** The one-shot replay can arrive _before_ the terminal has mounted (a fast daemon sends it the instant it receives `ptyAttach`). The per-label `BufferingPtySink` holds frames until the terminal connects, then drains them in order — a snapshot is never dropped. API: `registerPtySink(label)` (route, before attach) / `connectPtyTerminal(label, handle)` (from the component's `onready`) / `disconnectPtyTerminal` / `unregisterPtySink`; these two are order-independent (either creates the sink). `getPtySink(label)` returns the sink so the pure `event-handler.ts` can route `pty_output`/`pty_replay` to `.write` / `.reset`.

**Reconnects.** The daemon drops a client's PTY subscription when its socket closes, so the Sessions route re-sends `sessions.ptyAttach` after every reconnect: its attach effect is keyed on `appState.connected` (not on `connectionGeneration`), and the replay snapshot repaints the terminal. The per-label sink/terminal binding is torn down only when the selection changes. A `role="status"` banner (`pty-reattach-banner`) shows the detached/reattaching/failed state, and `SessionDto.osSandboxWarning` renders as a `role="alert"` banner (`pty-os-sandbox-warning`). `sessions.ptyResize` accepts cols 2..1000 and rows 1..500 (`src/pty/pty-size.ts`; INVALID_PARAMS otherwise), and the mock server mirrors those bounds.

**Complete browser reviews.** `src/web-ui/escalation-wire.ts` retains a complete review within 16 KiB, 2,048 traversal entries and depth 16, or emits an explicitly deny-only summary. All list/detail/push paths use this projection; server approval routes check the original pending record, including every member before group resolution. Summaries have no whitelist/group actions. The existing 8 MiB aggregate RPC cap remains; many bounded records may still yield a visible refresh error.

**Escalations in PTY sessions.** `escalations.resolve` can fail with `ESCALATION_EXPIRED` when the proxy already timed the request out; the modal shows resolve errors inline. `session.ended` also drops that session's pending escalations client-side (the daemon expires them first with `escalation.expired`, and so does the mock server on `sessions.end`).

**Armed approvals (`features/escalation-modal.svelte`).** The escalation modal opens with `focusOnOpen="none"`, so it never takes keyboard focus, and it has no bare-letter hotkeys: deciding is a click on Approve or Deny, or Ctrl/Cmd+Enter (approve) and Ctrl/Cmd+Backspace (deny) once focus is inside the dialog. Both work only while the escalation on screen is armed: visible for `ESCALATION_ARM_DELAY_MS` (750 ms). The delay restarts whenever a different escalation is shown, and nothing is armed while the page is hidden or the window unfocused. An escalation that does not name its server, tool and arguments can only be denied (`isApprovableEscalation` in `$lib/escalation-approval.ts`).

## Workflows, gates and escalation groups

- **Gates.** `pendingGates` is rebuilt from server state on reconnect, and `workflow.gate_raised` evicts the other gates of the same workflow. `resolveWorkflowGate(workflowId, gateId, event, prompt?)` declares the `web-ui` channel and, after a `GATE_MISMATCH` or `WORKFLOW_NOT_AT_GATE` refusal, re-reads the workflow's gate before rethrowing. `GateReviewPanel`'s `onResolve` is `(gateId, event, prompt?)`. Approve requires the full gate/event/content review to remain visible, focused and in place for `ESCALATION_ARM_DELAY_MS` (750 ms). Review/refresh changes, surrounding layout changes and measured action-row movement restart the delay; this includes scrolling and responsive layout changes. Presses begun unarmed, repeated keys and presses held across rearming cannot approve. Handlers reject duplicate pending submissions, and changed reviews clear feedback/abort drafts. Revision/replan and abort keep their existing feedback/confirmation steps and remain available while approval is unarmed.
- **Artifacts and the message log.** `workflows.artifacts` returns a listing (`{path, size}[]` plus `truncated`) and `workflows.artifactFile` one file; the gate review panel opens the first file and loads the others on expand. Message-log entries are cut to 8,192 characters with `truncated` and `ref` (the full text comes from `workflows.messageLogEntry`), and the file tree notes when a directory listing stops at 2,000 entries. A `daemon.resync` event triggers a full refresh.
- **Workflow escalations.** Tool-call escalations raised inside workflows arrive as `workflow.escalation_*` events, live in `appState.pendingWorkflowEscalations`, render in `workflow-escalation-panel.svelte`, and are decided through `resolveWorkflowEscalation`.
- **Escalation groups.** Pending escalations sharing one whitelist pattern (`EscalationDto.groupKey`) can be approved together after a confirmation that lists every member (`approveEscalationGroup` → `escalations.approveGroup`; the daemon answers `ESCALATION_GROUP_CHANGED` unless the ids are still exactly the group). Human-only escalations never group.

## WebSocket Client

`ws-client.ts` implements a JSON-RPC client with:

- Request/response correlation via `id` field
- Server-push events via `event` field
- Auto-reconnect with exponential backoff (1s base, 30s max)
- 120s request timeout

The `stores.svelte.ts` module wires events to the reactive `AppState` class, which all route components read from.

## Build

```bash
npm run build    # Outputs to ../../dist/web-ui-static/
```

The `$lib` alias resolves to `src/lib/` (configured in both `vite.config.ts` and `tsconfig.json`).
