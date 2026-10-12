/**
 * Ortak arayüz bileşenleri (erişilebilir, mobil öncelikli).
 *
 * Bu dosya iş mantığı içermez; yalnızca sunum ve erişilebilirlik sorumluluğu vardır.
 */
import type { ReactNode } from 'react';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }): ReactNode {
  const tones: Record<string, string> = {
    neutral: 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
    warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
    danger: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
    info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function Card({ title, children, description, actions }: { title?: string; description?: string; children: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">{title}</h2>}
            {description && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Spinner({ label = 'Yükleniyor…' }: { label?: string }): ReactNode {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-slate-600 dark:text-slate-300" role="status" aria-live="polite">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="card text-center">
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</p>
      {description && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{description}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn-secondary mt-2" onClick={onRetry}>
          Yeniden dene
        </button>
      )}
    </div>
  );
}

export function InfoNote({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' }): ReactNode {
  const styles =
    tone === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100'
      : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200';
  return <p className={`rounded-lg border p-3 text-sm ${styles}`}>{children}</p>;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  required,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-700 dark:text-red-300" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function DefinitionList({ items }: { items: { term: string; value: ReactNode }[] }): ReactNode {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.term} className="min-w-0">
          <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{item.term}</dt>
          <dd className="break-words text-sm text-slate-900 dark:text-slate-100">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pagination({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
}): ReactNode {
  if (pages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-between gap-2" aria-label="Sayfalar">
      <button type="button" className="btn-secondary" onClick={() => onChange(page - 1)} disabled={page <= 1}>
        ← Önceki
      </button>
      <p className="text-sm text-slate-600 dark:text-slate-300" aria-live="polite">
        {page} / {pages}
      </p>
      <button type="button" className="btn-secondary" onClick={() => onChange(page + 1)} disabled={page >= pages}>
        Sonraki →
      </button>
    </nav>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }): ReactNode {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
        <span>{label}</span>
        <span aria-hidden="true">{percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className="h-full rounded-full bg-brand-600"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        />
      </div>
    </div>
  );
}
