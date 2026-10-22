/**
 * Ana sayfa — özet.
 *
 * Buradaki her sayı sunucudan gelir (`/api/jobs/stats`, `/api/health`).
 * Kullanıcıya teknik ayrıntı (tarama süreci, doğrulama sayıları) gösterilmez;
 * yalnızca "liste en son ne zaman güncellendi" ve kaç kurumun takip edildiği
 * yazılır. Ayrıntılı sağlık bilgisi yönetim panelindedir.
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PROVINCES } from '../domain/provinces';
import { JobCard } from '../components/JobCard';
import { Icon } from '../components/Icon';
import { Card, ErrorNotice, LoadingCard, StatCard, Tag } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { usePageMeta } from '../lib/page-meta';
import { HEALTH_QUERY_KEY } from '../lib/query-keys';
import { deadlineLabel, employmentTypeLabel, formatDateOnly, formatNumber, formatRelative } from '../lib/format';
import { APP_TAGLINE } from '../site';
import type { DashboardStats, HealthResponse, JobListResponse, PublicJobSummary } from '../types';

const STATS_KEY = ['home', 'stats'] as const;
const LATEST_KEY = ['home', 'latest'] as const;
const CLOSING_KEY = ['home', 'closing'] as const;

/** Bir günden eski güncelleme "gecikti" sayılır (durum bandıyla aynı eşik). */
const STALE_MINUTES = 24 * 60;

/** "Liste ne kadar güncel?" kartı: sade dil, teknik terim yok. */
function SystemStrip() {
  const health = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: ({ signal }) => api.get<HealthResponse>('/api/health', undefined, signal),
  });

  const data = health.data;
  const lastSuccessAt = data?.scans.lastSuccessAt ?? null;
  const minutes = data?.scans.minutesSinceSuccess ?? null;
  const late = data?.status === 'down' || (minutes !== null && minutes > STALE_MINUTES);

  return (
    <aside className="desk-now" role="status" aria-busy={health.isLoading}>
      <div className="desk-now-top">
        <span className="desk-now-tag">
          <span className="desk-now-pulse" aria-hidden="true" />
          İlan listesi
        </span>
        {data && (late || lastSuccessAt) && (
          <Tag tone={late ? 'warning' : 'success'}>{late ? 'Güncelleme gecikti' : 'Güncel'}</Tag>
        )}
      </div>
      <div className="desk-now-body">
        <div className="desk-now-main">
          <span className="desk-now-when">Son güncelleme</span>
          <span className="desk-now-name">
            {health.isLoading
              ? 'Okunuyor…'
              : !data
                ? 'Şu anda okunamadı'
                : lastSuccessAt
                  ? formatRelative(lastSuccessAt)
                  : 'Henüz güncelleme yok'}
          </span>
          {data && (
            <span className="desk-now-detail">
              <strong>{formatNumber(data.sources.enabled)}</strong> resmî kaynak takip ediliyor.
            </span>
          )}
        </div>
      </div>
      <div className="desk-now-foot">
        <Link className="desk-now-go" to="/panel">
          <Icon name="bell" size={14} />
          <span>E-posta bildirimi kur</span>
        </Link>
        <Link className="desk-now-secondary" to="/kaynaklar">
          <span>İlan kaynakları</span>
          <Icon name="arrowRight" size={13} />
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
                placeholder="Unvan, kurum ya da kelime"
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
            <Link className="btn-secondary btn-sm" to="/ilanlar?status=active&sort=deadline">
              Son günü yaklaşanlar
            </Link>
            <Link className="btn-secondary btn-sm" to="/ilanlar?sort=newest">
              Yeni eklenenler
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
        <Card title="Türlerine göre ilan sayısı">
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

      <Card title="Nasıl kullanılır?">
        <ol className="how-steps">
          <li>
            <strong>Arayın</strong>
            <span>Unvan, kurum ya da il yazın; açık ilanları hemen görün.</span>
          </li>
          <li>
            <strong>Kaydedin</strong>
            <span>İlgilendiğiniz ilanı kaydedin, son başvuru gününü kaçırmayın.</span>
          </li>
          <li>
            <strong>Haber alın</strong>
            <span>Tercihlerinize uyan yeni ilan çıkınca e-posta ile bildirelim.</span>
          </li>
        </ol>
      </Card>

      <datalist id="il-listesi">
        {PROVINCES.map((province) => (
          <option value={province.name} key={province.plateCode} />
        ))}
      </datalist>
    </div>
  );
}
