// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { randomUUID } from "node:crypto";
import type { ToolResult } from "../tools/types.ts";

export type TaskState = "working" | "completed" | "failed" | "cancelled";
export interface Task {
  id: string;
  owner: string;
  state: TaskState;
  createdAt: number;
  expiresAt?: number;
  result?: ToolResult;
  controller: AbortController;
}
export class TaskCapacityError extends Error {
  constructor() {
    super("Async task capacity is full with active tasks");
    this.name = "TaskCapacityError";
  }
}
/** Process-local, explicitly non-durable async task store. */
export class MemoryTaskStore {
  private readonly tasks = new Map<string, Task>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}
  start(owner: string, run: (signal: AbortSignal) => Promise<ToolResult>): Task {
    this.sweep();
    while (this.tasks.size >= this.maxEntries) {
      const terminal = [...this.tasks.values()].find((t) => t.state !== "working");
      if (!terminal) throw new TaskCapacityError();
      this.tasks.delete(terminal.id);
    }
    const controller = new AbortController();
    const task: Task = {
      id: randomUUID(),
      owner,
      state: "working",
      createdAt: this.now(),
      controller,
    };
    this.tasks.set(task.id, task);
    void run(controller.signal).then(
      (r) => {
        if (task.state === "working") this.finish(task, r, r.isError ? "failed" : "completed");
      },
      (e) => {
        if (task.state === "working")
          this.finish(
            task,
            {
              content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
              isError: true,
            },
            "failed",
          );
      },
    );
    return task;
  }
  get(id: string, owner: string): Task | undefined {
    this.sweep();
    const task = this.tasks.get(id);
    return task?.owner === owner ? task : undefined;
  }
  cancel(id: string, owner: string): Task | undefined {
    const task = this.get(id, owner);
    if (!task) return undefined;
    if (task.state === "working") {
      task.state = "cancelled";
      task.result = {
        content: [{ type: "text", text: "Task cancelled" }],
        isError: true,
        structuredContent: { code: "CANCELLED" },
      };
      task.expiresAt = this.now() + this.ttlMs;
      task.controller.abort(new Error("Task cancelled"));
    }
    return task;
  }
  clear(): void {
    for (const task of this.tasks.values())
      if (task.state === "working") task.controller.abort(new Error("Task store cleared"));
    this.tasks.clear();
  }
  private finish(task: Task, result: ToolResult, state: "completed" | "failed") {
    task.result = result;
    task.state = state;
    task.expiresAt = this.now() + this.ttlMs;
  }
  private sweep() {
    const now = this.now();
    for (const [id, t] of this.tasks)
      if (t.state !== "working" && t.expiresAt !== undefined && t.expiresAt <= now)
        this.tasks.delete(id);
  }
}
