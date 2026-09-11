// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ui-page.ts
 *
 * The upload UI: one self-contained page, no build step, no framework.
 *
 * ## Why it is hand-written HTML
 *
 * This is an operator tool for checking that a document converts the way it
 * should before wiring a corpus through the API. Its whole value is being
 * available at the service's own root with nothing to install, which a bundled
 * SPA would trade away for features nobody needs here. Search's `test-page.ts`
 * makes the same call.
 *
 * ## Why it streams
 *
 * A 40-page specification takes minutes. A spinner tells an operator nothing,
 * while pages appearing one by one tells them whether the conversion is working
 * *and* whether the output is right — usually within the first page, which is
 * when it is still cheap to change a setting and retry. So the page consumes the
 * SSE mode of `/v1/convert` rather than the sync mode.
 *
 * ## Security notes
 *
 * The page authenticates with the session cookie the OIDC flow set; it never
 * holds a bearer token, because a token in a browser is a token in every
 * extension that page loads. Requests go to `/ui/*`, which is the
 * backend-for-frontend boundary that accepts cookies and applies the CSRF guard.
 * Model output is inserted with `textContent`, never `innerHTML` — converted
 * documents contain HTML tables by contract, and rendering those would execute
 * whatever a crafted PDF talked the model into emitting.
 */

import { supportedExtensions, supportedFormatsLabel } from "./formats.js";

