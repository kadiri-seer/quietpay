import type { Metadata } from "next";
import { HomeFlow } from "./HomeFlow";

export const metadata: Metadata = {
  title: "Home | QuietPay",
  description: "Your QuietPay balance in one place: money in the shielded pool and payments still at one-time addresses, worked out on your device.",
};

export default function HomePage() {
  return <HomeFlow />;
}
