import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Limit } from "../../src/limit.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Limit", () => {
  it("runs a single task and resolves its return value", async () => {
    const l = new Limit(2);
    const result = await l.run(() => Promise.resolve(42));
    assert.equal(result, 42);
  });

  it("rejects when the task throws", async () => {
    const l = new Limit(2);
    await assert.rejects(
      () => l.run(() => Promise.reject(new Error("boom"))),
      /boom/
    );
  });

  it("respects max concurrency", async () => {
    const l = new Limit(2);
    let active = 0;
    let maxSeen = 0;

    const task = async () => {
      active++;
      maxSeen = Math.max(maxSeen, active);
      await delay(30);
      active--;
    };

    await Promise.all([l.run(task), l.run(task), l.run(task), l.run(task)]);
    assert.ok(maxSeen <= 2, `maxSeen was ${maxSeen}, expected ≤ 2`);
  });

  it("queued tasks all complete", async () => {
    const l = new Limit(1);
    const results = [];
    await Promise.all(
      [1, 2, 3].map((n) => l.run(async () => { results.push(n); }))
    );
    assert.deepEqual(results.sort(), [1, 2, 3]);
  });

  it("clamps max to at least 1", async () => {
    const l = new Limit(0);
    const result = await l.run(() => Promise.resolve("ok"));
    assert.equal(result, "ok");
  });
});
