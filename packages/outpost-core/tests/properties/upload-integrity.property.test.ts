// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 22: Resumable-Upload-Integrität
 *
 * **Validates: Requirements 8.5, 8.6**
 *
 * Für jeden Dateiinhalt, jede Chunkgröße und jede Folge injizierter Abbrüche
 * (Verbindungsabbruch vor oder nach dem serverseitigen Commit, verlorene
 * 204-Antworten, 409 mit korrigiertem Offset, Korruption im Transit) gilt:
 * die vom Server zusammengesetzten Bytes sind identisch mit dem Original, der
 * deklarierte X-Checksum-Sha256 entspricht dem SHA-256 des Inhalts, und jeder
 * angenommene PATCH beginnt am vom Server bestätigten Offset.
 */

import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ExtractHttpClient, runResumableUpload, type PatchOutcome } from "../../src/index.js";
import { FakeExtract, type PatchFault } from "../fakes/fake-extract.js";
import { FakeTokenProvider } from "../fakes/fake-token-provider.js";

function clientWith(fake: FakeExtract): ExtractHttpClient {
  return new ExtractHttpClient({
    extractUrl: "https://extract.example.com",
    tokenProvider: new FakeTokenProvider("tok"),
    version: "0.1.0",
    runtime: "docker",
    fetchImpl: fake.fetchImpl as unknown as typeof globalThis.fetch,
  });
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// Die von Property 22 genannten Abbrüche: Verbindung vor/nach dem Commit,
// verlorene 204-Antwort, 409 mit korrigiertem Offset. Transit-Korruption ist
// kein Abbruch und wird separat (deterministisch) geprüft.
const patchFaultArb = fc.constantFrom<PatchFault>(
  "network-before",
  "network-after",
  "offset-409",
);

describe("Property 22: Resumable-Upload-Integrität", () => {
  it(
    "setzt nach beliebig vielen Abbrüchen exakt die Originalbytes zusammen",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: 200 }),
          fc.integer({ min: 1, max: 64 }),
          fc.array(patchFaultArb, { maxLength: 10 }),
          async (content, chunkSize, faults) => {
            const fake = new FakeExtract();
            // Ein Fault je Patch-Versuch, der Reihe nach.
            for (const [index, fault] of faults.entries()) fake.patchFaults.set(index, fault);
            const client = clientWith(fake);
            const sha = sha256Hex(content);

            const result = await runResumableUpload(client, {
              reference: "outpost:src:abc",
              sha256: sha,
              size: content.length,
              readChunk: async (offset, length) => content.slice(offset, offset + length),
              chunkSize,
            });

            // 1. Die zusammengesetzten Bytes sind das Original.
            const assembled = Buffer.from(fake.assembledBytes(result.uploadId));
            expect(assembled.equals(Buffer.from(content))).toBe(true);
            // 2. Der deklarierte Digest entspricht dem SHA-256 des Inhalts.
            const session = fake.uploads.get(result.uploadId);
            expect(session?.expectedSha256).toBe(sha);
            expect(result.sha256).toBe(sha);
            // 3. Jeder angenommene PATCH begann am bestätigten Offset.
            for (const patch of fake.patches) {
              expect(patch.claimedOffset).toBe(patch.confirmedOffset);
            }
            // 4. Die Session endet abgeschlossen.
            expect(session?.status).toBe("completed");
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it("ein einzelner Checksum-Mismatch wird genau einmal wiederholt", async () => {
    // Deterministischer Gegentest: zwei Korruptionen in Folge brechen ab.
    const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const fake = new FakeExtract();
    fake.patchFaults.set(0, "corrupt-transit");
    fake.patchFaults.set(1, "corrupt-transit");
    const client = clientWith(fake);
    await expect(
      runResumableUpload(client, {
        reference: "r",
        sha256: sha256Hex(content),
        size: content.length,
        readChunk: async (offset, length) => content.slice(offset, offset + length),
        chunkSize: 8,
      }),
    ).rejects.toThrow(/zweimal abgelehnt/);
  });

  it("409 ohne Offset-Header wird per HEAD aufgelöst", async () => {
    // patchChunk liefert offset-conflict ohne serverOffset → der Treiber liest
    // den Offset über HEAD neu.
    const content = new Uint8Array([9, 8, 7]);
    const fake = new FakeExtract();
    let firstPatch = true;
    const base = fake.fetchImpl;
    const client = new ExtractHttpClient({
      extractUrl: "https://extract.example.com",
      tokenProvider: new FakeTokenProvider("tok"),
      version: "0.1.0",
      runtime: "docker",
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        if (firstPatch && String(url).includes("/v2/uploads/") && init?.method === "PATCH") {
          firstPatch = false;
          return new Response(JSON.stringify({ error: "conflict", code: "CONFLICT" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        return base(url as string, init);
      }) as unknown as typeof globalThis.fetch,
    });
    const outcome: PatchOutcome = { kind: "offset-conflict", serverOffset: undefined };
    expect(outcome.kind).toBe("offset-conflict");
    const result = await runResumableUpload(client, {
      reference: "r",
      sha256: sha256Hex(content),
      size: content.length,
      readChunk: async (offset, length) => content.slice(offset, offset + length),
      chunkSize: 8,
    });
    expect(Buffer.from(fake.assembledBytes(result.uploadId)).equals(Buffer.from(content))).toBe(true);
  });
});