export interface UiPageOptions {
  /** Rendered as a sign-out link when SSO is configured. */
  logoutPath: string | null;
  /** Whether the ingest control is shown at all. */
  ingestEnabled: boolean;
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

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ATF Extract</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 20%, transparent); }
  * { box-sizing: border-box; }
  body { font: 16px/1.55 system-ui, sans-serif; margin: 0; }
  header { display: flex; align-items: baseline; gap: 1rem; padding: 1rem 1.5rem; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 1.1rem; margin: 0; }
  header .spacer { flex: 1; }
  main { max-width: 70rem; margin: 0 auto; padding: 1.5rem; display: grid; gap: 1.5rem; }
  fieldset { border: 1px solid var(--line); border-radius: .5rem; padding: 1rem 1.25rem 1.25rem; }
  legend { padding: 0 .4rem; font-weight: 600; }
  .row { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; }
  .field { display: grid; gap: .25rem; }
  label { font-weight: 500; font-size: .9rem; }
  input, select, button { font: inherit; padding: .5rem .65rem; border-radius: .375rem; border: 1px solid currentColor; background: transparent; color: inherit; }
  button { cursor: pointer; font-weight: 500; }
  button[disabled] { opacity: .5; cursor: not-allowed; }
  .hint { font-size: .85rem; opacity: .75; margin: .35rem 0 0; }
  progress { width: 100%; height: 1rem; }
  #status { font-variant-numeric: tabular-nums; }
  #status[data-state="error"] { color: #b00020; font-weight: 600; }
  #status[data-state="done"] { font-weight: 600; }
  pre { white-space: pre-wrap; word-break: break-word; border: 1px solid var(--line); border-radius: .5rem; padding: 1rem; max-height: 32rem; overflow: auto; margin: 0; font-size: .85rem; }
  ul.log { list-style: none; padding: 0; margin: 0; display: grid; gap: .35rem; font-size: .85rem; }
  ul.log li { padding-left: 1rem; border-left: 3px solid var(--line); }
  ul.log li[data-kind="warn"] { border-left-color: #b8860b; }
  ul.log li[data-kind="error"] { border-left-color: #b00020; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  @media (prefers-reduced-motion: no-preference) { pre { scroll-behavior: smooth; } }
</style>
</head>
<body>
<header>
  <h1>ATF Extract</h1>
  <span class="spacer"></span>
  <a href="/openapi.json">OpenAPI</a>
  <a href="/health">Health</a>
  ${options.logoutPath !== null ? `<a href="${escapeHtml(options.logoutPath)}">Abmelden</a>` : ""}
</header>

<main>
  <form id="form">
    <fieldset>
      <legend>Dokument konvertieren</legend>
      <div class="row">
        <div class="field">
          <label for="file">Datei</label>
          <input id="file" name="document" type="file" accept="${escapeHtml(accept)}" required />
        </div>
        <div class="field">
          <label for="reference">Referenz</label>
          <input id="reference" type="text" placeholder="wird aus dem Dateinamen abgeleitet" size="30" />
        </div>
        ${
          options.ingestEnabled
            ? `<div class="field">
          <label for="collection">Collection</label>
          <input id="collection" type="text" value="${escapeHtml(options.defaultCollection)}" size="16" />
        </div>
        <div class="field">
          <label for="mode">Modus</label>
          <select id="mode">
            <option value="convert">Nur konvertieren</option>
            <option value="ingest">Konvertieren und indexieren</option>
          </select>
        </div>`
            : ""
        }
        <button id="submit" type="submit">Starten</button>
      </div>
      <p class="hint">Unterstützt: ${escapeHtml(formats)}. Maximal ${maxMib} MiB.</p>
    </fieldset>
  </form>

  <fieldset>
    <legend>Fortschritt</legend>
    <progress id="progress" value="0" max="1"></progress>
    <p id="status" role="status" aria-live="polite">Bereit.</p>
    <ul class="log" id="log" aria-label="Meldungen"></ul>
  </fieldset>

  <fieldset>
    <legend>Ergebnis</legend>
    <div class="row" style="margin-bottom:.75rem">
      <button id="copy" type="button" disabled>Markdown kopieren</button>
      <button id="download" type="button" disabled>Markdown herunterladen</button>
    </div>
    <label class="visually-hidden" for="output">Erzeugtes Markdown</label>
    <pre id="output" tabindex="0"></pre>
  </fieldset>
</main>

<script>
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const form = $("form");
  const fileInput = $("file");
  const submit = $("submit");
  const progress = $("progress");
  const status = $("status");
  const log = $("log");
  const output = $("output");
  const copyButton = $("copy");
  const downloadButton = $("download");
  const modeSelect = $("mode");

  let markdown = "";

  const setStatus = (text, state) => {
    status.textContent = text;
    if (state) status.dataset.state = state; else delete status.dataset.state;
  };

  const addLog = (text, kind) => {
    const item = document.createElement("li");
    // textContent, never innerHTML: this text comes from a model and from
    // converter stderr.
    item.textContent = text;
    if (kind) item.dataset.kind = kind;
    log.append(item);
  };

  const reset = () => {
    markdown = "";
    output.textContent = "";
    log.replaceChildren();
    progress.value = 0;
    progress.max = 1;
    copyButton.disabled = true;
    downloadButton.disabled = true;
  };

  const appendMarkdown = (chunk) => {
    markdown += (markdown === "" ? "" : "\\n\\n---\\n\\n") + chunk;
    output.textContent = markdown;
    output.scrollTop = output.scrollHeight;
    copyButton.disabled = false;
    downloadButton.disabled = false;
  };

  /**
   * Read an SSE stream from a POST response.
   *
   * EventSource cannot POST, so the stream is parsed by hand. Events are split on
   * a blank line, which is the SSE frame delimiter.
   */
  const readEvents = async (response, onEvent) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\\n\\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        const dataLines = [];
        for (const line of frame.split("\\n")) {
          if (line.startsWith(":")) continue;              // heartbeat comment
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          try { onEvent(event, JSON.parse(dataLines.join("\\n"))); }
          catch { addLog("Ein Ereignis konnte nicht gelesen werden.", "warn"); }
        }
        boundary = buffer.indexOf("\\n\\n");
      }
    }
  };

  const buildHeaders = (reference) => {
    const headers = { accept: "text/event-stream" };
    if (reference) headers["x-reference"] = reference;
    return headers;
  };

  const runConvert = async (file, reference) => {
    const body = new FormData();
    body.append("document", file);
    const response = await fetch("/ui/convert", {
      method: "POST",
      headers: buildHeaders(reference),
      body,
      credentials: "same-origin",
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error("HTTP " + response.status + (detail ? ": " + detail.slice(0, 300) : ""));
    }

    await readEvents(response, (event, data) => {
      if (event === "accepted") {
        setStatus("Konvertierung läuft …");
      } else if (event === "progress") {
        if (data.pageCount) progress.max = data.pageCount;
        progress.value = data.page;
        setStatus("Seite " + data.page + (progress.max > 1 ? " von " + progress.max : "") + " fertig.");
        appendMarkdown(data.markdown);
        for (const warning of data.warnings || []) addLog("Seite " + data.page + ": " + warning, "warn");
      } else if (event === "done") {
        progress.max = data.pageCount || 1;
        progress.value = progress.max;
        const figures = (data.pages || []).reduce((sum, page) => sum + (page.figures || []).length, 0);
        setStatus(data.pageCount + " Seite(n), " + figures + " Abbildung(en) konvertiert.", "done");
        markdown = data.markdown;
        output.textContent = markdown;
      } else if (event === "error") {
        setStatus(data.error || "Konvertierung fehlgeschlagen.", "error");
        addLog((data.code || "ERROR") + ": " + (data.detail || data.error || ""), "error");
      }
    });
  };

  const runIngest = async (file, reference, collection) => {
    setStatus("Konvertierung und Indexierung laufen … (keine Zwischenmeldungen)");
    const body = new FormData();
    body.append("document", file);
    const headers = { accept: "application/json", "x-reference": reference };
    if (collection) headers["x-collection"] = collection;
    const response = await fetch("/ui/ingest", {
      method: "POST",
      headers,
      body,
      credentials: "same-origin",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setStatus(data.error || ("Indexierung fehlgeschlagen (HTTP " + response.status + ")"), "error");
      if (data.code) addLog(data.code + (data.errorId ? " — errorId " + data.errorId : ""), "error");
      return;
    }
    progress.max = 1;
    progress.value = 1;
    setStatus(
      data.page_count + " Seite(n) in Collection " + data.collection +
      " indexiert, " + data.assets_stored + " Abbildung(en) gespeichert" +
      (data.assets_failed ? ", " + data.assets_failed + " fehlgeschlagen" : "") + ".",
      "done"
    );
    for (const warning of data.warnings || []) addLog(warning, "warn");
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    reset();
    submit.disabled = true;
    setStatus("Wird übertragen …");

    const referenceInput = $("reference").value.trim();
    const reference = referenceInput || file.name;
    const collectionInput = $("collection");
    const mode = modeSelect ? modeSelect.value : "convert";

    try {
      if (mode === "ingest") {
        await runIngest(file, reference, collectionInput ? collectionInput.value.trim() : "");
      } else {
        await runConvert(file, referenceInput);
      }
    } catch (error) {
      setStatus(String(error && error.message ? error.message : error), "error");
    } finally {
      submit.disabled = false;
    }
  });

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      addLog("Markdown in die Zwischenablage kopiert.");
    } catch {
      addLog("Kopieren war nicht möglich; bitte den Text manuell markieren.", "warn");
    }
  });

  downloadButton.addEventListener("click", () => {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const name = ($("reference").value.trim() || (fileInput.files[0] && fileInput.files[0].name) || "dokument");
    link.download = name.replace(/[^A-Za-z0-9._-]+/g, "_") + ".md";
    link.click();
    URL.revokeObjectURL(url);
  });
})();
</script>
</body>
</html>`;
}
