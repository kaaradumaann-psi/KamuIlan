/**
 * İlan filtreleri: URL'de saklanır (paylaşılabilir bağlantı şartı).
 *
 * Filtre durumu bileşenin içinde tutulmaz; sayfa URL sorgu parametrelerini
 * yönetir. Böylece aynı bağlantı başka birinde aynı sonucu verir.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PROVINCES } from '../domain/provinces';
import { EMPLOYMENT_TYPE_LABELS } from '../lib/format';
import { Icon } from './Icon';
import { Checkbox, Field } from './ui';

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
  busy = false,
}: {
  filters: JobFilters;
  onChange: (next: JobFilters) => void;
  onSubmit: () => void;
  onReset: () => void;
  busy?: boolean;
}): ReactNode {
  const update = (patch: Partial<JobFilters>): void => onChange({ ...filters, ...patch });

  return (
    <form
      className="card-elevated filter-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      aria-label="İlan filtreleri"
    >
      <CityDatalist />
      <div className="filter-grid">
        <Field label="Anahtar kelime" htmlFor="filter-q" hint="Başlık, kurum veya ilan metninde arar.">
          <span className="search-input-wrap">
            <Icon name="search" size={16} />
            <input
              id="filter-q"
              type="search"
              value={filters.q}
              onChange={(event) => update({ q: event.target.value })}
              placeholder="ör. hemşire, zabıta, öğretim görevlisi"
            />
          </span>
        </Field>

        <Field label="Kurum" htmlFor="filter-institution">
          <input
            id="filter-institution"
            value={filters.institution}
            onChange={(event) => update({ institution: event.target.value })}
            placeholder="ör. Üniversitesi, Bakanlığı"
          />
        </Field>

        <Field label="İl" htmlFor="filter-city">
          <input
            id="filter-city"
            value={filters.city}
            onChange={(event) => update({ city: event.target.value })}
            placeholder="ör. Ankara"
            list="il-listesi"
          />
        </Field>

        <Field label="İstihdam türü" htmlFor="filter-employment">
          <select
            id="filter-employment"
            className="filter-select"
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
          <select
            id="filter-status"
            className="filter-select"
            value={filters.status}
            onChange={(event) => update({ status: event.target.value })}
          >
            <option value="">Tümü</option>
            <option value="active">Başvuru açık</option>
            <option value="upcoming">Başvuru yakında</option>
            <option value="closed">Kapandı</option>
          </select>
        </Field>

        <Field label="En az kontenjan" htmlFor="filter-quota" hint="Yalnızca kontenjanı belirtilen ilanlarda çalışır.">
          <input
            id="filter-quota"
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
            className="date-filter-field"
            type="date"
            value={filters.deadlineFrom}
            onChange={(event) => update({ deadlineFrom: event.target.value })}
          />
        </Field>

        <Field label="Son başvuru (bitiş)" htmlFor="filter-to">
          <input
            id="filter-to"
            className="date-filter-field"
            type="date"
            value={filters.deadlineTo}
            onChange={(event) => update({ deadlineTo: event.target.value })}
          />
        </Field>

        <Field label="Sıralama" htmlFor="filter-sort">
          <select
            id="filter-sort"
            className="filter-select"
            value={filters.sort}
            onChange={(event) => update({ sort: event.target.value })}
          >
            <option value="newest">Sisteme eklenme (yeni → eski)</option>
            <option value="deadline">Son başvuru tarihi (yakın → uzak)</option>
            <option value="published">Yayım tarihi (yeni → eski)</option>
            <option value="institution">Kurum adı (A → Z)</option>
            <option value="title">İlan başlığı (A → Z)</option>
          </select>
        </Field>
      </div>

      <Checkbox
        id="filter-app-url"
        checked={filters.hasApplicationUrl}
        onChange={(checked) => update({ hasApplicationUrl: checked })}
        label="Yalnızca başvuru bağlantısı olan ilanlar"
        hint="Başvuru adresi yalnızca ilanda açıkça verilmişse doldurulur."
      />

      <div className="filter-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          <Icon name="search" size={16} />
          <span>{busy ? 'Aranıyor…' : 'Filtrele'}</span>
        </button>
        <button type="button" className="btn-secondary" onClick={onReset}>
          <Icon name="close" size={15} />
          <span>Filtreleri temizle</span>
        </button>
        <Link className="btn-secondary" to="/kaynaklar">
          <Icon name="list" size={15} />
          <span>Hangi kaynaklar taranıyor?</span>
        </Link>
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
