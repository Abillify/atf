// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the assistant context framing and echo containment
 * (`assistants/context-frame.ts`).
 *
 * The failure these guard against: the injected config block was folded into the
 * user turn, the model read "## Who you are / - Name: Assistant1" as the user
 * introducing themselves, addressed the user as "Assistant1", and prefixed every
 * reply with the block — which was then persisted and replayed as prior dialogue.
 */
import { describe, test, expect } from "bun:test";
import {
  ASSISTANT_CONTEXT_FRAME,
  stripLeakedContextEcho,
} from "../context-frame.js";

describe("ASSISTANT_CONTEXT_FRAME", () => {
  test("states whose identity the block describes and forbids repeating it", () => {
    expect(ASSISTANT_CONTEXT_FRAME).toContain("YOU, the assistant");
    expect(ASSISTANT_CONTEXT_FRAME).toContain("as the user's name");
    expect(ASSISTANT_CONTEXT_FRAME).toContain("never repeat");
    expect(ASSISTANT_CONTEXT_FRAME.startsWith("[")).toBe(true);
  });
});

describe("stripLeakedContextEcho", () => {
  test("removes an echoed identity block", () => {
    const echoed =
      "## Who you are\n- Name: Assistant1\n\nHello! I am the helpdesk assistant. How can I help you?";
    expect(stripLeakedContextEcho(echoed)).toBe(
      "Hello! I am the helpdesk assistant. How can I help you?",
    );
  });

  test("removes several consecutive echoed blocks", () => {
    const echoed = [
      "## Who you are\n- Name: Assistant1",
      "## Tool access for this run\nYou are running without your user's credentials, so tools that act on their behalf are unavailable.\nDo not attempt those tools.",
      "I cannot look up your parking space.",
    ].join("\n\n");
    expect(stripLeakedContextEcho(echoed)).toBe(
      "I cannot look up your parking space.",
    );
  });

  test("leaves a normal answer untouched", () => {
    const answer = "You are in space P_10 today.\n\nAnything else?";
    expect(stripLeakedContextEcho(answer)).toBe(answer);
  });

  test("keeps a heading that appears inside a real answer", () => {
    const answer =
      "Sure, here is my configuration:\n\n## Hard limits\n- no external email";
    expect(stripLeakedContextEcho(answer)).toBe(answer);
  });

  test("never blanks out a message that consists only of an echo", () => {
    const onlyEcho = "## Who you are\n- Name: Assistant1";
    expect(stripLeakedContextEcho(onlyEcho)).toBe(onlyEcho);
  });

  test("handles an empty message", () => {
    expect(stripLeakedContextEcho("")).toBe("");
  });
});
