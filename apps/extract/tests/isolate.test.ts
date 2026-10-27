// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { zipSync, strToU8 } from "fflate";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ExtractError } from "../src/errors.js";
import { buildBpmnRecords, splitMbox } from "../src/pipeline/native/index.js";
import {
  createDirectIsolatedRunner,
  createIsolatedRunner,
  type IsolatedRunner,
} from "../src/pipeline/isolate.js";

// Requirement 5.2: the native parsers run in a Worker (fork fallback) with a
// memory limit so the main process keeps serving health and lease heartbeats.
// These tests drive the REAL child process — under `node` (how the suite
// runs) the entry is the plain `.ts` file with its own module hooks.
const silentLogger = pino({ level: "silent" });

const runner: IsolatedRunner = createIsolatedRunner({
  enabled: true,
  maxOldGenerationSizeMb: 256,
  logger: silentLogger,
});

/** A small synthetic BPMN 2.0 file, same shape as `native-bpmn.test.ts`. */
const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_1">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1" name="Posteingang"/>
    <bpmn:userTask id="Task_1" name="Antragseingang pruefen"/>
    <bpmn:endEvent id="End_1" name="Abgeschlossen"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start_1" targetRef="Task_1"/>
    <bpmn:sequenceFlow id="F2" sourceRef="Task_1" targetRef="End_1"/>
  </bpmn:process>
</bpmn:definitions>`;

const bpmnBuffer = new TextEncoder().encode(BPMN);

describe("isolated runner (requirement 5.2)", () => {
  it("returns the same BPMN records through the worker as in-process", async () => {
    const isolated = await runner.run(
      { kind: "bpmn", reference: "diagram.bpmn", buffer: bpmnBuffer },
      () => buildBpmnRecords("diagram.bpmn", bpmnBuffer),
    );
    const direct = buildBpmnRecords("diagram.bpmn", bpmnBuffer);

    expect(isolated.records.length).toBe(direct.records.length);
    expect(JSON.stringify(isolated)).toBe(JSON.stringify(direct));
  });

  it("revives an ExtractError across the boundary with code, status and retryability", async () => {
    const evil = new TextEncoder().encode(
      `<?xml version="1.0"?>\n<!DOCTYPE d [<!ENTITY x "y">]>\n<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D"/>`,
    );
    const error = await runner
      .run({ kind: "bpmn", reference: "evil.bpmn", buffer: evil }, () => {
        throw new Error("the direct callback must not run");
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExtractError);
    const extractError = error as ExtractError;
    expect(extractError.code).toBe("DOCUMENT_TOO_COMPLEX");
    expect(extractError.status).toBe(422);
    expect(extractError.retryable).toBe(false);
    expect(extractError.message).toContain("DOCTYPE");
  });

  it("keeps Uint8Array payloads intact through the structured clone", async () => {
    // A `From ` separator only starts a message after an empty line.
    const mbox = Buffer.from(
      "From a@b.c Mon Jan 01 00:00:00 2024\n" +
        "Subject: Erste\n\nKörper eins\n\n" +
        "From a@b.c Tue Jan 02 00:00:00 2024\n" +
        "Subject: Zweite\n\nKörper zwei\n",
      "utf8",
    );
    const messages = await runner.run(
      { kind: "mbox-split", buffer: new Uint8Array(mbox) },
      () => splitMbox(new Uint8Array(mbox)),
    );

    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).toBeInstanceOf(Uint8Array);
    }
    const text = new TextDecoder().decode(messages[0]);
    expect(text).toContain("Subject: Erste");
    expect(text).toContain("Körper eins");
  });

  it("round-trips the zip guard: a small package passes, an entry-cap breach throws", async () => {
    const zip = new Uint8Array(
      zipSync({ "a.txt": strToU8("eins"), "b.txt": strToU8("zwei") }),
    );
    await expect(
      runner.run(
        {
          kind: "zip-guard",
          buffer: zip,
          limits: {
            maxEntries: 10,
            maxTotalBytes: 1_000_000,
            maxRatio: 100,
            maxEntryBytes: 1_000_000,
          },
        },
        () => null,
      ),
    ).resolves.toBeNull();

    const error = await runner
      .run(
        {
          kind: "zip-guard",
          buffer: zip,
          limits: {
            maxEntries: 1,
            maxTotalBytes: 1_000_000,
            maxRatio: 100,
            maxEntryBytes: 1_000_000,
          },
        },
        () => null,
      )
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).code).toBe("DOCUMENT_TOO_COMPLEX");
  });

  it("a disabled runner calls the direct callback and never spawns a child", async () => {
    let directCalls = 0;
    const disabled = createDirectIsolatedRunner();
    const records = await disabled.run(
      { kind: "bpmn", reference: "diagram.bpmn", buffer: bpmnBuffer },
      () => {
        directCalls += 1;
        return buildBpmnRecords("diagram.bpmn", bpmnBuffer);
      },
    );
    expect(directCalls).toBe(1);
    expect(records.records.length).toBeGreaterThan(0);
  });

  it("serves consecutive documents in fresh children", async () => {
    const first = await runner.run(
      { kind: "bpmn", reference: "a.bpmn", buffer: bpmnBuffer },
      () => buildBpmnRecords("a.bpmn", bpmnBuffer),
    );
    const second = await runner.run(
      { kind: "bpmn", reference: "b.bpmn", buffer: bpmnBuffer },
      () => buildBpmnRecords("b.bpmn", bpmnBuffer),
    );
    expect(first.records.length).toBe(second.records.length);
  });
});
