# Configuring Gate router result interpretation

Gate's router picks a tool from a natural-language prompt and executes it. By default it
returns the tool's raw structured result. With `router.interpretResults` enabled, the router
makes a second model call that turns that result into prose before returning it.

This is a Gate YAML setting, not a Runtime one, and not an environment variable. The current
behavior and operational trade-offs are documented here; the historical introduction record
has been consolidated into [CHANGELOG-gate.md](CHANGELOG-gate.md).

## Configuration

```yaml
router:
  enabled: true
  mode: replace
  name: ask
  interpretResults: true # default: false
  llm:
    baseUrl: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY}
    model: gpt-4o-mini
    temperature: 0
```

`${OPENAI_API_KEY}` is interpolated by the Gate deployment from its environment. Runtime's
model access is separate and uses the `PROVIDERS` registry instead; the two are not
interchangeable.

Implemented in `apps/gate/src/config/schema.ts` (the option and its `false` default),
`apps/gate/src/llm/client.ts` (interpretation for the OpenAI-compatible and Bedrock Converse
clients), `apps/gate/src/router/router-tool.ts` (the conditional second pass), and
`apps/gate/src/app.ts` (read and write router wiring).

## What changes in the response

Without interpretation, a caller receives the tool result as the tool produced it — typically
JSON with a row count and rows. With interpretation enabled, the caller receives a
natural-language rendering of the same data, and the original result is preserved in
metadata under `rawToolOutput`.

Interpretation only runs when the tool call succeeded. If the interpretation call itself
fails — timeout, provider error, malformed response — the router falls back to the raw tool
output, so enabling this cannot turn a working tool call into a failed request.

## Trade-offs

| Aspect | Disabled (default) | Enabled |
| --- | --- | --- |
| Model calls per request | Routing only | Routing plus interpretation |
| Latency | Lower | Roughly doubled |
| Token cost | Baseline | About 2x |
| Result shape | Raw structured result | Prose, with the raw result in metadata |
| On interpretation failure | Not applicable | Falls back to the raw result |

Enable it when a human reads the output directly and the deployment has a capable model and
the token budget for a second pass. Leave it off for machine-to-machine callers that parse
the structured result anyway, for latency-critical paths, and for small local models that
handle multi-turn tool conversations poorly.

## Monitoring

When interpretation runs, the router's monitoring event carries the extra metadata:

```json
{
  "type": "router",
  "tool": "invoice_lookup",
  "status": "ok",
  "meta": {
    "routedTo": "invoice_lookup",
    "routedArguments": {},
    "rawToolOutput": "{\"rowCount\": 3, ...}",
    "interpreted": true
  }
}
```

The absence of `interpreted` on a successful routed call means the second pass did not run,
either because the option is off or because the fallback path was taken.

## Tuning

Keep `temperature` at or near `0`; this is a formatting task, and creative variation shows up
as inconsistent output rather than better output. If results need a house style, put it in the
router's `systemPrompt` rather than relying on the model's default presentation:

```yaml
systemPrompt:
  text: >
    When presenting results, format them clearly and concisely.
    Use lists for multiple items. Include relevant dates and times.
    Be specific but brief.
```

Validate a deployment that enables interpretation against its own model choice, timeout, and
cost expectations using synthetic data:

```bash
bun run --filter @atf/gate typecheck
bun run --filter @atf/gate test
```
