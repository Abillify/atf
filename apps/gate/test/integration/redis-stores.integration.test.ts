// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * The Gate's Redis-backed stores against a real Redis server, through the
 * production factories and the real `redis` client (no fakes). Runs when
 * TEST_REDIS_URL points at a disposable Redis (CI starts one); skipped
 * otherwise. The database behind the URL is flushed, never point it at a
 * shared instance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "redis";
import { createApprovalConsumptionStore } from "../../src/mcp/approval-store.ts";
import { createPendingApprovalStore } from "../../src/mcp/pending-approval-store.ts";
import { TaskCapacityError } from "../../src/mcp/tasks.ts";
import { createMonitorClusterBridge } from "../../src/monitor/cluster-bridge.ts";
import { MonitorBus, type MonitorEvent } from "../../src/monitor/events.ts";
import { createIdentityRateLimiter } from "../../src/server/identity-rate-limit.ts";
import { createRateLimitStore } from "../../src/server/rate-limit-store.ts";
import { createWebhookReplayStore } from "../../src/tools/webhook-replay-store.ts";
import { createInvocationLedger } from "../../src/transaction/fabric.ts";

const REDIS_URL = process.env.TEST_REDIS_URL;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!REDIS_URL)("Gate Redis stores against a real Redis", () => {
	const url = REDIS_URL as string;
	const admin = createClient({ url });

	beforeAll(async () => {
		await admin.connect();
		await admin.flushDb();
	});
	afterAll(async () => {
		await admin.flushDb();
		await admin.quit();
	});

	test("the client speaks RESP3 (the redis 6 default)", async () => {
		const hello = (await admin.sendCommand(["HELLO"])) as Record<string, unknown> | unknown[];
		const proto = Array.isArray(hello) ? hello[hello.indexOf("proto") + 1] : hello.proto;
		expect(Number(proto)).toBe(3);
	});

	test("approval consumption: a jti is redeemable once and expires with the token", async () => {
		const store = await createApprovalConsumptionStore(url, "test", "t:approval:");
		try {
			expect(store.backing).toBe("redis");
			await store.healthcheck?.();
			const exp = Date.now() + 60_000;
			expect(await store.consume("jti-1", exp)).toBe(true);
			expect(await store.consume("jti-1", exp)).toBe(false);
			expect(await store.consume("jti-2", exp)).toBe(true);
			const pttl = await admin.pTTL("t:approval:jti-1");
			expect(pttl).toBeGreaterThan(55_000);
			expect(pttl).toBeLessThanOrEqual(60_000);
		} finally {
			await store.close?.();
		}
	});

	test("webhook replay: a nonce is reserved once and free again after its TTL", async () => {
		const store = await createWebhookReplayStore(url, "production", "t:webhook:");
		try {
			expect(store.backing).toBe("redis");
			await store.healthcheck?.();
			expect(await store.reserve("n-1", 200)).toBe(true);
			expect(await store.reserve("n-1", 200)).toBe(false);
			await sleep(350);
			expect(await store.reserve("n-1", 200)).toBe(true);
		} finally {
			await store.close?.();
		}
	});

	test("invocation ledger: reserve, in-flight, commit, replay and conflict", async () => {
		const ledger = await createInvocationLedger(url, "t:tx:", { ttlSec: 60 });
		try {
			expect(ledger.backing).toBe("redis");
			await ledger.healthcheck?.();
			const first = await ledger.reserve("inv-1", "fp-a");
			expect(first.kind).toBe("acquired");
			expect(first.record).toMatchObject({ invocationId: "inv-1", fingerprint: "fp-a", state: "pending" });
			expect((await ledger.reserve("inv-1", "fp-a")).kind).toBe("in_flight");
			expect((await ledger.reserve("inv-1", "fp-b")).kind).toBe("conflict");

			const result = { content: [{ type: "text" as const, text: "done" }] };
			await ledger.transition("inv-1", "committed", result);
			const replay = await ledger.reserve("inv-1", "fp-a");
			expect(replay.kind).toBe("replay");
			expect(replay.record.result).toEqual(result);
			expect((await ledger.get("inv-1"))?.state).toBe("committed");
			// A terminal record expires with the retention TTL; an open one is persistent.
			expect(await admin.pTTL("t:tx:inv-1")).toBeGreaterThan(0);
			await ledger.reserve("inv-2", "fp-a");
			expect(await admin.pTTL("t:tx:inv-2")).toBe(-1);

			await expect(ledger.transition("missing", "committed")).rejects.toThrow("Unknown invocation");
			expect(await ledger.get("missing")).toBeUndefined();
		} finally {
			await ledger.close?.();
		}
	});

	test("pending approvals: create, list, claim once, resolve, and the per-tenant limit", async () => {
		const store = await createPendingApprovalStore(url, 60_000, 2);
		try {
			expect(store.backing).toBe("redis");
			const a = await store.create("alice", "tenant-a", "tool.x", { n: 1 });
			const b = await store.create("alice", "tenant-a", "tool.x", { n: 2 });
			await expect(store.create("alice", "tenant-a", "tool.x", { n: 3 })).rejects.toBeInstanceOf(
				TaskCapacityError,
			);
			// Another tenant has its own budget.
			await store.create("bob", "tenant-b", "tool.y", {});

			// Oldest first; entries created in the same millisecond order by request state.
			const [older, newer] = [a, b].sort((x, y) =>
				x.createdAt === y.createdAt ? x.requestState.localeCompare(y.requestState) : x.createdAt - y.createdAt,
			);
			const page = await store.list("tenant-a", () => true, undefined, 1);
			expect(page.approvals.map((p) => p.requestState)).toEqual([older?.requestState]);
			expect(page.nextCursor).toBeDefined();
			const next = await store.list("tenant-a", () => true, page.nextCursor, 1);
			expect(next.approvals.map((p) => p.requestState)).toEqual([newer?.requestState]);

			expect(await store.take(a.requestState, "mallory")).toBeUndefined();
			expect((await store.take(a.requestState, "alice"))?.args).toEqual({ n: 1 });
			expect(await store.claim(a.requestState, a.expiresAt)).toBe(true);
			expect(await store.claim(a.requestState, a.expiresAt)).toBe(false);
			await store.markResolved(a.requestState, "approved", "tok-1");
			const resolved = await store.lookup(a.requestState);
			expect(resolved).toMatchObject({ status: "approved", token: "tok-1" });
			// The resolution keeps the entry's remaining lifetime.
			expect(await admin.pTTL(`mcpgate:approval:pending:${a.requestState}`)).toBeGreaterThan(0);
			expect(await store.takeForeign(a.requestState)).toBeUndefined();
			expect((await store.list("tenant-a", () => true)).approvals.map((p) => p.requestState)).toEqual([
				b.requestState,
			]);
		} finally {
			await store.close?.();
		}
	});

	test("pending approvals without a limit write entry and index directly", async () => {
		const store = await createPendingApprovalStore(url, 60_000, undefined as unknown as number);
		try {
			const entry = await store.create("carol", "tenant-c", "tool.z", { k: "v" });
			expect((await store.peek(entry.requestState))?.owner).toBe("carol");
			expect(await admin.pTTL("mcpgate:approval:tenant:tenant-c")).toBeGreaterThan(0);
		} finally {
			await store.close?.();
		}
	});

	test("monitor cluster bridge: an event reaches the other replica once and is not echoed", async () => {
		const busA = new MonitorBus();
		const busB = new MonitorBus();
		const bridgeA = await createMonitorClusterBridge(busA, url, "t:monitor");
		const bridgeB = await createMonitorClusterBridge(busB, url, "t:monitor");
		const seenA: MonitorEvent[] = [];
		const seenB: MonitorEvent[] = [];
		busA.subscribe((e) => seenA.push(e));
		busB.subscribe((e) => seenB.push(e));
		try {
			busA.publish({ type: "connection", sessionId: "s-1" });
			for (let i = 0; i < 50 && seenB.length === 0; i++) await sleep(20);
			await sleep(100);
			expect(seenB).toHaveLength(1);
			expect(seenB[0]?.sessionId).toBe("s-1");
			expect(seenB[0]?.remote).toBe(true);
			// A sees only its own local event, no bounce from B.
			expect(seenA).toHaveLength(1);
			expect(seenA[0]?.remote).toBeFalsy();
		} finally {
			await bridgeA.close();
			await bridgeB.close();
		}
	});

	test("per-identity rate limit: the burst is shared and the next call is refused", async () => {
		const cfg = {
			enabled: true,
			windowMs: 60_000,
			max: 2,
			failMode: "closed" as const,
			store: { type: "redis" as const, redisUrl: url, prefix: "t:rl:identity:" },
		};
		const first = await createIdentityRateLimiter(cfg);
		const second = await createIdentityRateLimiter(cfg);
		try {
			expect((await first?.check("user-1"))?.allowed).toBe(true);
			expect((await second?.check("user-1"))?.allowed).toBe(true);
			const denied = await first?.check("user-1");
			expect(denied?.allowed).toBe(false);
			expect(denied?.retryAfterMs).toBeGreaterThan(0);
			expect((await second?.check("user-2"))?.allowed).toBe(true);
		} finally {
			await first?.close?.();
			await second?.close?.();
		}
	});

	test("IP rate limit store (rate-limit-redis): hits are counted across store instances", async () => {
		const cfg = {
			enabled: true,
			windowMs: 60_000,
			max: 5,
			store: { type: "redis" as const, redisUrl: url, prefix: "t:rl:" },
		} as unknown as Parameters<typeof createRateLimitStore>[0];
		const one = await createRateLimitStore(cfg);
		const two = await createRateLimitStore(cfg);
		expect(one).toBeDefined();
		expect(two).toBeDefined();
		if (!one || !two) return;
		const options = { windowMs: 60_000 } as Parameters<NonNullable<typeof one.init>>[0];
		one.init?.(options);
		two.init?.(options);
		expect((await one.increment("10.0.0.1")).totalHits).toBe(1);
		expect((await two.increment("10.0.0.1")).totalHits).toBe(2);
		const third = await one.increment("10.0.0.1");
		expect(third.totalHits).toBe(3);
		expect(third.resetTime?.getTime()).toBeGreaterThan(Date.now());
		await one.decrement("10.0.0.1");
		expect((await two.increment("10.0.0.1")).totalHits).toBe(3);
		await one.resetKey("10.0.0.1");
		expect((await two.increment("10.0.0.1")).totalHits).toBe(1);
	});
});
