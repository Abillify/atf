// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E: visual-regression snapshots of the four governance pages.
 *
 * These four images are the screenshots in the `README.md` section "Control at
 * a glance", so they are rendered from one fixed set of fixtures: every value
 * below is invented, and the pinned clock plus `timezoneId`, `locale` and
 * `colorScheme` from `playwright.config.ts` make the pixels reproducible.
 * `mockBackend()` supplies the app shell (grouped sidebar, palette, health,
 * SSE); each test layers on only the endpoints its own page calls on mount —
 * note that those routes must be registered AFTER `mockBackend()`, whose
 * catch-all for the metrics path would otherwise answer the metrics URL with
 * a Prometheus body instead of the JSON summary the panels expect.
 *
 * (Never write a route glob in a block comment here: the star-slash in the
 * middle of the pattern ends the comment.)
 *
 * `clock.setFixedTime()` pins `Date.now()` for `ApprovalsPanel`'s age text
 * while deliberately leaving the timers alone: a paused clock would also stop
 * the polling Playwright needs to wait for content, and the recharts bars grow
 * from zero on mount with no reduced-motion path. The polls therefore keep
 * firing — harmlessly, because every mocked payload is a constant, so each
 * re-render produces the same DOM. The cost test waits out the bar animation
 * before shooting.
 *
 * Regenerate after an intentional change — this rewrites the files the README
 * embeds:
 *   BASE_URL=http://localhost:3000 bun run test:e2e \
 *     -- e2e/visual-governance.spec.ts --update-snapshots
 *
 * Baselines are stored per platform; CI excludes them (its e2e job greps
 * "Visual regression" out) because Linux renders text with other fonts.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { mockBackend, setTestToken } from "./helpers/mock-backend";

/**
 * Single source of truth for the runtime identity every fixture describes —
 * it appears in the sidebar (active nav item), the trace, the audit report and
 * the spend tables, so one flow name and one tenant name run through all four
 * images.
 */
const FLOW = "06-request-pipeline";
const TENANT = "tenant-example";
const MODEL = "openai/gpt-4o-mini";
const EXEC_ID = "exec-aabbccdd-1234";

/** Pinned wall clock. Ages, waits and relative dates are arithmetic on this. */
const FIXED_TIME = "2026-05-14T10:00:00.000Z";

/** Serves the same payload on every poll, so a refresh cannot change pixels. */
function staticJson(page: Page, pattern: string, body: unknown): Promise<void> {
  return page.route(pattern, (route: Route) => route.fulfill({ json: body }));
}

// -------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------

/** Two requests a reviewer has to decide, one of them already overdue. */
const PENDING_APPROVALS = {
  pending: [
    {
      id: "appr-1",
      executionId: EXEC_ID,
      nodeId: "tool-send",
      tool: "crm/send_email",
      args: {
        to: "someone@example.com",
        subject: "Your open ticket",
        body: "We found your ticket and are replying today.",
      },
      tenantId: TENANT,
      requestedAt: "2026-05-14T09:48:00.000Z",
    },
    {
      id: "appr-2",
      executionId: "exec-eeff0011-2233",
      nodeId: "tool-cancel",
      tool: "crm/cancel_booking",
      args: { booking_id: "B-100", reason: "customer request" },
      tenantId: "tenant-example-2",
      requestedAt: "2026-05-14T09:59:30.000Z",
    },
  ],
  resolved: [],
};

/**
 * One run of `FLOW`: retrieval, the model call, and a write tool that was
 * approved. Timestamps are absolute so the viewer renders them verbatim and
 * the wait badge becomes decidedAt - requestedAt.
 */
const TRACE_EVENTS = [
  {
    execution_id: EXEC_ID,
    node_id: "retrieve",
    label: "retrieve",
    status: "completed",
    start_time: "2026-05-14T09:40:00.000Z",
    end_time: "2026-05-14T09:40:00.420Z",
    latency_ms: 420,
    sequence: 1,
  },
  {
    execution_id: EXEC_ID,
    node_id: "answer",
    label: "answer",
    status: "completed",
    start_time: "2026-05-14T09:40:00.420Z",
    end_time: "2026-05-14T09:40:03.140Z",
    latency_ms: 2720,
    model: MODEL,
    input_tokens: 1_840,
    output_tokens: 214,
    cost: 0.0019,
    sequence: 2,
    prompt:
      "You are the support assistant for Example Corp. Answer only from the " +
      "retrieved contract clauses below; if they do not answer the question, " +
      "say so.\n\nClauses:\n- §4 Cancellation: 30 days notice.\n" +
      "- §7 Support: first reply within one business day.",
    response:
      "Your contract gives a 30 day cancellation notice (§4), and we reply " +
      "within one business day (§7).",
  },
  {
    execution_id: EXEC_ID,
    node_id: "tool-send",
    label: "crm/send_email",
    kind: "tool",
    parent_node_id: "answer",
    status: "completed",
    start_time: "2026-05-14T09:41:00.000Z",
    end_time: "2026-05-14T09:41:00.900Z",
    latency_ms: 900,
    sequence: 3,
    tool_calls: [
      {
        id: "tc-1",
        name: "crm__send_email",
        args_json:
          '{"to":"someone@example.com","subject":"Your open ticket",' +
          '"body":"We found your ticket and are replying today."}',
        exec_time_seconds: 0.9,
      },
    ],
  },
];

