/**
 * Yönetim paneli (RBAC: yalnızca admin).
 *
 * Bölümler: genel bakış, kaynaklar (sağlık + manuel tarama), tarama geçmişi,
 * inceleme kuyruğu (sınıflandırma/tekilleştirme), e-posta kuyruğu, kuyruk &
 * kilitler, kapsam raporu, denetim kaydı.
 *
 * Kural: Panelde hiçbir sayı uydurulmaz; her değer API'den gelir. E-postalar
 * maskeli gösterilir; kullanıcı verisine erişim denetim kaydına yazılır.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import { Icon } from '../components/Icon';
import {
  RUN_STATUS_LABELS,
  SOURCE_STATUS_LABELS,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
} from '../lib/format';
import type {
  AdminOverview,
  CoverageReport,
  HealthResponse,
  OutboxItem,
  QueueResponse,
  ReviewItem,
  ScrapeRunSummary,
  SourceCoverageEntry,
} from '../types';
import { Badge, Card, DataTable, ErrorNotice, Field, InfoNote, Spinner, Tabs, Tag } from '../components/ui';

type Tab = 'ozet' | 'kaynaklar' | 'taramalar' | 'inceleme' | 'eposta' | 'kuyruk' | 'kapsam' | 'kullanicilar' | 'denetim';

const TABS: { id: Tab; label: string }[] = [
  { id: 'ozet', label: 'Genel bakış' },
  { id: 'kaynaklar', label: 'Kaynaklar' },
  { id: 'taramalar', label: 'Tarama geçmişi' },
  { id: 'inceleme', label: 'İnceleme kuyruğu' },
  { id: 'eposta', label: 'E-posta kuyruğu' },
  { id: 'kuyruk', label: 'Kuyruk & kilitler' },
  { id: 'kapsam', label: 'Kapsam raporu' },
  { id: 'kullanicilar', label: 'Kullanıcılar' },
  { id: 'denetim', label: 'Denetim kaydı' },
];

export function AdminPage(): ReactNode {
  const [tab, setTab] = useState<Tab>('ozet');
  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: () => api.get<AdminOverview>('/api/admin/overview'), retry: 0 });

  if (overview.isError) {
    return (
      <Card title="Yetki gerekli">
        <ErrorNotice message={errorMessage(overview.error)} />
        <p className="mt-2 text-sm">Bu bölüm yalnızca yönetici hesaplarına açıktır.</p>
      </Card>
    );
  }

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-text">
          <span className="kicker">Yönetim</span>
          <h1 className="page-title">Yönetim paneli</h1>
          <p className="info-lede">
            Kaynak sağlığı, tarama kayıtları, inceleme kuyruğu, e-posta hattı ve kullanıcılar. Her işlem denetim
            kaydına yazılır; e-posta adresleri panelde maskeli gösterilir.
          </p>
        </div>
      </header>

      <Tabs tabs={TABS} current={tab} onSelect={(id) => setTab(id as Tab)} label="Yönetim bölümleri" />

      {overview.isLoading && <Spinner label="Panel yükleniyor…" />}
      {overview.data && tab === 'ozet' && <OverviewTab data={overview.data} />}
      {tab === 'kaynaklar' && <SourcesTab />}
      {tab === 'taramalar' && <RunsTab />}
      {tab === 'inceleme' && <ReviewTab />}
      {tab === 'eposta' && <OutboxTab />}
      {tab === 'kuyruk' && <QueueTab />}
      {tab === 'kapsam' && <CoverageTab />}
      {tab === 'kullanicilar' && <UsersTab />}
      {tab === 'denetim' && <AuditTab />}
    </div>
  );
}

function OverviewTab({ data }: { data: AdminOverview }): ReactNode {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<HealthResponse>('/api/health') });
  return (
    <div className="page-stack">
      {data.workerWarning && <InfoNote tone="warning">{data.workerWarning}</InfoNote>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="İlan (kabul)" value={formatNumber(data.jobs.total)} />
        <Metric label="Başvuruya açık" value={formatNumber(data.jobs.active)} />
        <Metric label="Bugün eklenen" value={formatNumber(data.jobs.addedToday)} />
        <Metric label="İnceleme kuyruğu" value={formatNumber(data.reviewQueue.total)} />
        <Metric label="Tarama kaydı" value={formatNumber(data.runs.total)} />
        <Metric label="Başarısız tarama" value={formatNumber(data.runs.failed)} />
        <Metric label="Ortalama süre" value={formatDuration(data.runs.avgDurationMs)} />
        <Metric label="Denetim kaydı" value={formatNumber(data.auditEntries)} />
      </div>

      <Card title="Worker kalp atışları" description="Bayat kalp atışı, zamanlanmış taramanın durduğunu gösterir.">
        {data.workers.length === 0 ? (
          <InfoNote tone="warning">
            Kayıtlı worker yok. Zamanlanmış tarama ve e-posta gönderimi çalışmıyor demektir: <code>npm run dev:worker</code>{' '}
            (üretimde ayrı servis) çalıştırılmalı.
          </InfoNote>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.workers.map((worker) => (
              <li key={worker.workerId} className="flex flex-wrap items-center gap-2">
                <Badge tone={worker.stale ? 'danger' : 'success'}>{worker.stale ? 'bayat' : 'çalışıyor'}</Badge>
                <span className="font-medium">{worker.workerId}</span>
                <span className="text-slate-600 dark:text-slate-300">
                  rol: {worker.role} · son atış: {formatRelative(worker.lastHeartbeatAt)} · işlenen iş: {formatNumber(worker.processedJobs)}
                </span>
                {worker.lastError && <span className="text-danger-sm">son hata: {worker.lastError}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Kuyruk ve e-posta" description="Durum modeli: pending → sending → accepted | failed → dead">
        <ul className="space-y-1 text-sm">
          <li>
            Kuyruk arka ucu: {data.queue.backend} · bekleyen {formatNumber(data.queue.counts.pending ?? 0)} · aktif{' '}
            {formatNumber(data.queue.counts.active ?? 0)} · ölü {formatNumber(data.queue.dead)}
          </li>
          <li>
            E-posta: bekleyen {formatNumber(data.outbox.pending ?? 0)} · gönderiliyor {formatNumber(data.outbox.sending ?? 0)} · kabul
            edilen {formatNumber(data.outbox.accepted ?? 0)} · başarısız {formatNumber(data.outbox.failed ?? 0)} · ölü{' '}
            {formatNumber(data.outbox.dead ?? 0)}
          </li>
          <li>
            Kaynaklar: {formatNumber(data.coverage.summary.enabled)} etkin · doğrulanmış {formatNumber(data.coverage.summary.verified)} · üst
            üste başarısız {formatNumber(data.coverage.summary.failing)} · planlanan {formatNumber(data.coverage.summary.planned)}
          </li>
          {health.data && (
            <li>
              Son başarılı tarama:{' '}
              {health.data.scans.lastSuccessAt ? formatRelative(health.data.scans.lastSuccessAt) : 'henüz yok'} · veritabanı:{' '}
              {health.data.database.driver} ({health.data.database.latencyMs ?? '—'} ms)
            </li>
          )}
        </ul>
      </Card>
    </div>
  );
}

function SourcesTab(): ReactNode {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sources = useQuery({
    queryKey: ['admin-sources'],
    queryFn: () => api.get<{ sources: SourceCoverageEntry[] }>('/api/admin/sources'),
  });

  const scan = useMutation({
    mutationFn: (key: string) => api.post<{ note: string; dedupeKey: string }>(`/api/admin/sources/${encodeURIComponent(key)}/run`),
    onSuccess: (data) => {
      setMessage(`${data.note} (${data.dedupeKey})`);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-sources'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const scanAll = useMutation({
    mutationFn: () => api.post<{ requested: number }>('/api/admin/sources/run-all'),
    onSuccess: (data) => {
      setMessage(`${data.requested} kaynak tarama için kuyruğa alındı.`);
      setError(null);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const maintenance = useMutation({
    mutationFn: (kind: 'deadline-refresh' | 'coverage-audit') => api.post<{ note: string }>(`/api/admin/maintenance/${kind}`),
    onSuccess: (data) => setMessage(data.note),
    onError: (caught) => setError(errorMessage(caught)),
  });

  const toggle = useMutation({
    mutationFn: (payload: { key: string; enabled: boolean }) =>
      api.patch(`/api/admin/sources/${encodeURIComponent(payload.key)}`, { enabled: payload.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-sources'] }),
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <div className="page-stack">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={() => scanAll.mutate()} disabled={scanAll.isPending}>
          Tüm etkin kaynakları tara
        </button>
        <button type="button" className="btn-secondary" onClick={() => maintenance.mutate('deadline-refresh')}>
          Süresi dolan ilanları güncelle
        </button>
        <button type="button" className="btn-secondary" onClick={() => maintenance.mutate('coverage-audit')}>
          Kapsam denetimi çalıştır
        </button>
      </div>
      {message && <InfoNote>{message}</InfoNote>}
      {error && <ErrorNotice message={error} />}

      {sources.data?.sources.map((source) => (
        <Card key={source.key} title={source.name} description={source.statusNote}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={source.verified ? 'success' : source.enabled ? 'warning' : 'neutral'}>
              {SOURCE_STATUS_LABELS[source.status] ?? source.status}
            </Badge>
            <span>aralık: {source.intervalMinutes} dk</span>
            <span>son başarılı: {source.health.lastSuccessAt ? formatRelative(source.health.lastSuccessAt) : 'yok'}</span>
            <span>üst üste hata: {source.health.consecutiveFailures}</span>
            <span>ortalama süre: {formatDuration(source.health.avgDurationMs)}</span>
            <span>başarı oranı: {source.health.totalRuns > 0 ? `${Math.round((source.health.successRuns / source.health.totalRuns) * 100)}%` : 'veri yok'}</span>
          </div>
          <p className="text-muted-sm mt-2">{source.coverageNote}</p>
          {source.health.lastError && <p className="text-danger-sm">Son hata: {source.health.lastError}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => scan.mutate(source.key)} disabled={scan.isPending || !source.enabled}>
              Şimdi tara
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => toggle.mutate({ key: source.key, enabled: !source.enabled })}
              disabled={toggle.isPending}
            >
              {source.enabled ? 'Devre dışı bırak' : 'Etkinleştir'}
            </button>
            <a className="btn-ghost" href={`/api/sources/${encodeURIComponent(source.key)}/status`} target="_blank" rel="noreferrer noopener">
              Durum JSON
            </a>
          </div>
        </Card>
      ))}
    </div>
  );
}

function RunsTab(): ReactNode {
  const [sourceKey, setSourceKey] = useState('');
  const query = useQuery({
    queryKey: ['admin-runs', sourceKey],
    queryFn: () => api.get<{ runs: ScrapeRunSummary[]; failing: { id: string; sourceKey: string; startedAt: string; result: string; errors: string[] }[] }>(
      '/api/admin/scrape-runs',
      { limit: 50, ...(sourceKey ? { sourceKey } : {}) },
    ),
  });

  return (
    <div className="page-stack">
      <label className="input-narrow">
        <span className="label">Kaynağa göre filtrele</span>
        <input className="input" value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} placeholder="ör. resmigazete-cestili-ilanlar" />
      </label>
      {query.isLoading && <Spinner />}
      {query.data?.failing.length ? (
        <Card title="Hata bildirimleri" description="HTML değişikliği veya erişim sorunu burada görünür.">
          <ul className="space-y-2 text-sm">
            {query.data.failing.map((run) => (
              <li key={run.id} className="text-danger-sm">
                <p className="font-medium">{run.id}</p>
                <p className="text-xs">
                  {formatDateTime(run.startedAt)} · {run.result}
                </p>
                {run.errors.length > 0 && <p className="text-xs">{run.errors.join(' | ')}</p>}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Tarama kayıtları">
        <div className="modern-table-card">
          <table className="modern-data-table">
            <caption className="sr-only">Tarama kayıtları</caption>
            <thead>
              <tr className="table-head-label">
                <th scope="col" className="py-2 pr-3">Zaman</th>
                <th scope="col" className="py-2 pr-3">Kaynak</th>
                <th scope="col" className="py-2 pr-3">Durum</th>
                <th scope="col" className="py-2 pr-3">Bulunan</th>
                <th scope="col" className="py-2 pr-3">Yeni/Güncelleme</th>
                <th scope="col" className="py-2 pr-3">Gecikme</th>
                <th scope="col" className="py-2">Not</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.runs.map((run) => (
                <tr key={run.id} className="border-t border-slate-200 align-top dark:border-slate-800">
                  <td className="py-2 pr-3">{formatDateTime(run.startedAt)}</td>
                  <td className="py-2 pr-3">{run.sourceKey}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={run.status === 'success' ? 'success' : run.status === 'partial' ? 'warning' : run.status === 'failed' ? 'danger' : 'neutral'}>
                      {RUN_STATUS_LABELS[run.status] ?? run.status}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3">
                    {run.itemsFound} ({run.itemsAccepted} kabul / {run.itemsRejected} ret / {run.itemsReview} inceleme)
                  </td>
                  <td className="py-2 pr-3">
                    {run.jobsCreated} yeni / {run.jobsUpdated} güncelleme / {run.revisionsCreated} revizyon
                  </td>
                  <td className="py-2 pr-3">{run.scheduleDelayMs !== null ? formatDuration(run.scheduleDelayMs) : '—'}</td>
                  <td className="py-2 text-xs">
                    {run.result}
                    {run.errors.length > 0 && <p className="text-danger-sm">{run.errors.join(' | ')}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ReviewTab(): ReactNode {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'' | 'classification' | 'dedupe' | 'extraction'>('');
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['admin-review', kind],
    queryFn: () =>
      api.get<{ items: ReviewItem[]; counts: { total: number; classification: number; dedupe: number; extraction: number }; candidateTitles: Record<string, string> }>(
        '/api/admin/review-queue',
        { status: 'open', ...(kind ? { kind } : {}) },
      ),
  });

  const decide = useMutation({
    mutationFn: (payload: { id: string; action: 'accept' | 'reject' | 'merge' | 'keep-separate' | 'ignore' }) =>
      api.post<{ message: string }>(`/api/admin/review-queue/${payload.id}/resolve`, { action: payload.action, note: '' }),
    onSuccess: (data) => {
      setMessage(data.message);
      void queryClient.invalidateQueries({ queryKey: ['admin-review'] });
    },
  });

  return (
    <div className="page-stack">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">
          <span className="label">Tür</span>
          <select className="input" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="">Tümü</option>
            <option value="classification">Sınıflandırma</option>
            <option value="dedupe">Tekilleştirme</option>
            <option value="extraction">Çıkarım</option>
          </select>
        </label>
        {query.data && (
          <p className="text-muted-sm">
            Açık kayıt: {formatNumber(query.data.counts.total)} (sınıflandırma {query.data.counts.classification}, tekilleştirme{' '}
            {query.data.counts.dedupe}, çıkarım {query.data.counts.extraction})
          </p>
        )}
      </div>
      {message && <InfoNote>{message}</InfoNote>}
      {query.isLoading && <Spinner />}
      {query.data?.items.length === 0 && <InfoNote>İnceleme bekleyen kayıt yok.</InfoNote>}

      {query.data?.items.map((item) => (
        <Card key={item.id} title={item.title} description={`${item.kind} · güven ${Math.round(item.confidence * 100)}%`}>
          <p className="text-sm">{item.reason}</p>
          <p className="text-muted-sm mt-1">
            <a href={item.url} target="_blank" rel="noreferrer noopener" className="break-all">
              {item.url}
            </a>
          </p>
          {item.candidateJobIds.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {item.candidateJobIds.map((id) => (
                <li key={id}>
                  Aday ilan: <a href={`/ilanlar/${id}`}>{query.data?.candidateTitles[id] ?? id}</a>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {item.kind === 'dedupe' && item.candidateJobIds.length >= 2 && (
              <button type="button" className="btn-secondary" onClick={() => decide.mutate({ id: item.id, action: 'merge' })}>
                Aynı ilan — birleştir
              </button>
            )}
            {item.kind === 'dedupe' && (
              <button type="button" className="btn-secondary" onClick={() => decide.mutate({ id: item.id, action: 'keep-separate' })}>
                Farklı ilan — ayrı bırak
              </button>
            )}
            {item.kind === 'classification' && (
              <>
                <button type="button" className="btn-secondary" onClick={() => decide.mutate({ id: item.id, action: 'accept' })}>
                  İlanı kabul et
                </button>
                <button type="button" className="btn-secondary" onClick={() => decide.mutate({ id: item.id, action: 'reject' })}>
                  İlan değil
                </button>
              </>
            )}
            <button type="button" className="btn-ghost" onClick={() => decide.mutate({ id: item.id, action: 'ignore' })}>
              Yok say
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function OutboxTab(): ReactNode {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const query = useQuery({
    queryKey: ['admin-outbox', status],
    queryFn: () =>
      api.get<{ items: OutboxItem[]; stats: Record<string, number>; notice: string; schema: string }>('/api/admin/email-outbox', {
        limit: 50,
        ...(status ? { status } : {}),
      }),
  });

  const requeue = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/email-outbox/${id}/requeue`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-outbox'] }),
  });

  return (
    <div className="page-stack">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">
          <span className="label">Durum</span>
          <select className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Tümü</option>
            <option value="pending">Bekleyen</option>
            <option value="sending">Gönderiliyor</option>
            <option value="accepted">Kabul edilen</option>
            <option value="failed">Başarısız (yeniden denenecek)</option>
            <option value="dead">Ölü (denemeler tükendi)</option>
            <option value="suppressed">Durdurulan</option>
          </select>
        </label>
        {query.data && (
          <p className="text-muted-sm">
            {Object.entries(query.data.stats)
              .map(([key, value]) => `${key}: ${value}`)
              .join(' · ')}
          </p>
        )}
      </div>
      {query.data?.notice && <InfoNote>{query.data.notice}</InfoNote>}
      {query.isLoading && <Spinner />}
      <Card title="E-posta kuyruğu" description={query.data?.schema}>
        <div className="modern-table-card">
          <table className="modern-data-table">
            <caption className="sr-only">E-posta kuyruğu kayıtları</caption>
            <thead>
              <tr className="table-head-label">
                <th scope="col" className="py-2 pr-3">Oluşturma</th>
                <th scope="col" className="py-2 pr-3">Alıcı</th>
                <th scope="col" className="py-2 pr-3">Konu</th>
                <th scope="col" className="py-2 pr-3">Durum</th>
                <th scope="col" className="py-2 pr-3">Deneme</th>
                <th scope="col" className="py-2">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.items.map((item) => (
                <tr key={item.id} className="border-t border-slate-200 align-top dark:border-slate-800">
                  <td className="py-2 pr-3">{formatDateTime(item.createdAt)}</td>
                  <td className="py-2 pr-3">{item.to}</td>
                  <td className="py-2 pr-3">{item.subject}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={item.status === 'accepted' ? 'success' : item.status === 'dead' ? 'danger' : item.status === 'failed' ? 'warning' : 'neutral'}>
                      {item.status}
                    </Badge>
                    {item.lastError && <p className="text-danger-sm">{item.lastError}</p>}
                  </td>
                  <td className="py-2 pr-3">
                    {item.attempts}/{item.maxAttempts}
                  </td>
                  <td className="py-2">
                    {item.status === 'dead' && (
                      <button type="button" className="btn-secondary" onClick={() => requeue.mutate(item.id)}>
                        Yeniden dene
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function QueueTab(): ReactNode {
  const query = useQuery({ queryKey: ['admin-queue'], queryFn: () => api.get<QueueResponse>('/api/admin/queue'), refetchInterval: 30_000 });

  return (
    <div className="page-stack">
      {query.data?.scheduleLagWarning && <InfoNote tone="warning">{query.data.scheduleLagWarning}</InfoNote>}
      {query.isLoading && <Spinner />}
      {query.data && (
        <>
          <Card title="Zamanlanmış görevler" description="Her kaynak için planlanan sonraki çalışma; gecikme = worker'ın geride kaldığı süre.">
            <div className="modern-table-card">
              <table className="modern-data-table">
                <caption className="sr-only">Zamanlanmış görevler</caption>
                <thead>
                  <tr className="table-head-label">
                    <th scope="col" className="py-2 pr-3">Kaynak</th>
                    <th scope="col" className="py-2 pr-3">Aralık</th>
                    <th scope="col" className="py-2 pr-3">Sıradaki</th>
                    <th scope="col" className="py-2 pr-3">Gecikme</th>
                    <th scope="col" className="py-2">Kaçırılan</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.tasks.map((task) => (
                    <tr key={task.id} className="border-t border-slate-200 dark:border-slate-800">
                      <td className="py-2 pr-3">
                        {task.sourceKey} <span className="text-muted-sm">({task.kind})</span>
                      </td>
                      <td className="py-2 pr-3">{task.intervalMinutes} dk</td>
                      <td className="py-2 pr-3">{formatDateTime(task.nextRunAt)}</td>
                      <td className="py-2 pr-3">{task.overdueMinutes > 0 ? `${task.overdueMinutes} dk gecikme` : 'zamanında'}</td>
                      <td className="py-2">{task.misses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Ölü işler" description="Yeniden denenebilir; hata nedeni kayıpta saklanır.">
            {query.data.dead.length === 0 ? (
              <p className="text-sm">Ölü iş yok.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {query.data.dead.map((job) => (
                  <li key={job.id}>
                    {job.queue}/{job.name} · {job.attempts} deneme · {job.lastError ?? 'hata yok'}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Kilitler" description="Aynı kaynağın iki kez taranmasını engelleyen kilitler.">
            {query.data.locks.length === 0 ? (
              <p className="text-sm">Aktif kilit yok.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {query.data.locks.map((lock) => (
                  <li key={lock.key}>
                    {lock.key} · sahip {lock.owner} · {lock.expired ? 'süresi geçmiş' : `bitiş ${formatDateTime(lock.expiresAt)}`}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function CoverageTab(): ReactNode {
  const query = useQuery({ queryKey: ['admin-coverage'], queryFn: () => api.get<CoverageReport>('/api/admin/coverage-report') });
  if (query.isLoading) return <Spinner />;
  if (!query.data) return <ErrorNotice message="Kapsam raporu alınamadı." onRetry={() => void query.refetch()} />;
  return (
    <div className="page-stack">
      <InfoNote tone="warning">{query.data.disclaimer}</InfoNote>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Toplam kaynak" value={formatNumber(query.data.total)} />
        <Metric label="Etkin" value={formatNumber(query.data.enabled)} />
        <Metric label="Doğrulanmış" value={formatNumber(query.data.verified)} />
        <Metric label="Planlanan" value={formatNumber(query.data.planned)} />
      </div>
      <Card title="Gruplara göre kapsam">
        <ul className="text-sm">
          {query.data.byGroup.map((entry) => (
            <li key={entry.group}>
              {entry.group}: {entry.count}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Bilinen boşluklar" description="Etkin ama doğrulanmamış ya da üst üste başarısız kaynaklar.">
        {query.data.gaps.length === 0 ? (
          <p className="text-sm">Boşluk yok.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {query.data.gaps.map((gap) => (
              <li key={gap.key}>
                <span className="font-medium">{gap.key}</span>: {gap.reason}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {query.data.unknownRegistryAdapters.length > 0 && (
        <Card title="Envanterde olmayan adaptör kaynakları">
          <ul className="text-sm">
            {query.data.unknownRegistryAdapters.map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Kapsamı genişletme" description="Yeni kaynak ekleme adımları: docs/source-onboarding.md">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Kaynağın liste adresini ve yöntemini doğrula (canlı test).</li>
          <li>Uygun adaptörü seç, gerekirse yaz; `src/sources/registry.ts` içine kaydet.</li>
          <li>Kaynak kaydını doğrulama kanıtıyla birlikte envantere ekle.</li>
          <li>Fixture testi yaz ve `npm run test:live` ile canlı doğrula.</li>
        </ol>
      </Card>
    </div>
  );
}

function AuditTab(): ReactNode {
  const [action, setAction] = useState('');
  const query = useQuery({
    queryKey: ['admin-audit', action],
    queryFn: () =>
      api.get<{ logs: { id: string; action: string; actorUserId: string | null; actorRole: string | null; targetType: string; targetId: string | null; createdAt: string; ipHash: string | null; meta: Record<string, unknown> }[] }>(
        '/api/admin/audit-logs',
        { limit: 100, ...(action ? { action } : {}) },
      ),
  });

  return (
    <div className="page-stack">
      <label className="input-narrow">
        <span className="label">İşlem filtresi</span>
        <input className="input" value={action} onChange={(event) => setAction(event.target.value)} placeholder="ör. admin.source-scan-requested" />
      </label>
      {query.isLoading && <Spinner />}
      <Card title="Denetim kaydı" description="Yönetici işlemleri ve güvenlik olayları; IP adresi hash olarak saklanır.">
        <ul className="space-y-1 text-sm">
          {query.data?.logs.map((log) => (
            <li key={log.id} className="border-b border-slate-100 py-1 last:border-0 dark:border-slate-800">
              <p>
                <span className="font-medium">{log.action}</span> · {formatDateTime(log.createdAt)} · {log.targetType}
                {log.targetId ? `/${log.targetId}` : ''} · rol: {log.actorRole ?? 'anonim'}
              </p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}


type AdminUserRow = {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  status: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  notificationsEnabled: boolean;
  notificationMode: string | null;
};

/**
 * Kullanıcılar: Kamuİlan'da dışarıdan kayıt YOKTUR. Hesap yalnızca buradan
 * açılır; kullanıcı tek kullanımlık bağlantıyla kendi parolasını belirler.
 * Yönetici paneli e-posta adreslerini maskeli gösterir (KVKK).
 */
