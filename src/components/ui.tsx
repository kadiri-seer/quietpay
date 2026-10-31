"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { explorerAddressUrl, explorerTxUrl, type NetworkConfig } from "@/config/networks";
import type { CheckStatus, PreflightCheck } from "@/lib/payer";

export function shorten(addr: string, chars = 4) {
  return addr.length <= 2 + chars * 2 + 1 ? addr : `${addr.slice(0, 2 + chars)}…${addr.slice(-chars)}`;
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[0.85em] tracking-tight ${className}`}>{children}</span>;
}

export function CopyButton({ value, label = "Copy", className = "" }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`btn btn-sm btn-quiet ${className}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard blocked: the value stays visible to copy manually */
        }
      }}
      aria-live="polite"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function ExplorerLink({ network, tx, address, children }: { network: NetworkConfig; tx?: string; address?: string; children?: ReactNode }) {
  const href = tx ? explorerTxUrl(network, tx) : explorerAddressUrl(network, address!);
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-signal underline decoration-signal/40 underline-offset-4 hover:decoration-signal">
      {children ?? <Mono>{shorten(tx ?? address!, 6)}</Mono>}
    </a>
  );
}

const PILL: Record<string, string> = {
  created: "border-mist/30 text-mist",
  pending: "border-warn/60 text-warn",
  paid: "border-ok/60 text-ok",
  announcement_pending: "border-warn/60 text-warn",
  claimable: "border-signal/70 text-signal",
  claimed: "border-ok/60 text-ok",
  expired: "border-haze/40 text-haze",
  error: "border-bad/60 text-bad",
};

export function StatusPill({ state, label }: { state: string; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${PILL[state] ?? PILL.created}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "ok"; title?: string; children: ReactNode }) {
  const tones = {
    info: "border-signal/40 bg-signal/5",
    warn: "border-warn/50 bg-warn/5",
    bad: "border-bad/50 bg-bad/5",
    ok: "border-ok/50 bg-ok/5",
  };
  return (
    <div className={`rounded-[3px] border-l-2 px-4 py-3 text-sm leading-relaxed ${tones[tone]}`} role={tone === "bad" ? "alert" : undefined}>
      {title && <p className="mb-0.5 font-semibold text-snow">{title}</p>}
      <div className="text-mist">{children}</div>
    </div>
  );
}

const CHECK_ICON: Record<CheckStatus | "running", string> = { ok: "✓", warn: "!", fail: "✕", running: "…" };
const CHECK_TONE: Record<CheckStatus | "running", string> = { ok: "text-ok", warn: "text-warn", fail: "text-bad", running: "text-haze" };

export function CheckList({ checks }: { checks: PreflightCheck[] }) {
  return (
    <ul className="space-y-2 text-sm">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-3">
          <span className={`w-4 shrink-0 text-center font-bold ${CHECK_TONE[c.status]}`} aria-label={c.status}>
            {CHECK_ICON[c.status]}
          </span>
          <span>
            <span className="text-snow">{c.label}</span>
            {c.detail && <span className="block text-haze">{c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px] ${className}`}
      aria-hidden
    />
  );
}

/** QR code rendered as React SVG rects (no innerHTML). */
export function QR({ value, size = 220 }: { value: string; size?: number }) {
  const modules = useMemo(() => {
    const q = QRCode.create(value, { errorCorrectionLevel: "M" });
    return { n: q.modules.size, data: q.modules.data };
  }, [value]);
  const quiet = 3;
  const dim = modules.n + quiet * 2;
  const rects: ReactNode[] = [];
  for (let y = 0; y < modules.n; y++) {
    for (let x = 0; x < modules.n; x++) {
      if (modules.data[y * modules.n + x]) rects.push(<rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1.02} height={1.02} />);
    }
  }
  return (
    <svg viewBox={`0 0 ${dim} ${dim}`} width={size} height={size} role="img" aria-label="QR code for the payment link" className="rounded-[3px] bg-snow">
      <g fill="#061a23">{rects}</g>
    </svg>
  );
}

export function Countdown({ to }: { to: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  return <>{formatRemaining(to - now)}</>;
}

export function formatRemaining(seconds: number) {
  if (seconds <= 0) return "expired";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.max(1, Math.floor((seconds % 3600) / 60));
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export function formatDateTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function PageTitle({ light, bold, children }: { light: string; bold: string; children?: ReactNode }) {
  return (
    <header className="mb-8">
      <h1 className="font-display text-3xl uppercase leading-[1.05] tracking-[0.02em] text-snow sm:text-4xl">
        <span className="font-extralight">{light} </span>
        <span className="font-bold">{bold}</span>
      </h1>
      {children && <p className="mt-3 max-w-[60ch] text-[0.95rem] leading-relaxed text-haze">{children}</p>}
    </header>
  );
}

/** ETH amount rounded UP to 6 decimals, so suggested top-ups never fall short. */
export function formatEthCeil(wei: bigint): string {
  const unit = 10n ** 12n;
  const rounded = ((wei + unit - 1n) / unit) * unit;
  const whole = rounded / 10n ** 18n;
  const frac = (rounded % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
