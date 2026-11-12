// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Catalog of every human-readable string in the human-in-the-loop approval UI:
 * the chat message emitted by `onApprovalRequired` and the HTML served by the
 * in-chat widget, decision and confirmation endpoints (`routes/control.ts`).
 *
 * Before this existed the chat message was hard-coded in German while the
 * widget was hard-coded in English, so a deployment could not present both
 * halves of one interaction in the same language. `APPROVAL_MESSAGE_LOCALE`
 * selects the catalog for both (`en` is the default; `de` restores the
 * previous German chat text).
 *
 * Rules for this file:
 * - It is the ONLY place in `apps/runtime` where these strings appear, so a
 *   translation sweep has a single target.
 * - Values are plain text. Markup stays in the renderers, which escape the
 *   values they interpolate.
 * - `{placeholder}` tokens are substituted by {@link formatMessage}; both
 *   locales must use the same token names for a given key.
 * - Both locales must expose exactly the same keys — asserted by
 *   `__tests__/approval-messages.test.ts`, so a new key cannot ship in one
 *   language only.
 */

/** Locales the approval UI can render. */
export const APPROVAL_MESSAGE_LOCALES = ["en", "de"] as const;
export type ApprovalMessageLocale = (typeof APPROVAL_MESSAGE_LOCALES)[number];

/** The language fallback when a deployment asks for something unsupported. */
export const DEFAULT_APPROVAL_MESSAGE_LOCALE: ApprovalMessageLocale = "en";

/**
 * Every string of one approval interaction. See {@link APPROVAL_MESSAGES} for
 * what each key drives.
 */
export interface ApprovalMessages {
  /** BCP-47 tag to declare on the rendered HTML document. */
  lang: string;
  /** Heading of a pending approval — chat text and widget title. */
  approvalRequired: string;
  /** Placeholder shown instead of an empty argument list. */
  noArguments: string;
  /** Label introducing the argument list in the plain-text chat fallback. */
  arguments: string;
  /** Widget button that approves the request. */
  approve: string;
  /** Widget button that denies the request. */
  deny: string;
  /** Terminal state after an operator approved the request. */
  approved: string;
  /** Terminal state after the request was denied. */
  denied: string;
  /** Terminal state note when the gate auto-denied on its timeout. */
  timedOut: string;
  /** Question on the confirmation page for an approval ({tool}). */
  confirmApprove: string;
  /** Question on the confirmation page for a denial ({tool}). */
  confirmDeny: string;
  /** Link from the confirmation page back to the widget. */
  back: string;
  /** Why a second click is required, on the confirmation page. */
  confirmExplanation: string;
  /** Neutral card when an approval id is gone or no longer readable. */
  noLongerAvailable: string;
  /** Heading of that neutral card. */
  approvalLabel: string;
  /** Attribution of a decision to a reviewer ({by}). */
  resolvedBy: string;
  /** Tooltip of the widget countdown ({seconds}). */
  countdownTitle: string;
  /** Screen-reader label of the widget countdown ({seconds}). */
  countdownAria: string;
  /** Heading of the rejection for an unknown `decision` value. */
  invalidDecision: string;
  /** Detail of the rejection for an unknown `decision` value. */
  invalidDecisionNote: string;
  /** Heading of the rejection for a stale or mismatched confirmation ({decision}). */
  invalidConfirmation: string;
  /** Detail of the rejection for a stale or mismatched confirmation. */
  invalidConfirmationNote: string;
  /** Heading shown when a decision took effect but was not audited ({decision}). */
  auditEntryMissing: string;
  /** Detail shown when a decision took effect but was not audited. */
  auditEntryMissingNote: string;
  /** Tool label used when an approval carries none. */
  unnamedTool: string;
}

