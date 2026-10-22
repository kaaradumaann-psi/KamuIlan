/**
 * İlan kaynakları sayfası (kullanıcı tarafı).
 *
 * Sade liste: kurum adı, ne tür ilanlar, durum rozeti ve son güncelleme.
 * Teknik ayrıntı (tarama süresi, deneme sayısı, sayfa kapsamı, uyarlayıcı
 * durumu) burada GÖSTERİLMEZ; o bilgiler yalnızca yönetim panelindedir.
 *
 * Durum rozeti üç değerden biridir:
 *  - "Taranıyor"      — kaynak düzenli olarak otomatik taranır,
 *  - "Elle takip"     — ilanları elle eklenir,
 *  - "Şimdilik kapalı" — kaynak kapatıldı ya da kullanım şartları onayı
 *                        beklendiği için taranmıyor (`termsGated`). Bu durum
 *                        kullanıcıya "hata/ulaşılamadı" olarak sunulmaz.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CONTACT_EMAIL } from '../site';
import { api, errorMessage } from '../lib/api';
import { usePageMeta } from '../lib/page-meta';
import { formatNumber, formatRelative } from '../lib/format';
import type { SourceListResponse } from '../types';
import { Card, EmptyState, ErrorNotice, LoadingCard, Tag } from '../components/ui';
import { Icon } from '../components/Icon';

type SourceRow = SourceListResponse['sources'][number];
export type SourceUserState = 'active' | 'manual' | 'paused';

/** Kullanıcıya gösterilen tek durum (teknik durumlar üç sade değere indirgenir). */
export function sourceUserState(source: Pick<SourceRow, 'enabled' | 'status' | 'termsGated'>): SourceUserState {
  if (source.status === 'needs-manual-method') return 'manual';
  if (!source.enabled || source.termsGated || source.status === 'disabled') return 'paused';
  return 'active';
}

const STATE_LABEL: Record<SourceUserState, { label: string; tone: 'success' | 'info' | 'neutral' }> = {
  active: { label: 'Taranıyor', tone: 'success' },
  manual: { label: 'Elle takip', tone: 'info' },
  paused: { label: 'Şimdilik kapalı', tone: 'neutral' },
};

/** Kaynağın ilan türü — teknik grup adı yerine okunur bir açıklama. */
const GROUP_LABEL: Record<string, string> = {
  ulusal: 'Tüm kurumların ilanları',
  kurum: 'Kurumun kendi ilanları',
  universite: 'Üniversite ilanları',
  belediye: 'Belediye ilanları',
  sinav: 'Sınav ve yerleştirme duyuruları',
};

/** Kaynak adındaki teknik ekleri ("(JSON API)" gibi) kullanıcıdan gizler. */
export function displaySourceName(name: string): string {
  return name.replace(/\s*\((?:json\s*)?api\)/giu, '').trim();
}

const STATE_ORDER: Record<SourceUserState, number> = { active: 0, manual: 1, paused: 2 };

/** Önce taranan, sonra elle takip edilen, en sonda kapalı kaynaklar; her grupta ada göre. */
function sortSources(sources: SourceRow[]): SourceRow[] {
  return [...sources].sort(
    (a, b) =>
      STATE_ORDER[sourceUserState(a)] - STATE_ORDER[sourceUserState(b)] ||
      a.name.localeCompare(b.name, 'tr'),
  );
}

function SourceItem({ source }: { source: SourceRow }) {
  const userState = sourceUserState(source);
  const state = STATE_LABEL[userState];
  const kind = GROUP_LABEL[source.group] ?? 'Kamu personel ilanları';
  return (
    <li className="source-item">
      <div className="source-item-main">
        <strong className="source-item-name">{displaySourceName(source.name)}</strong>
        <span className="source-item-kind">{`${source.institution} · ${kind}`}</span>
      </div>
      <div className="source-item-side">
        <Tag tone={state.tone}>{state.label}</Tag>
        {source.health.lastSuccessAt ? (
          <span className="source-item-when">Son güncelleme: {formatRelative(source.health.lastSuccessAt)}</span>
        ) : (
          userState === 'active' && <span className="source-item-when">Henüz güncellenmedi</span>
        )}
      </div>
    </li>
  );
}

export function SourcesPage(): ReactNode {
  usePageMeta({
    title: 'İlan kaynakları',
    description: 'Kamuİlan’ın ilanlarını topladığı resmî kaynaklar.',
  });
  const query = useQuery({
    queryKey: ['sources'],
    queryFn: ({ signal }) => api.get<SourceListResponse>('/api/sources', undefined, signal),
  });

  const sources = sortSources(query.data?.sources ?? []);
  const activeCount = sources.filter((source) => sourceUserState(source) === 'active').length;

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-text">
          <span className="kicker">İlan kaynakları</span>
          <h1 className="page-title">İlanları nereden alıyoruz?</h1>
          <p className="info-lede">
            İlanları aşağıdaki resmî kaynaklardan topluyoruz.
            {query.data ? ` Şu anda ${formatNumber(activeCount)} kaynak düzenli olarak taranıyor.` : ''}
          </p>
        </div>
      </header>

      {query.isLoading && <LoadingCard title="Kaynaklar yükleniyor…" />}
      {query.isError && (
        <ErrorNotice
          title="Kaynak listesi alınamadı"
          message={errorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
      )}

      {query.data && (
        <>
          <Card title="Kaynak listesi">
            {sources.length === 0 ? (
              <EmptyState icon="list" title="Henüz kaynak yok" description="Kaynaklar eklendiğinde burada görünür." />
            ) : (
              <ul className="source-list" aria-label="Kaynak listesi">
                {sources.map((source) => (
                  <SourceItem source={source} key={source.key} />
                ))}
              </ul>
            )}
          </Card>

          {query.data.planned.length > 0 && (
            <Card
              title="Henüz takip etmediğimiz kurumlar"
              description="Bu kurumların ilanları şimdilik yalnızca yukarıdaki genel kaynaklardan gelebilir."
            >
              <ul className="source-list">
                {query.data.planned.map((planned) => (
                  <li className="source-item" key={planned.id}>
                    <div className="source-item-main">
                      <strong className="source-item-name">{planned.institution}</strong>
                      <span className="source-item-kind">{planned.name}</span>
                    </div>
                    {planned.candidateUrl && (
                      <div className="source-item-side">
                        <a
                          className="board-text-link"
                          href={planned.candidateUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Kurumun sayfası <Icon name="external" size={13} />
                        </a>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <p className="text-muted-sm">
            Listede olmasını istediğiniz bir kurum var mı? Bize yazın:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        </>
      )}
    </div>
  );
}
