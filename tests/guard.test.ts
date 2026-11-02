import { describe, expect, it } from "vitest";
import { rateLimit, readJson, withLock } from "@/lib/server/guard";

const req = (ip: string, body?: string) => new Request("http://x/api", { method: "POST", headers: { "x-forwarded-for": ip }, body });

describe("server guards", () => {
  it("keeps working when Redis can't be reached", async () => {
    process.env.KV_REST_API_URL = "http://127.0.0.1:1";
    process.env.KV_REST_API_TOKEN = "x";
    try {
      expect(await rateLimit(req("10.9.9.9"), "down", 1, 60)).toBe(true);
      expect(await rateLimit(req("10.9.9.9"), "down", 1, 60)).toBe(false);
      expect(await withLock("down-lock", 10, 0, async () => 7)).toEqual({ value: 7 });
    } finally {
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    }
  });

  it("rate-limits each client separately", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit(req("10.0.0.1"), "t1", 3, 60));
    expect(results).toEqual([true, true, true, false]);
    expect(await rateLimit(req("10.0.0.2"), "t1", 3, 60)).toBe(true);
  });

  it("lets only one holder run at a time", async () => {
    let inside = 0;
    let most = 0;
    const job = () =>
      withLock("job", 10, 2_000, async () => {
        inside++;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, 50));
        inside--;
        return 1;
      });
    const out = await Promise.all([job(), job(), job()]);
    expect(out.every((x) => x?.value === 1)).toBe(true);
    expect(most).toBe(1);
    // With no wait, a held lock is reported as taken.
    const slow = withLock("job2", 10, 0, () => new Promise((r) => setTimeout(r, 100)));
    expect(await withLock("job2", 10, 0, async () => 1)).toBeNull();
    await slow;
  });

  it("refuses oversized bodies even without a Content-Length", async () => {
    expect(await readJson(req("1", JSON.stringify({ a: 1 })), 100)).toEqual({ ok: true, body: { a: 1 } });
    expect(await readJson(req("1", "x".repeat(200)), 100)).toEqual({ ok: false, status: 413 });
    expect(await readJson(req("1", "{nope"), 100)).toEqual({ ok: false, status: 400 });
  });
});
