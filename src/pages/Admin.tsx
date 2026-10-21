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
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { HEALTH_QUERY_KEY } from '../lib/query-keys';
import { Icon } from '../components/Icon';
import {
  RUN_STATUS_LABELS,
  describeWorkerState,
  sortWorkersByRecency,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  sourceStatusLabel,
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

type Tab =
  | 'ozet'
  | 'kaynaklar'
  | 'taramalar'
  | 'inceleme'
  | 'eposta'
  | 'kuyruk'
  | 'kapsam'
  | 'kullanicilar'
  | 'denetim';

/** İnceleme nedenleri günlük dille görünür. */
const REVIEW_KIND_LABELS: Record<string, string> = {
  classification: 'ilgililik',
  dedupe: 'aynı ilan olabilir',
  extraction: 'bilgi okunamadı',
};

const LLM_OPINION_LABELS: Record<string, string> = {
  ilan: 'personel alımı olabilir (kanıt doğrulanamadı)',
  surec: 'süreç duyurusu olabilir',
  'ilan-degil': 'ilan değil (kanıt doğrulanamadı)',
  belirsiz: 'model de kararsız',
  dogrulanamadi: 'model çıktısı doğrulanamadı',
  hata: 'model denetimine ulaşılamadı',
};

interface ReviewLlmOpinion {
  verdict: string;
  contentType: string | null;
  summary: string | null;
  reasons: string[];
  model: string;
  cacheHit: boolean;
}

/** İnceleme kaydı payload'ındaki LLM ön görüşünü güvenle okur (yoksa null). */
function llmOpinionOf(item: ReviewItem): ReviewLlmOpinion | null {
  const raw = item.payload?.llmOpinion;
  if (!raw || typeof raw !== 'object') return null;
  const opinion = raw as Partial<ReviewLlmOpinion>;
  if (typeof opinion.verdict !== 'string') return null;
  return {
    verdict: opinion.verdict,
    contentType: typeof opinion.contentType === 'string' ? opinion.contentType : null,
    summary: typeof opinion.summary === 'string' ? opinion.summary : null,
    reasons: Array.isArray(opinion.reasons) ? opinion.reasons.filter((r): r is string => typeof r === 'string') : [],
    model: typeof opinion.model === 'string' ? opinion.model : 'bilinmeyen model',
    cacheHit: Boolean(opinion.cacheHit),
  };
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'ozet', label: 'Genel bakış' },
  { id: 'kaynaklar', label: 'Kaynaklar' },
  { id: 'taramalar', label: 'Tarama geçmişi' },
  { id: 'inceleme', label: 'İncelenecek ilanlar' },
  { id: 'eposta', label: 'E-posta gönderimi' },
  { id: 'kuyruk', label: 'İş sırası' },
  { id: 'kapsam', label: 'Kapsam durumu' },
  { id: 'kullanicilar', label: 'Kullanıcılar' },
  { id: 'denetim', label: 'İşlem geçmişi' },
];

