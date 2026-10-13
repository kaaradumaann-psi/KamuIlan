/**
 * İlan detayı.
 *
 * Gösterilen her bilgi ilandan gelir; bilinmeyenler "belirtilmemiş" olarak
 * işaretlenir, kesin olmayanlar ayrıca uyarılır. Mühendislik ayrıntısı
 * (alan kaynağı, sınıflandırma kararı) aday ekranında gösterilmez; bu bilgi
 * yönetim/inceleme ekranlarında durur.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import {
  EDUCATION_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  JOB_STATUS_LABELS,
  deadlineLabel,
  formatDate,
  formatDateOnly,
  formatDateTime,
  formatNumber,
  turkishCapitalize,
} from '../lib/format';
import type { PublicJobDetail } from '../types';
import { Card, EmptyState, ErrorNotice, InfoNote, LoadingCard, Tag, DefinitionList } from '../components/ui';
import { Icon } from '../components/Icon';
import { SaveJobButton } from '../components/SaveJobButton';
import { downloadDeadlineIcs } from '../lib/calendar';

export function JobDetailPage(): ReactNode {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.get<PublicJobDetail>(`/api/jobs/${encodeURIComponent(id)}`),
    enabled: id.length > 0,
    retry: 0,
  });

  if (query.isLoading) return <LoadingCard title="İlan yükleniyor…" />;
  if (query.isError) {
    return (
      <div className="page-stack">
        <ErrorNotice message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        <Link className="btn-secondary" to="/ilanlar">
          <Icon name="left" size={15} />
          <span>İlan listesine dön</span>
        </Link>
      </div>
    );
  }
  const job = query.data;
  if (!job) {
    return (
      <EmptyState
        icon="info"
        title="İlan bulunamadı"
        description="Bağlantı eski olabilir; kayıt kaldırılmış ya da kimliği değişmiş olabilir."
        action={
          <Link className="btn-primary" to="/ilanlar">
            İlanlara göz at
          </Link>
        }
      />
    );
  }

  const requirements = job.requirements;

  return (
    <article className="page-stack">
      <header className="detail-head card-elevated">
        <div className="detail-head-tags">
          <Tag tone="accent">{EMPLOYMENT_TYPE_LABELS[job.employmentType] ?? job.employmentType}</Tag>
          <Tag tone={job.status === 'active' ? 'success' : job.status === 'upcoming' ? 'info' : 'neutral'}>
            {JOB_STATUS_LABELS[job.status] ?? job.status}
          </Tag>
          <Tag
            tone={
              job.deadline.state === 'closing-soon'
                ? 'warning'
                : job.deadline.state === 'closed'
                  ? 'neutral'
                  : 'info'
            }
          >
            {deadlineLabel(job.deadline.daysLeft, job.deadline.state)}
          </Tag>
          {job.provenance === 'sample' && <Tag tone="warning">örnek veri (gerçek ilan değil)</Tag>}
        </div>

        <h1 className="page-title">{job.title}</h1>
        <p className="detail-institution">
          <Icon name="building" size={15} /> {job.institution}
          {job.unit ? ` · ${job.unit}` : ''}
        </p>

        <div className="detail-actions">
          <a className="btn-primary" href={job.detailUrl} target="_blank" rel="noreferrer noopener">
            <Icon name="external" size={15} />
            <span>Resmî ilanı aç</span>
          </a>
          {job.applicationUrl ? (
            <a className="btn-secondary" href={job.applicationUrl} target="_blank" rel="noreferrer noopener">
              <Icon name="link" size={15} />
              <span>Başvuru bağlantısı</span>
            </a>
          ) : (
            <span
              className="btn-secondary is-disabled"
              aria-disabled="true"
              title="İlanda başvuru bağlantısı belirtilmemiş"
            >
              <Icon name="info" size={15} />
              <span>Başvuru bağlantısı belirtilmemiş</span>
            </span>
          )}
          <SaveJobButton jobId={job.id} />
          {job.applicationEndDate && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                downloadDeadlineIcs({
                  id: job.id,
                  title: job.title,
                  institution: job.institution,
                  applicationEndDate: job.applicationEndDate,
                  applicationEndAt: job.applicationEndAt,
                  detailUrl: job.detailUrl,
                })
              }
              title="Son başvuru gününü takviminize ekleyin (1 gün önce hatırlatır)"
            >
              <Icon name="calendar" size={15} />
              <span>Son günü takvime ekle</span>
            </button>
          )}
          <Link className="btn-secondary" to="/ilanlar">
            <Icon name="search" size={15} />
            <span>Benzer ilanları ara</span>
          </Link>
        </div>
      </header>

      {job.uncertainties.length > 0 && (
        <InfoNote tone="warning" title="Kesin olmayan bilgiler">
          {job.uncertainties.join(' ')}
        </InfoNote>
      )}

      <Card title="Temel bilgiler" description="Bu bilgiler ilanın kendisinden alınır; yazmayan yerde belirtilmemiş görürsünüz.">
        <DefinitionList
          items={[
            { term: 'Kontenjan', value: formatNumber(job.quota) },
            {
              term: 'İl / İlçe',
              value: [job.city, job.district].filter(Boolean).join(' / ') || 'belirtilmemiş',
            },
            { term: 'Unvan(lar)', value: job.titles.length > 0 ? job.titles.join(', ') : 'belirtilmemiş' },
            {
              term: 'Başvuru başlangıcı',
              value: job.applicationStartAt ? formatDateTime(job.applicationStartAt) : 'belirtilmemiş',
            },
            {
              term: 'Son başvuru',
              value: job.applicationEndAt ? formatDateTime(job.applicationEndAt) : 'belirtilmemiş',
            },
            { term: 'Yayım tarihi', value: job.publishedAt ? formatDate(job.publishedAt) : 'belirtilmemiş' },
            { term: 'Resmî ilan no', value: job.originalRefNo ?? 'belirtilmemiş' },
            { term: 'Başvuru yöntemi', value: job.applicationMethod ?? 'belirtilmemiş' },
            { term: 'Burada ilk görülme', value: formatDateTime(job.firstSeenAt) },
            {
              term: 'Son kontrol',
              value: job.lastVerifiedAt ? formatDateTime(job.lastVerifiedAt) : 'henüz yapılmadı',
              hint: 'İlanın hâlâ yayında olduğunu en son ne zaman kontrol ettik?',
            },
          ]}
        />
      </Card>

      <Card
        title="Başvuru kontrol listesi"
        description="Başvurmadan önce bu ilanın gerçek alanlarına göre kontrol edin."
      >
        <ol className="checklist">
          <li>
            <strong>Resmî metni okuyun:</strong> Yukarıdaki "Resmî ilanı aç" bağlantısı tek kesin kaynaktır;
            özet burada, koşullar kaynaktadır.
          </li>
          <li>
            <strong>Son günü not edin:</strong>{' '}
            {job.applicationEndDate
              ? `Son başvuru ${formatDateOnly(job.applicationEndDate)}${job.applicationEndAt ? ` (${formatDateTime(job.applicationEndAt)})` : ''}. "Son günü takvime ekle" ile hatırlatma kurabilirsiniz.`
              : 'Bu ilanda son başvuru tarihi belirtilmemiş; resmî metinden doğrulayın.'}
          </li>
          <li>
            <strong>Başvuru yolu:</strong>{' '}
            {job.applicationUrl
              ? 'Başvuru bağlantısı ilanda verilmiş; süresi içinde o adresten ilerleyin.'
              : job.applicationMethod
                ? job.applicationMethod
                : 'Başvuru bağlantısı/yöntemi ilanda ayrıca belirtilmemiş; resmî metindeki başvuru bölümüne bakın.'}
          </li>
          <li>
            <strong>Belgeler:</strong>{' '}
            {job.attachments.length > 0
              ? `İlanın ${job.attachments.length} ek belgesi aşağıda listeli; kılavuzu indirmeden başvurmayın.`
              : 'Bu kayıtta ek belge yok; istenen belgeler resmî metinde yazar.'}
          </li>
          <li>
            <strong>Değişiklik takibi:</strong> Bu ilanı kaydederseniz listenizde tutarsınız; bildirim
            tercihiniz açıksa tarih/kontenjan/koşul değişiklikleri e-posta ile de bildirilir.
          </li>
        </ol>
      </Card>

      <Card
        title="Koşullar ve nitelikler"
        description="Yalnızca ilanda açıkça yazan koşullar; yazmayanlar belirtilmemiş görünür."
      >
        <DefinitionList
          items={[
            {
              term: 'Eğitim düzeyi',
              value:
                requirements.educationLevels.length > 0
                  ? requirements.educationLevels.map((level) => EDUCATION_LABELS[level] ?? level).join(', ')
                  : 'belirtilmemiş',
            },
            {
              term: 'Bölüm / program',
              value:
                requirements.departments.length > 0 ? requirements.departments.join(', ') : 'belirtilmemiş',
            },
            {
              term: 'KPSS',
              value:
                requirements.kpssScoreTypes.length > 0 || requirements.kpssMinScore !== null
                  ? `${requirements.kpssScoreTypes.join(', ') || 'tür belirtilmemiş'}${
                      requirements.kpssMinScore !== null
                        ? ` — en az ${formatNumber(requirements.kpssMinScore)} puan`
                        : ''
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
            {
              term: 'Deneyim',
              value:
                requirements.minExperienceYears !== null
                  ? `en az ${requirements.minExperienceYears} yıl`
                  : 'belirtilmemiş',
            },
            {
              term: 'Yabancı dil',
              value:
                requirements.foreignLanguages.length > 0
                  ? requirements.foreignLanguages.join(', ')
                  : 'belirtilmemiş',
            },
            {
              term: 'Sertifika / belge',
              value:
                requirements.certificates.length > 0 ? requirements.certificates.join(', ') : 'belirtilmemiş',
            },
            {
              term: 'Özel koşullar',
              value:
                requirements.specialConditions.length > 0
                  ? requirements.specialConditions.join(', ')
                  : 'belirtilmemiş',
            },
          ]}
        />
      </Card>

      {job.attachments.length > 0 && (
        <Card
          title="Ek belgeler"
          description="Kurumun yayımladığı dosyalar; bağlantıya tıklayınca kurumun sitesinde açılır."
        >
          <ul className="link-row">
            {job.attachments.map((attachment) => (
              <li key={attachment.url}>
                <a href={attachment.url} target="_blank" rel="noreferrer noopener">
                  <Icon name="file" size={15} />
                  <span>{attachment.label || turkishCapitalize(attachment.kind)}</span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Bu ilanı nereden aldık?"
        description="İlanın yayımlandığı resmî adresler. Kesin bilgi için her zaman asıl adrese bakın."
      >
        <ul className="provenance-list">
          {job.sources.map((source) => (
            <li className="provenance-source" key={source.sourceKey + source.url}>
              <div className="provenance-head">
                <strong>{source.sourceName ?? source.sourceKey}</strong>
                <Tag tone={source.active ? 'success' : 'neutral'}>
                  {source.active ? 'hâlâ yayında' : 'şu an görünmüyor'}
                </Tag>
              </div>
              <a href={source.url} target="_blank" rel="noreferrer noopener" className="provenance-snippet">
                {source.url}
              </a>
              <p className="text-muted-sm">
                Burada ilk kez: {formatDateTime(source.firstSeenAt)} · En son:{' '}
                {formatDateTime(source.lastSeenAt)}
                {source.publishedAt ? ` · Yayımlanma: ${formatDate(source.publishedAt)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="İlan metninden özet" description="İlanın kendi metninden bir bölüm; tamamı resmî adreste.">
        <p className="job-excerpt">{job.textExcerpt || 'Metin alınamadı.'}</p>
      </Card>

      <InfoNote title="Kesin bilgi kaynağındadır">
        Başvuru koşullarını ilanın resmî kaynağından doğrulayın; değişiklikler önce kaynakta olur. Kamuİlan
        yalnızca yayımlanmış ilanları toplar ve gördüğü son hâli gösterir.
        {job.applicationEndDate ? ` Son başvuru günü: ${formatDateOnly(job.applicationEndDate)}.` : ''}
      </InfoNote>
    </article>
  );
}
