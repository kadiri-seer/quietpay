import type { Metadata } from "next";
import { NamesFlow } from "./NamesFlow";

export const metadata: Metadata = {
  title: "Claim your name | QuietPay",
  description: "Reserve your QuietPay username before pay-by-username launches. Free, nothing onchain, and your wallet address is never stored.",
};

export default function NamesPage() {
  return <NamesFlow />;
}