const TRACE_APPROVALS = {
  pending: [],
  resolved: [
    {
      id: "appr-1",
      approved: true,
      tool: "crm/send_email",
      nodeId: "tool-send",
      executionId: EXEC_ID,
      args: PENDING_APPROVALS.pending[0]?.args,
      by: "op@example.com",
      requestedAt: "2026-05-14T09:40:40.000Z",
      decidedAt: "2026-05-14T09:41:00.000Z",
    },
  ],
};

const COMPLIANCE_STATUS = {
  targets: [
    { name: "executions", capabilities: { agePurge: true, subjectErase: true } },
    { name: "memories", capabilities: { agePurge: true, subjectErase: true } },
    { name: "snapshots", capabilities: { agePurge: true, subjectErase: false } },
  ],
};

/**
 * The policy as the audit report embeds it: a flat `PolicySummary`, unlike the
 * nested `rules` object `/admin/compliance-policy` returns below.
 */
const REPORT_POLICY = {
  version: "1.3.0",
  description: "Example corp policy: EU residency, approval for outbound mail.",
  failClosed: true,
  dataRules: 4,
  modelRules: 3,
  approvalRules: 2,
  retentionRules: 3,
  auditRules: 2,
};

const COMPLIANCE_POLICY = {
  enabled: true,
  version: "1.3.0",
  description: "Example corp policy: EU residency, approval for outbound mail.",
  failClosed: true,
  rules: {
    dataRules: 4,
    modelRules: 3,
    approvalRules: 2,
    retentionRules: 3,
    auditRules: 2,
  },
};

const COMPLIANCE_REPORT = {
  generatedAt: FIXED_TIME,
  windowStart: "2026-05-13T10:00:00.000Z",
  windowEnd: FIXED_TIME,
  policy: REPORT_POLICY,
  violations: {
    total: 3,
    denied: 1,
    requireApproval: 2,
    recent: [
      {
        at: "2026-05-14T09:12:00.000Z",
        action: "crm/send_email",
        actor: "op@example.com",
        target: FLOW,
      },
      {
        at: "2026-05-14T07:05:00.000Z",
        action: "chat.completion",
        actor: "op@example.com",
        target: FLOW,
      },
    ],
  },
  approvals: { total: 2, approved: 1, denied: 1, timedOut: 0 },
  modelUsage: [
    { provider: "openai", model: "gpt-4o-mini", requests: 128, tenants: [TENANT] },
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      requests: 37,
      tenants: [TENANT, "tenant-example-2"],
    },
  ],
  retentionRules: [
    { dataClass: "personal", maxAgeDays: 90 },
    { dataClass: "execution", maxAgeDays: 30 },
  ],
};

const AUDIT_ANCHOR = {
  active: true,
  uptoId: "18_420",
  signature: "8f14e45fceea167a5a36dedd4bea2543a0c5d1f9b7e2c3a49586778899aabbcc",
  createdAt: "2026-05-14T06:00:00.000Z",
  valid: true,
};

const ROPA = {
  generatedAt: FIXED_TIME,
  entries: [
    {
      flowId: FLOW,
      flowName: "Request pipeline",
      description: "Answers support questions from the contracted knowledge base.",
      dataClasses: ["contact data", "ticket text"],
      processors: [
        { provider: "openai", models: [MODEL], nodeIds: ["answer"], local: false },
        {
          provider: "qdrant",
          models: [],
          nodeIds: ["retrieve"],
          local: true,
        },
      ],
      status: "compliant",
      warnings: [],
    },
    {
      flowId: "dispatch",
      flowName: "Intake router",
      dataClasses: ["ticket text"],
      processors: [
        {
          provider: "anthropic",
          models: ["claude-sonnet-4-5"],
          nodeIds: ["classify"],
          local: false,
        },
      ],
      status: "undeclared",
      warnings: ["no data classes declared on node classify"],
    },
  ],
  summary: {
    flows: 2,
    withDataClasses: 1,
    violations: 0,
    providers: ["openai", "anthropic", "qdrant"],
    dataClasses: ["contact data", "ticket text"],
  },
};

