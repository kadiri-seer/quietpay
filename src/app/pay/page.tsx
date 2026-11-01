import type { Metadata } from "next";
import { PayFlow } from "./PayFlow";

export const metadata: Metadata = {
  title: "Pay a link | QuietPay",
  description: "Check a QuietPay link before connecting a wallet, then send USDG to a one-time address created for this payment only.",
};

export default function PayPage() {
  return <PayFlow />;
}
