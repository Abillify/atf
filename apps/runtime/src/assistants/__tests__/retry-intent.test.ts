// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  classifySafeParkingReadIntent,
  isRetryRequest,
  resolveSafeRetryIntent,
} from "../retry-intent.js";

describe("safe assistant retry intent", () => {
  test("recognises explicit retries, including the observed typo", () => {
    for (const query of ["retry", "versuchs nochmal", "ry again"]) {
      expect(isRetryRequest(query)).toBe(true);
    }
    expect(isRetryRequest("hallo")).toBe(false);
  });

  test("classifies only explicit parking read intents", () => {
    expect(classifySafeParkingReadIntent("Auf welchem Parkplatz stehe ich morgen?")).toBe("status");
    expect(classifySafeParkingReadIntent("Welche Parkplätze sind morgen verfügbar?")).toBe("availability");
    expect(classifySafeParkingReadIntent("Buche mir Parkplatz P_10")).toBeUndefined();
    expect(classifySafeParkingReadIntent("Verschiebe meine Parkplatzbuchung")).toBeUndefined();
  });

  test("continues the nearest safe read intent without inheriting parking writes", () => {
    expect(
      resolveSafeRetryIntent("ry again", [
        "Auf welchem Parkplatz stehe ich heute?",
        "und morgen",
      ]),
    ).toEqual({ intent: "status", toolRefs: ["parking/status"] });
    expect(
      resolveSafeRetryIntent("retry", ["Buche mir Parkplatz P_10"]),
    ).toBeUndefined();
  });

  test("never resolves a normal follow-up as a retry", () => {
    expect(
      resolveSafeRetryIntent("Welche Parkplätze sind morgen frei?", [
        "Auf welchem Parkplatz stehe ich heute?",
      ]),
    ).toBeUndefined();
  });
});
