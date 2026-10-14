/**
 * İlan kartı — liste ve ana sayfada ortak.
 *
 * Kart yalnızca kayıttaki alanları gösterir; hiçbir değer tahmin edilmez.
 * Belirsiz alanlar ("—") olarak kalır ve kayıt demo verisiyse bu açıkça yazılır.
 */
import { Link } from 'react-router-dom';
import { deadlineLabel, employmentTypeLabel, formatDateOnly, formatRelative } from '../lib/format';
import type { PublicJobSummary } from '../types';
import { Icon } from './Icon';
import { SaveJobButton } from './SaveJobButton';
import { Tag } from './ui';

/** Kapanış bilgisi etiket tonu (sunucu durumu: open | closing-soon | closed | unknown). */
function deadlineTone(job: PublicJobSummary): 'success' | 'warning' | 'info' | 'neutral' {
  if (job.deadline.state === 'closing-soon') return 'warning';
  if (job.deadline.state === 'open') return 'success';
  return 'neutral';
}

export function JobCard({ job }: { job: PublicJobSummary }) {
  const city = [job.city, job.district].filter((part): part is string => Boolean(part)).join(' / ');

  return (
    <article className="job-card">
      <header className="job-card-head">
        <span className="job-card-institution">
          <Icon name="building" size={14} />
          {job.institution}
        </span>
        <span className="job-card-dates">
          {job.publishedAt ? `Yayım: ${formatDateOnly(job.publishedAt)}` : 'Yayım tarihi belirtilmemiş'}
        </span>
      </header>

      <h3 className="job-card-title">
        <Link to={`/ilanlar/${encodeURIComponent(job.id)}`}>{job.title}</Link>
      </h3>

      <div className="job-card-tags">
        {job.kind === 'process' ? (
          <Tag tone="info">Süreç duyurusu</Tag>
        ) : (
          <Tag tone="accent">{employmentTypeLabel(job.employmentType) || job.employmentTypeLabel}</Tag>
        )}
        {city && <Tag icon="mapPin">{city}</Tag>}
        {job.quota !== null && <Tag icon="user">{`${job.quota} kişi`}</Tag>}
        <Tag tone={deadlineTone(job)}>{deadlineLabel(job.deadline.daysLeft, job.deadline.state)}</Tag>
        {job.provenance === 'sample' && <Tag tone="warning">Örnek veri</Tag>}
        {job.criticalMissingFields && job.criticalMissingFields.length > 0 && (
          <Tag tone="warning">Bazı bilgiler eksik</Tag>
        )}
      </div>

      {job.kind === 'process' && (
        <p className="job-card-note">
          Yeni alım ilanı değil; devam eden bir personel alımının kura, sınav veya sonuç aşamasını bildirir.
        </p>
      )}

      {(job.unit || job.titles.length > 0 || job.attachmentCount > 0) && (
        <ul className="job-card-meta">
          {job.unit && (
            <li>
              <Icon name="layers" size={13} /> {job.unit}
            </li>
          )}
          {job.titles.length > 0 && (
            <li>
              <Icon name="tag" size={13} /> {job.titles.slice(0, 3).join(', ')}
              {job.titles.length > 3 ? ` +${job.titles.length - 3}` : ''}
            </li>
          )}
          {job.attachmentCount > 0 && (
            <li>
              <Icon name="file" size={13} /> {job.attachmentCount} belge
            </li>
          )}
          <li>
            <Icon name="list" size={13} />{' '}
            {job.sourceKeys.length > 1 ? `${job.sourceKeys.length} sitede yayımlandı` : '1 sitede yayımlandı'}
          </li>
        </ul>
      )}

      <footer className="job-card-foot">
        <span>
          {job.hasApplicationUrl ? (
            <>
              <Icon name="link" size={13} /> Başvuru bağlantısı var
            </>
          ) : (
            <>
              <Icon name="info" size={13} /> Başvuru bağlantısı ilanda belirtilmemiş
            </>
          )}
        </span>
        <span>
          Son kontrol: {job.lastVerifiedAt ? formatRelative(job.lastVerifiedAt) : 'henüz yapılmadı'}
        </span>
        <SaveJobButton jobId={job.id} compact />
      </footer>
    </article>
  );
}
