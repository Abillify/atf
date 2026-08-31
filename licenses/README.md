# Vendored license texts

License texts that a dependency's license requires ATF to distribute, but which the upstream
package does not ship itself. `scripts/generate-supply-chain.ts` substitutes these files into
`THIRD_PARTY_NOTICES.md` so the generated notices are complete.

| File | Applies to | Why it is here |
| --- | --- | --- |
| `LGPL-3.0.txt` | `@img/sharp-libvips-*` (LGPL-3.0-or-later) | The prebuilt packages contain only the `libvips` binary and a README, with no license file. LGPL-3.0 requires the license text and the GNU GPL text to accompany distribution, so both are included; the SPDX `LGPL-3.0-or-later` text contains them. |

`libvips` is loaded as a separate dynamic library rather than linked into ATF code, so the
LGPL applies to that library and not to ATF. The obligations ATF must meet are to ship this
text and to leave the shared-library mechanism intact so the library can be replaced with an
interface-compatible build. Nothing in ATF prevents that.

Source: <https://github.com/spdx/license-list-data/blob/main/text/LGPL-3.0-or-later.txt>

Do not edit these files. To add one, place the text here and register it in
`SUPPLEMENTAL_NOTICES` in `scripts/generate-supply-chain.ts`.
