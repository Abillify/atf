<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Compliance frameworks beyond the EU AI Act and GDPR

> **Draft mapping. Not legal advice. Clause references must be verified against the official text
> before use.**
>
> Every row in the *Reference* column of the files in this directory is `TODO(human)`, on purpose.
> The requirement topics below are paraphrases written for orientation, not quotations, and they
> carry no clause or article number, because a mapping that cites a number nobody checked is worse
> than no mapping. Whoever uses these files in an audit, a tender or a gap analysis fills the
> reference column from the standard text they hold — or deletes the row.

## Why this mapping cannot be generated

ATF documents itself from source. [CAPABILITIES.md](../CAPABILITIES.md) describes behaviour that
exists in the code, [CONFIGURATION.md](../CONFIGURATION.md) lists every variable a service reads,
[METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md) states where data lives, for how long, and
under which setting, and both are checked in CI.

No framework text is in this repository, and none of them is freely quotable. That splits any
compliance document into two halves with different epistemic status:

| Half | Source of truth | Status here |
| --- | --- | --- |
| *"What does ATF do?"* — the control, the setting, the endpoint, the metric | the code and the generated documentation | stated, and checkable by anyone with the checkout |
| *"What does the framework require, and where?"* — topic, clause, wording | the standard, directive or regulation, which an auditor and an operator hold and this repository does not | paraphrased topic headings, reference left as `TODO(human)` |

The columns are deliberately separated so nobody mistakes a confident middle column for a verified
right column.

## Files

| File | Framework | Character |
| --- | --- | --- |
| [iso-iec-42001.md](iso-iec-42001.md) | ISO/IEC 42001 — AI management system | certifiable standard; organisation-level, so most of it is management process rather than product |
| [nis2.md](nis2.md) | NIS2 — EU cybersecurity and incident reporting | law; binds essential and important entities in named sectors, and applies to the operator, not to ATF |
| [dora.md](dora.md) | DORA — EU digital operational resilience for financial entities | law; ICT risk, testing, incident reporting, third-party risk, information sharing |
| [bsi-c5.md](bsi-c5.md) | BSI C5 — German catalogue of security requirements | attestation catalogue for cloud providers; recognised in the public sector |

Related documents that already exist and are not repeated here:
[EU-AI-ACT.md](../EU-AI-ACT.md) (obligations of the AI Act, with article numbers verified against
the published regulation), [DSFA-VORLAGE.md](../DSFA-VORLAGE.md) and
[VVT-VORLAGE.md](../VVT-VORLAGE.md) (GDPR Art. 35 and Art. 30 templates),
[THREAT-MODEL.md](../THREAT-MODEL.md) (STRIDE per service), and
[METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md).

## Reading the tables

Each file uses the same shape:

| Column | Content | Provenance |
| --- | --- | --- |
| **Requirement topic** | what the framework asks for, as a topic heading | paraphrase — no clause number, see *Reference* |
| **ATF control** | the implemented capability that serves the topic | [CAPABILITIES.md](../CAPABILITIES.md), linked to the section |
| **Configuration** | the settings that turn the control on or make it binding | [CONFIGURATION.md](../CONFIGURATION.md) |
| **Evidence** | endpoint, artefact or metric an auditor can be handed | the three files named above |
| **Reference** | the framework clause behind the topic | `TODO(human)` in every row |

Three constraints that apply to all four files:

- **A control that is off by default is stated as off by default.** Several of the strongest
  controls (PII vault, input guardrails, sandboxing, tool egress, decision receipts, retention
  sweeps, audit anchors) are warnings or opt-in unless a preset or the production profile turns
  them on. A framework row satisfied by a switch nobody flipped is a finding waiting to happen, so
  the switch is named in the *Configuration* column rather than hidden.
- **Every positive control is linked to where it is documented.** Each section of
  [CAPABILITIES.md](../CAPABILITIES.md) a file cites is listed in that file's *Capability areas*
  table, and every row names its section directly, so a claim can be checked without reading the
  whole capability document. The one exception is stated in the row itself: a few topics — the
  dependency and licence inventory, for instance — rest on a build artefact rather than on a
  runtime control, and CAPABILITIES.md does not cover build output. Those rows say so instead of
  linking to a section that does not make the claim.
- **Management-system duties are marked as not covered.** A product does not have a policy
  committee, a scope statement or a training programme. Writing "not covered" is the useful answer,
  because it tells the operator where their own documentation has to start.
- **ATF is a component, not a certified organisation.** Nothing in this directory is an
  attestation. ATF holds no certification, no C5 type-1 or type-2 report, and no NIS2 or DORA
  registration; it supplies controls and evidence to the entity that operates it, which is the
  party the framework addresses.

## The honest summary

What the four frameworks ask for and what ATF is genuinely strong at overlaps in four places, and
those four are the reason these documents exist:

| Topic | Why ATF is unusually well placed |
| --- | --- |
| Logging and record-keeping | append-only, hash-chained audit log with signed anchors, verifiable offline by a third party (`EVIDENCE_SIGNING_KEY`, `/.well-known/atf-evidence-jwks.json`) |
| Point-in-time provability of the control set | `GET /monitoring/posture` answers "which governance controls were active" for one moment, including the production-gate result |
| Change control over AI behaviour | flow version and digest in every execution trace, CI-blocked version bumps, bench-gated and signed flow release receipts |
| Incidents, failures and degradation | every fail-open path is a metric (`aiperator_degraded_total`), not a log line, and the incident runbook is organized around severity and evidence |

Where the overlap is weak, it is weak in the same direction: the frameworks ask for **process,
people, and reporting to an external authority over time**, and a runtime cannot own a process,
name a person, or file a report. Every "gap" in these files is an instance of that.

## Conventions

- Settings are written as `UPPER_SNAKE_CASE` as in the reference; metrics carry their service
  prefix (`aiperator_*`, `mcpgate_*`, `vectorsearch_*`, `extract_*`).
- `—` means the topic has no ATF-side contribution worth naming, not that nothing exists.
- Framework names are written the way their own documents write them. The 2023/… and 2022/…
  directive and regulation numbers are omitted for the same reason clause numbers are.
