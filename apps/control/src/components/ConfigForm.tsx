"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ConfigForm — the per-node-type settings form, generated from the runtime's
 * node type catalog (`GET /flows/node-types`).
 *
 * Every documented `config` key gets a control that fits its kind (switch,
 * number with bounds, select, tool picker, node picker, model picker, nested
 * sub-form, JSON with example). Values that aren't set show the effective
 * default. Keys the catalog doesn't know are preserved and editable as JSON
 * under "Other keys" — nothing in a flow is ever dropped by the form.
 *
 * Focusing a field reports its key (`onFocusField`) so the documentation panel
 * can jump to it.
 */

import type React from "react";
import { useId } from "react";
import type { ConfigField } from "../lib/node-types";
import { formatDefault } from "../lib/node-types";
import { Field, JsonEditor, NumberOrVarInput, inputCls } from "./form-controls";
import { FormulaInput, FormulaTextarea } from "./FormulaEditor";
import type { FormulaKind } from "../lib/formula";

export interface ConfigFormProps {
  /** Type-specific fields, then the cross-cutting ones. */
  fields: ConfigField[];
  common: ConfigField[];
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
  /** Node ids on the canvas (for node pickers). */
  nodeIds: string[];
  /** Tool ids of connected MCP servers (suggestions). */
  tools: string[];
  /** Model shortcut names (suggestions). */
  shortcuts: string[];
  onFocusField?: (key: string) => void;
}

type Obj = Record<string, unknown>;

/**
 * Where the runtime renders run-time placeholders ({{classification.x}},
 * {{query}}, …). Every other string only gets flow variables, which are
 * substituted when the flow loads.
 */
const TEMPLATE_KEYS = new Set(["toolArgs", "messageTemplate", "scheduledMessage", "queryTemplate", "toolContext", "ragProfiles"]);
const formulaKindFor = (key: string): FormulaKind => (TEMPLATE_KEYS.has(key) ? "template" : "vars");

function setKey(obj: Obj | undefined, key: string, v: unknown): Obj | undefined {
  const next: Obj = { ...(obj ?? {}) };
  if (v === undefined || (typeof v === "string" && v === "")) delete next[key];
  else next[key] = v;
  return Object.keys(next).length > 0 ? next : undefined;
}

function Hint({ field }: { field: ConfigField }): React.JSX.Element {
  const def = formatDefault(field.default);
  const range =
    field.min !== undefined || field.max !== undefined
      ? `${field.min ?? "…"}–${field.max ?? "…"}`
      : undefined;
  const first = field.description.split(/(?<=\.)\s/)[0] ?? field.description;
  return (
    <>
      {first}
      {(def || range) && (
        <span className="ml-1 text-muted-foreground/80">
          {def && <>Default: {def}.</>} {range && <>Range: {range}.</>}
        </span>
      )}
    </>
  );
}

