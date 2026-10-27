/**
 * İlan listesi: filtrelenebilir, sıralanabilir, sayfalanabilir.
 *
 * Filtre durumu URL'de yaşar (paylaşılabilir bağlantı şartı). Sayfa yalnızca
 * sunucudan gelen kayıtları gösterir; toplam sayı da sunucudan gelir.
 *
 * Düzen: arama satırı (metin + il) her zaman görünür; başvuru durumu yalnızca
 * "Durum" düğmelerinden seçilir; diğer filtreler gruplanmış panelde durur.
 * Etkin filtreler sonuç satırında kaldırılabilir etiketlerdir, sıralama da
 * sonuçların hemen üstündedir.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ARCHIVE_STATUS,
  EMPTY_FILTERS,
  FilterForm,
  PANEL_FILTER_KEYS,
  activeFilterChips,
  filtersFromParams,
  filtersToParams,
  type JobFilters,
} from '../components/Filters';
import { toIstanbulDateOnly } from '../domain/dates';
import { JobCard } from '../components/JobCard';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorNotice, LoadingCard, Pagination } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { usePageMeta } from '../lib/page-meta';
import { formatNumber } from '../lib/format';
import type { JobListResponse } from '../types';

type JobsPreset = 'current' | 'all' | 'open' | 'closing7' | 'upcoming' | 'archive';

const PRESETS: readonly { id: JobsPreset; label: string }[] = [
  { id: 'current', label: 'Güncel' },
  { id: 'open', label: 'Başvurusu açık' },
  { id: 'closing7', label: 'Son günü yaklaşanlar' },
  { id: 'upcoming', label: 'Yakında başlayacak' },
  { id: 'archive', label: 'Süresi geçmiş (arşiv)' },
  { id: 'all', label: 'Tümü' },
];

const SORT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'newest', label: 'Önce yeni eklenenler' },
  { value: 'deadline', label: 'Önce son günü yakın olanlar' },
  { value: 'published', label: 'Önce yeni yayımlananlar' },
  { value: 'institution', label: 'Kurum adı (A → Z)' },
  { value: 'title', label: 'İlan başlığı (A → Z)' },
];

/** URL filtrelerinin hangi durum düğmesine karşılık geldiği (aria-pressed için). */
function activePreset(filters: JobFilters): JobsPreset | null {
  // Durum seçilmemişse sunucu süresi geçmiş/iptal ilanları göstermez ("Güncel").
  if (!filters.status) return 'current';
  if (filters.status === 'all') return 'all';
  if (filters.status === ARCHIVE_STATUS) return 'archive';
  if (filters.status === 'upcoming') return 'upcoming';
  if (filters.status === 'active') return filters.deadlineTo ? 'closing7' : 'open';
  return null;
}

/** Durum düğmesinin zaten gösterdiği alanlar etiket olarak tekrarlanmaz. */
function presetCoveredKeys(preset: JobsPreset | null): ReadonlySet<keyof JobFilters> {
  if (preset === 'closing7') return new Set<keyof JobFilters>(['status', 'deadlineFrom', 'deadlineTo']);
  if (preset && preset !== 'current') return new Set<keyof JobFilters>(['status']);
  return new Set();
}

const PAGE_SIZE = 20;

