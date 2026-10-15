/**
 * Kaynaklar sayfası: ilanları hangi resmî adreslerden aldığımız.
 *
 * Amaç: "hangi kurumlara bakılıyor, hangilerine henüz başlanmadı, en son
 * ne zaman bakıldı" sorularını herkesin anlayacağı dille yanıtlamak.
 * Çalıştığı kanıtlanmamış kaynak "çalışıyor" gibi gösterilmez.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CONTACT_EMAIL } from '../site';
import { api, errorMessage } from '../lib/api';
import {
  RUN_STATUS_LABELS,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  sourceStatusLabel,
} from '../lib/format';
import type { SourceListResponse } from '../types';
import {
  Card,
  DataTable,
  EmptyState,
  ErrorNotice,
  InfoNote,
  LoadingCard,
  StatCard,
  Tag,
} from '../components/ui';
import { Icon } from '../components/Icon';

/** Son tarama sonucu, statik doğrulama bilgisinden ayrı gösterilir. */
function sourceTag(source: SourceListResponse['sources'][number]): ReactNode {
  switch (source.lastRun?.status) {
    case 'success':
      return (
        <Tag tone="success" icon="check">
          son tarama başarılı
        </Tag>
      );
    case 'partial':
      return (
        <Tag tone="warning" icon="info">
          son tarama kısmi
        </Tag>
      );
    case 'failed':
      return (
        <Tag tone="danger" icon="alert">
          son tarama sorunlu
        </Tag>
      );
    case 'skipped':
    case 'locked':
      return (
        <Tag tone="warning" icon="info">
          son tarama atlandı
        </Tag>
      );
    case 'queued':
      return <Tag tone="info">tarama sırada</Tag>;
    case 'running':
      return <Tag tone="info">tarama çalışıyor</Tag>;
    default:
      if (source.verified)
        return (
          <Tag tone="info" icon="check">
            tarihsel doğrulama
          </Tag>
        );
      if (source.built)
        return (
          <Tag tone="warning" icon="info">
            uyarlayıcı hazır
          </Tag>
        );
      return <Tag tone="neutral">{sourceStatusLabel(source.status)}</Tag>;
  }
}

