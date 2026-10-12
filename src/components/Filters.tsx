/**
 * İlan filtreleri: URL'de saklanır (paylaşılabilir bağlantı şartı).
 *
 * Filtre durumu bileşenin içinde tutulmaz; sayfa URL sorgu parametrelerini
 * yönetir. Böylece aynı bağlantı başka birinde aynı sonucu verir.
 */
import type { ReactNode } from 'react';
import { PROVINCES } from '../domain/provinces';
import { EMPLOYMENT_TYPE_LABELS } from '../lib/format';
import { Field } from './ui';

export interface JobFilters {
  q: string;
  city: string;
  institution: string;
  employmentType: string;
  status: string;
  deadlineFrom: string;
  deadlineTo: string;
  minQuota: string;
  hasApplicationUrl: boolean;
  sort: string;
}

export const EMPTY_FILTERS: JobFilters = {
  q: '',
  city: '',
  institution: '',
  employmentType: '',
  status: '',
  deadlineFrom: '',
  deadlineTo: '',
  minQuota: '',
  hasApplicationUrl: false,
  sort: 'newest',
};

export function filtersFromParams(params: URLSearchParams): JobFilters {
  return {
    q: params.get('q') ?? '',
    city: params.get('city') ?? '',
    institution: params.get('institution') ?? '',
    employmentType: params.get('employmentType') ?? '',
    status: params.get('status') ?? '',
    deadlineFrom: params.get('deadlineFrom') ?? '',
    deadlineTo: params.get('deadlineTo') ?? '',
    minQuota: params.get('minQuota') ?? '',
    hasApplicationUrl: params.get('hasApplicationUrl') === '1',
    sort: params.get('sort') ?? 'newest',
  };
}

export function filtersToParams(filters: JobFilters, page: number, pageSize = 20): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.city) params.set('city', filters.city);
  if (filters.institution) params.set('institution', filters.institution);
  if (filters.employmentType) params.set('employmentType', filters.employmentType);
  if (filters.status) params.set('status', filters.status);
  if (filters.deadlineFrom) params.set('deadlineFrom', filters.deadlineFrom);
  if (filters.deadlineTo) params.set('deadlineTo', filters.deadlineTo);
  if (filters.minQuota) params.set('minQuota', filters.minQuota);
  if (filters.hasApplicationUrl) params.set('hasApplicationUrl', '1');
  if (filters.sort !== 'newest') params.set('sort', filters.sort);
  if (page > 1) params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return params;
}

export function activeFilterCount(filters: JobFilters): number {
  return [
    filters.q,
    filters.city,
    filters.institution,
    filters.employmentType,
    filters.status,
    filters.deadlineFrom,
    filters.deadlineTo,
    filters.minQuota,
    filters.hasApplicationUrl ? 'x' : '',
  ].filter((value) => value !== '').length;
}

export function FilterForm({
  filters,
  onChange,
  onSubmit,
  onReset,
}: {
  filters: JobFilters;
  onChange: (next: JobFilters) => void;
  onSubmit: () => void;
  onReset: () => void;
}): ReactNode {
  const update = (patch: Partial<JobFilters>): void => onChange({ ...filters, ...patch });

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      aria-label="İlan filtreleri"
    >
      <CityDatalist />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Anahtar kelime" htmlFor="filter-q" hint="Başlık, kurum veya ilan metninde arar.">
          <input
            id="filter-q"
            className="input"
            type="search"
            value={filters.q}
            onChange={(event) => update({ q: event.target.value })}
            placeholder="ör. hemşire, zabıta, öğretim görevlisi"
          />
        </Field>

        <Field label="Kurum" htmlFor="filter-institution">
          <input
            id="filter-institution"
            className="input"
            value={filters.institution}
            onChange={(event) => update({ institution: event.target.value })}
            placeholder="ör. Üniversitesi, Bakanlığı"
          />
        </Field>

        <Field label="İl" htmlFor="filter-city">
          <input
            id="filter-city"
            className="input"
            value={filters.city}
            onChange={(event) => update({ city: event.target.value })}
            placeholder="ör. Ankara"
            list="il-listesi"
          />
        </Field>

        <Field label="İstihdam türü" htmlFor="filter-employment">
          <select
            id="filter-employment"
            className="input"
            value={filters.employmentType}
            onChange={(event) => update({ employmentType: event.target.value })}
          >
            <option value="">Tümü</option>
            {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Durum" htmlFor="filter-status">
          <select id="filter-status" className="input" value={filters.status} onChange={(event) => update({ status: event.target.value })}>
            <option value="">Tümü</option>
            <option value="active">Başvuru açık</option>
            <option value="upcoming">Başvuru yakında</option>
            <option value="closed">Kapandı</option>
          </select>
        </Field>

        <Field label="En az kontenjan" htmlFor="filter-quota" hint="Yalnızca sayı belirtilen ilanlarda çalışır.">
          <input
            id="filter-quota"
            className="input"
            type="number"
            min={1}
            inputMode="numeric"
            value={filters.minQuota}
            onChange={(event) => update({ minQuota: event.target.value })}
          />
        </Field>

        <Field label="Son başvuru (başlangıç)" htmlFor="filter-from">
          <input
            id="filter-from"
            className="input"
            type="date"
            value={filters.deadlineFrom}
            onChange={(event) => update({ deadlineFrom: event.target.value })}
          />
        </Field>

        <Field label="Son başvuru (bitiş)" htmlFor="filter-to">
          <input
            id="filter-to"
            className="input"
            type="date"
            value={filters.deadlineTo}
            onChange={(event) => update({ deadlineTo: event.target.value })}
          />
        </Field>

        <Field label="Sıralama" htmlFor="filter-sort">
          <select id="filter-sort" className="input" value={filters.sort} onChange={(event) => update({ sort: event.target.value })}>
            <option value="newest">Sisteme eklenme (yeni → eski)</option>
            <option value="deadline">Son başvuru tarihi (yakın → uzak)</option>
            <option value="published">Yayım tarihi (yeni → eski)</option>
            <option value="institution">Kurum adı (A → Z)</option>
            <option value="title">İlan başlığı (A → Z)</option>
          </select>
        </Field>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={filters.hasApplicationUrl}
          onChange={(event) => update({ hasApplicationUrl: event.target.checked })}
        />
        Yalnızca başvuru bağlantısı olan ilanlar
      </label>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" className="btn-primary">
          Filtrele
        </button>
        <button type="button" className="btn-secondary" onClick={onReset}>
          Filtreleri temizle
        </button>
      </div>
    </form>
  );
}

/**
 * İl listesi: Türkiye'nin 81 ili, `src/domain/provinces.ts` tek kaynağından.
 * Ayrı veri kopyası tutulmaz; iki listeyi senkron tutma yükü doğmaz.
 */
export function CityDatalist(): ReactNode {
  return (
    <datalist id="il-listesi">
      {PROVINCES.map((province) => (
        <option key={province.plateCode} value={province.name} />
      ))}
    </datalist>
  );
}
