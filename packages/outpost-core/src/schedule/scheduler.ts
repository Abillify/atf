// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Scheduler: Serialisierung der Sync-Laeufe pro Quelle (requirements 1.3,
 * 1.4, 3.5, 3.8, 3.9, 6.17).
 *
 * Zustandsmaschine pro Quelle: `idle -> running -> idle` mit `pending`-Flag
 * (Trigger waehrend eines Laufs koaleszieren zu genau einem Folge-Lauf).
 * Zusaetzliche Zustände: `stopped` (nach {@link Scheduler.stopAll} — Trigger
 * werden verworfen), `paused` (Extract-Reauth erforderlich, 4.4) sowie die
 * aus dem letzten Lauf abgeleiteten Anzeigestaende `needs-authorization`,
 * `awaiting-confirmation` und `error`.
 *
 * Logout-Sequenz (3.5, 3.8, design.md): {@link performLogout} stoppt zuerst
 * alle Quellen (inkl. Abort ohne Grace-Periode und Warten auf laufende
 * Transfers), flusht jeden Sync_State und loescht ERST danach die
 * Extract-Credentials — pendingUpload-Eintraege bleiben erhalten (8.6).
 */

import type { Logger } from "pino";
import type { OutpostConfig, SourceConfig } from "../config/schema.js";
import type { RunReport } from "../sync/run.js";
import type { TokenProvider } from "../auth/manager.js";
import { newCounters, type RunCounters } from "../sync/counters.js";

/** Anzeigestatus einer Quelle fuer Health/Tray (Anforderung 11.3). */
export type SourceStatus =
  | "idle"
  | "running"
  | "paused"
  | "needs-authorization"
  | "awaiting-confirmation"
  | "error"
  | "stopped";

/** Zusammenfassung des zuletzt abgeschlossenen Laufs. */
export interface LastRunInfo {
  /** ISO-Zeitpunkt des Laufendes. */
  finishedAt: string;
  /** Ergebnis des Laufs. */
  result: RunReport["outcome"];
  /** Zaehler des Laufs. */
  counters: RunCounters;
}

/** Status-Sicht einer Quelle (Health-API, Task 20.3). */
export interface SourceStatusView {
  sourceId: string;
  status: SourceStatus;
  /** Ein Trigger wartet auf den naechsten Lauf. */
  pending: boolean;
  lastRun?: LastRunInfo;
}

interface SourceEntry {
  readonly src: SourceConfig;
  status: SourceStatus;
  pending: boolean;
  stopped: boolean;
  controller?: AbortController;
  runPromise?: Promise<void>;
  interval?: ReturnType<typeof setInterval>;
  lastRun?: LastRunInfo;
}

export interface SchedulerOptions {
  cfg: OutpostConfig;
  logger: Logger;
  /** Fuehrt genau einen Sync-Lauf fuer eine Quelle aus (runSourceOnce). */
  runSource: (src: SourceConfig, signal: AbortSignal) => Promise<RunReport>;
  /** Flusht den Sync_State einer Quelle (vor Token-Loeschung, 3.5). */
  flushSource: (sourceId: string) => Promise<void>;
}

export class Scheduler {
  private readonly opts: SchedulerOptions;
  private readonly entries = new Map<string, SourceEntry>();
  /** true, waehrend alle Quellen wegen Extract-Reauth pausieren (4.4). */
  private reauthPaused = false;
  /** true nach beginShutdown(): keine neuen Läufe mehr (10.7). */
  private shutdownRequested = false;
  /** manuelle Pause (10.6): Trigger setzen nur pending, laufende Läufe enden. */
  private paused = false;

  constructor(options: SchedulerOptions) {
    this.opts = options;
    for (const src of options.cfg.sources) {
      this.entries.set(src.id, {
        src,
        status: "idle",
        pending: false,
        stopped: false,
      });
    }
  }

