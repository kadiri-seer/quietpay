export const PRIVACY_STATEMENT =
  "QuietPay gives each payment a fresh receiving address. Robinhood Chain is public: the payer, amount, destination address, and transaction time can be visible. This is not full anonymity.";

export function PrivacyStatement({ compact = false }: { compact?: boolean }) {
  return (
    <aside
      aria-label="Privacy statement"
      className={`border-l-2 border-signal/70 ${compact ? "py-1 pl-4 text-sm" : "py-2 pl-5 text-base"} leading-relaxed text-mist`}
    >
      {PRIVACY_STATEMENT}
    </aside>
  );
}
