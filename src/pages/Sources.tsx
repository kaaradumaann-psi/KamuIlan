/**
 * Kaynaklar ve kapsam sayfası.
 *
 * Amaç: "hangi kaynaklar taranıyor, hangileri planlanıyor, en son ne zaman
 * başarılı tarandı" sorularını açıkça yanıtlamak. Doğrulanmamış kaynaklar
 * "doğrulandı" gibi gösterilmez.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { RUN_STATUS_LABELS, SOURCE_STATUS_LABELS, formatDateTime, formatDuration, formatNumber, formatRelative } from '../lib/format';
import type { SourceListResponse } from '../types';
import { Badge, Card, ErrorNotice, InfoNote, Spinner } from '../components/ui';

export function SourcesPage(): ReactNode {
  const query = useQuery({ queryKey: ['sources'], queryFn: () => api.get<SourceListResponse>('/api/sources') });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Kaynaklar ve kapsam</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Kapsam eksiktir ve bunu saklamıyoruz: aşağıda hangi kaynağın canlı doğrulandığı, hangisinin henüz adaptör beklediği
          listelenir.
        </p>
      </header>

      {query.isLoading && <Spinner label="Kaynaklar yükleniyor…" />}
      {query.isError && <ErrorNotice message="Kaynak listesi alınamadı." onRetry={() => void query.refetch()} />}

      {query.data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Kayıtlı kaynak" value={formatNumber(query.data.summary.total)} />
            <Stat label="Etkin" value={formatNumber(query.data.summary.enabled)} />
            <Stat label="Canlı doğrulanmış" value={formatNumber(query.data.summary.verified)} />
            <Stat label="Adaptörü yazılmış" value={formatNumber(query.data.summary.built ?? 0)} />
            <Stat label="Planlanan" value={formatNumber(query.data.summary.planned)} />
            <Stat label="Üst üste başarısız" value={formatNumber(query.data.summary.failing)} />
          </div>

          <InfoNote>
            "Canlı doğrulanmış", bu ortamdan gerçekten erişilip ilan listesinin okunduğu kanıtlanan kaynaklardır. "Adaptörü
            yazılmış" kaynaklarda kod hazırdır ancak canlı erişim doğrulaması henüz yapılmamıştır; ikisi aynı şey değildir.
          </InfoNote>

          <InfoNote tone="warning">{query.data.disclaimer}</InfoNote>

          <Card title="Taranan kaynaklar" description="Sağlık bilgileri en son tarama kayıtlarından gelir.">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Kaynak listesi ve sağlık durumu</caption>
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    <th scope="col" className="py-2 pr-3">
                      Kaynak
                    </th>
                    <th scope="col" className="py-2 pr-3">
                      Durum
                    </th>
                    <th scope="col" className="py-2 pr-3">
                      Aralık
                    </th>
                    <th scope="col" className="py-2 pr-3">
                      Son başarılı tarama
                    </th>
                    <th scope="col" className="py-2">
                      Hata
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.sources.map((source) => (
                    <tr key={source.key} className="border-t border-slate-200 align-top dark:border-slate-800">
                      <td className="py-3 pr-3">
                        <p className="font-medium">{source.name}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{source.institution}</p>
                        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{source.coverageNote}</p>
                        <p className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400">{source.key}</p>
                      </td>
                      <td className="py-3 pr-3">
                        <Badge tone={source.verified ? 'success' : source.built ? 'warning' : source.enabled ? 'info' : 'neutral'}>
                          {source.verified ? 'canlı doğrulandı' : source.built ? 'adaptör hazır, doğrulanmadı' : SOURCE_STATUS_LABELS[source.status] ?? source.status}
                        </Badge>
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          {SOURCE_STATUS_LABELS[source.status] ?? source.status}
                          {source.enabled ? '' : ' · devre dışı'}
                        </p>
                      </td>
                      <td className="py-3 pr-3">{source.intervalMinutes} dk</td>
                      <td className="py-3 pr-3">
                        {source.health.lastSuccessAt ? (
                          <>
                            <p>{formatRelative(source.health.lastSuccessAt)}</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(source.health.lastSuccessAt)}</p>
                          </>
                        ) : (
                          <span className="text-slate-500">henüz yok</span>
                        )}
                        {source.lastRun && (
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            Son çalışma: {RUN_STATUS_LABELS[source.lastRun.status] ?? source.lastRun.status} ·{' '}
                            {formatNumber(source.lastRun.itemsFound)} kayıt · {formatDuration(source.health.avgDurationMs)}
                          </p>
                        )}
                      </td>
                      <td className="py-3">
                        {source.health.consecutiveFailures > 0 ? (
                          <span className="text-red-700 dark:text-red-300">
                            {source.health.consecutiveFailures} kez üst üste · {source.health.lastError ?? 'hata ayrıntısı yok'}
                          </span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            title="Planlanan kaynaklar (henüz entegre edilmedi)"
            description="Bu kurumların ilanları kısmen diğer kaynaklardan gelir; kendi sayfaları doğrulanmadan 'entegre' sayılmaz."
          >
            <ul className="space-y-2 text-sm">
              {query.data.planned.map((planned) => (
                <li key={planned.id} className="rounded-lg border border-slate-200 p-2 dark:border-slate-800">
                  <p className="font-medium">{planned.name}</p>
                  <p className="text-xs text-slate-600 dark:text-slate-300">{planned.institution}</p>
                  {planned.indirectCoverage && <p className="mt-1 text-xs">Dolaylı kapsam: {planned.indirectCoverage}</p>}
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{planned.note}</p>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="card">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
