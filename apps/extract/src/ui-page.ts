// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ui-page.ts
 *
 * The operator console: one self-contained page, no build step, no framework.
 *
 * ## Why it is hand-written HTML
 *
 * This is an operator tool for checking that a document converts the way it
 * should before wiring a corpus through the API. Its whole value is being
 * available at the service's own root with nothing to install, which a bundled
 * SPA would trade away for features nobody needs here. Search's `test-page.ts`
 * makes the same call, and this page deliberately shares its visual language
 * — the dark card, the tab bar, the drop zone — so an operator moving between
 * the two services sees one product, not two.
 *
 * ## What it does
 *
 * Tabs, mirroring what the backend offers:
 *
 *  - **Konvertieren** — drop one or many documents, watch each convert page by
 *    page over SSE, then copy or download the resulting Markdown per file. Each
 *    file is a separate `/ui/convert` request (the backend takes one file per
 *    request); the browser walks the queue in order so an operator can drop a
 *    folder's worth of PDFs and leave.
 *  - **Indexieren** — the same drop-and-queue flow, but each file is converted
 *    *and* written to Search via `/ui/ingest`, with the full set of ingest
 *    headers (collection, tags, chunking, access control) exposed. On a
 *    Document Intelligence v2 deployment that route is a job wrapper: a large
 *    document answers 202 with a job id, which the page then follows.
 *  - **Neuer Job** (v2 only) — the full `POST /v2/jobs` surface: the source is
 *    uploaded in resumable, checksummed chunks via `/ui/uploads` (or pulled from
 *    a `source_url`, or named by an already stored sha256), then a job is
 *    created with every job option and followed stage by stage.
 *  - **Jobs** (v2 only) — the job overview with per-stage progress, identity
 *    (version, duplicate, revision), the operator actions including reparse and
 *    resume-with-policy, and an on-demand page preview via `/ui/render`.
 *  - **Health** — a formatted view of `/health`: pipeline settings, dependency
 *    probes and queue depth, so an operator can tell at a glance whether the
 *    converters and the vision model are reachable.
 *
 * ## Why it streams
 *
 * A 40-page specification takes minutes. A spinner tells an operator nothing,
 * while pages appearing one by one tells them whether the conversion is working
 * *and* whether the output is right — usually within the first page, which is
 * when it is still cheap to change a setting and retry. So the convert flow
 * consumes the SSE mode of `/v1/convert` and surfaces every event the backend
 * emits: queue position, per-page progress, ETA, token spend and heartbeats.
 *
 * ## Security notes
 *
 * The page authenticates with the session cookie the OIDC flow set; it never
 * holds a bearer token, because a token in a browser is a token in every
 * extension that page loads. Requests go to `/ui/*`, which is the
 * backend-for-frontend boundary that accepts cookies and applies the CSRF guard
 * (all fetches send `credentials: "same-origin"`). Model output — converted
 * Markdown, converter stderr, page warnings — is inserted with `textContent`,
 * never `innerHTML`: converted documents contain HTML tables by contract, and
 * rendering those would execute whatever a crafted PDF talked the model into
 * emitting. The only `innerHTML` writes on this page are of strings we build
 * ourselves from `escapeHtml`-wrapped values.
 */

import { supportedExtensions, supportedFormatsLabel } from "./formats.js";

