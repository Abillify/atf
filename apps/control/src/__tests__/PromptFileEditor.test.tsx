// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The prompt files behind `#[[file:prompts/x.md]]` must be editable in the
 * Studio — before this editor existed the node panel showed the reference and
 * the prompt text itself was unreachable from the UI.
 *
 * Saving comes in three scopes: the file itself (every flow including it
 * changes), a copy under a new name referenced only by this flow ("save as"),
 * or the text moved into the flow with the include dropped ("copy into flow").
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { PromptFileEditor } from "../components/PromptFileEditor";
import {
  inlinePromptRef,
  isEditablePromptPath,
  promptFileRefs,
  rewritePromptRef,
} from "../lib/prompt-files";

const FILE = "prompts/casework-loop-researcher.md";
const BODY = "Du bist ein Rechercheur.\n";

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/flows/prompts/content")) {
      return new Response(
        JSON.stringify({ path: FILE, content: BODY, hash: "h1", writable: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (href.includes("/flows/prompts/write")) {
      const sent = JSON.parse(String(init?.body)) as { path: string; content: string };
      return new Response(JSON.stringify({ path: sent.path, hash: "h2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("promptFileRefs", () => {
  test("finds every reference once, in order", () => {
    expect(
      promptFileRefs(`#[[file:prompts/a.md]]\nText\n#[[file:prompts/b.md]]\n#[[file:prompts/a.md]]`),
    ).toEqual([
      { path: "prompts/a.md", editable: true },
      { path: "prompts/b.md", editable: true },
    ]);
  });

  test("marks paths outside prompts/ and traversal attempts as not editable", () => {
    expect(promptFileRefs("#[[file:shared/a.md]]")).toEqual([
      { path: "shared/a.md", editable: false },
    ]);
    expect(promptFileRefs("#[[file:prompts/../a.md]]")).toEqual([
      { path: "prompts/../a.md", editable: false },
    ]);
  });

  test("an inline prompt yields no references", () => {
    expect(promptFileRefs("Du bist hilfsbereit.")).toEqual([]);
    expect(promptFileRefs(undefined)).toEqual([]);
  });
});

describe("isEditablePromptPath", () => {
  test("accepts Markdown under prompts/ only", () => {
    expect(isEditablePromptPath("prompts/a.md")).toBe(true);
    expect(isEditablePromptPath("prompts/sub/dir/a.markdown")).toBe(true);
    expect(isEditablePromptPath("prompts/a.txt")).toBe(true);
    expect(isEditablePromptPath("shared/a.md")).toBe(false);
    expect(isEditablePromptPath("prompts/a.sh")).toBe(false);
    expect(isEditablePromptPath("prompts/../secrets.md")).toBe(false);
  });
});

describe("rewritePromptRef", () => {
  test("points only the matching reference at the new file", () => {
    expect(
      rewritePromptRef(`#[[file:${FILE}]]`, FILE, "prompts/other.md"),
    ).toBe("#[[file:prompts/other.md]]");
  });

  test("trims the raw tag and leaves other references untouched", () => {
    const text = `#[[file: ${FILE} ]]\n#[[file:prompts/keep.md]]`;
    expect(rewritePromptRef(text, FILE, "prompts/other.md")).toBe(
      "#[[file:prompts/other.md]]\n#[[file:prompts/keep.md]]",
    );
  });
});

describe("inlinePromptRef", () => {
  test("replaces the matching reference with the prompt text", () => {
    expect(inlinePromptRef(`Vortext\n#[[file:${FILE}]]`, FILE, BODY)).toBe(
      `Vortext\n${BODY}`,
    );
  });

  test("leaves other references in place", () => {
    const text = `#[[file:${FILE}]] #[[file:prompts/keep.md]]`;
    expect(inlinePromptRef(text, FILE, "Text")).toBe(
      "Text #[[file:prompts/keep.md]]",
    );
  });
});

describe("PromptFileEditor", () => {
  test("renders nothing for an inline prompt", () => {
    const { container } = render(
      <PromptFileEditor systemPrompt="Du bist hilfsbereit." token="t" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("loads the referenced file and saves edits back to it", async () => {
    render(<PromptFileEditor systemPrompt={`#[[file:${FILE}]]`} token="t" />);

    const area = (await screen.findByRole("textbox", {
      name: `Prompt file ${FILE}`,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe(BODY));

    const save = screen.getByRole("button", { name: /Save prompt file/ });
    // Nothing changed yet — saving is disabled.
    expect(save).toBeDisabled();

    fireEvent.change(area, { target: { value: "Neuer Prompt." } });
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument();
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(/^saved$/)).toBeInTheDocument());

    const writeCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url]) => String(url).includes("/flows/prompts/write"),
    );
    expect(writeCall).toBeDefined();
    expect(JSON.parse(String((writeCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      path: FILE,
      content: "Neuer Prompt.",
      baseHash: "h1",
    });
  });

  test("keeps the editor read-only when the flows directory is not writable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ path: FILE, content: BODY, hash: "h1", writable: false }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    render(<PromptFileEditor systemPrompt={`#[[file:${FILE}]]`} token="t" />);
    await screen.findByText(/read-only/);
    expect(screen.getByRole("button", { name: /Save prompt file/ })).toBeDisabled();
  });

  test("shows the backend error and offers a retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: `Prompt file ${FILE} not found.` } }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    render(<PromptFileEditor systemPrompt={`#[[file:${FILE}]]`} token="t" />);
    await screen.findByText(new RegExp(`Prompt file ${FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} not found`));
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  test("explains why a reference outside prompts/ cannot be edited", () => {
    render(<PromptFileEditor systemPrompt="#[[file:shared/a.md]]" token="t" />);
    expect(screen.getByText(/cannot be edited here/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("hides the flow-local modes without onSystemPromptChange", async () => {
    render(<PromptFileEditor systemPrompt={`#[[file:${FILE}]]`} token="t" />);
    await screen.findByRole("textbox", { name: `Prompt file ${FILE}` });
    expect(screen.queryByRole("button", { name: /Save as/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy into flow/ })).toBeNull();
  });

  test("save as writes a new file and repoints only this flow's reference", async () => {
    const onSystemPromptChange = vi.fn();
    const fetchMock = mockFetch();
    render(
      <PromptFileEditor
        systemPrompt={`#[[file:${FILE}]]`}
        token="t"
        onSystemPromptChange={onSystemPromptChange}
      />,
    );
    const area = (await screen.findByRole("textbox", {
      name: `Prompt file ${FILE}`,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe(BODY));

    fireEvent.click(screen.getByRole("button", { name: /Save as\u2026/ }));
    const pathInput = screen.getByRole("textbox", {
      name: `New prompt file path for ${FILE}`,
    }) as HTMLInputElement;
    // Pre-filled with the current path so the user only edits the name.
    expect(pathInput.value).toBe(FILE);
    fireEvent.change(pathInput, { target: { value: "prompts/other.md" } });
    fireEvent.change(area, { target: { value: "Angepasster Prompt." } });

    fireEvent.click(screen.getByRole("button", { name: /^Save as$/ }));
    await waitFor(() => expect(onSystemPromptChange).toHaveBeenCalledOnce());

    // The copy is a new file — written without baseHash, unlike a plain save.
    const writeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/flows/prompts/write"),
    );
    expect(writeCall).toBeDefined();
    expect(JSON.parse(String((writeCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      path: "prompts/other.md",
      content: "Angepasster Prompt.",
    });
    // Only this flow's reference moves; the old file stays on disk untouched.
    expect(onSystemPromptChange).toHaveBeenCalledWith(
      "#[[file:prompts/other.md]]",
    );
  });

  test("copy into flow drops the include and never writes to disk", async () => {
    const onSystemPromptChange = vi.fn();
    const fetchMock = mockFetch();
    render(
      <PromptFileEditor
        systemPrompt={`#[[file:${FILE}]]`}
        token="t"
        onSystemPromptChange={onSystemPromptChange}
      />,
    );
    const area = (await screen.findByRole("textbox", {
      name: `Prompt file ${FILE}`,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe(BODY));

    fireEvent.change(area, { target: { value: "Nur in diesem Flow." } });
    fireEvent.click(screen.getByRole("button", { name: /Copy into flow/ }));

    expect(onSystemPromptChange).toHaveBeenCalledWith("Nur in diesem Flow.");
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/flows/prompts/write"),
      ),
    ).toBe(false);
  });
});
