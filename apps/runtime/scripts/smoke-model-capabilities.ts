// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Live capability smoke test for the models configured by the deployment.
 *
 * It validates DEFAULT_LLM and FALLBACK_LLM against their configured providers:
 *   - reasoning can be disabled and enabled
 *   - tool_choice="auto" returns an OpenAI-compatible tool call
 *   - image input is understood
 *
 * It also validates the configured Google vision model with the same generated
 * image. The probe sends only synthetic prompts and pixels, never project data.
 * Provider credentials are read from the deployment env file and never printed.
 *
 * Usage from the repository root:
 *   AIPERATOR_ENV_FILE=/path/to/aiperator.env bun run smoke:model-capabilities
 *
 * Overrides:
 *   AIPERATOR_ENV_FILE=/path/to/.env.production
 *   MODEL_CAPABILITY_VISION_MODEL=models/gemini-3-flash-preview
 *   MODEL_CAPABILITY_VISION_PROVIDER=googleai
 *   MODEL_CAPABILITY_SKIP_GEMINI=1
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

type JsonRecord = Record<string, unknown>;
type ProviderConfig = {
  name: string;
  protocol: string;
  url?: string;
  apiKey?: string;
  local?: boolean;
};
type LlmConfig = {
  provider: string;
  model: string;
  parameters?: {
    reasoningEffort?: string;
    chatTemplateKwargs?: JsonRecord;
    extraBody?: JsonRecord;
  };
};
type RequestResult = {
  ok: boolean;
  status: number;
  latencyMs: number;
  data: JsonRecord;
};
type CheckResult = {
  label: string;
  pass: boolean;
  latencyMs: number;
  details: string;
};

const envPathValue = process.env.AIPERATOR_ENV_FILE?.trim();
if (!envPathValue) {
  console.error(
    "FAIL AIPERATOR_ENV_FILE is required. Set it to an explicit Aiperator env file; no deployment file is selected automatically.",
  );
  process.exit(1);
}
const envPath = resolve(envPathValue);

function parseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.replace(/^export\s+/, "");
    const separator = withoutExport.indexOf("=");
    if (separator < 1) continue;
    const key = withoutExport.slice(0, separator).trim();
    let value = withoutExport.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function parseJson<T>(value: string | undefined, name: string): T {
  if (!value) throw new Error(`${name} is missing in ${envPath}`);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(
      `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

let fileEnv: Record<string, string>;
try {
  fileEnv = parseEnv(readFileSync(envPath, "utf8"));
} catch (error) {
  console.error(
    `FAIL Cannot read Aiperator env file ${envPath}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const setting = (name: string): string | undefined =>
  process.env[name] ?? fileEnv[name];
const providers = parseJson<ProviderConfig[]>(setting("PROVIDERS"), "PROVIDERS");
const defaultLlm = parseJson<LlmConfig>(setting("DEFAULT_LLM"), "DEFAULT_LLM");
const fallbackLlm = parseJson<LlmConfig>(
  setting("FALLBACK_LLM"),
  "FALLBACK_LLM",
);
const secretValues = providers
  .map((provider) => provider.apiKey)
  .filter((value): value is string => Boolean(value));

function providerFor(name: string): ProviderConfig {
  const provider = providers.find((candidate) => candidate.name === name);
  if (!provider) throw new Error(`Configured provider ${name} was not found`);
  return provider;
}

function redact(value: unknown): string {
  let text =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  for (const secret of secretValues) text = text.replaceAll(secret, "[REDACTED]");
  return text.slice(0, 800);
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs = 180_000,
): Promise<RequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    let data: JsonRecord;
    try {
      data = JSON.parse(body) as JsonRecord;
    } catch {
      data = { raw: body.slice(0, 800) };
    }
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      data,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - started),
      data: { error: redact(error) },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function chat(
  provider: ProviderConfig,
  body: JsonRecord,
): Promise<RequestResult> {
  if (provider.protocol !== "openai" || !provider.url) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      data: {
        error: `Provider ${provider.name} must use the openai protocol and define a URL`,
      },
    };
  }
  return requestJson(`${provider.url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey ?? "local"}`,
    },
    body: JSON.stringify({ stream: false, ...body }),
  });
}

function responseError(result: RequestResult): string {
  const error = result.data.error;
  if (typeof error === "string") return redact(error);
  if (error && typeof error === "object") {
    const record = error as JsonRecord;
    return redact(record.message ?? record);
  }
  return redact(result.data);
}

