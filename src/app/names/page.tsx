import type { Metadata } from "next";
import { NamesFlow } from "./NamesFlow";

export const metadata: Metadata = {
  title: "Claim your name | QuietPay",
  description: "Claim your QuietPay username: people pay @you straight into your shielded balance. Free, nothing onchain, and your wallet address is never stored.",
};

export default function NamesPage() {
  return <NamesFlow />;
}
