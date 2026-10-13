// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { request } from "./control-api";

export interface AuthenticatedDownloadOptions {
  url: string;
  token?: string;
  fallbackFilename: string;
  accept?: string;
}

function filenameFromDisposition(
  disposition: string | null,
  fallback: string,
): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = fallback;
  try {
    candidate = encoded ? decodeURIComponent(encoded) : (plain ?? fallback);
  } catch {
    candidate = fallback;
  }

  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must go
  const safe = candidate.trim().replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  return safe || fallback;
}

/** Downloads a protected resource without placing credentials in the URL. */
export async function downloadAuthenticated({
  url,
  token,
  fallbackFilename,
  accept,
}: AuthenticatedDownloadOptions): Promise<void> {
  const response = await request(url, {
    target: "same-origin",
    token,
    headers: accept ? { Accept: accept } : undefined,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  try {
    anchor.href = objectUrl;
    anchor.download = filenameFromDisposition(
      response.headers.get("Content-Disposition"),
      fallbackFilename,
    );
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }
}
