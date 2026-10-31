import type { Metadata } from "next";
import { CreateFlow } from "./CreateFlow";

export const metadata: Metadata = { title: "Create a payment link | QuietPay" };

export default function CreatePage() {
  return <CreateFlow />;
}
