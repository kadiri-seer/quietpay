import type { Metadata } from "next";
import { PoolFlow } from "./PoolFlow";

export const metadata: Metadata = {
  title: "Shielded pool | QuietPay",
  description: "Withdraw shielded payments to any fresh address. Proofs are generated on your device; nothing onchain says which deposit a withdrawal came from.",
};

export default function PoolPage() {
  return <PoolFlow />;
}