function UsersTab(): ReactNode {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () =>
      api.get<{ users: AdminUserRow[]; notifiableCount: number; notice: string }>('/api/admin/users', { limit: 100 }),
  });

  const invite = useMutation({
    mutationFn: () =>
      api.post<{ message: string }>('/api/admin/users', {
        email,
        displayName: displayName.trim() || undefined,
        role,
      }),
    onSuccess: (data) => {
      setMessage(data.message);
      setError(null);
      setEmail('');
      setDisplayName('');
      setRole('user');
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (caught) => {
      setError(errorMessage(caught));
      setMessage(null);
    },
  });

  return (
    <div className="admin-section">
      <InfoNote tone="info" title="Halka açık kayıt yoktur">
        Kamuİlan'da kullanıcılar kendi kendine kayıt olamaz. Hesap buradan açılır; davet e-postasındaki bağlantı 72
        saat geçerlidir ve parolayı yalnızca kullanıcı belirler. Sistem düz metin parola üretmez ve göndermez.
      </InfoNote>

      <Card title="Yeni kullanıcı davet et" description="Hesap açılır ve tek kullanımlık şifre belirleme bağlantısı gönderilir.">
        <form
          className="filter-grid"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate();
          }}
        >
          <Field label="E-posta" htmlFor="invite-email" required>
            <input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ad.soyad@ornek.gov.tr"
            />
          </Field>
          <Field label="Görünen ad" htmlFor="invite-name" hint="Boş bırakılırsa e-posta kökü kullanılır.">
            <input id="invite-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Field label="Rol" htmlFor="invite-role" hint="Yönetici rolü tüm panele erişir.">
            <select
              id="invite-role"
              className="filter-select"
              value={role}
              onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'user')}
            >
              <option value="user">Kullanıcı</option>
              <option value="admin">Yönetici</option>
            </select>
          </Field>
        </form>
        <div className="filter-actions">
          <button type="button" className="btn-primary" disabled={invite.isPending || email.length < 5} onClick={() => invite.mutate()}>
            <Icon name="send" size={15} />
            <span>{invite.isPending ? 'Davet gönderiliyor…' : 'Davet gönder'}</span>
          </button>
        </div>
        {message && <InfoNote tone="success">{message}</InfoNote>}
        {error && <ErrorNotice message={error} />}
      </Card>

      <Card
        title="Kullanıcılar"
        description={users.data ? `Bildirim alan kullanıcı: ${formatNumber(users.data.notifiableCount)}` : undefined}
      >
        {users.isLoading && <Spinner label="Kullanıcılar yükleniyor…" />}
        {users.isError && <ErrorNotice message={errorMessage(users.error)} onRetry={() => void users.refetch()} />}
        {users.data && (
          <DataTable caption="Kullanıcı listesi" head={['Kullanıcı', 'Rol', 'Durum', 'Bildirim', 'Son giriş', 'Kayıt']}>
            {users.data.users.map((user) => (
              <tr key={user.id}>
                <td data-label="Kullanıcı">
                  <span className="cell-title">{user.displayName ?? '—'}</span>
                  <span className="cell-mono">{user.email}</span>
                </td>
                <td data-label="Rol">
                  <Tag tone={user.role === 'admin' ? 'accent' : 'neutral'}>
                    {user.role === 'admin' ? 'yönetici' : 'kullanıcı'}
                  </Tag>
                </td>
                <td data-label="Durum">
                  <Tag tone={user.emailVerified ? 'success' : 'warning'}>
                    {user.emailVerified ? 'doğrulanmış' : 'doğrulanmamış'}
                  </Tag>
                  <span className="cell-subtitle">{user.status}</span>
                </td>
                <td data-label="Bildirim">
                  {user.notificationsEnabled ? (
                    <span>
                      açık <span className="cell-subtitle">{user.notificationMode ?? 'instant'}</span>
                    </span>
                  ) : (
                    <span className="cell-subtitle">kapalı / duraklatıldı</span>
                  )}
                </td>
                <td data-label="Son giriş">
                  <span className="cell-subtitle">
                    {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'hiç giriş yapmadı'}
                  </span>
                </td>
                <td data-label="Kayıt">
                  <span className="cell-subtitle">{formatDateTime(user.createdAt)}</span>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {users.data && <p className="text-muted-sm mt-2">{users.data.notice}</p>}
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="card-elevated">
      <p className="table-head-label">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
