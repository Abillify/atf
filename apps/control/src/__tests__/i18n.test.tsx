// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, renderHook, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  LOCALE_COOKIE,
  LocaleProvider,
  createFormatters,
  formatDateTime,
  parseLocale,
  setActiveLocale,
  getActiveLocale,
  useI18n,
  writeLocaleCookie,
  readLocaleFromDocument,
} from "../lib/i18n";

afterEach(() => {
  cleanup();
  // Reset global state so tests stay independent.
  setActiveLocale("en");
  document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0`;
  document.documentElement.lang = "";
});

describe("parseLocale (Req 9.7)", () => {
  it("akzeptiert de/en unabhaengig von Gross-/Kleinschreibung", () => {
    expect(parseLocale("de")).toBe("de");
    expect(parseLocale("DE")).toBe("de");
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale("En")).toBe("en");
  });

  it("maps regional variants to the base language", () => {
    expect(parseLocale("en-GB")).toBe("en");
    expect(parseLocale("de-AT")).toBe("de");
  });

  it("falls back to the default (en)", () => {
    expect(parseLocale(undefined)).toBe("en");
    expect(parseLocale("")).toBe("en");
    expect(parseLocale("fr")).toBe("en");
    expect(parseLocale("deutsch")).toBe("en");
  });
});

describe("Locale-Cookie (Req 9.7)", () => {
  it("writes and reads NEXT_LOCALE", () => {
    writeLocaleCookie("de");
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=de`);
    expect(readLocaleFromDocument()).toBe("de");
    writeLocaleCookie("en");
    expect(readLocaleFromDocument()).toBe("en");
  });
});

describe("LocaleProvider / useI18n (Req 9.7)", () => {
  function wrapperDe({ children }: { children: ReactNode }) {
    return <LocaleProvider initialLocale="de">{children}</LocaleProvider>;
  }

  it("returns the de catalog through t()", () => {
    const { result } = renderHook(() => useI18n(), { wrapper: wrapperDe });
    expect(result.current.locale).toBe("de");
    expect(result.current.t("nav.graph")).toBe("Live-Graph");
    expect(result.current.t("chrome.signOut")).toBe("Abmelden");
  });

  it("returns the en catalog as the default", () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <LocaleProvider>{children}</LocaleProvider>
      ),
    });
    expect(result.current.locale).toBe("en");
    expect(result.current.t("nav.graph")).toBe("Live Graph");
  });

  it("setzt document.documentElement.lang", () => {
    render(
      <LocaleProvider initialLocale="de">
        <span>kind</span>
      </LocaleProvider>,
    );
    expect(document.documentElement.lang).toBe("de");
  });

  it("throws without a provider", () => {
    // Suppress React's console.error for error boundaries
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useI18n())).toThrow();
    spy.mockRestore();
  });

  it("setLocale switches catalog and cookie", () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <LocaleProvider>{children}</LocaleProvider>
      ),
    });
    act(() => result.current.setLocale("de"));
    expect(result.current.locale).toBe("de");
    expect(result.current.t("nav.approvals")).toBe("Freigaben");
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=de`);
  });
});

describe("Intl-Formatierung (Req 9.7)", () => {
  const date = new Date("2026-02-03T14:05:00Z");

  it("formattiert Zahlen locale-gerecht", () => {
    expect(createFormatters("de").formatNumber(1234.5)).toBe("1.234,5");
    expect(createFormatters("en").formatNumber(1234.5)).toBe("1,234.5");
  });

  it("formattiert Datum/Zeit locale-gerecht unterschiedlich", () => {
    const de = createFormatters("de").formatDateTime(date);
    const en = createFormatters("en").formatDateTime(date);
    expect(de).not.toBe(en);
    // dateStyle "short": de Tag vor Monat (03.02.26), en Monat vor Tag (2/3/26)
    expect(de).toContain("03.02.26");
    expect(en).toContain("2/3/26");
  });

  it("formatDateTime returns a placeholder for invalid dates", () => {
    expect(formatDateTime(new Date("kein Datum"))).toBe("—");
  });

  it("global helpers follow setActiveLocale", () => {
    setActiveLocale("de");
    expect(getActiveLocale()).toBe("de");
    expect(formatDateTime(date)).toContain("03.02.26");
  });

  it("currency follows the locale", () => {
    const de = createFormatters("de").formatCurrency(1234.5, 2, "EUR");
    const en = createFormatters("en").formatCurrency(1234.5, 2, "EUR");
    expect(de).toContain("1.234,50");
    expect(en).toContain("1,234.50");
  });
});

describe("Katalog-Paritaet (Req 9.7)", () => {
  it("de contains every key from en", async () => {
    const { en } = await import("../lib/i18n/catalogs/en");
    const { de } = await import("../lib/i18n/catalogs/de");
    const enKeys = Object.keys(en);
    for (const key of enKeys) {
      expect(de, `de fehlt: ${key}`).toHaveProperty(key);
    }
  });
});
