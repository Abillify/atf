// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

const MINUTE_MS = 60_000;
const MAX_SEARCH_MINUTES = 5 * 366 * 24 * 60;

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

export interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseInteger(value: string, minimum: number, maximum: number, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label} value '${value}'.`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${label} value '${value}' must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseField(source: string, minimum: number, maximum: number, label: string): CronField {
  const values = new Set<number>();
  const wildcard = source === "*";
  for (const part of source.split(",")) {
    const [rangeSource, stepSource] = part.split("/");
    if (rangeSource === undefined || rangeSource === "") throw new Error(`Invalid ${label} field.`);
    const step = stepSource === undefined ? 1 : parseInteger(stepSource, 1, maximum - minimum + 1, `${label} step`);
    let start: number;
    let end: number;
    if (rangeSource === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeSource.includes("-")) {
      const [startSource, endSource] = rangeSource.split("-");
      if (startSource === undefined || endSource === undefined) throw new Error(`Invalid ${label} range.`);
      start = parseInteger(startSource, minimum, maximum, label);
      end = parseInteger(endSource, minimum, maximum, label);
      if (start > end) throw new Error(`Invalid descending ${label} range '${rangeSource}'.`);
    } else {
      start = parseInteger(rangeSource, minimum, maximum, label);
      end = start;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`Empty ${label} field.`);
  return { values, wildcard };
}

/** Parses a standard five-field cron expression. Scheduling is deliberately UTC-only. */
export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expressions must contain exactly five fields.");
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (minute === undefined || hour === undefined || dayOfMonth === undefined || month === undefined || dayOfWeek === undefined) {
    throw new Error("Cron expressions must contain exactly five fields.");
  }
  return {
    minute: parseField(minute, 0, 59, "minute"),
    hour: parseField(hour, 0, 23, "hour"),
    dayOfMonth: parseField(dayOfMonth, 1, 31, "day-of-month"),
    month: parseField(month, 1, 12, "month"),
    dayOfWeek: parseField(dayOfWeek, 0, 7, "day-of-week"),
  };
}

function matches(parsed: ParsedCronExpression, candidate: Date): boolean {
  const weekday = candidate.getUTCDay();
  const weekdayMatches = parsed.dayOfWeek.values.has(weekday) || (weekday === 0 && parsed.dayOfWeek.values.has(7));
  const monthDayMatches = parsed.dayOfMonth.values.has(candidate.getUTCDate());
  const dayMatches = parsed.dayOfMonth.wildcard
    ? weekdayMatches
    : parsed.dayOfWeek.wildcard
      ? monthDayMatches
      : monthDayMatches || weekdayMatches;
  return parsed.minute.values.has(candidate.getUTCMinutes())
    && parsed.hour.values.has(candidate.getUTCHours())
    && parsed.month.values.has(candidate.getUTCMonth() + 1)
    && dayMatches;
}

/** Returns the first matching UTC minute strictly after `after`. */
export function nextCronOccurrence(expression: string, after: Date): Date {
  const parsed = parseCronExpression(expression);
  const start = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let offset = 0; offset < MAX_SEARCH_MINUTES; offset += 1) {
    const candidate = new Date(start + offset * MINUTE_MS);
    if (matches(parsed, candidate)) return candidate;
  }
  throw new Error("Cron expression has no occurrence within the next five years.");
}
