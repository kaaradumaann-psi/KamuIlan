/**
 * Ana sayfa — herkese açık özet.
 *
 * Buradaki her sayı sunucudan gelir (`/api/jobs/stats`, `/api/health`). Sistem
 * "tüm ilanlar" iddiasında bulunmaz: kapsam, son başarılı tarama ve doğrulanmış
 * kaynak sayısı açıkça yazılır.
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PROVINCES } from '../domain/provinces';
import { JobCard } from '../components/JobCard';
import { Icon } from '../components/Icon';
import { Card, ErrorNotice, InfoNote, LoadingCard, StatCard, Tag } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { usePageMeta } from '../lib/page-meta';
import { HEALTH_QUERY_KEY, WORKER_HEALTH_QUERY_KEY } from '../lib/query-keys';
import { deadlineLabel, employmentTypeLabel, formatDateOnly, formatNumber, formatRelative } from '../lib/format';
import { APP_TAGLINE, HONESTY_NOTE } from '../site';
import type { DashboardStats, HealthResponse, JobListResponse, PublicJobSummary, WorkerHealthResponse } from '../types';

const STATS_KEY = ['home', 'stats'] as const;
const LATEST_KEY = ['home', 'latest'] as const;
const CLOSING_KEY = ['home', 'closing'] as const;

/** Sistem durumu şeridi: gerçek sağlık yanıtından türetilir. */
function statusLabel(status: HealthResponse['status'] | undefined): {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
} {
  if (status === 'ok') return { label: 'Sistem normal', tone: 'success' };
  if (status === 'degraded') return { label: 'Sistem kısmen sorunlu', tone: 'warning' };
  if (status === 'down') return { label: 'Sistem erişilemez', tone: 'danger' };
  return { label: 'Durum bilinmiyor', tone: 'neutral' };
}

function SystemStrip() {
  const health = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: ({ signal }) => api.get<HealthResponse>('/api/health', undefined, signal),
  });
  const worker = useQuery({
    queryKey: WORKER_HEALTH_QUERY_KEY,
    queryFn: ({ signal }) => api.get<WorkerHealthResponse>('/api/health/worker', undefined, signal),
    refetchInterval: 10_000,
  });

  if (health.isLoading)
    return (
      <aside className="desk-now" aria-busy="true">
        <div className="desk-now-top">
          <span className="desk-now-tag">
            <span className="desk-now-pulse" aria-hidden="true" />
            Canlı sistem durumu
          </span>
        </div>
        <div className="status-strip">Durum okunuyor…</div>
      </aside>
    );
  if (health.isError || !health.data) {
    return (
      <aside className="desk-now" role="status">
        <div className="desk-now-top">
          <span className="desk-now-tag">
            <span className="desk-now-pulse" aria-hidden="true" />
            Canlı sistem durumu
          </span>
        </div>
        <div className="status-strip is-warning">
          <Icon name="alert" size={15} />
          <span>Durum şu anda okunamıyor. Sayfayı yenilediğinizde yeniden denenecek.</span>
        </div>
      </aside>
    );
  }

  const data = health.data;
  const workerRunning = worker.data?.workers.running ?? data.workers.running;
  const workerStarting = worker.data?.workers.starting ?? 0;
  const workerPending = worker.isLoading && !worker.data && workerRunning === 0;
  const workerActive = workerRunning > 0;
  const workerStartingNow = !workerActive && (workerStarting > 0 || workerPending);
  const state =
    data.status === 'down'
      ? statusLabel(data.status)
      : workerStartingNow
        ? { label: 'Tarama worker’ı başlatılıyor', tone: 'warning' as const }
        : !workerActive
          ? { label: 'Tarama worker’ı çalışmıyor', tone: 'warning' as const }
          : statusLabel(data.status);
  return (
    <aside className="desk-now" role="status">
      <div className="desk-now-top">
        <span className="desk-now-tag">
          <span className="desk-now-pulse" aria-hidden="true" />
          Canlı sistem durumu
        </span>
        <Tag tone={state.tone}>{state.label}</Tag>
      </div>
      <div className="desk-now-body">
        <span className="desk-now-symbol" aria-hidden="true">
          <Icon name="layers" size={18} />
        </span>
        <div className="desk-now-main">
          <span className="desk-now-when">Otomatik tarama özeti</span>
          <span className="desk-now-name">
            İlanlar en son:{' '}
            <strong>{data.scans.lastSuccessAt ? formatRelative(data.scans.lastSuccessAt) : 'henüz başarılı tarama yok'}</strong>
          </span>
          <span className="desk-now-detail">
            Etkin kaynak: <strong>{data.sources.enabled}</strong> · Worker:{' '}
            <strong>{workerActive ? 'çalışıyor' : workerStartingNow ? 'başlatılıyor' : 'çalışmıyor'}</strong> · Gerçek veriyle doğrulanan:{' '}
            <strong>{data.sources.verified}</strong>
          </span>
        </div>
      </div>
      <div className="desk-now-foot">
        <Link className="desk-now-go" to="/kaynaklar">
          <span>Kaynak durumunu incele</span>
          <Icon name="arrowRight" size={14} />
        </Link>
        <Link className="desk-now-secondary" to="/panel">
          <Icon name="bell" size={13} />
          <span>E-posta bildirimi kur</span>
        </Link>
      </div>
    </aside>
  );
}