export function JobsPage() {
  usePageMeta({ title: 'Kamu personel alım ilanları' });
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const urlFilters = filtersFromParams(params);
  const currentPreset = activePreset(urlFilters);
  const covered = presetCoveredKeys(currentPreset);
  const chips = activeFilterChips(urlFilters).filter((chip) => !covered.has(chip.key));
  const panelCount = chips.filter((chip) => PANEL_FILTER_KEYS.has(chip.key)).length;

  const [draft, setDraft] = useState<JobFilters>(urlFilters);
  // Panel yalnızca paylaşılan bağlantıda panel filtresi varsa açık başlar;
  // ilk bakışta arama satırı ve durum düğmeleri yeterlidir.
  const [panelOpen, setPanelOpen] = useState(panelCount > 0);

  // Adres çubuğu değiştiğinde (geri/ileri, paylaşılan bağlantı) taslağı eşitle.
  // React'in önerdiği "prop değişince durumu ayarla" deseni: efekt yerine
  // render sırasında önceki anahtarla karşılaştırılır.
  const paramsKey = params.toString();
  const [lastParamsKey, setLastParamsKey] = useState(paramsKey);
  if (paramsKey !== lastParamsKey) {
    setLastParamsKey(paramsKey);
    setDraft(urlFilters);
  }

  const query = {
    ...urlFilters,
    page,
    pageSize: PAGE_SIZE,
  };

  const jobs = useQuery({
    queryKey: ['jobs', JSON.stringify(query)],
    queryFn: ({ signal }) =>
      api.get<JobListResponse>('/api/jobs', {
        q: query.q || undefined,
        city: query.city || undefined,
        institution: query.institution || undefined,
        employmentType: query.employmentType || undefined,
        kind: query.kind || undefined,
        status: query.status || undefined,
        deadlineFrom: query.deadlineFrom || undefined,
        deadlineTo: query.deadlineTo || undefined,
        minQuota: query.minQuota || undefined,
        // Eğitim/bölüm/KPSS filtreleri formda toplanıyordu ama isteğe
        // EKLENMİYORDU (sessizce etkisizdiler) — artık gönderiliyorlar.
        education: query.education || undefined,
        department: query.department || undefined,
        kpssType: query.kpssType || undefined,
        kpssMaxScore: query.kpssScore ? Number(query.kpssScore) : undefined,
        hasApplicationUrl: query.hasApplicationUrl ? true : undefined,
        sort: query.sort,
        page,
        pageSize: PAGE_SIZE,
      }, signal),
    placeholderData: (previous) => previous,
  });

  /** Filtreleri uygula: URL'i tek doğruluk kaynağı yapar, sayfayı 1'e alır. */
  function apply(filters: JobFilters): void {
    const next = filtersToParams(filters, 1, PAGE_SIZE);
    setParams(next, { replace: true });
  }

  /** Tüm filtreleri kaldırır; seçili sıralama korunur. */
  function reset(): void {
    apply({ ...EMPTY_FILTERS, sort: urlFilters.sort });
  }

  /**
   * Durum düğmeleri: yalnızca durum (ve "son günü yaklaşanlar" için tarih
   * penceresi) değişir; arama, il ve panel filtreleri korunur.
   */
  function applyPreset(preset: JobsPreset): void {
    // Tarih Türkiye gününe göre hesaplanır: `toISOString()` UTC verir ve gece
    // 00:00-03:00 arasında pencereyi bir gün kaydırıyordu.
    const now = Date.now();
    const today = toIstanbulDateOnly(new Date(now));
    const in7 = toIstanbulDateOnly(new Date(now + 7 * 86_400_000));
    // Süreç duyurularının başvuru durumu yoktur: durum seçilince tür filtresi kalkar.
    const kind = urlFilters.kind === 'process' ? '' : urlFilters.kind;
    const base: JobFilters = { ...urlFilters, kind };
    // Önceki "son günü yaklaşanlar" penceresi başka bir duruma taşınmasın.
    const withoutWindow: JobFilters =
      currentPreset === 'closing7' ? { ...base, deadlineFrom: '', deadlineTo: '' } : base;
    if (preset === 'current') apply({ ...withoutWindow, kind: urlFilters.kind, status: '' });
    else if (preset === 'all') apply({ ...withoutWindow, kind: urlFilters.kind, status: 'all' });
    else if (preset === 'open') apply({ ...withoutWindow, status: 'active', sort: 'deadline' });
    else if (preset === 'closing7')
      apply({ ...base, status: 'active', deadlineFrom: today, deadlineTo: in7, sort: 'deadline' });
    else if (preset === 'upcoming') apply({ ...withoutWindow, status: 'upcoming', sort: 'deadline' });
    // Arşiv: süresi dolan ve iptal edilen ilanlar silinmez, burada bulunur.
    else apply({ ...withoutWindow, status: ARCHIVE_STATUS, sort: 'newest' });
  }

  function goToPage(next: number): void {
    const nextParams = filtersToParams(urlFilters, next, PAGE_SIZE);
    setParams(nextParams, { replace: false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-text">
          <span className="kicker">İlan arama</span>
          <h1 className="page-title">Kamu personel alım ilanları</h1>
        </div>
      </header>

      <FilterForm
        filters={draft}
        onChange={setDraft}
        onSubmit={() => apply(draft)}
        onReset={reset}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((open) => !open)}
        panelCount={panelCount}
        busy={jobs.isFetching}
      />

      <div className="status-row" role="group" aria-label="Durum">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="status-tab"
            aria-pressed={currentPreset === preset.id}
            onClick={() => applyPreset(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="results-bar">
        <div className="filter-summary" role="status" aria-live="polite">
          {jobs.data ? (
            <>
              <strong>{formatNumber(jobs.data.total)}</strong> ilan bulundu
              {jobs.data.pages > 1 && (
                <span className="text-muted-sm filter-summary-page">
                  {' '}
                  · Sayfa {jobs.data.page}/{jobs.data.pages}
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-sm">Sonuçlar yükleniyor…</span>
          )}
        </div>
        <label className="sort-control" htmlFor="filter-sort">
          <span>Sıralama</span>
          <select
            id="filter-sort"
            className="filter-select"
            value={urlFilters.sort}
            onChange={(event) => apply({ ...urlFilters, sort: event.target.value })}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {chips.length > 0 && (
        <ul className="active-filters" aria-label="Etkin filtreler">
          {chips.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                className="filter-chip"
                aria-label={`${chip.label} filtresini kaldır`}
                onClick={() => apply({ ...urlFilters, ...chip.clear })}
              >
                <span>{chip.label}</span>
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
          {chips.length > 1 && (
            <li>
              <button type="button" className="btn-ghost btn-sm" onClick={reset}>
                Tümünü temizle
              </button>
            </li>
          )}
        </ul>
      )}

      {jobs.isError && (
        <ErrorNotice
          title="İlan listesi alınamadı"
          message={errorMessage(jobs.error)}
          onRetry={() => void jobs.refetch()}
        />
      )}

      {jobs.isLoading && <LoadingCard title="İlanlar yükleniyor…" />}

      {jobs.data && jobs.data.items.length === 0 && (
        <EmptyState
          icon="search"
          title="Bu filtrelerle ilan bulunamadı"
          description="Seçimlerinizi azaltıp yeniden deneyin; belki aradığınız ilan henüz burada değildir."
          action={
            chips.length > 0 || currentPreset !== 'all' ? (
              <div className="action-row">
                <button type="button" className="btn-primary btn-sm" onClick={reset}>
                  <Icon name="close" size={14} />
                  <span>Filtreleri temizle</span>
                </button>
                {!panelOpen && (
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setPanelOpen(true)}>
                    <Icon name="filter" size={14} />
                    <span>Filtreleri düzenle</span>
                  </button>
                )}
              </div>
            ) : undefined
          }
        />
      )}

      {jobs.data && jobs.data.items.length > 0 && (
        <div className="job-list">
          {jobs.data.items.map((job) => (
            <JobCard job={job} key={job.id} />
          ))}
        </div>
      )}

      {jobs.data && (
        <Pagination page={jobs.data.page} pages={jobs.data.pages} onPage={goToPage} label="İlan sayfaları" />
      )}

    </div>
  );
}
