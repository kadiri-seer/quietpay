import type { Metadata } from "next";
import { ScanFlow } from "./ScanFlow";

export const metadata: Metadata = {
  title: "Scan | QuietPay",
  description: "Scan a QuietPay QR code to pay a username, a personal link or a payment request.",
};

export default function ScanPage() {
  return <ScanFlow />;
}
