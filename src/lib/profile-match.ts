import { normalizeTr } from '../domain/text';
import type { CandidateProfile, PublicJobDetail } from '../types';

export interface ProfileMatchExplanation {
  signal: 'high' | 'medium' | 'low' | 'unknown';
  score: number | null;
  reasons: string[];
  caveats: string[];
}

function normal(value: string): string {
  return normalizeTr(value).trim();
}

function tokens(value: string): string[] {
  return normal(value)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

const TURKISH_INFLECTION_SUFFIXES = new Set([
  'a',
  'e',
  'ı',
  'i',
  'u',
  'ü',
  'da',
  'de',
  'ta',
  'te',
  'dan',
  'den',
  'tan',
  'ten',
  'lar',
  'ler',
  'ları',
  'leri',
  'lı',
  'li',
  'lu',
  'lü',
  'lık',
  'lik',
  'luk',
  'lük',
  'lığı',
  'liği',
  'luğu',
  'lüğü',
  'ligi',
  'si',
  'sı',
  'su',
  'sü',
]);

function wordMatches(left: string, right: string, allowInflection: boolean): boolean {
  if (left === right) return true;
  if (!allowInflection) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  // Prefix similarity is not a word match: e.g. "Java" must not match
  // "JavaScript". Only a known Turkish inflection on a sufficiently long
  // whole-token stem may match.
  if (shorter.length < 5 || !longer.startsWith(shorter)) return false;
  return TURKISH_INFLECTION_SUFFIXES.has(longer.slice(shorter.length));
}

function containsTerm(haystack: string, needle: string, allowInflection = false): boolean {
  const sourceTokens = tokens(haystack);
  const needleTokens = tokens(needle);
  if (needleTokens.length === 0 || needleTokens.some((token) => token.length < 2)) return false;
  return sourceTokens.some((_, start) =>
    needleTokens.every((needleToken, offset) => {
      const sourceToken = sourceTokens[start + offset];
      return sourceToken !== undefined && wordMatches(sourceToken, needleToken, allowInflection);
    }),
  );
}

function listMatch(left: string[], right: string[]): string | null {
  for (const userValue of left) {
    const a = normal(userValue);
    if (a.length < 2) continue;
    const match = right.find((jobValue) => {
      const b = normal(jobValue);
      return b.length >= 2 && (containsTerm(a, b, true) || containsTerm(b, a, true));
    });
    if (match) return match;
  }
  return null;
}

/**
 * A privacy-first, evidence-based profile comparison. This is a heuristic
 * signal, not an eligibility decision or a generative-AI conclusion.
 */
export function explainProfileMatch(
  job: PublicJobDetail,
  profile: CandidateProfile,
): ProfileMatchExplanation | null {
  const hasProfile = Boolean(
    profile.profession.trim() ||
    profile.educationLevel ||
    profile.departments.length ||
    profile.skills.length ||
    profile.experienceYears !== null,
  );
  if (!hasProfile) return null;

  const titleText = normal(`${job.title} ${job.titles.join(' ')}`);
  const extractedEvidence = [
    ...Object.values(job.evidence),
    ...Object.values(job.fieldSources).map((source) => source.snippet ?? ''),
  ].join(' ');
  const bodyText = normal(`${job.textExcerpt} ${extractedEvidence}`);
  const allText = normal(
    `${job.title} ${job.titles.join(' ')} ${job.requirements.departments.join(' ')} ${bodyText}`,
  );
  const reasons: string[] = [];
  const caveats: string[] = [];
  let possiblePoints = 0;
  let matchedPoints = 0;

  if (profile.profession.trim()) {
    possiblePoints += 40;
    if (containsTerm(titleText, profile.profession, true)) {
      matchedPoints += 40;
      reasons.push(
        `Meslek/unvanınız “${profile.profession.trim()}” ilan başlığı veya unvanlarıyla eşleşiyor.`,
      );
    } else if (containsTerm(allText, profile.profession, true)) {
      matchedPoints += 22;
      reasons.push(
        `Mesleğiniz “${profile.profession.trim()}” ilan metninde geçiyor; başlıkta doğrudan eşleşme yok.`,
      );
    } else {
      caveats.push(
        'Meslek/unvanınız çıkarılan metinde doğrudan bulunmadı; ilanda eş anlamlı veya farklı bir unvan kullanılmış olabilir.',
      );
    }
  }

  if (profile.departments.length > 0) {
    if (job.requirements.departments.length === 0) {
      caveats.push('İlandan bölüm koşulu çıkarılamadı; mezuniyet bölümünüz için asıl ilanı kontrol edin.');
    } else {
      possiblePoints += 30;
      const matchingDepartment = listMatch(profile.departments, job.requirements.departments);
      if (matchingDepartment) {
        matchedPoints += 30;
        reasons.push(
          `Bölümünüz, ilandan çıkarılan bölüm koşullarından “${matchingDepartment}” ile örtüşüyor.`,
        );
      } else {
        caveats.push(
          `Girdiğiniz bölüm, çıkarılan bölüm koşulları (${job.requirements.departments.join(', ')}) arasında görünmüyor; farklı kadrolarda farklı koşullar olabilir.`,
        );
      }
    }
  }

  if (profile.skills.length > 0) {
    if (bodyText.length === 0) {
      caveats.push('Beceri eşleşmesini değerlendirecek ilan metni yakalanmamış.');
    } else {
      const matchedSkills = profile.skills.filter((skill) => containsTerm(bodyText, skill));
      possiblePoints += Math.min(15, profile.skills.length * 5);
      const skillPoints = Math.min(15, matchedSkills.length * 5);
      matchedPoints += skillPoints;
      if (matchedSkills.length > 0) {
        reasons.push(
          `İlan metninde profilinizdeki şu beceri/terimler geçiyor: ${matchedSkills.slice(0, 3).join(', ')}.`,
        );
      }
    }
  }

  if (profile.educationLevel) {
    if (job.requirements.educationLevels.length === 0) {
      caveats.push('Eğitim koşulu ilandan güvenilir biçimde çıkarılamadı.');
    } else {
      possiblePoints += 15;
      if (job.requirements.educationLevels.includes(profile.educationLevel)) {
        matchedPoints += 15;
        reasons.push('Profilinizdeki eğitim düzeyi, ilandan çıkarılan eğitim düzeyleri arasında.');
      } else {
        caveats.push(
          'Profilinizdeki eğitim düzeyi çıkarılan eğitim koşullarıyla doğrudan eşleşmiyor; düzey denklikleri ve kadro bazlı şartlar için asıl ilanı okuyun.',
        );
      }
    }
  }

  if (profile.experienceYears !== null) {
    if (job.requirements.minExperienceYears === null) {
      caveats.push(
        'İlandan asgari deneyim koşulu çıkarılamadı; deneyim süreniz bu eşleşme sinyaline dahil edilmedi.',
      );
    } else {
      possiblePoints += 10;
      if (profile.experienceYears >= job.requirements.minExperienceYears) {
        matchedPoints += 10;
        reasons.push(
          `Girdiğiniz deneyim süresi (${profile.experienceYears} yıl), çıkarılan asgari sürenin (${job.requirements.minExperienceYears} yıl) altında değil.`,
        );
      } else {
        caveats.push(
          `İlanda en az ${job.requirements.minExperienceYears} yıl deneyim çıkarıldı; profilinizde ${profile.experienceYears} yıl var. Deneyimin alanı ve denkliği asıl ilanda kontrol edilmeli.`,
        );
      }
    }
  }

  if (reasons.length === 0 && caveats.length === 0) {
    caveats.push('Bu profil ile ilan arasında karşılaştırılabilecek yeterli alan bulunamadı.');
  }
  caveats.push(
    job.textExcerpt.length > 0
      ? 'Bu deterministik sinyal yalnızca sınırlı metin alıntısı, çıkarılmış alanlar ve bunların kanıt parçalarını karşılaştırır; tam ilanın tüm koşullarını kapsamaz.'
      : 'Tam ilan gövdesi burada gösterilmez; bu deterministik sinyal yalnızca başlık, çıkarılmış alanlar ve kanıt parçalarını karşılaştırır. Asıl ilanın tüm koşullarını kontrol edin.',
  );
  if (job.uncertainties.length > 0) {
    caveats.push(
      'İlan verilerinde çıkarım belirsizlikleri var; alanların kanıtını ve asıl duyuruyu kontrol edin.',
    );
  }

  const score = possiblePoints > 0 ? Math.round((matchedPoints / possiblePoints) * 100) : null;
  return {
    score,
    signal: score === null ? 'unknown' : score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low',
    reasons,
    caveats,
  };
}
