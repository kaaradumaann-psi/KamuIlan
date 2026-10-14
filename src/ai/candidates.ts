/**
 * Yapay zekâya gönderilecek ADAY ilanların seçimi (deterministik, ağsız).
 *
 * Kural: model hiçbir zaman veritabanını gezmez; yalnızca bu fonksiyonun döndürdüğü
 * kısa liste üzerinde karar verir. Liste dışındaki bir ilan kimliği önerilirse
 * sunucu onu reddeder (bkz. suggest.ts).
 */
import type { Repos } from '../db/repos';
import type { JobDoc } from '../db/schemas';
import { explainProfileMatch, type ProfileMatchExplanation } from '../lib/profile-match';
import { toPublicJobDetail, toPublicJobSummary } from '../server/serializers';
import type { CandidateProfile, PublicJobDetail } from '../types';

/** Aday havuzunun büyüklüğü (taranan en yeni açık ilanlar). */
export const CANDIDATE_POOL_SIZE = 150;
/** Modele gönderilen en çok aday (veri minimizasyonu ve maliyet). */
export const MAX_CANDIDATES = 12;

export interface JobCandidate {
  job: JobDoc;
  summary: ReturnType<typeof toPublicJobSummary>;
  match: ProfileMatchExplanation;
}

const SIGNAL_RANK: Record<ProfileMatchExplanation['signal'], number> = {
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

/** Profilde en az bir alan doluysa öneri üretmek anlamlıdır. */
export function hasProfileSignal(profile: CandidateProfile): boolean {
  return Boolean(
    profile.profession.trim() ||
    profile.educationLevel ||
    profile.departments.length > 0 ||
    profile.skills.length > 0 ||
    profile.experienceYears !== null,
  );
}

/** Açık (aktif veya başlamamış) ilanlar arasından profille ilgili olanları seçer. */
export async function selectCandidates(
  repos: Repos,
  profile: CandidateProfile,
  now: Date,
): Promise<JobCandidate[]> {
  if (!hasProfileSignal(profile)) return [];
  const page = await repos.jobs.search(
    { status: ['active', 'upcoming'] },
    { pageSize: CANDIDATE_POOL_SIZE, sort: 'newest' },
  );

  const scored: JobCandidate[] = [];
  for (const job of page.items) {
    // Sunucu serileştirici tipi, istemci tipinin (`src/types`) ALTKÜMESİDİR; ön eleme
    // sezgisi yalnızca ilan alanlarını okur, bu yüzden dönüşüm güvenlidir.
    const detail = toPublicJobDetail(job, { sources: [], now }) as unknown as PublicJobDetail;
    const match = explainProfileMatch(detail, profile);
    if (!match || match.signal === 'unknown') continue;
    // Düşük sinyal yalnızca somut bir kanıt (gerekçe) varsa adaydır; kanıtsız ilan modele gitmez.
    if (match.signal === 'low' && match.reasons.length === 0) continue;
    scored.push({ job, summary: toPublicJobSummary(job, now), match });
  }

  scored.sort((a, b) => {
    const bySignal = SIGNAL_RANK[b.match.signal] - SIGNAL_RANK[a.match.signal];
    if (bySignal !== 0) return bySignal;
    return (b.match.score ?? 0) - (a.match.score ?? 0);
  });
  return scored.slice(0, MAX_CANDIDATES);
}
