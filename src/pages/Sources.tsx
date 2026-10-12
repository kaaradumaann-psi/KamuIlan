/**
 * Kaynaklar ve kapsam sayfası.
 *
 * Amaç: "hangi kaynaklar taranıyor, hangileri planlanıyor, en son ne zaman
 * başarılı tarandı" sorularını açıkça yanıtlamak. Doğrulanmamış kaynaklar
 * "doğrulandı" gibi gösterilmez; adaptörü yazılmış olmak canlı doğrulama değildir.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
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

/** Kaynak etiketi: doğrulanmış / adaptör hazır / devre dışı ayrımı korunur. */
function sourceTag(source: SourceListResponse['sources'][number]): ReactNode {
  if (source.verified) return <Tag tone="success" icon="check">canlı doğrulandı</Tag>;
  if (source.built) return <Tag tone="warning" icon="info">adaptör hazır, doğrulanmadı</Tag>;
  return <Tag tone="neutral">{SOURCE_STATUS_LABELS[source.status] ?? source.status}</Tag>;
}

export function SourcesPage(): ReactNode {
  const query = useQuery({ queryKey: ['sources'], queryFn: () => api.get<SourceListResponse>('/api/sources') });

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-text">
          <span className="kicker">Kapsam</span>
          <h1 className="page-title">Kaynaklar ve kapsam</h1>
          <p className="info-lede">
            Kapsam eksiktir ve bunu saklamıyoruz: aşağıda hangi kaynağın canlı doğrulandığı, hangisinin henüz adaptör
            beklediği ve hangisinin elle takip edildiği listelenir.
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
            <StatCard label="Kayıtlı kaynak" value={formatNumber(query.data.summary.total)} icon="list" />
            <StatCard label="Etkin" value={formatNumber(query.data.summary.enabled)} icon="server" tone="accent" />
            <StatCard
              label="Canlı doğrulanmış"
              value={formatNumber(query.data.summary.verified)}
              icon="check"
              tone="success"
            />
            <StatCard
              label="Adaptörü yazılmış"
              value={formatNumber(query.data.summary.built ?? 0)}
              icon="layers"
              hint="Canlı doğrulama kanıtı olmayabilir."
            />
            <StatCard label="Planlanan" value={formatNumber(query.data.summary.planned)} icon="clock" />
            <StatCard
              label="Üst üste başarısız"
              value={formatNumber(query.data.summary.failing)}
              icon="alert"
              tone={query.data.summary.failing > 0 ? 'warning' : 'neutral'}
            />
          </section>

          <InfoNote title="Terimler">
            <ul className="checklist">
              <li>
                <strong>Canlı doğrulanmış:</strong> Bu ortamdan gerçekten erişilip ilan listesinin okunduğu kanıtlanan
                kaynak.
              </li>
              <li>
                <strong>Adaptörü yazılmış:</strong> Kod hazır; canlı erişim doğrulaması yapılmamış. İkisi aynı şey
                değildir ve arayüzde ayrı gösterilir.
              </li>
              <li>
                <strong>Planlanan:</strong> Henüz entegre edilmemiş kurum sayfaları; ilanları diğer kaynaklardan
                kısmen gelebilir.
              </li>
            </ul>
          </InfoNote>

          <InfoNote tone="warning" title="Kapsam uyarısı">
            {query.data.disclaimer}
          </InfoNote>

          <Card title="Taranan kaynaklar" description="Sağlık bilgileri en son tarama kayıtlarından gelir.">
            <DataTable
              caption="Kaynak listesi ve sağlık durumu"
              head={['Kaynak', 'Durum', 'Aralık', 'Son başarılı tarama', 'Hata']}
            >
              {query.data.sources.map((source) => (
                <tr key={source.key}>
                  <td data-label="Kaynak">
                    <span className="cell-title">{source.name}</span>
                    <span className="cell-subtitle">{source.institution}</span>
                    <span className="cell-subtitle">{source.coverageNote}</span>
                    <span className="cell-mono">{source.key}</span>
                  </td>
                  <td data-label="Durum">
                    {sourceTag(source)}
                    <span className="cell-subtitle">
                      {SOURCE_STATUS_LABELS[source.status] ?? source.status}
                      {source.enabled ? '' : ' · devre dışı'}
                    </span>
                    {source.verificationEvidence && (
                      <span className="cell-subtitle">Kanıt: {source.verificationEvidence}</span>
                    )}
                  </td>
                  <td data-label="Aralık">
                    <span className="cell-num">{source.intervalMinutes} dk</span>
                  </td>
                  <td data-label="Son başarılı tarama">
                    {source.health.lastSuccessAt ? (
                      <>
                        <span>{formatRelative(source.health.lastSuccessAt)}</span>
                        <span className="cell-subtitle">{formatDateTime(source.health.lastSuccessAt)}</span>
                      </>
                    ) : (
                      <span className="cell-subtitle">henüz yok</span>
                    )}
                    {source.lastRun && (
                      <span className="cell-subtitle">
                        Son çalışma: {RUN_STATUS_LABELS[source.lastRun.status] ?? source.lastRun.status} ·{' '}
                        {formatNumber(source.lastRun.itemsFound)} kayıt · {formatDuration(source.health.avgDurationMs)}
                      </span>
                    )}
                    {source.health.successRuns + source.health.failureRuns > 0 && (
                      <span className="cell-subtitle">
                        Başarı oranı: {formatNumber(source.health.successRuns)}/
                        {formatNumber(source.health.successRuns + source.health.failureRuns)}
                      </span>
                    )}
                  </td>
                  <td data-label="Hata">
                    {source.health.consecutiveFailures > 0 ? (
                      <span className="cell-error">
                        {source.health.consecutiveFailures} kez üst üste · {source.health.lastError ?? 'hata ayrıntısı yok'}
                      </span>
                    ) : (
                      <span className="cell-subtitle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          </Card>

          <Card
            title="Planlanan kaynaklar (henüz entegre edilmedi)"
            description="Bu kurumların ilanları kısmen diğer kaynaklardan gelir; kendi sayfaları doğrulanmadan 'entegre' sayılmaz."
          >
            {query.data.planned.length === 0 ? (
              <EmptyState icon="check" title="Planlanan kaynak kalmadı" description="Tanımlı kurum listesinin tamamı kayıtlı." />
            ) : (
              <ul className="report-list">
                {query.data.planned.map((planned) => (
                  <li className="report-list-item" key={planned.id}>
                    <div>
                      <strong>{planned.name}</strong>
                      <span className="cell-subtitle">{planned.institution}</span>
                      {planned.indirectCoverage && (
                        <span className="cell-subtitle">Dolaylı kapsam: {planned.indirectCoverage}</span>
                      )}
                      <span className="cell-subtitle">{planned.note}</span>
                    </div>
                    <div className="report-list-meta">
                      {planned.candidateUrl ? (
                        <a className="board-text-link" href={planned.candidateUrl} target="_blank" rel="noreferrer noopener">
                          Aday adres <Icon name="external" size={13} />
                        </a>
                      ) : (
                        <Tag>adres belirlenmedi</Tag>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="text-muted-sm">
            Kaynak ekleme ve düzenleme yönetim panelinden yapılır; kaynak kaydı eklemek için kod değişikliği gerekmez.{' '}
            <Link to="/yonetim">Yönetim paneli</Link>
          </p>
        </>
      )}
    </div>
  );
}
