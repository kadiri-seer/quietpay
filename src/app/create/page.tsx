import { redirect } from "next/navigation";

// Requests now live under Receive.
export default function CreatePage() {
  redirect("/receive?tab=request");
}
