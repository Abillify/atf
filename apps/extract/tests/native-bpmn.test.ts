// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { buildAssetId, nativeLocalId } from "@atf/extract-contract";
import {
	pageRecordSchema,
	processTranscriptionSchema,
} from "@atf/extract-contract/v2";
import { describe, expect, it } from "vitest";
import { ExtractError } from "../src/errors.js";
import { parseBpmn } from "../src/pipeline/native/bpmn.js";
import { buildBpmnRecords } from "../src/pipeline/native/index.js";

/** A small synthetic BPMN 2.0 file: two lanes, tasks, a gateway, a conditioned flow. */
const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_1">
  <bpmn:collaboration id="Collab_1">
    <bpmn:participant id="Part_1" name="Lager" processRef="Process_1"/>
  </bpmn:collaboration>
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_A" name="Wareneingang">
        <bpmn:flowNodeRef>Start_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Gw_1</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_B" name="Qualität">
        <bpmn:flowNodeRef>Task_2</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>End_1</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start_1" name="Anlieferung"/>
    <bpmn:userTask id="Task_1" name="Wareneingang prüfen"/>
    <bpmn:exclusiveGateway id="Gw_1" name="OK?"/>
    <bpmn:serviceTask id="Task_2" name="Einlagern"/>
    <bpmn:endEvent id="End_1" name="Abgeschlossen"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start_1" targetRef="Task_1"/>
    <bpmn:sequenceFlow id="F2" sourceRef="Task_1" targetRef="Gw_1"/>
    <bpmn:sequenceFlow id="F3" name="ja" sourceRef="Gw_1" targetRef="Task_2"/>
    <bpmn:sequenceFlow id="F4" sourceRef="Task_2" targetRef="End_1"/>
  </bpmn:process>
</bpmn:definitions>`;

describe("parseBpmn", () => {
  it("produces a contract-valid process transcription with nodes, edges, lanes, steps and mermaid", () => {
    const { transcription, warnings } = parseBpmn(BPMN);

    // The transcription is exactly the contract's `process` shape.
    expect(() => processTranscriptionSchema.parse(transcription)).not.toThrow();
    expect(transcription.format).toBe("process");
    expect(warnings).toEqual([]);

    // Five flow nodes, four edges.
    expect(transcription.nodes.map((n) => n.id).sort()).toEqual([
      "End_1",
      "Gw_1",
      "Start_1",
      "Task_1",
      "Task_2",
    ]);
    expect(transcription.edges).toHaveLength(4);

    // Node types and labels came from the element name + `name` attribute.
    const task1 = transcription.nodes.find((n) => n.id === "Task_1");
    expect(task1).toMatchObject({
      type: "userTask",
      label: "Wareneingang prüfen",
      lane: "Wareneingang",
    });
    const gw = transcription.nodes.find((n) => n.id === "Gw_1");
    expect(gw).toMatchObject({
      type: "exclusiveGateway",
      lane: "Wareneingang",
    });

    // Lanes are captured, and lane membership is stamped on each node.
    expect(transcription.lanes).toEqual(["Wareneingang", "Qualität"]);
    expect(transcription.nodes.find((n) => n.id === "Task_2")?.lane).toBe(
      "Qualität",
    );

    // The conditioned flow carries its name as the condition.
    const conditioned = transcription.edges.find(
      (e) => e.from === "Gw_1" && e.to === "Task_2",
    );
    expect(conditioned?.condition).toBe("ja");

    // Steps are a linear walk from the start event.
    expect(transcription.steps[0]).toBe("Anlieferung");
    expect(transcription.steps).toContain("Einlagern");
    expect(transcription.steps[transcription.steps.length - 1]).toBe(
      "Abgeschlossen",
    );

    // A Mermaid rendering is generated deterministically.
    expect(transcription.mermaid.startsWith("flowchart TD")).toBe(true);
    expect(transcription.mermaid).toContain("Wareneingang prüfen");
  });

  it("reads a conditionExpression when a flow has no name", () => {
    const xml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P">
    <exclusiveGateway id="G"/>
    <task id="T"/>
    <sequenceFlow id="F" sourceRef="G" targetRef="T">
      <conditionExpression xsi:type="tFormalExpression">amount &gt; 100</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
    const { transcription } = parseBpmn(xml);
    expect(transcription.edges[0]?.condition).toContain("amount");
  });

  it("uses the node id as the label when no name is given", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P"><task id="OnlyId"/></process></definitions>`;
    const { transcription } = parseBpmn(xml);
    expect(transcription.nodes[0]).toMatchObject({
      id: "OnlyId",
      label: "OnlyId",
    });
  });

  it("degrades to an empty process with a warning on non-BPMN input", () => {
    const { transcription, warnings } = parseBpmn("this is not xml at all { ]");
    expect(transcription.nodes).toEqual([]);
    expect(transcription.edges).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("does not throw on a definitions with no process", () => {
    const { transcription, warnings } = parseBpmn(
      `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>`,
    );
    expect(transcription.nodes).toEqual([]);
    expect(warnings.some((w) => /process/i.test(w))).toBe(true);
  });

  // ── Requirement 5.3: DOCTYPE rejection, entity processing off ──────────

  it("rejects a BPMN document with a DOCTYPE declaration", () => {
    const xml = `<!DOCTYPE definitions [<!ENTITY x "boom">]>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P"><task id="T" name="&x;"/></process></definitions>`;
    let caught: unknown;
    try {
      parseBpmn(xml);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExtractError);
    if (caught instanceof ExtractError) {
      expect(caught.code).toBe("DOCUMENT_TOO_COMPLEX");
      expect(caught.status).toBe(422);
      expect(caught.retryable).toBe(false);
    }
  });

  it("rejects a Billion Laughs entity bomb before the parser sees it", () => {
    const bomb = `<!DOCTYPE definitions [
<!ENTITY lol "lol">
<!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P"><task id="T" name="&lol3;"/></process></definitions>`;
    expect(() => parseBpmn(bomb)).toThrowError(ExtractError);
  });

  it("matches a DOCTYPE declaration case-insensitively", () => {
    const xml = `<!doctype definitions><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>`;
    expect(() => parseBpmn(xml)).toThrowError(ExtractError);
  });

  it("decodes the five predefined entities and leaves all others raw", () => {
    // Entity processing is off in the parser; the five
    // predefined XML entities are decoded by hand, everything else —
    // named HTML entities, numeric references — stays raw, exactly like
    // the parser default with htmlEntities disabled.
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P"><task id="T" name="A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos; &copy; &#65; &amp;amp;"/></process></definitions>`;
    const { transcription } = parseBpmn(xml);
    expect(transcription.nodes[0]?.label).toBe(
      `A & B < C > D "E" 'F' &copy; &#65; &amp;`,
    );
  });
});

