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
  formatDateTime,
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

function evidenceHint(job: PublicJobDetail, field: string): string | undefined {
  const source = job.fieldSources[field];
  if (!source || source.kind === 'unstated') return undefined;
  const origin =
    source.kind === 'listing'
      ? 'Kaynak liste sayfası'
      : source.kind === 'document'
        ? 'Kaynak belgesi'
        : source.kind === 'link'
          ? 'İlan bağlantısı'
          : 'İlan metni';
  return source.snippet
    ? `${origin} kanıtı: “${source.snippet}”`
    : `Kaynak: ${origin.toLocaleLowerCase('tr-TR')}.`;
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
      </header>

      {personalization?.profilePersonalizationEnabled &&
        (profileMatch ? (
          <Card
            title="Profilinle ilan eşleşmesi"
            description="İlan metni ve çıkarılmış koşullardaki ortak işaretleri gösterir; resmî uygunluk veya işe alınma olasılığı değildir."
            className="profile-match-card"
          >
            <div className="profile-match-summary">
              <Tag tone={profileSignalTone}>{profileSignalLabel}</Tag>
              <span className="text-muted-sm">
                Sinyal, yalnızca karşılaştırılabilen alanlara göre hesaplanır.
              </span>
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
              Karşılaştırma bu tarayıcıda yapılır; bu karşılaştırma için profiliniz hiçbir hizmete
              gönderilmez. İlanın resmî metnini ve tüm kadro koşullarını başvuru öncesi kontrol edin.
            </p>
            <Link to="/panel">Profil ve gizlilik ayarlarını düzenle</Link>
          </Card>
        ) : (
          <InfoNote title="Profil eşleşmesi için profil bilgisi gerekli">
            Meslek, eğitim veya beceri bilgilerinizi <Link to="/panel">Panelim’de</Link> ekleyebilirsiniz.
            İstediğiniz zaman kişiselleştirmeyi kapatabilirsiniz.
          </InfoNote>
        ))}

      {job.uncertainties.length > 0 && (
        <InfoNote tone="warning" title="Kesin olmayan bilgiler">
          {job.uncertainties.join(' ')}
        </InfoNote>
      )}

      {job.classification.llmVerified && (
        <InfoNote tone="info" title="Bu ilan ek denetimden geçti">
          Kuralların kararsız kaldığı bu duyuru, yapay zekâ destekli ikinci bir denetimden geçti;
          modelin gösterdiği kanıt ilan metninde birebir doğrulandıktan sonra yayımlandı. Resmî
          başvuru öncesi kaynağın kendi sayfasını kontrol edin.
        </InfoNote>
      )}

      <Card
        title="Temel bilgiler"
        description="Bu bilgiler ilanın kendisinden alınır; yazmayan yerde belirtilmemiş görürsünüz."
      >
        <DefinitionList
          items={[
            { term: 'Kontenjan', value: formatNumber(job.quota), hint: evidenceHint(job, 'quota') },
            {
              term: 'İl / İlçe',
              value: [job.city, job.district].filter(Boolean).join(' / ') || 'belirtilmemiş',
              hint: evidenceHint(job, 'city'),
            },
            {
              term: 'Unvan(lar)',
              value: job.titles.length > 0 ? job.titles.join(', ') : 'belirtilmemiş',
              hint: evidenceHint(job, 'titles'),
            },
            {
              term: 'Başvuru başlangıcı',
              value: job.applicationStartAt ? formatDateMaybeTime(job.applicationStartAt) : 'belirtilmemiş',
              hint: evidenceHint(job, 'applicationStartAt'),
            },
            {
              term: 'Son başvuru',
              // Saat bilinmiyorsa bile GÜN bilinir; günü göstermemek bilgiyi
              // saklamak olurdu (ör. yalnızca "30.10.2026" yazan ilanlar).
              value: job.applicationEndAt
                ? formatDateMaybeTime(job.applicationEndAt)
                : job.applicationEndDate
                  ? formatDateOnly(job.applicationEndDate)
                  : 'belirtilmemiş',
              hint: evidenceHint(job, 'applicationEndDate') ?? evidenceHint(job, 'applicationEndAt'),
            },
            {
              term: 'Yayım tarihi',
              value: job.publishedAt ? formatDate(job.publishedAt) : 'belirtilmemiş',
              hint: evidenceHint(job, 'publishedAt'),
            },
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
              ? `Son başvuru ${formatDateOnly(job.applicationEndDate)}${job.applicationEndAt ? ` (${formatDateMaybeTime(job.applicationEndAt)})` : ''}. "Son günü takvime ekle" ile hatırlatma kurabilirsiniz.`
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
                  ? requirements.educationLevels.map((level) => educationLabel(level)).join(', ')
                  : 'belirtilmemiş',
              hint: evidenceHint(job, 'educationLevels'),
            },
            {
              term: 'Bölüm / program',
              value:
                requirements.departments.length > 0 ? requirements.departments.join(', ') : 'belirtilmemiş',
              hint: evidenceHint(job, 'departments'),
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
              term: 'ÖSYM nitelik kodu',
              value:
                (requirements.qualificationCodes ?? []).length > 0
                  ? requirements.qualificationCodes.join(', ')
                  : 'belirtilmemiş',
              hint: evidenceHint(job, 'qualificationCodes'),
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

      <Card
        title="Kaynak metni"
        description="Kaynak metni yalnızca sunucu tarafındaki sınıflandırma ve alan çıkarımı için işlenir; tam ilan gövdesi bu herkese açık sayfada yayımlanmaz."
      >
        {job.capturedNotice ? (
          <p className="text-muted-sm">
            Kaynak: {job.capturedNotice.sourceName ?? job.capturedNotice.sourceKey} ·{' '}
            {job.capturedNotice.status === 'truncated'
              ? `İç yakalama ${formatNumber(job.capturedNotice.characterCount)} karakterde sınırlandı; güncel ve eksiksiz metin resmî bağlantıdadır.`
              : 'Metin alan çıkarımı için yakalandı; burada yeniden yayımlanmaz.'}
          </p>
        ) : (
          <InfoNote tone="warning" title="Kaynak metni yakalanamadı">
            Bu taramada ilan detay metni okunamadı. Çıkarılan koşulları ve güncel tam metni resmî ilan
            bağlantısından doğrulayın.
          </InfoNote>
        )}
      </Card>

      <Card
        title="Sınırlı ilan alıntısı"
        description="Gövde metni en çok 400 karakterlik bir alıntıyla sınırlıdır; daha kısa duyuruların tamamı yeniden yayımlanmaz."
      >
        {job.textExcerpt ? (
          <p className="job-excerpt">{job.textExcerpt}</p>
        ) : (
          <InfoNote tone="info" title="Kısa metin burada gösterilmiyor">
            Kısa duyurunun tam içeriğini yeniden yayımlamamak için alıntı gösterilmez. Tam ve güncel metin
            resmî ilan bağlantısındadır.
          </InfoNote>
        )}
      </Card>

      <InfoNote title="Kesin bilgi kaynağındadır">
        Başvuru koşullarını ilanın resmî kaynağından doğrulayın; değişiklikler önce kaynakta olur. Kamuİlan
        yalnızca yayımlanmış ilanları toplar ve gördüğü son hâli gösterir.
        {job.applicationEndDate ? ` Son başvuru günü: ${formatDateOnly(job.applicationEndDate)}.` : ''}
      </InfoNote>
    </article>
  );
}
