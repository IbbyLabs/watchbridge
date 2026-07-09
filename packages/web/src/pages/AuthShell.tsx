import type { ReactNode } from 'react';
import { Logo } from '../components/Logo.tsx';
import { Footer } from '../components/Footer.tsx';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col px-4 py-10">
      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5">
            <Logo className="h-7 w-7" />
            <span className="text-[15px] font-bold tracking-tight text-ink">Watchbridge</span>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-7">
            <h1 className="text-lg font-semibold text-ink">{title}</h1>
            <p className="mt-1 text-sm text-muted">{subtitle}</p>
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-sm">
        <Footer />
      </div>
    </main>
  );
}