export function SourcesPage(): ReactNode {
  const query = useQuery({
    queryKey: ['sources'],
    queryFn: ({ signal }) => api.get<SourceListResponse>('/api/sources', undefined, signal),
  });

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-text">
          <span className="kicker">İlan kaynakları</span>
          <h1 className="page-title">İlanları nereden alıyoruz?</h1>
          <p className="info-lede">
            Hangi resmî kaynaklara baktığımızı, her birinin son tarama sonucunu ve son başarılı taramasını
            burada görürsünüz. Bir kaynağın yönteminin doğrulanmış olması, şu anda taranıyor olduğu anlamına
            gelmez.
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
          <section className="stats-grid-4" aria-label="Kaynak özeti">
            <StatCard label="Toplam kaynak" value={formatNumber(query.data.summary.total)} icon="list" />
            <StatCard
              label="Etkin kaynak"
              value={formatNumber(query.data.summary.enabled)}
              icon="server"
              tone="accent"
              hint="Taramaya açık olarak tanımlı."
            />
            <StatCard
              label="Gerçek veriyle doğrulanan"
              value={formatNumber(query.data.summary.verified)}
              icon="check"
              tone="success"
            />
            <StatCard
              label="Hazırlanan"
              value={formatNumber(query.data.summary.built ?? 0)}
              icon="layers"
              hint="Adaptörü var, canlı doğrulaması henüz yok."
            />
            <StatCard label="Henüz başlamadı" value={formatNumber(query.data.summary.planned)} icon="clock" />
            <StatCard
              label="Sorun yaşayan"
              value={formatNumber(query.data.summary.failing)}
              icon="alert"
              tone={query.data.summary.failing > 0 ? 'warning' : 'neutral'}
            />
          </section>

          <InfoNote title="Durumlar ne demek?">
            <ul className="checklist">
              <li>
                <strong>Son tarama başarılı:</strong> En son deneme başarılı tamamlandı. Bu geçmiş sonucu,
                worker'ın şu anda çalıştığını tek başına göstermez; canlı worker durumu üst bölümde yer alır.
              </li>
              <li>
                <strong>Yöntemi doğrulandı:</strong> Kaynak gerçek veriye erişilerek daha önce kontrol edildi;
                son tarama kaydı yoksa düzenli okuma yapıldığı iddia edilmez.
              </li>
              <li>
                <strong>Uyarlayıcı hazır:</strong> Kaynak için kod hazır, ancak canlı doğrulama/başarılı
                tarama kanıtı henüz yok.
              </li>
              <li>
                <strong>Son tarama sorunlu:</strong> Son denemede kaynağa ulaşılamadı ya da sayfa okunamadı.
                Önceki ilanlar silinmez; kaynak düzelince yeniden taranır.
              </li>
              <li>
                <strong>Elle takip ediliyor:</strong> Bu kaynak otomatik taranmaz; ilanları elle girilir.
              </li>
              <li>
                <strong>Henüz başlamadı:</strong> Bu kurumlara doğrudan bakmıyoruz; ilanları başka
                kaynaklardan kısmen gelebilir.
              </li>
            </ul>
          </InfoNote>

          <InfoNote tone="warning" title="Bilmeniz gereken">
            {query.data.disclaimer}
          </InfoNote>

          <Card
            title="Kaynak listesi"
            description="Aralık planlanan sıklıktır; son deneme ve son başarı ayrı gösterilir."
          >
            <DataTable
              caption="Kaynak listesi ve son tarama durumu"
              head={[
                'Kaynak',
                'Durum',
                'Planlanan aralık',
                'Son başarılı tarama / son deneme',
                'Sorun var mı',
              ]}
            >
              {query.data.sources.map((source) => (
                <tr key={source.key}>
                  <td data-label="Kaynak">
                    <span className="cell-title">{source.name}</span>
                    <span className="cell-subtitle">{source.institution}</span>
                    <span className="cell-subtitle">{source.coverageNote}</span>
                  </td>
                  <td data-label="Durum">
                    {sourceTag(source)}
                    {!source.enabled && <span className="cell-subtitle">kapalı</span>}
                  </td>
                  <td data-label="Planlanan aralık">
                    <span className="cell-num">{source.intervalMinutes} dakikada bir planlı</span>
                  </td>
                  <td data-label="Son başarılı tarama / son deneme">
                    {source.health.lastSuccessAt ? (
                      <>
                        <span>Son başarı: {formatRelative(source.health.lastSuccessAt)}</span>
                        <span className="cell-subtitle">{formatDateTime(source.health.lastSuccessAt)}</span>
                      </>
                    ) : source.lastRun ? (
                      <>
                        <span>Henüz başarılı tarama yok</span>
                        <span className="cell-subtitle">
                          Son deneme: {formatDateTime(source.lastRun.startedAt)}
                        </span>
                      </>
                    ) : (
                      <span className="cell-subtitle">Henüz tarama yapılmadı</span>
                    )}
                    {source.lastRun && (
                      <>
                        <span className="cell-subtitle">
                          Son sonuç: {RUN_STATUS_LABELS[source.lastRun.status] ?? source.lastRun.status} ·{' '}
                          {formatNumber(source.lastRun.itemsFound)} ilan · ortalama süre{' '}
                          {formatDuration(source.health.avgDurationMs)}
                        </span>
                        <span className="cell-subtitle">
                          Sayfa kapsamı:{' '}
                          {source.lastRun.coverageStatus === 'complete'
                            ? 'bu taramada tam'
                            : source.lastRun.coverageStatus === 'partial'
                              ? 'kısmi'
                              : 'doğrulanamadı'}
                          {source.lastRun.coverageNote ? ` — ${source.lastRun.coverageNote}` : ''}
                        </span>
                      </>
                    )}
                    {source.health.successRuns + source.health.failureRuns > 0 && (
                      <span className="cell-subtitle">
                        Son {formatNumber(source.health.successRuns + source.health.failureRuns)} denemenin{' '}
                        {formatNumber(source.health.successRuns)} tanesi başarılı
                      </span>
                    )}
                  </td>
                  <td data-label="Sorun var mı">
                    {source.health.consecutiveFailures > 0 ? (
                      <span className="cell-error">
                        Son {formatNumber(source.health.consecutiveFailures)} denemede ulaşılamadı
                      </span>
                    ) : (
                      <span className="cell-subtitle">Sorun yok</span>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          </Card>

          <Card
            title="Henüz başlamadığımız kurumlar"
            description="Bu kurumların ilanları şimdilik başka kaynaklardan geliyor; kendi sayfalarına doğrudan bakmaya başlamadık."
          >
            {query.data.planned.length === 0 ? (
              <EmptyState
                icon="check"
                title="Başlanmamış kurum kalmadı"
                description="Bildiğimiz kurumların tamamı listede."
              />
            ) : (
              <ul className="report-list">
                {query.data.planned.map((planned) => (
                  <li className="report-list-item" key={planned.id}>
                    <div>
                      <strong>{planned.name}</strong>
                      <span className="cell-subtitle">{planned.institution}</span>
                      {planned.indirectCoverage && (
                        <span className="cell-subtitle">
                          Şimdilik şuradan geliyor: {planned.indirectCoverage}
                        </span>
                      )}
                      <span className="cell-subtitle">{planned.note}</span>
                    </div>
                    <div className="report-list-meta">
                      {planned.candidateUrl ? (
                        <a
                          className="board-text-link"
                          href={planned.candidateUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Kurumun sayfası <Icon name="external" size={13} />
                        </a>
                      ) : (
                        <span className="cell-subtitle">Kurumun sayfası kayıtlı değil</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="text-muted-sm">
            Listede eksik olduğunu düşündüğünüz bir kurum varsa bize yazın:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        </>
      )}
    </div>
  );
}
