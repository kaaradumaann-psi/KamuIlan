/**
 * Kaydettiklerim — adayın takip listesi.
 *
 * Liste sunucudan gelir ve son başvurusu yakın olan üsttedir. Kapanmış
 * ilanlar listeden kendiliğinden düşmez; aday neyi takip ettiğini görür,
 * kaydını kendisi kaldırır.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { JobCard } from '../components/JobCard';
import { EmptyState, ErrorNotice, LoadingCard } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { HONESTY_NOTE } from '../site';
import type { SavedJobsResponse } from '../types';

export function SavedJobsPage(): ReactNode {
  const saved = useQuery({
    queryKey: ['saved-jobs'],
    queryFn: ({ signal }) => api.get<SavedJobsResponse>('/api/me/saved-jobs', undefined, signal),
  });

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-text">
          <span className="kicker">Takip listem</span>
          <h1 className="page-title">Kaydettiğim ilanlar</h1>
          <p className="info-lede">
            Son başvurusu yakın olan üstte sıralanır. Değişiklik bildirimleri, bildirim tercihiniz açıksa
            e-posta ile de gelir.
          </p>
        </div>
        <div className="page-head-actions">
          <Link className="btn-secondary btn-sm" to="/panel">
            Bildirim tercihleri
          </Link>
          <Link className="btn-primary btn-sm" to="/ilanlar">
            İlanlarda ara
          </Link>
        </div>
      </header>

      <nav className="subnav-tabs" aria-label="Panel bölümleri">
        <Link className="subnav-tab" to="/panel">
          Tercihlerim
        </Link>
        <Link className="subnav-tab" to="/panel/gecmis">
          Bildirim geçmişi
        </Link>
        <Link className="subnav-tab is-active" aria-current="page" to="/panel/kaydedilenler">
          Kaydettiklerim
        </Link>
      </nav>

      {saved.isLoading && <LoadingCard title="Kayıtlı ilanlar yükleniyor…" />}
      {saved.isError && (
        <ErrorNotice
          title="Kayıtlı ilanlar alınamadı"
          message={errorMessage(saved.error)}
          onRetry={() => void saved.refetch()}
        />
      )}

      {saved.data && saved.data.items.length === 0 && (
        <EmptyState
          icon="save"
          title="Henüz kaydettiğiniz ilan yok"
          description="İlgilendiğiniz ilanın kartındaki Kaydet düğmesiyle takip listenize ekleyin; son başvuru günü yaklaşanlar burada üstte görünür."
          action={
            <Link className="btn-primary" to="/ilanlar">
              İlanlarda ara
            </Link>
          }
        />
      )}

      {saved.data && saved.data.items.length > 0 && (
        <div className="job-list">
          {saved.data.items.map((item) => (
            <JobCard job={item.job} key={item.job.id} />
          ))}
        </div>
      )}

      <p className="text-muted-sm">{HONESTY_NOTE}</p>
    </div>
  );
}
