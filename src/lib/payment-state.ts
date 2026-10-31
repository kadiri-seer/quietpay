/**
 * Payment state machine.
 *
 * created -> pending -> paid -> announcement_pending -> claimable -> claimed
 * plus expired and error.
 *
 * Core invariant: once the payment transfer has been submitted, nothing can move the request
 * back to a state from which the payment could be sent again. A failed announcement keeps the
 * request in `announcement_pending` so only the announcement can be retried.
 */

export const PAYMENT_STATES = [
  "created",
  "pending",
  "paid",
  "announcement_pending",
  "claimable",
  "claimed",
  "expired",
  "error",
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

export type PaymentEvent =
  | { type: "SUBMIT_PAYMENT"; txHash: string }
  | { type: "USER_REJECTED" }
  | { type: "PAYMENT_CONFIRMED"; txHash: string }
  | { type: "PAYMENT_FAILED"; reason: string; txSubmitted: boolean }
  | { type: "SUBMIT_ANNOUNCEMENT"; txHash: string }
  | { type: "ANNOUNCEMENT_CONFIRMED"; txHash: string }
  | { type: "ANNOUNCEMENT_FAILED"; reason: string }
  | { type: "CLAIMED"; txHash: string }
  | { type: "EXPIRE" };

export interface PaymentMachine {
  state: PaymentState;
  paymentTx?: string;
  announcementTx?: string;
  claimTx?: string;
  error?: string;
  /** True once a payment transaction hash exists. Never reset. */
  paymentSubmitted: boolean;
}

export const initialMachine = (): PaymentMachine => ({ state: "created", paymentSubmitted: false });

export class InvalidTransitionError extends Error {
  constructor(from: PaymentState, event: PaymentEvent["type"]) {
    super(`Invalid transition: ${event} from ${from}`);
    this.name = "InvalidTransitionError";
  }
}

export function transition(m: PaymentMachine, e: PaymentEvent): PaymentMachine {
  const fail = () => {
    throw new InvalidTransitionError(m.state, e.type);
  };
  switch (e.type) {
    case "SUBMIT_PAYMENT":
      if (m.paymentSubmitted || (m.state !== "created" && m.state !== "error")) fail();
      return { ...m, state: "pending", paymentTx: e.txHash, paymentSubmitted: true, error: undefined };
    case "USER_REJECTED":
      if (m.paymentSubmitted || (m.state !== "created" && m.state !== "error")) fail();
      return { ...m, state: "created", error: "You rejected the request in your wallet." };
    case "PAYMENT_CONFIRMED":
      if (m.state !== "pending") fail();
      return { ...m, state: "paid", paymentTx: e.txHash, error: undefined };
    case "PAYMENT_FAILED":
      // Before submission: back to an error state that allows another attempt.
      // After submission (reverted/cancelled): terminal error for this attempt; the UI must
      // re-check the chain before ever offering a new payment.
      if (m.state !== "created" && m.state !== "pending" && m.state !== "error") fail();
      return { ...m, state: "error", error: e.reason, paymentSubmitted: m.paymentSubmitted || e.txSubmitted };
    case "SUBMIT_ANNOUNCEMENT":
      if (m.state !== "paid" && m.state !== "announcement_pending") fail();
      return { ...m, state: "announcement_pending", announcementTx: e.txHash, error: undefined };
    case "ANNOUNCEMENT_FAILED":
      if (m.state !== "paid" && m.state !== "announcement_pending") fail();
      return { ...m, state: "announcement_pending", error: e.reason };
    case "ANNOUNCEMENT_CONFIRMED":
      if (m.state !== "announcement_pending") fail();
      return { ...m, state: "claimable", announcementTx: e.txHash, error: undefined };
    case "CLAIMED":
      if (m.state !== "claimable") fail();
      return { ...m, state: "claimed", claimTx: e.txHash };
    case "EXPIRE":
      if (m.paymentSubmitted) return m; // a submitted payment never "expires" away
      if (m.state !== "created" && m.state !== "error") return m;
      return { ...m, state: "expired" };
  }
}

/** Whether a new payment transfer may be offered for this machine. */
export function canSendPayment(m: PaymentMachine): boolean {
  return !m.paymentSubmitted && (m.state === "created" || m.state === "error");
}

/** Whether the announcement (and only the announcement) may be (re)sent. */
export function canSendAnnouncement(m: PaymentMachine): boolean {
  return m.state === "paid" || (m.state === "announcement_pending" && !!m.error) ;
}

export const STATE_LABELS: Record<PaymentState, string> = {
  created: "Awaiting payment",
  pending: "Payment pending",
  paid: "Paid",
  announcement_pending: "Announcing",
  claimable: "Ready to claim",
  claimed: "Claimed",
  expired: "Expired",
  error: "Needs attention",
};
