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
import {
  EMPLOYMENT_TYPE_LABELS,
  deadlineLabel,
  formatDateOnly,
  formatNumber,
  formatRelative,
} from '../lib/format';
import { APP_TAGLINE, HONESTY_NOTE } from '../site';
import type { DashboardStats, HealthResponse, JobListResponse, PublicJobSummary } from '../types';

const STATS_KEY = ['home', 'stats'] as const;
const LATEST_KEY = ['home', 'latest'] as const;
const CLOSING_KEY = ['home', 'closing'] as const;
const HEALTH_KEY = ['home', 'health'] as const;

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
    queryKey: HEALTH_KEY,
    queryFn: () => api.get<HealthResponse>('/api/health'),
    refetchInterval: 60_000,
    retry: 1,
  });

  if (health.isLoading)
    return (
      <div className="status-strip" aria-busy="true">
        Durum okunuyor…
      </div>
    );
  if (health.isError || !health.data) {
    return (
      <div className="status-strip is-warning" role="status">
        <Icon name="alert" size={15} />
        <span>Durum şu anda okunamıyor. Sayfayı yenilediğinizde yeniden denenecek.</span>
      </div>
    );
  }

  const data = health.data;
  const state = statusLabel(data.status);
  return (
    <div className={`status-strip is-${state.tone}`} role="status">
      <Tag tone={state.tone}>{state.label}</Tag>
      <span>
        İlanlar en son:{' '}
        <strong>{data.scans.lastSuccessAt ? formatRelative(data.scans.lastSuccessAt) : 'henüz güncellenmedi'}</strong>
      </span>
      <span>
        İzlenen kaynak: <strong>{data.sources.enabled}</strong>
      </span>
      <span>
        Çalıştığı kanıtlanan: <strong>{data.sources.verified}</strong>
      </span>
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [city, setCity] = useState('');

  const stats = useQuery({
    queryKey: STATS_KEY,
    queryFn: () => api.get<DashboardStats>('/api/jobs/stats'),
  });
  const latest = useQuery({
    queryKey: LATEST_KEY,
    queryFn: () => api.get<JobListResponse>('/api/jobs', { sort: 'newest', pageSize: 6 }),
  });
  const closing = useQuery({
    queryKey: CLOSING_KEY,
    queryFn: () =>
      api.get<{ items: PublicJobSummary[]; days: number; generatedAt: string }>(
        '/api/jobs/deadlines/upcoming',
        {
          days: 14,
        },
      ),
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
    <div className="page-stack">
      <section className="hero-band">
        <div className="hero-band-inner">
          <div className="hero-text-side">
            <span className="kicker">Kamu ilanı takip sistemi</span>
            <h1>Kamu personel alım ilanları</h1>
            <p className="info-lede">{APP_TAGLINE}</p>
            <form className="hero-search" onSubmit={submit} role="search" aria-label="İlan ara">
              <div className="search-input-wrapper">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                  placeholder="Unvan, kurum veya anahtar kelime (örn. hemşire, zabıta, DSİ)"
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
            <div className="hero-actions">
              <Link className="btn-secondary" to="/kaynaklar">
                <Icon name="list" size={16} />
                <span>Kaynaklar ve kapsam</span>
              </Link>
              <Link className="btn-secondary" to="/panel">
                <Icon name="bell" size={16} />
                <span>Bildirim kur</span>
              </Link>
            </div>
          </div>

          <div className="hero-foot">
            <SystemStrip />
          </div>
        </div>
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

        <Card title="Yaklaşan son başvuru tarihleri" description="Başvurusu önümüzdeki 14 gün içinde bitenler.">
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
                    <span className="date-tag">{formatDateOnly(job.applicationEndAt)}</span>
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
                  {EMPLOYMENT_TYPE_LABELS[item.key] ?? item.key}
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
            <strong>Okuma:</strong> İlanın içinden tarih, kontenjan, şehir ve koşulları okuruz.
            Okuyamadığımız yerde "belirtilmemiş" yazarız; hiçbir bilgiyi tahmin etmeyiz.
          </li>
          <li>
            <strong>Tek gösterme:</strong> Aynı ilan birden çok yerde çıkarsa size bir kez gösteririz;
            çıktığı bütün adresleri ilanın altında sıralarız. Benzer başlıklı farklı ilanları
            birleştirmeyiz.
          </li>
          <li>
            <strong>Haber verme:</strong> Tercihlerinize uyan yeni bir ilan bulursak ya da takip
            ettiğiniz ilanda değişiklik olursa e-posta göndeririz. Gönderimin ulaşıp ulaşmadığını
            da geçmiş ekranından görebilirsiniz.
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
