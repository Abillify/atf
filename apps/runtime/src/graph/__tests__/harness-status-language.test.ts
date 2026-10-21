// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `statusLanguage` renders every harness status and task label in one language.
 * Without the key the mixed legacy texts must stay byte-identical.
 */

import { describe, expect, test } from "bun:test";
import {
  formatTaskReference,
  parseHarnessConfig,
  renderTaskList,
  type Task,
} from "../agent-harness/types.js";
import {
  coverageLabelText,
  STATUS_TEXT,
  statusText,
  type StatusArgs,
  type StatusKey,
} from "../agent-harness/status-text.js";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "t3",
  displayStep: 2,
  description: "weiter recherchieren",
  target: "worker-a",
  status: "pending",
  ...overrides,
});

/**
 * Every key with its argument names. Values are language-neutral placeholders:
 * interpolated values come from the caller, only the template must be localized.
 */
const SAMPLES: Array<{ key: StatusKey; args: StatusArgs }> = [
  { key: "startingResearch", args: {} },
  { key: "taskList", args: { list: "LIST" } },
  { key: "updatedTaskList", args: { list: "LIST" } },
  { key: "taskInProgress", args: { ref: "REF" } },
  { key: "tasksInProgressParallel", args: { refs: "REFS" } },
  { key: "taskApprovalRejected", args: { ref: "REF" } },
  { key: "taskStatusLine", args: { ref: "REF", status: "STATUS" } },
  { key: "delegating", args: { target: "TARGET" } },
  { key: "delegatingParallel", args: { targets: "TARGETS" } },
  { key: "researchProgress", args: { detail: "DETAIL" } },
  { key: "stepProgress", args: { step: 2, max: 6, phase: "PHASE" } },
  {
    key: "hypothesesDetail",
    args: {
      active: 1,
      confirmed: 2,
      rejected: 3,
      detailState: "STATE",
      detail: "DETAIL",
    },
  },
  { key: "coverageDetail", args: { summary: "3/10" } },
  { key: "coveredScope", args: { scope: "SCOPE" } },
  { key: "nextResearchStep", args: { seq: 4 } },
  { key: "stopSignal", args: { signal: "SIGNAL" } },
  {
    key: "verificationRound",
    args: { round: 1, max: 2, target: "TARGET" },
  },
  { key: "verificationPassed", args: {} },
  { key: "reworkAfterVerification", args: { list: "LIST" } },
  { key: "reworkTaskDescription", args: { round: 1 } },
  { key: "researchStepLabel", args: { seq: 3 } },
  { key: "coverage", args: {} },
  { key: "coverageRework", args: {} },
  {
    key: "coverageTaskLabel",
    args: { prefix: "PREFIX", mode: "rerank", count: 4 },
  },
  { key: "taskReference", args: { id: "t3", step: "STEP", replanned: "" } },
  { key: "noTasks", args: {} },
  { key: "stepWord", args: { step: 2 } },
  { key: "replannedSuffix", args: {} },
  { key: "statusLabel", args: { status: "STATUS" } },
];

describe("statusText", () => {
  test("without a language the legacy text is returned verbatim", () => {
    for (const { key, args } of SAMPLES) {
      const legacy = `LEGACY<${key}>`;
      expect(statusText(undefined, key, args, legacy)).toBe(legacy);
    }
  });

  test("every key is defined in both languages and renders non-empty", () => {
    for (const { key, args } of SAMPLES) {
      expect(STATUS_TEXT.en[key](args).length).toBeGreaterThan(0);
      expect(STATUS_TEXT.de[key](args).length).toBeGreaterThan(0);
    }
  });

  test("the table covers every key in both languages", () => {
    const keys = Object.keys(STATUS_TEXT.en).sort();
    expect(Object.keys(STATUS_TEXT.de).sort()).toEqual(keys);
    expect(keys).toEqual(SAMPLES.map((s) => s.key).sort());
  });

  test("the German table contains no English-only fragments", () => {
    const englishOnly = [
      "Task list",
      "Updated task list",
      "in-progress",
      "delegating",
      "Research progress",
      "Next research step",
      "Stop signal detected",
      "Verification passed",
      "Rework after verification",
      "Research step",
      "(no tasks)",
      "step ",
      "(replanned)",
    ];
    for (const { key, args } of SAMPLES) {
      const text = STATUS_TEXT.de[key](args);
      for (const fragment of englishOnly) {
        expect(text.includes(fragment)).toBe(false);
      }
    }
  });

  test("the English table contains no German-only fragments", () => {
    const germanOnly = [
      "Aufgabenliste",
      "in Bearbeitung",
      "Übergabe",
      "Forschungsfortschritt",
      "Nächster Forschungsschritt",
      "Stopsignal",
      "Verifikation",
      "Nacharbeit",
      "Forschungsschritt",
      "keine Aufgaben",
      "Schritt ",
      "neu geplant",
    ];
    for (const { key, args } of SAMPLES) {
      const text = STATUS_TEXT.en[key](args);
      for (const fragment of germanOnly) {
        expect(text.includes(fragment)).toBe(false);
      }
    }
  });
});

