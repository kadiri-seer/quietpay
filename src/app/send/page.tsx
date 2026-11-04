import type { Metadata } from "next";
import { SendFlow } from "./SendFlow";

export const metadata: Metadata = {
  title: "Send | QuietPay",
  description: "Send from your shielded balance to a QuietPay username, a wallet address, or pay a payment link.",
};

export default function SendPage() {
  return <SendFlow />;
}
