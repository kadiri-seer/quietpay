import type { Metadata } from "next";
import Link from "next/link";
import { LogoMark } from "@/components/Logo";

export const metadata: Metadata = {
  title: "Page not found | QuietPay",
  description: "This page does not exist. Create a payment link, pay one, or receive your payments on QuietPay.",
};

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 pb-8 pt-16 text-center sm:px-6">
      <LogoMark className="h-10 w-auto text-harbor" />
      <p className="mt-8 text-sm font-medium text-haze">Error 404</p>
      <h1 className="mt-3 font-display font-bold leading-[1.04] tracking-[-0.03em] text-snow">
        <span className="block text-4xl text-haze sm:text-5xl">No address</span>{" "}
        <span className="block text-4xl sm:text-5xl">at this page.</span>
      </h1>
      <p className="mt-5 max-w-[46ch] leading-relaxed text-mist">
        The page you followed doesn&apos;t exist. If you were opening a payment link, ask the sender to share the full link again, including
        everything after the #.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/" className="btn btn-primary">
          Go to the home page
        </Link>
        <Link href="/pay" className="btn btn-quiet">
          Paste a payment link
        </Link>
      </div>
    </div>
  );
}
