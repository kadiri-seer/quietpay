import type { Metadata } from "next";
import { CreateFlow } from "./CreateFlow";

export const metadata: Metadata = {
  title: "Create a payment link | QuietPay",
  description: "Set an amount and expiry and get a one-time USDG payment link with its own receiving keys. Your wallet address is never put in the link.",
};

export default function CreatePage() {
  return <CreateFlow />;
}
