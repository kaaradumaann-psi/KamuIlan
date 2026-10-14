import { describe, expect, it } from 'vitest';
import type { CandidateProfile, PublicJobDetail } from '../src/types';
import { explainProfileMatch } from '../src/lib/profile-match';

const profile: CandidateProfile = {
  profession: 'inşaat mühendisi',
  educationLevel: 'lisans',
  departments: ['İnşaat Mühendisliği'],
  skills: ['AutoCAD'],
  experienceYears: 4,
};

function job(overrides: Partial<PublicJobDetail> = {}): PublicJobDetail {
  return {
    id: 'job_test',
    title: 'İnşaat Mühendisi Alım İlanı',
    institution: 'Örnek Bakanlık',
    unit: null,
    employmentType: 'sozlesmeli',
    employmentTypeLabel: 'Sözleşmeli personel',
    status: 'active',
    statusLabel: 'Başvuru açık',
    city: null,
    district: null,
    quota: null,
    applicationStartAt: null,
    applicationEndAt: null,
    applicationEndDate: null,
    publishedAt: null,
    detailUrl: 'https://example.gov.tr/ilan/1',
    applicationUrl: null,
    hasApplicationUrl: false,
    attachmentCount: 0,
    titles: ['İnşaat Mühendisi'],
    sourceKeys: ['example'],
    extractionConfidence: 0.8,
    lastVerifiedAt: null,
    provenance: 'scraped',
    version: 1,
    updatedAt: '2026-10-14T00:00:00.000Z',
    deadline: { state: 'open', daysLeft: 10 },
    applicationMethod: null,
    originalRefNo: null,
    textExcerpt: 'AutoCAD kullanımı ve en az üç yıl ilgili deneyim aranıyor.',
    requirements: {
      educationLevels: ['lisans'],
      departments: ['İnşaat Mühendisliği'],
      kpssScoreTypes: [],
      kpssMinScore: null,
      kpssYear: null,
      minAge: null,
      maxAge: null,
      certificates: [],
      minExperienceYears: 3,
      foreignLanguages: [],
      specialConditions: [],
    },
    attachments: [],
    classification: {
      decision: 'accept',
      employmentType: 'sozlesmeli',
      confidence: 0.8,
      reasons: [],
      version: 'test',
    },
    fieldSources: {},
    evidence: {},
    uncertainties: [],
    capturedNotice: {
      sourceKey: 'example',
      sourceName: 'Örnek kaynak',
      characterCount: 800,
      status: 'captured',
    },
    sources: [],
    ...overrides,
  } as PublicJobDetail;
}

describe('profile-aware listing explanation', () => {
  it('explains concrete field matches without presenting them as official eligibility', () => {
    const result = explainProfileMatch(job(), profile);
    expect(result?.signal).toBe('high');
    expect(result?.score).toBe(100);
    expect(result?.reasons).toHaveLength(5);
    expect(result?.caveats).toContain(
      'Bu deterministik sinyal yalnızca sınırlı metin alıntısı, çıkarılmış alanlar ve bunların kanıt parçalarını karşılaştırır; tam ilanın tüm koşullarını kapsamaz.',
    );
  });

  it('returns unknown rather than a false low match when comparable job data is absent', () => {
    const result = explainProfileMatch(
      job({
        textExcerpt: '',
        capturedNotice: null,
        requirements: {
          educationLevels: [],
          departments: [],
          kpssScoreTypes: [],
          kpssMinScore: null,
          kpssYear: null,
          qualificationCodes: [],
          minAge: null,
          maxAge: null,
          certificates: [],
          minExperienceYears: null,
          foreignLanguages: [],
          specialConditions: [],
        },
      }),
      { ...profile, profession: '', skills: [] },
    );
    expect(result?.signal).toBe('unknown');
    expect(result?.score).toBeNull();
    expect(result?.caveats).toContain(
      'İlandan asgari deneyim koşulu çıkarılamadı; deneyim süreniz bu eşleşme sinyaline dahil edilmedi.',
    );
  });

  it('does not count arbitrary substrings or Java inside JavaScript as exact matches', () => {
    const shortTerm = explainProfileMatch(
      job({
        title: 'Adana kamu personel alım duyurusu',
        titles: [],
        textExcerpt: 'Adana için personel alınacaktır.',
      }),
      {
        ...profile,
        profession: 'ada',
        educationLevel: null,
        departments: [],
        skills: [],
        experienceYears: null,
      },
    );
    const skill = explainProfileMatch(
      job({
        title: 'JavaScript geliştirici alımı',
        titles: [],
        textExcerpt: 'JavaScript ve web teknolojileri aranıyor.',
      }),
      {
        ...profile,
        profession: '',
        educationLevel: null,
        departments: [],
        skills: ['Java'],
        experienceYears: null,
      },
    );
    expect(shortTerm?.reasons).toEqual([]);
    expect(skill?.reasons).toEqual([]);
  });

  it('does not produce an explanation for an empty profile', () => {
    expect(
      explainProfileMatch(job(), {
        profession: '',
        educationLevel: null,
        departments: [],
        skills: [],
        experienceYears: null,
      }),
    ).toBeNull();
  });
});
