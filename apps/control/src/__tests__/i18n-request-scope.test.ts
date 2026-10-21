// @vitest-environment node
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * On the server one process renders many requests: the active locale must not
 * leak from one request to a concurrent one. (No `window` here, so the
 * helpers use their request-scoped store.)
 */
import { describe, expect, it } from "vitest";
import { formatNumber, getActiveLocale, setActiveLocale, translate } from "../lib/i18n";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What one request does: bind its locale, yield to the others, then render. */
async function renderRequest(locale: "de" | "en", yieldMs: number) {
  setActiveLocale(locale);
  await sleep(yieldMs);
  return {
    active: getActiveLocale(),
    text: translate("auth.continueWithToken"),
    number: formatNumber(1234.5),
  };
}

describe("per-request locale on the server", () => {
  it("two parallel requests each render in their own language", async () => {
    // Started in the same tick, interleaved by different delays.
    const [de, en] = await Promise.all([renderRequest("de", 20), renderRequest("en", 5)]);
    expect(de.active).toBe("de");
    expect(en.active).toBe("en");
    expect(de.text).not.toBe(en.text);
    expect(de.number).toBe("1.234,5");
    expect(en.number).toBe("1,234.5");
  });

  it("an explicit locale argument wins over the active one", () => {
    setActiveLocale("en");
    expect(translate("auth.continueWithToken", undefined, "de")).not.toBe(translate("auth.continueWithToken"));
  });
});