describe("buildBpmnRecords", () => {
	it("emits one contract-valid page with a bpmn figure and a native: asset", () => {
		const reference = "doc-ref-123";
		const buffer = new TextEncoder().encode(BPMN);
		const { records, nativeAssets, warnings } = buildBpmnRecords(
			reference,
			buffer,
		);

		expect(warnings).toEqual([]);
		expect(records).toHaveLength(1);
		const [record] = records;
		if (record === undefined) throw new Error("expected a record");
		// The page record validates against the contract.
		expect(() => pageRecordSchema.parse(record)).not.toThrow();
		expect(record.class).toBe("drawing");

		// One figure block of kind bpmn, source native, with the process transcription.
		const figure = record.blocks.find((b) => b.type === "figure");
		expect(figure).toBeDefined();
		if (figure?.type === "figure") {
			expect(figure.kind).toBe("bpmn");
			expect(figure.source).toBe("native");
			expect(figure.transcription?.format).toBe("process");
		}

		// The original .bpmn XML is a native: asset, and its id is the contract
		// derivation of `native:diagram.bpmn`.
		const nativeAsset = record.assets.find((a) => a.kind === "native");
		expect(nativeAsset).toBeDefined();
		expect(nativeAsset?.localId).toBe(nativeLocalId("diagram.bpmn"));
		expect(nativeAsset?.assetId).toBe(
			buildAssetId(reference, nativeLocalId("diagram.bpmn")),
		);
		expect(nativeAsset?.mimeType).toBe("application/bpmn+xml");

		// The native asset bytes are the original XML, verbatim.
		expect(nativeAssets).toHaveLength(1);
		const [nativeBody] = nativeAssets;
		if (nativeBody === undefined) throw new Error("expected a native asset body");
		expect(new TextDecoder().decode(nativeBody.buffer)).toBe(BPMN);
	});
});
