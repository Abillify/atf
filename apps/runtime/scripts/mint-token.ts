// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Mints an HS256 JWT for the `/v1/*` inference plane (qodo, n8n, Open WebUI, …).
 *
 * The backend accepts this token as `Authorization: Bearer <token>` (or
 * `body.metadata.token`) and verifies its signature against JWT_SECRET
 * (src/middleware/jwt-verifier.ts, HmacVerifier). Use it to authenticate
 * machine clients with a static, long-lived token.
 *
 * The secret is read from JWT_SECRET (.env) and is NEVER printed. Only the
 * signed token is written to stdout, so it stays pipe/copy friendly:
 *
 *   bun run token:mint                       # non-expiring token, sub=machine
 *   bun run token:mint -- --sub n8n          # custom subject
 *   bun run token:mint -- --sub qodo --exp 90d
 *   JWT_SECRET=... bun run token:mint        # override secret inline
 *
 * --exp accepts a jose time span ("30d", "12h", "3600s", "1y") or a plain
 * number of seconds. Omit it (or pass "never") for a token without an `exp`
 * claim — jwtVerify only enforces expiry when the claim is present.
 */
import { SignJWT } from "jose";

interface Args {
  sub: string;
  exp: string | undefined;
  name: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sub: "machine", exp: undefined, name: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--sub":
      case "-s":
        if (value === undefined) fail(`Missing value for ${flag}`);
        args.sub = value;
        i++;
        break;
      case "--exp":
      case "-e":
        if (value === undefined) fail(`Missing value for ${flag}`);
        args.exp = value;
        i++;
        break;
      case "--name":
      case "-n":
        if (value === undefined) fail(`Missing value for ${flag}`);
        args.name = value;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.stderr.write(`Run "bun run token:mint -- --help" for usage.\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stderr.write(
    [
      "Mint an HS256 JWT for the /v1/* API (qodo, n8n, …).",
      "",
      "Usage: bun run token:mint -- [--sub <subject>] [--exp <span>] [--name <name>]",
      "",
      "Options:",
      "  -s, --sub <subject>   Token subject / client id (default: machine)",
      "  -e, --exp <span>      Expiry: jose span (30d, 12h, 3600s, 1y) or seconds.",
      "                        Omit or 'never' for a non-expiring token.",
      "  -n, --name <name>     Optional display name claim.",
      "  -h, --help            Show this help.",
      "",
      "Requires JWT_SECRET in the environment (.env). The secret is never printed.",
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  // Parse args first so --help works without a secret configured.
  const { sub, exp, name } = parseArgs(process.argv.slice(2));

  const secret = process.env.JWT_SECRET;
  if (secret === undefined || secret.length === 0) {
    fail(
      "JWT_SECRET is not set. Add it to the backend .env (min. 32 chars), " +
        'e.g. JWT_SECRET=$(openssl rand -hex 32). It must match the running backend.',
    );
  }

  const key = new TextEncoder().encode(secret);
  let builder = new SignJWT(name !== undefined ? { name } : {})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt();

  if (exp !== undefined && exp.toLowerCase() !== "never") {
    // jose accepts a numeric string as seconds or a time span like "30d".
    const numeric = Number(exp);
    builder = builder.setExpirationTime(
      Number.isFinite(numeric) ? Math.floor(Date.now() / 1000) + numeric : exp,
    );
  }

  const token = await builder.sign(key);

  // Human-readable summary to stderr (safe to see in logs); token to stdout so
  // it can be captured cleanly: TOKEN=$(bun run --silent token:mint -- -s n8n)
  process.stderr.write(
    `✓ Minted HS256 token  sub=${sub}` +
      (name !== undefined ? ` name=${name}` : "") +
      `  exp=${exp !== undefined && exp.toLowerCase() !== "never" ? exp : "never"}\n`,
  );
  process.stdout.write(token + "\n");
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
