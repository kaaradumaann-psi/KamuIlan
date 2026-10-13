/**
 * İlan filtreleri: URL'de saklanır (paylaşılabilir bağlantı şartı).
 *
 * Filtre durumu bileşenin içinde tutulmaz; sayfa URL sorgu parametrelerini
 * yönetir. Böylece aynı bağlantı başka birinde aynı sonucu verir.
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PROVINCES } from '../domain/provinces';
import { EDUCATION_LABELS, EMPLOYMENT_TYPE_LABELS } from '../lib/format';

/** KPSS puan türleri — `src/domain/types.ts` KPSS_SCORE_TYPES ile aynı liste. */
export const KPSS_TYPE_OPTIONS = ['P1', 'P2', 'P3', 'P10', 'P93', 'P94', 'P121', 'P124', 'DHBT'] as const;
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
  education: string;
  department: string;
  kpssType: string;
  /** Adayın kendi KPSS puanı: taban puanı bunu aşan ilanlar elenir. */
  kpssScore: string;
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
  education: '',
  department: '',
  kpssType: '',
  kpssScore: '',
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
    education: params.get('education') ?? '',
    department: params.get('department') ?? '',
    kpssType: params.get('kpssType') ?? '',
    kpssScore: params.get('kpssScore') ?? '',
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
  if (filters.education) params.set('education', filters.education);
  if (filters.department) params.set('department', filters.department);
  if (filters.kpssType) params.set('kpssType', filters.kpssType);
  if (filters.kpssScore) params.set('kpssScore', filters.kpssScore);
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
    filters.education,
    filters.department,
    filters.kpssType,
    filters.kpssScore,
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
  const advancedCount = [
    filters.institution,
    filters.education,
    filters.department,
    filters.kpssType,
    filters.kpssScore,
    filters.deadlineFrom,
    filters.deadlineTo,
    filters.minQuota,
    filters.hasApplicationUrl ? 'x' : '',
    filters.sort !== 'newest' ? 'x' : '',
  ].filter((value) => value !== '').length;
  // Gelişmiş filtre URL'den geliyorsa (paylaşılan bağlantı) bölüm açık başlar;
  // yoksa kapalıdır: önce temel arama, gerisi isteğe bağlı.
  const [advancedOpen, setAdvancedOpen] = useState(advancedCount > 0);

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
        <Field label="Ne arıyorsunuz?" htmlFor="filter-q" hint="İş, kurum veya meslek adı yazın.">
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
      </div>

      <div className="filter-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          <Icon name="search" size={16} />
          <span>{busy ? 'Aranıyor…' : 'Ara'}</span>
        </button>
        <button type="button" className="btn-secondary" onClick={onReset}>
          <Icon name="close" size={15} />
          <span>Temizle</span>
        </button>
        <button
          type="button"
          className="btn-secondary"
          aria-expanded={advancedOpen}
          aria-controls="gelismis-filtreler"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <Icon name="filter" size={15} />
          <span>
            Gelişmiş filtreler{advancedCount > 0 ? ` (${advancedCount} seçili)` : ''}
          </span>
        </button>
      </div>

      {advancedOpen && (
        <div id="gelismis-filtreler" className="page-stack-sm">
          <div className="filter-grid">
            <Field label="Kurum" htmlFor="filter-institution">
              <input
                id="filter-institution"
                value={filters.institution}
                onChange={(event) => update({ institution: event.target.value })}
                placeholder="ör. Üniversitesi, Bakanlığı"
              />
            </Field>

            <Field label="Eğitim düzeyi" htmlFor="filter-education" hint="İlanda aranan öğrenim düzeyi.">
              <select
                id="filter-education"
                className="filter-select"
                value={filters.education}
                onChange={(event) => update({ education: event.target.value })}
              >
                <option value="">Tümü</option>
                {Object.entries(EDUCATION_LABELS)
                  .filter(([value]) => value !== 'belirtilmemis' && value !== 'lise')
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </select>
            </Field>

            <Field label="Bölüm / program" htmlFor="filter-department" hint="ör. hemşirelik, bilgisayar mühendisliği">
              <input
                id="filter-department"
                value={filters.department}
                onChange={(event) => update({ department: event.target.value })}
                placeholder="ör. hemşirelik"
              />
            </Field>

            <Field label="KPSS puan türü" htmlFor="filter-kpss-type">
              <select
                id="filter-kpss-type"
                className="filter-select"
                value={filters.kpssType}
                onChange={(event) => update({ kpssType: event.target.value })}
              >
                <option value="">Tümü</option>
                {KPSS_TYPE_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    KPSS {value}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="KPSS puanım"
              htmlFor="filter-kpss-score"
              hint="Taban puanı puanınızı aşan ilanlar elenir. Yalnızca taban puanı belirtilen ilanlarda çalışır."
            >
              <input
                id="filter-kpss-score"
                type="number"
                min={0}
                max={100}
                inputMode="decimal"
                value={filters.kpssScore}
                onChange={(event) => update({ kpssScore: event.target.value })}
                placeholder="ör. 72"
              />
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

            <Field label="Son başvuru: en erken" htmlFor="filter-from" hint="Son günü bu tarihten önce olmayanlar.">
              <input
                id="filter-from"
                className="date-filter-field"
                type="date"
                value={filters.deadlineFrom}
                onChange={(event) => update({ deadlineFrom: event.target.value })}
              />
            </Field>

            <Field label="Son başvuru: en geç" htmlFor="filter-to" hint="Son günü bu tarihten sonra olmayanlar.">
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
                <option value="newest">Önce yeni eklenenler</option>
                <option value="deadline">Önce son günü yakın olanlar</option>
                <option value="published">Önce yeni yayımlananlar</option>
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
        </div>
      )}

      <p className="text-muted-sm">
        Adres çubuğundaki bağlantıyı paylaşırsanız aynı liste karşı tarafta da açılır.{' '}
        <Link to="/kaynaklar">Hangi kaynaklar taranıyor?</Link>
      </p>
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
