// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/src/test-page.ts

export function getTestPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>vectorsearch</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <div class="logo">⚡</div>
    <h1>vectorsearch</h1>
    <span class="badge">dev console</span>
  </header>

  <div class="card">
    <div class="tabs" role="tablist">
      <button class="tab-btn active" role="tab" data-tab="ingest" aria-selected="true"><span class="tab-icon">📥</span> Ingest</button>
      <button class="tab-btn" role="tab" data-tab="batch" aria-selected="false"><span class="tab-icon">📦</span> Batch</button>
      <button class="tab-btn" role="tab" data-tab="search" aria-selected="false"><span class="tab-icon">🔍</span> Search</button>
      <button class="tab-btn" role="tab" data-tab="delete" aria-selected="false"><span class="tab-icon">🗑️</span> Delete</button>
      <button class="tab-btn" role="tab" data-tab="query" aria-selected="false"><span class="tab-icon">📚</span> Query</button>
      <button class="tab-btn" role="tab" data-tab="collections" aria-selected="false"><span class="tab-icon">🗄️</span> Collections</button>
      <button class="tab-btn" role="tab" data-tab="stats" aria-selected="false"><span class="tab-icon">📊</span> Stats</button>
      <button class="tab-btn" role="tab" data-tab="activity" aria-selected="false"><span class="tab-icon">📋</span> Activity</button>
    </div>

    <!-- Shared datalist: collection suggestions for all collection inputs -->
    <datalist id="collections-datalist"></datalist>

    <!-- ── Ingest panel ─────────────────────────────────────────────────── -->
    <div class="tab-panel active" id="panel-ingest" role="tabpanel">
      <p class="panel-title">Ingest Document</p>
      <p class="panel-desc">Embed and store a single document. All fields map directly to request headers.</p>
      <form id="ingest-form">
        <div class="field">
          <label for="ingest-text">Content (Markdown / plain text)</label>
          <textarea id="ingest-text" rows="8" placeholder="# Document Title&#10;&#10;Your content here..."></textarea>
        </div>

        <div class="section-label">Identity</div>
        <div class="row">
          <div class="field field-wide">
            <label for="ingest-reference">Reference <span class="req">*</span> <span class="hint">(X-Reference)</span></label>
            <input type="text" id="ingest-reference" placeholder="doc-123" />
          </div>
          <div class="field field-narrow">
            <label for="ingest-collection">Collection <span class="hint">(X-Collection)</span></label>
            <input type="text" id="ingest-collection" placeholder="documents" list="collections-datalist" />
          </div>
          <div class="field field-narrow">
            <label for="ingest-version-mode">Version Mode <span class="hint">(X-Version-Mode)</span></label>
            <select id="ingest-version-mode">
              <option value="replace">replace</option>
              <option value="version">version</option>
            </select>
          </div>
          <div class="field field-narrow" id="ingest-version-field" style="display:none">
            <label for="ingest-version">Version <span class="hint">(X-Version)</span></label>
            <input type="text" id="ingest-version" placeholder="e.g. 1.0.0" />
          </div>
        </div>

        <div class="section-label">Document Info</div>
        <div class="row">
          <div class="field field-wide">
            <label for="ingest-title">Title <span class="hint">(X-Title)</span></label>
            <input type="text" id="ingest-title" placeholder="My Document" />
          </div>
          <div class="field field-wide">
            <label for="ingest-source">Source <span class="hint">(X-Source)</span></label>
            <input type="text" id="ingest-source" placeholder="confluence / jira / …" />
          </div>
        </div>
        <div class="field">
          <label for="ingest-link">Link <span class="hint">(X-Link)</span></label>
          <input type="text" id="ingest-link" placeholder="https://…" />
        </div>
        <div class="row">
          <div class="field field-wide">
            <label for="ingest-tags">Tags <span class="hint">(X-Tags, comma-separated)</span></label>
            <input type="text" id="ingest-tags" placeholder="tag1, tag2" />
          </div>
          <div class="field field-narrow">
            <label for="ingest-fts-language">FTS Language <span class="hint">(X-FTS-Language)</span></label>
            <input type="text" id="ingest-fts-language" placeholder="simple" />
          </div>
        </div>

        <div class="section-label">Access Control</div>
        <div class="row">
          <div class="field">
            <label for="ingest-allowed-users">Allowed Users <span class="hint">(X-Allowed-Users, comma-separated)</span></label>
            <input type="text" id="ingest-allowed-users" placeholder="alice, bob" />
          </div>
          <div class="field">
            <label for="ingest-allowed-groups">Allowed Groups <span class="hint">(X-Allowed-Groups, comma-separated)</span></label>
            <input type="text" id="ingest-allowed-groups" placeholder="admins, editors" />
          </div>
        </div>

        <div class="section-label">Chunking</div>
        <div class="row">
          <div class="field field-narrow">
            <label for="ingest-chunk-size">Chunk Size <span class="hint">(X-Chunk-Size)</span></label>
            <input type="number" id="ingest-chunk-size" placeholder="e.g. 512" min="1" />
          </div>
          <div class="field field-narrow">
            <label for="ingest-chunk-overlap">Chunk Overlap <span class="hint">(X-Chunk-Overlap)</span></label>
            <input type="number" id="ingest-chunk-overlap" placeholder="e.g. 64" min="0" />
          </div>
          <div class="field field-narrow">
            <label for="ingest-context-prefix-size">Context Prefix Size <span class="hint">(X-Context-Prefix-Size)</span></label>
            <input type="number" id="ingest-context-prefix-size" placeholder="e.g. 256" min="0" />
          </div>
          <div class="field field-narrow">
            <label for="ingest-breakpoint-percentile">Breakpoint Percentile <span class="hint">(X-Breakpoint-Percentile, 1–99)</span></label>
            <input type="number" id="ingest-breakpoint-percentile" placeholder="e.g. 75" min="1" max="99" />
          </div>
        </div>
        <div class="row">
          <div class="field field-narrow">
            <label for="ingest-late-chunking-alpha">Late Chunking Alpha <span class="hint">(X-Late-Chunking-Alpha, 0–1)</span></label>
            <input type="number" id="ingest-late-chunking-alpha" placeholder="e.g. 0.5" min="0" max="1" step="0.05" />
          </div>
          <div class="field field-narrow">
            <label for="ingest-chapter-split-max-chunks">Chapter Split Max Chunks <span class="hint">(X-Chapter-Split-Max-Chunks — split large docs into chapters)</span></label>
            <input type="number" id="ingest-chapter-split-max-chunks" placeholder="e.g. 25" min="0" />
          </div>
          <div class="field field-narrow" style="display:flex;flex-direction:column;justify-content:flex-end;gap:0.6rem;padding-bottom:0.1rem">
            <label class="checkbox-label" style="text-transform:none;letter-spacing:normal;font-size:0.82rem"><input type="checkbox" id="ingest-semantic-chunking" /> Semantic Chunking <span class="hint">(X-Semantic-Chunking)</span></label>
            <label class="checkbox-label" style="text-transform:none;letter-spacing:normal;font-size:0.82rem"><input type="checkbox" id="ingest-summarize" /> Summarize <span class="hint">(X-Summarize)</span></label>
          </div>
        </div>

        <div class="section-label">Vector</div>
        <div class="row">
          <div class="field field-narrow">
            <label for="ingest-quantization">Quantization <span class="hint">(X-Quantization)</span></label>
            <select id="ingest-quantization">
              <option value="">server default</option>
              <option value="none">none</option>
              <option value="binary">binary</option>
            </select>
          </div>
        </div>

        <div class="section-label">Metadata</div>
        <div class="field">
          <label for="ingest-metadata">Metadata JSON <span class="hint">(X-Metadata)</span></label>
          <textarea id="ingest-metadata" rows="3" placeholder='{"client": "acme"}'></textarea>
        </div>

        <button type="submit" class="btn btn-primary">⚡ Ingest</button>
        <div id="ingest-result" class="result"></div>
      </form>
    </div>

    <!-- ── Batch Ingest panel ───────────────────────────────────────────── -->
    <div class="tab-panel" id="panel-batch" role="tabpanel">
      <p class="panel-title">Batch Ingest</p>
      <p class="panel-desc">Drop multiple files — each is ingested as a separate document. The filename (without extension) becomes the reference.</p>

      <div class="dropzone" id="batch-dropzone" tabindex="0" role="button" aria-label="Drop files here or click to select">
        <div class="dropzone-icon">📂</div>
        <div class="dropzone-text"><strong>Drop files here</strong> or click to select</div>
        <div class="dropzone-text" style="margin-top:0.25rem;font-size:0.75rem">Markdown, plain text, or any text file</div>
      </div>
      <input type="file" id="batch-file-input" multiple accept="*/*" style="display:none" />

      <div class="file-list" id="batch-file-list"></div>

      <div class="section-label">Common Settings</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="batch-collection">Collection <span class="hint">(X-Collection)</span></label>
          <input type="text" id="batch-collection" placeholder="documents" list="collections-datalist" />
        </div>
        <div class="field field-narrow">
          <label for="batch-version-mode">Version Mode <span class="hint">(X-Version-Mode)</span></label>
          <select id="batch-version-mode">
            <option value="replace">replace</option>
            <option value="version">version</option>
          </select>
        </div>
        <div class="field field-narrow" id="batch-version-field" style="display:none">
          <label for="batch-version">Version <span class="hint">(X-Version)</span></label>
          <input type="text" id="batch-version" placeholder="e.g. 1.0.0" />
        </div>
        <div class="field field-narrow">
          <label for="batch-fts-language">FTS Language <span class="hint">(X-FTS-Language)</span></label>
          <input type="text" id="batch-fts-language" placeholder="simple" />
        </div>
      </div>

      <div class="section-label">Document Info</div>
      <div class="row">
        <div class="field field-wide">
          <label for="batch-title">Title <span class="hint">(X-Title, applied to all files)</span></label>
          <input type="text" id="batch-title" placeholder="Shared title (optional)" />
        </div>
        <div class="field field-wide">
          <label for="batch-source">Source <span class="hint">(X-Source)</span></label>
          <input type="text" id="batch-source" placeholder="confluence / jira / …" />
        </div>
      </div>
      <div class="row">
        <div class="field field-wide">
          <label for="batch-link">Link <span class="hint">(X-Link)</span></label>
          <input type="text" id="batch-link" placeholder="https://…" />
        </div>
        <div class="field field-wide">
          <label for="batch-tags">Tags <span class="hint">(X-Tags, comma-separated)</span></label>
          <input type="text" id="batch-tags" placeholder="tag1, tag2" />
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="batch-allowed-users">Allowed Users <span class="hint">(X-Allowed-Users)</span></label>
          <input type="text" id="batch-allowed-users" placeholder="alice, bob" />
        </div>
        <div class="field">
          <label for="batch-allowed-groups">Allowed Groups <span class="hint">(X-Allowed-Groups)</span></label>
          <input type="text" id="batch-allowed-groups" placeholder="admins, editors" />
        </div>
      </div>

      <div class="section-label">Chunking</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="batch-chunk-size">Chunk Size <span class="hint">(X-Chunk-Size)</span></label>
          <input type="number" id="batch-chunk-size" placeholder="e.g. 512" min="1" />
        </div>
        <div class="field field-narrow">
          <label for="batch-chunk-overlap">Chunk Overlap <span class="hint">(X-Chunk-Overlap)</span></label>
          <input type="number" id="batch-chunk-overlap" placeholder="e.g. 64" min="0" />
        </div>
        <div class="field field-narrow">
          <label for="batch-context-prefix-size">Context Prefix Size <span class="hint">(X-Context-Prefix-Size)</span></label>
          <input type="number" id="batch-context-prefix-size" placeholder="e.g. 256" min="0" />
        </div>
        <div class="field field-narrow">
          <label for="batch-breakpoint-percentile">Breakpoint Percentile <span class="hint">(X-Breakpoint-Percentile, 1–99)</span></label>
          <input type="number" id="batch-breakpoint-percentile" placeholder="e.g. 75" min="1" max="99" />
        </div>
      </div>
      <div class="row">
        <div class="field field-narrow">
          <label for="batch-late-chunking-alpha">Late Chunking Alpha <span class="hint">(X-Late-Chunking-Alpha, 0–1)</span></label>
          <input type="number" id="batch-late-chunking-alpha" placeholder="e.g. 0.5" min="0" max="1" step="0.05" />
        </div>
        <div class="field field-narrow">
          <label for="batch-chapter-split-max-chunks">Chapter Split Max Chunks <span class="hint">(X-Chapter-Split-Max-Chunks)</span></label>
          <input type="number" id="batch-chapter-split-max-chunks" placeholder="e.g. 25" min="0" />
        </div>
        <div class="field field-narrow" style="display:flex;flex-direction:column;justify-content:flex-end;gap:0.6rem;padding-bottom:0.1rem">
          <label class="checkbox-label" style="text-transform:none;letter-spacing:normal;font-size:0.82rem"><input type="checkbox" id="batch-semantic-chunking" /> Semantic Chunking <span class="hint">(X-Semantic-Chunking)</span></label>
          <label class="checkbox-label" style="text-transform:none;letter-spacing:normal;font-size:0.82rem"><input type="checkbox" id="batch-summarize" /> Summarize <span class="hint">(X-Summarize)</span></label>
        </div>
      </div>

      <div class="section-label">Vector</div>
      <div class="row">
        <div class="field field-narrow">
          <label for="batch-quantization">Quantization <span class="hint">(X-Quantization)</span></label>
          <select id="batch-quantization">
            <option value="">server default</option>
            <option value="none">none</option>
            <option value="binary">binary</option>
          </select>
        </div>
      </div>

      <div class="section-label">Metadata</div>
      <div class="field">
        <label for="batch-metadata">Metadata JSON <span class="hint">(X-Metadata, applied to all files)</span></label>
        <textarea id="batch-metadata" rows="3" placeholder='{"client": "acme"}'></textarea>
      </div>

      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" id="batch-ingest-btn" disabled>⚡ Ingest All</button>
        <button type="button" class="btn btn-secondary" id="batch-clear-btn">✕ Clear</button>
        <span class="batch-progress" id="batch-progress"></span>
      </div>
      <div id="batch-result" class="result"></div>
    </div>

    <!-- ── Search panel ─────────────────────────────────────────────────── -->
    <div class="tab-panel" id="panel-search" role="tabpanel">
      <p class="panel-title">Semantic Search</p>
      <p class="panel-desc">Query the vector database using natural language.</p>
      <form id="search-form">
        <div class="field">
          <label for="search-query">Query</label>
          <input type="text" id="search-query" placeholder="What are you looking for?" />
        </div>

        <div class="section-label">Scope</div>
        <div class="row">
          <div class="field field-narrow">
            <label for="search-collection">Collection <span class="hint">(X-Collection)</span></label>
            <input type="text" id="search-collection" placeholder="documents" list="collections-datalist" />
          </div>
          <div class="field field-narrow">
            <label for="search-max-results">Max Results <span class="hint">(X-Max-Results)</span></label>
            <input type="number" id="search-max-results" value="10" min="1" max="100" />
          </div>
          <div class="field field-narrow">
            <label for="search-offset">Offset <span class="hint">(X-Offset)</span></label>
            <input type="number" id="search-offset" value="0" min="0" />
          </div>
        </div>
        <div class="field">
          <label for="search-path-prefix">Path Prefix <span class="hint">(X-Path-Prefix — restrict to a folder, matched against base_ref)</span></label>
          <input type="text" id="search-path-prefix" placeholder="/Unterlagen Teil 1" />
        </div>

        <div class="section-label">Options</div>
        <div class="row" style="flex-wrap:wrap;gap:1.25rem;align-items:center;">
          <label class="checkbox-label"><input type="checkbox" id="search-rerank" /> Rerank <span class="hint">(X-Rerank)</span></label>
          <div class="search-mode-group" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
            <span style="font-size:0.78rem;color:#94a3b8;font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Mode:</span>
            <label class="checkbox-label"><input type="radio" name="search-mode" id="search-mode-dense"   value="dense"  /> Dense <span class="hint">(X-Search-Mode)</span></label>
            <label class="checkbox-label"><input type="radio" name="search-mode" id="search-mode-hybrid"  value="hybrid" checked /> Hybrid</label>
            <label class="checkbox-label"><input type="radio" name="search-mode" id="search-mode-fts"     value="fts"    /> FTS only</label>
          </div>
          <label class="checkbox-label"><input type="checkbox" id="search-hyde" /> HyDE expansion <span class="hint">(X-Hyde)</span></label>
          <label class="checkbox-label"><input type="checkbox" id="search-all-versions" /> All versions <span class="hint">(X-Include-All-Versions)</span></label>
          <label class="checkbox-label"><input type="checkbox" id="search-group-by-document" /> Group by document <span class="hint">(X-Group-By-Document)</span></label>
          <label class="checkbox-label"><input type="checkbox" id="search-include-vector" /> Query vector <span class="hint">(X-Include-Query-Vector)</span></label>
        </div>

        <div class="section-label">Filters</div>
        <div class="row">
          <div class="field field-wide">
            <label for="search-metadata">Metadata Filter JSON <span class="hint">(X-Metadata)</span></label>
            <textarea id="search-metadata" rows="2" placeholder='{"client": "acme"}'></textarea>
          </div>
          <div class="field field-wide">
            <label for="search-filter">Extra Filter JSON <span class="hint">(X-Filter)</span></label>
            <textarea id="search-filter" rows="2" placeholder='{"status": "published"}'></textarea>
          </div>
        </div>
        <div class="field">
          <label for="search-tags">Tags Filter <span class="hint">(X-Tags, comma-separated — doc must have ALL)</span></label>
          <input type="text" id="search-tags" placeholder="tag1, tag2" />
        </div>

        <div class="section-label">Access Control</div>

        <button type="submit" class="btn btn-primary">🔍 Search</button>
        <div id="search-result" class="search-output"></div>
      </form>
    </div>

    <!-- ── Delete panel ─────────────────────────────────────────────────── -->
    <div class="tab-panel" id="panel-delete" role="tabpanel">
      <p class="panel-title">Delete Documents</p>
      <p class="panel-desc">Remove documents by reference or metadata filter.</p>
      <div class="warning-strip">⚠️ This action is irreversible. All matching documents will be permanently deleted.</div>
      <form id="delete-form">
        <div class="row">
          <div class="field field-wide">
            <label for="delete-reference">Reference <span class="hint">(X-Reference — deletes all versions of this ref)</span></label>
            <input type="text" id="delete-reference" placeholder="doc-123" />
          </div>
          <div class="field field-narrow">
            <label for="delete-collection">Collection <span class="hint">(X-Collection)</span></label>
            <input type="text" id="delete-collection" placeholder="documents" list="collections-datalist" />
          </div>
        </div>
        <div class="field">
          <label for="delete-metadata">Metadata Filter JSON <span class="hint">(X-Metadata — used when no reference given)</span></label>
          <textarea id="delete-metadata" rows="3" placeholder='{"client": "acme", "id": "doc-123"}'></textarea>
        </div>
        <button type="submit" class="btn btn-danger">🗑️ Delete</button>
        <div id="delete-result" class="result"></div>
      </form>
    </div>

    <!-- ── Query (read-only) panel ─────────────────────────────────────── -->
    <div class="tab-panel" id="panel-query" role="tabpanel">
      <p class="panel-title">Query</p>
      <p class="panel-desc">Read-only queries: list documents and folders, read whole documents, fetch summaries and count collections. Every call shows up in the Activity view.</p>
      <form id="query-form">
        <div class="row">
          <div class="field field-wide">
            <label for="query-op">Operation</label>
            <select id="query-op">
              <option value="list_documents">list_documents — list documents</option>
              <option value="get_document">get_document — read a single document</option>
              <option value="get_documents">get_documents — read a whole folder</option>
              <option value="list_folders">list_folders — folder structure</option>
              <option value="get_summary">get_summary — summary of one document</option>
              <option value="get_summaries">get_summaries — summaries (overview)</option>
              <option value="collection_stats">collection_stats — count documents/chunks</option>
            </select>
          </div>
          <div class="field field-narrow">
            <label for="query-collection">Collection</label>
            <input type="text" id="query-collection" placeholder="documents" list="collections-datalist" />
          </div>
        </div>
        <div class="row">
          <div class="field field-wide" id="query-field-reference">
            <label for="query-reference">Reference <span class="hint">(document path / base_ref or chunk reference)</span></label>
            <input type="text" id="query-reference" placeholder="/Unterlagen Teil 1/vertrag.pdf" />
          </div>
          <div class="field field-wide" id="query-field-path-prefix">
            <label for="query-path-prefix">Path Prefix <span class="hint">(folder, optional)</span></label>
            <input type="text" id="query-path-prefix" placeholder="/Unterlagen Teil 1" />
          </div>
        </div>
        <div class="row">
          <div class="field field-narrow" id="query-field-limit">
            <label for="query-limit">Limit</label>
            <input type="number" id="query-limit" placeholder="100" min="1" />
          </div>
          <div class="field field-narrow" id="query-field-offset">
            <label for="query-offset">Offset</label>
            <input type="number" id="query-offset" placeholder="0" min="0" />
          </div>
          <div class="field field-narrow" id="query-field-depth">
            <label for="query-depth">Depth <span class="hint">(list_folders; 0 = full structure)</span></label>
            <input type="number" id="query-depth" placeholder="1" />
          </div>
          <div class="field field-narrow" id="query-field-max-chars">
            <label for="query-max-chars">Max Chars</label>
            <input type="number" id="query-max-chars" placeholder="200000" min="1000" />
          </div>
        </div>
        <button type="submit" class="btn btn-primary">▶ Run</button>
        <div id="query-result" class="result"></div>
      </form>
    </div>

    <!-- ── Collections overview panel ──────────────────────────────────── -->
    <div class="tab-panel" id="panel-collections" role="tabpanel">
      <p class="panel-title">Collections</p>
      <p class="panel-desc">All vector collections with their settings and document counts. Refresh to update.</p>
      <div style="display:flex;gap:0.75rem;align-items:center;margin-bottom:1.5rem;flex-wrap:wrap;">
        <button type="button" class="btn btn-secondary" id="collections-refresh-btn">↺ Refresh</button>
        <span id="collections-status" style="font-size:0.78rem;color:#64748b;"></span>
      </div>
      <div id="collections-progress"></div>
      <div id="collections-output"></div>
    </div>

    <!-- ── Stats panel ──────────────────────────────────────────────────── -->
    <div class="tab-panel" id="panel-stats" role="tabpanel">
      <p class="panel-title">Statistics</p>
      <p class="panel-desc">Historical ingest and search operations recorded in the database (GET /admin/stats).</p>
      <div class="row" style="align-items:flex-end;margin-bottom:1.25rem;">
        <div class="field field-narrow">
          <label for="stats-collection">Collection <span class="hint">(optional filter)</span></label>
          <input type="text" id="stats-collection" placeholder="all" list="collections-datalist" />
        </div>
        <div class="field field-narrow">
          <label for="stats-type">Type</label>
          <select id="stats-type">
            <option value="">ingest + search</option>
            <option value="ingest">ingest</option>
            <option value="search">search</option>
          </select>
        </div>
        <div class="field field-narrow">
          <label for="stats-limit">Limit</label>
          <input type="number" id="stats-limit" placeholder="100" min="1" max="1000" />
        </div>
        <div class="field field-narrow" style="display:flex;align-items:flex-end;">
          <button type="button" class="btn btn-secondary" id="stats-refresh-btn">↺ Load</button>
        </div>
      </div>
      <span id="stats-status" style="font-size:0.78rem;color:#64748b;"></span>
      <div id="stats-output"></div>
    </div>

    <!-- ── Activity panel ───────────────────────────────────────────────── -->
    <div class="tab-panel" id="panel-activity" role="tabpanel">
      <p class="panel-title">Activity</p>
      <p class="panel-desc">Real-time activity across all sessions — ingests, searches, deletions and queries (list/get via MCP).</p>
      <div style="display:flex;gap:0.75rem;align-items:center;margin-bottom:1.5rem;flex-wrap:wrap;">
        <span id="activity-sse-badge" class="act-sse-badge act-sse-connecting">⏳ Connecting…</span>
        <button type="button" class="btn btn-secondary" id="activity-clear-btn">✕ Clear view</button>
        <span id="activity-status" style="font-size:0.78rem;color:#64748b;"></span>
      </div>
      <div id="activity-output"><div class="act-empty">Waiting for events…</div></div>
    </div>

  </div><!-- /.card -->
