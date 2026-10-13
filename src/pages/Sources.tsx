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
  SOURCE_STATUS_LABELS,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
} from '../lib/format';
import type { SourceListResponse } from '../types';
import { Card, DataTable, EmptyState, ErrorNotice, InfoNote, LoadingCard, StatCard, Tag } from '../components/ui';
import { Icon } from '../components/Icon';

/** Kaynak etiketi: çalışıyor / hazırlanıyor / diğer durumlar ayrımı korunur. */
function sourceTag(source: SourceListResponse['sources'][number]): ReactNode {
  if (source.verified) return <Tag tone="success" icon="check">ilanları düzenli okunuyor</Tag>;
  if (source.built) return <Tag tone="warning" icon="info">hazırlanıyor</Tag>;
  return <Tag tone="neutral">{SOURCE_STATUS_LABELS[source.status] ?? source.status}</Tag>;
}

export function SourcesPage(): ReactNode {
  const query = useQuery({ queryKey: ['sources'], queryFn: () => api.get<SourceListResponse>('/api/sources') });

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-text">
          <span className="kicker">İlan kaynakları</span>
          <h1 className="page-title">İlanları nereden alıyoruz?</h1>
          <p className="info-lede">
            Her ilanı bulamayabiliriz; bunu saklamıyoruz. Aşağıda hangi kurumlara düzenli baktığımızı,
            hangilerine henüz başlamadığımızı ve en son ne zaman baktığımızı görürsünüz.
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
            <StatCard label="İzlenen" value={formatNumber(query.data.summary.enabled)} icon="server" tone="accent" />
            <StatCard
              label="Çalıştığı kanıtlanan"
              value={formatNumber(query.data.summary.verified)}
              icon="check"
              tone="success"
            />
            <StatCard
              label="Hazırlanan"
              value={formatNumber(query.data.summary.built ?? 0)}
              icon="layers"
              hint="Henüz düzenli okunmuyor."
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
                <strong>İlanları düzenli okunuyor:</strong> Bu kurumun ilan sayfasına düzenli bakıyoruz ve
                ilanları gerçekten okuyabildiğimizi gördük.
              </li>
              <li>
                <strong>Hazırlanıyor:</strong> Bağlantı üzerinde çalışıyoruz; henüz düzenli okumuyoruz.
                Bu ikisi aynı şey değildir, o yüzden ayrı gösteriyoruz.
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

          <Card title="Baktığımız kaynaklar" description="Son kontrol bilgileri günceldir.">
            <DataTable
              caption="Kaynak listesi ve durumu"
              head={['Kaynak', 'Durum', 'Ne sıklıkla bakılıyor', 'Son kontrol', 'Sorun var mı']}
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
                    <span className="cell-subtitle">
                      {SOURCE_STATUS_LABELS[source.status] ?? source.status}
                      {source.enabled ? '' : ' · kapalı'}
                    </span>
                  </td>
                  <td data-label="Ne sıklıkla bakılıyor">
                    <span className="cell-num">{source.intervalMinutes} dakikada bir</span>
                  </td>
                  <td data-label="Son kontrol">
                    {source.health.lastSuccessAt ? (
                      <>
                        <span>{formatRelative(source.health.lastSuccessAt)}</span>
                        <span className="cell-subtitle">{formatDateTime(source.health.lastSuccessAt)}</span>
                      </>
                    ) : (
                      <span className="cell-subtitle">henüz bakılmadı</span>
                    )}
                    {source.lastRun && (
                      <span className="cell-subtitle">
                        Son bakışta: {RUN_STATUS_LABELS[source.lastRun.status] ?? source.lastRun.status} ·{' '}
                        {formatNumber(source.lastRun.itemsFound)} ilan · {formatDuration(source.health.avgDurationMs)}
                      </span>
                    )}
                    {source.health.successRuns + source.health.failureRuns > 0 && (
                      <span className="cell-subtitle">
                        Kontroller: {formatNumber(source.health.successRuns)}/
                        {formatNumber(source.health.successRuns + source.health.failureRuns)} başarılı
                      </span>
                    )}
                  </td>
                  <td data-label="Sorun var mı">
                    {source.health.consecutiveFailures > 0 ? (
                      <span className="cell-error">
                        {source.health.consecutiveFailures} denemedir ulaşılamıyor
                      </span>
                    ) : (
                      <span className="cell-subtitle">yok</span>
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
              <EmptyState icon="check" title="Başlanmamış kurum kalmadı" description="Bildiğimiz kurumların tamamı listede." />
            ) : (
              <ul className="report-list">
                {query.data.planned.map((planned) => (
                  <li className="report-list-item" key={planned.id}>
                    <div>
                      <strong>{planned.name}</strong>
                      <span className="cell-subtitle">{planned.institution}</span>
                      {planned.indirectCoverage && (
                        <span className="cell-subtitle">Şimdilik şuradan geliyor: {planned.indirectCoverage}</span>
                      )}
                      <span className="cell-subtitle">{planned.note}</span>
                    </div>
                    <div className="report-list-meta">
                      {planned.candidateUrl ? (
                        <a className="board-text-link" href={planned.candidateUrl} target="_blank" rel="noreferrer noopener">
                          Kurumun sayfası <Icon name="external" size={13} />
                        </a>
                      ) : (
                        <Tag>adresi yok</Tag>
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