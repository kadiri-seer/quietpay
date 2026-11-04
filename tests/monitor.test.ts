import { describe, expect, it, vi } from "vitest";
import { recentAlerts, RULES, watch } from "@/lib/server/monitor";

describe("repeated-action monitor", () => {
  it("counts per subject and raises one alert when a threshold is passed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { alertAt } = RULES["lock.empty.recipient"];
    for (let i = 0; i < alertAt; i++) await watch("lock.empty.recipient", "0xabc");
    expect(warn).not.toHaveBeenCalled();
    await watch("lock.empty.recipient", "0xabc");
    await watch("lock.empty.recipient", "0xabc");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({ quietpay: "repeated-action", event: "lock.empty.recipient", subject: "0xabc" });
    // Another subject has its own count.
    expect(await watch("lock.empty.recipient", "0xdef")).toBe(1);
    const alerts = await recentAlerts();
    expect(alerts[0]).toMatchObject({ event: "lock.empty.recipient", subject: "0xabc", count: alertAt + 1 });
    warn.mockRestore();
  });
});
