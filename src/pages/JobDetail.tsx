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
import { useAuth } from '../lib/session';
import { explainProfileMatch } from '../lib/profile-match';
import {
  deadlineLabel,
  educationLabel,
  employmentTypeLabel,
  formatDate,
  formatDateMaybeTime,
  formatDateOnly,
  formatNumber,
  jobStatusLabel,
  turkishCapitalize,
} from '../lib/format';
import type { PreferencesResponse, PublicJobDetail } from '../types';
import { Card, EmptyState, ErrorNotice, InfoNote, LoadingCard, Tag, DefinitionList } from '../components/ui';
import { Icon } from '../components/Icon';
import { SaveJobButton } from '../components/SaveJobButton';
import { downloadDeadlineIcs } from '../lib/calendar';
import { jobPostingJsonLd, serializeJsonLd, usePageMeta } from '../lib/page-meta';

/** İlanda yazmayan alanın görünen değeri. */
const UNSTATED = 'belirtilmemiş';

type DefinitionItem = { term: string; value: string };

/**
 * Yazmayan satırları gizler; `keep` içindeki temel satırlar (kontenjan, il,
 * son başvuru) yazmasa da "belirtilmemiş" olarak kalır. Böylece kullanıcı
 * onlarca "belirtilmemiş" satırı okumak zorunda kalmaz.
 */
function withoutUnstated(items: DefinitionItem[], keep: string[] = []): DefinitionItem[] {
  return items.filter((item) => item.value !== UNSTATED || keep.includes(item.term));
}

