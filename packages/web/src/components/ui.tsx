import { createContext, useContext, useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover',
  secondary: 'bg-elevated text-ink border border-border hover:border-faint',
  ghost: 'text-muted hover:text-ink hover:bg-elevated',
  danger: 'text-danger hover:bg-danger/10',
};

export function Button({
  variant = 'primary',
  loading,
  children,
  className = '',
  ...props
}: { variant?: Variant; loading?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`inline-flex min-h-[40px] cursor-pointer items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {loading && <Spinner className="text-current" />}
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-border bg-surface ${className}`}>{children}</div>;
}

/**
 * Lets `Input`/`Select` pick up the surrounding field's hint or error without
 * every caller having to thread ids through by hand. The `<label>` wrapper
 * already associates the label itself; this covers the description.
 */
const FieldContext = createContext<{ describedBy?: string; invalid: boolean }>({ invalid: false });

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const helpId = `${useId()}-help`;
  const described = error || hint ? helpId : undefined;
  return (
    <FieldContext.Provider value={{ describedBy: described, invalid: Boolean(error) }}>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
        {children}
        {error ? (
          <span id={helpId} role="alert" className="mt-1 block text-xs text-danger">
            {error}
          </span>
        ) : hint ? (
          <span id={helpId} className="mt-1 block text-xs text-faint">
            {hint}
          </span>
        ) : null}
      </label>
    </FieldContext.Provider>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const field = useContext(FieldContext);
  return (
    <input
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      {...props}
      className={`w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-ink placeholder:text-faint transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40 ${props.className ?? ''}`}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useContext(FieldContext);
  return (
    <select
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      {...props}
      className={`w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-ink transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40 ${props.className ?? ''}`}
    />
  );
}

type Tone = 'success' | 'danger' | 'neutral' | 'brand';
const PILL: Record<Tone, string> = {
  success: 'bg-success/15 text-success',
  danger: 'bg-danger/15 text-danger',
  neutral: 'bg-elevated text-muted',
  brand: 'bg-brand/15 text-brand-ink',
};

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${PILL[tone]}`}>
      {children}
    </span>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Whatever opened the dialog gets focus back when it closes, so the keyboard
    // does not jump to the top of the page.
    const opener = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the dialog; otherwise it walks into the page behind the
      // overlay, which is still there and still clickable-looking.
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    // Move focus into the dialog for keyboard and screen-reader users.
    const firstField = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (firstField ?? dialogRef.current)?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-border bg-surface p-6 focus:outline-none"
      >
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