export const APPROVAL_MESSAGES: Record<ApprovalMessageLocale, ApprovalMessages> =
  {
    en: {
      lang: "en",
      approvalRequired: "Approval required",
      noArguments: "no arguments",
      arguments: "Arguments",
      approve: "Approve",
      deny: "Deny",
      approved: "Approved",
      denied: "Denied",
      timedOut: "Automatically denied (timed out).",
      confirmApprove: "Approve {tool}?",
      confirmDeny: "Deny {tool}?",
      back: "Back",
      confirmExplanation:
        "Confirm your choice — this second step keeps an automatic link " +
        "preview, prefetcher or security scanner from acting on the request.",
      noLongerAvailable:
        "This request is no longer available (already handled or expired).",
      approvalLabel: "Approval",
      resolvedBy: "by {by}",
      countdownTitle: "Automatic denial in {seconds}s",
      countdownAria: "Automatic denial in {seconds} seconds",
      invalidDecision: "Invalid decision",
      invalidDecisionNote:
        "Parameter decision must be approved or denied.",
      invalidConfirmation: "Invalid confirmation",
      invalidConfirmationNote:
        "The confirmation link is stale or belongs to a different decision. " +
        "Open the approval again.",
      auditEntryMissing: "{decision} — audit entry missing",
      auditEntryMissingNote:
        "The decision took effect, but it could not be recorded in the audit " +
        "trail. Please inform your operator.",
      unnamedTool: "tool call",
    },
    de: {
      lang: "de",
      approvalRequired: "Freigabe erforderlich",
      noArguments: "keine Argumente",
      arguments: "Argumente",
      approve: "Genehmigen",
      deny: "Ablehnen",
      approved: "Genehmigt",
      denied: "Abgelehnt",
      timedOut: "Automatisch abgelehnt (Zeitüberschreitung).",
      confirmApprove: "{tool} genehmigen?",
      confirmDeny: "{tool} ablehnen?",
      back: "Zurück",
      confirmExplanation:
        "Bestätige deine Auswahl — dieser zweite Schritt verhindert, dass ein " +
        "automatischer Link-Preview, Prefetcher oder Security-Scanner die " +
        "Anfrage bereits beantwortet.",
      noLongerAvailable:
        "Diese Anfrage ist nicht mehr verfügbar (bereits bearbeitet oder " +
        "abgelaufen).",
      approvalLabel: "Freigabe",
      resolvedBy: "von {by}",
      countdownTitle: "Automatische Ablehnung in {seconds}s",
      countdownAria: "Automatische Ablehnung in {seconds} Sekunden",
      invalidDecision: "Ungültige Entscheidung",
      invalidDecisionNote:
        "Der Parameter decision muss approved oder denied sein.",
      invalidConfirmation: "Ungültige Bestätigung",
      invalidConfirmationNote:
        "Der Bestätigungslink ist veraltet oder gehört zu einer anderen " +
        "Entscheidung. Öffne die Freigabe erneut.",
      auditEntryMissing: "{decision} — Audit-Eintrag fehlt",
      auditEntryMissingNote:
        "Die Entscheidung wurde wirksam, konnte aber nicht im Audit-Protokoll " +
        "erfasst werden. Bitte informiere deinen Betreiber.",
      unnamedTool: "Werkzeugaufruf",
    },
  };

/**
 * Resolve the catalog for a configured locale. An unknown or unset value falls
 * back to {@link DEFAULT_APPROVAL_MESSAGE_LOCALE} rather than failing: the
 * approval UI has to render something, and a misconfigured label language must
 * never block a security-relevant decision.
 */
export function approvalMessages(
  locale: string | undefined,
): ApprovalMessages {
  return APPROVAL_MESSAGES[
    locale !== undefined &&
    (APPROVAL_MESSAGE_LOCALES as readonly string[]).includes(locale)
      ? (locale as ApprovalMessageLocale)
      : DEFAULT_APPROVAL_MESSAGE_LOCALE
  ];
}

/**
 * Substitute `{name}` tokens in a catalog value. Values are escaped by the
 * caller that renders them, so substitution happens on the raw text.
 */
export function formatMessage(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? (values[key] ?? match) : match,
  );
}
