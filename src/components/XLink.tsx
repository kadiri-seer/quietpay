export const X_URL = "https://x.com/quietpay_";

/** Icon-only link to QuietPay on X. The mark is the official X icon from Simple Icons (CC0-1.0). */
export function XLink({ className = "" }: { className?: string }) {
  return (
    <a
      href={X_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="QuietPay on X (opens in a new tab)"
      title="@quietpay_ on X"
      className={`inline-flex h-11 w-11 items-center justify-center rounded-[10px] text-mist hover:bg-snow/[0.08] hover:text-snow ${className}`}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
        <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
      </svg>
    </a>
  );
}
