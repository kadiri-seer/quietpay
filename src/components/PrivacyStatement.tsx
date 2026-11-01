export const PRIVACY_STATEMENT =
  "QuietPay gives each payment a fresh receiving address. Robinhood Chain is public: the payer, amount, destination address, and transaction time can be visible. This is not full anonymity.";

export function PrivacyStatement({ compact = false }: { compact?: boolean }) {
  return (
    <aside
      aria-label="Privacy statement"
      className={`rounded-[3px] border border-signal/35 bg-signal/[0.05] ${compact ? "px-4 py-3 text-sm" : "px-5 py-4 text-base"} leading-relaxed text-mist`}
    >
      <span className="mb-1 block font-display text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-signal">What is public</span>
      {PRIVACY_STATEMENT}
    </aside>
  );
}
