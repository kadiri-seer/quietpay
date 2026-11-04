export const PRIVACY_STATEMENT =
  "Payments go into a shielded pool under a one-time lock. Robinhood Chain is public: who paid in, the amount and the time can be visible, and so can sends to a wallet address. Who was paid isn't shown onchain. This is not full anonymity.";

export function PrivacyStatement({ compact = false }: { compact?: boolean }) {
  return (
    <aside
      aria-label="Privacy statement"
      className={`rounded-xl border border-signal/35 bg-signal/[0.05] ${compact ? "px-4 py-3 text-sm" : "px-5 py-4 text-base"} leading-relaxed text-mist`}
    >
      <span className="mb-1 block font-display text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-signal">What is public</span>
      {PRIVACY_STATEMENT}
    </aside>
  );
}