describe("task reference and task list rendering", () => {
  test("single-argument calls keep the legacy rendering", () => {
    expect(formatTaskReference(task())).toBe("t3 · step 2");
    expect(formatTaskReference(task({ replanned: true }))).toBe(
      "t3 · step 2 (replanned)",
    );
    expect(renderTaskList([task()])).toBe(
      "○ t3 · step 2: weiter recherchieren → worker-a",
    );
    expect(renderTaskList([])).toBe("(no tasks)");
    expect(
      renderTaskList([task({ researchStatus: "Quelle belegt" })]),
    ).toBe(
      "○ t3 · step 2: weiter recherchieren → worker-a\n  Status: Quelle belegt",
    );
  });

  test("de renders the reference and list in German", () => {
    expect(formatTaskReference(task({ replanned: true }), "de")).toBe(
      "t3 · Schritt 2 (neu geplant)",
    );
    expect(renderTaskList([task({ researchStatus: "Quelle belegt" })], "de")).toBe(
      "○ t3 · Schritt 2: weiter recherchieren → worker-a\n  Status: Quelle belegt",
    );
    expect(renderTaskList([], "de")).toBe("(keine Aufgaben)");
  });

  test("en renders the reference and list in English", () => {
    expect(formatTaskReference(task({ replanned: true }), "en")).toBe(
      "t3 · step 2 (replanned)",
    );
    expect(renderTaskList([task()], "en")).toBe(
      "○ t3 · step 2: weiter recherchieren → worker-a",
    );
    expect(renderTaskList([], "en")).toBe("(no tasks)");
  });
});

describe("coverage task labels", () => {
  const assignment = { mode: "rerank", documents: [1, 2, 3] };

  test("without a language the legacy label is returned verbatim", () => {
    const legacy = "Coverage rerank: 3 document(s)";
    expect(
      coverageLabelText(undefined, assignment, "coverage", legacy),
    ).toBe(legacy);
  });

  test("en and de render the label in one language", () => {
    expect(
      coverageLabelText("en", assignment, "coverage", "legacy"),
    ).toBe("Coverage rerank: 3 document(s)");
    expect(
      coverageLabelText("de", assignment, "coverage", "legacy"),
    ).toBe("Abdeckung rerank: 3 Dokument(e)");
    expect(
      coverageLabelText("de", { mode: "discovery", documents: [] }, "coverageRework", "legacy"),
    ).toBe("Abdeckungs-Nacharbeit Discovery: gezielte hybride Suche");
  });
});

describe("statusLanguage config parsing", () => {
  test("absent stays absent", () => {
    expect(parseHarnessConfig({}).statusLanguage).toBeUndefined();
    expect(parseHarnessConfig(undefined).statusLanguage).toBeUndefined();
  });

  test("en and de are accepted, anything else is dropped", () => {
    expect(parseHarnessConfig({ statusLanguage: "en" }).statusLanguage).toBe(
      "en",
    );
    expect(parseHarnessConfig({ statusLanguage: "de" }).statusLanguage).toBe(
      "de",
    );
    expect(parseHarnessConfig({ statusLanguage: "fr" }).statusLanguage).toBe(
      undefined,
    );
    expect(parseHarnessConfig({ statusLanguage: 1 }).statusLanguage).toBe(
      undefined,
    );
  });
});
