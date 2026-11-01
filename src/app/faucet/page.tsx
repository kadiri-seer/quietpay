import type { Metadata } from "next";
import { FaucetFlow } from "./FaucetFlow";

export const metadata: Metadata = {
  title: "Test money | QuietPay",
  description: "Get testnet ETH for gas and test tUSDG to try QuietPay on Robinhood Chain Testnet. Test money has no value.",
};

export default function FaucetPage() {
  return <FaucetFlow />;
}
