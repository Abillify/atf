# Vendored license texts

The supply-chain gate accepts only syntactically valid SPDX expressions that normalize to the explicit allowlist in `scripts/generate-supply-chain.ts`. It requires a plausible complete text for every license identifier in an accepted expression, including every `OR` branch. Resolution is fail-closed and occurs in this order:

1. top-level `LICENSE`, `LICENCE`, `COPYING`, and package-specific `NOTICE` files shipped by the package;
2. exact package/version/repository-bound license sections embedded in another shipped file through `PACKAGE_EMBEDDED_LICENSE_RULES`;
3. repository-root `LICENSE`, `LICENCE`, or `COPYING` files reused only through an explicit `REPOSITORY_LICENSE_REUSE_RULES` entry;
4. package- or genuine upstream-project-family files registered in `SUPPLEMENTAL_RULES`;
5. exact-version declared-license fallbacks registered in `DECLARED_LICENSE_FALLBACK_RULES`, only when reviewed upstream artifacts omit both the complete text and copyright notice;
6. exact package/version/license/repository-bound missing expression branches registered in `EXPRESSION_LICENSE_SUPPLEMENT_RULES`;
7. the canonical Apache License 2.0 standard text, added to every expression containing `Apache-2.0` and protected by a fixed SHA-256 guard.

The canonical Apache text is the unmodified Apache License 2.0 standard text, including the standard Appendix placeholder; it has no AWS or other package provenance. Package-specific `NOTICE` and attribution files remain separate and are retained independently.

Package-embedded, repository-reuse, expression-supplement, and fallback rules never accept arbitrary prose or copy `NOTICE` from another package. Every rule fixes the target package, declared license, source and rationale; embedded, expression-supplement, and fallback rules additionally fix the exact version and normalized repository URL. A changed version, license, repository, source package, filename, or section fails generation. Declared-license fallbacks state the missing upstream copyright notice explicitly and never infer a holder or year.

## Reviewed package-embedded license sections

| Package | Version | Expected license | Repository | Source | Reason |
| --- | --- | --- | --- | --- | --- |
| `pg-types` | `2.2.0` | `MIT` | `https://github.com/brianc/node-pg-types` | `README.md`, `## license` section | The published package includes the complete MIT text and Brian M. Carlson's copyright notice there. |
| `pgpass` | `1.0.5` | `MIT` | `https://github.com/hoegaarden/pgpass` | `README.md`, `## License` section | The published package includes the complete MIT text and Hannes Hörl's copyright notice there. |

## Reviewed repository-root reuse

| Target package regex | Expected license | Repository | Source package regex | Allowed files | Reason |
| --- | --- | --- | --- | --- | --- |
| `^@ai-sdk/provider-utils$` | `Apache-2.0` | `https://github.com/vercel/ai` | `^@ai-sdk/provider$` | `LICENSE`, `LICENCE`, `COPYING` variants | Vercel AI packages use the repository-root Apache-2.0 license. |
| `^@aws-sdk/(credential-provider-http\|credential-provider-login\|nested-clients)$` | `Apache-2.0` | `https://github.com/aws/aws-sdk-js-v3` | `^@aws-sdk/core$` | `LICENSE`, `LICENCE`, `COPYING` variants | AWS SDK for JavaScript v3 packages use the repository-root Apache-2.0 license. |
| `^@biomejs/cli-.+$` | `MIT OR Apache-2.0` | `https://github.com/biomejs/biome` | `^@biomejs/biome$` | `LICENSE-MIT`, `LICENSE-APACHE` | Biome platform packages use the repository-root dual-license files. |
| `^@rolldown/binding-.+$` | `MIT` | `https://github.com/rolldown/rolldown` | `^rolldown$` | `LICENSE`, `LICENCE`, or `COPYING` only | Rolldown bindings use the root MIT license; `THIRD-PARTY-LICENSE` is intentionally excluded. |
| `^cookie-signature$` | `MIT` | `https://github.com/visionmedia/node-cookie-signature` | `^cookie-signature$` | `LICENSE`, `LICENCE`, or `COPYING` only | Installed versions share the repository-root MIT license. |