function firstChoice(result: RequestResult): JsonRecord {
  const choices = result.data.choices;
  return Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
    ? (choices[0] as JsonRecord)
    : {};
}

function firstMessage(result: RequestResult): JsonRecord {
  const message = firstChoice(result).message;
  return message && typeof message === "object" ? (message as JsonRecord) : {};
}

function modelWireParameters(
  config: LlmConfig,
  enableReasoning: boolean,
): JsonRecord {
  const parameters = config.parameters ?? {};
  const extra = parameters.extraBody ?? {};
  const chatTemplateKwargs = parameters.chatTemplateKwargs ?? {};
  return {
    ...extra,
    chat_template_kwargs: {
      ...chatTemplateKwargs,
      enable_thinking: enableReasoning,
    },
    ...(parameters.reasoningEffort !== undefined
      ? { reasoning_effort: enableReasoning ? "medium" : "none" }
      : {}),
  };
}

function reasoningText(message: JsonRecord): string {
  if (typeof message.reasoning_content === "string") {
    return message.reasoning_content;
  }
  return typeof message.reasoning === "string" ? message.reasoning : "";
}

async function checkReasoning(
  config: LlmConfig,
  enableReasoning: boolean,
): Promise<CheckResult> {
  const result = await chat(providerFor(config.provider), {
    model: config.model,
    messages: [
      {
        role: "user",
        content:
          "Compute 37 times 19. Think briefly and finish your answer with the number.",
      },
    ],
    temperature: 0,
    max_tokens: 768,
    ...modelWireParameters(config, enableReasoning),
  });
  const state = enableReasoning ? "on" : "off";
  if (!result.ok) {
    return {
      label: `${config.model} reasoning ${state}`,
      pass: false,
      latencyMs: result.latencyMs,
      details: `HTTP ${result.status}: ${responseError(result)}`,
    };
  }
  const message = firstMessage(result);
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning = reasoningText(message);
  const hasThinkTag = /<think>[\s\S]*?<\/think>/i.test(content);
  const observed = reasoning.trim().length > 0 || hasThinkTag;
  const correctAnswer = /\b703\b/.test(content);
  return {
    label: `${config.model} reasoning ${state}`,
    pass: correctAnswer && (enableReasoning ? observed : !observed),
    latencyMs: result.latencyMs,
    details: `HTTP ${result.status}, reasoning=${reasoning.length} chars, answer=${correctAnswer ? "703" : "unexpected"}`,
  };
}