  /** Startet alle Quellen: sofortiger Lauf, danach Intervall (1.3).
   *  Hebt ausserdem `stopped` nach erneuter Anmeldung auf (3.8). */
  start(): void {
    const intervalMs = this.opts.cfg.syncIntervalSec * 1000;
    for (const entry of this.entries.values()) {
      if (entry.stopped) {
        entry.stopped = false;
        if (entry.status === "stopped") entry.status = "idle";
      }
      if (entry.interval === undefined && intervalMs > 0) {
        entry.interval = setInterval(() => {
          this.trigger(entry.src.id);
        }, intervalMs);
        // Der Timer darf einen Prozess nicht am Beenden hindern (CLI once).
        entry.interval.unref?.();
      }
      this.trigger(entry.src.id);
    }
  }

  /**
   * Triggert einen Lauf fuer eine Quelle. Laeuft bereits einer, wird
   * `pending` gesetzt (genau ein Folge-Lauf, 1.4). Gestoppte/quellende
   * Quellen ignorieren Trigger (3.8); Quellen im Zustand
   * `needs-authorization` starten weiterhin Laeufe (6.17).
   */
  trigger(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (entry === undefined || entry.stopped) return;
    if (this.shutdownRequested) return;
    if (this.reauthPaused || this.paused) {
      entry.pending = true;
      return;
    }
    if (entry.runPromise !== undefined) {
      entry.pending = true;
      return;
    }
    this.startRun(entry);
  }

  /**
   * Credential-Aenderung einer Quelle (6.17): startet den naechsten Lauf
   * sofort, ohne auf das Intervall zu warten.
   */
  credentialChanged(sourceId: string): void {
    this.trigger(sourceId);
  }

  /**
   * Extract-Reauth erforderlich (4.4): bricht laufende Laeufe ab, pausiert
   * alle Quellen bis {@link resume}. pending-Trigger bleiben erhalten.
   */
  onReauthRequired(): void {
    this.reauthPaused = true;
    for (const entry of this.entries.values()) {
      entry.controller?.abort("reauth");
    }
    this.opts.logger.warn(
      { event: "scheduler.reauth_paused" },
      "alle Sync-Laeufe pausiert: Re-Authentifizierung erforderlich",
    );
  }

  /**
   * Manuelle Pause (10.6): es starten keine neuen Läufe, laufende laufen zu
   * Ende. Trigger während der Pause werden zu genau einem Folge-Lauf.
   */
  pauseAll(): void {
    this.paused = true;
    this.opts.logger.info({ event: "scheduler.paused" }, "Sync-Laeufe pausiert");
  }

  /** Beendet die manuelle Pause; pending-Trigger starten sofort (10.6). */
  resumeAll(): void {
    if (!this.paused) return;
    this.paused = false;
    this.opts.logger.info({ event: "scheduler.resumed" }, "Sync-Laeufe fortgesetzt");
    for (const entry of this.entries.values()) {
      if (entry.stopped || this.reauthPaused) continue;
      if (entry.pending && entry.runPromise === undefined) {
        entry.pending = false;
        this.startRun(entry);
      }
    }
  }

  /** true, wenn manuell pausiert (10.6). */
  isPaused(): boolean {
    return this.paused;
  }

  /** Setzt nach erfolgreichem Re-Login alle Pausen auf; pending -> Lauf. */
  resume(): void {
    this.reauthPaused = false;
    for (const entry of this.entries.values()) {
      if (entry.stopped || this.paused) continue;
      if (entry.status === "paused") entry.status = "idle";
      if (entry.pending && entry.runPromise === undefined) {
        entry.pending = false;
        this.startRun(entry);
      }
    }
  }

