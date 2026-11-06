import type { Metadata } from "next";
import { SendFlow } from "./SendFlow";

export const metadata: Metadata = {
  title: "Send | QuietPay",
  description: "Send from QuietPay to a personal link or a wallet address, or pay a payment link. Every send goes through the shielded pool.",
};

export default function SendPage() {
  return <SendFlow />;
}
