# Roadmap

What the project is working toward, without dates. Committed work ships in a release
announced in [CHANGELOG.md](CHANGELOG.md); everything below is intent, not a schedule.
Every item that names an ADR has an accepted decision in [docs/adr/](docs/adr/); what is
open is the implementation.

## Now

- **Experimental features to stable.** The features listed as
  [experimental](docs/STABILITY.md#experimental) — among them trust-proxy mode, the PII
  vault beyond messages, model cascade, LLM query decomposition, the citation index, flow
  service objectives, bench capture and the SharePoint Outpost source — leave that list
  once they have proven themselves in use.
- **Measured numbers.** [docs/BENCHMARKS.md](docs/BENCHMARKS.md) still lacks extraction
  quality on real documents, groundedness of live model answers and a chosen abstention
  gate; these need measurements, not code.
- **Knowledge base in Control**
  ([ADR 0037](docs/adr/0037-knowledge-management-in-control.md)): a read-only view of
  collections, documents and extraction jobs through a Runtime proxy, scoped to one
  tenant and audited.

## Next

- **Shared state between replicas.** The remaining single-process behaviours documented
  in [docs/UPGRADE.md](docs/UPGRADE.md#not-yet-shared-between-replicas-roadmap) — above
  all the Runtime media store behind `show_figure` — need shared implementations so
  `REPLICAS > 1` deployments stop routing around them. The receipts transparency log is
  shared already when a database is configured (ADR 0039).
- **Deprovisioning endpoint**
  ([ADR 0042](docs/adr/0042-provisioning-oidc-claims-before-scim.md)): cut off a subject
  at once, end its sessions and bindings, and erase its data only on request. Rights keep
  coming from OIDC claims; there is no SCIM server.
- **Keys as an operation** ([ADR 0040](docs/adr/0040-external-key-management.md), layer 2):
  route the evidence signers through a `KeyProvider` so a KMS or HSM adapter touches one
  module. Secrets from files (`NAME_FILE`, layer 1) are in place.
- **More chat channels** ([ADR 0041](docs/adr/0041-channel-interface-derived-from-rocketchat.md)):
  lift the channel interface out of the Rocket.Chat integration, then Slack, then
  Microsoft Teams.

## Later

- **Agent-to-agent protocol**
  ([ADR 0043](docs/adr/0043-a2a-agent-endpoint-mapping-flows.md)): an A2A endpoint that
  translates onto the chat pipeline, with flows listed only on the authenticated agent
  card.
- **MCP elicitation for approvals**
  ([ADR 0044](docs/adr/0044-mcp-elicitation-for-approvals.md)): an optional way to answer
  an approval inside the MCP session, on stateful Gate transports.
- **Remote key adapters** (AWS KMS, GCP KMS, Azure Key Vault, PKCS#11), one at a time,
  each for a named deployment that needs it.
- **Document content in Control** behind a stricter permission than the metadata view.
