/**
 * İlan filtreleri: URL'de saklanır (paylaşılabilir bağlantı şartı).
 *
 * Filtre durumu bileşenin içinde tutulmaz; sayfa URL sorgu parametrelerini
 * yönetir. Böylece aynı bağlantı başka birinde aynı sonucu verir.
 */
import type { ReactNode } from 'react';
import { PROVINCES } from '../domain/provinces';
import { EDUCATION_LEVELS, EDUCATION_LEVEL_LABELS } from '../domain/types';
import { EMPLOYMENT_TYPE_LABELS, normalizeEducationLevel } from '../lib/format';

/** KPSS puan türleri — `src/domain/types.ts` KPSS_SCORE_TYPES ile aynı liste. */
export const KPSS_TYPE_OPTIONS = ['P1', 'P2', 'P3', 'P10', 'P93', 'P94', 'P121', 'P124', 'DHBT'] as const;
import { Icon } from './Icon';
import { Checkbox, Field } from './ui';

/** Arşiv görünümü: süresi dolan ve iptal edilen ilanlar (API virgüllü durum listesini kabul eder). */
export const ARCHIVE_STATUS = 'closed,cancelled';

export interface JobFilters {
  q: string;
  city: string;
  institution: string;
  employmentType: string;
  /** Tür: '' tümü, 'job' iş ilanları, 'process' süreç duyuruları. */
  kind: string;
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
  kind: '',
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
    kind: params.get('kind') ?? '',
    status: params.get('status') ?? '',
    deadlineFrom: params.get('deadlineFrom') ?? '',
    deadlineTo: params.get('deadlineTo') ?? '',
    minQuota: params.get('minQuota') ?? '',
    // Paylaşılmış eski bağlantılar: 'lise' → 'ortaogretim', 'belirtilmemis' → seçili değil.
    education: normalizeEducationLevel(params.get('education') ?? ''),
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
  if (filters.kind) params.set('kind', filters.kind);
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

/** Durum adları (etkin filtre etiketleri için; URL'deki eski tekil durumlar da okunur). */
const STATUS_CHIP_LABELS: Record<string, string> = {
  active: 'Başvuru açık',
  upcoming: 'Başvuru yakında',
  closed: 'Kapandı',
  cancelled: 'İptal edildi',
  [ARCHIVE_STATUS]: 'Arşiv',
};

const KIND_LABELS: Record<string, string> = {
  job: 'İş ilanları',
  process: 'Sınav, kura ve sonuç duyuruları',
};

/** 'YYYY-AA-GG' → 'GG.AA.YYYY' (etiketlerde kısa ve saat diliminden bağımsız). */
function shortDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

export interface FilterChip {
  key: keyof JobFilters;
  label: string;
  /** Etiket kaldırılınca uygulanacak değişiklik. */
  clear: Partial<JobFilters>;
}

/**
 * Etkin filtrelerin okunur etiketleri. Sonuç satırında gösterilir; her biri
 * tek tıkla kaldırılabilir (panel kapalıyken de neyin seçili olduğu görünür).
 */
export function activeFilterChips(filters: JobFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  const add = (key: keyof JobFilters, label: string, clear: Partial<JobFilters> = { [key]: '' }): void => {
    chips.push({ key, label, clear });
  };
  const employmentLabels: Record<string, string> = EMPLOYMENT_TYPE_LABELS;
  const educationLabels: Record<string, string> = EDUCATION_LEVEL_LABELS;
  if (filters.q) add('q', `“${filters.q}”`);
  if (filters.city) add('city', `İl: ${filters.city}`);
  if (filters.status) add('status', `Durum: ${STATUS_CHIP_LABELS[filters.status] ?? filters.status}`);
  if (filters.employmentType) add('employmentType', employmentLabels[filters.employmentType] ?? filters.employmentType);
  if (filters.kind) add('kind', KIND_LABELS[filters.kind] ?? filters.kind);
  if (filters.institution) add('institution', `Kurum: ${filters.institution}`);
  if (filters.education) add('education', educationLabels[filters.education] ?? filters.education);
  if (filters.department) add('department', `Bölüm: ${filters.department}`);
  if (filters.kpssType) add('kpssType', `KPSS ${filters.kpssType}`);
  if (filters.kpssScore) add('kpssScore', `KPSS puanım: ${filters.kpssScore}`);
  if (filters.minQuota) add('minQuota', `En az ${filters.minQuota} kişi`);
  if (filters.deadlineFrom) add('deadlineFrom', `Son başvuru ${shortDate(filters.deadlineFrom)} ve sonrası`);
  if (filters.deadlineTo) add('deadlineTo', `Son başvuru ${shortDate(filters.deadlineTo)} ve öncesi`);
  if (filters.hasApplicationUrl) add('hasApplicationUrl', 'Başvuru bağlantısı olanlar', { hasApplicationUrl: false });
  return chips;
}

/** "Filtreler" panelindeki alanlar (arama ve il her zaman görünür; durum hazır düğmelerdedir). */
export const PANEL_FILTER_KEYS: ReadonlySet<keyof JobFilters> = new Set<keyof JobFilters>([
  'employmentType',
  'kind',
  'institution',
  'education',
  'department',
  'kpssType',
  'kpssScore',
  'minQuota',
  'deadlineFrom',
  'deadlineTo',
  'hasApplicationUrl',
]);

export function FilterForm({
  filters,
  onChange,
  onSubmit,
  onReset,
  panelOpen,
  onTogglePanel,
  panelCount,
  busy = false,
}: {
  filters: JobFilters;
  onChange: (next: JobFilters) => void;
  onSubmit: () => void;
  onReset: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** Panelde seçili filtre sayısı (düğmede rozet). */
  panelCount: number;
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
      <div className="filter-search-row">
        <Field label="Ne arıyorsunuz?" htmlFor="filter-q">
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
            placeholder="Tüm iller"
            list="il-listesi"
          />
        </Field>

        <button type="submit" className="btn-primary filter-search-submit" disabled={busy}>
          <Icon name="search" size={16} />
          <span>{busy ? 'Aranıyor…' : 'Ara'}</span>
        </button>
      </div>

      <div className="filter-toolbar">
        <button
          type="button"
          className="btn-ghost btn-sm"
          aria-expanded={panelOpen}
          aria-controls="filtre-paneli"
          onClick={onTogglePanel}
        >
          <Icon name="filter" size={15} />
          <span>{panelOpen ? 'Filtreleri gizle' : 'Filtreler'}</span>
          {panelCount > 0 && <span className="subnav-count">{panelCount}</span>}
        </button>
      </div>

      {panelOpen && (
        <div id="filtre-paneli" className="filter-groups">
          <fieldset className="filter-group-box">
            <legend>İlan</legend>
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

            <Field label="İlan türü" htmlFor="filter-kind">
              <select
                id="filter-kind"
                className="filter-select"
                value={filters.kind}
                onChange={(event) =>
                  // Süreç duyurularında başvuru durumu yoktur; durum seçimi kaldırılır.
                  update(
                    event.target.value === 'process'
                      ? { kind: event.target.value, status: '' }
                      : { kind: event.target.value },
                  )
                }
              >
                <option value="">Tümü</option>
                <option value="job">{KIND_LABELS.job}</option>
                <option value="process">{KIND_LABELS.process}</option>
              </select>
            </Field>

            <Field label="Kurum" htmlFor="filter-institution">
              <input
                id="filter-institution"
                value={filters.institution}
                onChange={(event) => update({ institution: event.target.value })}
                placeholder="ör. Sağlık Bakanlığı"
              />
            </Field>
          </fieldset>

          <fieldset className="filter-group-box">
            <legend>Size uygunluk</legend>
            <Field label="Eğitim düzeyi" htmlFor="filter-education">
              <select
                id="filter-education"
                className="filter-select"
                value={filters.education}
                onChange={(event) => update({ education: event.target.value })}
              >
                <option value="">Tümü</option>
                {/* Kanonik liste (domain): 'lise'/'belirtilmemis' uydurma değer
                    sunulmaz — 'lise' hiçbir kayıtla eşleşmiyordu. */}
                {EDUCATION_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {EDUCATION_LEVEL_LABELS[level]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Bölüm / program" htmlFor="filter-department">
              <input
                id="filter-department"
                value={filters.department}
                onChange={(event) => update({ department: event.target.value })}
                placeholder="ör. hemşirelik"
              />
            </Field>

            <div className="filter-pair">
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

              <Field label="KPSS puanım" htmlFor="filter-kpss-score">
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
            </div>
            <p className="field-hint">Puanınızı yazarsanız taban puanı daha yüksek olan ilanlar gizlenir.</p>
          </fieldset>

          <fieldset className="filter-group-box">
            <legend>Başvuru</legend>
            <div className="filter-pair">
              <Field label="Son başvuru: en erken" htmlFor="filter-from">
                <input
                  id="filter-from"
                  className="date-filter-field"
                  type="date"
                  value={filters.deadlineFrom}
                  onChange={(event) => update({ deadlineFrom: event.target.value })}
                />
              </Field>

              <Field label="Son başvuru: en geç" htmlFor="filter-to">
                <input
                  id="filter-to"
                  className="date-filter-field"
                  type="date"
                  value={filters.deadlineTo}
                  onChange={(event) => update({ deadlineTo: event.target.value })}
                />
              </Field>
            </div>

            <Field label="En az kontenjan" htmlFor="filter-quota">
              <input
                id="filter-quota"
                type="number"
                min={1}
                inputMode="numeric"
                value={filters.minQuota}
                onChange={(event) => update({ minQuota: event.target.value })}
                placeholder="ör. 5"
              />
            </Field>

            <Checkbox
              id="filter-app-url"
              checked={filters.hasApplicationUrl}
              onChange={(checked) => update({ hasApplicationUrl: checked })}
              label="Yalnızca başvuru bağlantısı olanlar"
            />
          </fieldset>

          <div className="filter-actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              <span>Filtreleri uygula</span>
            </button>
            <button type="button" className="btn-secondary" onClick={onReset}>
              <Icon name="close" size={15} />
              <span>Temizle</span>
            </button>
          </div>
        </div>
      )}
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
