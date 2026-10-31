import type { Metadata } from "next";
import { PayFlow } from "./PayFlow";

export const metadata: Metadata = { title: "Pay a link | QuietPay" };

export default function PayPage() {
  return <PayFlow />;
}