const DOSSIER = {
  generatedAt: FIXED_TIME,
  windowStart: "2026-05-13T10:00:00.000Z",
  windowEnd: FIXED_TIME,
  auditReport: { policy: REPORT_POLICY },
  auditIntegrity: { chainVerification: { valid: true, checked: 18_420 } },
  rtbfEvidence: {
    totalOperations: 2,
    totalRecordsErased: 57,
    operations: [
      {
        at: "2026-05-13T15:20:00.000Z",
        actor: "op@example.com",
        action: "forget",
        target: "tenant=tenant-example-2",
        erased: 57,
      },
    ],
  },
  retentionPosture: {
    targets: [
      { name: "executions", agePurge: true, subjectErase: true, maxAgeDays: 30 },
      { name: "snapshots", agePurge: true, subjectErase: false, maxAgeDays: 7 },
      { name: "memories", agePurge: true, subjectErase: true, maxAgeDays: null },
    ],
    policyRetentionRules: [
      { dataClass: "personal", maxAgeDays: 90 },
      { dataClass: "execution", maxAgeDays: 30 },
    ],
  },
  evalEvidence: [
    {
      dataset: "support-answers",
      recordedAt: "2026-05-13T02:00:00.000Z",
      source: "ci",
      passRate: 0.96,
      passed: 48,
      total: 50,
      avgScore: 4.6,
    },
    {
      dataset: "pii-redaction",
      recordedAt: "2026-05-12T02:00:00.000Z",
      source: "ci",
      passRate: 1,
      passed: 30,
      total: 30,
      avgScore: 5,
    },
  ],
  securityPosture: {
    enabled: true,
    postureByFlow: { [FLOW]: 0.88 },
    recentRuns: [
      {
        id: "rt-1",
        flowId: FLOW,
        status: "completed",
        bypassRate: 0,
        postureScore: 0.88,
      },
    ],
  },
  dlpEffectiveness: {
    dataset: "pii-corpus-example",
    cases: 320,
    overall: { recall: 0.981, precision: 0.965, f1: 0.973, falseNegatives: 6 },
    byType: [
      { type: "email", recall: 0.99, precision: 0.99 },
      { type: "iban", recall: 0.97, precision: 0.95 },
    ],
  },
  architecturalGuarantees: [
    {
      topic: "Tenant isolation",
      summary: "Every query is scoped by the authenticated tenant claim.",
      reference: "docs/SECURITY.md",
    },
    {
      topic: "Fail-closed approvals",
      summary: "An unanswered tool approval auto-denies at the timeout.",
      reference: "docs/FLOWS.md",
    },
  ],
};

/** Full `MetricsSummary`; `/monitoring/metrics` is JSON, not the text body. */
const METRICS_SUMMARY = {
  requestsTotal: 1_204,
  requestsByStatus: { "200": 1_150, "400": 32, "429": 12, "500": 10 },
  nodeExecutionsTotal: 3_880,
  nodeErrorsTotal: 21,
  llmCallsTotal: 2_140,
  llmErrorsTotal: 7,
  tokensPrompt: 1_940_000,
  tokensCompletion: 386_000,
  costTotal: 14.27,
  costByModel: {
    "openai/gpt-4o-mini": 4.9,
    "anthropic/claude-sonnet-4-5": 7.31,
    "mock/mock-echo": 2.06,
  },
  tokensByModel: {
    "openai/gpt-4o-mini": { prompt: 1_120_000, completion: 190_000 },
    "anthropic/claude-sonnet-4-5": { prompt: 720_000, completion: 160_000 },
    "mock/mock-echo": { prompt: 100_000, completion: 36_000 },
  },
  activeExecutions: 3,
  queueDepth: 0,
  avgNodeLatencyMs: 812,
  groundednessPassed: 640,
  groundednessFailed: 18,
  approvalsApproved: 41,
  approvalsDenied: 6,
  cacheHits: 812,
  cacheMisses: 392,
  cacheExactHits: 640,
  cacheSemanticHits: 172,
  tenants: [
    { tenant: TENANT, spent: 9.4, cap: 50, resetAt: 1_778_803_200 },
    { tenant: "tenant-example-2", spent: 3.1, cap: 20, resetAt: 1_778_803_200 },
    { tenant: "tenant-example-3", spent: 1.77, cap: 10, resetAt: 1_778_803_200 },
  ],
  spendByUser: [
    { userId: "u-1", label: "ana@example.com", spent: 5.2 },
    { userId: "u-2", label: "ben@example.com", spent: 3.4 },
    { userId: "u-3", label: "clea@example.com", spent: 1.1 },
  ],
  spendByFlow: [
    { flowId: FLOW, spent: 6.8 },
    { flowId: "fds-recherche", spent: 4.2 },
    { flowId: "dispatch", spent: 3.27 },
  ],
};