export function JobDetailPage(): ReactNode {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const preferences = useQuery({
    queryKey: ['preferences'],
    queryFn: ({ signal }) =>
      api.get<PreferencesResponse>('/api/notifications/preferences', undefined, signal),
    enabled: Boolean(user),
    staleTime: 60_000,
    retry: 0,
  });
  const query = useQuery({
    queryKey: ['job', id],
    queryFn: ({ signal }) =>
      api.get<PublicJobDetail>(`/api/jobs/${encodeURIComponent(id)}`, undefined, signal),
    enabled: id.length > 0,
    retry: 0,
  });
  usePageMeta({
    title: query.data ? `${query.data.title} — ${query.data.institution}` : null,
    description: query.data
      ? [
          query.data.institution,
          query.data.city,
          query.data.applicationEndDate ? `son başvuru ${query.data.applicationEndDate}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null,
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
  const conditions = withoutUnstated([
    {
      term: 'Eğitim düzeyi',
      value:
        requirements.educationLevels.length > 0
          ? requirements.educationLevels.map((level) => educationLabel(level)).join(', ')
          : UNSTATED,
    },
    {
      term: 'Bölüm / program',
      value: requirements.departments.length > 0 ? requirements.departments.join(', ') : UNSTATED,
    },
    {
      term: 'KPSS',
      value:
        requirements.kpssScoreTypes.length > 0 || requirements.kpssMinScore !== null
          ? `${requirements.kpssScoreTypes.join(', ') || 'tür belirtilmemiş'}${
              requirements.kpssMinScore !== null ? ` — en az ${formatNumber(requirements.kpssMinScore)} puan` : ''
            }${requirements.kpssYear ? ` (${requirements.kpssYear})` : ''}`
          : UNSTATED,
    },
    {
      term: 'ÖSYM nitelik kodu',
      value:
        (requirements.qualificationCodes ?? []).length > 0 ? requirements.qualificationCodes.join(', ') : UNSTATED,
    },
    {
      term: 'Yaş aralığı',
      value:
        requirements.minAge !== null && requirements.maxAge !== null
          ? `${requirements.minAge} – ${requirements.maxAge}`
          : requirements.minAge !== null
            ? `en az ${requirements.minAge}`
            : requirements.maxAge !== null
              ? `en çok ${requirements.maxAge}`
              : UNSTATED,
    },
    {
      term: 'Deneyim',
      value: requirements.minExperienceYears !== null ? `en az ${requirements.minExperienceYears} yıl` : UNSTATED,
    },
    {
      term: 'Yabancı dil',
      value: requirements.foreignLanguages.length > 0 ? requirements.foreignLanguages.join(', ') : UNSTATED,
    },
    {
      term: 'Sertifika / belge',
      value: requirements.certificates.length > 0 ? requirements.certificates.join(', ') : UNSTATED,
    },
    {
      term: 'Özel koşullar',
      value: requirements.specialConditions.length > 0 ? requirements.specialConditions.join(', ') : UNSTATED,
    },
  ]);
  const personalization = preferences.data?.preference;
  const profileMatch = personalization?.profilePersonalizationEnabled
    ? explainProfileMatch(job, personalization.candidateProfile)
    : null;
  const profileSignalLabel =
    profileMatch?.signal === 'high'
      ? 'Güçlü sinyal'
      : profileMatch?.signal === 'medium'
        ? 'Orta sinyal'
        : profileMatch?.signal === 'low'
          ? 'Sınırlı sinyal'
          : 'Yeterli veri yok';
  const profileSignalTone =
    profileMatch?.signal === 'high'
      ? 'success'
      : profileMatch?.signal === 'medium'
        ? 'info'
        : profileMatch?.signal === 'low'
          ? 'warning'
          : 'neutral';

  const structuredData = jobPostingJsonLd(job, `${window.location.origin}/ilanlar/${encodeURIComponent(job.id)}`);

  return (
    <article className="page-stack">
      {structuredData && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }} />
      )}
      <header className="detail-head card-elevated">
        <div className="detail-head-tags">
          {job.kind === 'process' ? (
            <Tag tone="info">Süreç duyurusu (yeni ilan değil)</Tag>
          ) : (
            <Tag tone="accent">{employmentTypeLabel(job.employmentType)}</Tag>
          )}
          {/* Süreç duyurusunda başvuru durumu ve son başvuru etiketi gösterilmez: "açık" yanılgısı yaratır. */}
          {job.kind !== 'process' && (
            <>
              <Tag
                tone={job.status === 'active' ? 'success' : job.status === 'upcoming' ? 'info' : 'neutral'}
              >
                {jobStatusLabel(job.status)}
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
            </>
          )}
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
          {job.applicationUrl && (
            <a className="btn-secondary" href={job.applicationUrl} target="_blank" rel="noreferrer noopener">
              <Icon name="link" size={15} />
              <span>Başvuru sayfası</span>
            </a>
          )}
          <SaveJobButton jobId={job.id} />
          {job.applicationEndDate && job.kind !== 'process' && (
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
        {/* Sitedeki TEK sorumluluk notu: başvuru kararı resmî metne dayanır. */}
        <p className="detail-check-note">
          <Icon name="info" size={14} /> Başvurmadan önce resmî ilanı kontrol edin.
        </p>
      </header>

      {personalization?.profilePersonalizationEnabled &&
        (profileMatch ? (
          <Card
            title="Profilinle ilan eşleşmesi"
            description="Profilinizle bu ilan arasındaki ortak noktalar. Resmî uygunluk kararı değildir."
            className="profile-match-card"
          >
            <div className="profile-match-summary">
              <Tag tone={profileSignalTone}>{profileSignalLabel}</Tag>
            </div>
            {profileMatch.reasons.length > 0 && (
              <div>
                <h3>Örtüşen bilgiler</h3>
                <ul className="profile-match-list">
                  {profileMatch.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {profileMatch.caveats.length > 0 && (
              <div>
                <h3>Kontrol edilmesi gerekenler</h3>
                <ul className="profile-match-list profile-match-caveats">
                  {profileMatch.caveats.map((caveat) => (
                    <li key={caveat}>{caveat}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-muted-sm">
              Bu karşılaştırma yalnızca tarayıcınızda yapılır; profiliniz hiçbir yere gönderilmez.
            </p>
            <Link to="/panel">Profil ve gizlilik ayarlarını düzenle</Link>
          </Card>
        ) : (
          <InfoNote title="Profil eşleşmesi için profil bilgisi gerekli">
            Meslek, eğitim veya beceri bilgilerinizi <Link to="/panel">Panelim’de</Link> ekleyebilirsiniz.
            İstediğiniz zaman kişiselleştirmeyi kapatabilirsiniz.
          </InfoNote>
        ))}

      <Card title="Temel bilgiler">
        {job.uncertainties.length > 0 && <p className="text-muted-sm">{job.uncertainties.join(' ')}</p>}
        <DefinitionList
          items={withoutUnstated(
            [
              { term: 'Kontenjan', value: job.quota !== null ? formatNumber(job.quota) : UNSTATED },
              {
                term: 'İl / İlçe',
                value: [job.city, job.district].filter(Boolean).join(' / ') || UNSTATED,
              },
              {
                term: 'Unvan(lar)',
                value: job.titles.length > 0 ? job.titles.join(', ') : UNSTATED,
              },
              {
                term: 'Başvuru başlangıcı',
                value: job.applicationStartAt ? formatDateMaybeTime(job.applicationStartAt) : UNSTATED,
              },
              {
                term: 'Son başvuru',
                // Saat bilinmiyorsa bile GÜN bilinir; günü göstermemek bilgiyi
                // saklamak olurdu (ör. yalnızca "30.10.2026" yazan ilanlar).
                value: job.applicationEndAt
                  ? formatDateMaybeTime(job.applicationEndAt)
                  : job.applicationEndDate
                    ? formatDateOnly(job.applicationEndDate)
                    : UNSTATED,
              },
              {
                term: 'Yayım tarihi',
                value: job.publishedAt ? formatDate(job.publishedAt) : UNSTATED,
              },
              { term: 'Resmî ilan no', value: job.originalRefNo ?? UNSTATED },
              { term: 'Başvuru yöntemi', value: job.applicationMethod ?? UNSTATED },
            ],
            ['Kontenjan', 'İl / İlçe', 'Son başvuru'],
          )}
        />
      </Card>

      {(job.openings?.length ?? 0) > 0 && (
        <Card title="Kadrolar">
          <div className="table-scroll">
            <table className="openings-table">
              <caption className="sr-only">Unvan, kontenjan ve nitelik kırılımı</caption>
              <thead>
                <tr>
                  <th scope="col">Unvan</th>
                  <th scope="col">Kontenjan</th>
                  <th scope="col">Sınıf / derece</th>
                  <th scope="col">Niteliği</th>
                </tr>
              </thead>
              <tbody>
                {job.openings?.map((opening, index) => (
                  <tr key={`${opening.title}-${index}`}>
                    <th scope="row" data-label="Unvan">
                      {opening.title}
                    </th>
                    <td data-label="Kontenjan">{formatNumber(opening.quota)}</td>
                    <td data-label="Sınıf / derece">
                      {[opening.serviceClass, opening.degree ? `${opening.degree}. derece` : null]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td data-label="Niteliği">{opening.qualification ?? UNSTATED}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Toplam</th>
                  <td data-label="Kontenjan">
                    {formatNumber(job.openings?.reduce((sum, opening) => sum + opening.quota, 0) ?? 0)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      <Card title="Koşullar ve nitelikler">
        {conditions.length > 0 ? (
          <DefinitionList items={conditions} />
        ) : (
          <p className="text-muted-sm">Koşullar özetlenemedi; resmî ilan metnine bakın.</p>
        )}
      </Card>

      {job.attachments.length > 0 && (
        <Card title="Ek belgeler">
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

      {job.textExcerpt && (
        <Card title="İlandan kısa alıntı">
          <p className="job-excerpt">{job.textExcerpt}</p>
        </Card>
      )}

      <Card title="Yayımlandığı yer">
        <ul className="provenance-list">
          {job.sources.map((source) => (
            <li className="provenance-source" key={source.sourceKey + source.url}>
              <div className="provenance-head">
                <strong>{source.sourceName ?? source.sourceKey}</strong>
                <Tag tone={source.active ? 'success' : 'neutral'}>
                  {source.active ? 'Yayında' : 'Artık görünmüyor'}
                </Tag>
              </div>
              <a href={source.url} target="_blank" rel="noreferrer noopener" className="provenance-snippet">
                {source.url}
              </a>
              {source.publishedAt && (
                <p className="text-muted-sm">Yayımlanma: {formatDate(source.publishedAt)}</p>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </article>
  );
}
