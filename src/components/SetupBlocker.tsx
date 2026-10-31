"use client";

import Link from "next/link";
import type { NetworkConfig } from "@/config/networks";
import type { NetworkReadiness } from "./hooks";
import { Notice } from "./ui";

/** Shown when the token or announcer can't be verified onchain. Never falls back to mocks silently. */
export function SetupBlocker({ network, readiness, error }: { network: NetworkConfig; readiness?: NetworkReadiness; error?: Error | null }) {
  return (
    <div className="space-y-3">
      <Notice tone="bad" title={`QuietPay isn't ready on ${network.label}`}>
        {error ? (
          <p>Could not reach the network RPC: {error.message.split("\n")[0]}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-4">
            {readiness?.tokenError && <li>Token: {readiness.tokenError}</li>}
            {readiness?.announcerError && <li>Announcer: {readiness.announcerError}</li>}
          </ul>
        )}
      </Notice>
      <p className="text-xs leading-relaxed text-haze">
        Payments stay off until these contracts verify onchain. This is usually a temporary network problem, so try again in a minute. See the <Link href="/security#contracts" className="underline underline-offset-4">contract details</Link>.
      </p>
    </div>
  );
}