The reused bytes come from the named installed source package, so the lockfile fixes the exact source version. Reviewed repository roots: [Vercel AI](https://github.com/vercel/ai/tree/82bd64aa07c97dd53db2b7f5143cb93720b51869), [AWS SDK v3](https://github.com/aws/aws-sdk-js-v3/tree/e80cab3d6831ad16c976bd65ba28a3467e1163e6), [Biome](https://github.com/biomejs/biome/tree/f4e5ebb40e64d4488166bf0f2b7d8d96a6118016), [Rolldown](https://github.com/rolldown/rolldown/tree/4e92ff35a6ab2904114c82e808b0b4f7a3ac0170), and [cookie-signature](https://github.com/visionmedia/node-cookie-signature/tree/b7bd4cb9500bfa5e696143f51d61e5f24f7a625d).

## Reviewed missing expression branches

| Package | Version | Expected license | Repository | Vendored text | Reason |
| --- | --- | --- | --- | --- | --- |
| `type-fest` | `0.13.1` | `(MIT OR CC0-1.0)` | `sindresorhus/type-fest` | `CC0-1.0.txt` | The published package supplies its MIT text but omits the CC0-1.0 branch. The exact immutable package identity receives the complete CC0 legal code; any version, expression, or repository change fails closed. |

## Vendored files

Each file below is sourced from the linked authoritative upstream text. `Applies to` is the exact package regex; generation also requires the exact license expression.

| File | Applies to | Expected license | Exact upstream source |
| --- | --- | --- | --- |
| `Apache-2.0.txt` | every package whose expression contains `Apache-2.0` | expression contains `Apache-2.0` | [Apache License, Version 2.0 canonical text](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `CC0-1.0.txt` | exact `type-fest@0.13.1` expression-supplement rule only | `(MIT OR CC0-1.0)` | [Creative Commons CC0 1.0 Universal legal code](https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt) |
| `LGPL-3.0.txt` | `^@img/sharp-libvips(?:-\|$)` | `LGPL-3.0-or-later` | [SPDX `LGPL-3.0-or-later.txt`](https://github.com/spdx/license-list-data/blob/a3cbf2e897d54bccec0c35469c691521d089ef53/text/LGPL-3.0-or-later.txt) |
| `cfworker-json-schema-MIT.txt` | `^@cfworker/json-schema$` | `MIT` | [cfworker `LICENSE.md`](https://github.com/cfworker/cfworker/blob/53401039978aaacc5961d6fc0f2c64f7927ea260/LICENSE.md) |
| `nextjs-MIT.txt` | `^@next/(?:env\|swc-.+)$` | `MIT` | [Next.js `license.md`](https://github.com/vercel/next.js/blob/9c626ac94b8bcd8195e4f4d789824f90e0c95fe5/license.md) |
| `node-redis-MIT.txt` | `^(?:@redis/(?:bloom\|client\|json\|search\|time-series)\|redis)$` | `MIT` | [node-redis `LICENSE`](https://github.com/redis/node-redis/blob/3c6a7e845c5fc5cc18e9f6bec8878c87f170b35e/LICENSE) |
| `react-MIT.txt` | `^client-only$` | `MIT` | [React `LICENSE`](https://github.com/facebook/react/blob/0209ef8a77bcf423cb31029e050a0722a71ebd03/LICENSE) |
| `js-tiktoken-MIT.txt` | `^js-tiktoken$` | `MIT` | [tiktoken `LICENSE`](https://github.com/dqbd/tiktoken/blob/4c8b748e07992c00386f3180af5c574b27b65139/LICENSE) |
| `langsmith-MIT.txt` | `^langsmith$` | `MIT` | [LangSmith SDK `LICENSE`](https://github.com/langchain-ai/langsmith-sdk/blob/4a6e78e5c6d697c338636b1efae1e19537a0dfd1/LICENSE) |
| `nodable-entities-MIT.txt` | `^@nodable/entities$` | `MIT` | [nodable/val-parsers `LICENSE`](https://github.com/nodable/val-parsers/blob/d2070d76a8ba07e6c7fa142caeb51ffd756e47eb/LICENSE) |
| `onnxruntime-MIT.txt` | `^onnxruntime-(?:common\|node\|web)$` | `MIT` | [ONNX Runtime `LICENSE`](https://github.com/microsoft/onnxruntime/blob/ac94fed93ae6d3310fef4920995e8d6a68a3df8a/LICENSE) |
| `saxes-ISC.txt` | `^saxes$` | `ISC` | [saxes `LICENSE`](https://github.com/lddubeau/saxes/blob/4968bd09b5fd0270a989c69913614b0e640dae1b/LICENSE) |
| `victory-MIT.txt` | `^victory-vendor$` | `MIT AND ISC` | [Victory `LICENSE.txt`](https://github.com/FormidableLabs/victory/blob/75549cf8c67e3ea220f862eb7f530c36d540d41c/LICENSE.txt) |
| `d3-ISC.txt` | `^victory-vendor$` | `MIT AND ISC` | [d3-array `LICENSE`](https://github.com/d3/d3-array/blob/be0ae0d2b36ab91b833294ad2cfc5d5905acbd0f/LICENSE) |
| `declared-MIT-no-upstream-copyright.txt` | exact `bun-types@1.4.0` and `stackback@0.0.2` fallback rules only | `MIT` | Canonical MIT terms; package manifests provide the license declaration, while reviewed package/source trees provide no package copyright notice. |
| `declared-ISC-no-upstream-copyright.txt` | exact `guid-typescript@1.0.9` fallback rule only | `ISC` | Canonical ISC terms; the package manifest provides the license declaration, while the reviewed package/source tree provides no package copyright notice. |
| `stackback-v8-BSD-3-Clause.txt` | exact `stackback@0.0.2` fallback rule only | embedded BSD-3-Clause code | Verbatim license header from the package's `formatstack.js`, preserving the V8 project copyright and terms. |

## Declared-license fallback policy

The three fallback rules are a deliberate release-policy exception for exact immutable package identities, not a license-family default. Each generated provenance entry records the package/version manifest declaration, reviewed omission, and that no copyright holder or year was inferred. Any package version, declared expression, or normalized repository change fails closed and requires a new review.

`stackback@0.0.2` additionally contains a complete BSD-3-Clause header for V8-derived code. That embedded header remains in the distributed package; it does not substitute for the separately declared package-level MIT terms.

Do not add a broad license-family fallback. Add or change a rule only with a reviewable exact package identity, source, expected expression, and rationale.
