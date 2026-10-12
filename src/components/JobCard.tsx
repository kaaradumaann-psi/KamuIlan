/**
 * İlan kartı: liste görünümünde kullanılır.
 *
 * Gösterilen her alan ilan kaydından gelir; eksik alan "belirtilmemiş" olarak
 * işaretlenir ve kart, örnek veri olduğunda bunu açıkça söyler.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EMPLOYMENT_TYPE_LABELS, JOB_STATUS_LABELS, deadlineLabel, formatDateOnly, formatNumber } from '../lib/format';
import type { PublicJobSummary } from '../types';
import { Badge } from './ui';

export function JobCard({ job }: { job: PublicJobSummary }): ReactNode {
  const deadlineTone =
    job.deadline.state === 'closed'
      ? 'danger'
      : job.deadline.state === 'closing-soon'
        ? 'warning'
        : job.deadline.state === 'active'
          ? 'success'
          : 'neutral';

  return (
    <article className="card">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">{EMPLOYMENT_TYPE_LABELS[job.employmentType] ?? job.employmentType}</Badge>
        <Badge tone={job.status === 'active' ? 'success' : job.status === 'upcoming' ? 'info' : 'neutral'}>
          {JOB_STATUS_LABELS[job.status] ?? job.status}
        </Badge>
        <Badge tone={deadlineTone as 'danger' | 'warning' | 'success' | 'neutral'}>{deadlineLabel(job.deadline.daysLeft, job.deadline.state)}</Badge>
        {job.provenance === 'sample' && <Badge tone="warning">örnek veri</Badge>}
      </div>

      <h3 className="mt-2 text-base font-semibold leading-snug">
        <Link to={`/ilanlar/${job.id}`} className="text-slate-900 no-underline hover:underline dark:text-slate-50">
          {job.title}
        </Link>
      </h3>

      <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{job.institution}</p>

      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Kontenjan</dt>
          <dd>{formatNumber(job.quota)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Yer</dt>
          <dd>{[job.city, job.district].filter(Boolean).join(' / ') || 'belirtilmemiş'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Son başvuru</dt>
          <dd>{job.applicationEndDate ? formatDateOnly(job.applicationEndDate) : 'belirtilmemiş'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Kaynak</dt>
          <dd>{job.sourceKeys.length > 0 ? job.sourceKeys.join(', ') : 'belirtilmemiş'}</dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
        {job.titles.length > 0 && <span>Unvan: {job.titles.slice(0, 3).join(', ')}</span>}
        {job.attachmentCount > 0 && <span>· {job.attachmentCount} ek belge</span>}
        {job.hasApplicationUrl ? <span>· başvuru bağlantısı var</span> : <span>· başvuru bağlantısı belirtilmemiş</span>}
      </div>

      <div className="mt-3">
        <Link className="btn-secondary" to={`/ilanlar/${job.id}`}>
          İlan detayı
        </Link>
      </div>
    </article>
  );
}
