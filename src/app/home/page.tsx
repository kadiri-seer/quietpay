import { redirect } from "next/navigation";

// Home is the front page now.
export default function HomePage() {
  redirect("/?app=1");
}
