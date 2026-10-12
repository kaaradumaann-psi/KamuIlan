/**
 * Ana sayfa: güncel ilanlar, yakın son başvurular, tür dağılımı ve sistem durumu.
 *
 * Kural: Hiçbir sayı uydurulmaz. Tüm değerler `/api/jobs/stats` ve
 * `/api/health` yanıtlarından gelir; veri yoksa "henüz veri yok" yazılır.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { EMPLOYMENT_TYPE_LABELS, formatNumber, formatRelative } from '../lib/format';
import type { DashboardStats, HealthResponse, JobListResponse } from '../types';
import { JobCard } from '../components/JobCard';
import { Card, EmptyState, ErrorNotice, InfoNote, Spinner } from '../components/ui';

export function HomePage(): ReactNode {
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api.get<DashboardStats>('/api/jobs/stats') });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<HealthResponse>('/api/health') });
  const latest = useQuery({
    queryKey: ['jobs', 'latest'],
    queryFn: () => api.get<JobListResponse>('/api/jobs', { pageSize: 6, sort: 'newest' }),
  });
  const closing = useQuery({
    queryKey: ['jobs', 'closing-soon'],
    queryFn: () => api.get<JobListResponse>('/api/jobs', { pageSize: 4, sort: 'deadline', status: 'active' }),
  });

  return (
    <div className="space-y-6">
      <section className="card bg-gradient-to-br from-brand-600 to-brand-700 text-white dark:from-brand-700 dark:to-slate-900">
        <h1 className="text-2xl font-semibold sm:text-3xl">Kamu personel alım ilanları — tek yerde, kaynaklı</h1>
        <p className="mt-2 max-w-3xl text-sm text-brand-50">
          Resmî Gazete, ilan.gov.tr, ÖSYM, İŞKUR, Kariyer Kapısı ve kurum sayfalarından ilanlar toplanır; sınıflandırılır,
          tekilleştirilir ve kriterlerinize uyan yeni ilanlar için e-posta gönderilir.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link to="/ilanlar" className="btn bg-white text-brand-700 hover:bg-brand-50">
            İlanları ara
          </Link>
          <Link to="/kaynaklar" className="btn border border-white/40 text-white hover:bg-white/10">
            Kaynak kapsamı
          </Link>
          <Link to="/giris" className="btn border border-white/40 text-white hover:bg-white/10">
            Bildirim al
          </Link>
        </div>
      </section>

      {health.data && health.data.warnings.length > 0 && (
        <InfoNote tone="warning">
          <strong>Sistem uyarısı:</strong> {health.data.warnings.join(' ')}
        </InfoNote>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.isLoading && <Spinner />}
        {stats.data && (
          <>
            <StatCard label="Toplam ilan" value={formatNumber(stats.data.total)} />
            <StatCard label="Başvuruya açık" value={formatNumber(stats.data.active)} />
            <StatCard label="Yakında başlıyor" value={formatNumber(stats.data.upcoming)} />
            <StatCard label="Son 7 günde kapanan/kapanacak" value={formatNumber(stats.data.closingSoon)} />
            <StatCard label="Bugün eklenen" value={formatNumber(stats.data.addedToday)} />
            <StatCard label="Kapandı" value={formatNumber(stats.data.closed)} />
          </>
        )}
      </section>

      {stats.data && (
        <Card title="İlan türüne göre dağılım" description="Yalnızca kayıtlı ilanlardan hesaplanır.">
          {stats.data.byEmploymentType.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">Henüz ilan yok.</p>
          ) : (
            <ul className="space-y-2">
              {stats.data.byEmploymentType.map((entry) => {
                const total = stats.data?.total ?? 1;
                const percent = Math.round((entry.count / Math.max(1, total)) * 100);
                return (
                  <li key={entry.key}>
                    <div className="flex items-center justify-between text-sm">
                      <Link to={`/ilanlar?employmentType=${encodeURIComponent(entry.key)}`}>
                        {EMPLOYMENT_TYPE_LABELS[entry.key] ?? entry.key}
                      </Link>
                      <span className="text-slate-600 dark:text-slate-300">
                        {formatNumber(entry.count)} ({percent}%)
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${percent}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">En yeni ilanlar</h2>
            <Link to="/ilanlar?sort=newest" className="text-sm">
              Tümü
            </Link>
          </header>
          {latest.isError && <ErrorNotice message="İlanlar yüklenemedi." onRetry={() => void latest.refetch()} />}
          {latest.data?.items.length === 0 && (
            <EmptyState
              title="Henüz ilan toplanmadı"
              description="Kaynaklar ilk taramayı bekliyor. Worker çalıştığında ilanlar burada görünür — tarayıcıyı açık tutmanız gerekmez."
            />
          )}
          {latest.data?.items.map((job) => <JobCard key={job.id} job={job} />)}
        </div>

        <div className="space-y-3">
          <header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Son günler</h2>
            <Link to="/ilanlar?sort=deadline&status=active" className="text-sm">
              Tümü
            </Link>
          </header>
          {closing.data?.items.length === 0 && (
            <EmptyState title="Yakın tarihli kapanan ilan yok" description="Son başvuru tarihi yaklaşan ilan bulunmuyor." />
          )}
          {closing.data?.items.map((job) => <JobCard key={job.id} job={job} />)}
        </div>
      </section>

      <Card title="Sistem durumu" description="Bu bilgiler gerçek ölçümlerdir: son başarılı tarama, worker kalp atışı ve kapsam.">
        {health.isError && <ErrorNotice message="Sistem durumu okunamadı." onRetry={() => void health.refetch()} />}
        {health.data && (
          <ul className="space-y-1 text-sm">
            <li>Durum: {health.data.status === 'ok' ? 'normal' : health.data.status === 'degraded' ? 'kısmen sorunlu' : 'erişilemez'}</li>
            <li>
              Son başarılı tarama:{' '}
              {health.data.scans.lastSuccessAt ? formatRelative(health.data.scans.lastSuccessAt) : 'henüz başarılı tarama yok'}
            </li>
            <li>
              Tarama kaydı: {formatNumber(health.data.scans.totalRuns)} (başarısız {formatNumber(health.data.scans.failedRuns)})
            </li>
            <li>
              Çalışan worker: {formatNumber(health.data.workers.running)} / {formatNumber(health.data.workers.total)} (bayat:{' '}
              {formatNumber(health.data.workers.stale)})
            </li>
            <li>
              Kuyruk: {health.data.queue.backend} — bekleyen {formatNumber(health.data.queue.pending)}, aktif{' '}
              {formatNumber(health.data.queue.active)}, ölü {formatNumber(health.data.queue.dead)}
            </li>
            <li>
              Kaynaklar: {formatNumber(health.data.sources.enabled)} etkin / {formatNumber(health.data.sources.total)} kayıtlı
              (doğrulanmış {formatNumber(health.data.sources.verified)}, üst üste başarısız {formatNumber(health.data.sources.failing)})
            </li>
            <li className="text-slate-600 dark:text-slate-300">
              Ayrıntılı kapsam ve boşluklar için <Link to="/kaynaklar">Kaynaklar</Link> sayfasına bakın.
            </li>
          </ul>
        )}
      </Card>

      <InfoNote>
        Bu sistem Türkiye'deki tüm kamu ilanlarını yakaladığını iddia etmez: yalnızca envanterde kayıtlı kaynaklar taranır,
        henüz entegre edilmemiş kurum sayfaları kaynak listesinde açıkça belirtilir.
      </InfoNote>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="card">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}
