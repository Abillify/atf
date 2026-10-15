<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Threat model (STRIDE)

As of 0.16.0. One section per service, grouped by STRIDE category, each row
reading threat → mitigation → residual risk. Port numbers are the host ports
of the Compose quickstart. Trust boundaries: (1) internet → gateway → Gate,
(2) Gate → internal services (network segment, service tokens), (3) Runtime
→ LLM and tool providers (egress), (4) Outpost → ATF cloud (dial-out; local
data stays local).

## Runtime (3000)

| Cat. | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S | Prompt injection through documents or tools → data exfiltration via a tool call | Tool-authorization policy (ADR 0011), plugin trust boundary (ADR 0006), egress allowlist (`security/egress.ts`), red-teaming (ADR 0010); retrieved chunks are handed to the model as a delimited untrusted-data block with a per-call nonce (`RETRIEVAL_CONTEXT_MODE`, default `spotlight` in production); after the injection scan flags retrieved or tool text, tools not declared read-only (`readOnlyHint`) need human approval for the rest of the run (`TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`, default on in production; tools without annotations count as write tools; without an approval gate the call is denied); Search labels every result `content_trust: untrusted` with a heuristic `injection_risk` hint (`none` / `suspected`) | Model-inherent bypass ideas; detection stays heuristic and pattern-based, so `none` is not proof of safety; spotlighting lowers but does not remove the risk; the taint rule only protects tool calls routed through the node handlers, and does not cover consequential targets of the agent harness; the `injection_risk` hint is computed at query time, an ingest-time score is a possible follow-up |
| T | Tampered flow definitions or audit entries | Flow publishing is a regulated action on the fail-closed audit path; flows carry `metadata.version`, emitted as `flow_version` in the debug trace together with `flow_digest` (a hash of the executed definition, so a forgotten version bump is still visible) and `subflow_versions`; the audit log is hash-chained, append-only (migration 42) and anchored externally (ADR 0026) | Whoever compromises the deployment system and the database can forge both consistently; the anchor file must live off-host |
| R | Unauthenticated flow execution, BYOK abuse | Bearer/JWT on `/v1/*`, tenant isolation (ADR 0005), BYOK only per tenant, the production gate refuses auth-off | Insider with an admin token; admin actions are audited |
| I | PII in clear text at the provider or in logs | PII-vault decorator (ADR 0007), detector pipeline (ADR 0015), multimodal mode (ADR 0016), log redaction | New PII types need a detector extension; the fail mode is configurable |
| D | Expensive models or endless loops → cost DoS | Budgets (`budgets/`), FinOps forecast (ADR 0018), iteration and stagnation limits, rate limiting | Cost DoS below the budget threshold |
| E | Escalation: a tenant reads another tenant's data | RLS as a deployment option, application scoping, tests; one DB user per service | Application scoping without RLS is a known deployment decision (ADR 0005 status) |
| S | A second trusted token issuer asserts another tenant's identity | `JWT_ISSUER_TENANTS` binds every issuer in `JWT_ADDITIONAL_ISSUERS` to the tenants it may claim; an unlisted issuer or an unbound tenant gets 401 on `/v1/*` and the operator plane; the production gate fails with several issuers and no binding | A `"*"` binding trusts that issuer for every tenant; the binding is only as good as the map the operator maintains |
| T | Shadow or replay runs repeat real tool side effects | `suppressSideEffects`: the MCP wrapper refuses tools without `readOnlyHint`, approval-gated tools are denied without a reviewer, assistant memory writes are skipped; shadow sampling defaults to 5 % | A third-party MCP server that wrongly declares `readOnlyHint` on a write tool; `queryPreview` still keeps up to 256 characters of user text in memory |
| I | Credentials or tokens in service logs | A shared redactor (`@atf/security-kit` `log-redact`) runs on every Runtime, Search and Extract log entry; Gate redacts through the same kit; Search no longer logs queries, user ids or groups; OIDC logs carry a hashed email | Redaction is pattern- and field-name-based; secrets in free-form values of unusual shape can slip through; Search v1 still logs filter values |
| E | An invalid compliance policy switches enforcement off | A hot reload keeps the last valid policy; with none valid at startup chat and engine admission answer 503 | A deleted policy file still means "no policy" (no mandatory mode yet) |

## Gate (3003)

| Cat. | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| S | Forged monitor sessions | Session cookie `atf_monitor_session`, optional OIDC login for the monitor | — |
| I | Monitor token leaks through URLs, browser storage or script injection | `?token=` is refused on every monitor endpoint; the token is exchanged once at `POST /monitor/session` for an HttpOnly, SameSite=Strict cookie (8 h, invalidated by token rotation); the page is served with a nonce CSP (`frame-ancestors 'none'`) and no inline handlers | Scripts that still send `?token=` fail; a stolen cookie is valid until it expires or the token is rotated |
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
| S | Cross-site request through the BFF proxy (`CONTROL_SESSION_MODE=bff`) | `/api/backend/*` checks `Sec-Fetch-Site` and `Origin` before the session cookie is used; `CONTROL_PUBLIC_ORIGIN` pins the accepted host; the cookie is `SameSite=Strict`; the proxy has an allowlist | Requests that carry neither header (non-browser clients) pass, and they cannot ride a browser session cookie; without `CONTROL_PUBLIC_ORIGIN` the reverse proxy must overwrite `X-Forwarded-Host`; BFF mode has no silent renewal |
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
