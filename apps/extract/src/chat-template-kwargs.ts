// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * chat-template-kwargs.ts
 *
 * The optional `chat_template_kwargs` body field shared by the vision and the
 * summary client. Only configured knobs are sent, and the field is omitted
 * entirely when none is set: strict OpenAI-compatible servers reject unknown
 * fields, so an unconditional `chat_template_kwargs` would break every request
 * against them.
 *
 * `reasoning_effort` suits templates with a thinking budget; Qwen-style
 * templates ignore it and switch their thinking block with `enable_thinking`
 * instead, which is why both exist.
 */
export function chatTemplateKwargs(
  reasoningEffort: string | null,
  enableThinking: boolean | null,
): { chat_template_kwargs?: Record<string, string | boolean> } {
  const kwargs: Record<string, string | boolean> = {};
  if (reasoningEffort !== null) kwargs["reasoning_effort"] = reasoningEffort;
  if (enableThinking !== null) kwargs["enable_thinking"] = enableThinking;
  return Object.keys(kwargs).length > 0 ? { chat_template_kwargs: kwargs } : {};
}
