import { redirect } from "next/navigation";

// Usernames were removed for privacy; your personal link does the same job.
export default function NamesPage() {
  redirect("/receive?tab=link");
}
