import type { Metadata } from "next";
import { ActivityFlow } from "./ActivityFlow";

export const metadata: Metadata = {
  title: "Activity | QuietPay",
  description: "Everything that moved in and out of your QuietPay balance, worked out on your device.",
};

export default function ActivityPage() {
  return <ActivityFlow />;
}