export function ListInput({
  value,
  onChange,
  suggestions,
  placeholder,
  listId,
  highlight,
}: {
  value: unknown;
  onChange: (v: string[] | undefined) => void;
  suggestions?: string[];
  placeholder?: string;
  listId: string;
  /** Entry to emphasise (e.g. the tool clicked on the canvas). */
  highlight?: string | undefined;
}): React.JSX.Element {
  const items = Array.isArray(value) ? value.map(String) : [];
  const add = (raw: string): void => {
    const v = raw.trim();
    if (!v || items.includes(v)) return;
    onChange([...items, v]);
  };
  return (
    <div className="space-y-1">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {items.map((it) => (
            <span
              key={it}
              data-list-item={it}
              {...(highlight === it ? { "data-highlighted": "true" } : {})}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] ${
                highlight === it ? "bg-sky-500/20 ring-2 ring-sky-500" : "bg-muted"
              }`}
            >
              {it}
              <button
                type="button"
                aria-label={`Remove ${it}`}
                onClick={() => {
                  const rest = items.filter((x) => x !== it);
                  onChange(rest.length > 0 ? rest : undefined);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className={`${inputCls} font-mono text-xs`}
        list={suggestions ? listId : undefined}
        placeholder={placeholder ?? "Add… (Enter)"}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(e.currentTarget.value);
            e.currentTarget.value = "";
          }
        }}
        onBlur={(e) => {
          if (e.currentTarget.value.trim()) {
            add(e.currentTarget.value);
            e.currentTarget.value = "";
          }
        }}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

function LlmInput({
  value,
  onChange,
  shortcuts,
  listId,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  shortcuts: string[];
  listId: string;
}): React.JSX.Element {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined;
  const shortcut = typeof obj?.shortcut === "string" ? obj.shortcut : "";
  const other = obj && !("shortcut" in obj) ? obj : undefined;
  return (
    <div className="space-y-1">
      <FormulaInput
        kind="vars"
        replace
        ariaLabel="Model shortcut"
        className={`${inputCls} font-mono text-xs`}
        list={listId}
        placeholder={other ? `${String(other.provider ?? "")}/${String(other.model ?? "")}` : "shortcut, e.g. fast-pool"}
        value={shortcut}
        onChange={(s) => {
          onChange(s ? { ...(obj && "shortcut" in obj ? obj : {}), shortcut: s } : other);
        }}
      />
      <datalist id={listId}>
        {shortcuts.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <details>
        <summary className="cursor-pointer text-[10px] text-muted-foreground">
          provider/model/parameters as JSON
        </summary>
        <JsonEditor label="Model config" rows={4} value={value} onChange={onChange} />
      </details>
    </div>
  );
}

function FieldControl({
  field,
  value,
  onChange,
  ctx,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
  ctx: Omit<ConfigFormProps, "fields" | "common" | "value" | "onChange">;
}): React.JSX.Element {
  const id = useId();
  const listId = `${id}-list`;
  const focus = (): void => ctx.onFocusField?.(field.key);

  switch (field.kind) {
    case "boolean": {
      const def = field.default === true ? "on" : field.default === false ? "off" : undefined;
      return (
        <select
          aria-label={field.label}
          className={inputCls}
          onFocus={focus}
          value={value === true ? "true" : value === false ? "false" : ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : e.target.value === "true")
          }
        >
          <option value="">{def ? `— default (${def}) —` : "— not set —"}</option>
          <option value="true">on</option>
          <option value="false">off</option>
        </select>
      );
    }
    case "number":
      return (
        <fieldset className="m-0 min-w-0 border-0 p-0" onFocus={focus}>
          <NumberOrVarInput label="" ariaLabel={field.label} value={value} onChange={(v) => onChange(v)} />
          {typeof value === "number" &&
            ((field.min !== undefined && value < field.min) ||
              (field.max !== undefined && value > field.max) ||
              (field.integer && !Number.isInteger(value))) && (
              <p className="mt-0.5 text-[10px] text-amber-600">
                Outside the allowed range{field.integer ? " / not an integer" : ""} — the runtime may reject or ignore it.
              </p>
            )}
        </fieldset>
      );
    case "enum":
      return (
        <select
          aria-label={field.label}
          className={inputCls}
          onFocus={focus}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">
            {field.default !== undefined ? `— default (${formatDefault(field.default)}) —` : "— not set —"}
          </option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          {typeof value === "string" && value && !(field.options ?? []).includes(value) && (
            <option value={value}>{value} (unknown)</option>
          )}
        </select>
      );
    case "string":
    case "condition":
      return (
        <FormulaInput
          ariaLabel={field.label}
          title={`${field.label} (${field.key})`}
          kind={field.kind === "condition" ? "condition" : formulaKindFor(field.key)}
          className={`${inputCls} ${field.kind === "condition" ? "font-mono text-xs" : ""}`}
          onFocus={focus}
          value={typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)}
          placeholder={formatDefault(field.default) ?? ""}
          onChange={(v) => onChange(v || undefined)}
        />
      );
    case "text":
      return (
        <FormulaTextarea
          ariaLabel={field.label}
          title={`${field.label} (${field.key})`}
          kind={formulaKindFor(field.key)}
          className={`${inputCls} w-full resize-y text-xs`}
          rows={3}
          onFocus={focus}
          value={typeof value === "string" ? value : ""}
          onChange={(v) => onChange(v || undefined)}
        />
      );
    case "node-ref":
      return (
        <select
          aria-label={field.label}
          className={`${inputCls} font-mono text-xs`}
          onFocus={focus}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">— none —</option>
          {ctx.nodeIds.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          {typeof value === "string" && value && !ctx.nodeIds.includes(value) && (
            <option value={value}>{value} (not on canvas)</option>
          )}
        </select>
      );
    case "node-list":
    case "tool-list":
    case "string-list":
      return (
        <fieldset className="m-0 min-w-0 border-0 p-0" onFocus={focus}>
          <ListInput
            value={value}
            onChange={onChange}
            listId={listId}
            {...(field.kind === "node-list"
              ? { suggestions: ctx.nodeIds, placeholder: "Add node id… (Enter)" }
              : field.kind === "tool-list"
                ? { suggestions: ctx.tools, placeholder: "Add tool or pattern (server/*)… (Enter)" }
                : {})}
          />
        </fieldset>
      );
    case "llm":
      return (
        <fieldset className="m-0 min-w-0 border-0 p-0" onFocus={focus}>
          <LlmInput value={value} onChange={onChange} shortcuts={ctx.shortcuts} listId={listId} />
        </fieldset>
      );
    case "object": {
      const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined;
      return (
        <fieldset className="m-0 min-w-0 space-y-2 rounded border border-border p-2" onFocus={focus}>
          {(field.fields ?? []).map((sub) => (
            <Field key={sub.key} label={`${sub.label}${sub.required ? " *" : ""}`} hint={undefined}>
              <FieldControl
                field={sub}
                value={obj?.[sub.key]}
                onChange={(v) => onChange(setKey(obj, sub.key, v))}
                ctx={ctx}
              />
              <span className="mt-0.5 block text-[10px] text-muted-foreground">
                <Hint field={sub} />
              </span>
            </Field>
          ))}
        </fieldset>
      );
    }
    default:
      return (
        <fieldset className="m-0 min-w-0 border-0 p-0" onFocus={focus}>
          <JsonEditor
            label=""
            formulaKind={formulaKindFor(field.key)}
            rows={field.example !== undefined ? Math.min(10, JSON.stringify(field.example, null, 2).split("\n").length + 1) : 4}
            value={value}
            onChange={onChange}
          />
          {value === undefined && field.example !== undefined && (
            <button
              type="button"
              onClick={() => onChange(field.example)}
              className="mt-0.5 text-[10px] text-muted-foreground underline hover:text-foreground"
            >
              Insert example
            </button>
          )}
        </fieldset>
      );
  }
}

function FieldRow({
  field,
  config,
  onChange,
  ctx,
}: {
  field: ConfigField;
  config: Obj | undefined;
  onChange: (next: Obj | undefined) => void;
  ctx: Omit<ConfigFormProps, "fields" | "common" | "value" | "onChange">;
}): React.JSX.Element {
  const isSet = config !== undefined && field.key in config;
  return (
    <div data-config-key={field.key} className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {field.label}
          {field.required ? " *" : ""}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <code className="text-[10px] text-muted-foreground/70">{field.key}</code>
          {isSet && (
            <button
              type="button"
              onClick={() => onChange(setKey(config, field.key, undefined))}
              title="Remove this key (use the default)"
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              reset
            </button>
          )}
        </span>
      </div>
      <FieldControl
        field={field}
        value={config?.[field.key]}
        onChange={(v) => onChange(setKey(config, field.key, v))}
        ctx={ctx}
      />
      <p className="text-[10px] leading-snug text-muted-foreground">
        <Hint field={field} />
      </p>
    </div>
  );
}

export function ConfigForm({
  fields,
  common,
  value,
  onChange,
  ...ctx
}: ConfigFormProps): React.JSX.Element {
  const known = new Set([...fields, ...common].map((f) => f.key));
  const unknown = Object.fromEntries(
    Object.entries(value ?? {}).filter(([k]) => !known.has(k)),
  );
  const essential = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);
  // Open a section whenever it already holds a value, so nothing set is hidden.
  const anySet = (fs: ConfigField[]): boolean => fs.some((f) => value !== undefined && f.key in value);

  const rows = (fs: ConfigField[]): React.JSX.Element[] =>
    fs.map((f) => (
      <FieldRow key={f.key} field={f} config={value} onChange={onChange} ctx={ctx} />
    ));

  return (
    <div className="space-y-3">
      {essential.length === 0 && advanced.length === 0 && (
        <p className="text-[11px] text-muted-foreground">This node type has no type-specific settings.</p>
      )}
      {rows(essential)}
      {advanced.length > 0 && (
        <details open={anySet(advanced)} className="border-t border-border pt-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-foreground">
            Advanced ({advanced.length})
          </summary>
          <div className="mt-2 space-y-3">{rows(advanced)}</div>
        </details>
      )}
      <details open={anySet(common)} className="border-t border-border pt-2">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-foreground">
          Error handling, approval &amp; progress
        </summary>
        <div className="mt-2 space-y-3">{rows(common)}</div>
      </details>
      {Object.keys(unknown).length > 0 && (
        <div className="border-t border-border pt-2">
          <JsonEditor
            label={`Other keys (${Object.keys(unknown).length})`}
            hint="Not documented for this node type — the runtime ignores them unless a plugin reads them. Kept as they are."
            rows={Math.min(10, JSON.stringify(unknown, null, 2).split("\n").length + 1)}
            value={unknown}
            onChange={(v) => {
              if (v !== undefined && (typeof v !== "object" || Array.isArray(v))) return;
              const kept = Object.fromEntries(
                Object.entries(value ?? {}).filter(([k]) => known.has(k)),
              );
              const next = { ...kept, ...((v as Obj | undefined) ?? {}) };
              onChange(Object.keys(next).length > 0 ? next : undefined);
            }}
          />
        </div>
      )}
    </div>
  );
}
