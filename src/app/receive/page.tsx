import type { Metadata } from "next";
import { ReceiveFlow } from "./ReceiveFlow";

export const metadata: Metadata = {
  title: "Receive and claim | QuietPay",
  description: "Find payments to your links using keys that never leave your browser, then move the funds anywhere. Connect the same wallet on any device to get everything back.",
};

export default function ReceivePage() {
  return <ReceiveFlow />;
}
