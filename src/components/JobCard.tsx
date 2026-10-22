/**
 * İlan kartı — liste ve ana sayfada ortak.
 *
 * Kart yalnızca kayıttaki alanları gösterir; hiçbir değer tahmin edilmez.
 * Sade tutulur: kurum, başlık, birkaç temel etiket ve son başvuru tarihi.
 * Kaynak sayısı, son kontrol zamanı gibi ayrıntılar ilan detayındadır.
 * Örnek (demo) kayıt açıkça "Örnek veri" olarak işaretlenir.
 */
import { Link } from 'react-router-dom';
import { deadlineLabel, employmentTypeLabel, formatDateOnly } from '../lib/format';
import type { PublicJobSummary } from '../types';
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
  const endDate = job.applicationEndAt ?? job.applicationEndDate;
  const titles =
    job.titles.length > 0
      ? `${job.titles.slice(0, 3).join(', ')}${job.titles.length > 3 ? ` +${job.titles.length - 3}` : ''}`
      : null;

  return (
    <article className="job-card">
      <header className="job-card-head">
        <span className="job-card-institution">{job.institution}</span>
        {job.publishedAt && <span className="job-card-dates">{formatDateOnly(job.publishedAt)}</span>}
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
        {job.provenance === 'sample' && <Tag tone="warning">Örnek veri</Tag>}
      </div>

      {job.kind === 'process' && (
        <p className="job-card-note">Yeni alım değil; süren bir alımın sınav, kura ya da sonuç duyurusu.</p>
      )}

      {(job.unit || titles) && (
        <p className="job-card-meta">{[job.unit, titles].filter(Boolean).join(' · ')}</p>
      )}

      <footer className="job-card-foot">
        {job.kind !== 'process' ? (
          <span className="job-card-deadline">
            {endDate && <span>Son başvuru: {formatDateOnly(endDate)}</span>}
            <Tag tone={deadlineTone(job)}>{deadlineLabel(job.deadline.daysLeft, job.deadline.state)}</Tag>
          </span>
        ) : (
          <span />
        )}
        <SaveJobButton jobId={job.id} compact />
      </footer>
    </article>
  );
}