<script>${JS}</script>
</body>
</html>`;
}

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f1117; color: #e2e8f0; min-height: 100vh;
  display: flex; flex-direction: column; align-items: center;
  padding: 2.5rem 1rem 4rem;
}
header { width: 100%; max-width: 1600px; margin-bottom: 2.5rem; display: flex; align-items: center; gap: 0.75rem; }
header .logo { width: 32px; height: 32px; background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 1rem; }
header h1 { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.02em; color: #f8fafc; }
header .badge { margin-left: auto; font-size: 0.7rem; font-weight: 500; padding: 0.2rem 0.6rem; border-radius: 999px; background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
.card { width: 100%; max-width: 1600px; background: #1a1f2e; border: 1px solid #2d3748; border-radius: 16px; overflow: hidden; }
.tabs { display: flex; border-bottom: 1px solid #2d3748; background: #141824; overflow: hidden; }
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
.req { color: #ef4444; }
textarea, input[type="text"], input[type="number"], select {
  width: 100%; padding: 0.65rem 0.85rem; background: #0f1117; border: 1px solid #2d3748; border-radius: 8px; color: #e2e8f0;
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace; font-size: 0.82rem; line-height: 1.6;
  transition: border-color 0.15s, box-shadow 0.15s; resize: vertical;
}
select { resize: none; cursor: pointer; }
textarea:focus, input[type="text"]:focus, input[type="number"]:focus, select:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }
textarea::placeholder, input::placeholder { color: #475569; }
input[type="number"] { max-width: 140px; }
.row { display: flex; gap: 1rem; align-items: flex-end; flex-wrap: wrap; }
.row .field { flex: 1; min-width: 140px; }
.row .field-narrow { flex: 0 0 140px; }
.row .field-wide { flex: 2; min-width: 200px; }
.checkbox-label { display: flex; align-items: center; gap: 0.5rem; text-transform: none; letter-spacing: normal; cursor: pointer; font-size: 0.82rem; color: #94a3b8; }
.checkbox-label input[type="checkbox"] { width: auto; cursor: pointer; accent-color: #6366f1; }
.btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.6rem 1.4rem; border: none; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; transition: opacity 0.15s, transform 0.1s; }
.btn:active { transform: scale(0.97); }
.btn-primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; }
.btn-primary:hover { opacity: 0.9; }
.btn-danger { background: linear-gradient(135deg, #ef4444, #dc2626); color: #fff; }
.btn-danger:hover { opacity: 0.9; }
.btn-secondary { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
.btn-secondary:hover { background: #263347; color: #cbd5e1; }
.result { margin-top: 1.25rem; padding: 1rem; border-radius: 8px; font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.78rem; line-height: 1.7; white-space: pre-wrap; word-break: break-all; display: none; max-height: 400px; overflow-y: auto; }
.result.success { background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.25); color: #6ee7b7; display: block; }
.result.error { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25); color: #fca5a5; display: block; }
.result-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.5rem; opacity: 0.7; }
.warning-strip { display: flex; align-items: center; gap: 0.6rem; padding: 0.65rem 0.9rem; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2); border-radius: 8px; font-size: 0.8rem; color: #fcd34d; margin-bottom: 1.5rem; }
.dropzone { border: 2px dashed #334155; border-radius: 12px; padding: 2.5rem 1.5rem; text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s; background: #0f1117; margin-bottom: 1.25rem; }
.dropzone:hover, .dropzone.drag-over { border-color: #6366f1; background: rgba(99,102,241,0.05); }
.dropzone-icon { font-size: 2rem; margin-bottom: 0.5rem; }
.dropzone-text { font-size: 0.85rem; color: #64748b; }
.dropzone-text strong { color: #94a3b8; }
.file-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.25rem; }
.file-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.85rem; background: #0f1117; border: 1px solid #2d3748; border-radius: 8px; font-size: 0.8rem; }
.file-item .file-name { flex: 1; color: #cbd5e1; font-family: "JetBrains Mono",monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-item .file-size { color: #475569; white-space: nowrap; }
.file-item .file-remove { background: none; border: none; color: #475569; cursor: pointer; font-size: 1rem; padding: 0; line-height: 1; transition: color 0.15s; }
.file-item .file-remove:hover { color: #ef4444; }
.file-item .file-status { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 999px; white-space: nowrap; }
.file-item .file-status.pending { background: rgba(99,102,241,0.1); color: #a78bfa; }
.file-item .file-status.ok { background: rgba(16,185,129,0.1); color: #6ee7b7; }
.file-item .file-status.err { background: rgba(239,68,68,0.1); color: #fca5a5; }
.batch-progress { font-size: 0.8rem; color: #64748b; }

/* ── Search result styles ─────────────────────────────────────────────────── */
.search-output { margin-top: 1.25rem; display: none; }
.search-output.visible { display: block; }

.search-meta-box {
  background: #141824; border: 1px solid #2d3748; border-radius: 10px;
  padding: 1rem 1.25rem; margin-bottom: 1rem;
}
.search-meta-box .meta-title {
  font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
  color: #6366f1; margin-bottom: 0.75rem;
}
.search-meta-pills { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }
.pill {
  display: inline-flex; align-items: center; gap: 0.3rem;
  font-size: 0.72rem; padding: 0.2rem 0.6rem; border-radius: 999px; font-weight: 500;
}
.pill-on  { background: rgba(99,102,241,0.15); color: #a78bfa; border: 1px solid rgba(99,102,241,0.3); }
.pill-off { background: rgba(71,85,105,0.2);   color: #475569;  border: 1px solid #2d3748; }
.pill-neutral { background: rgba(16,185,129,0.1); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.25); }

.search-meta-vector {
  margin-top: 0.6rem; padding: 0.6rem 0.75rem;
  background: #0f1117; border: 1px solid #2d3748; border-radius: 6px;
}
.search-meta-vector .vec-label {
  font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  color: #475569; margin-bottom: 0.3rem;
}
.search-meta-vector .vec-value {
  font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.7rem; color: #64748b;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
}
.search-meta-vector .vec-value:hover { color: #94a3b8; }

.hyde-box {
  background: rgba(139,92,246,0.06); border: 1px solid rgba(139,92,246,0.25);
  border-radius: 10px; padding: 0.9rem 1.25rem; margin-bottom: 1rem;
}
.hyde-box .hyde-title {
  font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
  color: #8b5cf6; margin-bottom: 0.5rem;
}
.hyde-box .hyde-text {
  font-size: 0.8rem; color: #c4b5fd; line-height: 1.6; white-space: pre-wrap;
}

.search-table-wrap {
  background: #141824; border: 1px solid #2d3748; border-radius: 10px; overflow: hidden;
}
.search-table-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.65rem 1rem; border-bottom: 1px solid #2d3748; background: #0f1117;
}
.search-table-header .tbl-title {
  font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #475569;
}
.search-table-header .tbl-count {
  font-size: 0.72rem; color: #6366f1; font-weight: 600;
}

table.sr-table { width: 100%; border-collapse: collapse; }
table.sr-table th {
  font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  color: #475569; padding: 0.55rem 0.85rem; text-align: left;
  border-bottom: 1px solid #2d3748; background: #141824; white-space: nowrap;
}
table.sr-table td {
  padding: 0.75rem 0.85rem; vertical-align: top; border-bottom: 1px solid #1e293b;
  font-size: 0.8rem; color: #cbd5e1; line-height: 1.55;
}
table.sr-table tr:last-child td { border-bottom: none; }
table.sr-table tr:hover td { background: rgba(99,102,241,0.04); }

.sr-rank { color: #475569; font-size: 0.72rem; font-weight: 600; white-space: nowrap; }
.sr-ref  { font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.72rem; color: #94a3b8; }
.sr-title { font-weight: 600; color: #f1f5f9; font-size: 0.82rem; }
.sr-link a { color: #6366f1; text-decoration: none; font-size: 0.75rem; }
.sr-link a:hover { text-decoration: underline; color: #a78bfa; }
.sr-content { color: #94a3b8; font-size: 0.78rem; line-height: 1.6; max-width: 400px; }
.sr-content-inner { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.sr-content-inner.expanded { display: block; -webkit-line-clamp: unset; }
.sr-expand { background: none; border: none; color: #6366f1; font-size: 0.7rem; cursor: pointer; padding: 0.1rem 0; margin-top: 0.2rem; display: block; }
.sr-expand:hover { color: #a78bfa; }

.sr-details-btn { background: none; border: 1px solid #2d3748; color: #475569; font-size: 0.68rem; cursor: pointer; padding: 0.15rem 0.5rem; border-radius: 4px; margin-top: 0.4rem; display: inline-flex; align-items: center; gap: 0.25rem; transition: color 0.15s, border-color 0.15s; }
.sr-details-btn:hover { color: #94a3b8; border-color: #475569; }
.sr-doc-btn { background: none; border: 1px solid #334155; color: #6366f1; font-size: 0.68rem; cursor: pointer; padding: 0.15rem 0.5rem; border-radius: 4px; margin-top: 0.4rem; margin-left: 0.4rem; display: inline-flex; align-items: center; gap: 0.25rem; transition: color 0.15s, border-color 0.15s, background 0.15s; }
.sr-doc-btn:hover { color: #a78bfa; border-color: #6366f1; background: rgba(99,102,241,0.08); }
.sr-details-row { display: none; }
.sr-details-row.open { display: table-row; }
.sr-details-row td { background: #0f1117; border-bottom: 1px solid #1e293b; padding: 0.65rem 0.85rem; }
.sr-details-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.6rem 1.25rem; }
.sr-detail-item { font-size: 0.75rem; }
.sr-detail-label { font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; margin-bottom: 0.2rem; }
.sr-detail-value { color: #94a3b8; font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.72rem; word-break: break-all; line-height: 1.5; }
.sr-detail-value.empty { color: #334155; font-style: italic; }
.sr-detail-tag { display: inline-block; background: rgba(99,102,241,0.12); color: #a78bfa; border: 1px solid rgba(99,102,241,0.25); border-radius: 999px; padding: 0.1rem 0.45rem; font-size: 0.68rem; margin: 0.1rem 0.15rem 0.1rem 0; }
.sr-pagination { display: flex; align-items: center; justify-content: space-between; margin-top: 0.85rem; gap: 0.75rem; }
.sr-page-btn { font-size: 0.8rem; padding: 0.5rem 1.1rem; }
.sr-page-info { font-size: 0.75rem; color: #475569; font-weight: 600; }.sr-scores { white-space: nowrap; }

/* ── Document modal ──────────────────────────────────────────────────────── */
.doc-modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 9999;
  display: flex; align-items: flex-start; justify-content: center;
  padding: 2rem 1rem; overflow-y: auto;
}
.doc-modal {
  background: #1a1f2e; border: 1px solid #2d3748; border-radius: 16px;
  width: 100%; max-width: 860px; min-height: 200px;
  display: flex; flex-direction: column;
}
.doc-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 1.25rem; border-bottom: 1px solid #2d3748;
  background: #141824; border-radius: 16px 16px 0 0;
}
.doc-modal-title { font-size: 0.85rem; font-weight: 600; color: #f1f5f9; }
.doc-modal-close {
  background: none; border: none; color: #64748b; font-size: 1.2rem; cursor: pointer;
  line-height: 1; padding: 0.1rem 0.4rem; border-radius: 4px; transition: color 0.15s, background 0.15s;
}
.doc-modal-close:hover { color: #f1f5f9; background: rgba(255,255,255,0.06); }
.doc-modal-body { padding: 1.25rem; flex: 1; overflow-y: auto; }
.doc-modal-loading { text-align: center; padding: 2rem; color: #64748b; font-size: 0.85rem; }
.doc-meta-section {
  background: #141824; border: 1px solid #2d3748; border-radius: 10px;
  padding: 1rem 1.25rem; margin-bottom: 1.25rem;
}
.doc-meta-section .doc-section-title {
  font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
  color: #6366f1; margin-bottom: 0.75rem;
}
.doc-meta-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.5rem 1.25rem; }
.doc-meta-item { font-size: 0.75rem; }
.doc-meta-label { font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; margin-bottom: 0.15rem; }
.doc-meta-value { color: #94a3b8; font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.72rem; word-break: break-all; line-height: 1.4; }
.doc-meta-value a { color: #6366f1; text-decoration: none; }
.doc-meta-value a:hover { text-decoration: underline; color: #a78bfa; }
.doc-meta-tag { display: inline-block; background: rgba(99,102,241,0.12); color: #a78bfa; border: 1px solid rgba(99,102,241,0.25); border-radius: 999px; padding: 0.1rem 0.45rem; font-size: 0.65rem; margin: 0.1rem 0.1rem 0 0; }
.doc-prefix-section {
  background: rgba(245,158,11,0.06); border: 1px solid rgba(245,158,11,0.2);
  border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.25rem;
}
.doc-prefix-section .doc-section-title { color: #f59e0b; }
.doc-prefix-text { font-size: 0.8rem; color: #fcd34d; white-space: pre-wrap; line-height: 1.65; font-family: "JetBrains Mono","Fira Code",monospace; }
.doc-chunks-section { margin-bottom: 0.5rem; }
.doc-chunks-title {
  font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
  color: #475569; margin-bottom: 0.85rem; padding-bottom: 0.4rem; border-bottom: 1px solid #2d3748;
}
.doc-chunk-block {
  border: 1px solid #2d3748; border-radius: 8px; margin-bottom: 0.5rem; overflow: hidden;
}
.doc-chunk-header {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.45rem 0.85rem; background: #141824;
  border-bottom: 1px solid #2d3748; font-size: 0.68rem;
}
.doc-chunk-num { font-weight: 700; color: #6366f1; }
.doc-chunk-score { color: #6ee7b7; font-weight: 600; }
.doc-chunk-score-badge {
  display: inline-flex; align-items: center; gap: 0.25rem;
  background: rgba(110,231,183,0.1); border: 1px solid rgba(110,231,183,0.25);
  border-radius: 999px; padding: 0.1rem 0.5rem; font-size: 0.65rem; color: #6ee7b7;
}
.doc-chunk-matched-badge {
  display: inline-flex; align-items: center; gap: 0.2rem;
  background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.35);
  border-radius: 999px; padding: 0.1rem 0.5rem; font-size: 0.65rem; color: #a78bfa;
}
.doc-chunk-body { padding: 0.75rem 0.85rem; }
.doc-chunk-text { font-size: 0.79rem; color: #cbd5e1; white-space: pre-wrap; line-height: 1.65; font-family: "JetBrains Mono","Fira Code",monospace; }
/* overlap highlight spans */
.doc-chunk-overlap-end   { background: rgba(245,158,11,0.18); border-bottom: 2px solid rgba(245,158,11,0.5); }
.doc-chunk-overlap-start { background: rgba(139,92,246,0.18); border-bottom: 2px solid rgba(139,92,246,0.5); }
.doc-chunk-overlap-both  { background: rgba(99,102,241,0.2);  border-bottom: 2px dashed rgba(99,102,241,0.6); }
.doc-chunk-boundary {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.3rem 0.85rem; font-size: 0.65rem; color: #475569;
  background: #0f1117; border-top: 1px solid #2d3748;
}
.doc-chunk-boundary span { flex: 1; height: 1px; background: #2d3748; }
.doc-overlap-legend {
  display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center;
  padding: 0.6rem 0; margin-bottom: 0.85rem; font-size: 0.7rem; color: #64748b;
}
.legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px; vertical-align: middle; margin-right: 0.3rem; }
.legend-end   { background: rgba(245,158,11,0.3); border: 1px solid rgba(245,158,11,0.6); }
.legend-start { background: rgba(139,92,246,0.3); border: 1px solid rgba(139,92,246,0.6); }
.legend-both  { background: rgba(99,102,241,0.3);  border: 1px dashed rgba(99,102,241,0.7); }
.score-main { font-weight: 700; font-size: 0.82rem; color: #6ee7b7; }
.score-sub  { font-size: 0.68rem; color: #475569; margin-top: 0.15rem; }
.score-sub span { display: inline-block; margin-right: 0.4rem; }

.search-error-box {
  background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25);
  border-radius: 10px; padding: 1rem 1.25rem; color: #fca5a5;
  font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.8rem;
}
.search-spinner {
  display: flex; align-items: center; justify-content: center; gap: 0.75rem;
  padding: 2.5rem 1rem; color: #64748b; font-size: 0.82rem;
}
.search-spinner::before {
  content: ''; width: 20px; height: 20px; border-radius: 50%;
  border: 2px solid #2d3748; border-top-color: #6366f1;
  animation: spin 0.7s linear infinite; flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Collections overview ────────────────────────────────────────────────── */
.coll-table-wrap {
  background: #141824; border: 1px solid #2d3748; border-radius: 10px; overflow: hidden;
}
.coll-table-wrap table { width: 100%; border-collapse: collapse; }
.coll-table-wrap th {
  font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  color: #475569; padding: 0.55rem 0.9rem; text-align: left;
  border-bottom: 1px solid #2d3748; background: #0f1117; white-space: nowrap;
}
.coll-table-wrap td {
  padding: 0.75rem 0.9rem; vertical-align: top; border-bottom: 1px solid #1e293b;
  font-size: 0.8rem; color: #cbd5e1; line-height: 1.5;
}
.coll-table-wrap tr:last-child td { border-bottom: none; }
.coll-table-wrap tr:hover td { background: rgba(99,102,241,0.04); }
.coll-name { font-family: "JetBrains Mono","Fira Code",monospace; font-weight: 700; color: #a78bfa; font-size: 0.85rem; }
.coll-badge {
  display: inline-flex; align-items: center; gap: 0.2rem;
  font-size: 0.65rem; padding: 0.15rem 0.5rem; border-radius: 999px; font-weight: 600;
  white-space: nowrap;
}
.coll-badge-on  { background: rgba(99,102,241,0.15); color: #a78bfa; border: 1px solid rgba(99,102,241,0.3); }
.coll-badge-off { background: rgba(71,85,105,0.15);  color: #475569;  border: 1px solid #2d3748; }
.coll-badge-bin { background: rgba(245,158,11,0.12); color: #fcd34d;  border: 1px solid rgba(245,158,11,0.25); }
.coll-count-big { font-size: 1rem; font-weight: 700; color: #f1f5f9; line-height: 1; }
.coll-count-sub { font-size: 0.68rem; color: #475569; margin-top: 0.2rem; }
.coll-mono { font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.72rem; color: #64748b; }
.coll-delete-btn {
  background: none; border: 1px solid #334155; color: #475569; font-size: 0.72rem;
  cursor: pointer; padding: 0.25rem 0.6rem; border-radius: 6px;
  transition: color 0.15s, border-color 0.15s, background 0.15s; white-space: nowrap;
}
.coll-delete-btn:hover { color: #ef4444; border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.06); }
.coll-summary-btn {
  background: none; border: 1px solid #334155; color: #64748b; font-size: 0.72rem;
  cursor: pointer; padding: 0.25rem 0.6rem; border-radius: 6px; margin-right: 0.4rem;
  transition: color 0.15s, border-color 0.15s, background 0.15s; white-space: nowrap;
}
.coll-summary-btn:hover { color: #a78bfa; border-color: rgba(99,102,241,0.4); background: rgba(99,102,241,0.06); }
.coll-summary-btn:disabled { opacity: 0.6; cursor: default; }
.coll-perms-btn {
  background: none; border: 1px solid #334155; color: #64748b; font-size: 0.72rem;
  cursor: pointer; padding: 0.25rem 0.6rem; border-radius: 6px; margin-right: 0.4rem;
  transition: color 0.15s, border-color 0.15s, background 0.15s; white-space: nowrap;
}
.coll-perms-btn:hover { color: #38bdf8; border-color: rgba(56,189,248,0.4); background: rgba(56,189,248,0.06); }
.coll-rename-btn {
  background: none; border: 1px solid #334155; color: #64748b; font-size: 0.72rem;
  cursor: pointer; padding: 0.25rem 0.6rem; border-radius: 6px; margin-right: 0.4rem;
  transition: color 0.15s, border-color 0.15s, background 0.15s; white-space: nowrap;
}
.coll-rename-btn:hover { color: #fcd34d; border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.06); }
.coll-open:hover { color: #c4b5fd; text-decoration: underline; }
/* ── Folder / file browser ── */
.fb-bar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 1rem; }
.fb-breadcrumb { font-size: 0.82rem; color: #94a3b8; display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
.fb-crumb { cursor: pointer; color: #a78bfa; }
.fb-crumb:hover { text-decoration: underline; }
.fb-sep { color: #475569; }
.fb-list { border: 1px solid #2d3748; border-radius: 10px; overflow: hidden; }
.fb-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.9rem; border-bottom: 1px solid #232a3a; cursor: pointer; font-size: 0.85rem; transition: background 0.12s; }
.fb-row:last-child { border-bottom: none; }
.fb-row:hover { background: rgba(99,102,241,0.06); }
.fb-icon { font-size: 1rem; flex-shrink: 0; }
.fb-name { color: #e2e8f0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-folder .fb-name { color: #a78bfa; }
.fb-meta { margin-left: auto; font-size: 0.72rem; color: #64748b; white-space: nowrap; flex-shrink: 0; }
.coll-progress-wrap {
  background: #0f1117; border: 1px solid #2d3748; border-radius: 10px;
  padding: 1rem 1.1rem; margin-bottom: 1.25rem;
}
.coll-progress-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 0.8rem; color: #cbd5e1; margin-bottom: 0.6rem;
}
.coll-progress-head #cp-counts { font-family: "JetBrains Mono","Fira Code",monospace; color: #64748b; font-size: 0.72rem; }
.coll-progress-track { height: 8px; background: #1e293b; border-radius: 999px; overflow: hidden; }
.coll-progress-bar {
  height: 100%; width: 0%; border-radius: 999px;
  background: linear-gradient(90deg, #6366f1, #8b5cf6); transition: width 0.25s ease;
}
.coll-progress-bar.cp-done { background: linear-gradient(90deg, #10b981, #059669); }
.coll-progress-current {
  margin-top: 0.55rem; font-family: "JetBrains Mono","Fira Code",monospace;
  font-size: 0.72rem; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.coll-progress-current.cp-err { color: #fca5a5; }
.coll-empty {
  padding: 2.5rem 1rem; text-align: center; color: #475569; font-size: 0.85rem;
}
.coll-error {
  background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25);
  border-radius: 10px; padding: 1rem 1.25rem; color: #fca5a5;
  font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.8rem;
}
.coll-spinner {
  display: flex; align-items: center; justify-content: center; gap: 0.75rem;
  padding: 2.5rem 1rem; color: #64748b; font-size: 0.82rem;
}
.coll-spinner::before {
  content: ''; width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid #2d3748; border-top-color: #6366f1;
  animation: spin 0.7s linear infinite; flex-shrink: 0;
}

/* ── Activity log ──────────────────────────────────────────────────────────── */
.act-empty { padding: 2.5rem 1rem; text-align: center; color: #475569; font-size: 0.85rem; }
.act-list { display: flex; flex-direction: column; gap: 0.5rem; }
.act-item {
  border: 1px solid #2d3748; border-radius: 10px; overflow: hidden;
  transition: border-color 0.15s;
}
.act-item:hover { border-color: #3d4f6b; }
.act-header {
  display: flex; align-items: center; gap: 0.75rem; padding: 0.65rem 1rem;
  background: #141824; cursor: pointer; user-select: none;
}
.act-type-badge {
  display: inline-flex; align-items: center; gap: 0.3rem;
  font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em;
  padding: 0.18rem 0.55rem; border-radius: 999px; white-space: nowrap; flex-shrink: 0;
}
.act-type-ingest  { background: rgba(99,102,241,0.15); color: #a78bfa; border: 1px solid rgba(99,102,241,0.3); }
.act-type-search  { background: rgba(16,185,129,0.12); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.3); }
.act-type-delete  { background: rgba(239,68,68,0.12);  color: #fca5a5; border: 1px solid rgba(239,68,68,0.3); }
.act-type-query   { background: rgba(14,165,233,0.12); color: #7dd3fc; border: 1px solid rgba(14,165,233,0.3); }
.act-status-badge {
  display: inline-flex; align-items: center; gap: 0.25rem;
  font-size: 0.68rem; font-weight: 600; padding: 0.15rem 0.5rem;
  border-radius: 999px; white-space: nowrap; flex-shrink: 0;
}
.act-status-ok      { background: rgba(16,185,129,0.1);  color: #6ee7b7;  border: 1px solid rgba(16,185,129,0.25); }
.act-status-error   { background: rgba(239,68,68,0.1);   color: #fca5a5;  border: 1px solid rgba(239,68,68,0.25); }
.act-status-running { background: rgba(245,158,11,0.1);  color: #fcd34d;  border: 1px solid rgba(245,158,11,0.25); }
.act-summary { flex: 1; font-size: 0.8rem; color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.act-time { font-size: 0.7rem; color: #475569; white-space: nowrap; flex-shrink: 0; font-family: "JetBrains Mono","Fira Code",monospace; }
.act-chevron { color: #475569; font-size: 0.75rem; flex-shrink: 0; transition: transform 0.2s; }
.act-item.open .act-chevron { transform: rotate(90deg); }
.act-body { display: none; padding: 0.75rem 1rem; background: #0f1117; border-top: 1px solid #2d3748; }
.act-item.open .act-body { display: block; }
.act-body pre {
  font-family: "JetBrains Mono","Fira Code",monospace; font-size: 0.75rem; color: #94a3b8;
  line-height: 1.65; white-space: pre-wrap; word-break: break-all; margin: 0;
}
.act-duration { font-size: 0.7rem; color: #475569; margin-top: 0.5rem; }
/* SSE connection badge */
.act-sse-badge {
  display: inline-flex; align-items: center; gap: 0.3rem;
  font-size: 0.72rem; font-weight: 600; padding: 0.2rem 0.6rem;
  border-radius: 999px; white-space: nowrap;
}
.act-sse-connected    { background: rgba(16,185,129,0.12); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.3); }
.act-sse-connecting   { background: rgba(245,158,11,0.1);  color: #fcd34d; border: 1px solid rgba(245,158,11,0.25); }
.act-sse-disconnected { background: rgba(239,68,68,0.1);   color: #fca5a5; border: 1px solid rgba(239,68,68,0.25); }
`;

