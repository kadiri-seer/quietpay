import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  canSendAnnouncement,
  canSendPayment,
  initialMachine,
  transition,
  type PaymentMachine,
} from "@/lib/payment-state";

const run = (...events: Parameters<typeof transition>[1][]): PaymentMachine => events.reduce(transition, initialMachine());

describe("payment state machine", () => {
  it("walks the happy path", () => {
    const m = run(
      { type: "SUBMIT_PAYMENT", txHash: "0x1" },
      { type: "PAYMENT_CONFIRMED", txHash: "0x1" },
      { type: "SUBMIT_ANNOUNCEMENT", txHash: "0x2" },
      { type: "ANNOUNCEMENT_CONFIRMED", txHash: "0x2" },
      { type: "CLAIMED", txHash: "0x3" },
    );
    expect(m.state).toBe("claimed");
    expect(m.paymentTx).toBe("0x1");
    expect(m.announcementTx).toBe("0x2");
  });

  it("returns to created when the user rejects before submission", () => {
    const m = run({ type: "USER_REJECTED" });
    expect(m.state).toBe("created");
    expect(canSendPayment(m)).toBe(true);
  });

  it("never allows a second payment once one was submitted", () => {
    const m = run({ type: "SUBMIT_PAYMENT", txHash: "0x1" });
    expect(canSendPayment(m)).toBe(false);
    expect(() => transition(m, { type: "SUBMIT_PAYMENT", txHash: "0x9" })).toThrow(InvalidTransitionError);
    const failed = transition(m, { type: "PAYMENT_FAILED", reason: "cancelled", txSubmitted: true });
    expect(failed.state).toBe("error");
    expect(canSendPayment(failed)).toBe(false);
    expect(() => transition(failed, { type: "SUBMIT_PAYMENT", txHash: "0x9" })).toThrow(InvalidTransitionError);
  });

  it("allows retrying payment after a pre-submission failure", () => {
    const m = run({ type: "PAYMENT_FAILED", reason: "insufficient funds", txSubmitted: false });
    expect(canSendPayment(m)).toBe(true);
    expect(transition(m, { type: "SUBMIT_PAYMENT", txHash: "0x1" }).state).toBe("pending");
  });

  it("retries only the announcement when it fails after payment", () => {
    let m = run({ type: "SUBMIT_PAYMENT", txHash: "0x1" }, { type: "PAYMENT_CONFIRMED", txHash: "0x1" });
    expect(canSendAnnouncement(m)).toBe(true);
    m = transition(m, { type: "ANNOUNCEMENT_FAILED", reason: "rpc down" });
    expect(m.state).toBe("announcement_pending");
    expect(canSendAnnouncement(m)).toBe(true);
    expect(canSendPayment(m)).toBe(false);
    m = transition(m, { type: "SUBMIT_ANNOUNCEMENT", txHash: "0x2" });
    expect(canSendAnnouncement(m)).toBe(false); // in flight
    m = transition(m, { type: "ANNOUNCEMENT_CONFIRMED", txHash: "0x2" });
    expect(m.state).toBe("claimable");
  });

  it("expires only unpaid requests", () => {
    expect(run({ type: "EXPIRE" }).state).toBe("expired");
    const paid = run({ type: "SUBMIT_PAYMENT", txHash: "0x1" }, { type: "PAYMENT_CONFIRMED", txHash: "0x1" });
    expect(transition(paid, { type: "EXPIRE" }).state).toBe("paid");
  });

  it("rejects out-of-order events", () => {
    expect(() => run({ type: "PAYMENT_CONFIRMED", txHash: "0x1" })).toThrow(InvalidTransitionError);
    expect(() => run({ type: "CLAIMED", txHash: "0x1" })).toThrow(InvalidTransitionError);
    expect(() => run({ type: "SUBMIT_ANNOUNCEMENT", txHash: "0x1" })).toThrow(InvalidTransitionError);
  });
});