test.describe("Visual regression — governance pages", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1_440, height: 1_100 });
    // Pinned before navigating so the first render already carries the target
    // time — otherwise the age text is rendered once from the real clock.
    await page.clock.setFixedTime(new Date(FIXED_TIME));
  });

  /** The scrollable content area of the dashboard layout. */
  function content(page: Page) {
    return page.locator("main");
  }

  test("approvals — reviewer inbox", async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
    await staticJson(page, "**/monitoring/approvals", PENDING_APPROVALS);
    await page.goto("/approvals");
    await expect(
      page.getByRole("heading", { level: 3, name: /Pending approvals/ }),
    ).toBeVisible();
    // Both ages come from the pinned clock: the first request is 12 minutes
    // old here, the second 30 seconds — the text in the image, not just its
    // pixels, are reproducible. Only the panel itself is shot, because the
    // inbox is short and a full viewport would be mostly empty page.
    await expect(page.locator("main section").first()).toHaveScreenshot(
      "governance-approvals.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("traces — step-by-step with prompt, tokens and approval", async ({
    page,
  }) => {
    // The trace view is a fixed two-column panel; a shorter viewport keeps it
    // filling the frame instead of trailing off into empty page.
    await page.setViewportSize({ width: 1_440, height: 620 });
    await mockBackend(page, { nodeEvents: TRACE_EVENTS });
    await setTestToken(page);
    await staticJson(page, "**/monitoring/approvals", TRACE_APPROVALS);
    await staticJson(page, "**/api/traces/**", { spans: [] });

    await page.goto(`/traces?execution=${EXEC_ID}`);
    await expect(page.getByRole("button", { name: /answer/ })).toBeVisible();
    await page.getByRole("button", { name: /answer/ }).click();
    // The metadata row is the proof the selected step carries its LLM numbers.
    // The prompt/response sections stay collapsed on purpose: their open state
    // is component state that a background refetch can reset, and the numbers
    // above are the story this image tells.
    await expect(page.getByText(/in-tokens\s+1840/)).toBeVisible();
    await expect(content(page)).toHaveScreenshot("governance-traces.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("compliance — policy, audit report, retention and dossier", async ({
    page,
  }) => {
    await mockBackend(page);
    await setTestToken(page);
    await staticJson(page, "**/admin/compliance/status", COMPLIANCE_STATUS);
    await staticJson(page, "**/admin/compliance/audit-anchor", AUDIT_ANCHOR);
    await staticJson(page, "**/admin/compliance/ropa", ROPA);
    await staticJson(page, "**/admin/compliance/dossier", DOSSIER);
    // Order matters: the bare pattern also matches the report URL, and the
    // route registered last is the one Playwright consults.
    await staticJson(page, "**/admin/compliance-policy", COMPLIANCE_POLICY);
    await staticJson(page, "**/admin/compliance-policy/report", COMPLIANCE_REPORT);

    await page.goto("/compliance");
    await expect(
      page.getByRole("heading", { level: 2, name: /Compliance Dossier/ }),
    ).toBeVisible();
    await expect(content(page)).toHaveScreenshot("governance-compliance.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("cost — spend by model, tenant and flow", async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
    // Registered last on purpose: mockBackend has a catch-all for the metrics
    // path returning the Prometheus body, and the later route wins.
    await staticJson(page, "**/monitoring/metrics", METRICS_SUMMARY);
    await page.goto("/cost");
    await expect(
      page.getByRole("heading", { level: 3, name: /Estimated cost by model/ }),
    ).toBeVisible();
    // recharts grows the bars on mount (see the note above): give the
    // animation its full duration before the stability check starts.
    await page.waitForTimeout(1_500);
    await expect(content(page)).toHaveScreenshot("governance-cost.png", {
      maxDiffPixelRatio: 0.05,
    });
  });
});
