# 10. Continuous automated red-teaming as a scheduled security-posture engine

Date: 2026-07-13

## Status

Accepted

## Context

Guardrail quality (the input classifier's threshold, the output guardrail's
pattern library) had no feedback loop: it was set once and left alone until
someone manually noticed a bypass, usually in production, after the fact.
There was no answer to "how well is our guardrail stack actually holding
against prompt injection / jailbreak / exfiltration attempts today" short of
manually crafting and running adversarial prompts.

We wanted a system that: (a) fires the same category of attacks a real
attacker would try, through the *exact* production pipeline (input guardrail →
graph engine → output guardrail), not a mocked subset; (b) produces a single
comparable number so a trend is visible; (c) turns every attack that gets
through into a regression test, so a fixed bypass cannot silently regress; and
(d) can optionally react on its own, within a bounded envelope, rather than
requiring a human to notice and file a ticket.

## Decision

Three cooperating pieces, deliberately layered so the core stays
network/timer/database-free and unit-testable:

### 1. Attack registry (`src/security/red-team-attack-registry.ts`)

Wraps the static `ATTACK_TEMPLATES` (22 built-ins across 6 categories:
`prompt_injection`, `jailbreak`, `exfiltration`, `pii_extraction`,
`tool_abuse`, `encoding_evasion`) with a mutable registry supporting operator
`register()` of custom templates, a remote-URL poll
(`refreshRemote()`/`startPolling()`, default 6h interval) so the library stays
current without a code deploy, and per-category `disableCategory()` toggles.
Built-ins are never shadowed — `register()` and `refreshRemote()` both check
`builtinIds` and silently skip a colliding id — so a bad remote payload cannot
delete baseline coverage, only add to it. `defaultAttackRegistry` is a module
singleton so `GET /security/red-team/attacks` (in `routes/red-team.ts`) can
read whatever registry was last constructed without threading a reference
through every call site.

### 2. Engine (`src/security/red-team-engine.ts`)

`RedTeamEngineImpl.run(flowId, executor, opts)` is the orchestration core. It
is deliberately decoupled from HTTP, cron, and the database — `executor:
RedTeamExecutor` is injected (`(flowId, payload) => { response, blocked,
inputScore }`), so tests drive it with a fake and the real wiring passes a
function that calls the actual `GraphEngineService.executeFlow` path. Per
trial (`runTrial()`):

1. Send the attack payload through the injected executor.
2. If the input guardrail already blocked it (`result.blocked`), verdict is
   `"blocked"` — no further scoring needed.
3. Otherwise scan the response with `detectLeakInResponse()` — reuses
   `scoreText()` from `graph/input-guardrails.js` (the same heuristic
   signal set that gates *input*, now applied to *output*) plus dedicated
   output-only patterns (`sk-`/`AKIA`/`ghp_`/JWT-shaped secret regexes,
   system-prompt-echo phrasing, generic `key=value` credential dumps).
4. When a judge is configured and either the heuristic fired or the input
   score exceeded 0.3, an LLM judge scores the response against an explicit
   safety-compliance rubric; a score below `judgePassThreshold` (default 0.7)
   also counts as a bypass. Verdict is `bypassed` if *either* heuristic or
   judge says so — the judge only tightens detection, it cannot loosen it.

After the run: a **severity-weighted posture score**
(`1 − Σ(severity×bypassed) / Σ(severity×all)`, computed in `run()`) rather than
a flat bypass rate — a bypass on a low-severity attack should not dominate the
score the same way a bypass on exfiltration does. When `autoTune` is enabled
and the bypass rate exceeds `autoTuneBypassCeiling` (default 0.1), the input
guardrail threshold is tightened by `autoTuneStep` (default 0.05), floored at
`autoTuneMinThreshold` (default 0.3) so auto-tuning cannot silently block all
real traffic. Every bypassed trial is persisted as an `ExecutionSnapshot` in
the `ReplayStore` with `metadata.source: "red-team"`, so a bypass can be
re-executed against the current guardrail configuration — via
`POST /monitoring/replay` or the replay panel in Control — to confirm that a
fix holds. For a scheduled regression check, export the bypasses as an
evaluation dataset and run the eval CLI against it:

```bash
bun run --filter @atf/runtime eval:run -- \
  --dataset eval/red-team.json --base-url http://localhost:3000 --token <jwt>
```

A posture score below
`postureAlertThreshold` (default 0.7) fires a webhook (`fireAlert()`).

### 3. Scheduler (`src/security/red-team-scheduler.ts`)

A thin `setInterval` wrapper (default 6h) over the engine for a configured
`flowIds` list — kept separate from the engine specifically so the engine has
no timer dependency and can be driven synchronously in tests. A per-flow
failure inside `tick()` is caught and logged; it does not abort the remaining
flows in that cycle.

### Operator surface (`src/routes/red-team.ts`)

Mounted at `/security/red-team/*` behind the same operator auth as
`/monitoring`, deliberately scoped with `app.use("/security/*", ...)` rather
than a root-level `use("*")` — a root-level auth middleware here would run for
*every* request the app serves (`/monitoring/*`, `/flows/*`, …), rejecting
tokens those planes accept and turning their 401 (which the dashboard
auto-refreshes on) into an indiscriminate 403.

## Consequences

- Guardrail quality now has a trend line (`GET /security/red-team/posture`)
  instead of being invisible until an incident.
- Every bypass becomes a permanent regression case automatically — no manual
  step between "we found a hole" and "CI will catch it reopening."
- Auto-tune only ever tightens the guardrail; nothing in the engine loosens
  it automatically. A threshold that becomes too aggressive over many
  tightening cycles requires manual intervention to relax — an accepted
  asymmetry, since the failure mode of "guardrail too loose" is worse than
  "guardrail occasionally too strict."
- The engine feeds `AutopilotEngine.onRedTeamRunCompleted()` (see ADR-0008),
  so a sustained bypass-rate breach can trigger not just a threshold tighten
  but a full prompt-hardening optimization cycle — the two systems compose
  without the red-team engine knowing the autopilot exists (the hook is
  installed by wrapping `redTeamEngine.run` in `src/bootstrap/autopilot.ts`,
  not by a direct dependency from `red-team-engine.ts`).
- Detection is heuristic-plus-optional-judge; a genuinely novel bypass that
  matches none of the secret-shape regexes, none of the input-guardrail
  signal set, and is not flagged by the judge would be scored as `blocked`
  when it should not be. The attack *library* itself is extensible (custom +
  remote templates) precisely to keep pace with novel attack shapes without a
  code deploy, but detection quality is only as good as `detectLeakInResponse`
  and the judge rubric.
