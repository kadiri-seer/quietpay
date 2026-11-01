import Link from "next/link";
import type { ReactNode } from "react";
import { PageTitle } from "./ui";

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

/** Shared layout for legal pages: title, date, contents list and numbered sections. */
export function LegalPage({
  light,
  bold,
  intro,
  updated,
  sections,
}: {
  light: string;
  bold: string;
  intro: ReactNode;
  updated: string;
  sections: LegalSection[];
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
      <PageTitle light={light} bold={bold}>
        {intro}
      </PageTitle>
      <p className="-mt-4 mb-8 text-sm text-haze">Last updated {updated}</p>

      <nav aria-label="Contents" className="mb-10 rounded-[3px] border border-harbor p-4 sm:p-5">
        <p className="mb-2 text-sm font-medium text-snow">Contents</p>
        <ol className="grid gap-x-6 text-sm sm:grid-cols-2">
          {sections.map((s, i) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="inline-flex min-h-10 items-center text-mist underline decoration-mist/30 underline-offset-4 hover:text-snow">
                <span className="mr-2 tabular-nums text-haze">{i + 1}.</span>
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="space-y-10">
        {sections.map((s, i) => (
          <section key={s.id} id={s.id} className="scroll-mt-24">
            <h2 className="mb-3 font-display text-base font-semibold uppercase tracking-[0.06em] text-snow">
              <span className="mr-2 font-extralight text-signal">{i + 1}</span>
              {s.title}
            </h2>
            <div className="max-w-[68ch] space-y-3 text-[0.95rem] leading-relaxed text-mist [&_a]:text-signal [&_a]:underline [&_a]:underline-offset-4 [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5">
              {s.body}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-12 border-t border-harbor pt-6 text-sm text-haze">
        See also the <Link href="/terms">Terms of Service</Link>, the <Link href="/privacy">Privacy Policy</Link> and the{" "}
        <Link href="/security">Security model</Link>.
      </p>
    </div>
  );
}