export function HomePage() {
  usePageMeta({ title: 'Kamu personel alım ilanları' });
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [city, setCity] = useState('');

  const stats = useQuery({
    queryKey: STATS_KEY,
    queryFn: ({ signal }) => api.get<DashboardStats>('/api/jobs/stats', undefined, signal),
  });
  const latest = useQuery({
    queryKey: LATEST_KEY,
    queryFn: ({ signal }) => api.get<JobListResponse>('/api/jobs', { sort: 'newest', pageSize: 6 }, signal),
  });
  const closing = useQuery({
    queryKey: CLOSING_KEY,
    queryFn: ({ signal }) =>
      api.get<{
        items: PublicJobSummary[];
        total: number;
        humanRange: string;
        range: { from: string; to: string; days: number };
      }>('/api/jobs/deadlines/upcoming', { days: 14 }, signal),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (term.trim()) params.set('q', term.trim());
    if (city.trim()) params.set('city', city.trim());
    const query = params.toString();
    navigate(`/ilanlar${query ? `?${query}` : ''}`);
  }

  const typeCounts = stats.data?.byEmploymentType ?? [];
  const maxType = typeCounts.reduce((max, item) => Math.max(max, item.count), 0);

  return (
    <div className="page-stack day-board">
      <section className="desk hero-band">
        <div className="desk-intro hero-text-side">
          <div className="desk-eyebrow">
            <span className="desk-eyebrow-dot" aria-hidden="true" />
            <span>Kamu ilanı takip sistemi</span>
          </div>
          <h1>Kamu personel alım ilanları</h1>
          <p className="info-lede">{APP_TAGLINE}</p>
          <form className="hero-search" onSubmit={submit} role="search" aria-label="İlan ara">
            <div className="search-input-wrapper">
              <Icon name="search" size={18} />
              <input
                type="search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Unvan, kurum ya da kelime (örn. hemşire)"
                aria-label="Arama terimi"
              />
            </div>
            <div className="search-input-wrapper">
              <Icon name="mapPin" size={18} />
              <input
                type="search"
                value={city}
                onChange={(event) => setCity(event.target.value)}
                placeholder="İl (örn. İstanbul)"
                aria-label="İl"
                list="il-listesi"
              />
            </div>
            <button type="submit" className="btn-primary">
              <Icon name="search" size={16} />
              <span>İlanlarda ara</span>
            </button>
          </form>
          <div className="desk-actions hero-actions">
            <Link className="btn-secondary btn-sm" to="/ilanlar?status=active">
              Başvurusu açık ilanlar
            </Link>
            <Link className="btn-secondary btn-sm" to="/kaynaklar">
              <Icon name="list" size={16} />
              <span>Kaynaklar ve kapsam</span>
            </Link>
            <Link className="btn-secondary btn-sm" to="/panel">
              <Icon name="bell" size={16} />
              <span>Bildirim kur</span>
            </Link>
          </div>
        </div>

        <SystemStrip />
      </section>

      {stats.isError && (
        <ErrorNotice
          title="Özet sayılar alınamadı"
          message={errorMessage(stats.error)}
          onRetry={() => void stats.refetch()}
        />
      )}

      {stats.data && (
        <section className="stats-grid-4" aria-label="Güncel sayılar">
          <StatCard label="Açık ilan" value={formatNumber(stats.data.active)} icon="layers" tone="accent" />
          <StatCard
            label="Bugün eklenen"
            value={formatNumber(stats.data.addedToday)}
            icon="check"
            tone="success"
          />
          <StatCard
            label="Son günü yaklaşan"
            value={formatNumber(stats.data.closingSoon)}
            icon="clock"
            tone="warning"
          />
          <StatCard label="Toplam ilan" value={formatNumber(stats.data.total)} icon="list" />
        </section>
      )}

      <div className="dashboard-grid">
        <Card
          title="Son eklenen ilanlar"
          description="En son bulunan ilanlar."
          actions={
            <Link className="board-text-link" to="/ilanlar?sort=newest">
              Tümünü gör <Icon name="right" size={13} />
            </Link>
          }
        >
          {latest.isLoading && <LoadingCard title="İlanlar yükleniyor…" />}
          {latest.isError && (
            <ErrorNotice message={errorMessage(latest.error)} onRetry={() => void latest.refetch()} />
          )}
          {latest.data && latest.data.items.length === 0 && (
            <p className="text-muted-sm">Henüz ilan bulunamadı. Kontroller sürdükçe burada görünecek.</p>
          )}
          {latest.data && latest.data.items.length > 0 && (
            <div className="job-list">
              {latest.data.items.map((job) => (
                <JobCard job={job} key={job.id} />
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Yaklaşan son başvuru tarihleri"
          description="Başvurusu önümüzdeki 14 gün içinde bitenler."
        >
          {closing.isLoading && <LoadingCard title="Takvim yükleniyor…" />}
          {closing.isError && (
            <ErrorNotice message={errorMessage(closing.error)} onRetry={() => void closing.refetch()} />
          )}
          {closing.data && closing.data.items.length === 0 && (
            <p className="text-muted-sm">Önümüzdeki 14 gün içinde başvurusu biten ilan yok.</p>
          )}
          {closing.data && closing.data.items.length > 0 && (
            <ul className="report-list">
              {closing.data.items.map((job) => (
                <li className="report-list-item" key={job.id}>
                  <div>
                    <Link to={`/ilanlar/${encodeURIComponent(job.id)}`}>{job.title}</Link>
                    <span className="cell-subtitle">{job.institution}</span>
                  </div>
                  <div className="report-list-meta">
                    <span className="date-tag">
                      {formatDateOnly(job.applicationEndAt ?? job.applicationEndDate)}
                    </span>
                    <span className="text-muted-sm">
                      {deadlineLabel(job.deadline.daysLeft, job.deadline.state)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {typeCounts.length > 0 && (
        <Card title="Türlerine göre ilan sayısı" description="Hangi türde kaç ilan olduğunu gösterir.">
          <ul className="distribution-list">
            {typeCounts.map((item) => (
              <li key={item.key}>
                <Link
                  className="distribution-label distribution-link"
                  to={`/ilanlar?employmentType=${encodeURIComponent(item.key)}`}
                >
                  {employmentTypeLabel(item.key)}
                </Link>
                <span className="distribution-track" aria-hidden="true">
                  <span
                    className="distribution-fill"
                    style={{ width: maxType > 0 ? `${Math.round((item.count / maxType) * 100)}%` : '0%' }}
                  />
                </span>
                <strong className="distribution-value">{formatNumber(item.count)}</strong>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Bu site nasıl çalışıyor?" description="İlanların size ulaşana kadar geçtiği yol, kısaca.">
        <ol className="checklist">
          <li>
            <strong>Kontrol:</strong> Kurumların ilan sayfalarını düzenli aralıklarla yoklarız. Bir sayfaya
            ulaşamazsak elimizdeki ilanları silmeyiz; bir süre sonra yeniden deneriz.
          </li>
          <li>
            <strong>Ayıklama:</strong> İş alımı olmayan duyuruları (ihale, sonuç listesi, tebliğ gibi)
            ayıklarız. Emin olamadıklarımızı silmez, bir insanın gözden geçirmesine bırakırız.
          </li>
          <li>
            <strong>Okuma:</strong> İlanın içinden tarih, kontenjan, şehir ve koşulları okuruz. Okuyamadığımız
            yerde "belirtilmemiş" yazarız; hiçbir bilgiyi tahmin etmeyiz.
          </li>
          <li>
            <strong>Tek gösterme:</strong> Aynı ilan birden çok yerde çıkarsa size bir kez gösteririz; çıktığı
            bütün adresleri ilanın altında sıralarız. Benzer başlıklı farklı ilanları birleştirmeyiz.
          </li>
          <li>
            <strong>Haber verme:</strong> Tercihlerinize uyan yeni bir ilan bulursak ya da takip ettiğiniz
            ilanda değişiklik olursa e-posta göndeririz. Gönderimin ulaşıp ulaşmadığını da geçmiş ekranından
            görebilirsiniz.
          </li>
        </ol>
        <InfoNote title="Bilmeniz gereken" tone="info">
          {HONESTY_NOTE}
        </InfoNote>
      </Card>

      <datalist id="il-listesi">
        {PROVINCES.map((province) => (
          <option value={province.name} key={province.plateCode} />
        ))}
      </datalist>
    </div>
  );
}