async function checkAutoTool(config: LlmConfig): Promise<CheckResult> {
  const result = await chat(providerFor(config.provider), {
    model: config.model,
    messages: [
      {
        role: "user",
        content:
          "You must call capability_probe with value set to ok. Do not answer yourself.",
      },
    ],
    temperature: 0,
    max_tokens: 384,
    ...modelWireParameters(config, false),
    tools: [
      {
        type: "function",
        function: {
          name: "capability_probe",
          description: "Technical capability probe.",
          parameters: {
            type: "object",
            properties: { value: { type: "string", enum: ["ok"] } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: "auto",
  });
  if (!result.ok) {
    return {
      label: `${config.model} auto tool call`,
      pass: false,
      latencyMs: result.latencyMs,
      details: `HTTP ${result.status}: ${responseError(result)}`,
    };
  }
  const message = firstMessage(result);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const firstCall =
    calls[0] && typeof calls[0] === "object" ? (calls[0] as JsonRecord) : {};
  const fn =
    firstCall.function && typeof firstCall.function === "object"
      ? (firstCall.function as JsonRecord)
      : {};
  let args: JsonRecord = {};
  try {
    if (typeof fn.arguments === "string") {
      args = JSON.parse(fn.arguments) as JsonRecord;
    }
  } catch {
    args = {};
  }
  const pass = fn.name === "capability_probe" && args.value === "ok";
  return {
    label: `${config.model} auto tool call`,
    pass,
    latencyMs: result.latencyMs,
    details: `HTTP ${result.status}, calls=${calls.length}, tool=${String(fn.name ?? "none")}`,
  };
}

let crcTable: number[] | undefined;
function crc32(buffer: Buffer): number {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let index = 0; index < 8; index++) {
      value =
        value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) {
    const tableEntry = crcTable[(crc ^ byte) & 0xff];
    if (tableEntry === undefined) {
      throw new Error("CRC table lookup failed");
    }
    crc = tableEntry ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function splitColorPngBase64(): string {
  const width = 64;
  const height = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const row = y * rowSize;
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 3;
      if (x < width / 2) raw[pixel] = 255;
      else raw[pixel + 2] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const visionPrompt =
  "Betrachte ausschließlich das Bild. Welche Farbe hat die linke Hälfte und " +
  "welche die rechte Hälfte? Antworte exakt im Format: " +
  "LINKS=<FARBE>; RECHTS=<FARBE>.";
const imageBase64 = splitColorPngBase64();

function imageAnswerPass(content: string): boolean {
  const normalized = content.toUpperCase();
  return (
    /LINKS\s*=\s*ROT/.test(normalized) &&
    /RECHTS\s*=\s*BLAU/.test(normalized)
  );
}

async function checkOpenAiVision(config: LlmConfig): Promise<CheckResult> {
  const result = await chat(providerFor(config.provider), {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: visionPrompt },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${imageBase64}` },
          },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 512,
    ...modelWireParameters(config, false),
  });
  if (!result.ok) {
    return {
      label: `${config.model} vision`,
      pass: false,
      latencyMs: result.latencyMs,
      details: `HTTP ${result.status}: ${responseError(result)}`,
    };
  }
  const message = firstMessage(result);
  const content = typeof message.content === "string" ? message.content : "";
  return {
    label: `${config.model} vision`,
    pass: imageAnswerPass(content),
    latencyMs: result.latencyMs,
    details: `HTTP ${result.status}, answer=${JSON.stringify(content.slice(0, 120))}`,
  };
}

async function checkGeminiVision(): Promise<CheckResult> {
  const providerName =
    process.env.MODEL_CAPABILITY_VISION_PROVIDER ?? "googleai";
  const model =
    process.env.MODEL_CAPABILITY_VISION_MODEL ??
    "models/gemini-3-flash-preview";
  const provider = providerFor(providerName);
  if (provider.protocol !== "google" || !provider.apiKey) {
    return {
      label: `${model} vision`,
      pass: false,
      latencyMs: 0,
      details: `Provider ${providerName} must use the google protocol and define an API key`,
    };
  }
  const result = await requestJson(
    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": provider.apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: visionPrompt },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: imageBase64,
                },
              },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 512 },
      }),
    },
  );
  if (!result.ok) {
    return {
      label: `${model} vision`,
      pass: false,
      latencyMs: result.latencyMs,
      details: `HTTP ${result.status}: ${responseError(result)}`,
    };
  }
  const candidates = result.data.candidates;
  const candidate =
    Array.isArray(candidates) && candidates[0] && typeof candidates[0] === "object"
      ? (candidates[0] as JsonRecord)
      : {};
  const content =
    candidate.content && typeof candidate.content === "object"
      ? (candidate.content as JsonRecord)
      : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts
    .map((part) =>
      part && typeof part === "object" && typeof (part as JsonRecord).text === "string"
        ? ((part as JsonRecord).text as string)
        : "",
    )
    .join(" ")
    .trim();
  return {
    label: `${model} vision`,
    pass: imageAnswerPass(text),
    latencyMs: result.latencyMs,
    details: `HTTP ${result.status}, answer=${JSON.stringify(text.slice(0, 120))}`,
  };
}

async function run(): Promise<void> {
  const configs = [defaultLlm, fallbackLlm].filter(
    (config, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === config.provider && candidate.model === config.model,
      ) === index,
  );
  const checks: CheckResult[] = [];
  for (const config of configs) {
    checks.push(await checkReasoning(config, false));
    checks.push(await checkReasoning(config, true));
    checks.push(await checkAutoTool(config));
    checks.push(await checkOpenAiVision(config));
  }
  if (process.env.MODEL_CAPABILITY_SKIP_GEMINI !== "1") {
    checks.push(await checkGeminiVision());
  }

  console.log(`Model capability smoke (${envPath})\n`);
  for (const check of checks) {
    console.log(
      `${check.pass ? "PASS" : "FAIL"} ${check.label} (${check.latencyMs} ms) — ${check.details}`,
    );
  }
  const failed = checks.filter((check) => !check.pass);
  console.log(
    `\n${failed.length === 0 ? "PASS" : "FAIL"}: ${checks.length - failed.length}/${checks.length} checks passed.`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(`FAIL Model capability smoke crashed: ${redact(error)}`);
  process.exit(1);
});
