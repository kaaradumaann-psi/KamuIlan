/**
 * İlan detayı.
 *
 * Gösterilen her alan kayıttan gelir; her alanın hangi katmandan (liste, detay,
 * belge, bağlantı) alındığı "alan kaynağı" olarak listelenir. Bilinmeyen alanlar
 * "belirtilmemiş" olarak işaretlenir ve belirsizlik uyarıları gösterilir.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import {
  EDUCATION_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  JOB_STATUS_LABELS,
  confidenceLabel,
  deadlineLabel,
  formatDate,
  formatDateOnly,
  formatDateTime,
  formatNumber,
  turkishCapitalize,
} from '../lib/format';
import type { PublicJobDetail } from '../types';
import { Badge, Card, DefinitionList, ErrorNotice, InfoNote, ProgressBar, Spinner } from '../components/ui';

const FIELD_LABELS: Record<string, string> = {
  title: 'Başlık',
  institution: 'Kurum',
  unit: 'Birim',
  quota: 'Kontenjan',
  city: 'İl',
  district: 'İlçe',
  applicationStartAt: 'Başvuru başlangıcı',
  applicationEndAt: 'Son başvuru',
  applicationEndDate: 'Son başvuru (gün)',
  applicationUrl: 'Başvuru bağlantısı',
  publishedAt: 'Yayım tarihi',
  originalRefNo: 'Resmî ilan no',
  employmentType: 'İstihdam türü',
};

const SOURCE_KIND_LABELS: Record<string, string> = {
  listing: 'liste sayfası',
  detail: 'ilan detay sayfası',
  document: 'ek belge (PDF)',
  link: 'ilan içi bağlantı',
  unstated: 'belirtilmemiş',
};

export function JobDetailPage(): ReactNode {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.get<PublicJobDetail>(`/api/jobs/${encodeURIComponent(id)}`),
    enabled: id.length > 0,
    retry: 0,
  });

  if (query.isLoading) return <Spinner label="İlan yükleniyor…" />;
  if (query.isError) {
    return (
      <div className="space-y-3">
        <ErrorNotice message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        <Link to="/ilanlar" className="btn-secondary">
          İlan listesine dön
        </Link>
      </div>
    );
  }
  const job = query.data;
  if (!job) return null;

  const requirements = job.requirements;

  return (
    <article className="space-y-4">
      <header className="card">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{EMPLOYMENT_TYPE_LABELS[job.employmentType] ?? job.employmentType}</Badge>
          <Badge tone={job.status === 'active' ? 'success' : job.status === 'upcoming' ? 'info' : 'neutral'}>
            {JOB_STATUS_LABELS[job.status] ?? job.status}
          </Badge>
          <Badge
            tone={job.deadline.state === 'closing-soon' ? 'warning' : job.deadline.state === 'closed' ? 'danger' : 'neutral'}
          >
            {deadlineLabel(job.deadline.daysLeft, job.deadline.state)}
          </Badge>
          {job.provenance === 'sample' && <Badge tone="warning">örnek veri (gerçek ilan değil)</Badge>}
          <Badge tone={job.classification.confidence >= 0.8 ? 'success' : 'neutral'}>
            sınıflandırma: {confidenceLabel(job.classification.confidence)}
          </Badge>
        </div>
        <h1 className="mt-2 text-xl font-semibold">{job.title}</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{job.institution}</p>
        {job.unit && <p className="text-sm text-slate-600 dark:text-slate-400">Birim: {job.unit}</p>}

        <div className="mt-3 flex flex-wrap gap-2">
          <a className="btn-primary" href={job.detailUrl} target="_blank" rel="noreferrer noopener">
            Resmî ilanı aç
          </a>
          {job.applicationUrl ? (
            <a className="btn-secondary" href={job.applicationUrl} target="_blank" rel="noreferrer noopener">
              Başvuru bağlantısı
            </a>
          ) : (
            <span className="btn-secondary cursor-not-allowed" aria-disabled="true" title="İlanda başvuru bağlantısı belirtilmemiş">
              Başvuru bağlantısı belirtilmemiş
            </span>
          )}
        </div>
      </header>

      {job.uncertainties.length > 0 && (
        <InfoNote tone="warning">
          <strong>Belirsizlikler:</strong> {job.uncertainties.join(' ')}
        </InfoNote>
      )}

      <Card title="Temel bilgiler">
        <DefinitionList
          items={[
            { term: 'Kontenjan', value: formatNumber(job.quota) },
            { term: 'İl / İlçe', value: [job.city, job.district].filter(Boolean).join(' / ') || 'belirtilmemiş' },
            { term: 'Unvan(lar)', value: job.titles.length > 0 ? job.titles.join(', ') : 'belirtilmemiş' },
            { term: 'Başvuru başlangıcı', value: job.applicationStartAt ? formatDateTime(job.applicationStartAt) : 'belirtilmemiş' },
            { term: 'Son başvuru', value: job.applicationEndAt ? formatDateTime(job.applicationEndAt) : 'belirtilmemiş' },
            { term: 'Yayım tarihi', value: job.publishedAt ? formatDate(job.publishedAt) : 'belirtilmemiş' },
            { term: 'Resmî ilan no', value: job.originalRefNo ?? 'belirtilmemiş' },
            { term: 'İlk görülme', value: formatDateTime(job.firstSeenAt) },
            { term: 'Son doğrulama', value: job.lastVerifiedAt ? formatDateTime(job.lastVerifiedAt) : 'doğrulanmadı' },
          ]}
        />
      </Card>

      <Card title="Koşullar ve nitelikler" description="Yalnızca ilan metninde açıkça yazan bilgiler; eksik alanlar boş bırakılır.">
        <DefinitionList
          items={[
            {
              term: 'Eğitim düzeyi',
              value:
                requirements.educationLevels.length > 0
                  ? requirements.educationLevels.map((level) => EDUCATION_LABELS[level] ?? level).join(', ')
                  : 'belirtilmemiş',
            },
            { term: 'Bölüm / program', value: requirements.departments.length > 0 ? requirements.departments.join(', ') : 'belirtilmemiş' },
            {
              term: 'KPSS',
              value:
                requirements.kpssScoreTypes.length > 0 || requirements.kpssMinScore !== null
                  ? `${requirements.kpssScoreTypes.join(', ') || 'tür belirtilmemiş'}${
                      requirements.kpssMinScore !== null ? ` — en az ${formatNumber(requirements.kpssMinScore)} puan` : ''
                    }${requirements.kpssYear ? ` (${requirements.kpssYear})` : ''}`
                  : 'belirtilmemiş',
            },
            {
              term: 'Yaş aralığı',
              value:
                requirements.minAge !== null || requirements.maxAge !== null
                  ? `${requirements.minAge ?? ''}${requirements.minAge !== null ? ' – ' : ''}${requirements.maxAge ?? ''}`
                  : 'belirtilmemiş',
            },
            { term: 'Deneyim', value: requirements.minExperienceYears !== null ? `en az ${requirements.minExperienceYears} yıl` : 'belirtilmemiş' },
            { term: 'Yabancı dil', value: requirements.foreignLanguages.length > 0 ? requirements.foreignLanguages.join(', ') : 'belirtilmemiş' },
            { term: 'Sertifika / belge', value: requirements.certificates.length > 0 ? requirements.certificates.join(', ') : 'belirtilmemiş' },
            {
              term: 'Özel koşullar',
              value: requirements.specialConditions.length > 0 ? requirements.specialConditions.join(', ') : 'belirtilmemiş',
            },
          ]}
        />
      </Card>

      {job.attachments.length > 0 && (
        <Card title="Ek belgeler" description="İlan sahibinin yayımladığı dosyalar (içeriği çalıştırılmaz, yalnızca bağlantı verilir).">
          <ul className="space-y-1 text-sm">
            {job.attachments.map((attachment) => (
              <li key={attachment.url}>
                <a href={attachment.url} target="_blank" rel="noreferrer noopener">
                  {attachment.label || turkishCapitalize(attachment.kind)} ({attachment.kind.toUpperCase()})
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Kaynaklar ve doğrulama" description="Bu ilanın bulunduğu tüm kaynaklar; hiçbiri diğerinin yerine geçmez.">
        <ul className="space-y-2 text-sm">
          {job.sources.map((source) => (
            <li key={source.sourceKey + source.url} className="rounded-lg border border-slate-200 p-2 dark:border-slate-800">
              <p className="font-medium">{source.sourceName ?? source.sourceKey}</p>
              <a href={source.url} target="_blank" rel="noreferrer noopener" className="break-all text-xs">
                {source.url}
              </a>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                İlk görülme: {formatDateTime(source.firstSeenAt)} · Son görülme: {formatDateTime(source.lastSeenAt)} ·{' '}
                {source.active ? 'kaynakta aktif' : 'kaynakta görünmüyor'}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Alan bazlı kaynak izi" description="Her alanın hangi katmandan çıkarıldığı.">
        <div className="space-y-2">
          <ProgressBar value={job.extractionConfidence} label="Çıkarım güveni" />
          <ul className="space-y-1 text-sm">
            {Object.entries(job.fieldSources).map(([field, source]) => (
              <li key={field} className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{FIELD_LABELS[field] ?? field}</span>
                <Badge tone="neutral">{SOURCE_KIND_LABELS[source.kind] ?? source.kind}</Badge>
                {source.snippet && <span className="text-xs text-slate-600 dark:text-slate-400">“{source.snippet.slice(0, 120)}”</span>}
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <Card title="İlan metni özeti" description="Ham metinden alıntı; biçimlendirme uygulanmaz (güvenlik gereği).">
        <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{job.textExcerpt || 'Metin alınamadı.'}</p>
      </Card>

      <Card title="Sınıflandırma kararı" description="Kural motoru kararı; şüpheli kayıtlar kullanıcıya gösterilmez.">
        <p className="text-sm">
          Karar: <strong>{job.classification.decision === 'accept' ? 'kabul' : job.classification.decision}</strong> · Tür:{' '}
          {EMPLOYMENT_TYPE_LABELS[job.classification.employmentType] ?? job.classification.employmentType} · Sürüm:{' '}
          {job.classification.version}
        </p>
        {job.classification.reasons.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {job.classification.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </Card>

      <InfoNote>
        Kesin bilgi için ilanın resmî kaynağını doğrulayın. KamuRadar yalnızca yayımlanmış ilanları toplar; başvuru koşullarındaki
        değişiklikler kaynağın kendisinde olur.
        {job.applicationEndDate ? ` Son başvuru günü: ${formatDateOnly(job.applicationEndDate)}.` : ''}
      </InfoNote>
    </article>
  );
}
