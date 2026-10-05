// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `lastUserQuery` feeds `{{query}}` in retrieval tool args. Open WebUI stores
 * file attachments as a separate text part (`<attached_files>…`) that must not
 * leak into the retrieval query (local-model trace 01636a1d).
 */

import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { lastUserQuery, stripAttachmentMarkup } from "../exec-runtime.js";
import type { AgentState } from "../graph-engine.js";

const QUESTION =
  "Untersuche die Meldung des Kunden und bewerte ob es sich um einen Mangel, " +
  "eine Rückfrage oder eine neue Anforderung handelt.";

const ATTACHED =
  '<attached_files>\n<file type="file" id="x" url="/api/v1/files/x" ' +
  'content_type="image/png" name="image.png"/>\n</attached_files>';

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const stateOf = (messages: BaseMessage[]): AgentState =>
  ({ messages, context: {} }) as unknown as AgentState;

describe("lastUserQuery — attachment markup", () => {
  test("drops the Open WebUI attached_files part of a multimodal message", () => {
    const query = lastUserQuery(
      stateOf([
        new HumanMessage({
          content: [
            { type: "text", text: ATTACHED },
            { type: "text", text: QUESTION },
            { type: "image_url", image_url: { url: PNG_1PX } },
          ],
        }),
      ]),
    );
    expect(query).toBe(QUESTION);
    expect(query).not.toContain("<attached_files");
  });

  test("strips the markup from string content", () => {
    const query = lastUserQuery(
      stateOf([new HumanMessage(`${ATTACHED}\n\n\n${QUESTION}`)]),
    );
    expect(query).toBe(QUESTION);
  });

  test("reads only the newest human message", () => {
    const query = lastUserQuery(
      stateOf([
        new HumanMessage("alte Frage"),
        new AIMessage("Antwort"),
        new HumanMessage(`${QUESTION}\n${ATTACHED.toUpperCase()}`),
      ]),
    );
    expect(query).toBe(QUESTION);
  });

  test("content without markup is unchanged", () => {
    const text = "Zeile 1\n\n\nZeile 2 mit <b>Tag</b>";
    expect(stripAttachmentMarkup(text)).toBe(text);
    expect(lastUserQuery(stateOf([new HumanMessage(text)]))).toBe(text);
    expect(
      lastUserQuery(
        stateOf([
          new HumanMessage({
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          }),
        ]),
      ),
    ).toBe("a b");
  });

  test("collapses blank lines left behind by a removed block", () => {
    expect(stripAttachmentMarkup(`A\n\n${ATTACHED}\n\nB`)).toBe("A\n\nB");
  });
});
