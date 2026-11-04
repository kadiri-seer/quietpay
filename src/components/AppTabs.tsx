"use client";

/**
 * Phone tab bar for people using QuietPay: Home, Receive, Send, Activity. Shown once the vault is
 * unlocked on this device; hidden on large screens, which have the header menu.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useVault } from "./VaultProvider";

const TABS = [
  { href: "/", label: "Home", d: "M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" },
  { href: "/receive", label: "Receive", d: "M12 4v14M6 12l6 6 6-6" },
  { href: "/send", label: "Send", d: "M12 20V6M6 12l6-6 6 6" },
  { href: "/activity", label: "Activity", d: "M5 6h14M5 12h14M5 18h9" },
];

export function AppTabs() {
  const path = usePathname();
  const { status } = useVault();
  if (status !== "unlocked") return null;
  return (
    <>
      <div className="h-20 lg:hidden" aria-hidden />
      <nav
        aria-label="App"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-harbor bg-abyss/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {TABS.map((t) => {
            const active = t.href === "/" ? path === "/" : path === t.href || !!path?.startsWith(`${t.href}/`);
            return (
              <li key={t.href}>
                <Link
                  href={t.href === "/" ? "/?app=1" : t.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs font-medium ${active ? "text-snow" : "text-haze hover:text-mist"}`}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d={t.d} />
                  </svg>
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
