<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Threat model (STRIDE)

As of 0.14.0. One section per service, grouped by STRIDE category, each row
reading threat → mitigation → residual risk. Port numbers are the host ports
of the Compose quickstart. Trust boundaries: (1) internet → gateway → Gate,
(2) Gate → internal services (network segment, service tokens), (3) Runtime
→ LLM and tool providers (egress), (4) Outpost → ATF cloud (dial-out; local
data stays local).

## Runtime (3000)

| Cat. | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S | Prompt injection through documents or tools → data exfiltration via a tool call | Tool-authorization policy (ADR 0011), plugin trust boundary (ADR 0006), egress allowlist (`security/egress.ts`), red-teaming (ADR 0010) | Model-inherent bypass ideas; detection stays LLM-based |
| T | Tampered flow definitions or audit entries | Flow publishing is a regulated action on the fail-closed audit path; flows carry `metadata.version`, emitted as `flow_version` in the debug trace; the audit log is hash-chained, append-only (migration 42) and anchored externally (ADR 0026) | Whoever compromises the deployment system and the database can forge both consistently; the anchor file must live off-host |
| R | Unauthenticated flow execution, BYOK abuse | Bearer/JWT on `/v1/*`, tenant isolation (ADR 0005), BYOK only per tenant, the production gate refuses auth-off | Insider with an admin token; admin actions are audited |
| I | PII in clear text at the provider or in logs | PII-vault decorator (ADR 0007), detector pipeline (ADR 0015), multimodal mode (ADR 0016), log redaction | New PII types need a detector extension; the fail mode is configurable |
| D | Expensive models or endless loops → cost DoS | Budgets (`budgets/`), FinOps forecast (ADR 0018), iteration and stagnation limits, rate limiting | Cost DoS below the budget threshold |
| E | Escalation: a tenant reads another tenant's data | RLS as a deployment option, application scoping, tests; one DB user per service | Application scoping without RLS is a known deployment decision (ADR 0005 status) |

## Gate (3003)

| Cat. | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S | Forged monitor sessions | Session cookie `atf_monitor_session`, optional OIDC login for the monitor | — |
| T | Deleting or altering the Gate audit trail | The file audit sink (JSONL) applies a sink-level redaction policy; subject erasure only through `POST /v1/erasure` with the `gate.erasure` scope, idempotent over `requestId`; an append-only sink reports `not_configured` instead of erasing; the erasure operation itself is recorded in the Runtime audit chain (ADR 0025) | The JSONL file is not hash-chained; ship it to append-only storage if tamper evidence is required |
| R | Unauthorized MCP access | Bearer on `/mcp*`, tool policy at the Gate, `/.well-known/oauth-protected-resource` | An MCP client with a valid token can do everything it is allowed to (by design) |
| I | Metrics or health leak internals | `/metrics` only with `server.metrics.enabled`, health without details | — |
| D | SSE/session exhaustion | Session caps per transport and instance (`server.sessions`), per-identity GCRA rate limiting (memory or Redis), sticky routing documented (`runbooks/scaling.md`) | Slow clients hold slots |
| E | Erasure endpoint used as a weapon (mass deletion) | Service auth plus a dedicated scope, tenant binding, audit of every operation | Admin error; a four-eyes check in the process is recommended |

## Search (3002) / Extract (3004)

| Cat. | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S | Query injection, path traversal in ingested files | Parameterized queries, path normalization, size and page limits (`MAX_PAGES`) | — |
| T | Index poisoning (malicious documents) | Revisions and a delete path, tenant scoping, document ACLs | Poisoning within one's own tenant remains possible |
| R | Another tenant reads the index or documents | Mandatory access scope on every query (`ACCESS_SCOPE_REQUIRED`), service tokens between Extract and Search | — |
| I | Documents or PII in clear text in the outstore | Encrypted volumes (deployment responsibility), the erasure chain, converter isolation (ADR 0028) | Outstore access equals document access — volume hardening is required |
| D | Conversion DoS (zip bombs, huge PDFs) | Zip-bomb guard before every unzip, `SUBPROCESS_TIMEOUT_MS` > 0 enforced, `MAX_PAGES`, per-job budgets (`BUDGET_EXCEEDED`), scratch quota | CPU exhaustion below the limits → scaling runbook |
| E | Converter escape (parser bugs in PDF/Office) | `CONVERTER_MODE=isolated`: separate process/container, only the socket and scratch space, non-root | Zero-day in a parser; isolation limits the damage |

