# 1. Record architecture decisions

Date: 2026-06-14

## Status

Accepted

## Context

aiperator carries a large amount of non-obvious design intent (security
trade-offs, fail-open/closed choices, why a custom expression evaluator exists
instead of `eval`, why most features are optional). With a small contributor
base this knowledge lives in one person's head, which is a continuity risk and
slows down onboarding and review.

## Decision

We keep lightweight Architecture Decision Records (ADRs) in `docs/adr/`, one
Markdown file per decision, numbered sequentially. Each ADR states the context,
the decision, and its consequences. We add an ADR whenever we make a decision a
future contributor would otherwise have to reverse-engineer from the code.

We use the format popularised by Michael Nygard: Title, Status, Context,
Decision, Consequences.

## Consequences

- New contributors can read `docs/adr/` to understand _why_ the system is shaped
  the way it is, not just _what_ it does.
- Reviewers can point to an ADR instead of re-litigating a settled decision.
- ADRs are immutable once accepted; a reversal is a new ADR that supersedes the
  old one (noted in both Status fields).
