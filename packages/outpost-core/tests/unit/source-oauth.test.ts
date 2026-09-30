// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the cloud source authorization (task 12.9).
 *
 * Covers: device-flow `invalid_scope` → code-paste fallback (6.15),
 * service-account via `_FILE` without user authorization (6.10), env-name
 * collision (6.10), refresh-token rotation written back (6.17),
 * `invalid_grant` keeping the stored token (6.18), and Google
 * `client_secret` redaction (4.6).
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildServiceAccountAssertion,
  exchangeCodeForTokens,
  gdriveSaKeyFileEnv,
  loadGoogleClientSecret,
  MemoryCredentialStore,
  parseServiceAccountKey,
  persistRotatedRefreshToken,
  refreshSourceToken,
  requestGdriveDeviceCode,
  resolveSourceCredential,
  SecretRedactor,
  serviceAccountToken,
  SourceTransientError,
  sourceGdriveSaKey,
  sourceLoginHint,
  sourceOauthRefreshKey,
  startGdriveAuthorization,
  validateConfig,
  type Env,
  type FetchLike,
  type SourceConfig,
} from "../../src/index.js";

/** Minimal FetchLike backed by a scripted response. */
function fakeFetch(
  status: number,
  body: unknown,
  captured?: { url?: string; body?: string },
): FetchLike {
  return async (url, init) => {
    if (captured) {
      captured.url = url;
      captured.body = init?.body;
    }
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    };
  };
}

const gdriveSource = (over: Partial<Extract<SourceConfig, { type: "gdrive" }>> = {}): SourceConfig => ({
  type: "gdrive",
  id: "g1",
  folderId: "folder-1",
  exportFormat: "pdf",
  auth: "oauth",
  ...over,
});

describe("parsePastedInput / exchange: Fehlerklassifikation (6.12, 6.18)", () => {
  it("Code-Tausch liefert Tokens und optionales rotiertes Refresh-Token", async () => {
    const captured: { url?: string; body?: string } = {};
    const result = await exchangeCodeForTokens(
      "gdrive",
      {
        clientId: "cid",
        clientSecret: "gsecret",
        code: "code-123",
        codeVerifier: "verifier-value",
        redirectUri: "http://127.0.0.1:49999",
      },
      fakeFetch(200, { access_token: "at", refresh_token: "rt-new", expires_in: 3600 }, captured),
    );
    expect(result).toEqual({
      kind: "ok",
      accessToken: "at",
      refreshToken: "rt-new",
      expiresInSec: 3600,
    });
    const form = new URLSearchParams(captured.body ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe("verifier-value");
    expect(form.get("client_secret")).toBe("gsecret");
    expect(form.get("redirect_uri")).toBe("http://127.0.0.1:49999");
  });

  it("invalid_grant → rejected; das gespeicherte Token bleibt (6.18)", async () => {
    const store = new MemoryCredentialStore();
    await store.set(sourceOauthRefreshKey("g1"), "stored-refresh");
    const result = await refreshSourceToken(
      "gdrive",
      { clientId: "cid", clientSecret: "s", refreshToken: "stored-refresh" },
      fakeFetch(400, { error: "invalid_grant" }),
    );
    expect(result).toEqual({ kind: "rejected", detail: "invalid_grant" });
    // 6.18: abgelehntes Token wird NICHT gelöscht.
    expect(await store.get(sourceOauthRefreshKey("g1"))).toBe("stored-refresh");
  });

  it("401 ohne OAuth-Fehlercode → rejected", async () => {
    const result = await refreshSourceToken(
      "dropbox",
      { clientId: "cid", refreshToken: "rt" },
      fakeFetch(401, ""),
    );
    expect(result).toEqual({ kind: "rejected", detail: "http_401" });
  });

  it("5xx und Netzwerkfehler sind transient, nicht rejected (6.12)", async () => {
    await expect(
      refreshSourceToken("dropbox", { clientId: "cid", refreshToken: "rt" }, fakeFetch(503, {})),
    ).rejects.toBeInstanceOf(SourceTransientError);
    const throwing: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      refreshSourceToken("dropbox", { clientId: "cid", refreshToken: "rt" }, throwing),
    ).rejects.toBeInstanceOf(SourceTransientError);
  });

  it("Fehlermeldungen enthalten keine Token-Inhalte", async () => {
    const secretToken = "super-secret-refresh-value";
    const bodyEcho: FetchLike = async () => ({
      status: 400,
      ok: false,
      json: async () => ({ error: "invalid_grant" }),
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });
    const result = await refreshSourceToken(
      "dropbox",
      { clientId: "cid", refreshToken: secretToken },
      bodyEcho,
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.detail ?? "").not.toContain(secretToken);
    }
  });

  it("Rotation schreibt das neue Refresh-Token atomar zurück (6.17)", async () => {
    const store = new MemoryCredentialStore();
    await store.set(sourceOauthRefreshKey("d1"), "old-rt");
    const result = await refreshSourceToken(
      "dropbox",
      { clientId: "cid", refreshToken: "old-rt" },
      fakeFetch(200, { access_token: "at", refresh_token: "rotated-rt" }),
    );
    const written = await persistRotatedRefreshToken(store, "d1", result);
    expect(written).toBe("rotated-rt");
    expect(await store.get(sourceOauthRefreshKey("d1"))).toBe("rotated-rt");
  });

  it("persistRotatedRefreshToken ist No-op ohne Rotation", async () => {
    const store = new MemoryCredentialStore();
    await store.set(sourceOauthRefreshKey("d1"), "keep-me");
    const written = await persistRotatedRefreshToken(store, "d1", {
      kind: "ok",
      accessToken: "at",
    });
    expect(written).toBeUndefined();
    expect(await store.get(sourceOauthRefreshKey("d1"))).toBe("keep-me");
  });
});

