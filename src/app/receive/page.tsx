import type { Metadata } from "next";
import { ReceiveFlow } from "./ReceiveFlow";

export const metadata: Metadata = {
  title: "Receive and claim | QuietPay",
  description: "Find payments to your links using keys that never leave your browser, then move the funds to any wallet. Back up and restore your keys.",
};

export default function ReceivePage() {
  return <ReceiveFlow />;
}