## Control (3001)

| Cat. | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S | XSS/CSRF in the Studio, stolen session | Nonce-based CSP (enforced by default, ADR 0027), SameSite cookies, OIDC session (ADR 0013), no secrets in the client | `NEXT_PUBLIC_*` is public by definition — never put secrets there |
| T | Flow edits without approval | Drafts (`flow_drafts`, migration 41), Autopilot governance with human approval (ADR 0008), canary promotion (ADR 0012) | — |
| R | Vertical escalation through UI APIs | The backend checks roles; the UI only disables or hides controls | — |
| I | Cost or usage leak | `NEXT_PUBLIC_CURRENCY` is only a label; details only in authenticated views | — |
| D | — (UI) | — | — |
| E | — | — | — |

## Outpost — Docker runtime

| Cat. | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S | Malicious sync targets (cloud) write harmful files into mounted folders | Read-only mounts where possible, confirm-deletes flow, the Outpost only ingests with a tenant token | Local consumers of the folders (Office) open harmful files — OS hardening is required |
| T | Outpost configuration tampered with (other cloud targets) | Read-only config mount, audit on the ATF side for every ingest | Whoever controls the host controls the sync — the Outpost runs on customer infrastructure |
| R | A stolen Outpost token uploads foreign data | Tenant-bound token, rotation like service tokens, interactive source login (`source-login`) | Token in the container environment — a secret store is recommended |
| I | Local data leaves the host unencrypted | TLS to ATF, health endpoint bound to 127.0.0.1 by default | Network segment behind the Outpost |
| D | Sync storm (wave of changes) | Backoff and rate limiting in the core, delta sync | — |
| E | The Outpost becomes a lateral-movement hop | Non-root user (UID 10001), no Docker-socket mounts, minimal capabilities | Host escape as with any container |

## Outpost Desktop + updater

| Cat. | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S | A compromised updater feed ships a malicious binary | Mandatory signatures (Minisign public key in `tauri.conf.json`); endpoints stay empty until the release infrastructure exists, so **the updater is currently disabled** (`createUpdaterArtifacts: false`); a signed release build in `outpost-release.yml` fails on the placeholder key or empty endpoints | The public-key rotation process must be anchored in the release workflow before the updater is enabled |
| T | Binary tampering between build and install | Digest pinning, SBOM, image and artifact scans in CI; desktop builds from reviewed commits | Supply chain of the Tauri/Rust dependencies (`deny.toml`) |
| R | The sidecar (`atf-outpost`, `externalBin`) is reachable without UI auth | Sidecar bound to localhost, per-launch IPC token handed to the WebView by the app | A local process sniffer running as the same user |
| I | Cloud OAuth tokens on the desktop | OS keychain instead of a file, refresh rotation | Same OS user = same access (OS model) |
| D | Sync blocks the UI | Sync runs in the sidecar process, not in the UI thread | — |
| E | The desktop app escalates privileges | Minimal Tauri capabilities, no shell access from the WebView | Tauri zero-day |

## Cross-cutting

- **Secrets**: never in the image; secret store plus the production gate,
  which refuses auth-off and demo secrets in production.
- **Supply chain**: CI with a lockfile check, Trivy (fails on critical CVEs),
  gitleaks, CodeQL, SBOM (`sbom.cdx.json`), cosign-signed release images
  with provenance and SBOM attestations, Actions pinned by SHA.
- **Audit**: every regulated action (erasure, key rotation, policy changes,
  approvals, flow publishing, tenant deletion) goes through the fail-closed
  Runtime audit path into the hash chain.

Review triggers: new services, new provider egress classes, enabling the
updater, and at least once a year.