describe("resolveSourceCredential (6.10, 6.17, 6.18)", () => {
  it("local/s3 → static", async () => {
    const store = new MemoryCredentialStore();
    const local: SourceConfig = { type: "local", id: "l", path: "/tmp", watch: false };
    const s3: SourceConfig = { type: "s3", id: "s", bucket: "b", credentials: "store" };
    expect(await resolveSourceCredential(local, store, {})).toEqual({ kind: "static" });
    expect(await resolveSourceCredential(s3, store, {})).toEqual({ kind: "static" });
  });

  it("GDrive service-account liest den Docker-`_FILE`-Pfad ohne Benutzer-Autorisierung (6.10)", async () => {
    const store = new MemoryCredentialStore();
    const env: Env = { OUTPOST_SOURCE_G1_GDRIVE_SA_KEY_FILE: "/run/secrets/g1_sa.json" };
    expect(gdriveSaKeyFileEnv("g1")).toBe("OUTPOST_SOURCE_G1_GDRIVE_SA_KEY_FILE");
    const result = await resolveSourceCredential(
      gdriveSource({ auth: "service-account" }),
      store,
      env,
      new Set(),
      { readFile: async (p) => (p === "/run/secrets/g1_sa.json" ? "KEY-JSON" : "") },
    );
    expect(result).toEqual({ kind: "service-account", keyJson: "KEY-JSON" });
  });

  it("GDrive service-account fällt auf den Schlüsselbund zurück (Desktop)", async () => {
    const store = new MemoryCredentialStore();
    await store.set(sourceGdriveSaKey("g1"), "sa-from-keychain");
    const result = await resolveSourceCredential(
      gdriveSource({ auth: "service-account" }),
      store,
      {},
      new Set(),
    );
    expect(result).toEqual({ kind: "service-account", keyJson: "sa-from-keychain" });
  });

  it("unlesbares `_FILE` → needs-authorization (missing)", async () => {
    const result = await resolveSourceCredential(
      gdriveSource({ auth: "service-account" }),
      new MemoryCredentialStore(),
      { OUTPOST_SOURCE_G1_GDRIVE_SA_KEY_FILE: "/missing" },
      new Set(),
      {
        readFile: async () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(result).toEqual({ kind: "needs-authorization", reason: "missing" });
  });

  it("oauth ohne Token → needs-authorization missing; mit Token → refresh-token", async () => {
    const store = new MemoryCredentialStore();
    expect(await resolveSourceCredential(gdriveSource(), store, {})).toEqual({
      kind: "needs-authorization",
      reason: "missing",
    });
    await store.set(sourceOauthRefreshKey("g1"), "rt");
    expect(await resolveSourceCredential(gdriveSource(), store, {})).toEqual({
      kind: "refresh-token",
      token: "rt",
    });
  });

  it("abgelehnte Source → needs-authorization rejected (6.18)", async () => {
    const result = await resolveSourceCredential(gdriveSource(), new MemoryCredentialStore(), {}, new Set(["g1"]));
    expect(result).toEqual({ kind: "needs-authorization", reason: "rejected" });
    expect(sourceLoginHint("g1")).toBe("atf-outpost source-login g1");
  });

  it("liest bei jedem Aufruf frisch aus dem Store (6.17)", async () => {
    const store = new MemoryCredentialStore();
    const before = await resolveSourceCredential(gdriveSource(), store, {});
    expect(before.kind).toBe("needs-authorization");
    // source-login schreibt das Token, ohne den Prozess neu zu starten …
    await store.set(sourceOauthRefreshKey("g1"), "fresh-rt");
    // … der nächste Run sieht es sofort.
    const after = await resolveSourceCredential(gdriveSource(), store, {});
    expect(after).toEqual({ kind: "refresh-token", token: "fresh-rt" });
  });
});

describe("Env-Namens-Kollision (6.10)", () => {
  it("weist Source-IDs zurück, die auf denselben Env-Namen abbilden", () => {
    const result = validateConfig({
      extractUrl: "https://extract.example.com",
      collection: "docs",
      sources: [
        { type: "local", id: "team-a", path: "/a", watch: false },
        { type: "local", id: "team_a", path: "/b", watch: false },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("TEAM_A"))).toBe(true);
    }
  });
});

describe("GDrive-Device-Flow (6.15)", () => {
  it("invalid_scope → Rückfall auf Code-Paste mit Log-Eintrag", async () => {
    const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
    const plan = await startGdriveAuthorization({
      clientId: "cid",
      deviceFlow: true,
      fetchImpl: fakeFetch(400, { error: "invalid_scope" }),
      log: (msg, fields) => logs.push({ msg, fields }),
    });
    expect(plan).toEqual({ kind: "code-paste", reason: "invalid-scope" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.msg).toBe("source.gdrive.device_flow_unavailable");
    expect(logs[0]?.fields).toEqual({ reason: "invalid_scope", fallback: "code-paste" });
  });

  it("deviceFlow:false → direkt Code-Paste, kein Netzwerkaufruf", async () => {
    let called = false;
    const plan = await startGdriveAuthorization({
      clientId: "cid",
      deviceFlow: false,
      fetchImpl: async () => {
        called = true;
        throw new Error("muss nicht aufgerufen werden");
      },
      log: () => {},
    });
    expect(plan).toEqual({ kind: "code-paste" });
    expect(called).toBe(false);
  });

  it("erfolgreiche Device-Antwort liefert Verifizierungs-URL und Benutzer-Code", async () => {
    const result = await requestGdriveDeviceCode(
      "cid",
      fakeFetch(200, {
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri: "https://google.com/device",
        verification_uri_complete: "https://google.com/device?user_code=ABCD-1234",
        expires_in: 1800,
        interval: 5,
      }),
    );
    expect(result).toEqual({
      kind: "device-code",
      device: {
        deviceCode: "dc",
        userCode: "ABCD-1234",
        verificationUri: "https://google.com/device",
        verificationUriComplete: "https://google.com/device?user_code=ABCD-1234",
        expiresInSec: 1800,
        intervalSec: 5,
      },
    });
  });

  it("5xx am Device-Endpunkt ist ein transienter Fehler", async () => {
    await expect(requestGdriveDeviceCode("cid", fakeFetch(500, {}))).rejects.toThrow(/500/);
  });
});

describe("Service-Account (6.10, 6.20, 15.1)", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const keyJson = JSON.stringify({
    type: "service_account",
    project_id: "p",
    private_key_id: "k1",
    private_key: pem,
    client_email: "bot@p.iam.gserviceaccount.com",
    client_id: "123",
    // token_uri wird bewusst ignoriert (15.1) — hier eine böse URL.
    token_uri: "https://evil.example.com/token",
  });

  it("parseServiceAccountKey akzeptiert ein gültiges Schlüssel-JSON", () => {
    const result = parseServiceAccountKey(keyJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key.clientEmail).toBe("bot@p.iam.gserviceaccount.com");
    }
  });

  it("parseServiceAccountKey lehnt fehlerhafte Eingaben ab", () => {
    expect(parseServiceAccountKey("not json")).toEqual({ ok: false, reason: "not-json" });
    expect(parseServiceAccountKey("[]")).toEqual({ ok: false, reason: "not-object" });
    expect(parseServiceAccountKey(JSON.stringify({ type: "authorized_user" }))).toEqual({
      ok: false,
      reason: "wrong-type",
    });
    expect(
      parseServiceAccountKey(JSON.stringify({ type: "service_account", client_email: " ", private_key: pem })),
    ).toEqual({ ok: false, reason: "missing-client-email" });
    expect(
      parseServiceAccountKey(
        JSON.stringify({ type: "service_account", client_email: "a@b.c", private_key: "nope" }),
      ),
    ).toEqual({ ok: false, reason: "missing-private-key" });
    expect(parseServiceAccountKey("x".repeat(64 * 1024 + 1))).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("Assertion nutzt den festen Google-Token-Endpunkt, nie token_uri (15.1)", () => {
    const parsed = parseServiceAccountKey(keyJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const assertion = buildServiceAccountAssertion(parsed.key, { now: () => 1_700_000_000_000 });
    const [header, claims] = assertion.split(".");
    const decodedClaims = JSON.parse(Buffer.from(claims ?? "", "base64url").toString("utf8"));
    expect(decodedClaims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(decodedClaims.scope).toBe("https://www.googleapis.com/auth/drive.readonly");
    expect(decodedClaims.iss).toBe("bot@p.iam.gserviceaccount.com");
    expect(decodedClaims.iat).toBe(1_700_000_000);
    expect(decodedClaims.exp).toBe(1_700_003_600);
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")).alg).toBe("RS256");
  });

  it("serviceAccountToken POSTet den jwt-bearer-Grant an den festen Endpunkt", async () => {
    const parsed = parseServiceAccountKey(keyJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const captured: { url?: string; body?: string } = {};
    const result = await serviceAccountToken(
      parsed.key,
      fakeFetch(200, { access_token: "sa-at", expires_in: 3599 }, captured),
      { now: () => 1_700_000_000_000 },
    );
    expect(result).toEqual({ kind: "ok", accessToken: "sa-at", expiresInSec: 3599 });
    expect(captured.url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(captured.body ?? "");
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")?.split(".")).toHaveLength(3);
  });

  it("abgelehnte Assertion → rejected ohne Tokenlöschung", async () => {
    const parsed = parseServiceAccountKey(keyJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = await serviceAccountToken(
      parsed.key,
      fakeFetch(401, { error: "invalid_grant" }),
      { now: () => 1_700_000_000_000 },
    );
    expect(result).toEqual({ kind: "rejected", detail: "invalid_grant" });
  });
});

describe("Google client_secret wird redigiert (4.6)", () => {
  it("loadGoogleClientSecret registriert den Wert im Redaktor", async () => {
    const redactor = new SecretRedactor();
    const secret = "ya29.googleapis-client-secret-value";
    const store = new MemoryCredentialStore();
    const fromEnv = await loadGoogleClientSecret({ OUTPOST_GDRIVE_CLIENT_SECRET: secret }, store, redactor);
    expect(fromEnv).toBe(secret);
    expect(redactor.redact(`token=${secret} done`)).toBe("token=[REDACTED] done");
  });

  it("liest aus dem Schlüsselbund, wenn die Env fehlt", async () => {
    const redactor = new SecretRedactor();
    const store = new MemoryCredentialStore();
    await store.set("auth:gdrive:client-secret", "keychain-secret");
    const value = await loadGoogleClientSecret({}, store, redactor);
    expect(value).toBe("keychain-secret");
    expect(redactor.redact("prefix keychain-secret suffix")).toBe("prefix [REDACTED] suffix");
  });

  it("undefined ohne Env und ohne Schlüsselbund", async () => {
    expect(await loadGoogleClientSecret({}, new MemoryCredentialStore())).toBeUndefined();
  });
});
