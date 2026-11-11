# Roadmap

What the project is working toward, without dates. Committed work ships in a release
announced in [CHANGELOG.md](CHANGELOG.md); everything below is intent, not a schedule.
Items marked *proposed* carry an ADR in [docs/adr/](docs/adr/) that has not been accepted yet.

## Now

- **PII vault completion.** Typed placeholders, one placeholder per value within an
  execution, and allowlisted detokenization at the tool boundary, per the design in
  [ADR 0036](docs/adr/0036-pii-vault-typed-tokens-and-tool-boundary.md) (*proposed*). Today's documented
  boundaries are in [docs/CAPABILITIES.md](docs/CAPABILITIES.md).
- **Operator surface consolidation.** One Control overview page and a services page
  that links to the per-application surfaces, so Control is one UI instead of four.
- **Onboarding.** A quickstart that runs from published images with demo data, a
  guided "trust in five minutes" tour, and reusable blueprints under
  [`deploy/blueprints/`](deploy/).
- **Experimental features to stable.** The features listed as
  [experimental](docs/STABILITY.md#experimental) — model cascade, LLM query
  decomposition, citation index, flow service objectives, bench capture, the
  SharePoint Outpost source — leave that list once they have proven themselves in use.

## Next

- **Shared state between replicas.** The single-process behaviours documented in
  [docs/UPGRADE.md](docs/UPGRADE.md#not-yet-shared-between-replicas-roadmap) — the
  Runtime media store behind `show_figure`, the receipts transparency log, Gate
  pagination cursors, and the Gate approval and invocation stores — need shared
  implementations so `REPLICAS > 1` deployments stop routing around them.
- **Decision receipts on a shared transparency log** so evidence survives replica
  restarts and scales horizontally.
- **Key material from files and external secret managers**, beyond the current
  environment-variable and generation-based handling.
- **Audit forwarding to a SIEM** as a first-class sink next to the existing audit
  anchor.
- **Governance documentation** — [GOVERNANCE.md](GOVERNANCE.md) describes who decides
  today; making that process usable for outside maintainers is open work.

## Later

- **Trust-proxy mode** (*proposed*, ADR 0038): let existing clients talk to ATF
  through an Anthropic-compatible endpoint with governed tools, instead of
  re-integrating.
- **Knowledge base in Control** (*proposed*): manage Search collections and
  documents from the operator UI.
- **More chat channels.** Rocket.Chat is the only channel today; Slack and
  Microsoft Teams need a shared channel interface first (*proposed ADR*).
- **SCIM provisioning** of users and groups from the identity provider, or a
  documented decision that OIDC group claims are enough (*proposed ADR*).
- **Agent-to-agent protocol.** An A2A endpoint with an agent card derived from flow
  metadata, next to the existing MCP tool surface (*proposed ADR*).
- **MCP elicitation** for approvals and follow-up questions inside the MCP session
  (*proposed ADR*).
- **Mechanically splitting very large files** in the repository, low priority.
