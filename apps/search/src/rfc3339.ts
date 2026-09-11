// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/** RFC 3339 date-time with a mandatory UTC designator or numeric offset. */
const RFC3339_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

/**
 * Validate and canonicalize a timestamp accepted by the temporal-versioning APIs.
 * Offset-less values are deliberately rejected because their instant depends on
 * the host timezone. Calendar and clock fields are checked before Date parsing,
 * which otherwise normalizes invalid values such as February 30 or hour 24.
 */
export function parseRfc3339DateTime(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("must be an RFC 3339 date-time with an explicit timezone");
  }
  const match = RFC3339_WITH_ZONE.exec(value.trim());
  if (!match) {
    throw new Error("must be an RFC 3339 date-time with an explicit timezone");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) {
    throw new Error("must be a valid RFC 3339 date-time with an explicit timezone");
  }
  const millis = Date.parse(value.trim());
  if (!Number.isFinite(millis)) {
    throw new Error("must be a valid RFC 3339 date-time with an explicit timezone");
  }
  return new Date(millis).toISOString();
}
