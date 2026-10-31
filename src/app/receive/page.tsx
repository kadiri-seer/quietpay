import type { Metadata } from "next";
import { ReceiveFlow } from "./ReceiveFlow";

export const metadata: Metadata = { title: "Receive and claim | QuietPay" };

export default function ReceivePage() {
  return <ReceiveFlow />;
}
