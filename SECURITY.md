# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in IronCurtain, please report it responsibly. **Do not open a public issue.**

Email: **security@provos.org**

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- The component affected (policy engine, sandbox, trusted process, MCP proxy, etc.)
- Whether you believe it affects the compiled policy, the runtime enforcement, or the sandbox boundary

I will acknowledge reports within 72 hours and aim to provide a fix or mitigation plan within 30 days.

## Scope

The following are in scope for security reports:

- **Policy engine bypasses** — crafted tool arguments that evade compiled rules or structural invariants
- **Sandbox escapes** — breaking out of the V8 isolate, the Anthropic SRT sandbox of an MCP server, or the agent container's network isolation
- **Trusted process vulnerabilities** — exploiting the MCP proxy to bypass policy evaluation or the audit log
- **MITM proxy bypasses** — reaching a host, endpoint or registry route the proxy should refuse, or getting the real credential (or a request authenticated with it) out of the proxy
- **Path traversal / symlink attacks** — circumventing directory containment checks, including host-side reads and writes of agent-writable paths
- **Credential leakage** — MCP server or provider credentials exposed to the agent or in logs
- **Approval integrity** — making a human or a whitelist approve something other than what was shown
- **Prompt injection leading to policy bypass** — adversarial input that causes the policy engine (not the LLM) to make incorrect decisions

The following are **out of scope**:

- The LLM itself being "jailbroken" — IronCurtain assumes the agent will be compromised and constrains consequences through architecture, not prevention (see [Why IronCurtain?](https://ironcurtain.dev/why))
- Vulnerabilities in upstream MCP servers that IronCurtain proxies to
- Denial of service against the local runtime (resource budgets bound runaway agents and spending; they are not a containment boundary)
- Risks that [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) documents as accepted, such as what a Docker agent does inside its own container and to its read-write mounts (§2b) or sends to a destination a human approved (§2b-i). A way around a mitigation that document describes (for example the host-side privilege scan, the SNI pin or the address screen) is in scope

## Security Architecture

IronCurtain's security model is defense-in-depth with multiple independent layers ([SANDBOXING.md](SANDBOXING.md) describes them in detail):

1. **V8 Sandbox (Code Mode)** — agent code runs in a fresh isolated V8 context per script, with no access to `process`, `require`, or Node.js built-ins and with host-enforced memory and output limits (`src/sandbox/code-mode-chain.ts`)
2. **Container (Docker Agent Mode)** — external agents run in a container with no network of its own; all traffic goes through IronCurtain's proxies. The container is not unprivileged: by default the agent has passwordless sudo inside it (`src/docker/agent-privileges.ts`)
3. **MITM Proxy (Docker Agent Mode)** — real credentials stay on the host; provider requests are filtered, sanitized and budgeted; package registries are read-only; any other destination needs a human's approval (or, with the opt-in egress policy, an allowlist entry) and is then tunneled without inspection; the deprecated `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` tunnels unknown hosts without either (`src/docker/mitm-proxy.ts`)
4. **Trusted Process** — every MCP tool call passes through a policy engine before reaching any real server, and is audited (`src/trusted-process/tool-call-pipeline.ts`)
5. **Policy Engine** — deterministic evaluation of compiled rules; structural invariants (protected paths, unknown tool denial) are hardcoded (`src/trusted-process/policy-engine.ts`)
6. **MCP Server Sandboxing** — MCP servers that request it (by default `filesystem`, `git` and `google-workspace`) run in their own Anthropic SRT sandbox with restricted filesystem and network access; `fetch` and the memory server run on the host, and `github` runs in Docker (`src/trusted-process/sandbox-integration.ts`, `src/config/mcp-servers.json`)
7. **Human Escalation** — sensitive operations require explicit human approval; some, such as opening a passthrough domain, can only be approved by a human, one at a time

For a detailed threat analysis, including what each layer does not stop, see [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md).

## Supported Versions

IronCurtain is pre-1.0 research software. Security fixes will be applied to the latest release on `main`.