const JS = `
// ── Tab switching ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    document.getElementById('panel-' + target).classList.add('active');
    if (target === 'activity') renderActivityLog();
    if (target === 'query') populateCollectionsDatalist();
  });
});

// ── Activity log — SSE-backed, real-time across all sessions ──────────────────
const MAX_ACTIVITY = 200;
const activityEntries = [];
let activityLastId = null;
let activityEvtSource = null;

function activitySseBadge(state, text) {
  const el = document.getElementById('activity-sse-badge');
  if (!el) return;
  el.className = 'act-sse-badge act-sse-' + state;
  el.textContent = text;
}

function activityConnectSSE() {
  if (activityEvtSource) {
    activityEvtSource.close();
    activityEvtSource = null;
  }
  activitySseBadge('connecting', '⏳ Connecting…');
  const url = '/ui/activity/stream' + (activityLastId ? '?_=' + Date.now() : '');
  const es = new EventSource(url);
  activityEvtSource = es;

  es.onopen = function() {
    activitySseBadge('connected', '● Live');
  };

  es.onmessage = function(evt) {
    activityLastId = evt.lastEventId || activityLastId;
    let event;
    try { event = JSON.parse(evt.data); } catch(e) { return; }
    // Prepend to list (newest first)
    activityEntries.unshift(event);
    if (activityEntries.length > MAX_ACTIVITY) activityEntries.pop();
    if (document.getElementById('panel-activity').classList.contains('active')) {
      renderActivityLog();
    }
  };

  es.onerror = function() {
    activitySseBadge('disconnected', '✗ Disconnected — reconnecting…');
    // Browser reconnects automatically; onerror fires on each failed attempt.
  };
}

// Start SSE immediately on page load.
activityConnectSSE();

function renderActivityLog() {
  const output = document.getElementById('activity-output');
  const statusEl = document.getElementById('activity-status');
  if (activityEntries.length === 0) {
    output.innerHTML = '<div class="act-empty">Waiting for events…</div>';
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = activityEntries.length + ' entries';
  const items = activityEntries.map(function(e) {
    const typeClass = e.type === 'ingest' ? 'act-type-ingest' : e.type === 'search' ? 'act-type-search' : e.type === 'query' ? 'act-type-query' : 'act-type-delete';
    const typeIcon  = e.type === 'ingest' ? '📥' : e.type === 'search' ? '🔍' : e.type === 'query' ? '📖' : '🗑️';
    const statusClass = e.status === 'ok' ? 'act-status-ok' : e.status === 'error' ? 'act-status-error' : 'act-status-running';
    const statusIcon  = e.status === 'ok' ? '✓' : e.status === 'error' ? '✗' : '⏳';
    const startedAt = new Date(e.timestamp || Date.now());
    const timeStr = startedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const durMs = e.duration_ms;
    const durStr = durMs != null ? (durMs < 1000 ? durMs + ' ms' : (durMs / 1000).toFixed(2) + ' s') : '';

    const usage = e.usage || (e.detail && e.detail.usage);
    let costStr = '';
    let usageHtml = '';
    if (usage && (typeof usage.total_cost === 'number' || typeof usage.cost === 'number')) {
      const totalCost = usage.total_cost ?? usage.cost;
      costStr = ' · $' + totalCost.toFixed(6);

      const modelCosts = usage.model_costs ?? usage.modelCosts ?? {};
      const modelList = Object.entries(modelCosts)
        .map(([m, c]) => '<code>' + escapeHtml(m) + '</code>: $' + Number(c).toFixed(6))
        .join(', ');
      if (totalCost > 0 || modelList) {
        usageHtml = '<div class="act-usage" style="font-size:0.75rem; color:#94a3b8; margin-bottom:0.5rem; padding:0.4rem; background:rgba(255,255,255,0.03); border-radius:4px;">' +
          '💵 <b>Cost:</b> $' + totalCost.toFixed(6) +
          (modelList ? ' (' + modelList + ')' : '') +
          '</div>';
      }
    }

    const detailJson = e.detail != null ? (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2)) : '';
    const escapedDetail = detailJson.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const safeId = 'act-' + (e.id || '').toString().replace(/[^a-zA-Z0-9_-]/g,'_');
    return '<div class="act-item" id="' + safeId + '">' +
      '<div class="act-header" onclick="(function(el){el.closest(\\'.act-item\\').classList.toggle(\\'open\\')})(this)">' +
        '<span class="act-type-badge ' + typeClass + '">' + typeIcon + ' ' + e.type + '</span>' +
        '<span class="act-status-badge ' + statusClass + '">' + statusIcon + ' ' + e.status + '</span>' +
        '<span class="act-summary">' + escapeHtml(e.summary) + '</span>' +
        '<span class="act-time">' + timeStr + (durStr ? ' · ' + durStr : '') + costStr + '</span>' +
        '<span class="act-chevron">▶</span>' +
      '</div>' +
      ((detailJson || usageHtml) ? '<div class="act-body">' + usageHtml + (detailJson ? '<pre>' + escapedDetail + '</pre>' : '') + (durStr ? '<div class="act-duration">⏱ ' + durStr + '</div>' : '') + '</div>' : '') +
    '</div>';
  }).join('');
  output.innerHTML = '<div class="act-list">' + items + '</div>';
}

document.getElementById('activity-clear-btn').addEventListener('click', function() {
  activityEntries.length = 0;
  renderActivityLog();
});


// ── Version field visibility ─────────────────────────────────────────────────
function setupVersionToggle(selectId, fieldId) {
  const select = document.getElementById(selectId);
  const field  = document.getElementById(fieldId);
  const toggle = () => { field.style.display = select.value === 'version' ? '' : 'none'; };
  select.addEventListener('change', toggle);
  toggle();
}
setupVersionToggle('ingest-version-mode', 'ingest-version-field');
setupVersionToggle('batch-version-mode',  'batch-version-field');

// ── Helpers ──────────────────────────────────────────────────────────────────
function hasNonAscii(str) { return /[^\\x00-\\x7F]/.test(str); }

function buildMetadataHeaders(metadataJson) {
  if (!metadataJson || metadataJson.trim() === '') return {};
  if (hasNonAscii(metadataJson)) {
    return { 'X-Metadata': 'base64:' + btoa(unescape(encodeURIComponent(metadataJson))) };
  }
  return { 'X-Metadata': metadataJson };
}

function showResult(divId, data, isError) {
  const div = document.getElementById(divId);
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  div.innerHTML = '<div class="result-label">' + (isError ? 'Error' : 'Response') + '</div>' + escapeHtml(text);
  div.className = 'result ' + (isError ? 'error' : 'success');
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function uiFetch(path, init) {
  const target = typeof path === 'string' && path.startsWith('/')
    ? '/ui' + path
    : path;
  return window.fetch(target, init);
}

function val(id) { return document.getElementById(id).value.trim(); }
function checked(id) { return document.getElementById(id).checked; }

function buildIngestHeaders(opts) {
  const h = { 'Content-Type': 'text/plain' };
  if (opts.reference)     h['X-Reference']      = opts.reference;
  if (opts.collection)    h['X-Collection']      = opts.collection;
  if (opts.versionMode)   h['X-Version-Mode']    = opts.versionMode;
  if (opts.versionMode === 'version' && opts.version) h['X-Version'] = opts.version;
  if (opts.title)         h['X-Title']           = opts.title;
  if (opts.source)        h['X-Source']          = opts.source;
  if (opts.link)          h['X-Link']            = opts.link;
  if (opts.tags)          h['X-Tags']            = opts.tags;
  if (opts.ftsLanguage)   h['X-FTS-Language']    = opts.ftsLanguage;
  if (opts.allowedUsers)  h['X-Allowed-Users']   = opts.allowedUsers;
  if (opts.allowedGroups) h['X-Allowed-Groups']  = opts.allowedGroups;
  if (opts.chunkSize)     h['X-Chunk-Size']      = opts.chunkSize;
  if (opts.chunkOverlap !== undefined && opts.chunkOverlap !== '') h['X-Chunk-Overlap'] = opts.chunkOverlap;
  if (opts.contextPrefixSize !== undefined && opts.contextPrefixSize !== '') h['X-Context-Prefix-Size'] = opts.contextPrefixSize;
  if (opts.breakpointPercentile !== undefined && opts.breakpointPercentile !== '') h['X-Breakpoint-Percentile'] = opts.breakpointPercentile;
  if (opts.lateChunkingAlpha !== undefined && opts.lateChunkingAlpha !== '') h['X-Late-Chunking-Alpha'] = opts.lateChunkingAlpha;
  if (opts.semanticChunking) h['X-Semantic-Chunking'] = '1';
  if (opts.summarize)     h['X-Summarize']       = '1';
  if (opts.chapterSplitMaxChunks !== undefined && opts.chapterSplitMaxChunks !== '') h['X-Chapter-Split-Max-Chunks'] = opts.chapterSplitMaxChunks;
  if (opts.quantization)  h['X-Quantization']    = opts.quantization;
  Object.assign(h, buildMetadataHeaders(opts.metadataJson));
  return h;
}

// ── Ingest ───────────────────────────────────────────────────────────────────
document.getElementById('ingest-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reference = val('ingest-reference');
  if (!reference) { showResult('ingest-result', 'X-Reference is required', true); return; }
  try {
    const response = await uiFetch('/ingest', {
      method: 'POST',
      headers: buildIngestHeaders({
        reference,
        collection:             val('ingest-collection'),
        versionMode:            val('ingest-version-mode'),
        version:                val('ingest-version'),
        title:                  val('ingest-title'),
        source:                 val('ingest-source'),
        link:                   val('ingest-link'),
        tags:                   val('ingest-tags'),
        ftsLanguage:            val('ingest-fts-language'),
        allowedUsers:           val('ingest-allowed-users'),
        allowedGroups:          val('ingest-allowed-groups'),
        chunkSize:              val('ingest-chunk-size'),
        chunkOverlap:           val('ingest-chunk-overlap'),
        contextPrefixSize:      val('ingest-context-prefix-size'),
        breakpointPercentile:   val('ingest-breakpoint-percentile'),
        lateChunkingAlpha:      val('ingest-late-chunking-alpha'),
        semanticChunking:       checked('ingest-semantic-chunking'),
        summarize:              checked('ingest-summarize'),
        chapterSplitMaxChunks:  val('ingest-chapter-split-max-chunks'),
        quantization:           val('ingest-quantization'),
        metadataJson:           val('ingest-metadata'),
      }),
      body: document.getElementById('ingest-text').value,
    });
    const json = await response.json();
    showResult('ingest-result', json, !response.ok);
  } catch (err) {
    showResult('ingest-result', 'Error: ' + err.message, true);
  }
});

// ── Search result renderer ────────────────────────────────────────────────────
function showSearchResults(divId, data, isError, searchParams, onNextPage, onPrevPage) {
  const div = document.getElementById(divId);
  if (isError) {
    div.innerHTML = '<div class="search-error-box"><div class="result-label">Error</div>' + escapeHtml(typeof data === 'string' ? data : JSON.stringify(data, null, 2)) + '</div>';
    div.className = 'search-output visible';
    return;
  }

  const results = data.results || [];
  const hydeQuery = data.hyde_query || null;
  const vector = data.query_vector || null;
  const nextCursor = data.next_cursor || null;

  // ── Method summary pills ──
  const pills = [
    { label: 'Rerank',            on: searchParams.rerank,                    icon: '🎯' },
    { label: 'Dense',          on: searchParams.searchMode === 'dense',     icon: '🧲' },
    { label: 'Hybrid',         on: searchParams.searchMode === 'hybrid',    icon: '⚡' },
    { label: 'FTS only',       on: searchParams.searchMode === 'fts',       icon: '📝' },
    { label: 'HyDE',              on: searchParams.hyde,                       icon: '🧠' },
    { label: 'All versions',      on: searchParams.allVersions,                icon: '📚' },
    { label: 'Group by document', on: searchParams.groupByDocument,            icon: '📄' },
  ];
  let pillsHtml = pills.map(p =>
    '<span class="pill ' + (p.on ? 'pill-on' : 'pill-off') + '">' + p.icon + ' ' + escapeHtml(p.label) + '</span>'
  ).join('');

  // Collection + limit pills
  pillsHtml += '<span class="pill pill-neutral">📁 ' + escapeHtml(searchParams.collection || 'documents') + '</span>';
  pillsHtml += '<span class="pill pill-neutral">🔢 limit ' + escapeHtml(String(searchParams.limit)) + '</span>';
  if (searchParams.pathPrefix) pillsHtml += '<span class="pill pill-neutral">🗂 ' + escapeHtml(searchParams.pathPrefix) + '</span>';
  if (nextCursor) pillsHtml += '<span class="pill pill-neutral">⏭ page ' + escapeHtml(String(searchParams.page || 1)) + '</span>';

  // ── Vector display ──
  let vectorHtml = '';
  if (vector && Array.isArray(vector)) {
    const preview = '[' + vector.slice(0, 8).map(v => v.toFixed(4)).join(', ') + (vector.length > 8 ? ', … (' + vector.length + ' dims)' : '') + ']';
    const full = JSON.stringify(vector);
    vectorHtml = '<div class="search-meta-vector">' +
      '<div class="vec-label">Query vector <span style="color:#6366f1;font-size:0.65rem">(click to copy full)</span></div>' +
      '<div class="vec-value" title="Click to copy" onclick="navigator.clipboard.writeText(' + "'" + full.replace(/'/g, "\\'") + "'" + ').then(()=>{ this.style.color=\\'#6ee7b7\\'; setTimeout(()=>this.style.color=\\'\\',1200); })">' +
      escapeHtml(preview) + '</div>' +
      '</div>';
  }

  let usageHtml = '';
  const usage = data.usage;
  if (usage && (typeof usage.total_cost === 'number' || typeof usage.cost === 'number')) {
    const totalCost = usage.total_cost ?? usage.cost;
    const modelCosts = usage.model_costs ?? usage.modelCosts ?? {};
    const modelList = Object.entries(modelCosts)
      .map(([m, c]) => '<span class="pill pill-neutral"><code>' + escapeHtml(m) + '</code>: $' + Number(c).toFixed(6) + '</span>')
      .join(' ');
    usageHtml = '<div class="search-meta-usage" style="margin-top:0.75rem; border-top:1px dashed #2d3748; padding-top:0.75rem;">' +
      '<div class="vec-label">💵 Incurred Cost</div>' +
      '<div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-top:0.25rem; align-items:center;">' +
      '<span class="pill pill-on">Total: $' + totalCost.toFixed(6) + '</span>' +
      modelList +
      '</div>' +
      '</div>';
  }

  const metaHtml = '<div class="search-meta-box">' +
    '<div class="meta-title">🔬 Search Method</div>' +
    '<div class="search-meta-pills">' + pillsHtml + '</div>' +
    vectorHtml +
    usageHtml +
    '</div>';

  // ── HyDE hypothetical answer ──
  let hydeHtml = '';
  if (hydeQuery) {
    hydeHtml = '<div class="hyde-box">' +
      '<div class="hyde-title">🧠 HyDE — hypothetical answer (used as query vector)</div>' +
      '<div class="hyde-text">' + escapeHtml(hydeQuery) + '</div>' +
      '</div>';
  }

  // ── Results table ──
  let tableHtml = '';
  if (results.length === 0) {
    tableHtml = '<div style="padding:1.5rem;text-align:center;color:#475569;font-size:0.85rem;">No results found.</div>';
  } else {
    // Determine which score columns exist
    const hasVecScore    = results.some(r => r.vector_score != null);
    const hasTextScore   = results.some(r => r.text_score   != null);
    const hasSparseScore = results.some(r => r.sparse_score != null);

    let thead = '<tr>' +
      '<th>#</th>' +
      '<th>Reference / Title</th>' +
      '<th>Content</th>' +
      '<th>Score</th>' +
      '</tr>';

    let tbody = results.map((r, i) => {
      // Reference + title + link
      const refHtml = '<div class="sr-ref">' + escapeHtml(r.reference || '') + '</div>';
      const titleHtml = r.title ? '<div class="sr-title">' + escapeHtml(r.title) + '</div>' : '';
      const linkHtml  = r.link
        ? '<div class="sr-link"><a href="' + escapeHtml(r.link) + '" target="_blank" rel="noopener">' + escapeHtml(r.title || r.link) + ' ↗</a></div>'
        : '';

      // Content with expand toggle
      const contentId = 'src-content-' + i;
      const detailsRowId = 'sr-details-' + i;
      const docBtnId = 'sr-doc-btn-' + i;
      const contentHtml =
        '<div class="sr-content">' +
        '<div class="sr-content-inner" id="' + contentId + '">' + escapeHtml(r.content || '') + '</div>' +
        '<button type="button" class="sr-expand" onclick="(function(btn,id){var el=document.getElementById(id);var exp=el.classList.toggle(\\'expanded\\');btn.textContent=exp?\\'▲ less\\':\\'▼ more\\';})(this,\\'' + contentId + '\\')" >▼ more</button>' +
        '<button type="button" class="sr-details-btn" onclick="(function(btn,id){var row=document.getElementById(id);var open=row.classList.toggle(\\'open\\');btn.innerHTML=open?\\'▲ Details\\':\\'▼ Details\\';})(this,\\'' + detailsRowId + '\\')" >▼ Details</button>' +
        '<button type="button" class="sr-doc-btn" id="' + docBtnId + '" data-ref="' + escapeHtml(r.base_ref || r.reference || '') + '" data-collection="' + escapeHtml(searchParams.collection || 'documents') + '" data-matched-id="' + escapeHtml(String(r.id || '')) + '">📄 Document</button>' +
        '</div>';

      // Scores
      let scoreHtml = '<div class="sr-scores">';
      scoreHtml += '<div class="score-main">' + (typeof r.score === 'number' ? r.score.toFixed(4) : '—') + '</div>';
      let subScores = [];
      if (hasVecScore    && r.vector_score  != null) subScores.push('<span title="Vector score">vec ' + r.vector_score.toFixed(4) + '</span>');
      if (hasTextScore   && r.text_score   != null) subScores.push('<span title="PostgreSQL FTS/ts_rank score">txt ' + r.text_score.toFixed(4) + '</span>');
      if (hasSparseScore && r.sparse_score != null) subScores.push('<span title="Sparse score">sps ' + r.sparse_score.toFixed(4) + '</span>');
      if (subScores.length) scoreHtml += '<div class="score-sub">' + subScores.join('') + '</div>';
      scoreHtml += '</div>';

      // ── Detail fields ──
      function detailItem(label, value) {
        let display;
        if (value === undefined || value === null || value === '') {
          display = '<span class="sr-detail-value empty">—</span>';
        } else if (Array.isArray(value)) {
          display = value.length
            ? value.map(function(t) { return '<span class="sr-detail-tag">' + escapeHtml(String(t)) + '</span>'; }).join('')
            : '<span class="sr-detail-value empty">—</span>';
        } else if (typeof value === 'object') {
          const json = JSON.stringify(value, null, 2);
          display = '<span class="sr-detail-value">' + escapeHtml(json) + '</span>';
        } else {
          display = '<span class="sr-detail-value">' + escapeHtml(String(value)) + '</span>';
        }
        return '<div class="sr-detail-item"><div class="sr-detail-label">' + escapeHtml(label) + '</div>' + display + '</div>';
      }

      const fmt = function(d) { return d ? new Date(d).toLocaleString() : undefined; };
      const metaStr = r.metadata && Object.keys(r.metadata).length ? r.metadata : null;

      const detailsHtml =
        '<div class="sr-details-grid">' +
        detailItem('Created',  fmt(r.created)) +
        detailItem('Modified', fmt(r.modified)) +
        detailItem('Source',   r.source) +
        detailItem('Tags',     r.tags) +
        detailItem('Prefix',   r.prefix) +
        detailItem('Metadata', metaStr) +
        '</div>';

      const detailsRow = '<tr class="sr-details-row" id="' + detailsRowId + '">' +
        '<td colspan="4">' + detailsHtml + '</td>' +
        '</tr>';

      return '<tr>' +
        '<td><span class="sr-rank">' + (i + 1) + '</span></td>' +
        '<td>' + refHtml + titleHtml + linkHtml + '</td>' +
        '<td>' + contentHtml + '</td>' +
        '<td>' + scoreHtml + '</td>' +
        '</tr>' + detailsRow;
    }).join('');

    tableHtml = '<div class="search-table-wrap">' +
      '<div class="search-table-header">' +
      '<span class="tbl-title">Results</span>' +
      '<span class="tbl-count">' + results.length + ' hits</span>' +
      '</div>' +
      '<div style="overflow-x:auto"><table class="sr-table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>' +
      '</div>';
  }

  // ── Pagination bar ──
  let paginationHtml = '';
  if (onPrevPage || nextCursor) {
    paginationHtml = '<div class="sr-pagination">';
    if (onPrevPage) {
      paginationHtml += '<button type="button" class="btn btn-secondary sr-page-btn" id="sr-prev-btn">← Back</button>';
    } else {
      paginationHtml += '<span></span>';
    }
    if (searchParams.page && searchParams.page > 1) {
      paginationHtml += '<span class="sr-page-info">Page ' + escapeHtml(String(searchParams.page)) + '</span>';
    } else if (onPrevPage) {
      paginationHtml += '<span class="sr-page-info">Page ' + escapeHtml(String(searchParams.page || 1)) + '</span>';
    }
    if (nextCursor) {
      paginationHtml += '<button type="button" class="btn btn-secondary sr-page-btn" id="sr-next-btn">Next page →</button>';
    } else {
      paginationHtml += '<span></span>';
    }
    paginationHtml += '</div>';
  }

  div.innerHTML = metaHtml + hydeHtml + tableHtml + paginationHtml;
  div.className = 'search-output visible';

  if (onPrevPage) {
    const prevBtn = document.getElementById('sr-prev-btn');
    if (prevBtn) prevBtn.addEventListener('click', onPrevPage);
  }
  if (nextCursor && onNextPage) {
    const nextBtn = document.getElementById('sr-next-btn');
    if (nextBtn) nextBtn.addEventListener('click', function() { onNextPage(nextCursor); });
  }

  // Attach doc-view button listeners
  div.querySelectorAll('.sr-doc-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openDocModal(btn.dataset.ref, btn.dataset.collection, btn.dataset.matchedId);
    });
  });
}

// ── Document modal ───────────────────────────────────────────────────────────
function openDocModal(reference, collection, matchedChunkId) {
  // Create overlay
  var overlay = document.createElement('div');
  overlay.className = 'doc-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Document: ' + reference);

  overlay.innerHTML =
    '<div class="doc-modal">' +
      '<div class="doc-modal-header">' +
        '<span class="doc-modal-title">📄 ' + escapeHtml(reference) + '</span>' +
        '<button type="button" class="doc-modal-close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="doc-modal-body"><div class="doc-modal-loading">⏳ Loading chunks…</div></div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Close on overlay click or button
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) { document.body.removeChild(overlay); }
  });
  overlay.querySelector('.doc-modal-close').addEventListener('click', function() {
    document.body.removeChild(overlay);
  });
  // Close on Escape
  function onKey(e) { if (e.key === 'Escape') { document.body.removeChild(overlay); document.removeEventListener('keydown', onKey); } }
  document.addEventListener('keydown', onKey);

  // Fetch all chunks for this reference (use a high limit, include all versions to get full picture)
  var headers = {
    'Content-Type':  'text/plain',
    'X-Max-Results': '200',
    'X-Search-Mode': 'fts',
    'X-Include-All-Versions': '0',
    'X-Base-Ref': reference,
  };
  if (collection) headers['X-Collection'] = collection;

  // Send a wildcard-ish body; the base_ref filter on the server ensures we get all chunks
  uiFetch('/search', { method: 'POST', headers: headers, body: reference })
    .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
    .then(function(r) {
      if (!r.ok) {
        overlay.querySelector('.doc-modal-body').innerHTML =
          '<div class="search-error-box">Failed to load: ' + escapeHtml(r.data.error || 'Unknown error') + '</div>';
        return;
      }
      var chunks = r.data.results || [];
      // Sort by chunk_index (inside the chunk object), otherwise by id
      chunks.sort(function(a, b) {
        var ai = (a.chunk && a.chunk.chunk_index != null) ? a.chunk.chunk_index : 0;
        var bi = (b.chunk && b.chunk.chunk_index != null) ? b.chunk.chunk_index : 0;
        if (ai !== bi) return ai - bi;
        return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      renderDocModal(overlay.querySelector('.doc-modal-body'), reference, chunks, matchedChunkId);
    })
    .catch(function(err) {
      overlay.querySelector('.doc-modal-body').innerHTML =
        '<div class="search-error-box">Network error: ' + escapeHtml(err.message) + '</div>';
    });
}

function renderDocModal(container, reference, chunks, matchedChunkId) {
  if (chunks.length === 0) {
    container.innerHTML = '<div class="doc-modal-loading">No chunks found for <em>' + escapeHtml(reference) + '</em>.</div>';
    return;
  }

  // ── Meta section (from first chunk) ──
  var first = chunks[0];
  function metaItem(label, value) {
    var v;
    if (!value && value !== 0) {
      v = '<span style="color:#334155;font-style:italic">—</span>';
    } else if (Array.isArray(value)) {
      v = value.map(function(t) { return '<span class="doc-meta-tag">' + escapeHtml(String(t)) + '</span>'; }).join('') || '<span style="color:#334155;font-style:italic">—</span>';
    } else if (typeof value === 'object') {
      v = '<span class="doc-meta-value">' + escapeHtml(JSON.stringify(value, null, 2)) + '</span>';
    } else {
      var s = String(value);
      if (/^https?:\\/\\//.test(s)) {
        v = '<a href="' + escapeHtml(s) + '" target="_blank" rel="noopener">' + escapeHtml(s) + ' ↗</a>';
      } else {
        v = escapeHtml(s);
      }
    }
    return '<div class="doc-meta-item"><div class="doc-meta-label">' + escapeHtml(label) + '</div><div class="doc-meta-value">' + v + '</div></div>';
  }

  var fmt = function(d) { return d ? new Date(d).toLocaleString() : undefined; };

  var metaHtml =
    '<div class="doc-meta-section">' +
    '<div class="doc-section-title">📋 Document info</div>' +
    '<div class="doc-meta-grid">' +
    metaItem('Reference', first.reference) +
    metaItem('Title',     first.title) +
    metaItem('Source',    first.source) +
    metaItem('Link',      first.link) +
    metaItem('Tags',      first.tags) +
    metaItem('Created',   fmt(first.created)) +
    metaItem('Modified',  fmt(first.modified)) +
    metaItem('Metadata',  first.metadata && Object.keys(first.metadata || {}).length ? first.metadata : null) +
    '</div></div>';

  // ── Prefix section ──
  var prefixHtml = '';
  if (first.prefix) {
    prefixHtml =
      '<div class="doc-prefix-section">' +
      '<div class="doc-section-title">🏷️ Prefix (context prefix)</div>' +
      '<div class="doc-prefix-text">' + escapeHtml(first.prefix) + '</div>' +
      '</div>';
  }

  // ── Overlap detection & chunk rendering ──
  // We detect overlaps by finding the longest common suffix/prefix between adjacent chunks.
  // We highlight:
  //   - end of chunk N: the part that also appears at the start of chunk N+1  (amber = "overlap-end")
  //   - start of chunk N+1: the part that also appeared at the end of chunk N  (purple = "overlap-start")
  //   - if a chunk is entirely within another (edge case): both colours → "overlap-both"

  function findOverlapLength(textA, textB) {
    // Find longest suffix of textA that is a prefix of textB
    var maxLen = Math.min(textA.length, textB.length);
    for (var l = maxLen; l > 0; l--) {
      if (textA.slice(textA.length - l) === textB.slice(0, l)) return l;
    }
    return 0;
  }

  // Build overlap metadata for each chunk
  var overlapMeta = chunks.map(function() { return { overlapEnd: 0, overlapStart: 0 }; });
  for (var i = 0; i < chunks.length - 1; i++) {
    var a = chunks[i].content || '';
    var b = chunks[i + 1].content || '';
    var ol = findOverlapLength(a, b);
    overlapMeta[i].overlapEnd = ol;
    overlapMeta[i + 1].overlapStart = ol;
  }

  var legendHtml =
    '<div class="doc-overlap-legend">' +
    '<span><span class="legend-swatch legend-end"></span> End overlap (this chunk ends with the start of the next one)</span>' +
    '<span><span class="legend-swatch legend-start"></span> Start overlap (this chunk begins with the end of the previous one)</span>' +
    '</div>';

  var chunksHtml = '<div class="doc-chunks-section">';
  chunksHtml += '<div class="doc-chunks-title">📦 ' + chunks.length + ' Chunk' + (chunks.length !== 1 ? 's' : '') + '</div>';
  chunksHtml += legendHtml;

  for (var ci = 0; ci < chunks.length; ci++) {
    var chunk = chunks[ci];
    var meta  = overlapMeta[ci];
    var text  = chunk.content || '';
    var isMatched = String(chunk.id) === String(matchedChunkId);

    // Build header badges
    var headerBadges = '';
    if (isMatched) {
      headerBadges += '<span class="doc-chunk-matched-badge">⭐ matched chunk</span>';
    }
    if (typeof chunk.score === 'number') {
      headerBadges += '<span class="doc-chunk-score-badge">Score ' + chunk.score.toFixed(4) + '</span>';
    }

    // Split text into: overlap-start | middle | overlap-end
    var overlapStartLen = meta.overlapStart;
    var overlapEndLen   = meta.overlapEnd;
    var bodyHtml;

    if (overlapStartLen > 0 || overlapEndLen > 0) {
      // Compute regions — handle the case where start and end might overlap each other
      var startPart  = text.slice(0, overlapStartLen);
      var endPart    = text.slice(text.length - overlapEndLen);
      var middleStart = overlapStartLen;
      var middleEnd   = text.length - overlapEndLen;

      if (middleStart >= middleEnd) {
        // The whole chunk is overlapping on both sides
        bodyHtml = '<span class="doc-chunk-overlap-both">' + escapeHtml(text) + '</span>';
      } else {
        var middlePart = text.slice(middleStart, middleEnd);
        bodyHtml = '';
        if (startPart) bodyHtml += '<span class="doc-chunk-overlap-start" title="Overlap with previous chunk">' + escapeHtml(startPart) + '</span>';
        bodyHtml += escapeHtml(middlePart);
        if (endPart)   bodyHtml += '<span class="doc-chunk-overlap-end" title="Overlap with next chunk">' + escapeHtml(endPart) + '</span>';
      }
    } else {
      bodyHtml = escapeHtml(text);
    }

    var chunkBlockStyle = isMatched ? ' style="border-color:#6366f1;box-shadow:0 0 0 2px rgba(99,102,241,0.25)"' : '';

    chunksHtml +=
      '<div class="doc-chunk-block"' + chunkBlockStyle + '>' +
        '<div class="doc-chunk-header">' +
          '<span class="doc-chunk-num">Chunk ' + (ci + 1) + '</span>' +
          '<span style="color:#475569;font-size:0.65rem">' + text.length + ' chars</span>' +
          (meta.overlapStart > 0 ? '<span style="color:#8b5cf6;font-size:0.65rem">↑ ' + meta.overlapStart + ' chars overlap with prev.</span>' : '') +
          (meta.overlapEnd   > 0 ? '<span style="color:#f59e0b;font-size:0.65rem">↓ ' + meta.overlapEnd   + ' chars overlap with next</span>' : '') +
          headerBadges +
        '</div>' +
        '<div class="doc-chunk-body"><div class="doc-chunk-text">' + bodyHtml + '</div></div>' +
        (ci < chunks.length - 1
          ? '<div class="doc-chunk-boundary"><span></span>— Chunk ' + (ci + 1) + ' end · Chunk ' + (ci + 2) + ' start —<span></span></div>'
          : '') +
      '</div>';
  }
  chunksHtml += '</div>';

  container.innerHTML = metaHtml + prefixHtml + chunksHtml;

  // Scroll matched chunk into view
  if (matchedChunkId) {
    var blocks = container.querySelectorAll('.doc-chunk-block');
    for (var bi = 0; bi < blocks.length; bi++) {
      if (blocks[bi].style.borderColor === 'rgb(99, 102, 241)') {
        blocks[bi].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        break;
      }
    }
  }
}

// ── Search ───────────────────────────────────────────────────────────────────
(function() {
  // cursorHistory[i] = X-Cursor value for page i+1 (undefined = page 1, no cursor)
  // currentPage is 1-based
  let cursorHistory = [];
  let currentPage = 0;

  async function doSearch(cursor, page) {
    const query = val('search-query');
    if (!query) {
      const div = document.getElementById('search-result');
      div.innerHTML = '<div class="search-error-box">Query must not be empty.</div>';
      div.className = 'search-output visible';
      return;
    }

    // Clear the result list immediately and show the spinner
    const resultDiv = document.getElementById('search-result');
    resultDiv.innerHTML = '<div class="search-spinner">Searching…</div>';
    resultDiv.className = 'search-output visible';

    const collection = val('search-collection');
    const searchMode = document.querySelector('input[name="search-mode"]:checked')?.value || 'hybrid';

    try {
      const headers = {
        'Content-Type':  'text/plain',
        'X-Max-Results': val('search-max-results') || '10',
        'X-Search-Mode': searchMode,
        ...buildMetadataHeaders(val('search-metadata')),
      };
      // Cursor-based pagination takes precedence over offset
      if (cursor) {
        headers['X-Cursor'] = cursor;
      } else {
        const offset = val('search-offset');
        if (offset) headers['X-Offset'] = offset;
      }
      if (collection)                     headers['X-Collection']            = collection;
      if (checked('search-rerank'))           headers['X-Rerank']                = '1';
      if (checked('search-hyde'))             headers['X-Hyde']                  = '1';
      if (checked('search-all-versions'))     headers['X-Include-All-Versions']  = '1';
      if (checked('search-group-by-document')) headers['X-Group-By-Document']    = '1';
      if (checked('search-include-vector'))   headers['X-Include-Query-Vector']  = '1';
      const pathPrefix = val('search-path-prefix');
      if (pathPrefix)                     headers['X-Path-Prefix']           = pathPrefix;
      const filter = val('search-filter');
      if (filter)                         headers['X-Filter']                = filter;
      const tags = val('search-tags');
      if (tags)                           headers['X-Tags']                  = tags;

      const response = await uiFetch('/search', { method: 'POST', headers, body: query });
      const data = await response.json();
      currentPage = page;

      const searchParams = {
        rerank:          checked('search-rerank'),
        searchMode,
        hyde:            checked('search-hyde'),
        allVersions:     checked('search-all-versions'),
        groupByDocument: checked('search-group-by-document'),
        includeVector:   checked('search-include-vector'),
        pathPrefix:      val('search-path-prefix'),
        collection:      collection || 'documents',
        limit:           val('search-max-results') || '10',
        page,
      };

      const onNext = function(nextCursor) {
        // Remember the cursor for the next page (if not known yet)
        if (cursorHistory.length < page) cursorHistory.push(nextCursor);
        doSearch(nextCursor, page + 1);
      };

      const onPrev = page > 1 ? function() {
        const prevCursor = page >= 3 ? cursorHistory[page - 3] : undefined;
        doSearch(prevCursor, page - 1);
      } : null;

      showSearchResults('search-result', data, !response.ok, searchParams, onNext, onPrev);
    } catch (err) {
      const div = document.getElementById('search-result');
      div.innerHTML = '<div class="search-error-box">Error: ' + escapeHtml(err.message) + '</div>';
      div.className = 'search-output visible';
    }
  }

  document.getElementById('search-form').addEventListener('submit', function(e) {
    e.preventDefault();
    cursorHistory = [];
    currentPage = 0;
    doSearch(undefined, 1);
  });
})();

// ── Delete ───────────────────────────────────────────────────────────────────
document.getElementById('delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reference = val('delete-reference');
  const collection = val('delete-collection');
  try {
    const headers = { ...buildMetadataHeaders(val('delete-metadata')) };
    if (reference)  headers['X-Reference']  = reference;
    if (collection) headers['X-Collection'] = collection;
    const response = await uiFetch('/delete', { method: 'DELETE', headers });
    const json = await response.json();
    showResult('delete-result', json, !response.ok);
  } catch (err) {
    showResult('delete-result', 'Error: ' + err.message, true);
  }
});

// ── Query (read-only) ─────────────────────────────────────────────────────────
(function() {
  // Which fields each operation uses.
  const OP_FIELDS = {
    list_documents:   ['path-prefix', 'limit', 'offset'],
    get_document:     ['reference', 'max-chars', 'offset'],
    get_documents:    ['path-prefix', 'limit', 'max-chars'],
    list_folders:     ['path-prefix', 'depth'],
    get_summary:      ['reference'],
    get_summaries:    ['path-prefix', 'limit', 'offset'],
    collection_stats: ['path-prefix'],
  };
  const ALL_FIELDS = ['reference', 'path-prefix', 'limit', 'offset', 'depth', 'max-chars'];

  function syncQueryFields() {
    const op = document.getElementById('query-op').value;
    const active = OP_FIELDS[op] || [];
    ALL_FIELDS.forEach(function(f) {
      const el = document.getElementById('query-field-' + f);
      if (el) el.style.display = active.indexOf(f) >= 0 ? '' : 'none';
    });
  }

  document.getElementById('query-op').addEventListener('change', syncQueryFields);
  syncQueryFields();

  document.getElementById('query-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const op = document.getElementById('query-op').value;
    const collection = val('query-collection');
    const reference = val('query-reference');
    const pathPrefix = val('query-path-prefix');
    const limit = val('query-limit');
    const offset = val('query-offset');
    const depth = val('query-depth');
    const maxChars = val('query-max-chars');
    const active = OP_FIELDS[op] || [];

    // reference is required for get_document / get_summary
    if (active.indexOf('reference') >= 0 && !reference) {
      showResult('query-result', 'Error: reference is required for ' + op, true);
      return;
    }

    const params = new URLSearchParams();
    if (collection) params.set('collection', collection);
    if (active.indexOf('reference') >= 0 && reference) params.set('reference', reference);
    if (active.indexOf('path-prefix') >= 0 && pathPrefix) params.set('path_prefix', pathPrefix);
    if (active.indexOf('limit') >= 0 && limit) params.set('limit', limit);
    if (active.indexOf('offset') >= 0 && offset) params.set('offset', offset);
    if (active.indexOf('depth') >= 0 && depth) params.set('depth', depth);
    if (active.indexOf('max-chars') >= 0 && maxChars) params.set('max_chars', maxChars);

    const PATHS = {
      list_documents:   '/documents',
      get_document:     '/document',
      get_documents:    '/documents/content',
      list_folders:     '/folders',
      get_summary:      '/summary',
      get_summaries:    '/summaries',
      collection_stats: '/collection-stats',
    };
    const qs = params.toString();
    const url = PATHS[op] + (qs ? '?' + qs : '');

    const div = document.getElementById('query-result');
    div.className = 'result';
    div.innerHTML = '<div class="result-label">…</div>Running…';
    try {
      const response = await uiFetch(url);
      const json = await response.json();
      showResult('query-result', json, !response.ok);
    } catch (err) {
      showResult('query-result', 'Error: ' + err.message, true);
    }
  });
})();

// ── Collection dropdown (datalist) population ─────────────────────────────────
function populateCollectionsDatalist() {
  uiFetch('/collections')
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(data) {
      if (!data || !data.collections) return;
      const dl = document.getElementById('collections-datalist');
      if (!dl) return;
      dl.innerHTML = data.collections
        .map(function(c) { return '<option value="' + escapeHtml(c.collection) + '"></option>'; })
        .join('');
    })
    .catch(function() { /* non-fatal: inputs still accept free text */ });
}
populateCollectionsDatalist();

// ── Batch Ingest ─────────────────────────────────────────────────────────────
const batchFiles = [];

function fileBaseName(name) {
  return name.replace(/\\.[^.]+$/, '');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderFileList() {
  const list = document.getElementById('batch-file-list');
  list.innerHTML = '';
  batchFiles.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.index = i;
    item.innerHTML =
      '<span class="file-name" title="' + escapeHtml(f.file.name) + '">' + escapeHtml(f.file.name) + '</span>' +
      '<span class="file-size">' + formatBytes(f.file.size) + '</span>' +
      '<span class="file-status pending" id="batch-status-' + i + '">pending</span>' +
      '<button type="button" class="file-remove" aria-label="Remove" data-index="' + i + '">✕</button>';
    list.appendChild(item);
  });
  list.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      batchFiles.splice(Number(btn.dataset.index), 1);
      renderFileList();
      updateBatchBtn();
    });
  });
  updateBatchBtn();
}

function updateBatchBtn() {
  document.getElementById('batch-ingest-btn').disabled = batchFiles.length === 0;
}

function addFiles(fileList) {
  Array.from(fileList).forEach(f => {
    if (!batchFiles.find(e => e.file.name === f.name && e.file.size === f.size)) {
      batchFiles.push({ file: f });
    }
  });
  renderFileList();
}

const dropzone = document.getElementById('batch-dropzone');
const fileInput = document.getElementById('batch-file-input');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});

document.getElementById('batch-clear-btn').addEventListener('click', () => {
  batchFiles.length = 0;
  renderFileList();
  document.getElementById('batch-progress').textContent = '';
  const r = document.getElementById('batch-result');
  r.className = 'result'; r.innerHTML = '';
});

document.getElementById('batch-ingest-btn').addEventListener('click', async () => {
  if (batchFiles.length === 0) return;
  const btn = document.getElementById('batch-ingest-btn');
  btn.disabled = true;

  const commonOpts = {
    collection:           val('batch-collection'),
    versionMode:          val('batch-version-mode'),
    version:              val('batch-version'),
    title:                val('batch-title'),
    source:               val('batch-source'),
    link:                 val('batch-link'),
    tags:                 val('batch-tags'),
    ftsLanguage:          val('batch-fts-language'),
    allowedUsers:         val('batch-allowed-users'),
    allowedGroups:        val('batch-allowed-groups'),
    chunkSize:            val('batch-chunk-size'),
    chunkOverlap:         val('batch-chunk-overlap'),
    contextPrefixSize:    val('batch-context-prefix-size'),
    breakpointPercentile: val('batch-breakpoint-percentile'),
    lateChunkingAlpha:    val('batch-late-chunking-alpha'),
    semanticChunking:     checked('batch-semantic-chunking'),
    summarize:            checked('batch-summarize'),
    quantization:         val('batch-quantization'),
    metadataJson:         val('batch-metadata'),
  };

  let done = 0, errors = 0;
  const progress = document.getElementById('batch-progress');
  const updateProgress = () => {
    progress.textContent = done + '/' + batchFiles.length + ' done' + (errors ? ', ' + errors + ' error(s)' : '');
  };
  updateProgress();

  // Shared options → request headers (reuse the single-ingest builder, then
  // switch the content type). Per-document fields (reference/title/source/link/
  // tags/allowed*) travel inside each NDJSON line instead.
  const sharedHeaders = buildIngestHeaders({
    collection:           commonOpts.collection,
    versionMode:          commonOpts.versionMode,
    version:              commonOpts.version,
    ftsLanguage:          commonOpts.ftsLanguage,
    chunkSize:            commonOpts.chunkSize,
    chunkOverlap:         commonOpts.chunkOverlap,
    contextPrefixSize:    commonOpts.contextPrefixSize,
    breakpointPercentile: commonOpts.breakpointPercentile,
    lateChunkingAlpha:    commonOpts.lateChunkingAlpha,
    semanticChunking:     commonOpts.semanticChunking,
    summarize:            commonOpts.summarize,
    chapterSplitMaxChunks: commonOpts.chapterSplitMaxChunks,
    quantization:         commonOpts.quantization,
    metadataJson:         commonOpts.metadataJson,
  });
  sharedHeaders['Content-Type'] = 'application/x-ndjson';

  const toArr = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const sharedTags = toArr(commonOpts.tags);
  const sharedUsers = toArr(commonOpts.allowedUsers);
  const sharedGroups = toArr(commonOpts.allowedGroups);

  // Read all files and build the NDJSON body. Map reference → file index so
  // streamed per-document results can update the right row.
  const results = [];
  const refToIndex = {};
  const lines = [];
  for (let i = 0; i < batchFiles.length; i++) {
    const entry = batchFiles[i];
    const statusEl = document.getElementById('batch-status-' + i);
    let text;
    try {
      text = await entry.file.text();
    } catch (err) {
      if (statusEl) { statusEl.className = 'file-status err'; statusEl.textContent = 'read error'; }
      errors++; done++;
      results.push({ file: entry.file.name, error: 'Could not read file: ' + err.message });
      updateProgress();
      continue;
    }
    const reference = fileBaseName(entry.file.name);
    refToIndex[reference] = i;
    if (statusEl) { statusEl.className = 'file-status pending'; statusEl.textContent = 'queued…'; }
    const doc = { reference, content: text };
    if (commonOpts.title)  doc.title = commonOpts.title;
    if (commonOpts.source) doc.source = commonOpts.source;
    if (commonOpts.link)   doc.link = commonOpts.link;
    if (sharedTags)   doc.tags = sharedTags;
    if (sharedUsers)  doc.allowedUsers = sharedUsers;
    if (sharedGroups) doc.allowedGroups = sharedGroups;
    lines.push(JSON.stringify(doc));
  }

  if (lines.length === 0) {
    showResult('batch-result', results, true);
    btn.disabled = false;
    return;
  }

  try {
    const response = await uiFetch('/ingest-stream', {
      method: 'POST',
      headers: sharedHeaders,
      body: lines.join('\\n'),
    });

    if (!response.ok || !response.body) {
      const json = await response.json().catch(() => ({}));
      throw new Error(json.error || ('HTTP ' + response.status));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { return; }
      if (ev.status === 'ok' && ev.total !== undefined) return; // final summary line
      if (typeof ev.reference === 'string' && ev.reference.charAt(0) === '_') {
        // Sub-batch level error (e.g. _batch_error / _upsert_error).
        errors++;
        results.push({ error: ev.error || ev.reference });
        return;
      }
      const idx = refToIndex[ev.reference];
      const statusEl = idx !== undefined ? document.getElementById('batch-status-' + idx) : null;
      if (ev.error) {
        if (statusEl) { statusEl.className = 'file-status err'; statusEl.textContent = 'error'; }
        errors++;
        results.push({ reference: ev.reference, error: ev.error });
      } else {
        if (statusEl) { statusEl.className = 'file-status ok'; statusEl.textContent = ev.chunks ? ev.chunks + ' chunks' : 'ok'; }
        results.push({ reference: ev.reference, ids: ev.ids, chunks: ev.chunks });
      }
      done++;
      updateProgress();
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await reader.read();
      if (r.done) { handleLine(buf); break; }
      buf += decoder.decode(r.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\\n')) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }

    // Mark any file that never received a result line as failed.
    for (let i = 0; i < batchFiles.length; i++) {
      const statusEl = document.getElementById('batch-status-' + i);
      if (statusEl && statusEl.className.indexOf('pending') >= 0) {
        statusEl.className = 'file-status err';
        statusEl.textContent = 'no result';
      }
    }
    showResult('batch-result', results, errors > 0);
  } catch (err) {
    showResult('batch-result', 'Stream ingest failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ── Collections overview ──────────────────────────────────────────────────────
(function() {
  var output = document.getElementById('collections-output');
  var status = document.getElementById('collections-status');

  function fmt(d) {
    return d ? new Date(d).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) : '—';
  }

  function badge(on, labelOn, labelOff) {
    return on
      ? '<span class="coll-badge coll-badge-on">✓ ' + escapeHtml(labelOn) + '</span>'
      : '<span class="coll-badge coll-badge-off">✗ ' + escapeHtml(labelOff || labelOn) + '</span>';
  }

  function renderCollections(collections) {
    if (collections.length === 0) {
      output.innerHTML = '<div class="coll-table-wrap"><div class="coll-empty">No collections yet. Ingest a document to create one.</div></div>';
      return;
    }

    var thead = '<tr>' +
      '<th>Collection</th>' +
      '<th>Documents</th>' +
      '<th>Chunks</th>' +
      '<th>Vector</th>' +
      '<th>Search</th>' +
      '<th>FTS Language</th>' +
      '<th>Access</th>' +
      '<th>Created</th>' +
      '<th></th>' +
      '</tr>';

    var tbody = collections.map(function(c) {
      var vectorCell = c.vectorSize
        ? '<span class="coll-mono">' + c.vectorSize + ' dims</span>' +
          (c.quantization === 'binary'
            ? '<br><span class="coll-badge coll-badge-bin" style="margin-top:0.3rem">⚡ binary</span>'
            : '')
        : '<span class="coll-mono" style="color:#334155">—</span>';

      var searchCell =
        badge(true, 'dense') + ' ' +
        badge(c.sparseEnabled, 'sparse') + ' ';

      var chunksCell = c.totalChunks !== c.totalDocs
        ? '<div class="coll-count-big">' + c.totalChunks.toLocaleString() + '</div>' +
          '<div class="coll-count-sub">across ' + c.totalDocs.toLocaleString() + ' docs</div>'
        : '<div class="coll-count-big">' + c.totalChunks.toLocaleString() + '</div>';

      var docsCell =
        '<div class="coll-count-big">' + c.totalDocs.toLocaleString() + '</div>' +
        '<div class="coll-count-sub">latest versions</div>';

      var nUsers = (c.allowedUsers || []).length;
      var nGroups = (c.allowedGroups || []).length;
      var accessCell = (nUsers || nGroups)
        ? '<span class="coll-badge coll-badge-bin" title="' +
            escapeHtml((c.allowedUsers || []).join(', ') + (nGroups ? ' | groups: ' + (c.allowedGroups || []).join(', ') : '')) +
          '">🔒 ' + nUsers + 'u / ' + nGroups + 'g</span>'
        : '<span class="coll-badge coll-badge-off">public</span>';

      return '<tr>' +
        '<td><div class="coll-name coll-open" data-name="' + escapeHtml(c.collection) + '" title="Open folder browser" style="cursor:pointer">📂 ' + escapeHtml(c.collection) + '</div></td>' +
        '<td>' + docsCell + '</td>' +
        '<td>' + chunksCell + '</td>' +
        '<td>' + vectorCell + '</td>' +
        '<td>' + searchCell + '</td>' +
        '<td><span class="coll-mono">' + escapeHtml(c.ftsLanguage) + '</span></td>' +
        '<td>' + accessCell + '</td>' +
        '<td><span class="coll-mono">' + fmt(c.created) + '</span></td>' +
        '<td style="white-space:nowrap">' +
          '<button type="button" class="coll-perms-btn" data-name="' + escapeHtml(c.collection) + '" title="Edit which users/groups may access this collection">🔒 Permissions</button>' +
          '<button type="button" class="coll-rename-btn" data-name="' + escapeHtml(c.collection) + '" title="Rename this collection">✏ Rename</button>' +
          '<button type="button" class="coll-summary-btn" data-name="' + escapeHtml(c.collection) + '" title="Generate summaries for all documents that are missing one">✨ Summaries</button>' +
          '<button type="button" class="coll-delete-btn" data-name="' + escapeHtml(c.collection) + '">🗑 Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    output.innerHTML =
      '<div class="coll-table-wrap">' +
      '<div style="overflow-x:auto"><table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>' +
      '</div>';

    output.querySelectorAll('.coll-open').forEach(function(el) {
      el.addEventListener('click', function() {
        openBrowser(el.dataset.name);
      });
    });

    output.querySelectorAll('.coll-perms-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        editPermissions(btn.dataset.name);
      });
    });

    output.querySelectorAll('.coll-rename-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        renameCollection(btn.dataset.name);
      });
    });

    output.querySelectorAll('.coll-summary-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var name = btn.dataset.name;
        if (!confirm('Generate summaries for all documents in "' + name + '" that are missing one? This calls the summary model for each such document and may take a while.')) return;
        btn.disabled = true;
        var original = btn.textContent;
        btn.textContent = '✨ Generating…';
        status.textContent = '';
        runBackfill(name, btn, original);
      });
    });

    output.querySelectorAll('.coll-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var name = btn.dataset.name;
        if (!confirm('Delete collection "' + name + '"? This is irreversible and removes all documents and indexes.')) return;
        btn.disabled = true;
        btn.textContent = 'Deleting…';
        uiFetch('/collections/' + encodeURIComponent(name), { method: 'DELETE' })
          .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
          .then(function(r) {
            if (r.ok) {
              status.textContent = 'Collection "' + name + '" deleted.';
              loadCollections();
            } else {
              status.textContent = 'Error: ' + (r.data.error || 'Unknown error');
            }
          })
          .catch(function(err) {
            status.textContent = 'Network error: ' + err.message;
            btn.disabled = false;
            btn.textContent = '🗑 Delete';
          });
      });
    });
  }

  // ── Folder / file browser ───────────────────────────────────────────────
  function lastSegment(p) {
    var parts = String(p == null ? '' : p).split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p);
  }

  function openBrowser(name) {
    browseTo(name, '');
  }

  function browseTo(collection, prefix) {
    output.innerHTML = '<div class="coll-spinner">Loading…</div>';
    status.textContent = '';
    var fParams = new URLSearchParams({ collection: collection, depth: '1' });
    if (prefix) fParams.set('path_prefix', prefix);
    var dParams = new URLSearchParams({ collection: collection, direct: '1', limit: '1000' });
    if (prefix) dParams.set('path_prefix', prefix);
    Promise.all([
      uiFetch('/folders?' + fParams.toString()).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); }),
      uiFetch('/documents?' + dParams.toString()).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); }),
    ]).then(function(res) {
      var fr = res[0], dr = res[1];
      if (!fr.ok) { output.innerHTML = '<div class="coll-error">Error: ' + escapeHtml(fr.data.error || 'Unknown error') + '</div>'; return; }
      var folders = fr.data.folders || [];
      var docs = (dr.ok && dr.data.documents) || [];
      var total = dr.ok && dr.data.total !== undefined ? dr.data.total : docs.length;
      renderBrowser(collection, prefix, folders, docs, total);
    }).catch(function(err) {
      output.innerHTML = '<div class="coll-error">Network error: ' + escapeHtml(err.message) + '</div>';
    });
  }

  function renderBrowser(collection, prefix, folders, docs, total) {
    var segs = String(prefix || '').split('/').filter(Boolean);
    var parentPrefix = segs.length > 1 ? '/' + segs.slice(0, -1).join('/') : '';

    var crumb = '<span class="fb-crumb" data-col="' + escapeHtml(collection) + '" data-prefix="">🗄️ ' + escapeHtml(collection) + '</span>';
    var acc = '';
    for (var i = 0; i < segs.length; i++) {
      acc += '/' + segs[i];
      crumb += ' <span class="fb-sep">/</span> <span class="fb-crumb" data-col="' + escapeHtml(collection) + '" data-prefix="' + escapeHtml(acc) + '">' + escapeHtml(segs[i]) + '</span>';
    }

    var head =
      '<div class="fb-bar">' +
        '<button type="button" class="btn btn-secondary fb-back">← Collections</button>' +
        (segs.length ? '<button type="button" class="btn btn-secondary fb-up" data-col="' + escapeHtml(collection) + '" data-prefix="' + escapeHtml(parentPrefix) + '">⬆ Up</button>' : '') +
        '<div class="fb-breadcrumb">' + crumb + '</div>' +
      '</div>';

    var rows = '';
    folders.forEach(function(f) {
      rows += '<div class="fb-row fb-folder" data-col="' + escapeHtml(collection) + '" data-prefix="' + escapeHtml(f.path) + '">' +
        '<span class="fb-icon">📁</span>' +
        '<span class="fb-name">' + escapeHtml(lastSegment(f.path)) + '</span>' +
        '<span class="fb-meta">' + f.documents + ' docs · ' + f.subfolderCount + ' subfolder(s)</span>' +
        '</div>';
    });
    docs.forEach(function(d) {
      var when = d.modified ? new Date(d.modified).toLocaleDateString() : '';
      rows += '<div class="fb-row fb-file"' +
          ' data-col="' + escapeHtml(collection) + '"' +
          ' data-ref="' + escapeHtml(d.reference) + '"' +
          ' data-chunks="' + (d.chunks || 0) + '"' +
          ' data-size="' + (d.size || 0) + '"' +
          ' data-title="' + escapeHtml(d.title || '') + '"' +
          ' data-modified="' + escapeHtml(d.modified || '') + '">' +
        '<span class="fb-icon">📄</span>' +
        '<span class="fb-name">' + escapeHtml(d.title || lastSegment(d.reference)) + '</span>' +
        '<span class="fb-meta">' + d.chunks + ' chunk(s) · ' + formatBytes(d.size || 0) + (when ? ' · ' + when : '') + '</span>' +
        '</div>';
    });
    if (!folders.length && !docs.length) rows = '<div class="coll-empty">Empty — no sub-folders or documents here.</div>';

    output.innerHTML = '<div class="fb">' + head + '<div class="fb-list">' + rows + '</div></div>';
    status.textContent = folders.length + ' folder(s), ' + docs.length + ' file(s)' +
      (total > docs.length ? ' (showing ' + docs.length + ' of ' + total + ')' : '');

    output.querySelector('.fb-back').addEventListener('click', loadCollections);
    var up = output.querySelector('.fb-up');
    if (up) up.addEventListener('click', function() { browseTo(up.dataset.col, up.dataset.prefix); });
    output.querySelectorAll('.fb-crumb').forEach(function(el) {
      el.addEventListener('click', function() { browseTo(el.dataset.col, el.dataset.prefix); });
    });
    output.querySelectorAll('.fb-folder').forEach(function(el) {
      el.addEventListener('click', function() { browseTo(el.dataset.col, el.dataset.prefix); });
    });
    output.querySelectorAll('.fb-file').forEach(function(el) {
      el.addEventListener('click', function() {
        openFileDetails({
          collection: el.dataset.col,
          reference: el.dataset.ref,
          chunks: parseInt(el.dataset.chunks, 10) || 0,
          size: parseInt(el.dataset.size, 10) || 0,
          title: el.dataset.title,
          modified: el.dataset.modified,
        });
      });
    });
  }

  // Document detail popup: chunk count, size and summary (no individual chunks).
  function openFileDetails(doc) {
    var overlay = document.createElement('div');
    overlay.className = 'doc-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var name = doc.title || lastSegment(doc.reference);
    var when = doc.modified ? new Date(doc.modified).toLocaleString() : '—';

    overlay.innerHTML =
      '<div class="doc-modal">' +
        '<div class="doc-modal-header">' +
          '<span class="doc-modal-title">📄 ' + escapeHtml(name) + '</span>' +
          '<button type="button" class="doc-modal-close" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="doc-modal-body">' +
          '<div class="doc-meta-section"><div class="doc-section-title">📊 Document</div>' +
            '<div class="doc-meta-grid">' +
              '<div class="doc-meta-item"><div class="doc-meta-label">Reference</div><div class="doc-meta-value" style="word-break:break-all">' + escapeHtml(doc.reference) + '</div></div>' +
              '<div class="doc-meta-item"><div class="doc-meta-label">Chunks</div><div class="doc-meta-value">' + doc.chunks + '</div></div>' +
              '<div class="doc-meta-item"><div class="doc-meta-label">Size</div><div class="doc-meta-value">' + formatBytes(doc.size) + '</div></div>' +
              '<div class="doc-meta-item"><div class="doc-meta-label">Modified</div><div class="doc-meta-value">' + escapeHtml(when) + '</div></div>' +
            '</div>' +
          '</div>' +
          '<div class="doc-prefix-section" id="fd-summary"><div class="doc-section-title">📝 Summary</div><div class="doc-prefix-text">⏳ Loading…</div></div>' +
          '<div style="margin-top:1.25rem"><button type="button" class="btn btn-secondary" id="fd-chunks-btn">🔍 View chunks</button></div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    var close = function() {
      if (overlay.parentNode) document.body.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
    };
    function onKey(e) { if (e.key === 'Escape') close(); }
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
    overlay.querySelector('.doc-modal-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    overlay.querySelector('#fd-chunks-btn').addEventListener('click', function() {
      close();
      openDocModal(doc.reference, doc.collection, null);
    });

    // Fetch the stored summary (chunk-0 prefix).
    var params = new URLSearchParams({ collection: doc.collection, reference: doc.reference });
    uiFetch('/summary?' + params.toString())
      .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
      .then(function(r) {
        var box = overlay.querySelector('#fd-summary .doc-prefix-text');
        if (!box) return;
        if (r.ok && r.data.summary && r.data.summary.summary) {
          var s = r.data.summary;
          box.textContent = s.summary;
          if (s.isSummary === false) {
            box.innerHTML = '<span style="color:#64748b;font-size:0.72rem">(text-slice prefix, not an LLM summary)</span><br>' + escapeHtml(s.summary);
          }
        } else if (r.ok) {
          box.innerHTML = '<span style="color:#64748b">No summary stored for this document.</span>';
        } else {
          box.innerHTML = '<span style="color:#fca5a5">Error: ' + escapeHtml(r.data.error || 'Unknown error') + '</span>';
        }
      })
      .catch(function(err) {
        var box = overlay.querySelector('#fd-summary .doc-prefix-text');
        if (box) box.innerHTML = '<span style="color:#fca5a5">Network error: ' + escapeHtml(err.message) + '</span>';
      });
  }

  function renameCollection(name) {
    var newName = prompt('Rename collection "' + name + '" to:', name);
    if (newName === null) return;
    newName = newName.trim();
    if (!newName || newName === name) return;
    status.textContent = 'Renaming "' + name + '" → "' + newName + '"…';
    uiFetch('/collections/' + encodeURIComponent(name) + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: newName }),
    })
      .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
      .then(function(r) {
        if (r.ok) {
          status.textContent = 'Collection renamed "' + name + '" → "' + newName + '".';
          loadCollections();
        } else {
          status.textContent = 'Error: ' + (r.data.error || 'Unknown error');
        }
      })
      .catch(function(err) { status.textContent = 'Network error: ' + err.message; });
  }

  function editPermissions(name) {
    // Load current ACL, then prompt for comma-separated users and groups.
    uiFetch('/collections/' + encodeURIComponent(name) + '/permissions')
      .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
      .then(function(r) {
        if (!r.ok) {
          status.textContent = 'Error loading permissions: ' + (r.data.error || 'Unknown error');
          return;
        }
        var curUsers = (r.data.allowed_users || []).join(', ');
        var curGroups = (r.data.allowed_groups || []).join(', ');
        var u = prompt('Allowed USERS for "' + name + '" (comma-separated).\\nLeave empty = public (no user restriction).', curUsers);
        if (u === null) return;
        var g = prompt('Allowed GROUPS for "' + name + '" (comma-separated).\\nLeave empty = public (no group restriction).', curGroups);
        if (g === null) return;
        var toArr = function(s) { return s.split(',').map(function(x){ return x.trim(); }).filter(Boolean); };
        var body = { allowed_users: toArr(u), allowed_groups: toArr(g) };
        status.textContent = 'Updating permissions for "' + name + '"…';
        uiFetch('/collections/' + encodeURIComponent(name) + '/permissions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
          .then(function(pr) {
            if (pr.ok) {
              var restricted = body.allowed_users.length || body.allowed_groups.length;
              status.textContent = 'Permissions for "' + name + '" updated — ' +
                (restricted ? body.allowed_users.length + ' user(s), ' + body.allowed_groups.length + ' group(s)' : 'now public') + '.';
              loadCollections();
            } else {
              status.textContent = 'Error: ' + (pr.data.error || 'Unknown error');
            }
          })
          .catch(function(err) { status.textContent = 'Network error: ' + err.message; });
      })
      .catch(function(err) { status.textContent = 'Network error: ' + err.message; });
  }

  function runBackfill(name, btn, original) {
    var progress = document.getElementById('collections-progress');
    progress.innerHTML =
      '<div class="coll-progress-wrap">' +
        '<div class="coll-progress-head"><span id="cp-label">Starting…</span><span id="cp-counts"></span></div>' +
        '<div class="coll-progress-track"><div class="coll-progress-bar" id="cp-bar"></div></div>' +
        '<div class="coll-progress-current" id="cp-current"></div>' +
      '</div>';
    var bar = document.getElementById('cp-bar');
    var label = document.getElementById('cp-label');
    var counts = document.getElementById('cp-counts');
    var current = document.getElementById('cp-current');

    function handleEvent(ev) {
      if (ev.type === 'start') {
        label.textContent = ev.processed === 0
          ? 'Collection "' + name + '": no documents are missing a summary.'
          : 'Generating summaries for "' + name + '"…';
        counts.textContent = '0 / ' + ev.processed;
      } else if (ev.type === 'progress') {
        var pct = ev.total ? Math.round((ev.index / ev.total) * 100) : 100;
        bar.style.width = pct + '%';
        counts.textContent = ev.index + ' / ' + ev.total +
          ' — ' + ev.updated + ' ok, ' + ev.failed + ' failed';
        current.className = 'coll-progress-current' + (ev.status === 'failed' ? ' cp-err' : '');
        current.textContent = (ev.status === 'failed' ? '⚠ ' : '✓ ') + ev.reference +
          (ev.error ? ' — ' + ev.error : '');
      } else if (ev.type === 'done') {
        bar.style.width = '100%';
        bar.classList.add('cp-done');
        label.textContent = 'Done' + (ev.aborted ? ' (stopped)' : '');
        counts.textContent = ev.updated + ' generated, ' + ev.failed + ' failed';
        current.textContent = '';
        status.textContent = 'Collection "' + name + '": ' + ev.updated +
          ' summaries generated' + (ev.failed ? ', ' + ev.failed + ' failed' : '') +
          ' (' + ev.missing + ' were missing).';
        loadCollections();
      } else if (ev.type === 'error') {
        label.textContent = 'Error';
        current.className = 'coll-progress-current cp-err';
        current.textContent = ev.error || 'Unknown error';
      }
    }

    uiFetch('/collections/' + encodeURIComponent(name) + '/backfill-summaries', { method: 'POST' })
      .then(function(res) {
        if (!res.ok || !res.body) {
          return res.json().then(function(d) {
            throw new Error(d.error || ('HTTP ' + res.status));
          });
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        function consume(line) {
          if (!line.trim()) return;
          var ev;
          try { ev = JSON.parse(line); } catch (e) { return; }
          handleEvent(ev);
        }
        function pump() {
          return reader.read().then(function(r) {
            if (r.done) { consume(buf); return; }
            buf += decoder.decode(r.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf('\\n')) >= 0) {
              consume(buf.slice(0, idx));
              buf = buf.slice(idx + 1);
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function(err) {
        label.textContent = 'Error';
        current.className = 'coll-progress-current cp-err';
        current.textContent = err.message;
      })
      .finally(function() {
        btn.disabled = false;
        btn.textContent = original;
      });
  }

  function loadCollections() {
    output.innerHTML = '<div class="coll-spinner">Loading collections…</div>';
    status.textContent = '';
    uiFetch('/collections')
      .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
      .then(function(r) {
        if (!r.ok) {
          output.innerHTML = '<div class="coll-error">Error: ' + escapeHtml(r.data.error || 'Unknown error') + '</div>';
          return;
        }
        var collections = r.data.collections || [];
        status.textContent = collections.length + ' collection' + (collections.length !== 1 ? 's' : '');
        renderCollections(collections);
      })
      .catch(function(err) {
        output.innerHTML = '<div class="coll-error">Network error: ' + escapeHtml(err.message) + '</div>';
      });
  }

  document.getElementById('collections-refresh-btn').addEventListener('click', loadCollections);

  // Auto-load when the tab is activated
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.dataset.tab === 'collections') loadCollections();
    });
  });
})();

// ── Stats (GET /admin/stats) ───────────────────────────────────────────────────
(function() {
  var output = document.getElementById('stats-output');
  var status = document.getElementById('stats-status');
  if (!output) return;

  function fmtTs(t) { return t ? new Date(t).toLocaleString() : '—'; }

  function table(title, headers, rows) {
    if (!rows || rows.length === 0) {
      return '<div style="margin-bottom:1.5rem"><div class="section-label">' + escapeHtml(title) +
        '</div><div class="coll-empty">No records.</div></div>';
    }
    var thead = '<tr>' + headers.map(function(h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('') + '</tr>';
    var tbody = rows.map(function(r) {
      return '<tr>' + r.map(function(c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<div style="margin-bottom:1.5rem"><div class="section-label">' + escapeHtml(title) + '</div>' +
      '<div class="coll-table-wrap"><div style="overflow-x:auto"><table><thead>' + thead +
      '</thead><tbody>' + tbody + '</tbody></table></div></div></div>';
  }

  function loadStats() {
    output.innerHTML = '<div class="coll-spinner">Loading stats…</div>';
    status.textContent = '';
    var params = new URLSearchParams();
    var col = document.getElementById('stats-collection').value.trim();
    if (col) params.set('collection', col);
    var type = document.getElementById('stats-type').value;
    if (type) params.set('type', type);
    var limit = document.getElementById('stats-limit').value.trim();
    if (limit) params.set('limit', limit);
    var qs = params.toString();
    uiFetch('/admin/stats' + (qs ? '?' + qs : ''))
      .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
      .then(function(r) {
        if (!r.ok) {
          output.innerHTML = '<div class="coll-error">Error: ' + escapeHtml(r.data.error || 'Unknown error') + '</div>';
          return;
        }
        var html = '';
        var ing = r.data.ingest_stats;
        if (ing) {
          html += table('Ingest (' + ing.length + ')',
            ['Time', 'Collection', 'Operation', 'Reference', 'Duration (ms)', 'Chunks'],
            ing.map(function(s) {
              return [
                '<span class="coll-mono">' + escapeHtml(fmtTs(s.timestamp)) + '</span>',
                escapeHtml(s.collection),
                '<span class="coll-mono">' + escapeHtml(s.operation) + '</span>',
                '<span class="coll-mono" style="word-break:break-all">' + escapeHtml(s.reference) + '</span>',
                s.duration_ms,
                s.chunks_processed,
              ];
            }));
        }
        var srch = r.data.search_stats;
        if (srch) {
          html += table('Search (' + srch.length + ')',
            ['Time', 'Collection', 'Query', 'Duration (ms)', 'Results', 'Hybrid', 'Reranked'],
            srch.map(function(s) {
              return [
                '<span class="coll-mono">' + escapeHtml(fmtTs(s.timestamp)) + '</span>',
                escapeHtml(s.collection),
                '<span style="word-break:break-word">' + escapeHtml(s.query) + '</span>',
                s.duration_ms,
                s.results_count,
                s.hybrid_search ? '✓' : '—',
                s.reranked ? '✓' : '—',
              ];
            }));
        }
        output.innerHTML = html || '<div class="coll-empty">No stats.</div>';
        status.textContent = 'Loaded.';
      })
      .catch(function(err) {
        output.innerHTML = '<div class="coll-error">Network error: ' + escapeHtml(err.message) + '</div>';
      });
  }

  document.getElementById('stats-refresh-btn').addEventListener('click', loadStats);
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.dataset.tab === 'stats') loadStats();
    });
  });
})();
`;
