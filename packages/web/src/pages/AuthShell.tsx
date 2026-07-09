import type { ReactNode } from 'react';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-brand" aria-hidden />
          <span className="text-[15px] font-bold tracking-tight text-ink">Watchbridge</span>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-7">
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