  /**
   * Stoppt alle Quellen (3.8): stopped-Status, pending verwerfen, Intervalle
   * loeschen, laufende Laeufe ohne Grace-Periode abbrechen, auf alle Laeufe
   * warten und jeden Sync_State flushen. Nach Rueckkehr dieses Aufrufs sind
   * alle Stores persistent — die Token-Loeschung darf beginnen (3.5).
   */
  async stopAll(reason: string): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      entry.stopped = true;
      entry.pending = false;
      if (entry.interval !== undefined) {
        clearInterval(entry.interval);
        entry.interval = undefined;
      }
      entry.controller?.abort(reason);
      if (entry.runPromise !== undefined) waits.push(entry.runPromise);
    }
    await Promise.allSettled(waits);
    for (const entry of this.entries.values()) {
      entry.status = "stopped";
      await this.opts.flushSource(entry.src.id);
    }
    this.opts.logger.info(
      { event: "scheduler.stopped", reason },
      "alle Sync-Laeufe gestoppt, Sync_State geflusht",
    );
  }

  /** Status-Sicht aller Quellen (Health/Tray, 11.3). */
  status(): SourceStatusView[] {
    return [...this.entries.values()].map((entry) => ({
      sourceId: entry.src.id,
      status:
        this.paused && entry.status === "idle" ? "paused" : entry.status,
      pending: entry.pending,
      ...(entry.lastRun !== undefined ? { lastRun: entry.lastRun } : {}),
    }));
  }

  /** true, wenn der Scheduler gestoppt ist (erste gestoppte Quelle). */
  isStopped(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.stopped) return true;
    }
    return false;
  }

  /**
   * Graceful Shutdown (10.7): Intervalle stoppen und keine neuen Läufe mehr
   * starten, aber laufende Übertragungen NICHT abbrechen — sie dürfen zu
   * Ende laufen. {@link stopAll} bricht nach der Grace-Periode ab.
   */
  beginShutdown(): void {
    this.shutdownRequested = true;
    for (const entry of this.entries.values()) {
      if (entry.interval !== undefined) {
        clearInterval(entry.interval);
        entry.interval = undefined;
      }
    }
  }

  /** true, wenn mindestens ein Lauf aktiv ist (Graceful-Shutdown-Warte). */
  hasActiveRun(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.runPromise !== undefined) return true;
    }
    return false;
  }

  /** Wartet, bis kein Lauf mehr aktiv ist (oder alle gestoppt sind). */
  async awaitIdle(): Promise<void> {
    for (;;) {
      const waits = [...this.entries.values()]
        .map((e) => e.runPromise)
        .filter((p): p is Promise<void> => p !== undefined);
      if (waits.length === 0) return;
      await Promise.allSettled(waits);
    }
  }

  private startRun(entry: SourceEntry): void {
    entry.status = "running";
    const controller = new AbortController();
    entry.controller = controller;
    // Gate sofort setzen: Trigger, die synchron in runSource (vor dessen
    // erstem await) eintreffen, sehen einen laufenden Run und setzen pending.
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    entry.runPromise = gate;
    void (async () => {
      let report: RunReport | undefined;
      let failed = false;
      try {
        report = await this.opts.runSource(entry.src, controller.signal);
      } catch {
        failed = true;
      }
      entry.runPromise = undefined;
      entry.controller = undefined;
      if (entry.stopped) {
        settle();
        return;
      }
      if (report !== undefined) {
        entry.lastRun = {
          finishedAt: new Date().toISOString(),
          result: report.outcome,
          counters: report.counters,
        };
      }
      if (this.reauthPaused || this.paused) {
        if (this.reauthPaused) entry.status = "paused";
        settle();
        return; // resume()/resumeAll() startet den naechsten Lauf
      }
      if (failed) {
        entry.status = "error";
      } else if (report !== undefined) {
        entry.status = statusFromReport(report);
      } else {
        entry.status = "idle";
      }
      if (entry.pending) {
        entry.pending = false;
        this.startRun(entry);
      }
    })();
  }
}

function statusFromReport(report: RunReport): SourceStatus {
  switch (report.outcome) {
    case "needs-authorization":
      return "needs-authorization";
    case "reauth-required":
      return "paused";
    case "incomplete":
      return "error";
    case "ok":
      return report.deletePhase === "awaiting-confirmation"
        ? "awaiting-confirmation"
        : "idle";
  }
}

/**
 * Logout-Sequenz in fester Reihenfolge (3.5, 3.8, design.md):
 * 1. alle Laeufe stoppen, auf Transfers warten, Sync_State flushen
 * 2. ERST danach die Extract-Credentials loeschen
 * Cloud-Quellen-Schluessel (`source:*`) bleiben erhalten (3.9).
 */
export async function performLogout(
  scheduler: Scheduler,
  tokenProvider: TokenProvider,
): Promise<void> {
  await scheduler.stopAll("logout");
  await tokenProvider.logout();
}

/** Leere Zaehler-Hilfe fuer Status-Anzeigen ohne letzten Lauf. */
export function emptyCounters(): RunCounters {
  return newCounters();
}
