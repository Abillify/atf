// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Single source of truth for agent-harness status and task-label texts.
//
// The harness grew its wording call site by call site, so a single run mixed
// English and German. When `statusLanguage` is configured every text comes from
// the table below; when it is absent the caller's legacy text is returned
// verbatim, which keeps existing runs byte-identical.

/** Language a harness run renders its status and task labels in. */
export type StatusLanguage = "en" | "de";

/** Interpolation values for a status text. */
export type StatusArgs = Readonly<Record<string, string | number>>;

const arg = (args: StatusArgs, key: string): string => String(args[key] ?? "");

/** Every text the agent harness can render. */
export type StatusKey =
  | "startingResearch"
  | "taskList"
  | "updatedTaskList"
  | "taskInProgress"
  | "tasksInProgressParallel"
  | "taskApprovalRejected"
  | "taskStatusLine"
  | "delegating"
  | "delegatingParallel"
  | "researchProgress"
  | "stepProgress"
  | "hypothesesDetail"
  | "coverageDetail"
  | "coveredScope"
  | "nextResearchStep"
  | "stopSignal"
  | "verificationRound"
  | "verificationPassed"
  | "reworkAfterVerification"
  | "reworkTaskDescription"
  | "researchStepLabel"
  | "coverage"
  | "coverageRework"
  | "coverageTaskLabel"
  | "taskReference"
  | "noTasks"
  | "stepWord"
  | "replannedSuffix"
  | "statusLabel";

export const STATUS_TEXT: Record<
  StatusLanguage,
  Record<StatusKey, (args: StatusArgs) => string>
