/**
 * Ortak arayüz yapı taşları.
 *
 * Tasarım dili psikolog/MMPI çalışma alanlarıyla aynı sınıf sözlüğünü kullanır
 * (`screen.css`, `theme.css`, `workspace.css`, `kamuilan.css`). Burada yeni
 * görsel karar verilmez; yalnızca var olan sınıflar tek yerden üretilir ki
 * sayfalar birbirinden farklı görünmesin.
 */
import type { ChangeEvent, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

/** Etiket: durum, tür ve güven göstergeleri. */
export function Tag({ children, tone = 'neutral', icon }: { children: ReactNode; tone?: Tone; icon?: IconName }) {
  return (
    <span className={`tag tag-${tone}`}>
      {icon && <Icon name={icon} size={12} />}
      <span>{children}</span>
    </span>
  );
}

/** Eski ad (`Badge`) ile geriye dönük uyum: aynı bileşen. */
export const Badge = Tag;

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
  id,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`card-elevated ${className}`.trim()} id={id}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3 className="card-title">{title}</h3>}
            {description && <p className="card-sub">{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Spinner({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <span className="spinner-inline" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function LoadingCard({ title = 'Yükleniyor…', description }: { title?: string; description?: string }) {
  return (
    <div className="loading-state-card" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <h4>{title}</h4>
      {description && <p>{description}</p>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = 'search',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="empty-state-card">
      <span className="empty-state-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <h4>{title}</h4>
      {description && <p>{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ message, onRetry, title }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <div className="notice notice-danger" role="alert">
      <Icon name="alert" size={16} />
      <div>
        {title && <strong>{title}</strong>}
        <p>{message}</p>
        {onRetry && (
          <button type="button" className="btn-secondary btn-sm" onClick={onRetry}>
            Yeniden dene
          </button>
        )}
      </div>
    </div>
  );
}

export function InfoNote({
  children,
  tone = 'info',
  title,
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'success' | 'danger';
  title?: string;
}) {
  return (
    <div className={`notice notice-${tone}`}>
      <Icon name={tone === 'info' ? 'info' : tone === 'success' ? 'check' : 'alert'} size={16} />
      <div>
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

type FieldProps = {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
};

/** Etiket + ipucu + hata metnini aynı düzende tutar. */
export function Field({ label, htmlFor, hint, error, required = false, children }: FieldProps) {
  return (
    <div className="form-group">
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="field-required"> *</span>}
      </label>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Metin girişi (etiket/ipucu/hata Field ile birlikte kullanılır). */
export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  type = 'text',
  invalid = false,
  autoComplete,
  inputMode,
  min,
  max,
  disabled = false,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'email' | 'password' | 'number' | 'date' | 'search' | 'tel';
  invalid?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'email';
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <input
      id={id}
      className={invalid ? 'is-invalid' : undefined}
      type={type}
      value={value}
      placeholder={placeholder}
      autoComplete={autoComplete}
      inputMode={inputMode}
      min={min}
      max={max}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  );
}

/** Onay kutusu — erişilebilirlik için etiket tıklanabilir alanı kaplar. */
export function Checkbox({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="checkbox-row" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
    </label>
  );
}

/** Terim–değer listesi (detay ve durum sayfalarında ortak kullanım). */
export function DefinitionList({ items }: { items: { term: string; value: ReactNode; hint?: string }[] }) {
  return (
    <dl className="definition-list">
      {items.map((item) => (
        <div className="definition-row" key={item.term}>
          <dt>{item.term}</dt>
          <dd>
            {item.value}
            {item.hint && <span className="field-hint">{item.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Sayfa numarası düğmeleri (yalnızca erişilebilir etiketlerle). */
export function Pagination({
  page,
  pages,
  onPage,
  label = 'Sayfalama',
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  label?: string;
}) {
  if (pages <= 1) return null;
  const windowSize = 2;
  const start = Math.max(1, page - windowSize);
  const end = Math.min(pages, page + windowSize);
  const numbers: number[] = [];
  for (let index = start; index <= end; index += 1) numbers.push(index);

  return (
    <nav className="pagination" aria-label={label}>
      <button type="button" className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <Icon name="left" size={14} />
        <span>Önceki</span>
      </button>
      {start > 1 && (
        <>
          <button type="button" className="page-btn" onClick={() => onPage(1)}>
            1
          </button>
          {start > 2 && <span className="pagination-gap">…</span>}
        </>
      )}
      {numbers.map((number) => (
        <button
          type="button"
          key={number}
          className={number === page ? 'page-btn is-current' : 'page-btn'}
          aria-current={number === page ? 'page' : undefined}
          onClick={() => onPage(number)}
        >
          {number}
        </button>
      ))}
      {end < pages && (
        <>
          {end < pages - 1 && <span className="pagination-gap">…</span>}
          <button type="button" className="page-btn" onClick={() => onPage(pages)}>
            {pages}
          </button>
        </>
      )}
      <button type="button" className="btn-secondary btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        <span>Sonraki</span>
        <Icon name="right" size={14} />
      </button>
      <span className="pagination-note">
        {page} / {pages}
      </span>
    </nav>
  );
}

/** Yüzde göstergesi: çıkarım güveni, kapsam oranı. */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="confidence-bar">
      <div className="confidence-track" role="img" aria-label={`${label}: yüzde ${percent}`}>
        <span className="confidence-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="confidence-value">
        {label} %{percent}
      </span>
    </div>
  );
}

/** Sekme başlıkları (yönetim paneli ve panel içi bölümler). */
export function Tabs({
  tabs,
  current,
  onSelect,
  label,
}: {
  tabs: { id: string; label: string; count?: number }[];
  current: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <div className="subnav-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          role="tab"
          aria-selected={tab.id === current}
          className={tab.id === current ? 'subnav-tab is-active' : 'subnav-tab'}
          onClick={() => onSelect(tab.id)}
        >
          <span>{tab.label}</span>
          {typeof tab.count === 'number' && <span className="subnav-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Ölçü kartı: yalnızca gerçek sunucu değerleri için kullanılır. */
export function StatCard({
  label,
  value,
  icon,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  icon?: IconName;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className={`stat-item stat-${tone}`}>
      {icon && (
        <span className="stat-icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
      )}
      <div>
        <span className="stat-label">{label}</span>
        <strong className="stat-val">{value}</strong>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
    </div>
  );
}

/** Yatay kaydırmalı tablo sarmalayıcı (mobilde kart görünümüne düşer). */
export function DataTable({ head, children, caption }: { head: string[]; children: ReactNode; caption: string }) {
  return (
    <div className="modern-table-card">
      <div className="table-responsive">
        <table className="modern-data-table">
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {head.map((cell) => (
                <th key={cell} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}