export function AdminPage(): ReactNode {
  const [tab, setTab] = useState<Tab>('ozet');
  const overview = useQuery({
    queryKey: ['admin-overview'],
    queryFn: ({ signal }) => api.get<AdminOverview>('/api/admin/overview', undefined, signal),
    retry: 0,
  });

  if (overview.isError) {
    return (
      <Card title="Yönetim paneli alınamadı">
        <ErrorNotice message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} />
        <p className="body-copy push">Yönetici yetkinizi ve API bağlantısını kontrol edip yeniden deneyin.</p>
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
            Kaynak sağlığı, tarama kayıtları, inceleme kuyruğu, e-posta hattı ve kullanıcılar. Her işlem
            denetim kaydına yazılır; e-posta adresleri panelde maskeli gösterilir.
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
  const health = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: ({ signal }) => api.get<HealthResponse>('/api/health', undefined, signal),
  });
  return (
    <div className="page-stack">
      {data.workerWarning && <InfoNote tone="warning">{data.workerWarning}</InfoNote>}
      <div className="metric-grid">
        <Metric label="İlan (kabul)" value={formatNumber(data.jobs.total)} />
        <Metric label="Başvuruya açık" value={formatNumber(data.jobs.active)} />
        <Metric label="Bugün eklenen" value={formatNumber(data.jobs.addedToday)} />
        <Metric label="İncelenecek ilanlar" value={formatNumber(data.reviewQueue.total)} />
        <Metric label="Tarama kaydı" value={formatNumber(data.runs.total)} />
        <Metric
          label="Başarısız tarama"
          value={`${formatNumber(data.runs.failed)} · kısmi ${formatNumber(data.runs.partial ?? 0)}`}
        />
        <Metric label="Ortalama süre" value={formatDuration(data.runs.avgDurationMs)} />
        <Metric label="İşlem geçmişi" value={formatNumber(data.auditEntries)} />
      </div>

      <Card
        title="Otomatik kontrol durumu"
        description="Uzun süredir haber alınamıyorsa otomatik kontroller durmuş demektir."
      >
        {data.workers.length === 0 ? (
          <InfoNote tone="warning">
            Kayıtlı worker yok. Zamanlanmış tarama ve e-posta gönderimi çalışmıyor demektir:{' '}
            <code>npm run dev:worker</code> (üretimde ayrı servis) çalıştırılmalı.
          </InfoNote>
        ) : (
          (() => {
            // Üç durum: bayat / çalışıyor / durdu. `stale` yalnızca "durduğunu
            // bildirmediği hâlde sessiz" süreçlerde true olur; iki duruma
            // indirgenirse 47 saat önce kapanmış süreç "çalışıyor" görünür.
            const { visible, hidden } = sortWorkersByRecency(data.workers);
            return (
              <>
                <ul className="summary-list">
                  {visible.map((worker) => {
                    const state = describeWorkerState(worker.status, worker.stale);
                    return (
                      <li key={worker.workerId} className="meta-row">
                        <Badge tone={state.tone}>{state.label}</Badge>
                        <span className="strong">{worker.workerId}</span>
                        <span className="text-muted">
                          rol: {worker.role} · son atış: {formatRelative(worker.lastHeartbeatAt)} · işlenen iş:{' '}
                          {formatNumber(worker.processedJobs)}
                        </span>
                        {worker.lastError && <span className="text-danger-sm">son hata: {worker.lastError}</span>}
                      </li>
                    );
                  })}
                </ul>
                {hidden > 0 && (
                  <p className="text-muted">
                    Ayrıca {formatNumber(hidden)} eski worker kaydı var (hepsi durmuş ya da bayat); yalnızca en yeni{' '}
                    {visible.length} satır gösteriliyor.
                  </p>
                )}
              </>
            );
          })()
        )}
      </Card>

      <Card
        title="Bekleyen işler ve e-postalar"
        description="Bekleyen, gönderilen ve ulaşmayan e-postalar burada izlenir."
      >
        <ul className="compact-list">
          <li>
            Kuyruk arka ucu: {data.queue.backend} · bekleyen {formatNumber(data.queue.counts.pending ?? 0)} ·
            aktif {formatNumber(data.queue.counts.active ?? 0)} · ölü {formatNumber(data.queue.dead)}
          </li>
          <li>
            E-posta: bekleyen {formatNumber(data.outbox.pending ?? 0)} · gönderiliyor{' '}
            {formatNumber(data.outbox.sending ?? 0)} · kabul edilen {formatNumber(data.outbox.accepted ?? 0)}{' '}
            · başarısız {formatNumber(data.outbox.failed ?? 0)} · ölü {formatNumber(data.outbox.dead ?? 0)}
          </li>
          <li>
            Kaynaklar: {formatNumber(data.coverage.summary.enabled)} etkin · doğrulanmış{' '}
            {formatNumber(data.coverage.summary.verified)} · üst üste başarısız{' '}
            {formatNumber(data.coverage.summary.failing)} · planlanan{' '}
            {formatNumber(data.coverage.summary.planned)}
          </li>
          {health.data && (
            <li>
              Son başarılı tarama:{' '}
              {health.data.scans.lastSuccessAt
                ? formatRelative(health.data.scans.lastSuccessAt)
                : 'henüz yok'}{' '}
              · veritabanı: {health.data.database.driver} ({health.data.database.latencyMs ?? '—'} ms)
            </li>
          )}
        </ul>
      </Card>

      <Card
        title="LLM sınıflandırma kapısı"
        description="Kuralların kararsız kaldığı (incelemedeki) duyurular için ikinci aşama denetimi. Kanıtı doğrulanamayan hiçbir karar yayımlanmaz."
      >
        {data.llm ? (
          data.llm.enabled ? (
            <ul className="compact-list">
              <li>
                Model: {data.llm.model ?? '—'} · istem sürümü: {data.llm.promptVersion} · günlük sınır:{' '}
                {formatNumber(data.llm.dailyCallLimit)} çağrı
              </li>
              <li>
                Son 24 saat: {formatNumber(data.llm.last24h.calls)} çağrı · {formatNumber(data.llm.last24h.cacheHits)}{' '}
                önbellek isabeti · {formatNumber(data.llm.last24h.invalid)} doğrulanamayan ·{' '}
                {formatNumber(data.llm.last24h.errors)} hata · ortalama gecikme{' '}
                {data.llm.last24h.avgLatencyMs !== null ? formatDuration(data.llm.last24h.avgLatencyMs) : '—'}
              </li>
              <li>
                Token (24s): {formatNumber(data.llm.last24h.promptTokens)} girdi +{' '}
                {formatNumber(data.llm.last24h.completionTokens)} çıktı · toplam kayıt:{' '}
                {formatNumber(data.llm.totals.analyses)} ({formatNumber(data.llm.totals.ok)} geçerli)
              </li>
              <li>
                Gecikme yüzdelikleri: p50{' '}
                {data.llm.last24h.latency.p50Ms !== null ? formatDuration(data.llm.last24h.latency.p50Ms) : '—'} · p95{' '}
                {data.llm.last24h.latency.p95Ms !== null ? formatDuration(data.llm.last24h.latency.p95Ms) : '—'} · en
                yüksek{' '}
                {data.llm.last24h.latency.maxMs !== null ? formatDuration(data.llm.last24h.latency.maxMs) : '—'} · hata
                oranı {data.llm.last24h.errorRate === null ? '—' : `%${(data.llm.last24h.errorRate * 100).toFixed(1)}`} ·
                önbellek isabeti{' '}
                {data.llm.last24h.cacheHitRate === null ? '—' : `%${(data.llm.last24h.cacheHitRate * 100).toFixed(0)}`}
              </li>
              <li>
                Maliyet:{' '}
                {data.llm.last24h.cost.usd === null
                  ? 'raporlanmadı'
                  : `~$${data.llm.last24h.cost.usd.toFixed(4)} (TAHMİN)`}{' '}
                <span className="cell-note"> · {data.llm.last24h.cost.note}</span>
              </li>
            </ul>
          ) : (
            <InfoNote tone="info">
              Kapalı: belirsiz kayıtlar yalnızca kurallarla değerlendiriliyor ve inceleme kuyruğunda kalıyor.
              Açmak için sunucuda <code>LLM_CLASSIFIER_ENABLED=1</code> + <code>LLM_BASE_URL</code>,{' '}
              <code>LLM_API_KEY</code>, <code>LLM_CLASSIFIER_MODEL</code> tanımlayın (ayrıntı: docs/llm-karari.md).
            </InfoNote>
          )
        ) : null}
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
    queryFn: ({ signal }) => api.get<{ sources: SourceCoverageEntry[] }>('/api/admin/sources', undefined, signal),
  });

  const scan = useMutation({
    mutationFn: (key: string) =>
      api.post<{ note: string; dedupeKey: string }>(`/api/admin/sources/${encodeURIComponent(key)}/run`),
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
    mutationFn: (kind: 'deadline-refresh' | 'coverage-audit') =>
      api.post<{ note: string }>(`/api/admin/maintenance/${kind}`),
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
      <div className="action-row">
        <button
          type="button"
          className="btn-primary"
          onClick={() => scanAll.mutate()}
          disabled={scanAll.isPending}
        >
          Tüm etkin kaynakları tara
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => maintenance.mutate('deadline-refresh')}
        >
          Süresi dolan ilanları güncelle
        </button>
        <button type="button" className="btn-secondary" onClick={() => maintenance.mutate('coverage-audit')}>
          Kapsam denetimi çalıştır
        </button>
      </div>
      {message && <InfoNote>{message}</InfoNote>}
      {error && <ErrorNotice message={error} />}
      {sources.isLoading && <Spinner />}
      {/* Sorgu hatasında liste boş görünmesin (kullanıcı "kaynak yok" sanmasın). */}
      {sources.isError && (
        <ErrorNotice message={errorMessage(sources.error)} onRetry={() => void sources.refetch()} />
      )}

      {sources.data?.sources.map((source) => (
        <Card key={source.key} title={source.name} description={source.statusNote}>
          <div className="meta-row">
            <Badge tone={source.verified ? 'success' : source.enabled ? 'warning' : 'neutral'}>
              {sourceStatusLabel(source.status)}
            </Badge>
            <span>aralık: {source.intervalMinutes} dk</span>
            <span>
              son başarılı:{' '}
              {source.health.lastSuccessAt ? formatRelative(source.health.lastSuccessAt) : 'yok'}
            </span>
            <span>üst üste hata: {source.health.consecutiveFailures}</span>
            <span>ortalama süre: {formatDuration(source.health.avgDurationMs)}</span>
            <span>
              başarı oranı:{' '}
              {source.health.totalRuns > 0
                ? `${Math.round((source.health.successRuns / source.health.totalRuns) * 100)}%`
                : 'veri yok'}
            </span>
          </div>
          <p className="text-muted-sm push">{source.coverageNote}</p>
          {source.health.lastError && <p className="text-danger-sm">Son hata: {source.health.lastError}</p>}
          <div className="action-row push-lg">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => scan.mutate(source.key)}
              disabled={scan.isPending || !source.enabled}
            >
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
            <a
              className="btn-ghost"
              href={`/api/sources/${encodeURIComponent(source.key)}/status`}
              target="_blank"
              rel="noreferrer noopener"
            >
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
    queryFn: ({ signal }) =>
      api.get<{
        runs: ScrapeRunSummary[];
        failing: { id: string; sourceKey: string; startedAt: string; result: string; errors: string[] }[];
      }>('/api/admin/scrape-runs', { limit: 50, ...(sourceKey ? { sourceKey } : {}) }, signal),
  });

  return (
    <div className="page-stack">
      <label className="input-narrow">
        <span className="label">Kaynağa göre filtrele</span>
        <input
          className="input"
          value={sourceKey}
          onChange={(event) => setSourceKey(event.target.value)}
          placeholder="ör. resmigazete-cestili-ilanlar"
        />
      </label>
      {query.isLoading && <Spinner />}
      {/* Sorgu hatasında sekme boş görünmesin: neden + yeniden dene. */}
      {query.isError && (
        <ErrorNotice message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      )}
      {query.data?.failing.length ? (
        <Card
          title="Hata bildirimleri"
          description="Site yapısı değiştiğinde ya da ulaşılamadığında burada görünür."
        >
          <ul className="summary-list">
            {query.data.failing.map((run) => (
              <li key={run.id} className="text-danger-sm">
                <p className="strong">{run.id}</p>
                <p className="note-text">
                  {formatDateTime(run.startedAt)} · {run.result}
                </p>
                {run.errors.length > 0 && <p className="note-text">{run.errors.join(' | ')}</p>}
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
                <th scope="col">Zaman</th>
                <th scope="col">Kaynak</th>
                <th scope="col">Durum</th>
                <th scope="col">Bulunan</th>
                <th scope="col">Yeni/Güncelleme</th>
                <th scope="col">Gecikme</th>
                <th scope="col">Not</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.runs.map((run) => (
                <tr key={run.id} className="cell-top">
                  <td>{formatDateTime(run.startedAt)}</td>
                  <td>{run.sourceKey}</td>
                  <td>
                    <Badge
                      tone={
                        run.status === 'success'
                          ? 'success'
                          : run.status === 'partial'
                            ? 'warning'
                            : run.status === 'failed'
                              ? 'danger'
                              : 'neutral'
                      }
                    >
                      {RUN_STATUS_LABELS[run.status] ?? run.status}
                    </Badge>
                  </td>
                  <td>
                    {run.itemsFound} ({run.itemsAccepted} kabul / {run.itemsRejected} ret / {run.itemsReview}{' '}
                    inceleme)
                  </td>
                  <td>
                    {run.jobsCreated} yeni / {run.jobsUpdated} güncelleme / {run.revisionsCreated} revizyon
                  </td>
                  <td>{run.scheduleDelayMs !== null ? formatDuration(run.scheduleDelayMs) : '—'}</td>
                  <td className="cell-note">
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
  // Karar isteği başarısız olursa sessiz kalmayız: nedeni burada gösterilir.
  const [mutationError, setMutationError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['admin-review', kind],
    queryFn: ({ signal }) =>
      api.get<{
        items: ReviewItem[];
        counts: { total: number; classification: number; dedupe: number; extraction: number };
        candidateTitles: Record<string, string>;
      }>('/api/admin/review-queue', { status: 'open', ...(kind ? { kind } : {}) }, signal),
  });

  const decide = useMutation({
    mutationFn: (payload: {
      id: string;
      action: 'accept' | 'reject' | 'merge' | 'keep-separate' | 'ignore';
    }) =>
      api.post<{ message: string }>(`/api/admin/review-queue/${payload.id}/resolve`, {
        action: payload.action,
        note: '',
      }),
    onSuccess: (data) => {
      setMessage(data.message);
      setMutationError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-review'] });
    },
    onError: (caught) => {
      setMessage(null);
      setMutationError(errorMessage(caught));
    },
  });

  return (
    <div className="page-stack">
      <div className="meta-row">
        <label className="body-copy">
          <span className="label">Tür</span>
          <select
            className="input"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="">Tümü</option>
            <option value="classification">İlgililik</option>
            <option value="dedupe">Aynı ilan olabilir</option>
            <option value="extraction">Bilgi okunamadı</option>
          </select>
        </label>
        {query.data && (
          <p className="text-muted-sm">
            İncelenecek: {formatNumber(query.data.counts.total)} (ilgililik {query.data.counts.classification}
            , aynı ilan olabilir {query.data.counts.dedupe}, bilgi okunamadı {query.data.counts.extraction})
          </p>
        )}
      </div>
      {message && <InfoNote>{message}</InfoNote>}
      {mutationError && (
        <ErrorNotice
          message={`Karar kaydedilemedi: ${mutationError}`}
          onRetry={() => setMutationError(null)}
          retryLabel="Kapat"
        />
      )}
      {query.isLoading && <Spinner />}
      {/* Sorgu hatasında sekme boş görünmesin: neden + yeniden dene. */}
      {query.isError && (
        <ErrorNotice message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      )}
      {query.data?.items.length === 0 && <InfoNote>İnceleme bekleyen kayıt yok.</InfoNote>}

      {query.data?.items.map((item) => (
        <Card
          key={item.id}
          title={item.title}
          description={`${REVIEW_KIND_LABELS[item.kind] ?? item.kind} · eminlik %${Math.round(item.confidence * 100)}`}
        >
          <p className="body-copy">{item.reason}</p>
          {llmOpinionOf(item) && (
            <div className="push-sm">
              <InfoNote
                tone={llmOpinionOf(item)?.verdict === 'hata' ? 'warning' : 'info'}
                title={`Yapay zekâ ön görüşü — ${LLM_OPINION_LABELS[llmOpinionOf(item)?.verdict ?? ''] ?? llmOpinionOf(item)?.verdict}`}
              >
                {llmOpinionOf(item)?.summary && <p className="body-copy">{llmOpinionOf(item)?.summary}</p>}
                {llmOpinionOf(item)?.reasons?.map((reason) => (
                  <p key={reason} className="text-muted-sm">
                    {reason}
                  </p>
                ))}
                <p className="text-muted-sm">
                  Bu bir ön görüştür, karar değildir; kabul/red kararı yöneticiye aittir.
                </p>
              </InfoNote>
            </div>
          )}
          <p className="text-muted-sm push-sm">
            <a href={item.url} target="_blank" rel="noreferrer noopener" className="wrap-anywhere">
              {item.url}
            </a>
          </p>
          {item.candidateJobIds.length > 0 && (
            <ul className="note-list push">
              {item.candidateJobIds.map((id) => (
                <li key={id}>
                  Aday ilan:{' '}
                  <Link to={`/ilanlar/${encodeURIComponent(id)}`}>
                    {query.data?.candidateTitles[id] ?? id}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="action-row push-lg">
            {item.kind === 'dedupe' && item.candidateJobIds.length >= 2 && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => decide.mutate({ id: item.id, action: 'merge' })}
              >
                Aynı ilan — birleştir
              </button>
            )}
            {item.kind === 'dedupe' && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => decide.mutate({ id: item.id, action: 'keep-separate' })}
              >
                Farklı ilan — ayrı bırak
              </button>
            )}
            {item.kind === 'classification' && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => decide.mutate({ id: item.id, action: 'accept' })}
                >
                  İlanı kabul et
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => decide.mutate({ id: item.id, action: 'reject' })}
                >
                  İlan değil
                </button>
              </>
            )}
            <button
              type="button"
              className="btn-ghost"
              onClick={() => decide.mutate({ id: item.id, action: 'ignore' })}
            >
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
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['admin-outbox', status],
    queryFn: ({ signal }) =>
      api.get<{ items: OutboxItem[]; stats: Record<string, number>; notice: string; schema: string }>(
        '/api/admin/email-outbox',
        {
          limit: 50,
          ...(status ? { status } : {}),
        },
        signal,
      ),
  });

  const requeue = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/email-outbox/${id}/requeue`),
    onSuccess: () => {
      setMessage('E-posta yeniden kuyruğa alındı.');
      void queryClient.invalidateQueries({ queryKey: ['admin-outbox'] });
    },
    onError: (caught) => setMessage(`Yeniden kuyruğa alınamadı: ${errorMessage(caught)}`),
  });

  return (
    <div className="page-stack">
      <div className="meta-row">
        <label className="body-copy">
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
      {message && <InfoNote tone={message.includes('alınamadı') ? 'danger' : 'success'}>{message}</InfoNote>}
      {query.data?.notice && <InfoNote>{query.data.notice}</InfoNote>}
      {query.isLoading && <Spinner />}
      {/* Sorgu hatasında sekme boş görünmesin: neden + yeniden dene. */}
      {query.isError && (
        <ErrorNotice message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      )}
      <Card title="E-posta gönderimi" description={query.data?.schema}>
        <div className="modern-table-card">
          <table className="modern-data-table">
            <caption className="sr-only">E-posta kuyruğu kayıtları</caption>
            <thead>
              <tr className="table-head-label">
                <th scope="col">Oluşturma</th>
                <th scope="col">Alıcı</th>
                <th scope="col">Konu</th>
                <th scope="col">Durum</th>
                <th scope="col">Deneme</th>
                <th scope="col">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.items.map((item) => (
                <tr key={item.id} className="cell-top">
                  <td>{formatDateTime(item.createdAt)}</td>
                  <td>{item.to}</td>
                  <td>{item.subject}</td>
                  <td>
                    <Badge
                      tone={
                        item.status === 'accepted'
                          ? 'success'
                          : item.status === 'dead'
                            ? 'danger'
                            : item.status === 'failed'
                              ? 'warning'
                              : 'neutral'
                      }
                    >
                      {item.status}
                    </Badge>
                    {item.lastError && <p className="text-danger-sm">{item.lastError}</p>}
                  </td>
                  <td>
                    {item.attempts}/{item.maxAttempts}
                  </td>
                  <td>
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
  const query = useQuery({
    queryKey: ['admin-queue'],
    queryFn: ({ signal }) => api.get<QueueResponse>('/api/admin/queue', undefined, signal),
    refetchInterval: 30_000,
  });

  return (
    <div className="page-stack">
      {query.data?.scheduleLagWarning && <InfoNote tone="warning">{query.data.scheduleLagWarning}</InfoNote>}
      {query.isLoading && <Spinner />}
      {/* Sorgu hatasında sekme boş görünmesin: neden + yeniden dene. */}
      {query.isError && (
        <ErrorNotice message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      )}
      {query.data && (
        <>
          <Card
            title="Zamanlanmış görevler"
            description="Her kaynağa bir sonraki ne zaman bakılacak; gecikirse otomatik kontrol geride kalmış demektir."
          >
            <div className="modern-table-card">
              <table className="modern-data-table">
                <caption className="sr-only">Zamanlanmış görevler</caption>
                <thead>
                  <tr className="table-head-label">
                    <th scope="col">Kaynak</th>
                    <th scope="col">Aralık</th>
                    <th scope="col">Sıradaki</th>
                    <th scope="col">Gecikme</th>
                    <th scope="col">Kaçırılan</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.tasks.map((task) => (
                    <tr key={task.id}>
                      <td>
                        {task.sourceKey} <span className="text-muted-sm">({task.kind})</span>
                      </td>
                      <td>{task.intervalMinutes} dk</td>
                      <td>{formatDateTime(task.nextRunAt)}</td>
                      <td>{task.overdueMinutes > 0 ? `${task.overdueMinutes} dk gecikme` : 'zamanında'}</td>
                      <td>{task.misses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Takılan işler" description="Tekrar denenebilir; nedeni yanında yazılıdır.">
            {query.data.dead.length === 0 ? (
              <p className="body-copy">Ölü iş yok.</p>
            ) : (
              <ul className="compact-list">
                {query.data.dead.map((job) => (
                  <li key={job.id}>
                    {job.queue}/{job.name} · {job.attempts} deneme · {job.lastError ?? 'hata yok'}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Şu an tarananlar" description="Aynı kaynağın iki kez üst üste taranmasını engeller.">
            {query.data.locks.length === 0 ? (
              <p className="body-copy">Aktif kilit yok.</p>
            ) : (
              <ul className="compact-list">
                {query.data.locks.map((lock) => (
                  <li key={lock.key}>
                    {lock.key} · sahip {lock.owner} ·{' '}
                    {lock.expired ? 'süresi geçmiş' : `bitiş ${formatDateTime(lock.expiresAt)}`}
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
  const query = useQuery({
    queryKey: ['admin-coverage'],
    queryFn: ({ signal }) => api.get<CoverageReport>('/api/admin/coverage-report', undefined, signal),
  });
  if (query.isLoading) return <Spinner label="Kapsam raporu yükleniyor…" />;
  if (!query.data)
    return (
      <ErrorNotice
        title="Kapsam raporu alınamadı"
        message={query.error ? errorMessage(query.error) : 'Sunucudan kapsam verisi alınamadı.'}
        onRetry={() => void query.refetch()}
      />
    );
  return (
    <div className="page-stack">
      <InfoNote tone="warning">{query.data.disclaimer}</InfoNote>
      <div className="metric-grid">
        <Metric label="Toplam kaynak" value={formatNumber(query.data.total)} />
        <Metric label="Etkin" value={formatNumber(query.data.enabled)} />
        <Metric label="Doğrulanmış" value={formatNumber(query.data.verified)} />
        <Metric label="Planlanan" value={formatNumber(query.data.planned)} />
      </div>
      <Card title="Gruplara göre kapsam">
        <ul className="body-copy">
          {query.data.byGroup.map((entry) => (
            <li key={entry.group}>
              {entry.group}: {entry.count}
            </li>
          ))}
        </ul>
      </Card>
      <Card
        title="Bilinen boşluklar"
        description="İzlenen ama çalıştığı kanıtlanmamış ya da üst üste ulaşılamayan kaynaklar."
      >
        {query.data.gaps.length === 0 ? (
          <p className="body-copy">Boşluk yok.</p>
        ) : (
          <ul className="compact-list">
            {query.data.gaps.map((gap) => (
              <li key={gap.key}>
                <span className="strong">{gap.key}</span>: {gap.reason}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {query.data.unknownRegistryAdapters.length > 0 && (
        <Card title="Listede olmayan kaynaklar">
          <ul className="body-copy">
            {query.data.unknownRegistryAdapters.map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Kapsamı genişletme" description="Yeni kaynak nasıl eklenir: docs/source-onboarding.md">
        <ol className="step-list">
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
    queryFn: ({ signal }) =>
      api.get<{
        logs: {
          id: string;
          action: string;
          actorUserId: string | null;
          actorRole: string | null;
          targetType: string;
          targetId: string | null;
          createdAt: string;
          ipHash: string | null;
          meta: Record<string, unknown>;
        }[];
      }>('/api/admin/audit-logs', { limit: 100, ...(action ? { action } : {}) }, signal),
  });

  return (
    <div className="page-stack">
      <label className="input-narrow">
        <span className="label">İşlem filtresi</span>
        <input
          className="input"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder="ör. admin.source-scan-requested"
        />
      </label>
      {query.isLoading && <Spinner />}
      {/* Sorgu hatasında sekme boş görünmesin: neden + yeniden dene. */}
      {query.isError && (
        <ErrorNotice message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      )}
      <Card
        title="İşlem geçmişi"
        description="Yönetici işlemleri ve güvenlik olayları burada tutulur. IP adresi tanınmaz biçimde saklanır."
      >
        <ul className="compact-list">
          {query.data?.logs.map((log) => (
            <li key={log.id}>
              <p>
                <span className="strong">{log.action}</span> · {formatDateTime(log.createdAt)} ·{' '}
                {log.targetType}
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
    queryFn: ({ signal }) =>
      api.get<{ users: AdminUserRow[]; notifiableCount: number; notice: string }>(
        '/api/admin/users',
        { limit: 100 },
        signal,
      ),
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
        Kamuİlan'da kullanıcılar kendi kendine kayıt olamaz. Hesap buradan açılır; davet e-postasındaki
        bağlantı 72 saat geçerlidir ve parolayı yalnızca kullanıcı belirler. Sistem düz metin parola üretmez
        ve göndermez.
      </InfoNote>

      <Card
        title="Yeni kullanıcı davet et"
        description="Hesap açılır ve tek kullanımlık şifre belirleme bağlantısı gönderilir."
      >
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
            <input
              id="invite-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
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
          <button
            type="button"
            className="btn-primary"
            disabled={invite.isPending || email.length < 5}
            onClick={() => invite.mutate()}
          >
            <Icon name="send" size={15} />
            <span>{invite.isPending ? 'Davet gönderiliyor…' : 'Davet gönder'}</span>
          </button>
        </div>
        {message && <InfoNote tone="success">{message}</InfoNote>}
        {error && <ErrorNotice message={error} />}
      </Card>

      <Card
        title="Kullanıcılar"
        description={
          users.data ? `Bildirim alan kullanıcı: ${formatNumber(users.data.notifiableCount)}` : undefined
        }
      >
        {users.isLoading && <Spinner label="Kullanıcılar yükleniyor…" />}
        {users.isError && (
          <ErrorNotice message={errorMessage(users.error)} onRetry={() => void users.refetch()} />
        )}
        {users.data && (
          <DataTable
            caption="Kullanıcı listesi"
            head={['Kullanıcı', 'Rol', 'Durum', 'Bildirim', 'Son giriş', 'Kayıt']}
          >
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
        {users.data && <p className="text-muted-sm push">{users.data.notice}</p>}
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="card-elevated">
      <p className="table-head-label">{label}</p>
      <p className="metric-value">{value}</p>
    </div>
  );
}
