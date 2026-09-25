"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * VariablesEditor — the flow's `variables` map as a table: one row per
 * variable with name, type and a type-specific value input, plus how often
 * nodes/edges reference it. Renaming a variable also rewrites its
 * `vars.<name>` references (done by the caller via `onRename`); deleting a
 * referenced one asks first. A JSON view stays available for bulk edits.
 */

import { Braces, Copy, Plus, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import type { FormulaGroup } from "../lib/formula";
import type { NodeTypeCatalog } from "../lib/node-types";
import { FormulaEditorDialog, FormulaInput, FxPicker } from "./FormulaEditor";

/** Evaluates one variable's draft value (the builder's "Result"). */
type ValueEvaluator = (
	draft: string,
) => Promise<{ value?: unknown; error?: string }>;

import { inputCls, JsonEditor } from "./form-controls";


const short = (v: unknown): string => {
	const text = JSON.stringify(v) ?? String(v);
	return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

/**
 * What the ƒx picker of variable `self` offers: the other flow variables,
 * global constants (flows/constants.yaml), allowlisted env (FLOW_PUBLIC_*),
 * calculation building blocks, and the model shortcuts/models (those replace
 * the whole value). Inside a `{{= … }}` calculation references are inserted
 * bare (`vars.x`), elsewhere as placeholders (`{{vars.x}}`).
 */
export function variableValueGroups(
	catalog:
		| Pick<
				NodeTypeCatalog,
				| "shortcuts"
				| "shortcutInfo"
				| "models"
				| "constants"
				| "publicEnv"
				| "reference"
		  >
		| undefined,
	variables: Record<string, unknown>,
	self?: string,
): FormulaGroup[] {
	const groups: FormulaGroup[] = [];
	const others = Object.entries(variables).filter(([n]) => n !== self);
	if (others.length > 0) {
		groups.push({
			title: "Flow variables",
			symbols: others.map(([n, v]) => ({
				path: `vars.${n}`,
				insert: `{{vars.${n}}}`,
				calcInsert: `vars.${n}`,
				description: `= ${short(v)}`,
			})),
		});
	}
	const constants = Object.entries(catalog?.constants ?? {});
	groups.push({
		title: "Constants (flows/constants.yaml)",
		symbols:
			constants.length > 0
				? constants.map(([n, v]) => ({
						path: `const.${n}`,
						insert: `{{const.${n}}}`,
						calcInsert: `const.${n}`,
						description: `= ${short(v)}`,
					}))
				: [
						{
							path: "const.none",
							description: "",
							unavailable:
								"No constants yet — add `constants: { name: value }` to flows/constants.yaml.",
						},
					],
	});
	const env = Object.entries(catalog?.publicEnv ?? {});
	groups.push({
		title: "Environment (FLOW_PUBLIC_*)",
		symbols:
			env.length > 0
				? env.map(([n, v]) => ({
						path: `env.${n}`,
						insert: `{{env.${n}}}`,
						calcInsert: `env.${n}`,
						description: `= ${short(v)}`,
					}))
				: [
						{
							path: "env.none",
							description: "",
							unavailable:
								"No FLOW_PUBLIC_* variables set in the runtime environment. Other env values are never exposed to flows.",
						},
					],
	});
	groups.push({
		title: "Calculation",
		symbols: [
			{
				path: "calc",
				insert: "{{=  }}",
				description: "Start a calculation: + − * / %, comparisons, a ? b : c",
			},
			// Functions from the runtime's reference data (docs/FLOWS.md source).
			...(catalog?.reference?.calculationFunctions ?? []).map((fn) => ({
				path: `fn.${fn.text.replace("()", "")}`,
				insert: `{{= ${fn.text} }}`,
				calcInsert: fn.text,
				description: `${fn.label} — ${fn.description}`,
			})),
		],
	});
	if (catalog && catalog.shortcuts.length > 0) {
		groups.push({
			title: "Model shortcuts",
			symbols: catalog.shortcuts.map((name) => ({
				path: `shortcut.${name}`,
				insert: name,
				replace: true,
				description: catalog.shortcutInfo?.[name] || "model shortcut",
			})),
		});
	}
	if ((catalog?.models?.length ?? 0) > 0) {
		groups.push({
			title: "Models",
			symbols: (catalog?.models ?? []).map((id) => ({
				path: `model.${id}`,
				insert: id,
				replace: true,
				description: "concrete model id (for llm.model)",
			})),
		});
	}
	return groups;
}

/** Result of evaluating the variables map (runtime `POST /flows/variables/evaluate`). */
export interface EvaluatedVariables {
	values: Record<string, unknown>;
	errors: Array<{ name: string; message: string }>;
}

const isFormula = (v: unknown): v is string =>
	typeof v === "string" && /\{\{\s*(=|vars\.|const\.|env\.)/.test(v);

export type VarType = "string" | "number" | "boolean" | "json";

export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function varTypeOf(value: unknown): VarType {
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	return "json";
}

/** Converts a value when the operator switches its type, keeping what fits. */
export function convertVar(value: unknown, to: VarType): unknown {
	switch (to) {
		case "string":
			return typeof value === "string"
				? value
				: value === undefined
					? ""
					: JSON.stringify(value);
		case "number": {
			const n = typeof value === "number" ? value : Number(value);
			return Number.isFinite(n) ? n : 0;
		}
		case "boolean":
			return typeof value === "boolean" ? value : value === "true";
		case "json":
			return typeof value === "object" && value !== null ? value : {};
	}
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `vars.<name>` but not `vars.<name>_suffix`. */
export function varRefRe(name: string): RegExp {
	return new RegExp(`\\bvars\\.${escapeRe(name)}(?![A-Za-z0-9_])`, "g");
}

/** How often each variable is referenced in `text` (serialized nodes/edges/…). */
export function countVarUsages(
	names: string[],
	text: string,
): Record<string, number> {
	return Object.fromEntries(
		names.map((n) => [n, text.match(varRefRe(n))?.length ?? 0]),
	);
}

function NameInput({
	name,
	taken,
	onCommit,
}: {
	name: string;
	taken: (candidate: string) => boolean;
	onCommit: (next: string) => void;
}): React.JSX.Element {
	const [draft, setDraft] = useState(name);
	useEffect(() => setDraft(name), [name]);
	const error =
		draft === name
			? null
			: !VAR_NAME_RE.test(draft)
				? "Letters, digits and _ only; must not start with a digit."
				: taken(draft)
					? "Name already in use."
					: null;
	const commit = (): void => {
		if (draft !== name && !error) onCommit(draft);
		else setDraft(name);
	};
	return (
		<div className="min-w-0 flex-1">
			<input
				aria-label={`Variable name ${name}`}
				className={`${inputCls} font-mono text-xs font-semibold ${error ? "border-red-400" : ""}`}
				placeholder="name"
				value={draft}
				spellCheck={false}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") commit();
					if (e.key === "Escape") setDraft(name);
				}}
			/>
			{error && (
				<span className="mt-0.5 block text-[10px] text-red-600">{error}</span>
			)}
		</div>
	);
}

function JsonValueInput({
	name,
	value,
	onChange,
}: {
	name: string;
	value: unknown;
	onChange: (v: unknown) => void;
}): React.JSX.Element {
	const serialized = JSON.stringify(value, null, 2);
	const [text, setText] = useState(serialized);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		setText((t) => {
			try {
				return JSON.stringify(JSON.parse(t), null, 2) === serialized
					? t
					: serialized;
			} catch {
				return t; // mid-edit on invalid JSON — keep what the operator typed
			}
		});
	}, [serialized]);
	return (
		<div>
			<textarea
				aria-label={`Value of ${name}`}
				rows={Math.min(8, Math.max(2, text.split("\n").length))}
				spellCheck={false}
				className={`${inputCls} resize-y font-mono text-xs ${error ? "border-red-400" : ""}`}
				value={text}
				onChange={(e) => {
					setText(e.target.value);
					try {
						onChange(JSON.parse(e.target.value));
						setError(null);
					} catch {
						setError("Invalid JSON — not applied.");
					}
				}}
			/>
			{error && (
				<span className="mt-0.5 block text-[10px] text-red-600">{error}</span>
			)}
		</div>
	);
}

function NumberValueInput({
	name,
	value,
	onChange,
	groups,
	evaluate,
}: {
	name: string;
	value: number;
	onChange: (v: unknown) => void;
	groups: FormulaGroup[];
	evaluate?: ValueEvaluator;
}): React.JSX.Element {
	const [text, setText] = useState(String(value));
	useEffect(
		() => setText((t) => (Number(t) === value ? t : String(value))),
		[value],
	);
	const [editorOpen, setEditorOpen] = useState(false);
	return (
		<div className="relative flex items-center">
			<input
				aria-label={`Value of ${name}`}
				type="number"
				className={`${inputCls} pr-9 font-mono text-xs`}
				value={text}
				onChange={(e) => {
					setText(e.target.value);
					const n = Number(e.target.value);
					if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
				}}
			/>
			<FxPicker
				kind="vars"
				label={`Value of ${name}`}
				groups={groups}
				onPick={() => {}}
				onOpenEditor={() => setEditorOpen(true)}
				className="right-1.5 top-1/2 -translate-y-1/2"
			/>
			{editorOpen && (
				<FormulaEditorDialog
					open
					title={`Variable ${name}`}
					kind="vars"
					value={String(value)}
					groups={groups}
					{...(evaluate ? { evaluate } : {})}
					onApply={(next) => {
						// A plain number stays a number; anything else becomes a formula.
						const n = Number(next);
						onChange(next.trim() !== "" && Number.isFinite(n) ? n : next);
						setEditorOpen(false);
					}}
					onClose={() => setEditorOpen(false)}
				/>
			)}
		</div>
	);
}

function ValueInput({
	name,
	value,
	onChange,
	groups,
	evaluate,
}: {
	name: string;
	value: unknown;
	onChange: (v: unknown) => void;
	groups: FormulaGroup[];
	evaluate?: ValueEvaluator;
}): React.JSX.Element {
	switch (varTypeOf(value)) {
		case "string":
			return (
				<FormulaInput
					kind="vars"
					ariaLabel={`Value of ${name}`}
					className={`${inputCls} font-mono text-xs`}
					value={value as string}
					onChange={onChange}
					groups={groups}
					title={`Variable ${name}`}
					{...(evaluate ? { evaluate } : {})}
				/>
			);
		case "number":
			return (
				<NumberValueInput
					name={name}
					value={value as number}
					onChange={onChange}
					groups={groups}
					{...(evaluate ? { evaluate } : {})}
				/>
			);
		case "boolean":
			return (
				<label className="flex items-center gap-1.5 py-1 text-xs">
					<input
						aria-label={`Value of ${name}`}
						type="checkbox"
						checked={value as boolean}
						onChange={(e) => onChange(e.target.checked)}
					/>
					{value ? "true" : "false"}
				</label>
			);
		case "json":
			return <JsonValueInput name={name} value={value} onChange={onChange} />;
	}
}

/** The runtime's result for a formula value, or its error. */
function FormulaResult({
	value,
	error,
}: {
	value: unknown;
	error: string | undefined;
}): React.JSX.Element {
	if (error) {
		return (
			<p role="alert" className="text-[10px] text-red-600">
				⚠ {error}
			</p>
		);
	}
	const type = Array.isArray(value)
		? "list"
		: value === null
			? "null"
			: typeof value;
	return (
		<p className="truncate text-[10px] text-emerald-700 dark:text-emerald-400">
			→ <code>{JSON.stringify(value)}</code>{" "}
			<span className="text-muted-foreground">({type})</span>
		</p>
	);
}

function nextFreeName(existing: Record<string, unknown>): string {
	for (let i = 1; ; i++) {
		const candidate = `var_${i}`;
		if (!(candidate in existing)) return candidate;
	}
}

export function VariablesEditor({
	value,
	usages,
	onChange,
	onRename,
	catalog,
	evaluate,
}: {
	value: Record<string, unknown> | undefined;
	/** Constants, env, shortcuts and models for the ƒx picker. */
	catalog?: Parameters<typeof variableValueGroups>[0];
	/** Evaluates the map like the runtime does — feeds the "→ result" preview. */
	evaluate?: (
		variables: Record<string, unknown>,
	) => Promise<EvaluatedVariables>;
	/** Reference count per variable name (nodes, edges, other flow fields). */
	usages: Record<string, number>;
	/** New map; `undefined` once the last variable is gone. */
	onChange: (next: Record<string, unknown> | undefined) => void;
	/** Renames a variable and its references. */
	onRename: (oldName: string, newName: string) => void;
}): React.JSX.Element {
	const vars = value ?? {};
	const names = Object.keys(vars);
	const [asJson, setAsJson] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [preview, setPreview] = useState<EvaluatedVariables | null>(null);

	// Evaluate formulas (debounced) whenever the map changes.
	const serialized = JSON.stringify(vars);
	const hasFormula = Object.values(vars).some(isFormula);
	useEffect(() => {
		if (!evaluate || !hasFormula) {
			setPreview(null);
			return;
		}
		let alive = true;
		const t = setTimeout(() => {
			evaluate(JSON.parse(serialized) as Record<string, unknown>).then(
				(r) => alive && setPreview(r),
				() => alive && setPreview(null),
			);
		}, 350);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [serialized, hasFormula, evaluate]);

	const setVar = (name: string, v: unknown): void =>
		onChange({ ...vars, [name]: v });
	const remove = (name: string): void => {
		const { [name]: _gone, ...rest } = vars;
		onChange(Object.keys(rest).length > 0 ? rest : undefined);
		setConfirmDelete(null);
	};
	const copyRef = (name: string): void => {
		void navigator.clipboard?.writeText(`{{vars.${name}}}`).then(
			() => {
				setCopied(name);
				setTimeout(() => setCopied((c) => (c === name ? null : c)), 1200);
			},
			() => {},
		);
	};

	return (
		<div>
			<div className="mb-1 flex items-center justify-between">
				<span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
					Variables{" "}
					{names.length > 0 && (
						<span className="normal-case">({names.length})</span>
					)}
				</span>
				<button
					type="button"
					aria-pressed={asJson}
					onClick={() => setAsJson((j) => !j)}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
					title="Switch between the table and the raw JSON"
				>
					<Braces className="h-3 w-3" aria-hidden />
					{asJson ? "Table" : "JSON"}
				</button>
			</div>

			{asJson ? (
				<JsonEditor
					label=""
					rows={6}
					value={value}
					onChange={(v) => {
						if (v === undefined) onChange(undefined);
						else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
							onChange(v as Record<string, unknown>);
						}
					}}
				/>
			) : (
				<div className="space-y-1.5">
					{names.length === 0 && (
						<p className="rounded border border-dashed border-border px-2 py-2 text-center text-[11px] text-muted-foreground">
							No variables yet.
						</p>
					)}
					{names.map((name) => {
						const used = usages[name] ?? 0;
						const type = varTypeOf(vars[name]);
						return (
							<div
								key={name}
								className="space-y-1 rounded border border-border bg-card p-1.5"
							>
								<div className="flex items-start gap-1">
									<NameInput
										name={name}
										taken={(c) => c !== name && c in vars}
										onCommit={(next) => onRename(name, next)}
									/>
									<button
										type="button"
										aria-label={`Copy reference to ${name}`}
										title={`Copy {{vars.${name}}}`}
										onClick={() => copyRef(name)}
										className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
									>
										<Copy className="h-3.5 w-3.5" aria-hidden />
									</button>
									<button
										type="button"
										aria-label={`Delete variable ${name}`}
										title="Delete variable"
										onClick={() =>
											used > 0 ? setConfirmDelete(name) : remove(name)
										}
										className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600"
									>
										<Trash2 className="h-3.5 w-3.5" aria-hidden />
									</button>
								</div>
								<div className="flex items-start gap-1">
									<select
										aria-label={`Type of ${name}`}
										className="w-[5.5rem] shrink-0 rounded border border-border bg-card px-1 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										value={type}
										onChange={(e) =>
											setVar(
												name,
												convertVar(vars[name], e.target.value as VarType),
											)
										}
									>
										<option value="string">text</option>
										<option value="number">number</option>
										<option value="boolean">yes/no</option>
										<option value="json">JSON</option>
									</select>
									<div className="min-w-0 flex-1">
										<ValueInput
											name={name}
											value={vars[name]}
											onChange={(v) => setVar(name, v)}
											groups={variableValueGroups(catalog, vars, name)}
											{...(evaluate
												? {
														evaluate: (draft: string) =>
															evaluate({ ...vars, [name]: draft }).then((r) => {
																const error = r.errors.find(
																	(e) => e.name === name,
																)?.message;
																return error
																	? { error }
																	: { value: r.values[name] };
															}),
													}
												: {})}
										/>
									</div>
								</div>
								{confirmDelete === name ? (
									<div
										role="alert"
										className="flex flex-wrap items-center gap-2 text-[10px] text-red-600"
									>
										Still used {used}× — references would stay unresolved.
										<button
											type="button"
											onClick={() => remove(name)}
											className="rounded bg-red-600 px-1.5 py-0.5 font-medium text-white"
										>
											Delete anyway
										</button>
										<button
											type="button"
											onClick={() => setConfirmDelete(null)}
											className="rounded border border-border px-1.5 py-0.5 text-foreground"
										>
											Cancel
										</button>
									</div>
								) : (
									<p className="text-[10px] text-muted-foreground">
										<code>{`{{vars.${name}}}`}</code>
										{" · "}
										{copied === name
											? "copied"
											: used > 0
												? `used ${used}×`
												: "not used yet"}
									</p>
								)}
								{isFormula(vars[name]) && preview && (
									<FormulaResult
										error={preview.errors.find((e) => e.name === name)?.message}
										value={preview.values[name]}
									/>
								)}
							</div>
						);
					})}
					<button
						type="button"
						onClick={() => onChange({ ...vars, [nextFreeName(vars)]: "" })}
						className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-border py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<Plus className="h-3 w-3" aria-hidden />
						Add variable
					</button>
				</div>
			)}
			<span className="mt-0.5 block text-[10px] text-muted-foreground">
				Referenced from nodes/edges as {"{{vars.<name>}}"}. Renaming updates
				those references.
			</span>
		</div>
	);
}