> = {
  en: {
    startingResearch: () =>
      "Starting research. I first survey the document inventory, break the question into verifiable sub-aspects, and then prioritise the documents with the strongest relation. Afterwards I reconcile relevant original passages and possible counter-evidence before accepting a finding as dependable.",
    taskList: (a) => `Task list:\n${arg(a, "list")}`,
    updatedTaskList: (a) => `Updated task list:\n${arg(a, "list")}`,
    taskInProgress: (a) => `Task ${arg(a, "ref")} → in-progress`,
    tasksInProgressParallel: (a) =>
      `Tasks ${arg(a, "refs")} → in-progress (parallel)`,
    taskApprovalRejected: (a) =>
      `Task ${arg(a, "ref")} → failed (approval rejected)`,
    taskStatusLine: (a) => `Task ${arg(a, "ref")} → ${arg(a, "status")}`,
    delegating: (a) => `→ delegating to ${arg(a, "target")}`,
    delegatingParallel: (a) => `→ delegating in parallel to ${arg(a, "targets")}`,
    researchProgress: (a) => `Research progress: ${arg(a, "detail")}`,
    stepProgress: (a) =>
      `Step ${arg(a, "step")}/${arg(a, "max")}: ${arg(a, "phase")}`,
    hypothesesDetail: (a) =>
      ` — hypotheses (this step): ${arg(a, "active")} active, ${arg(a, "confirmed")} confirmed, ${arg(a, "rejected")} rejected; ` +
      `detail [${arg(a, "detailState")}]: ${arg(a, "detail")}`,
    coverageDetail: (a) => ` — coverage: ${arg(a, "summary")}`,
    coveredScope: (a) => ` — ${arg(a, "scope")}`,
    nextResearchStep: (a) => `Next research step (${arg(a, "seq")}) …`,
    stopSignal: (a) =>
      `Stop signal detected ("${arg(a, "signal")}") — research complete, re-plan skipped.`,
    verificationRound: (a) =>
      `→ Verification (round ${arg(a, "round")}/${arg(a, "max")}) via ${arg(a, "target")}`,
    verificationPassed: () => "Verification passed.",
    reworkAfterVerification: (a) =>
      `Rework after verification:\n${arg(a, "list")}`,
    reworkTaskDescription: (a) => `Rework after verification (${arg(a, "round")})`,
    researchStepLabel: (a) => `Research step ${arg(a, "seq")}`,
    coverage: () => "Coverage",
    coverageRework: () => "Coverage rework",
    coverageTaskLabel: (a) =>
      arg(a, "mode") === "discovery"
        ? `${arg(a, "prefix")} discovery: targeted hybrid search`
        : `${arg(a, "prefix")} ${arg(a, "mode")}: ${arg(a, "count")} document(s)`,
    taskReference: (a) => `${arg(a, "id")} · ${arg(a, "step")}${arg(a, "replanned")}`,
    noTasks: () => "(no tasks)",
    stepWord: (a) => `step ${arg(a, "step")}`,
    replannedSuffix: () => " (replanned)",
    statusLabel: (a) => `Status: ${arg(a, "status")}`,
  },
  de: {
    startingResearch: () =>
      "Ich starte die Recherche. Zunächst überblicke ich das Dokumenteninventar, zerlege die Frage in überprüfbare Teilaspekte und priorisiere danach die Dokumente mit der stärksten Beziehung. Anschließend gleiche ich relevante Originalstellen und mögliche Gegenbelege ab, bevor ich einen Befund als verlässlich übernehme.",
    taskList: (a) => `Aufgabenliste:\n${arg(a, "list")}`,
    updatedTaskList: (a) => `Aktualisierte Aufgabenliste:\n${arg(a, "list")}`,
    taskInProgress: (a) => `Aufgabe ${arg(a, "ref")} → in Bearbeitung`,
    tasksInProgressParallel: (a) =>
      `Aufgaben ${arg(a, "refs")} → in Bearbeitung (parallel)`,
    taskApprovalRejected: (a) =>
      `Aufgabe ${arg(a, "ref")} → fehlgeschlagen (Freigabe abgelehnt)`,
    taskStatusLine: (a) => `Aufgabe ${arg(a, "ref")} → ${arg(a, "status")}`,
    delegating: (a) => `→ Übergabe an ${arg(a, "target")}`,
    delegatingParallel: (a) =>
      `→ Übergabe parallel an ${arg(a, "targets")}`,
    researchProgress: (a) => `Forschungsfortschritt: ${arg(a, "detail")}`,
    stepProgress: (a) =>
      `Schritt ${arg(a, "step")}/${arg(a, "max")}: ${arg(a, "phase")}`,
    hypothesesDetail: (a) =>
      ` — Hypothesen (dieser Schritt): ${arg(a, "active")} aktiv, ${arg(a, "confirmed")} bestätigt, ${arg(a, "rejected")} verworfen; ` +
      `Detail [${arg(a, "detailState")}]: ${arg(a, "detail")}`,
    coverageDetail: (a) => ` — Abdeckung: ${arg(a, "summary")}`,
    coveredScope: (a) => ` — ${arg(a, "scope")}`,
    nextResearchStep: (a) => `Nächster Forschungsschritt (${arg(a, "seq")}) …`,
    stopSignal: (a) =>
      `Stopsignal erkannt ("${arg(a, "signal")}") — Forschung abgeschlossen, Neuplanung übersprungen.`,
    verificationRound: (a) =>
      `→ Verifikation (Runde ${arg(a, "round")}/${arg(a, "max")}) via ${arg(a, "target")}`,
    verificationPassed: () => "Verifikation bestanden.",
    reworkAfterVerification: (a) =>
      `Nacharbeit nach Verifikation:\n${arg(a, "list")}`,
    reworkTaskDescription: (a) =>
      `Nacharbeit nach Verifikation (${arg(a, "round")})`,
    researchStepLabel: (a) => `Forschungsschritt ${arg(a, "seq")}`,
    coverage: () => "Abdeckung",
    coverageRework: () => "Abdeckungs-Nacharbeit",
    coverageTaskLabel: (a) =>
      arg(a, "mode") === "discovery"
        ? `${arg(a, "prefix")} Discovery: gezielte hybride Suche`
        : `${arg(a, "prefix")} ${arg(a, "mode")}: ${arg(a, "count")} Dokument(e)`,
    taskReference: (a) => `${arg(a, "id")} · ${arg(a, "step")}${arg(a, "replanned")}`,
    noTasks: () => "(keine Aufgaben)",
    stepWord: (a) => `Schritt ${arg(a, "step")}`,
    replannedSuffix: () => " (neu geplant)",
    statusLabel: (a) => `Status: ${arg(a, "status")}`,
  },
};

/**
 * Renders `key` in `lang`. Without a language the caller's `legacy` text is
 * returned verbatim, so behaviour without the `statusLanguage` key is unchanged.
 */
export function statusText(
  lang: StatusLanguage | undefined,
  key: StatusKey,
  args: StatusArgs,
  legacy: string,
): string {
  if (lang === undefined) return legacy;
  return STATUS_TEXT[lang][key](args);
}

/**
 * Label for a deterministic coverage assignment. Without a language the
 * `legacy` label produced by the coverage helper is returned verbatim.
 */
export function coverageLabelText(
  lang: StatusLanguage | undefined,
  assignment: { mode: string; documents: readonly unknown[] },
  prefixKey: "coverage" | "coverageRework",
  legacy: string,
): string {
  if (lang === undefined) return legacy;
  return statusText(
    lang,
    "coverageTaskLabel",
    {
      prefix: statusText(lang, prefixKey, {}, ""),
      mode: assignment.mode,
      count: assignment.documents.length,
    },
    legacy,
  );
}
