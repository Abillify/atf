"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * NodeTypeDocs — complete reference for one node type, shown in the Studio's
 * right sidebar while a node is selected. Content comes from the runtime's node
 * type catalog (the same data that builds the settings form), so the docs and
 * the form can't drift apart. The settings field currently being edited is
 * highlighted and scrolled into view.
 */

import type React from "react";
import { useEffect, useRef } from "react";
import type { ConfigField, NodeTypeDoc } from "../lib/node-types";
import { formatDefault } from "../lib/node-types";

/** Minimal inline Markdown: `code` and **bold**. Everything else is text. */
function inlineMd(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const tok = m[0];
    out.push(
      tok.startsWith("`") ? (
        <code key={i++} className="rounded bg-muted px-1 font-mono text-[10.5px]">
          {tok.slice(1, -1)}
        </code>
      ) : (
        <strong key={i++}>{tok.slice(2, -2)}</strong>
      ),
    );
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const KIND_LABEL: Record<ConfigField["kind"], string> = {
  boolean: "boolean",
  number: "number",
  string: "string",
  text: "text",
  enum: "one of",
  "string-list": "list of strings",
  "tool-list": "list of tool refs",
  "node-ref": "node id",
  "node-list": "list of node ids",
  condition: "condition expression",
  llm: "model",
  object: "object",
  json: "JSON",
};

function FieldDoc({
  field,
  focused,
  depth = 0,
}: {
  field: ConfigField;
  focused: string | undefined;
  depth?: number;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const isFocused = depth === 0 && focused === field.key;
  useEffect(() => {
    if (isFocused) ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [isFocused]);
  const def = formatDefault(field.default);
  return (
    <div
      ref={ref}
      data-doc-key={field.key}
      className={`rounded border px-2 py-1.5 ${
        isFocused ? "border-primary bg-primary/5" : "border-transparent"
      } ${depth > 0 ? "ml-2 border-l-border" : ""}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <code className="font-mono text-[11px] font-semibold text-foreground">{field.key}</code>
        <span className="text-[10px] text-muted-foreground">
          {KIND_LABEL[field.kind]}
          {field.options ? `: ${field.options.join(" | ")}` : ""}
          {field.required ? " · required" : ""}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-foreground/90">{inlineMd(field.description)}</p>
      {(def !== undefined || field.min !== undefined || field.max !== undefined) && (
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {def !== undefined && <>Default: {inlineMd(def)}. </>}
          {(field.min !== undefined || field.max !== undefined) && (
            <>
              Range: {field.min ?? "…"} – {field.max ?? "…"}
              {field.integer ? " (integer)" : ""}.
            </>
          )}
        </p>
      )}
      {field.example !== undefined && (
        <pre className="mt-1 overflow-auto rounded bg-muted p-1.5 font-mono text-[10px] leading-snug">
          {JSON.stringify(field.example, null, 2)}
        </pre>
      )}
      {field.fields && (
        <div className="mt-1 space-y-1">
          {field.fields.map((f) => (
            <FieldDoc key={f.key} field={f} focused={focused} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

const USAGE_STYLE: Record<string, string> = {
  required: "text-red-600",
  recommended: "text-foreground",
  optional: "text-muted-foreground",
  ignored: "text-muted-foreground line-through",
};

export function NodeTypeDocs({
  doc,
  common,
  focusedField,
  nodeId,
}: {
  doc: NodeTypeDoc;
  common: ConfigField[];
  focusedField?: string;
  nodeId?: string;
}): React.JSX.Element {
  return (
    <article aria-label={`${doc.title} documentation`} className="space-y-3 text-xs">
      <header>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{doc.title} node</h3>
          <code className="text-[10px] text-muted-foreground">type: {doc.type}</code>
        </div>
        {nodeId && <p className="text-[10px] text-muted-foreground">Selected: <code>{nodeId}</code></p>}
        <p className="mt-1 text-[11px] text-foreground/90">{inlineMd(doc.summary)}</p>
      </header>

      <section className="space-y-1.5">
        {doc.description.split(/\n\n+/).map((para) => (
          <p key={para.slice(0, 40)} className="text-[11px] leading-snug text-foreground/90">
            {inlineMd(para)}
          </p>
        ))}
      </section>

      {doc.whenToUse.length > 0 && (
        <section>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">When to use</h4>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
            {doc.whenToUse.map((w) => (
              <li key={w}>{inlineMd(w)}</li>
            ))}
          </ul>
        </section>
      )}

      {doc.topLevel.length > 0 && (
        <section>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Node fields</h4>
          <dl className="space-y-1">
            {doc.topLevel.map((t) => (
              <div key={t.key} data-doc-key={t.key} className={`rounded px-2 py-1 ${focusedField === t.key ? "bg-primary/5" : ""}`}>
                <dt className="flex items-baseline gap-1.5">
                  <code className="font-mono text-[11px] font-semibold">{t.key}</code>
                  <span className={`text-[10px] ${USAGE_STYLE[t.usage] ?? ""}`}>{t.usage}</span>
                </dt>
                <dd className="text-[11px] text-foreground/90">{inlineMd(t.description)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Settings (<code>config</code>) — {doc.config.length}
        </h4>
        {doc.config.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No type-specific settings.</p>
        ) : (
          <div className="space-y-1">
            {doc.config.map((f) => (
              <FieldDoc key={f.key} field={f} focused={focusedField} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Available on every node
        </h4>
        <div className="space-y-1">
          {common.map((f) => (
            <FieldDoc key={f.key} field={f} focused={focusedField} />
          ))}
        </div>
      </section>

      {doc.examples.length > 0 && (
        <section>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Examples</h4>
          {doc.examples.map((ex) => (
            <div key={ex.title} className="mb-2">
              <p className="text-[11px] font-medium">{ex.title}</p>
              <pre className="mt-0.5 overflow-auto rounded bg-muted p-1.5 font-mono text-[10px] leading-snug">{ex.yaml}</pre>
            </div>
          ))}
        </section>
      )}

      {doc.notes.length > 0 && (
        <section>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Notes</h4>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
            {doc.notes.map((n) => (
              <li key={n}>{inlineMd(n)}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
