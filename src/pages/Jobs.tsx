/**
 * İlan listesi: paylaşılabilir URL filtreleri, sıralama ve sayfalama.
 *
 * Filtre durumu URL'de tutulur; aynı bağlantıyı açan herkes aynı sonucu görür.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatNumber } from '../lib/format';
import type { JobListResponse } from '../types';
import { EMPTY_FILTERS, FilterForm, activeFilterCount, filtersFromParams, filtersToParams, type JobFilters } from '../components/Filters';
import { JobCard } from '../components/JobCard';
import { Card, EmptyState, ErrorNotice, Pagination, Spinner } from '../components/ui';

const PAGE_SIZE = 20;

export function JobsPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const query = useQuery({
    queryKey: ['jobs', params.toString()],
    queryFn: () =>
      api.get<JobListResponse>('/api/jobs', {
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.city ? { city: filters.city } : {}),
        ...(filters.institution ? { institution: filters.institution } : {}),
        ...(filters.employmentType ? { employmentType: filters.employmentType } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.deadlineFrom ? { deadlineFrom: filters.deadlineFrom } : {}),
        ...(filters.deadlineTo ? { deadlineTo: filters.deadlineTo } : {}),
        ...(filters.minQuota ? { minQuota: filters.minQuota } : {}),
        ...(filters.hasApplicationUrl ? { hasApplicationUrl: true } : {}),
        sort: filters.sort,
        page,
        pageSize: PAGE_SIZE,
      }),
  });

  const apply = (next: JobFilters, nextPage = 1): void => {
    setParams(filtersToParams(next, nextPage, PAGE_SIZE));
  };

  const active = activeFilterCount(filters);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold">İlanlar</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Filtreler adres çubuğuna yazılır; bağlantıyı paylaştığınızda karşı taraf aynı listeyi görür.
        </p>
      </header>

      <FilterForm
        filters={filters}
        onChange={(next) => setParams(filtersToParams(next, 1, PAGE_SIZE), { replace: true })}
        onSubmit={() => apply(filters, 1)}
        onReset={() => apply(EMPTY_FILTERS, 1)}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-300">
        <p aria-live="polite">
          {query.isLoading ? 'Aranıyor…' : `${formatNumber(query.data?.total ?? 0)} ilan bulundu`}
          {active > 0 ? ` (${active} filtre etkin)` : ''}
        </p>
        {query.data && query.data.pages > 1 && (
          <p>
            Sayfa {query.data.page} / {query.data.pages}
          </p>
        )}
      </div>

      {query.isError && <ErrorNotice message="İlanlar yüklenemedi. Bağlantıyı kontrol edip yeniden deneyin." onRetry={() => void query.refetch()} />}
      {query.isLoading && <Spinner label="İlanlar yükleniyor…" />}

      {query.data?.items.length === 0 && !query.isLoading && (
        <EmptyState
          title="Bu kriterlere uyan ilan bulunamadı"
          description="Filtreleri gevşetmeyi deneyin. Ayrıca ilk tarama henüz çalışmamış olabilir; Kaynaklar sayfasından son tarama durumunu görebilirsiniz."
        />
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {query.data?.items.map((job) => <JobCard key={job.id} job={job} />)}
      </div>

      {query.data && (
        <Pagination
          page={query.data.page}
          pages={query.data.pages}
          onChange={(nextPage) => {
            const next = filtersToParams(filters, nextPage, PAGE_SIZE);
            setParams(next);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}

      <Card title="Sonuçlar nasıl oluşuyor?" description="Şeffaflık notu">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Yalnızca sınıflandırmada "kabul" kararı verilen ilanlar listelenir; şüpheli kayıtlar inceleme kuyruğuna gider.</li>
          <li>İhale, satın alma, sonuç/atama ve tebliğ içerikleri yeni ilan sayılmaz.</li>
          <li>Eksik alanlar uydurulmaz: bilinmeyen değerler "belirtilmemiş" olarak gösterilir.</li>
        </ul>
      </Card>
    </div>
  );
}
