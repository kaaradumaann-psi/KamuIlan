/**
 * İlan kartı — liste ve ana sayfada ortak.
 *
 * Kart yalnızca kayıttaki alanları gösterir; hiçbir değer tahmin edilmez.
 * Belirsiz alanlar ("—") olarak kalır ve kayıt demo verisiyse bu açıkça yazılır.
 */
import { Link } from 'react-router-dom';
import { EMPLOYMENT_TYPE_LABELS, deadlineLabel, formatDateOnly, formatRelative } from '../lib/format';
import type { PublicJobSummary } from '../types';
import { Icon } from './Icon';
import { Tag } from './ui';

/** Kapanış bilgisi etiket tonu (duruma göre). */
function deadlineTone(job: PublicJobSummary): 'success' | 'warning' | 'info' | 'neutral' {
  if (job.deadline.state === 'closing-soon') return 'warning';
  if (job.deadline.state === 'active') return 'success';
  if (job.deadline.state === 'upcoming') return 'info';
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
        <Tag tone="accent">{job.employmentTypeLabel || EMPLOYMENT_TYPE_LABELS[job.employmentType] || 'Belirsiz'}</Tag>
        {city && <Tag icon="mapPin">{city}</Tag>}
        {job.quota !== null && <Tag icon="user">{`${job.quota} kişi`}</Tag>}
        <Tag tone={deadlineTone(job)}>{deadlineLabel(job.deadline.daysLeft, job.deadline.state)}</Tag>
        {job.provenance === 'sample' && <Tag tone="warning">Örnek veri</Tag>}
        {job.criticalMissingFields && job.criticalMissingFields.length > 0 && (
          <Tag tone="warning">{`${job.criticalMissingFields.length} alan eksik`}</Tag>
        )}
      </div>

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
            {job.sourceKeys.length > 1 ? `${job.sourceKeys.length} kaynak` : '1 kaynak'}
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
          Son doğrulama:{' '}
          {job.lastVerifiedAt ? formatRelative(job.lastVerifiedAt) : 'henüz doğrulanmadı'}
        </span>
      </footer>
    </article>
  );
}