export interface UiPageOptions {
  /** Rendered as a sign-out link when SSO is configured. */
  logoutPath: string | null;
  /** Whether the ingest tab is shown at all. */
  ingestEnabled: boolean;
  /**
   * Whether the Document Intelligence v2 surface is shown: the Jobs overview
   * (requirement 18.6), the "Neuer Job" tab and the page preview. Only when the
   * v2 job store is configured, which is what `/ui/jobs`, `/ui/uploads` and
   * `/ui/render` depend on.
   */
  jobsEnabled: boolean;
  /** Collection prefilled in the ingest form. */
  defaultCollection: string;
  maxUploadBytes: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getUiPageHtml(options: UiPageOptions): string {
  const accept = supportedExtensions().join(",");
  const formats = supportedFormatsLabel();
  const maxMib = Math.floor(options.maxUploadBytes / (1024 * 1024));
  const ingestEnabled = options.ingestEnabled;
  const jobsEnabled = options.jobsEnabled;

  // Config the client script needs, passed as a JSON island rather than
  // interpolated into the script body, so nothing user-influenced lands in a
  // JS string context.
  const clientConfig = JSON.stringify({
    accept,
    formats,
    maxMib,
    maxUploadBytes: options.maxUploadBytes,
    ingestEnabled,
    jobsEnabled,
    defaultCollection: options.defaultCollection,
  });

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ATF Extract</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <div class="logo">📄</div>
    <h1>ATF Extract</h1>
    <span class="badge">operator console</span>
    <nav class="header-links">
      <a href="/openapi.json">OpenAPI</a>
      <a href="/health">Health</a>
      ${options.logoutPath !== null ? `<a href="${escapeHtml(options.logoutPath)}">Abmelden</a>` : ""}
    </nav>
  </header>

  <div class="card">
    <div class="tabs" role="tablist">
      <button class="tab-btn active" role="tab" data-tab="convert" aria-selected="true"><span class="tab-icon">⚙️</span> Konvertieren</button>
      ${
        ingestEnabled
          ? `<button class="tab-btn" role="tab" data-tab="ingest" aria-selected="false" aria-controls="panel-ingest" id="tab-ingest"><span class="tab-icon">📥</span> Indexieren</button>`
          : ""
      }
      ${
        jobsEnabled
          ? `<button class="tab-btn" role="tab" data-tab="newjob" aria-selected="false" aria-controls="panel-newjob" id="tab-newjob"><span class="tab-icon">🧩</span> Neuer Job</button>
      <button class="tab-btn" role="tab" data-tab="jobs" aria-selected="false" aria-controls="panel-jobs" id="tab-jobs"><span class="tab-icon">📋</span> Jobs</button>`
          : ""
      }
      <button class="tab-btn" role="tab" data-tab="health" aria-selected="false" aria-controls="panel-health" id="tab-health"><span class="tab-icon">🩺</span> Health</button>
    </div>

    <!-- ── Convert panel ────────────────────────────────────────────────── -->
    <div class="tab-panel active" id="panel-convert" role="tabpanel">
      <p class="panel-title">Dokument konvertieren</p>
      <p class="panel-desc">Dateien ablegen und nach Markdown konvertieren. Jede Seite erscheint live, sobald das Modell sie verarbeitet hat.</p>

      <div class="dropzone" id="convert-dropzone" tabindex="0" role="button" aria-label="Dateien hier ablegen oder klicken zum Auswählen">
        <div class="dropzone-icon">📂</div>
        <div class="dropzone-text"><strong>Dateien hier ablegen</strong> oder klicken zum Auswählen</div>
        <div class="dropzone-text" id="convert-formats-hint" style="margin-top:0.25rem;font-size:0.75rem"></div>
      </div>
      <input type="file" id="convert-file-input" multiple style="display:none" />

      <div class="section-label">Optionen</div>
      <div class="row" style="flex-wrap:wrap;gap:1.25rem;align-items:center;">
        <label class="checkbox-label"><input type="checkbox" id="convert-include-figures" /> Abbildungsdaten einbetten <span class="hint">(X-Include-Figure-Data — Base64-Crops)</span></label>
        <label class="checkbox-label"><input type="checkbox" id="convert-auto-start" checked /> Automatisch starten <span class="hint">(nach dem Ablegen)</span></label>
      </div>

      <div class="convert-queue" id="convert-queue"></div>

      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-top:1.25rem;">
        <button type="button" class="btn btn-primary" id="convert-start-btn" disabled>⚙️ Alle konvertieren</button>
        <button type="button" class="btn btn-secondary" id="convert-clear-btn">✕ Leeren</button>
        <span class="batch-progress" id="convert-progress"></span>
      </div>
    </div>

    ${ingestEnabled ? ingestPanelHtml(jobsEnabled) : ""}

    ${jobsEnabled ? NEWJOB_PANEL_HTML : ""}

    ${jobsEnabled ? JOBS_PANEL_HTML : ""}

    <!-- ── Health panel ─────────────────────────────────────────────────── -->
    <div class="tab-panel" id="panel-health" role="tabpanel">
      <p class="panel-title">Health</p>
      <p class="panel-desc">Pipeline-Einstellungen, Abhängigkeiten und Queue-Auslastung des Dienstes (GET /health).</p>
      <div style="display:flex;gap:0.75rem;align-items:center;margin-bottom:1.5rem;flex-wrap:wrap;">
        <button type="button" class="btn btn-secondary" id="health-refresh-btn">↺ Aktualisieren</button>
        <label class="checkbox-label"><input type="checkbox" id="health-deep" /> Tiefe Prüfung <span class="hint">(?deep=1)</span></label>
        <span id="health-status" style="font-size:0.78rem;color:#64748b;"></span>
      </div>
      <div id="health-output"><div class="coll-empty">Noch nicht geladen. Auf „Aktualisieren" klicken.</div></div>
    </div>

  </div><!-- /.card -->

  <script type="application/json" id="ui-config">${clientConfig}</script>
  <script>${JS}</script>
</body>
</html>`;
}

/**
 * The ingest panel. With the v2 job store (`v2`), `/ui/ingest` is the job
 * wrapper: it evaluates the identity headers (X-Version, X-Source-Modified,
 * X-Dedup) and answers a large document with 202 and a job id; X-Version-Mode
 * only applies on the synchronous v1 path, so the form says so.
 */
function ingestPanelHtml(v2: boolean): string {
  return `
    <!-- ── Ingest panel ─────────────────────────────────────────────────── -->
    <div class="tab-panel" id="panel-ingest" role="tabpanel">
      <p class="panel-title">Konvertieren und indexieren</p>
      <p class="panel-desc">Dateien konvertieren und direkt in eine Search-Collection schreiben. Der Dateiname (ohne Endung) wird zur Referenz, sofern nichts anderes angegeben ist.</p>

      <div class="dropzone" id="ingest-dropzone" tabindex="0" role="button" aria-label="Dateien hier ablegen oder klicken zum Auswählen">
        <div class="dropzone-icon">📂</div>
        <div class="dropzone-text"><strong>Dateien hier ablegen</strong> oder klicken zum Auswählen</div>
        <div class="dropzone-text" style="margin-top:0.25rem;font-size:0.75rem">${
          v2
            ? "Document Intelligence v2: kleine Dokumente werden synchron indexiert, große als Job angenommen (202) und hier bis zum Abschluss verfolgt."
            : "Konvertieren + Indexieren läuft synchron, ohne Zwischenmeldungen pro Seite."
        }</div>
      </div>
      <input type="file" id="ingest-file-input" multiple style="display:none" />

      <div class="section-label">Ziel</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="ingest-collection">Collection <span class="hint">(X-Collection)</span></label>
          <input type="text" id="ingest-collection" placeholder="documents" pattern="[A-Za-z][A-Za-z0-9_]*" title="Buchstabe am Anfang, danach nur Buchstaben, Ziffern und _" />
        </div>
        <div class="field field-narrow">
          <label for="ingest-reference">Referenz <span class="hint">(X-Reference — leer = Dateiname)</span></label>
          <input type="text" id="ingest-reference" placeholder="pro Datei aus dem Namen" />
        </div>
        <div class="field field-narrow">
          <label for="ingest-version-mode">Version Mode <span class="hint">(X-Version-Mode${v2 ? " — nur v1-Pfad" : ""})</span></label>
          <select id="ingest-version-mode">
            <option value="">server default</option>
            <option value="replace">replace</option>
            <option value="version">version</option>
          </select>
        </div>
        <div class="field field-narrow" id="ingest-version-field"${v2 ? "" : ' style="display:none"'}>
          <label for="ingest-version">Version <span class="hint">(X-Version${v2 ? " — überspringt die Erkennung" : ""})</span></label>
          <input type="text" id="ingest-version" placeholder="z. B. 1.0.0" />
        </div>
      </div>
${
  v2
    ? `
      <div class="section-label">Identität (v2)</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="ingest-dedup">Dedup <span class="hint">(X-Dedup)</span></label>
          <select id="ingest-dedup">
            <option value="">server default (auto)</option>
            <option value="auto">auto</option>
            <option value="exact">exact</option>
            <option value="off">off</option>
          </select>
        </div>
        <div class="field field-wide" style="display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:0.1rem">
          <label class="checkbox-label" style="font-size:0.82rem"><input type="checkbox" id="ingest-source-modified" checked /> Änderungsdatum der Datei senden <span class="hint">(X-Source-Modified — letzte Rückfallebene der Versionserkennung)</span></label>
        </div>
      </div>`
    : ""
}

      <div class="section-label">Dokument-Info</div>
      <div class="row">
        <div class="field field-wide">
          <label for="ingest-title">Titel <span class="hint">(X-Title)</span></label>
          <input type="text" id="ingest-title" placeholder="pro Datei aus dem Namen" />
        </div>
        <div class="field field-wide">
          <label for="ingest-source">Quelle <span class="hint">(X-Source)</span></label>
          <input type="text" id="ingest-source" placeholder="confluence / jira / …" />
        </div>
      </div>
      <div class="row">
        <div class="field field-wide">
          <label for="ingest-link">Link <span class="hint">(X-Link)</span></label>
          <input type="text" id="ingest-link" placeholder="https://…" />
        </div>
        <div class="field field-wide">
          <label for="ingest-tags">Tags <span class="hint">(X-Tags, kommagetrennt)</span></label>
          <input type="text" id="ingest-tags" placeholder="tag1, tag2" />
        </div>
      </div>
      <div class="row">
        <div class="field field-narrow">
          <label for="ingest-valid-from">Gültig ab <span class="hint">(X-Valid-From, RFC-3339)</span></label>
          <input type="text" id="ingest-valid-from" placeholder="2026-01-01T00:00:00Z" />
        </div>
        <div class="field field-narrow">
          <label for="ingest-fts-language">FTS Language <span class="hint">(X-FTS-Language)</span></label>
          <input type="text" id="ingest-fts-language" placeholder="simple" />
        </div>
      </div>

      <div class="section-label">Zugriffssteuerung</div>
      <div class="row">
        <div class="field">
          <label for="ingest-allowed-users">Allowed Users <span class="hint">(X-Allowed-Users, kommagetrennt)</span></label>
          <input type="text" id="ingest-allowed-users" placeholder="alice, bob" />
        </div>
        <div class="field">
          <label for="ingest-allowed-groups">Allowed Groups <span class="hint">(X-Allowed-Groups, kommagetrennt)</span></label>
          <input type="text" id="ingest-allowed-groups" placeholder="admins, editors" />
        </div>
      </div>

      <div class="section-label">Chunking</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="ingest-chunk-size">Chunk Size <span class="hint">(X-Chunk-Size)</span></label>
          <input type="number" id="ingest-chunk-size" placeholder="z. B. 512" min="1" />
        </div>
        <div class="field field-narrow">
          <label for="ingest-chunk-overlap">Chunk Overlap <span class="hint">(X-Chunk-Overlap)</span></label>
          <input type="number" id="ingest-chunk-overlap" placeholder="z. B. 64" min="0" />
        </div>
        <div class="field field-narrow" style="display:flex;flex-direction:column;justify-content:flex-end;gap:0.6rem;padding-bottom:0.1rem">
          <label class="checkbox-label" style="text-transform:none;letter-spacing:normal;font-size:0.82rem"><input type="checkbox" id="ingest-semantic-chunking" /> Semantic Chunking <span class="hint">(X-Semantic-Chunking)</span></label>
        </div>
      </div>
      <div class="row">
        <div class="field field-narrow">
          <label for="ingest-breakpoint-percentile">Breakpoint Percentile <span class="hint">(X-Breakpoint-Percentile, 1–99)</span></label>
          <input type="number" id="ingest-breakpoint-percentile" placeholder="z. B. 75" min="1" max="99" />
        </div>
        <div class="field field-narrow">
          <label for="ingest-late-chunking-alpha">Late Chunking Alpha <span class="hint">(X-Late-Chunking-Alpha, 0–1)</span></label>
          <input type="number" id="ingest-late-chunking-alpha" placeholder="z. B. 0.5" min="0" max="1" step="0.05" />
        </div>
        <div class="field field-narrow">
          <label for="ingest-context-prefix-size">Context Prefix Size <span class="hint">(X-Context-Prefix-Size, 0 = aus)</span></label>
          <input type="number" id="ingest-context-prefix-size" placeholder="z. B. 256" min="0" />
        </div>
        <div class="field field-narrow">
          <label for="ingest-chapter-split-max-chunks">Chapter Split Max Chunks <span class="hint">(X-Chapter-Split-Max-Chunks, 0 = aus)</span></label>
          <input type="number" id="ingest-chapter-split-max-chunks" placeholder="z. B. 25" min="0" />
        </div>
      </div>

      <div class="section-label">Struktur & Zusammenfassung</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="ingest-document-structure">Document Structure <span class="hint">(X-Document-Structure)</span></label>
          <select id="ingest-document-structure">
            <option value="">server default (auto)</option>
            <option value="auto">auto</option>
            <option value="off">off (Flachtext)</option>
          </select>
        </div>
        <div class="field field-narrow">
          <label for="ingest-summary-mode">Summary Mode <span class="hint">(X-Summary-Mode)</span></label>
          <select id="ingest-summary-mode">
            <option value="">auto (aus Dokument)</option>
            <option value="auto">auto</option>
            <option value="generate">generate</option>
            <option value="embedded">embedded</option>
            <option value="off">off</option>
          </select>
        </div>
        <div class="field field-narrow">
          <label for="ingest-quantization">Quantization <span class="hint">(X-Quantization, nur bei neuer Collection)</span></label>
          <select id="ingest-quantization">
            <option value="">server default</option>
            <option value="none">none</option>
            <option value="binary">binary</option>
          </select>
        </div>
        <div class="field field-narrow" style="display:flex;flex-direction:column;justify-content:flex-end;gap:0.6rem;padding-bottom:0.1rem">
          <label class="checkbox-label" style="text-transform:none;letter-spacing:normal;font-size:0.82rem"><input type="checkbox" id="ingest-summarize" /> Summarize <span class="hint">(X-Summarize — LLM-Summary als Prefix)</span></label>
        </div>
      </div>

      <div class="section-label">Metadaten</div>
      <div class="field">
        <label for="ingest-metadata">Metadata JSON <span class="hint">(X-Metadata, auf alle Dateien angewendet)</span></label>
        <textarea id="ingest-metadata" rows="3" placeholder='{"client": "acme"}'></textarea>
      </div>

      <div class="convert-queue" id="ingest-queue"></div>

      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-top:1.25rem;">
        <button type="button" class="btn btn-primary" id="ingest-start-btn" disabled>📥 Alle indexieren</button>
        <button type="button" class="btn btn-secondary" id="ingest-clear-btn">✕ Leeren</button>
        <span class="batch-progress" id="ingest-progress"></span>
      </div>
    </div>`;
}

const NEWJOB_PANEL_HTML = `
    <!-- ── New v2 job panel ─────────────────────────────────────────────── -->
    <div class="tab-panel" id="panel-newjob" role="tabpanel" aria-labelledby="tab-newjob">
      <p class="panel-title">Neuer Verarbeitungs-Job (Document Intelligence v2)</p>
      <p class="panel-desc">Quelle ablegen, per URL holen lassen oder über ihren sha256 wählen, dann einen Job mit allen Optionen anlegen (POST /v2/jobs). Dateien werden in prüfsummengesicherten Teilen hochgeladen und setzen nach einem Abbruch an der bestätigten Stelle fort.</p>

      <div class="dropzone" id="newjob-dropzone" tabindex="0" role="button" aria-label="Dateien hier ablegen oder klicken zum Auswählen">
        <div class="dropzone-icon">📂</div>
        <div class="dropzone-text"><strong>Dateien hier ablegen</strong> oder klicken zum Auswählen</div>
        <div class="dropzone-text" id="newjob-formats-hint" style="margin-top:0.25rem;font-size:0.75rem"></div>
      </div>
      <input type="file" id="newjob-file-input" multiple style="display:none" />

      <div class="row">
        <div class="field field-wide">
          <label for="newjob-source-url">Quell-URL <span class="hint">(source_url — serverseitig geladen, SSRF-Allowlist SOURCE_URL_ALLOWED_HOSTS)</span></label>
          <input type="text" id="newjob-source-url" placeholder="https://…/dokument.pdf" />
        </div>
        <div class="field" style="flex:0 0 auto"><button type="button" class="btn btn-secondary" id="newjob-add-url-btn">+ URL hinzufügen</button></div>
      </div>
      <div class="row">
        <div class="field field-wide">
          <label for="newjob-sha">Gespeicherte Quelle <span class="hint">(sourceSha256 — bereits im Source Store)</span></label>
          <input type="text" id="newjob-sha" placeholder="64 Hex-Zeichen" spellcheck="false" />
        </div>
        <div class="field field-narrow">
          <label for="newjob-sha-filename">Dateiname <span class="hint">(typisiert die Quelle)</span></label>
          <input type="text" id="newjob-sha-filename" placeholder="handbuch.pdf" />
        </div>
        <div class="field" style="flex:0 0 auto"><button type="button" class="btn btn-secondary" id="newjob-add-sha-btn">+ sha256 hinzufügen</button></div>
      </div>

      <div class="section-label">Ziel</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="newjob-collection">Collection</label>
          <input type="text" id="newjob-collection" placeholder="documents" pattern="[A-Za-z][A-Za-z0-9_]*" title="Buchstabe am Anfang, danach nur Buchstaben, Ziffern und _" />
        </div>
        <div class="field field-narrow">
          <label for="newjob-reference">Referenz <span class="hint">(leer = Dateiname)</span></label>
          <input type="text" id="newjob-reference" placeholder="pro Quelle aus dem Namen" />
        </div>
        <div class="field field-narrow">
          <label for="newjob-pages">Seiten <span class="hint">(pages, z. B. 1-10,15)</span></label>
          <input type="text" id="newjob-pages" placeholder="alle" />
        </div>
        <div class="field field-narrow">
          <label for="newjob-visibility">Sichtbarkeit <span class="hint">(visibility)</span></label>
          <select id="newjob-visibility">
            <option value="">server default</option>
            <option value="progressive">progressive — Segmente sofort suchbar</option>
            <option value="on_commit">on_commit — erst nach finalem Commit</option>
          </select>
        </div>
      </div>

      <div class="section-label">Identität</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="newjob-version">Version <span class="hint">(überspringt die Erkennung)</span></label>
          <input type="text" id="newjob-version" placeholder="z. B. Rev. C" />
        </div>
        <div class="field field-narrow">
          <label for="newjob-dedup">Dedup</label>
          <select id="newjob-dedup">
            <option value="">server default (auto)</option>
            <option value="auto">auto</option>
            <option value="exact">exact</option>
            <option value="off">off</option>
          </select>
        </div>
        <div class="field field-narrow">
          <label for="newjob-source-modified">Quelle geändert <span class="hint">(sourceModifiedAt, RFC 3339)</span></label>
          <input type="text" id="newjob-source-modified" placeholder="leer = Dateidatum" />
        </div>
        <div class="field field-narrow" style="display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:0.1rem">
          <label class="checkbox-label" style="font-size:0.82rem"><input type="checkbox" id="newjob-use-file-mtime" checked /> Dateidatum verwenden</label>
        </div>
      </div>

      <div class="section-label">Dokument-Info</div>
      <div class="row">
        <div class="field field-wide">
          <label for="newjob-title">Titel <span class="hint">(title)</span></label>
          <input type="text" id="newjob-title" placeholder="pro Quelle aus dem Namen" />
        </div>
        <div class="field field-wide">
          <label for="newjob-source-label">Quelle <span class="hint">(sourceLabel)</span></label>
          <input type="text" id="newjob-source-label" placeholder="confluence / jira / …" />
        </div>
      </div>
      <div class="row">
        <div class="field field-wide">
          <label for="newjob-link">Link <span class="hint">(link)</span></label>
          <input type="text" id="newjob-link" placeholder="https://…" />
        </div>
        <div class="field field-wide">
          <label for="newjob-tags">Tags <span class="hint">(kommagetrennt)</span></label>
          <input type="text" id="newjob-tags" placeholder="tag1, tag2" />
        </div>
      </div>
      <div class="field">
        <label for="newjob-metadata">Metadata JSON <span class="hint">(metadata, auf alle Quellen angewendet)</span></label>
        <textarea id="newjob-metadata" rows="3" placeholder='{"client": "acme"}'></textarea>
      </div>

      <div class="section-label">Zugriffssteuerung</div>
      <div class="row">
        <div class="field">
          <label for="newjob-allowed-users">Allowed Users <span class="hint">(kommagetrennt, auf die eigene Identität eingeschränkt)</span></label>
          <input type="text" id="newjob-allowed-users" placeholder="alice, bob" />
        </div>
        <div class="field">
          <label for="newjob-allowed-groups">Allowed Groups <span class="hint">(kommagetrennt)</span></label>
          <input type="text" id="newjob-allowed-groups" placeholder="admins, editors" />
        </div>
      </div>

      <div class="section-label">Ausführung</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="newjob-priority">Priorität <span class="hint">(priority)</span></label>
          <input type="number" id="newjob-priority" placeholder="0" step="1" />
        </div>
        <div class="field field-narrow">
          <label for="newjob-token-budget">Token-Budget <span class="hint">(tokenBudget, leer = unbegrenzt)</span></label>
          <input type="number" id="newjob-token-budget" placeholder="unbegrenzt" min="0" step="1" />
        </div>
        <div class="field field-narrow">
          <label for="newjob-resume-policy">Resume-Policy <span class="hint">(bei geändertem Pipeline-Stand)</span></label>
          <select id="newjob-resume-policy">
            <option value="">server default (pin)</option>
            <option value="pin">pin — pausieren und fragen</option>
            <option value="continue">continue — mit neuem Stand weiter</option>
            <option value="restart-stage">restart-stage — ab Stufe neu</option>
          </select>
        </div>
        <div class="field field-wide">
          <label for="newjob-callback-url">Callback-URL <span class="hint">(callbackUrl, CALLBACK_ALLOWED_HOSTS)</span></label>
          <input type="text" id="newjob-callback-url" placeholder="https://…/hook" />
        </div>
      </div>
      <div class="row" style="gap:1.25rem;align-items:center;">
        <label class="checkbox-label"><input type="checkbox" id="newjob-follow" checked /> Jobs verfolgen <span class="hint">(Fortschritt je Stufe bis zum Abschluss)</span></label>
        <label class="checkbox-label"><input type="checkbox" id="newjob-auto-start" /> Automatisch starten <span class="hint">(nach dem Ablegen)</span></label>
      </div>

      <div class="convert-queue" id="newjob-queue"></div>

      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-top:1.25rem;">
        <button type="button" class="btn btn-primary" id="newjob-start-btn" disabled>🧩 Jobs anlegen</button>
        <button type="button" class="btn btn-secondary" id="newjob-clear-btn">✕ Leeren</button>
        <span class="batch-progress" id="newjob-progress"></span>
      </div>
    </div>`;

const JOBS_PANEL_HTML = `
    <!-- ── Jobs panel (requirement 18.6) ────────────────────────────────── -->
    <div class="tab-panel" id="panel-jobs" role="tabpanel" aria-labelledby="tab-jobs">
      <p class="panel-title">Job-Übersicht</p>
      <p class="panel-desc">Laufende und abgeschlossene Verarbeitungs-Jobs (GET /v2/jobs). Zeile anklicken für Details je Stufe, Identität, Revision, Warnungen, Kosten, Restzeit und Seitenvorschau. Aktionen: Pause, Fortsetzen (auch mit Resume-Policy), Retry fehlgeschlagener Einheiten, Reparse, Abbruch.</p>

      <div style="display:flex;gap:0.75rem;align-items:center;margin-bottom:1.25rem;flex-wrap:wrap;">
        <button type="button" class="btn btn-secondary" id="jobs-refresh-btn">↺ Aktualisieren</button>
        <label class="checkbox-label"><input type="checkbox" id="jobs-auto-refresh" /> Automatisch aktualisieren <span class="hint">(alle 5 s)</span></label>
        <select id="jobs-filter-status" aria-label="Nach Status filtern" style="width:auto">
          <option value="">alle Status</option>
          <option value="active">aktiv</option>
          <option value="queued">in Warteschlange</option>
          <option value="paused">pausiert</option>
          <option value="completed">abgeschlossen</option>
          <option value="failed">fehlgeschlagen</option>
          <option value="cancelled">abgebrochen</option>
        </select>
        <input type="text" id="jobs-filter-text" aria-label="Nach Referenz oder Job-ID filtern" placeholder="Referenz / Job-ID filtern" style="width:auto;flex:1;min-width:180px" />
        <span id="jobs-status" style="font-size:0.78rem;color:#64748b;"></span>
      </div>

      <div class="visually-hidden" id="jobs-live" role="status" aria-live="polite"></div>

      <div id="jobs-output"><div class="coll-empty">Noch nicht geladen. Auf „Aktualisieren" klicken.</div></div>

      <div style="display:flex;gap:0.75rem;align-items:center;margin-top:1.25rem;flex-wrap:wrap;">
        <button type="button" class="btn btn-secondary" id="jobs-more-btn" style="display:none">Mehr laden</button>
      </div>
    </div>`;

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f1117; color: #e2e8f0; min-height: 100vh;
  display: flex; flex-direction: column; align-items: center;
  padding: 2.5rem 1rem 4rem;
}
a { color: #6366f1; text-decoration: none; }
a:hover { text-decoration: underline; color: #a78bfa; }
header { width: 100%; max-width: 1200px; margin-bottom: 2.5rem; display: flex; align-items: center; gap: 0.75rem; }
header .logo { width: 32px; height: 32px; background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 1rem; }
header h1 { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.02em; color: #f8fafc; }
header .badge { font-size: 0.7rem; font-weight: 500; padding: 0.2rem 0.6rem; border-radius: 999px; background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
header .header-links { margin-left: auto; display: flex; gap: 1.1rem; font-size: 0.82rem; }
.card { width: 100%; max-width: 1200px; background: #1a1f2e; border: 1px solid #2d3748; border-radius: 16px; overflow: hidden; }
.tabs { display: flex; border-bottom: 1px solid #2d3748; background: #141824; overflow-x: auto; scrollbar-width: none; }
.tab-btn { flex: 1; min-width: 90px; padding: 0.9rem 1rem; background: none; border: none; color: #64748b; font-size: 0.875rem; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 0.5rem; transition: color 0.15s, background 0.15s; position: relative; white-space: nowrap; }
.tab-btn:hover { color: #cbd5e1; background: #1a1f2e; }
.tab-btn.active { color: #a78bfa; background: #1a1f2e; }
.tab-btn.active::after { content: ''; position: absolute; bottom: -1px; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, #6366f1, #8b5cf6); border-radius: 2px 2px 0 0; }
.tab-icon { font-size: 1rem; }
.tab-panel { display: none; padding: 2rem; }
.tab-panel.active { display: block; }
.panel-title { font-size: 1rem; font-weight: 600; color: #f1f5f9; margin-bottom: 0.35rem; }
.panel-desc { font-size: 0.8rem; color: #64748b; margin-bottom: 1.75rem; }
.section-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #475569; margin: 1.5rem 0 1rem; padding-bottom: 0.4rem; border-bottom: 1px solid #2d3748; }
.field { margin-bottom: 1.25rem; }
label { display: block; font-size: 0.78rem; font-weight: 500; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.45rem; }
.hint { font-size: 0.7rem; color: #475569; text-transform: none; letter-spacing: normal; font-weight: 400; }
textarea, input[type="text"], input[type="number"], select {
  width: 100%; padding: 0.65rem 0.85rem; background: #0f1117; border: 1px solid #2d3748; border-radius: 8px; color: #e2e8f0;
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace; font-size: 0.82rem; line-height: 1.6;
  transition: border-color 0.15s, box-shadow 0.15s; resize: vertical;
}
select { resize: none; cursor: pointer; }
textarea:focus, input[type="text"]:focus, input[type="number"]:focus, select:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }
textarea::placeholder, input::placeholder { color: #475569; }
input[type="number"] { max-width: 160px; }
.row { display: flex; gap: 1rem; align-items: flex-end; flex-wrap: wrap; }
.row .field { flex: 1; min-width: 140px; }
.row .field-narrow { flex: 0 0 160px; }
.row .field-wide { flex: 2; min-width: 200px; }
.checkbox-label { display: flex; align-items: center; gap: 0.5rem; text-transform: none; letter-spacing: normal; cursor: pointer; font-size: 0.82rem; color: #94a3b8; }
.checkbox-label input[type="checkbox"] { width: auto; cursor: pointer; accent-color: #6366f1; }
.btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.6rem 1.4rem; border: none; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; transition: opacity 0.15s, transform 0.1s; }
.btn:active { transform: scale(0.97); }
.btn[disabled] { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; }
.btn-primary:hover:not([disabled]) { opacity: 0.9; }
.btn-secondary { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
.btn-secondary:hover:not([disabled]) { background: #263347; color: #cbd5e1; }

/* ── Drop zone ─────────────────────────────────────────────────────────────── */
.dropzone { border: 2px dashed #334155; border-radius: 12px; padding: 2.5rem 1.5rem; text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s; background: #0f1117; margin-bottom: 1.25rem; }
.dropzone:hover, .dropzone.drag-over { border-color: #6366f1; background: rgba(99,102,241,0.05); }
.dropzone-icon { font-size: 2rem; margin-bottom: 0.5rem; }
.dropzone-text { font-size: 0.85rem; color: #64748b; }
.dropzone-text strong { color: #94a3b8; }
.batch-progress { font-size: 0.8rem; color: #64748b; }

/* ── Convert / ingest queue ────────────────────────────────────────────────── */
.convert-queue { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1.25rem; }
.cq-item { border: 1px solid #2d3748; border-radius: 10px; overflow: hidden; background: #141824; }
.cq-header { display: flex; align-items: center; gap: 0.75rem; padding: 0.7rem 1rem; cursor: pointer; user-select: none; }
.cq-icon { font-size: 1rem; flex-shrink: 0; }
.cq-name { flex: 1; color: #e2e8f0; font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cq-size { color: #475569; font-size: 0.72rem; white-space: nowrap; }
.cq-status { font-size: 0.72rem; padding: 0.15rem 0.55rem; border-radius: 999px; white-space: nowrap; font-weight: 600; }
.cq-status.pending  { background: rgba(71,85,105,0.2);   color: #94a3b8; border: 1px solid #334155; }
.cq-status.queued   { background: rgba(245,158,11,0.1);  color: #fcd34d; border: 1px solid rgba(245,158,11,0.25); }
.cq-status.running  { background: rgba(99,102,241,0.12); color: #a78bfa; border: 1px solid rgba(99,102,241,0.3); }
.cq-status.ok       { background: rgba(16,185,129,0.1);  color: #6ee7b7; border: 1px solid rgba(16,185,129,0.25); }
.cq-status.err      { background: rgba(239,68,68,0.1);   color: #fca5a5; border: 1px solid rgba(239,68,68,0.25); }
.cq-remove { background: none; border: none; color: #475569; cursor: pointer; font-size: 1rem; padding: 0 0.2rem; line-height: 1; transition: color 0.15s; flex-shrink: 0; }
.cq-remove:hover { color: #ef4444; }
.cq-chevron { color: #475569; font-size: 0.72rem; flex-shrink: 0; transition: transform 0.2s; }
.cq-item.open .cq-chevron { transform: rotate(90deg); }
.cq-body { display: none; border-top: 1px solid #2d3748; }
.cq-item.open .cq-body { display: block; }

.cq-progress-wrap { padding: 0.85rem 1rem 0.5rem; }
.cq-progress-head { display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: #cbd5e1; margin-bottom: 0.5rem; gap: 0.75rem; flex-wrap: wrap; }
.cq-progress-msg { font-family: "JetBrains Mono","Fira Code",monospace; color: #94a3b8; font-size: 0.72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.cq-progress-msg.cq-err { color: #fca5a5; }
.cq-progress-track { height: 8px; background: #1e293b; border-radius: 999px; overflow: hidden; }
.cq-progress-bar { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg, #6366f1, #8b5cf6); transition: width 0.25s ease; }
.cq-progress-bar.cq-done { background: linear-gradient(90deg, #10b981, #059669); }
.cq-stats { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0 1rem 0.75rem; }
.cq-stat { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.68rem; padding: 0.15rem 0.5rem; border-radius: 999px; background: rgba(99,102,241,0.1); color: #a78bfa; border: 1px solid rgba(99,102,241,0.25); }
.cq-log { list-style: none; margin: 0; padding: 0 1rem 0.5rem; display: grid; gap: 0.3rem; font-size: 0.72rem; }
.cq-log li { padding-left: 0.75rem; border-left: 3px solid #2d3748; color: #94a3b8; font-family: "JetBrains Mono","Fira Code",monospace; line-height: 1.5; }
.cq-log li[data-kind="warn"]  { border-left-color: #f59e0b; color: #fcd34d; }
.cq-log li[data-kind="error"] { border-left-color: #ef4444; color: #fca5a5; }
.cq-output-bar { display: flex; gap: 0.6rem; align-items: center; padding: 0.5rem 1rem; border-top: 1px solid #2d3748; }
.cq-mini-btn { background: none; border: 1px solid #334155; color: #94a3b8; font-size: 0.72rem; cursor: pointer; padding: 0.25rem 0.7rem; border-radius: 6px; transition: color 0.15s, border-color 0.15s, background 0.15s; }
.cq-mini-btn:hover:not([disabled]) { color: #a78bfa; border-color: #6366f1; background: rgba(99,102,241,0.06); }
.cq-mini-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
.cq-output { margin: 0; padding: 0.85rem 1rem 1rem; background: #0f1117; font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.78rem; line-height: 1.65; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; max-height: 32rem; overflow: auto; }

/* ── Health ────────────────────────────────────────────────────────────────── */
.hz-banner { display: flex; align-items: center; gap: 0.6rem; padding: 0.85rem 1.1rem; border-radius: 10px; margin-bottom: 1.5rem; font-size: 0.85rem; font-weight: 600; }
.hz-banner.ok  { background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.25); color: #6ee7b7; }
.hz-banner.bad { background: rgba(239,68,68,0.08);  border: 1px solid rgba(239,68,68,0.25);  color: #fca5a5; }
.hz-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
.hz-section { background: #141824; border: 1px solid #2d3748; border-radius: 10px; padding: 1rem 1.25rem; }
.hz-section-title { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6366f1; margin-bottom: 0.85rem; }
.hz-kv { display: flex; justify-content: space-between; gap: 1rem; padding: 0.35rem 0; border-bottom: 1px solid #1e293b; font-size: 0.78rem; }
.hz-kv:last-child { border-bottom: none; }
.hz-k { color: #64748b; }
.hz-v { color: #cbd5e1; font-family: "JetBrains Mono","Fira Code",monospace; text-align: right; word-break: break-all; }
.hz-dep { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.68rem; padding: 0.1rem 0.5rem; border-radius: 999px; font-weight: 600; }
.hz-dep.up   { background: rgba(16,185,129,0.1); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.25); }
.hz-dep.down { background: rgba(239,68,68,0.1);  color: #fca5a5; border: 1px solid rgba(239,68,68,0.25); }
.hz-dep.na   { background: rgba(71,85,105,0.2);  color: #94a3b8; border: 1px solid #334155; }
.hz-dep-detail { display: inline-block; margin-left: 0.4rem; font-size: 0.66rem; color: #64748b; font-family: "JetBrains Mono","Fira Code",monospace; }
.hz-kv .hz-v { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.2rem; }
.hz-tags { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.hz-tag { display: inline-block; background: rgba(99,102,241,0.12); color: #a78bfa; border: 1px solid rgba(99,102,241,0.25); border-radius: 999px; padding: 0.1rem 0.5rem; font-size: 0.68rem; }
.coll-empty { padding: 2.5rem 1rem; text-align: center; color: #475569; font-size: 0.85rem; }
.coll-error { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25); border-radius: 10px; padding: 1rem 1.25rem; color: #fca5a5; font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.8rem; }
.coll-spinner { display: flex; align-items: center; justify-content: center; gap: 0.75rem; padding: 2.5rem 1rem; color: #64748b; font-size: 0.82rem; }
.coll-spinner::before { content: ''; width: 18px; height: 18px; border-radius: 50%; border: 2px solid #2d3748; border-top-color: #6366f1; animation: hzspin 0.7s linear infinite; flex-shrink: 0; }
@keyframes hzspin { to { transform: rotate(360deg); } }

/* ── Jobs overview (requirement 18.6) ──────────────────────────────────────── */
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.jobs-list { display: flex; flex-direction: column; gap: 0.6rem; }
.job-item { border: 1px solid #2d3748; border-radius: 10px; overflow: hidden; background: #141824; }
.job-head { display: grid; grid-template-columns: 1.4rem minmax(0,2fr) auto minmax(120px,1fr) auto auto; gap: 0.75rem; align-items: center; padding: 0.7rem 1rem; cursor: pointer; user-select: none; }
.job-chevron { color: #475569; font-size: 0.72rem; transition: transform 0.2s; }
.job-item.open .job-chevron { transform: rotate(90deg); }
.job-ref { color: #e2e8f0; font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.job-status { font-size: 0.72rem; padding: 0.15rem 0.55rem; border-radius: 999px; white-space: nowrap; font-weight: 600; justify-self: start; }
.job-status.queued    { background: rgba(245,158,11,0.1);  color: #fcd34d; border: 1px solid rgba(245,158,11,0.25); }
.job-status.preparing,
.job-status.processing,
.job-status.emitting,
.job-status.committing { background: rgba(99,102,241,0.12); color: #a78bfa; border: 1px solid rgba(99,102,241,0.3); }
.job-status.completed { background: rgba(16,185,129,0.1);  color: #6ee7b7; border: 1px solid rgba(16,185,129,0.25); }
.job-status.failed    { background: rgba(239,68,68,0.1);   color: #fca5a5; border: 1px solid rgba(239,68,68,0.25); }
.job-status.paused    { background: rgba(71,85,105,0.2);   color: #cbd5e1; border: 1px solid #334155; }
.job-status.cancelled { background: rgba(71,85,105,0.2);   color: #94a3b8; border: 1px solid #334155; }
.job-mini-progress { height: 8px; background: #1e293b; border-radius: 999px; overflow: hidden; min-width: 80px; }
.job-mini-bar { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg, #6366f1, #8b5cf6); }
.job-mini-bar.done { background: linear-gradient(90deg, #10b981, #059669); }
.job-cost { font-size: 0.72rem; color: #94a3b8; font-family: "JetBrains Mono","Fira Code",monospace; white-space: nowrap; text-align: right; }
.job-eta { font-size: 0.72rem; color: #64748b; white-space: nowrap; text-align: right; }
.job-body { display: none; border-top: 1px solid #2d3748; padding: 1rem; }
.job-item.open .job-body { display: block; }
.job-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
.job-action-btn { background: #1e293b; border: 1px solid #334155; color: #cbd5e1; font-size: 0.75rem; cursor: pointer; padding: 0.35rem 0.8rem; border-radius: 6px; transition: color 0.15s, border-color 0.15s, background 0.15s; }
.job-action-btn:hover:not([disabled]) { color: #a78bfa; border-color: #6366f1; background: rgba(99,102,241,0.06); }
.job-action-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
.job-action-btn.danger:hover:not([disabled]) { color: #fca5a5; border-color: #ef4444; background: rgba(239,68,68,0.06); }
.job-stages { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.6rem; margin-bottom: 1rem; }
.job-stage { background: #0f1117; border: 1px solid #2d3748; border-radius: 8px; padding: 0.6rem 0.75rem; }
.job-stage-name { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 0.4rem; }
.job-stage-track { height: 6px; background: #1e293b; border-radius: 999px; overflow: hidden; margin-bottom: 0.35rem; }
.job-stage-fill { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg, #6366f1, #8b5cf6); }
.job-stage-fill.failed { background: linear-gradient(90deg, #ef4444, #b91c1c); }
.job-stage-fill.done { background: linear-gradient(90deg, #10b981, #059669); }
.job-stage-count { font-size: 0.72rem; color: #cbd5e1; font-family: "JetBrains Mono","Fira Code",monospace; }
.job-stage-count .fail { color: #fca5a5; }
.job-detail-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1rem; }
.job-warnings { list-style: none; margin: 0 0 0.5rem; padding: 0; display: grid; gap: 0.3rem; }
.job-warnings li { padding-left: 0.75rem; border-left: 3px solid #f59e0b; color: #fcd34d; font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.72rem; line-height: 1.5; }

/* ── Document Intelligence v2 additions ────────────────────────────────────── */
.cq-stages { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.5rem; padding: 0 1rem 0.75rem; }
.cq-stages:empty { display: none; }
.cq-link { background: none; border: none; color: #6366f1; cursor: pointer; font-size: 0.72rem; padding: 0; text-decoration: underline; }
.cq-link:hover { color: #a78bfa; }
.job-info { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0 1.5rem; background: #0f1117; border: 1px solid #2d3748; border-radius: 8px; padding: 0.5rem 0.9rem; margin-bottom: 1rem; }
.job-info .hz-kv { border-bottom: 1px solid #1e293b; }
.job-info .hz-v { font-size: 0.74rem; }
.job-subtitle { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; margin: 0.25rem 0 0.6rem; }
.job-resume { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin: -0.4rem 0 1rem; padding: 0.6rem 0.75rem; border: 1px dashed #334155; border-radius: 8px; }
.job-resume select, .job-preview-controls input, .job-preview-controls select { width: auto; padding: 0.3rem 0.5rem; font-size: 0.75rem; }
.job-resume .hint, .job-preview-controls .hint { font-size: 0.7rem; }
.job-preview { margin-top: 1rem; }
.job-preview-controls { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.6rem; }
.job-preview-controls input[type="number"] { max-width: 90px; }
.job-preview-controls input[type="text"] { min-width: 170px; }
.job-preview-meta { font-size: 0.7rem; color: #64748b; font-family: "JetBrains Mono","Fira Code",monospace; margin-bottom: 0.5rem; }
.job-preview-img { display: block; max-width: 100%; max-height: 70vh; border: 1px solid #2d3748; border-radius: 6px; background: #fff; }
.mono-short { font-family: "JetBrains Mono","Fira Code",monospace; }
.cq-figures { padding: 0 1rem 0.9rem; }
.cq-figures:empty { display: none; }
.cq-figures-title { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; margin: 0.25rem 0 0.6rem; }
.cq-figures-hint { font-size: 0.72rem; color: #64748b; margin-bottom: 0.6rem; }
.cq-figure-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem; }
.cq-figure { background: #0f1117; border: 1px solid #2d3748; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
.cq-figure-img { display: block; width: 100%; height: 150px; object-fit: contain; background: #fff; cursor: zoom-in; }
.cq-figure-img.zoomed { height: auto; max-height: none; cursor: zoom-out; }
.cq-figure-noimg { height: 60px; display: flex; align-items: center; justify-content: center; color: #475569; font-size: 0.7rem; border-bottom: 1px solid #2d3748; }
.cq-figure-meta { padding: 0.5rem 0.6rem; display: flex; flex-direction: column; gap: 0.3rem; }
.cq-figure-id { font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.68rem; color: #a78bfa; display: flex; justify-content: space-between; gap: 0.5rem; align-items: center; }
.cq-figure-desc { font-size: 0.74rem; color: #cbd5e1; line-height: 1.45; }
`;

const JS = `
"use strict";
(function () {
  var CONFIG = {};
  try { CONFIG = JSON.parse(document.getElementById("ui-config").textContent); } catch (e) { CONFIG = {}; }

  var $ = function (id) { return document.getElementById(id); };
  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  function fileBaseName(name) { return name.replace(/\\.[^.]+$/, ""); }
  function safeFileName(name) { return name.replace(/[^A-Za-z0-9._-]+/g, "_"); }
  function hasNonAscii(str) { return /[^\\x00-\\x7F]/.test(str); }
  function asciiHeaderValue(value) {
    // Header values must be latin1-safe; base64-wrap anything else. The backend
    // decodes the "base64:" prefix (header-utils.ts).
    return hasNonAscii(value) ? "base64:" + btoa(unescape(encodeURIComponent(value))) : value;
  }

  function parseList(value) {
    return String(value || "").split(",").map(function (v) { return v.trim(); }).filter(function (v) { return v !== ""; });
  }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function readJson(response) { return response.json().catch(function () { return {}; }); }
  function errorText(data, response) {
    return (data && data.error) || ("HTTP " + response.status);
  }
  function fileModifiedIso(file) {
    return file && typeof file.lastModified === "number" && file.lastModified > 0 ? new Date(file.lastModified).toISOString() : "";
  }
  function fmtVersion(v) {
    if (!v) return "";
    if (typeof v !== "object") return String(v);
    var parts = [v.label, v.date].filter(function (x) { return x; });
    return parts.join(" · ") + (v.source ? " (" + v.source + ")" : "");
  }
  function fmtDuplicate(d) {
    if (!d) return "";
    var how = d.match || "sha256";
    if (how === "similar" && typeof d.similarity === "number") how += " " + Math.round(d.similarity * 100) + " %";
    return d.reference + (d.filename ? " [" + d.filename + "]" : "") + " — " + how;
  }
  function shortId(id) { return id ? String(id).slice(0, 8) : ""; }
  // Search's collection naming rule; a bad name would otherwise only fail
  // after the whole document went through the model.
  function assertCollectionName(value) {
    if (value && !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
      throw new Error("Ungültige Collection „" + value + "“: Buchstabe am Anfang, danach nur Buchstaben, Ziffern und _.");
    }
  }

  // Fill the format hints from config.
  var fmtLabel = "Unterstützt: " + CONFIG.formats + " · max " + CONFIG.maxMib + " MiB";
  var fmtHint = $("convert-formats-hint");
  if (fmtHint) fmtHint.textContent = fmtLabel;
  var newjobHint = $("newjob-formats-hint");
  if (newjobHint) newjobHint.textContent = fmtLabel + " · resumable Upload in Teilen";

  // ── v2 job helpers (shared by Indexieren, Neuer Job and Jobs) ────────────────
  // Everything goes through the cookie-authenticated BFF at /ui/jobs (the same
  // router as /v2/jobs), never a bearer token, with credentials: same-origin.
  var JOBS_PATH = "/ui/jobs";
  var PAGE_STAGES = ["analyzed", "vision1", "refined", "vision2", "tiled", "docpass", "emitted"];
  // The stages an operator may restart from (stageOrderIndex in snapshot.ts).
  var RESTART_STAGES = ["analyzed", "vision1", "crops", "vision2", "tiled", "emitted", "docpass"];
  var TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
  var JOB_STATUS_LABELS = {
    queued: "in Warteschlange", preparing: "wird vorbereitet", processing: "verarbeitet",
    emitting: "schreibt", committing: "schließt ab", completed: "abgeschlossen",
    failed: "fehlgeschlagen", paused: "pausiert", cancelled: "abgebrochen"
  };
  var PAUSE_REASON_LABELS = {
    budget: "Token-Budget erschöpft — Budget prüfen, dann fortsetzen",
    dependency: "Abhängigkeit nicht erreichbar (setzt automatisch fort) oder Pipeline-Stand geändert bei resume_policy=pin (Fortsetzen mit Policy)",
    manual: "manuell pausiert"
  };
  var JOB_POLL_MS = 2000;
  // How long a follow keeps polling through a dependency pause before handing
  // over to the Jobs tab (a pin pause also reads "dependency" and never ends
  // on its own).
  var JOB_PAUSE_FOLLOW_MS = 10 * 60 * 1000;

  function jobsFetch(path, opts) {
    var init = { credentials: "same-origin", headers: { accept: "application/json" } };
    if (opts) { for (var k in opts) init[k] = opts[k]; }
    return fetch(path, init);
  }
  function postJson(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  function statusLabel(status) { return JOB_STATUS_LABELS[status] || status; }
  function isTerminalStatus(status) { return TERMINAL_STATUSES.indexOf(status) >= 0; }

  function overallRatio(job) {
    // The mean done/total across the stages that report a total — the same
    // shape the detail view shows, collapsed to one bar for the list row.
    if (!job.progress) return job.status === "completed" ? 1 : 0;
    var ratios = [];
    PAGE_STAGES.forEach(function (s) {
      var p = job.progress[s];
      if (p && p.total > 0) ratios.push(Math.min(1, p.done / p.total));
    });
    if (!ratios.length) return job.status === "completed" ? 1 : 0;
    return ratios.reduce(function (a, b) { return a + b; }, 0) / ratios.length;
  }

  function fmtCost(job) {
    var parts = [];
    if (typeof job.costUsd === "number") parts.push("$" + job.costUsd.toFixed(4));
    if (typeof job.tokensUsed === "number") {
      parts.push(job.tokensUsed + (typeof job.tokenBudget === "number" ? "/" + job.tokenBudget : "") + " Tok");
    }
    return parts.join(" · ") || "—";
  }

  function fmtEta(job) {
    if (typeof job.etaSeconds !== "number") return "";
    if (job.etaSeconds <= 0) return "fertig";
    var s = job.etaSeconds;
    if (s < 60) return "~" + s + " s";
    if (s < 3600) return "~" + Math.round(s / 60) + " min";
    return "~" + (s / 3600).toFixed(1) + " h";
  }

  function renderStage(name, p) {
    var total = p ? p.total : 0;
    var done = p ? p.done : 0;
    var failed = p ? p.failed : 0;
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    var cls = failed > 0 ? "failed" : (total > 0 && done >= total ? "done" : "");
    return '<div class="job-stage">' +
      '<div class="job-stage-name">' + escapeHtml(name) + "</div>" +
      '<div class="job-stage-track" role="progressbar" aria-label="' + escapeHtml(name) + ' Fortschritt" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-valuetext="' + done + " von " + total + (failed ? ", " + failed + " fehlgeschlagen" : "") + '">' +
        '<span class="job-stage-fill ' + cls + '" style="width:' + pct + '%"></span>' +
      "</div>" +
      '<div class="job-stage-count">' + done + "/" + total + (failed ? ' <span class="fail">(' + failed + " Fehler)</span>" : "") + "</div>" +
    "</div>";
  }

  function jobStats(job) {
    var stats = [];
    if (typeof job.pageCount === "number") stats.push(job.pageCount + " Seiten");
    stats.push(fmtCost(job));
    if (job.version) stats.push("Version " + fmtVersion(job.version));
    if (job.revisionId) stats.push("Revision " + shortId(job.revisionId));
    if (job.resolvedReference) stats.push("→ " + job.resolvedReference);
    return stats;
  }

  // Follow a v2 job until it is terminal, mirroring its per-stage progress,
  // cost, ETA and warnings into a queue item. Returns the last job read, or
  // null when its status cannot be read (no read scope, job gone).
  async function trackJob(jobId, it, api) {
    var seenWarnings = 0;
    var failures = 0;
    var pausedSince = null;
    for (;;) {
      var res, job;
      try {
        res = await jobsFetch(JOBS_PATH + "/" + encodeURIComponent(jobId));
        job = await readJson(res);
      } catch (err) {
        failures += 1;
        if (failures > 5) { api.addLog(it, "Job-Status nicht erreichbar: " + (err && err.message ? err.message : err), "warn"); return null; }
        await sleep(JOB_POLL_MS * failures);
        continue;
      }
      if (!res.ok) { api.addLog(it, "Job-Status nicht lesbar: " + errorText(job, res), "warn"); return null; }
      failures = 0;

      var eta = fmtEta(job);
      api.setBar(it, overallRatio(job), job.status === "completed");
      api.setMsg(it, "Job " + statusLabel(job.status) + (job.pauseReason ? " (" + job.pauseReason + ")" : "") + (eta ? " · Restzeit " + eta : ""));
      api.setStages(it, PAGE_STAGES.map(function (s) { return renderStage(s, job.progress ? job.progress[s] : null); }).join(""));
      api.setStats(it, jobStats(job));
      var warnings = Array.isArray(job.warnings) ? job.warnings : [];
      if (warnings.length < seenWarnings) seenWarnings = 0;   // a retry reset them
      for (; seenWarnings < warnings.length; seenWarnings++) api.addLog(it, String(warnings[seenWarnings]), "warn");

      if (isTerminalStatus(job.status)) return job;
      if (job.status === "paused") {
        if (pausedSince === null) pausedSince = Date.now();
        // Only a dependency pause resumes on its own; anything else waits for
        // an operator, and so does a dependency pause that outlasts the window.
        if (job.pauseReason !== "dependency" || Date.now() - pausedSince > JOB_PAUSE_FOLLOW_MS) return job;
      } else {
        pausedSince = null;
      }
      await sleep(JOB_POLL_MS);
    }
  }

  // Set a queue item's final state from a followed job.
  function finishTrackedJob(it, api, job) {
    if (job === null) {
      api.setStatus(it, "queued", "im Hintergrund");
      api.setMsg(it, "Der Job läuft im Hintergrund weiter; Status im Jobs-Tab.");
      return;
    }
    if (job.status === "completed") {
      api.setBar(it, 1, true);
      if (job.duplicateOf) {
        api.setStatus(it, "ok", "Duplikat");
        api.setMsg(it, "Übersprungen — Duplikat von " + fmtDuplicate(job.duplicateOf));
      } else {
        api.setStatus(it, "ok", "abgeschlossen");
        api.setMsg(it, "Abgeschlossen" + (typeof job.pageCount === "number" ? ": " + job.pageCount + " Seite(n)" : "") + (job.revisionId ? ", Revision " + job.revisionId : "") + ".");
      }
    } else if (job.status === "paused") {
      api.setStatus(it, "queued", "pausiert");
      api.setMsg(it, "Pausiert: " + (PAUSE_REASON_LABELS[job.pauseReason] || job.pauseReason || "?") + ". Fortsetzen im Jobs-Tab.");
    } else {
      api.setBar(it, 1, false);
      api.setStatus(it, "err", statusLabel(job.status));
      api.setMsg(it, "Job " + statusLabel(job.status) + ".", true);
    }
  }

  // Open the Jobs tab filtered to one job, with its detail expanded.
  function showJobInJobsTab(jobId) {
    var tab = $("tab-jobs");
    if (!tab) return;
    var filter = $("jobs-filter-text");
    if (filter) filter.value = jobId;
    var statusFilter = $("jobs-filter-status");
    if (statusFilter) statusFilter.value = "";
    jobsExpanded[jobId] = true;
    tab.click();
  }

  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      var panel = $("panel-" + target);
      if (panel) panel.classList.add("active");
      if (target === "health") loadHealth();
      if (target === "jobs") loadJobs();
    });
  });

  // ── Generic SSE frame reader for a POST response ─────────────────────────────
  // EventSource cannot POST, so the stream is parsed by hand. Events are split
  // on a blank line, the SSE frame delimiter.
  async function readEvents(response, onEvent) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var boundary = buffer.indexOf("\\n\\n");
      while (boundary !== -1) {
        var frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        var event = "message";
        var dataLines = [];
        frame.split("\\n").forEach(function (line) {
          if (line.charAt(0) === ":") return;
          if (line.indexOf("event:") === 0) event = line.slice(6).trim();
          else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).trim());
        });
        if (dataLines.length > 0) {
          try { onEvent(event, JSON.parse(dataLines.join("\\n"))); } catch (e) { /* skip unreadable frame */ }
        }
        boundary = buffer.indexOf("\\n\\n");
      }
    }
  }

  // ── Queue: shared engine for the convert, ingest and new-job tabs ─────────────
  // Each entry is one source: a dropped file or, in the new-job tab, a source
  // URL or a stored sha256. The backend takes one source per request, so the
  // browser walks the queue sequentially: one in flight, the rest pending.
  function createQueue(opts) {
    var items = [];          // { kind, file, value, name, status, markdown, el, refs:{...} }
    var running = false;
    var seq = 0;

    var listEl = $(opts.queueId);
    var startBtn = $(opts.startBtnId);
    var clearBtn = $(opts.clearBtnId);
    var progressEl = $(opts.progressId);
    var dropzone = $(opts.dropzoneId);
    var fileInput = $(opts.fileInputId);

    function updateControls() {
      var anyPending = items.some(function (it) { return it.status === "pending"; });
      startBtn.disabled = running || !anyPending;
      clearBtn.disabled = running;
    }
    function updateProgress() {
      var total = items.length;
      var done = items.filter(function (it) { return it.status === "ok" || it.status === "err"; }).length;
      var errs = items.filter(function (it) { return it.status === "err"; }).length;
      progressEl.textContent = total ? (done + "/" + total + " fertig" + (errs ? " · " + errs + " Fehler" : "")) : "";
    }

    function setStatus(it, status, label) {
      it.status = status;
      if (it.refs.statusEl) {
        it.refs.statusEl.className = "cq-status " + status;
        it.refs.statusEl.textContent = label;
      }
      updateControls();
      updateProgress();
    }
    function setBar(it, ratio, done) {
      if (!it.refs.barEl) return;
      it.refs.barEl.style.width = Math.max(0, Math.min(1, ratio)) * 100 + "%";
      it.refs.barEl.classList.toggle("cq-done", !!done);
    }
    function setMsg(it, text, isErr) {
      if (!it.refs.msgEl) return;
      it.refs.msgEl.textContent = text;
      it.refs.msgEl.classList.toggle("cq-err", !!isErr);
    }
    function setStats(it, stats) {
      if (!it.refs.statsEl) return;
      it.refs.statsEl.innerHTML = stats.map(function (s) { return '<span class="cq-stat">' + escapeHtml(s) + "</span>"; }).join("");
    }
    function addLog(it, text, kind) {
      if (!it.refs.logEl) return;
      var li = document.createElement("li");
      li.textContent = text;               // model / stderr text: textContent only
      if (kind) li.dataset.kind = kind;
      it.refs.logEl.append(li);
    }
    function setStages(it, html) {
      if (it.refs.stagesEl) it.refs.stagesEl.innerHTML = html;   // built from escapeHtml'd values only
    }
    // The figures of a converted document: crop (when the server embedded it),
    // page, id and description. Model text goes in via textContent and the
    // crop only as a data: URL of an allowed image type, never as markup.
    function setFigures(it, figures, hasData) {
      var host = it.refs.figuresEl;
      if (!host) return;
      host.innerHTML = "";
      if (!figures.length) return;
      var title = document.createElement("div");
      title.className = "cq-figures-title";
      title.textContent = "Abbildungen (" + figures.length + ")";
      host.append(title);
      if (!hasData) {
        var hint = document.createElement("div");
        hint.className = "cq-figures-hint";
        hint.textContent = "Keine Bilddaten übertragen — für Vorschaubilder „Abbildungsdaten einbetten“ aktivieren und erneut konvertieren.";
        host.append(hint);
      }
      var grid = document.createElement("div");
      grid.className = "cq-figure-grid";
      figures.forEach(function (f) {
        var card = document.createElement("figure");
        card.className = "cq-figure";
        var mime = String(f.mimeType || "");
        var data = typeof f.dataBase64 === "string" ? f.dataBase64 : "";
        var url = /^image\\/(png|jpeg|webp)$/.test(mime) && /^[A-Za-z0-9+\\/=]+$/.test(data) ? "data:" + mime + ";base64," + data : "";
        if (url) {
          var img = document.createElement("img");
          img.className = "cq-figure-img";
          img.src = url;
          img.alt = f.description ? String(f.description).slice(0, 200) : "Abbildung " + f.id;
          img.title = "Klicken zum Vergrößern";
          img.addEventListener("click", function () { img.classList.toggle("zoomed"); });
          card.append(img);
        } else {
          var none = document.createElement("div");
          none.className = "cq-figure-noimg";
          none.textContent = "kein Bild";
          card.append(none);
        }
        var meta = document.createElement("figcaption");
        meta.className = "cq-figure-meta";
        var idRow = document.createElement("div");
        idRow.className = "cq-figure-id";
        var idText = document.createElement("span");
        idText.textContent = "Seite " + f.page + " · " + f.id;
        idRow.append(idText);
        if (url) {
          var dl = document.createElement("a");
          dl.className = "cq-link";
          dl.href = url;
          dl.download = safeFileName(fileBaseName(it.name) || "dokument") + "-" + safeFileName(String(f.id)) + (mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : ".png");
          dl.textContent = "Download";
          idRow.append(dl);
        }
        meta.append(idRow);
        var desc = document.createElement("div");
        desc.className = "cq-figure-desc";
        desc.textContent = f.description || "";
        meta.append(desc);
        card.append(meta);
        grid.append(card);
      });
      host.append(grid);
    }
    function setJobLink(it, jobId) {
      if (!it.refs.progressHeadEl || !CONFIG.jobsEnabled) return;
      var old = it.refs.progressHeadEl.querySelector(".cq-link");
      if (old) old.remove();
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cq-link";
      btn.textContent = "Job " + shortId(jobId) + " im Jobs-Tab";
      btn.title = jobId;
      btn.addEventListener("click", function () { showJobInJobsTab(jobId); });
      it.refs.progressHeadEl.append(btn);
    }
    function setOutput(it, text) {
      it.markdown = text;
      if (it.refs.outputEl) { it.refs.outputEl.textContent = text; it.refs.outputEl.scrollTop = it.refs.outputEl.scrollHeight; }
      var has = text && text.length > 0;
      if (it.refs.copyBtn) it.refs.copyBtn.disabled = !has;
      if (it.refs.downloadBtn) it.refs.downloadBtn.disabled = !has;
    }

    function render(it) {
      var el = document.createElement("div");
      el.className = "cq-item";
      var showOutput = opts.mode === "convert";
      var icon = it.kind === "url" ? "🔗" : it.kind === "sha" ? "#️⃣" : "📄";
      el.innerHTML =
        '<div class="cq-header">' +
          '<span class="cq-icon">' + icon + "</span>" +
          '<span class="cq-name" title="' + escapeHtml(it.title) + '">' + escapeHtml(it.name) + "</span>" +
          '<span class="cq-size">' + (it.file ? formatBytes(it.file.size) : it.kind === "url" ? "URL" : "sha256") + "</span>" +
          '<span class="cq-status pending">wartet</span>' +
          '<button type="button" class="cq-remove" aria-label="Entfernen">✕</button>' +
          '<span class="cq-chevron">▶</span>' +
        "</div>" +
        '<div class="cq-body">' +
          '<div class="cq-progress-wrap">' +
            '<div class="cq-progress-head"><span class="cq-progress-msg">Bereit.</span></div>' +
            '<div class="cq-progress-track"><div class="cq-progress-bar"></div></div>' +
          "</div>" +
          '<div class="cq-stats"></div>' +
          '<div class="cq-stages"></div>' +
          '<div class="cq-figures"></div>' +
          '<ul class="cq-log" aria-label="Meldungen"></ul>' +
          (showOutput
            ? '<div class="cq-output-bar">' +
                '<button type="button" class="cq-mini-btn cq-copy" disabled>Markdown kopieren</button>' +
                '<button type="button" class="cq-mini-btn cq-download" disabled>Herunterladen</button>' +
              "</div>" +
              '<pre class="cq-output" tabindex="0"></pre>'
            : "") +
        "</div>";

      it.el = el;
      it.refs = {
        statusEl: el.querySelector(".cq-status"),
        barEl: el.querySelector(".cq-progress-bar"),
        msgEl: el.querySelector(".cq-progress-msg"),
        progressHeadEl: el.querySelector(".cq-progress-head"),
        statsEl: el.querySelector(".cq-stats"),
        stagesEl: el.querySelector(".cq-stages"),
        figuresEl: el.querySelector(".cq-figures"),
        logEl: el.querySelector(".cq-log"),
        outputEl: el.querySelector(".cq-output"),
        copyBtn: el.querySelector(".cq-copy"),
        downloadBtn: el.querySelector(".cq-download"),
      };

      var header = el.querySelector(".cq-header");
      header.addEventListener("click", function (ev) {
        if (ev.target.classList.contains("cq-remove")) return;
        el.classList.toggle("open");
      });
      el.querySelector(".cq-remove").addEventListener("click", function () {
        if (running && it.status === "running") return;   // don't yank the in-flight file
        var idx = items.indexOf(it);
        if (idx >= 0) { items.splice(idx, 1); el.remove(); updateControls(); updateProgress(); }
      });
      if (it.refs.copyBtn) it.refs.copyBtn.addEventListener("click", function () {
        navigator.clipboard.writeText(it.markdown || "").then(
          function () { addLog(it, "In die Zwischenablage kopiert."); },
          function () { addLog(it, "Kopieren nicht möglich; Text bitte manuell markieren.", "warn"); }
        );
      });
      if (it.refs.downloadBtn) it.refs.downloadBtn.addEventListener("click", function () {
        var blob = new Blob([it.markdown || ""], { type: "text/markdown;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = safeFileName(fileBaseName(it.name) || "dokument") + ".md";
        a.click();
        URL.revokeObjectURL(url);
      });

      listEl.append(el);
    }

    function addEntry(entry) {
      var key = entry.kind + "|" + entry.key;
      if (items.some(function (it) { return it.dedupKey === key; })) return;
      var it = {
        kind: entry.kind, file: entry.file || null, value: entry.value || "", filename: entry.filename || "",
        name: entry.name, title: entry.title || entry.name, dedupKey: key,
        status: "pending", markdown: "", el: null, refs: {}
      };
      items.push(it);
      render(it);
    }
    function afterAdd() {
      updateControls();
      updateProgress();
      var auto = opts.autoStartId ? $(opts.autoStartId) : null;
      if (auto && auto.checked && !running) runAll();
    }
    function addFiles(fileList) {
      Array.prototype.forEach.call(fileList, function (f) {
        addEntry({ kind: "file", file: f, key: f.name + "|" + f.size, name: f.name });
      });
      afterAdd();
    }
    function addSource(entry) {
      addEntry(entry);
      afterAdd();
    }

    async function runAll() {
      if (running) return;
      running = true;
      updateControls();
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.status !== "pending") continue;
        it.el.classList.add("open");
        try {
          await opts.processOne(it, { setStatus: setStatus, setBar: setBar, setMsg: setMsg, setStats: setStats, setStages: setStages, setJobLink: setJobLink, setFigures: setFigures, addLog: addLog, setOutput: setOutput });
        } catch (err) {
          setStatus(it, "err", "Fehler");
          setMsg(it, String(err && err.message ? err.message : err), true);
          setBar(it, 1, false);
        }
      }
      running = false;
      updateControls();
    }

    // Wire drop zone + file input.
    dropzone.addEventListener("click", function () { fileInput.click(); });
    dropzone.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
    fileInput.addEventListener("change", function () { addFiles(fileInput.files); fileInput.value = ""; });
    dropzone.addEventListener("dragover", function (e) { e.preventDefault(); dropzone.classList.add("drag-over"); });
    dropzone.addEventListener("dragleave", function () { dropzone.classList.remove("drag-over"); });
    dropzone.addEventListener("drop", function (e) { e.preventDefault(); dropzone.classList.remove("drag-over"); if (e.dataTransfer) addFiles(e.dataTransfer.files); });

    startBtn.addEventListener("click", runAll);
    clearBtn.addEventListener("click", function () {
      if (running) return;
      items.length = 0;
      listEl.innerHTML = "";
      updateControls();
      updateProgress();
    });

    return { addFiles: addFiles, addSource: addSource };
  }

  // ── Convert tab ──────────────────────────────────────────────────────────────
  createQueue({
    mode: "convert",
    queueId: "convert-queue",
    startBtnId: "convert-start-btn",
    clearBtnId: "convert-clear-btn",
    progressId: "convert-progress",
    dropzoneId: "convert-dropzone",
    fileInputId: "convert-file-input",
    autoStartId: "convert-auto-start",
    processOne: async function (it, api) {
      api.setStatus(it, "running", "läuft");
      api.setMsg(it, "Wird übertragen …");
      api.setBar(it, 0.02, false);

      var body = new FormData();
      body.append("document", it.file);
      var headers = { accept: "text/event-stream", "x-reference": asciiHeaderValue(it.file.name) };
      if ($("convert-include-figures") && $("convert-include-figures").checked) headers["x-include-figure-data"] = "1";

      var response = await fetch("/ui/convert", { method: "POST", headers: headers, body: body, credentials: "same-origin" });
      if (!response.ok || !response.body) {
        var detail = await response.text().catch(function () { return ""; });
        throw new Error("HTTP " + response.status + (detail ? ": " + detail.slice(0, 300) : ""));
      }

      var markdown = "";
      var pageCount = 0;
      var totalTokens = 0;
      var finished = false;

      await readEvents(response, function (event, data) {
        if (event === "accepted") {
          api.setMsg(it, "Angenommen — " + (data.filename || it.file.name));
        } else if (event === "queued") {
          api.setStatus(it, "queued", "in Warteschlange");
          api.setMsg(it, "In Warteschlange: Position " + data.position + (data.total ? " von " + data.total : ""));
        } else if (event === "converting") {
          api.setStatus(it, "running", "läuft");
          if (data.pageCount) pageCount = data.pageCount;
          api.setMsg(it, "Konvertierung gestartet" + (pageCount ? " · " + pageCount + " Seite(n)" : "") + (data.extractionMs ? " · Extraktion " + data.extractionMs + " ms" : ""));
          api.setBar(it, pageCount ? 0.05 : 0.1, false);
        } else if (event === "progress") {
          if (data.pageCount) pageCount = data.pageCount;
          markdown += (markdown === "" ? "" : "\\n\\n---\\n\\n") + (data.markdown || "");
          api.setOutput(it, markdown);
          if (data.tokens && typeof data.tokens.total === "number") totalTokens = data.tokens.total;
          var ratio = pageCount ? data.page / pageCount : 0.5;
          api.setBar(it, ratio, false);
          var msg = "Seite " + data.page + (pageCount ? " von " + pageCount : "") + " fertig";
          if (typeof data.etaSeconds === "number") msg += " · ETA " + Math.round(data.etaSeconds) + " s";
          api.setMsg(it, msg);
          var stats = [];
          stats.push("Seite " + data.page + (pageCount ? "/" + pageCount : ""));
          if (totalTokens) stats.push(totalTokens + " Tokens");
          var figs = (data.figures || []).length;
          if (figs) stats.push(figs + " Abb.");
          if (typeof data.elapsedMs === "number") stats.push((data.elapsedMs / 1000).toFixed(1) + " s");
          api.setStats(it, stats);
          (data.warnings || []).forEach(function (w) { api.addLog(it, "Seite " + data.page + ": " + w, "warn"); });
        } else if (event === "heartbeat") {
          if (!finished) api.setMsg(it, "… läuft (" + (data.phase || "") + (data.page ? ", Seite " + data.page : "") + ", " + Math.round((data.elapsedMs || 0) / 1000) + " s)");
        } else if (event === "done") {
          finished = true;
          if (typeof data.markdown === "string") { markdown = data.markdown; api.setOutput(it, markdown); }
          var pc = data.pageCount || pageCount || 1;
          var figCount = (data.pages || []).reduce(function (sum, p) { return sum + ((p.figures || []).length); }, 0);
          var allFigures = (data.pages || []).reduce(function (acc, p) { return acc.concat(p.figures || []); }, []);
          api.setFigures(it, allFigures, allFigures.some(function (f) { return typeof f.dataBase64 === "string"; }));
          api.setBar(it, 1, true);
          api.setStatus(it, "ok", "fertig");
          api.setMsg(it, pc + " Seite(n), " + figCount + " Abbildung(en) konvertiert.");
          var stats = [pc + " Seiten"];
          if (figCount) stats.push(figCount + " Abbildungen");
          if (data.usage && data.usage.tokens && typeof data.usage.tokens.total === "number") stats.push(data.usage.tokens.total + " Tokens");
          else if (totalTokens) stats.push(totalTokens + " Tokens");
          if (data.timings && typeof data.timings.totalMs === "number") stats.push((data.timings.totalMs / 1000).toFixed(1) + " s");
          api.setStats(it, stats);
          (data.warnings || []).forEach(function (w) { api.addLog(it, w, "warn"); });
        } else if (event === "error") {
          finished = true;
          api.setBar(it, 1, false);
          api.setStatus(it, "err", "Fehler");
          api.setMsg(it, data.error || "Konvertierung fehlgeschlagen.", true);
          api.addLog(it, (data.code || "ERROR") + ": " + (data.detail || data.error || "") + (data.errorId ? " (errorId " + data.errorId + ")" : ""), "error");
        }
      });

      if (!finished) {
        // Stream ended without a terminal event — treat as done if we got output.
        if (markdown) { api.setBar(it, 1, true); api.setStatus(it, "ok", "fertig"); api.setMsg(it, "Fertig."); }
        else throw new Error("Der Stream endete ohne Ergebnis.");
      }
    },
  });

  // ── Ingest tab ─────────────────────────────────────────────────────────────
  if (CONFIG.ingestEnabled) {
    // Version field visibility. On the v2 path X-Version is evaluated on its
    // own (it skips version detection), so the field stays visible there.
    var versionMode = $("ingest-version-mode");
    var versionField = $("ingest-version-field");
    if (versionMode && versionField && !CONFIG.jobsEnabled) {
      var toggleVersion = function () { versionField.style.display = versionMode.value === "version" ? "" : "none"; };
      versionMode.addEventListener("change", toggleVersion);
      toggleVersion();
    }

    function collectIngestHeaders(defaultReference, defaultTitle, file) {
      var headers = { accept: "application/json" };
      var ref = ($("ingest-reference").value.trim()) || defaultReference;
      headers["x-reference"] = asciiHeaderValue(ref);
      var set = function (name, id) { var v = $(id).value.trim(); if (v) headers[name] = asciiHeaderValue(v); };
      assertCollectionName($("ingest-collection").value.trim());
      set("x-collection", "ingest-collection");
      var title = $("ingest-title").value.trim() || defaultTitle;
      if (title) headers["x-title"] = asciiHeaderValue(title);
      set("x-source", "ingest-source");
      set("x-link", "ingest-link");
      set("x-tags", "ingest-tags");
      set("x-valid-from", "ingest-valid-from");
      set("x-fts-language", "ingest-fts-language");
      set("x-allowed-users", "ingest-allowed-users");
      set("x-allowed-groups", "ingest-allowed-groups");
      set("x-chunk-size", "ingest-chunk-size");
      set("x-chunk-overlap", "ingest-chunk-overlap");
      set("x-breakpoint-percentile", "ingest-breakpoint-percentile");
      set("x-late-chunking-alpha", "ingest-late-chunking-alpha");
      set("x-context-prefix-size", "ingest-context-prefix-size");
      set("x-chapter-split-max-chunks", "ingest-chapter-split-max-chunks");
      set("x-document-structure", "ingest-document-structure");
      set("x-summary-mode", "ingest-summary-mode");
      set("x-quantization", "ingest-quantization");
      var vm = $("ingest-version-mode").value.trim();
      if (vm) headers["x-version-mode"] = vm;
      if (vm === "version" || CONFIG.jobsEnabled) set("x-version", "ingest-version");
      // v2 identity inputs: duplicate handling and the file's modification
      // time, the last fallback of version detection.
      if ($("ingest-dedup")) set("x-dedup", "ingest-dedup");
      var sendModified = $("ingest-source-modified");
      if (sendModified && sendModified.checked) {
        var modified = fileModifiedIso(file);
        if (modified) headers["x-source-modified"] = modified;
      }
      if ($("ingest-semantic-chunking").checked) headers["x-semantic-chunking"] = "1";
      if ($("ingest-summarize").checked) headers["x-summarize"] = "1";
      var meta = $("ingest-metadata").value.trim();
      if (meta) headers["x-metadata"] = asciiHeaderValue(meta);
      return headers;
    }

    createQueue({
      mode: "ingest",
      queueId: "ingest-queue",
      startBtnId: "ingest-start-btn",
      clearBtnId: "ingest-clear-btn",
      progressId: "ingest-progress",
      dropzoneId: "ingest-dropzone",
      fileInputId: "ingest-file-input",
      processOne: async function (it, api) {
        api.setStatus(it, "running", "läuft");
        api.setMsg(it, "Konvertierung und Indexierung laufen … (keine Zwischenmeldungen)");
        api.setBar(it, 0.15, false);

        var body = new FormData();
        body.append("document", it.file);
        var headers = collectIngestHeaders(fileBaseName(it.file.name), fileBaseName(it.file.name), it.file);

        var response = await fetch("/ui/ingest", { method: "POST", headers: headers, body: body, credentials: "same-origin" });
        var data = await readJson(response);
        if (data.job_id) {
          api.setJobLink(it, data.job_id);
          api.addLog(it, "v2-Job " + data.job_id);
        }

        // v2: a document above the sync page limit (or one still running when
        // the sync budget ran out) is answered 202 with a job to follow.
        if (response.status === 202) {
          api.setStatus(it, "running", "Job läuft");
          api.setMsg(it, "Als Job angenommen" + (data.page_count ? " (" + data.page_count + " Seiten)" : "") + " — wird verfolgt …");
          if (!data.job_id) { api.setStatus(it, "queued", "angenommen"); return; }
          var job = await trackJob(data.job_id, it, api);
          finishTrackedJob(it, api, job);
          return;
        }

        if (!response.ok) {
          api.setBar(it, 1, false);
          api.setStatus(it, "err", "Fehler");
          api.setMsg(it, data.error || ("Indexierung fehlgeschlagen (HTTP " + response.status + ")"), true);
          if (data.code) api.addLog(it, data.code + (data.errorId ? " — errorId " + data.errorId : ""), "error");
          (data.warnings || []).forEach(function (w) { api.addLog(it, w, "warn"); });
          return;
        }

        var stats = [];
        if (data.status === "skipped") {
          // v2 dedup: an identical or near-identical source is already indexed.
          api.setBar(it, 1, true);
          api.setStatus(it, "ok", "Duplikat");
          api.setMsg(it, "Übersprungen — Duplikat von " + (fmtDuplicate(data.duplicate_of) || "einem indexierten Dokument") + ".");
        } else {
          api.setBar(it, 1, true);
          api.setStatus(it, "ok", "indexiert");
          api.setMsg(it,
            data.page_count + " Seite(n) in Collection " + data.collection + " indexiert" +
            (data.assets_stored != null ? ", " + data.assets_stored + " Abbildung(en) gespeichert" +
            (data.assets_failed ? ", " + data.assets_failed + " fehlgeschlagen" : "") : "") + ".");
          if (data.page_count != null) stats.push(data.page_count + " Seiten");
          if (data.figure_count != null) stats.push(data.figure_count + " Abbildungen");
          if (data.assets_stored != null) stats.push(data.assets_stored + " gespeichert");
          if (data.assets_failed) stats.push(data.assets_failed + " fehlgeschlagen");
        }
        if (data.version) stats.push("Version " + fmtVersion(data.version));
        if (data.revision_id) stats.push("Revision " + shortId(data.revision_id));
        if (data.resolved_reference) {
          stats.push("→ " + data.resolved_reference);
          if (data.status !== "skipped") api.addLog(it, "Als neue Version von „" + data.resolved_reference + "“ indexiert (angefragt: " + data.reference + ").");
        }
        api.setStats(it, stats);
        (data.warnings || []).forEach(function (w) { api.addLog(it, w, "warn"); });
      },
    });
  }

  // ── New job tab (Document Intelligence v2) ─────────────────────────────────
  // Source → store → job: a file is uploaded as a resumable session through
  // /ui/uploads (the cookie twin of /v2/uploads), a URL is pulled server-side,
  // a sha256 names a source already stored; then POST /ui/jobs creates the job
  // with every option of the v2 job request and the queue item follows it.
  if (CONFIG.jobsEnabled) {
    var UPLOADS_PATH = "/ui/uploads";
    var UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
    var UPLOAD_MAX_ATTEMPTS = 6;

    async function sha256Hex(blob) {
      // SubtleCrypto exists only in a secure context (https or localhost);
      // without it the chunk is sent unchecked and the whole-file digest the
      // server computes at complete time still addresses the source.
      if (!window.crypto || !window.crypto.subtle) return "";
      var digest = await window.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return Array.prototype.map.call(new Uint8Array(digest), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    }

    async function confirmedOffset(uploadId) {
      var res = await fetch(UPLOADS_PATH + "/" + encodeURIComponent(uploadId), { method: "HEAD", credentials: "same-origin" });
      if (!res.ok) throw new Error("Upload-Sitzung nicht lesbar (HTTP " + res.status + ")");
      var offset = Number(res.headers.get("upload-offset"));
      if (!Number.isInteger(offset) || offset < 0) throw new Error("Upload-Sitzung meldet keinen gültigen Offset");
      return offset;
    }

    // Upload one file in chunks. Every chunk states the offset it continues
    // from and carries its own sha256; after a failed or refused chunk the
    // session's confirmed offset is read back (HEAD) and the upload continues
    // from there, so an interrupted transfer never restarts from zero.
    async function uploadResumable(file, reference, it, api) {
      var openRes = await postJson(UPLOADS_PATH, { reference: reference, size: file.size });
      var session = await readJson(openRes);
      if (!openRes.ok) throw new Error("Upload-Sitzung konnte nicht geöffnet werden: " + errorText(session, openRes));
      var uploadId = session.upload_id;
      api.addLog(it, "Upload-Sitzung " + uploadId + " geöffnet.");

      var offset = 0;
      var attempts = 0;
      var started = Date.now();
      while (offset < file.size) {
        var end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
        var chunk = file.slice(offset, end);
        var headers = { "content-type": "application/offset+octet-stream", "upload-offset": String(offset) };
        var digest = await sha256Hex(chunk);
        if (digest) headers["x-chunk-checksum-sha256"] = digest;
        var res = null;
        var failure = "";
        try {
          res = await fetch(UPLOADS_PATH + "/" + encodeURIComponent(uploadId), { method: "PATCH", headers: headers, body: chunk, credentials: "same-origin" });
        } catch (err) {
          failure = "Netzwerkfehler: " + (err && err.message ? err.message : err);
        }
        if (res !== null && res.status === 204) {
          var next = Number(res.headers.get("upload-offset"));
          offset = Number.isInteger(next) && next > offset ? next : end;
          attempts = 0;
          var secs = Math.max(0.001, (Date.now() - started) / 1000);
          api.setBar(it, file.size ? offset / file.size : 1, false);
          api.setMsg(it, "Upload " + formatBytes(offset) + " / " + formatBytes(file.size) + " · " + formatBytes(offset / secs) + "/s");
          continue;
        }
        if (res !== null) {
          var body = await readJson(res);
          // Authorisation, a vanished session or an oversized source will not
          // get better by retrying.
          if ([401, 403, 404, 413].indexOf(res.status) >= 0) throw new Error("Upload abgelehnt: " + errorText(body, res));
          failure = errorText(body, res);
        }
        attempts += 1;
        if (attempts >= UPLOAD_MAX_ATTEMPTS) throw new Error("Upload nach " + attempts + " Versuchen abgebrochen: " + failure);
        var retryAfter = res !== null ? Number(res.headers.get("retry-after")) : NaN;
        var waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 500 * Math.pow(2, attempts));
        api.addLog(it, "Teil ab Byte " + offset + " fehlgeschlagen (" + failure + "); neuer Versuch in " + Math.round(waitMs / 1000) + " s.", "warn");
        await sleep(waitMs);
        offset = await confirmedOffset(uploadId);
      }

      var doneRes = await postJson(UPLOADS_PATH + "/" + encodeURIComponent(uploadId) + "/complete", {});
      var stored = await readJson(doneRes);
      if (!doneRes.ok) throw new Error("Upload konnte nicht abgeschlossen werden: " + errorText(stored, doneRes));
      api.setBar(it, 1, false);
      return stored;
    }

    async function pullSourceUrl(url, reference, it, api) {
      api.setMsg(it, "Quelle wird vom Server geladen …");
      var res = await postJson(UPLOADS_PATH, { reference: reference, source_url: url });
      var data = await readJson(res);
      if (!res.ok) throw new Error("source_url abgelehnt: " + errorText(data, res));
      return data;
    }

    function urlFilename(raw) {
      try {
        var last = new URL(raw).pathname.split("/").filter(function (x) { return x; }).pop();
        return last ? decodeURIComponent(last) : "";
      } catch (e) { return ""; }
    }

    function readMetadataField() {
      var raw = $("newjob-metadata").value.trim();
      if (!raw) return undefined;
      var parsed;
      try { parsed = JSON.parse(raw); } catch (e) { throw new Error("Metadata ist kein gültiges JSON: " + e.message); }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Metadata muss ein JSON-Objekt sein.");
      return parsed;
    }

    function readIntField(id, label) {
      var raw = $(id).value.trim();
      if (raw === "") return undefined;
      var n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(label + " muss eine ganze Zahl sein.");
      return n;
    }

    // The POST /v2/jobs body (jobRequestSchema); empty fields are left out so
    // the server defaults apply.
    function buildJobRequest(reference, sha, filename, file, metadata) {
      var body = { reference: reference, sourceSha256: sha };
      var str = function (key, id) { var v = $(id).value.trim(); if (v) body[key] = v; };
      if (filename) body.filename = filename;
      assertCollectionName($("newjob-collection").value.trim());
      str("collection", "newjob-collection");
      str("pages", "newjob-pages");
      str("visibility", "newjob-visibility");
      str("resumePolicy", "newjob-resume-policy");
      str("callbackUrl", "newjob-callback-url");
      str("version", "newjob-version");
      str("dedup", "newjob-dedup");
      str("link", "newjob-link");
      str("sourceLabel", "newjob-source-label");
      var title = $("newjob-title").value.trim() || (filename ? fileBaseName(filename) : "");
      if (title) body.title = title;
      var priority = readIntField("newjob-priority", "Priorität");
      if (priority !== undefined) body.priority = priority;
      var budget = readIntField("newjob-token-budget", "Token-Budget");
      if (budget !== undefined) {
        if (budget < 0) throw new Error("Token-Budget darf nicht negativ sein.");
        body.tokenBudget = budget;
      }
      var modified = $("newjob-source-modified").value.trim() || ($("newjob-use-file-mtime").checked ? fileModifiedIso(file) : "");
      if (modified) body.sourceModifiedAt = modified;
      var tags = parseList($("newjob-tags").value);
      if (tags.length) body.tags = tags;
      var users = parseList($("newjob-allowed-users").value);
      if (users.length) body.allowedUsers = users;
      var groups = parseList($("newjob-allowed-groups").value);
      if (groups.length) body.allowedGroups = groups;
      if (metadata !== undefined) body.metadata = metadata;
      return body;
    }

    var newjobQueue = createQueue({
      mode: "newjob",
      queueId: "newjob-queue",
      startBtnId: "newjob-start-btn",
      clearBtnId: "newjob-clear-btn",
      progressId: "newjob-progress",
      dropzoneId: "newjob-dropzone",
      fileInputId: "newjob-file-input",
      autoStartId: "newjob-auto-start",
      processOne: async function (it, api) {
        api.setStatus(it, "running", "läuft");
        // Validate the form before a single byte moves.
        var metadata = readMetadataField();
        var sourceName = it.kind === "file" ? it.file.name : it.kind === "url" ? urlFilename(it.value) : (it.filename || "");
        var reference = $("newjob-reference").value.trim() || sourceName || it.value;
        var filename = sourceName;
        buildJobRequest(reference, "0".repeat(64), filename, it.file, metadata);   // validate the form early

        var sha;
        if (it.kind === "file") {
          api.setMsg(it, "Upload wird vorbereitet …");
          var stored = await uploadResumable(it.file, reference, it, api);
          sha = stored.sha256;
          api.addLog(it, "Quelle gespeichert: sha256 " + sha + (stored.deduped ? " (war bereits vorhanden)" : ""));
        } else if (it.kind === "url") {
          var pulled = await pullSourceUrl(it.value, reference, it, api);
          sha = pulled.sha256;
          // The server names the pull from the final URL or its Content-Type,
          // which types the job when the URL itself has no extension.
          if (!filename && pulled.filename) filename = pulled.filename;
          if (pulled.content_type) api.addLog(it, "Content-Type: " + pulled.content_type + (pulled.filename ? " → " + pulled.filename : ""));
          api.addLog(it, "Quelle geladen: " + formatBytes(pulled.size || 0) + ", sha256 " + sha + (pulled.deduped ? " (war bereits vorhanden)" : ""));
        } else {
          sha = it.value;
        }
        var request = buildJobRequest(reference, sha, filename, it.file, metadata);

        api.setMsg(it, "Job wird angelegt …");
        var res = await postJson(JOBS_PATH, request);
        var job = await readJson(res);
        if (!res.ok) throw new Error("Job konnte nicht angelegt werden: " + errorText(job, res));
        api.addLog(it, "Job " + job.jobId + " angelegt (" + statusLabel(job.status) + ").");
        api.setJobLink(it, job.jobId);

        if (!$("newjob-follow").checked) {
          api.setBar(it, 1, true);
          api.setStatus(it, "ok", "angelegt");
          api.setMsg(it, "Job angelegt; Fortschritt im Jobs-Tab.");
          return;
        }
        api.setStatus(it, "running", "Job läuft");
        api.setBar(it, 0, false);
        var finalJob = await trackJob(job.jobId, it, api);
        finishTrackedJob(it, api, finalJob);
      },
    });

    var addUrlBtn = $("newjob-add-url-btn");
    var urlInput = $("newjob-source-url");
    var addUrl = function () {
      var url = urlInput.value.trim();
      if (!url) return;
      if (!/^https?:\\/\\//i.test(url)) { urlInput.setCustomValidity("Nur http(s)-URLs"); urlInput.reportValidity(); return; }
      urlInput.setCustomValidity("");
      newjobQueue.addSource({ kind: "url", value: url, key: url, name: urlFilename(url) || url, title: url });
      urlInput.value = "";
    };
    addUrlBtn.addEventListener("click", addUrl);
    urlInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addUrl(); } });

    var addShaBtn = $("newjob-add-sha-btn");
    var shaInput = $("newjob-sha");
    var shaFilename = $("newjob-sha-filename");
    var addSha = function () {
      var sha = shaInput.value.trim().toLowerCase().replace(/^sha-?256[:=]/, "");
      if (!/^[0-9a-f]{64}$/.test(sha)) { shaInput.setCustomValidity("sha256 muss aus 64 Hex-Zeichen bestehen"); shaInput.reportValidity(); return; }
      shaInput.setCustomValidity("");
      var fname = shaFilename.value.trim();
      newjobQueue.addSource({ kind: "sha", value: sha, filename: fname, key: sha + "|" + fname, name: fname || sha.slice(0, 16) + "…", title: sha });
      shaInput.value = "";
      shaFilename.value = "";
    };
    addShaBtn.addEventListener("click", addSha);
    shaInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addSha(); } });
  }

  // ── Health tab ───────────────────────────────────────────────────────────────
  var healthLoading = false;
  async function loadHealth() {
    if (healthLoading) return;
    healthLoading = true;
    var out = $("health-output");
    var statusEl = $("health-status");
    out.innerHTML = '<div class="coll-spinner">Lade Health …</div>';
    statusEl.textContent = "";
    var deep = $("health-deep") && $("health-deep").checked;
    try {
      var response = await fetch("/health" + (deep ? "?deep=1" : ""), { credentials: "same-origin", headers: { accept: "application/json" } });
      var data = await response.json();
      renderHealth(data, response.status);
      statusEl.textContent = "HTTP " + response.status + " · " + new Date().toLocaleTimeString();
    } catch (err) {
      out.innerHTML = '<div class="coll-error">Netzwerkfehler: ' + escapeHtml(err.message) + "</div>";
    } finally {
      healthLoading = false;
    }
  }

  function depBadge(value) {
    // The backend reports each dependency as a DependencyState object
    // { available: boolean, version?, error? }. Older/other shapes (plain
    // boolean or string) are handled too, defensively.
    if (value == null) return '<span class="hz-dep na">— n/a</span>';
    var available, version, error;
    if (typeof value === "object") {
      available = value.available;
      version = value.version;
      error = value.error;
    } else if (value === true || value === "ok" || value === "up") {
      available = true;
    } else if (value === false || value === "down" || value === "error") {
      available = false;
    } else {
      return '<span class="hz-dep na">' + escapeHtml(String(value)) + "</span>";
    }
    var cls = available ? "up" : "down";
    var label = available ? "● erreichbar" : "✗ nicht erreichbar";
    var suffix = "";
    if (version) suffix = ' <span class="hz-dep-detail">' + escapeHtml(String(version)) + "</span>";
    else if (error) suffix = ' <span class="hz-dep-detail" title="' + escapeHtml(String(error)) + '">' + escapeHtml(String(error)) + "</span>";
    return '<span class="hz-dep ' + cls + '">' + label + "</span>" + suffix;
  }
  function kv(k, v) {
    return '<div class="hz-kv"><span class="hz-k">' + escapeHtml(k) + '</span><span class="hz-v">' + escapeHtml(v == null ? "—" : String(v)) + "</span></div>";
  }

  function renderHealth(data, httpStatus) {
    var out = $("health-output");
    var ok = data.status === "ok" && httpStatus < 400;
    var html = '<div class="hz-banner ' + (ok ? "ok" : "bad") + '">' + (ok ? "✓ Dienst gesund" : "✗ Dienst nicht gesund") +
      " · Status: " + escapeHtml(String(data.status || httpStatus)) + "</div>";

    html += '<div class="hz-grid">';

    // Overview.
    var overview = "";
    overview += kv("Contract", data.contract);
    if (data.uptime_seconds != null) overview += kv("Uptime", Math.round(data.uptime_seconds) + " s");
    if (data.status) overview += kv("Status", data.status);
    html += '<div class="hz-section"><div class="hz-section-title">Übersicht</div>' + overview + "</div>";

    // Document Intelligence v2: what this deployment has switched on.
    var v2 = "";
    v2 += kv("Job-Store", CONFIG.jobsEnabled ? "aktiv" : "aus (EXTRACT_DATABASE_URL fehlt)");
    v2 += kv("Ingest-Pfad", !CONFIG.ingestEnabled ? "deaktiviert" : CONFIG.jobsEnabled ? "v2-Job-Wrapper" : "v1 synchron");
    v2 += kv("Resumable Uploads", CONFIG.jobsEnabled ? "/v2/uploads" : "—");
    v2 += kv("On-demand Render", "/v2/render" + (CONFIG.jobsEnabled ? " · Vorschau im Jobs-Tab" : ""));
    html += '<div class="hz-section"><div class="hz-section-title">Document Intelligence v2</div>' + v2 + "</div>";

    // Queue.
    if (data.queue) {
      var q = data.queue;
      html += '<div class="hz-section"><div class="hz-section-title">Queue</div>' +
        kv("Tiefe", q.depth) + kv("Aktiv", q.active) + kv("Parallelität", q.concurrency) + kv("Max. Tiefe", q.maxDepth) + "</div>";
    }

    // Pipeline.
    if (data.pipeline) {
      var p = data.pipeline;
      html += '<div class="hz-section"><div class="hz-section-title">Pipeline</div>' +
        kv("Vision-Modell", p.vision_model) + kv("Render DPI", p.render_dpi) + kv("Figure DPI", p.figure_dpi) + kv("Max. Seiten", p.max_pages) + "</div>";
    }

    // Dependencies.
    if (data.dependencies) {
      var d = data.dependencies;
      var depsHtml = "";
      if (d.poppler) {
        depsHtml += '<div class="hz-kv"><span class="hz-k">poppler · pdfinfo</span><span class="hz-v">' + depBadge(d.poppler.pdfinfo) + "</span></div>";
        depsHtml += '<div class="hz-kv"><span class="hz-k">poppler · pdftotext</span><span class="hz-v">' + depBadge(d.poppler.pdftotext) + "</span></div>";
        depsHtml += '<div class="hz-kv"><span class="hz-k">poppler · pdftoppm</span><span class="hz-v">' + depBadge(d.poppler.pdftoppm) + "</span></div>";
      }
      if (d.bbox_layout) {
        // The -bbox-layout capability of the deterministic page analysis (S2):
        // reported, not gating — without it pages fall through to vision.
        var bb = d.bbox_layout;
        depsHtml += '<div class="hz-kv"><span class="hz-k">pdftotext -bbox-layout (S2)</span><span class="hz-v">' +
          depBadge({ available: !!bb.supported, version: bb.version, error: bb.reason }) + "</span></div>";
      }
      depsHtml += '<div class="hz-kv"><span class="hz-k">libreoffice</span><span class="hz-v">' + depBadge(d.libreoffice) + "</span></div>";
      depsHtml += '<div class="hz-kv"><span class="hz-k">vision</span><span class="hz-v">' + depBadge(d.vision) + "</span></div>";
      depsHtml += '<div class="hz-kv"><span class="hz-k">search</span><span class="hz-v">' + depBadge(d.search) + "</span></div>";
      html += '<div class="hz-section"><div class="hz-section-title">Abhängigkeiten</div>' + depsHtml + "</div>";
    }

    // Supported types.
    if (Array.isArray(data.supported_types) && data.supported_types.length) {
      html += '<div class="hz-section" style="grid-column:1/-1"><div class="hz-section-title">Unterstützte Typen</div><div class="hz-tags">' +
        data.supported_types.map(function (t) { return '<span class="hz-tag">' + escapeHtml(t) + "</span>"; }).join("") + "</div></div>";
    }

    // Degraded formats.
    if (Array.isArray(data.degraded_formats) && data.degraded_formats.length) {
      html += '<div class="hz-section" style="grid-column:1/-1"><div class="hz-section-title" style="color:#f59e0b">Eingeschränkte Formate</div><div class="hz-tags">' +
        data.degraded_formats.map(function (t) { return '<span class="hz-tag" style="background:rgba(245,158,11,0.12);color:#fcd34d;border-color:rgba(245,158,11,0.25)">' + escapeHtml(t) + "</span>"; }).join("") + "</div></div>";
    }

    html += "</div>";
    out.innerHTML = html;
  }

  var healthBtn = $("health-refresh-btn");
  if (healthBtn) healthBtn.addEventListener("click", loadHealth);
  var healthDeep = $("health-deep");
  if (healthDeep) healthDeep.addEventListener("change", loadHealth);

  // ── Jobs tab (requirement 18.6) ──────────────────────────────────────────────
  // The overview list + per-job detail with per-stage progress, identity,
  // warnings, cost and remaining time, the operator actions and the page
  // preview. The shared job helpers live above, next to the queue engine.
  var jobsLimit = 25;
  var jobsOffset = 0;
  var jobsLoading = false;
  var jobsAutoTimer = null;
  var jobsExpanded = {};   // jobId -> true when its detail is open
  var jobsPreviews = {};   // jobId -> its page-preview element
  var jobsFigures = {};    // jobId -> its figure-gallery element

  function jobsLive(msg) {
    var el = $("jobs-live");
    if (el) el.textContent = msg;
  }

  // Mirror the state machine (resolveAction): which actions are legal now.
  function canPause(status) { return ["queued", "preparing", "processing", "emitting", "committing"].indexOf(status) >= 0; }
  function canResume(status) { return status === "paused"; }
  function canRetry(status) { return ["completed", "failed", "paused"].indexOf(status) >= 0; }
  function canCancel(status) { return ["completed", "failed", "cancelled"].indexOf(status) < 0; }

  function renderJobRow(job) {
    var el = document.createElement("div");
    el.className = "job-item" + (jobsExpanded[job.jobId] ? " open" : "");
    el.dataset.jobId = job.jobId;
    el.dataset.status = job.status;
    el.dataset.search = (job.reference + " " + (job.resolvedReference || "") + " " + job.jobId).toLowerCase();
    var ratio = overallRatio(job);
    var barDone = job.status === "completed";
    var statusText = statusLabel(job.status) + (job.pauseReason ? " (" + job.pauseReason + ")" : "");
    var pages = typeof job.pageCount === "number" ? job.pageCount + " S." : "—";
    var pct = Math.round(ratio * 100);

    el.innerHTML =
      '<div class="job-head" role="button" tabindex="0" aria-expanded="' + (jobsExpanded[job.jobId] ? "true" : "false") + '" aria-label="Job ' + escapeHtml(job.reference) + ', Status ' + escapeHtml(statusText) + '">' +
        '<span class="job-chevron" aria-hidden="true">▶</span>' +
        '<span class="job-ref" title="' + escapeHtml(job.reference) + '">' + escapeHtml(job.reference) + "</span>" +
        '<span class="job-status ' + escapeHtml(job.status) + '">' + escapeHtml(statusText) + "</span>" +
        '<span class="job-mini-progress" role="progressbar" aria-label="Fortschritt gesamt" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-valuetext="' + pct + ' Prozent, ' + escapeHtml(pages) + '">' +
          '<span class="job-mini-bar' + (barDone ? " done" : "") + '" style="width:' + pct + '%"></span>' +
        "</span>" +
        '<span class="job-cost">' + escapeHtml(fmtCost(job)) + "</span>" +
        '<span class="job-eta">' + escapeHtml(fmtEta(job)) + "</span>" +
      "</div>" +
      '<div class="job-body" id="job-body-' + escapeHtml(job.jobId) + '"></div>';

    var head = el.querySelector(".job-head");
    var toggle = function () {
      var open = el.classList.toggle("open");
      head.setAttribute("aria-expanded", open ? "true" : "false");
      jobsExpanded[job.jobId] = open;
      if (open) loadJobDetail(job.jobId, el.querySelector(".job-body"));
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });

    if (jobsExpanded[job.jobId]) loadJobDetail(job.jobId, el.querySelector(".job-body"));
    return el;
  }

  function renderJobActions(job, bodyEl) {
    var defs = [
      { action: "pause", label: "⏸ Pause", enabled: canPause(job.status), cls: "", title: "Job anhalten, Zustand bleibt erhalten" },
      { action: "resume", label: "▶ Fortsetzen", enabled: canResume(job.status), cls: "", title: "Pausierten Job wieder einreihen" },
      { action: "retry-failed", label: "↻ Retry", enabled: canRetry(job.status), cls: "", title: "Nur fehlgeschlagene Einheiten neu berechnen" },
      { action: "reparse", label: "⟳ Reparse", enabled: canRetry(job.status), cls: "", title: "Parser auf gespeicherte Modellantworten neu anwenden — ohne neue Modellaufrufe" },
      { action: "cancel", label: "✕ Abbruch", enabled: canCancel(job.status), cls: "danger", title: "Job verwerfen" }
    ];
    var wrap = document.createElement("div");
    wrap.className = "job-actions";
    defs.forEach(function (d) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "job-action-btn" + (d.cls ? " " + d.cls : "");
      btn.textContent = d.label;
      btn.setAttribute("aria-label", d.label.replace(/^[^ ]+ /, "") + " für Job " + job.reference);
      btn.title = d.title;
      btn.disabled = !d.enabled;
      btn.addEventListener("click", function () { runJobAction(job.jobId, d.action, wrap, bodyEl); });
      wrap.append(btn);
    });
    return wrap;
  }

  // Resume a paused job with an explicit resume policy — the answer to a pin
  // pause (the pipeline/prompt stand changed): continue under the new stand,
  // or restart from a stage for all pages.
  function renderResumeControl(job, bodyEl) {
    var wrap = document.createElement("div");
    wrap.className = "job-resume";
    wrap.innerHTML =
      '<span class="hint">Fortsetzen mit Resume-Policy:</span>' +
      '<select class="rs-policy" aria-label="Resume-Policy">' +
        '<option value="continue">continue — neuen Pipeline-Stand übernehmen</option>' +
        '<option value="restart-stage">restart-stage — ab Stufe neu berechnen</option>' +
        '<option value="pin">pin — nur bei unverändertem Stand</option>' +
      "</select>" +
      '<select class="rs-stage" aria-label="Neustart ab Stufe" style="display:none">' +
        RESTART_STAGES.map(function (st) { return '<option value="' + escapeHtml(st) + '">ab ' + escapeHtml(st) + "</option>"; }).join("") +
      "</select>" +
      '<button type="button" class="job-action-btn rs-go">▶ Fortsetzen</button>';
    var policy = wrap.querySelector(".rs-policy");
    var stage = wrap.querySelector(".rs-stage");
    policy.addEventListener("change", function () { stage.style.display = policy.value === "restart-stage" ? "" : "none"; });
    wrap.querySelector(".rs-go").addEventListener("click", function () {
      var payload = { resumePolicy: policy.value };
      if (policy.value === "restart-stage") payload.restartStage = stage.value;
      runJobAction(job.jobId, "resume", wrap, bodyEl, payload);
    });
    return wrap;
  }

  async function runJobAction(jobId, action, wrap, bodyEl, payload) {
    Array.prototype.forEach.call(wrap.querySelectorAll("button"), function (b) { b.disabled = true; });
    jobsLive("Aktion „" + action + "“ wird ausgeführt …");
    try {
      var res = await postJson(JOBS_PATH + "/" + encodeURIComponent(jobId) + "/" + action, payload || {});
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        jobsLive("Aktion fehlgeschlagen: " + (data.error || ("HTTP " + res.status)));
      } else {
        jobsLive("Aktion „" + action + "“ erfolgreich. Neuer Status: " + statusLabel(data.status || "?") +
          (typeof data.retriedUnits === "number" ? " · " + data.retriedUnits + " Einheit(en) zurückgesetzt" : "") + ".");
      }
    } catch (err) {
      jobsLive("Netzwerkfehler bei Aktion: " + (err && err.message ? err.message : err));
    }
    // Refresh the affected row's detail (and the row's status pill) from source.
    await loadJobDetail(jobId, bodyEl, true);
  }

  async function loadJobDetail(jobId, bodyEl, isRefresh) {
    if (!bodyEl) return;
    if (!isRefresh) bodyEl.innerHTML = '<div class="coll-spinner">Lade Details …</div>';
    try {
      var res = await jobsFetch(JOBS_PATH + "/" + encodeURIComponent(jobId));
      var job = await res.json();
      if (!res.ok) { bodyEl.innerHTML = '<div class="coll-error">' + escapeHtml(job.error || ("HTTP " + res.status)) + "</div>"; return; }

      // Keep the row's status pill in sync after an action.
      var item = bodyEl.closest(".job-item");
      if (item) {
        var pill = item.querySelector(".job-status");
        if (pill) {
          pill.className = "job-status " + job.status;
          pill.textContent = statusLabel(job.status) + (job.pauseReason ? " (" + job.pauseReason + ")" : "");
        }
        item.dataset.status = job.status;
      }

      bodyEl.innerHTML = "";
      bodyEl.append(renderJobActions(job, bodyEl));
      if (job.status === "paused") bodyEl.append(renderResumeControl(job, bodyEl));
      bodyEl.append(renderJobInfo(job));

      // Per-stage progress.
      var stagesWrap = document.createElement("div");
      stagesWrap.className = "job-stages";
      stagesWrap.innerHTML = PAGE_STAGES.map(function (s) {
        return renderStage(s, job.progress ? job.progress[s] : null);
      }).join("");
      bodyEl.append(stagesWrap);

      // Cost + ETA chips.
      var chips = [];
      chips.push("Kosten: " + fmtCost(job));
      if (typeof job.etaSeconds === "number") chips.push("Restzeit: " + (fmtEta(job) || "—"));
      if (typeof job.pageCount === "number") chips.push(job.pageCount + " Seite(n)");
      var grid = document.createElement("div");
      grid.className = "job-detail-grid";
      grid.innerHTML = chips.map(function (c) { return '<span class="cq-stat">' + escapeHtml(c) + "</span>"; }).join("");
      bodyEl.append(grid);

      // Warnings.
      if (Array.isArray(job.warnings) && job.warnings.length) {
        var ul = document.createElement("ul");
        ul.className = "job-warnings";
        ul.setAttribute("aria-label", "Warnungen");
        job.warnings.forEach(function (w) {
          var li = document.createElement("li");
          li.textContent = String(w);
          ul.append(li);
        });
        bodyEl.append(ul);
      }

      // One preview per job, kept across refreshes (auto-refresh rebuilds the
      // rows every few seconds) so a rendered page does not vanish.
      if (job.sourceSha256) {
        if (!jobsPreviews[job.jobId]) jobsPreviews[job.jobId] = renderPreview(job);
        bodyEl.append(jobsPreviews[job.jobId]);
        if (!jobsFigures[job.jobId]) jobsFigures[job.jobId] = renderJobFigures(job);
        bodyEl.append(jobsFigures[job.jobId]);
      }
    } catch (err) {
      bodyEl.innerHTML = '<div class="coll-error">Netzwerkfehler: ' + escapeHtml(err && err.message ? err.message : String(err)) + "</div>";
    }
  }

  function renderJobInfo(job) {
    var rows = [];
    rows.push(kv("Job-ID", job.jobId));
    rows.push(kv("Referenz", job.reference));
    if (job.resolvedReference) rows.push(kv("Indexiert als", job.resolvedReference));
    if (job.collection) rows.push(kv("Collection", job.collection));
    if (job.version) rows.push(kv("Version", fmtVersion(job.version)));
    if (job.duplicateOf) rows.push(kv("Duplikat von", fmtDuplicate(job.duplicateOf)));
    rows.push(kv("Revision", job.revisionId || "—"));
    if (job.sourceFilename) rows.push(kv("Dateiname", job.sourceFilename));
    if (job.sourceSha256) rows.push(kv("Quelle (sha256)", job.sourceSha256));
    if (job.visibility) rows.push(kv("Sichtbarkeit", job.visibility));
    if (typeof job.priority === "number") rows.push(kv("Priorität", job.priority));
    if (job.resumePolicy) rows.push(kv("Resume-Policy", job.resumePolicy));
    if (job.pauseReason) rows.push(kv("Pausegrund", PAUSE_REASON_LABELS[job.pauseReason] || job.pauseReason));
    if (job.createdAt) rows.push(kv("Angelegt", new Date(job.createdAt).toLocaleString()));
    if (job.updatedAt) rows.push(kv("Aktualisiert", new Date(job.updatedAt).toLocaleString()));
    var el = document.createElement("div");
    el.className = "job-info";
    el.innerHTML = rows.join("");   // kv() escapes every key and value
    return el;
  }

  // On-demand page render (POST /ui/render → the /v2/render handler): the page
  // image, or a normalised bbox crop of it, straight from the stored source.
  function renderPreview(job) {
    var wrap = document.createElement("div");
    wrap.className = "job-preview";
    var maxPage = typeof job.pageCount === "number" && job.pageCount > 0 ? ' max="' + job.pageCount + '"' : "";
    wrap.innerHTML =
      '<div class="job-subtitle">Seitenvorschau</div>' +
      '<div class="job-preview-controls">' +
        '<label class="checkbox-label">Seite <input type="number" class="pv-page" min="1"' + maxPage + ' value="1" /></label>' +
        '<select class="pv-size" aria-label="Zielgröße">' +
          '<option value="1400">1400 px</option><option value="2400">2400 px</option><option value="4000">4000 px</option><option value="">Server-DPI</option>' +
        "</select>" +
        '<input type="text" class="pv-bbox" aria-label="Ausschnitt" placeholder="Ausschnitt x0,y0,x1,y1 (0–1)" spellcheck="false" />' +
        '<button type="button" class="job-action-btn pv-go">🖼 Rendern</button>' +
      "</div>" +
      '<div class="job-preview-meta" role="status" aria-live="polite"></div>';
    var meta = wrap.querySelector(".job-preview-meta");
    var btn = wrap.querySelector(".pv-go");
    var objectUrl = null;
    btn.addEventListener("click", async function () {
      var page = Number(wrap.querySelector(".pv-page").value);
      if (!Number.isInteger(page) || page < 1) { meta.textContent = "Ungültige Seitenzahl."; return; }
      var body = { source: job.sourceSha256, page: page, filename: job.sourceFilename || job.reference };
      var size = wrap.querySelector(".pv-size").value;
      if (size) body.targetPixels = Number(size);
      var bboxRaw = wrap.querySelector(".pv-bbox").value.trim();
      if (bboxRaw) {
        var bbox = bboxRaw.split(",").map(function (v) { return Number(v.trim()); });
        if (bbox.length !== 4 || bbox.some(function (v) { return !Number.isFinite(v) || v < 0 || v > 1; }) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
          meta.textContent = "Ausschnitt muss x0,y0,x1,y1 in [0,1] mit x0<x1 und y0<y1 sein.";
          return;
        }
        body.bbox = bbox;
      }
      btn.disabled = true;
      meta.textContent = "Rendere Seite " + page + " …";
      try {
        var res = await postJson("/ui/render", body);
        if (!res.ok) { var err = await readJson(res); meta.textContent = "Rendern fehlgeschlagen: " + errorText(err, res); return; }
        var blob = await res.blob();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
        var img = wrap.querySelector(".job-preview-img");
        if (!img) { img = document.createElement("img"); img.className = "job-preview-img"; wrap.append(img); }
        img.alt = "Seite " + page + " von " + job.reference;
        img.src = objectUrl;
        var info = res.headers.get("x-render-width") + "×" + res.headers.get("x-render-height") + " px @ " + res.headers.get("x-render-dpi") + " dpi";
        if (res.headers.get("x-render-clamped") === "1") info += " · auf die Pixel-Obergrenze begrenzt";
        if (res.headers.get("x-render-tile")) info += " · aus Kachel " + res.headers.get("x-render-tile");
        meta.textContent = "Seite " + page + ": " + info;
      } catch (e) {
        meta.textContent = "Netzwerkfehler: " + (e && e.message ? e.message : e);
      } finally {
        btn.disabled = false;
      }
    });
    return wrap;
  }

  // The job's figures (GET /ui/jobs/{id}/figures) as a gallery. The crops are
  // not stored; each thumbnail renders on demand from the source with the
  // figure's bbox (POST /ui/render), one at a time to stay under the render
  // rate limit. A click loads a larger render. Model text via textContent only.
  var JOB_FIGURE_THUMB_PX = 480;
  var JOB_FIGURE_FULL_PX = 1600;
  function renderJobFigures(job) {
    var wrap = document.createElement("div");
    wrap.className = "job-preview";
    var title = document.createElement("div");
    title.className = "job-subtitle";
    title.textContent = "Abbildungen";
    var status = document.createElement("div");
    status.className = "job-preview-meta";
    status.setAttribute("role", "status");
    status.textContent = "Lade Abbildungen …";
    var grid = document.createElement("div");
    grid.className = "cq-figure-grid";
    wrap.append(title, status, grid);

    async function renderCrop(fig, px) {
      var body = { source: job.sourceSha256, page: fig.page, targetPixels: px, filename: job.sourceFilename || job.reference };
      if (Array.isArray(fig.bbox) && fig.bbox.length === 4 && fig.bbox[0] < fig.bbox[2] && fig.bbox[1] < fig.bbox[3]) body.bbox = fig.bbox;
      var res = await postJson("/ui/render", body);
      if (!res.ok) throw new Error(errorText(await readJson(res), res));
      return URL.createObjectURL(await res.blob());
    }

    (async function () {
      try {
        var res = await jobsFetch(JOBS_PATH + "/" + encodeURIComponent(job.jobId) + "/figures");
        var data = await readJson(res);
        if (!res.ok) { status.textContent = "Abbildungen nicht lesbar: " + errorText(data, res); return; }
        var figures = Array.isArray(data.figures) ? data.figures : [];
        if (!figures.length) {
          status.textContent = isTerminalStatus(job.status) ? "Keine Abbildungen erkannt." : "Noch keine Abbildungen (Job läuft).";
          if (!isTerminalStatus(job.status)) delete jobsFigures[job.jobId];   // look again on the next refresh
          return;
        }
        status.textContent = figures.length + " Abbildung(en)";
        var cards = figures.map(function (f) {
          var card = document.createElement("figure");
          card.className = "cq-figure";
          var img = document.createElement("img");
          img.className = "cq-figure-img";
          img.alt = f.description ? String(f.description).slice(0, 200) : "Abbildung " + f.figureId;
          img.title = "Klicken für größere Darstellung";
          var none = document.createElement("div");
          none.className = "cq-figure-noimg";
          none.textContent = "wird gerendert …";
          var meta = document.createElement("figcaption");
          meta.className = "cq-figure-meta";
          var idRow = document.createElement("div");
          idRow.className = "cq-figure-id";
          var idText = document.createElement("span");
          idText.textContent = "Seite " + f.page + " · " + f.figureId + (f.kind ? " · " + f.kind : "");
          idRow.append(idText);
          var desc = document.createElement("div");
          desc.className = "cq-figure-desc";
          desc.textContent = (f.caption ? f.caption + " — " : "") + (f.description || "");
          meta.append(idRow, desc);
          card.append(none, meta);
          grid.append(card);
          var large = false;
          img.addEventListener("click", async function () {
            if (large) { img.classList.toggle("zoomed"); return; }
            try {
              var url = await renderCrop(f, JOB_FIGURE_FULL_PX);
              URL.revokeObjectURL(img.src);
              img.src = url;
              large = true;
              img.classList.add("zoomed");
            } catch (e) { status.textContent = "Rendern fehlgeschlagen: " + (e && e.message ? e.message : e); }
          });
          return { f: f, img: img, none: none };
        });
        for (var i = 0; i < cards.length; i++) {
          try {
            cards[i].img.src = await renderCrop(cards[i].f, JOB_FIGURE_THUMB_PX);
            cards[i].none.replaceWith(cards[i].img);
          } catch (e) {
            cards[i].none.textContent = "kein Bild: " + (e && e.message ? e.message : e);
          }
        }
      } catch (err) {
        status.textContent = "Netzwerkfehler: " + (err && err.message ? err.message : err);
      }
    })();
    return wrap;
  }

  // Client-side filter over the loaded rows (the list API pages newest-first
  // and takes no filter).
  function applyJobsFilter() {
    var status = ($("jobs-filter-status") || {}).value || "";
    var text = (($("jobs-filter-text") || {}).value || "").trim().toLowerCase();
    var shown = 0;
    var total = 0;
    document.querySelectorAll("#jobs-output .job-item").forEach(function (el) {
      total += 1;
      var st = el.dataset.status || "";
      var okStatus = !status || (status === "active" ? !isTerminalStatus(st) && st !== "paused" && st !== "queued" : st === status);
      var okText = !text || (el.dataset.search || "").indexOf(text) >= 0;
      var visible = okStatus && okText;
      el.style.display = visible ? "" : "none";
      if (visible) shown += 1;
    });
    return { shown: shown, total: total };
  }

  async function loadJobs(append) {
    if (jobsLoading) return;
    jobsLoading = true;
    var out = $("jobs-output");
    var statusEl = $("jobs-status");
    var moreBtn = $("jobs-more-btn");
    if (!append) { jobsOffset = 0; out.innerHTML = '<div class="coll-spinner">Lade Jobs …</div>'; }
    try {
      var res = await jobsFetch(JOBS_PATH + "?limit=" + jobsLimit + "&offset=" + jobsOffset);
      var data = await res.json();
      if (!res.ok) { out.innerHTML = '<div class="coll-error">' + escapeHtml(data.error || ("HTTP " + res.status)) + "</div>"; return; }
      var jobs = Array.isArray(data.jobs) ? data.jobs : [];
      var list;
      if (append) {
        list = out.querySelector(".jobs-list");
        if (!list) { list = document.createElement("div"); list.className = "jobs-list"; out.innerHTML = ""; out.append(list); }
      } else {
        out.innerHTML = "";
        if (!jobs.length) { out.innerHTML = '<div class="coll-empty">Keine Jobs vorhanden.</div>'; }
        list = document.createElement("div"); list.className = "jobs-list";
        out.append(list);
      }
      jobs.forEach(function (job) { list.append(renderJobRow(job)); });
      var counts = applyJobsFilter();
      statusEl.textContent = "HTTP " + res.status + " · " + new Date().toLocaleTimeString() +
        (counts.shown !== counts.total ? " · " + counts.shown + " von " + counts.total + " angezeigt" : "");
      jobsLive(jobs.length + " Job(s) geladen.");
      if (moreBtn) moreBtn.style.display = jobs.length >= jobsLimit ? "" : "none";
      jobsOffset += jobs.length;
    } catch (err) {
      out.innerHTML = '<div class="coll-error">Netzwerkfehler: ' + escapeHtml(err && err.message ? err.message : String(err)) + "</div>";
    } finally {
      jobsLoading = false;
    }
  }

  var jobsRefreshBtn = $("jobs-refresh-btn");
  if (jobsRefreshBtn) jobsRefreshBtn.addEventListener("click", function () { loadJobs(false); });
  var jobsMoreBtn = $("jobs-more-btn");
  if (jobsMoreBtn) jobsMoreBtn.addEventListener("click", function () { loadJobs(true); });
  var jobsFilterStatus = $("jobs-filter-status");
  if (jobsFilterStatus) jobsFilterStatus.addEventListener("change", applyJobsFilter);
  var jobsFilterText = $("jobs-filter-text");
  if (jobsFilterText) jobsFilterText.addEventListener("input", applyJobsFilter);
  var jobsAuto = $("jobs-auto-refresh");
  if (jobsAuto) jobsAuto.addEventListener("change", function () {
    if (jobsAuto.checked) {
      jobsAutoTimer = setInterval(function () {
        var panel = $("panel-jobs");
        if (panel && panel.classList.contains("active")) loadJobs(false);
      }, 5000);
    } else if (jobsAutoTimer) {
      clearInterval(jobsAutoTimer); jobsAutoTimer = null;
    }
  });
})();
`;
