/**
 * İlan listesi: filtrelenebilir, sıralanabilir, sayfalanabilir.
 *
 * Filtre durumu URL'de yaşar (paylaşılabilir bağlantı şartı). Sayfa yalnızca
 * sunucudan gelen kayıtları gösterir; toplam sayı da sunucudan gelir.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  EMPTY_FILTERS,
  FilterForm,
  activeFilterCount,
  filtersFromParams,
  filtersToParams,
  type JobFilters,
} from '../components/Filters';

const EMPTY_PRESET: JobFilters = EMPTY_FILTERS;
import { toIstanbulDateOnly } from '../domain/dates';
import { JobCard } from '../components/JobCard';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorNotice, LoadingCard, Pagination, Tag } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatNumber } from '../lib/format';
import { HONESTY_NOTE } from '../site';
import type { JobListResponse } from '../types';

const PAGE_SIZE = 20;

export function JobsPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const urlFilters = filtersFromParams(params);

  const [draft, setDraft] = useState<JobFilters>(urlFilters);
  const [panelOpen, setPanelOpen] = useState(activeFilterCount(urlFilters) === 0);

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

  function reset(): void {
    setParams(
      filtersToParams(
        {
          ...draft,
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
        },
        1,
        PAGE_SIZE,
      ),
      { replace: true },
    );
  }

  /** Hazır görünümler: adayın en sık kullandığı üç bakış (URL filtrelerine çevrilir). */
  function applyPreset(preset: 'all' | 'open' | 'closing7' | 'newest'): void {
    // Tarih Türkiye gününe göre hesaplanır: `toISOString()` UTC verir ve gece
    // 00:00-03:00 arasında pencereyi bir gün kaydırıyordu.
    const now = Date.now();
    const today = toIstanbulDateOnly(new Date(now));
    const in7 = toIstanbulDateOnly(new Date(now + 7 * 86_400_000));
    const base: JobFilters = { ...EMPTY_PRESET, ...urlFilters };
    if (preset === 'all') apply({ ...EMPTY_PRESET });
    else if (preset === 'open')
      apply({ ...base, status: 'active', deadlineFrom: '', deadlineTo: '', sort: 'deadline' });
    else if (preset === 'closing7')
      apply({ ...base, status: 'active', deadlineFrom: today, deadlineTo: in7, sort: 'deadline' });
    else apply({ ...base, sort: 'newest' });
  }

  function goToPage(next: number): void {
    const nextParams = filtersToParams(urlFilters, next, PAGE_SIZE);
    setParams(nextParams, { replace: false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const activeCount = activeFilterCount(urlFilters);

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-text">
          <span className="kicker">İlan arama</span>
          <h1 className="page-title">Kamu personel alım ilanları</h1>
          <p className="info-lede">
            Ne aradığınızı yazın, isterseniz il ve tür seçip <strong>Ara</strong>'ya
            basın. Daha fazla seçenek isterseniz gelişmiş filtreler bir tık altta.
          </p>
        </div>
        <div className="page-head-actions">
          <button
            type="button"
            className="btn-secondary btn-sm"
            aria-expanded={panelOpen}
            aria-controls="filtre-paneli"
            onClick={() => setPanelOpen((open) => !open)}
          >
            <Icon name="filter" size={15} />
            <span>{panelOpen ? 'Filtreleri gizle' : 'Filtreler'}</span>
            {activeCount > 0 && <span className="subnav-count">{activeCount}</span>}
          </button>
        </div>
      </header>

      <div className="preset-row" role="group" aria-label="Hazır görünümler">
        <button type="button" className="btn-secondary btn-sm" onClick={() => applyPreset('all')}>
          Tümü
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => applyPreset('open')}>
          Başvurusu açık
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => applyPreset('closing7')}>
          Son günü yaklaşanlar
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => applyPreset('newest')}>
          Yeni eklenenler
        </button>
      </div>

      {panelOpen && (
        <div id="filtre-paneli">
          <FilterForm
            filters={draft}
            onChange={setDraft}
            onSubmit={() => apply(draft)}
            onReset={reset}
            busy={jobs.isFetching}
          />
        </div>
      )}

      <div className="filter-summary" role="status" aria-live="polite">
        {jobs.data ? (
          <>
            <strong>{formatNumber(jobs.data.total)}</strong> ilan bulundu
            {activeCount > 0 && <span className="inline-sep" />}
            {activeCount > 0 && <Tag tone="accent">{`${activeCount} filtre etkin`}</Tag>}
            <span className="inline-sep" />
            <span className="text-muted-sm">
              Sayfa {jobs.data.page}/{Math.max(1, jobs.data.pages)}
            </span>
          </>
        ) : (
          <span className="text-muted-sm">Sonuçlar yükleniyor…</span>
        )}
      </div>

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

      <p className="text-muted-sm">{HONESTY_NOTE}</p>
    </div>
  );
}
