// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { MqttToolExecutor } from "../../src/tools/mqtt-tool.ts";
import { MqttToolSchema, type MqttBroker } from "../../src/config/schema.ts";
import type { CachedMessage, MqttProvider } from "../../src/mqtt/manager.ts";
import type { AuthContext } from "../../src/auth/context.ts";

const ctx: AuthContext = {
  method: "static",
  subject: "s",
  username: "alice",
  scopes: [],
  claims: {},
  headers: {},
  rawToken: "t",
};

const BROKER: MqttBroker = {
  url: "mqtt://localhost:1883",
  clean: true,
  keepalive: 60,
  reconnectPeriod: 5000,
  connectTimeout: 30000,
};

/** A fake MQTT provider with a manually controllable message store. */
class FakeMqtt implements MqttProvider {
  readonly subscriptions: string[] = [];
  private readonly store = new Map<string, CachedMessage>();

  resolveBroker(b?: MqttBroker): MqttBroker {
    return b ?? BROKER;
  }
  subscribe(_b: MqttBroker, topic: string): void {
    this.subscriptions.push(topic);
  }
  latest(_b: MqttBroker, topic: string): CachedMessage | undefined {
    return this.store.get(topic);
  }
  async destroyAll(): Promise<void> {}

  /** Test helper: seed a retained message. */
  set(topic: string, payload: string, ageMs = 0): void {
    this.store.set(topic, {
      raw: Buffer.from(payload, "utf8"),
      topic,
      receivedAt: Date.now() - ageMs,
    });
  }
}

function tool(extra: Record<string, unknown>) {
  return MqttToolSchema.parse({ name: "m", type: "mqtt", ...extra });
}

describe("MqttToolExecutor · single-topic", () => {
  it("subscribes on construction and returns the latest value (auto JSON)", async () => {
    const mqtt = new FakeMqtt();
    const exec = new MqttToolExecutor(tool({ topic: "sensors/temp" }), mqtt);
    expect(mqtt.subscriptions).toContain("sensors/temp");
    mqtt.set("sensors/temp", JSON.stringify({ c: 21.5 }));
    const res = await exec.execute({}, ctx);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ c: 21.5 });
  });

  it("applies the number transform", async () => {
    const mqtt = new FakeMqtt();
    const exec = new MqttToolExecutor(tool({ topic: "t", transform: "number" }), mqtt);
    mqtt.set("t", "42.5");
    const res = await exec.execute({}, ctx);
    expect(res.content[0]!.text).toBe("42.5");
  });

  it("applies the boolean transform", async () => {
    const mqtt = new FakeMqtt();
    const exec = new MqttToolExecutor(tool({ topic: "t", transform: "boolean" }), mqtt);
    mqtt.set("t", "on");
    expect((await exec.execute({}, ctx)).content[0]!.text).toBe("true");
    mqtt.set("t", "off");
    expect((await exec.execute({}, ctx)).content[0]!.text).toBe("false");
  });

  it("errors when no message has arrived and no default is set", async () => {
    const mqtt = new FakeMqtt();
    const exec = new MqttToolExecutor(tool({ topic: "t" }), mqtt);
    const res = await exec.execute({}, ctx);
    expect(res.isError).toBe(true);
  });

  it("returns the default value when no message has arrived", async () => {
    const mqtt = new FakeMqtt();
    const exec = new MqttToolExecutor(tool({ topic: "t", defaultValue: "n/a" }), mqtt);
    const res = await exec.execute({}, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe("n/a");
  });

  it("treats a value older than ttlSeconds as stale", async () => {
    const mqtt = new FakeMqtt();
    const exec = new MqttToolExecutor(tool({ topic: "t", ttlSeconds: 1 }), mqtt);
    mqtt.set("t", "5", 5000); // 5s old, ttl 1s
    const res = await exec.execute({}, ctx);
    expect(res.isError).toBe(true);
  });
});

describe("MqttToolExecutor · multi-topic", () => {
  it("returns an object keyed by each mapping path", async () => {
    const mqtt = new FakeMqtt();
    const exec = new MqttToolExecutor(
      tool({
        topics: [
          { path: "temperature", topic: "home/temp", transform: "number" },
          { path: "humidity", topic: "home/hum", transform: "number" },
          { path: "raw", topic: "home/raw", transform: "string" },
        ],
      }),
      mqtt,
    );
    expect(mqtt.subscriptions).toEqual(["home/temp", "home/hum", "home/raw"]);
    mqtt.set("home/temp", "21");
    mqtt.set("home/hum", "55");
    mqtt.set("home/raw", "hello");
    const res = await exec.execute({}, ctx);
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      temperature: 21,
      humidity: 55,
      raw: "hello",
    });
  });

  it("uses per-mapping and tool-level defaults for missing topics", async () => {
    const mqtt = new FakeMqtt();
    const exec = new MqttToolExecutor(
      tool({
        defaultValue: "TOOL_DEFAULT",
        topics: [
          { path: "a", topic: "x/a", transform: "auto", defaultValue: "MAP_DEFAULT" },
          { path: "b", topic: "x/b", transform: "auto" },
        ],
      }),
      mqtt,
    );
    const res = await exec.execute({}, ctx);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ a: "MAP_DEFAULT", b: "TOOL_DEFAULT" });
  });
});
