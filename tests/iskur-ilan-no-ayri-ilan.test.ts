/**
 * Üretim bulgusu (23.10.2026): İŞKUR e-Şube kamu kaynağı 91 ayrı İŞKUR ilan numarası getirdi, ancak
 * tekilleştirme bunları yalnız 10 ilana birleştirdi (TCDD'nin il il açtığı 61 satır tek ilanda; Kayseri
 * Karayolları sıhhi tesisatçı → boyacı ilanı; Trabzon/Nevşehir İl Sağlık → Yozgat ilanı). Her İŞKUR
 * satırı kendi ilan numarasıyla AYRI ilandır: aynı kaynağın farklı kaynak-içi kimlikleri asla tek
 * ilanda birleşmez. Kaynaklar arası tekilleştirme (aynı ilan RG + İŞKUR) çalışmaya devam eder.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { loadHtml } from '../src/lib/html';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { decideDedupe, type DedupeCandidateJob, type DedupeRawItem } from '../src/ingest/dedupe';
import { normalizeTr } from '../src/domain/text';
import {
  iskurRowToAnnouncement,
  parseIskurDetail,
  parseIskurRows,
  type IskurListingRow,
} from '../src/sources/adapters/iskur-esube';
import type { RawAnnouncement } from '../src/domain';

const FIXTURES = fileURLToPath(new URL('./fixtures/kaynak-html/', import.meta.url));
const fixture = (name: string): string => readFileSync(`${FIXTURES}${name}`, 'utf8');
const iskurSource = SOURCE_DEFINITIONS.find((source) => source.key === 'iskur-esube-acik-is')!;
const SOURCE_KEY = 'iskur-esube-kamu';

async function freshCtx() {
  const now = new Date('2026-10-23T09:00:00+03:00');
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-iskur-ayri-')));
  await store.init();
  const repos = createRepos(store, fixedClock(now));
  return { repos, store, ctx: { repos, now, workerId: 'w', provenance: 'scraped' as const } };
}

function row(overrides: Partial<IskurListingRow>): IskurListingRow {
  const ilanNo = overrides.ilanNo ?? '00009862271';
  return {
    ilanNo,
    occupation: 'Makinist',
    institution: 'TCDD TAŞIMACILIK A.Ş GENEL MÜDÜRLÜĞÜ',
    employerType: 'Kamu',
    workPeriod: 'Sürekli',
    workPattern: 'Tam Zamanlı',
    quota: 2,
    city: 'Ankara',
    district: null,
    locationText: 'İl Geneli Başvuru (ANKARA / ANKARA/MERKEZ)',
    applicationEndDate: '2026-10-26',
    detailUrl: `https://esube.iskur.gov.tr/Istihdam/AcikIsIlanDetay.aspx?uiID=${ilanNo}`,
    ...overrides,
  };
}

const CITIES = ['Ankara', 'Edirne', 'Konya', 'Sivas', 'Kayseri', 'Eskişehir', 'Malatya', 'Erzurum'];

describe('İŞKUR: farklı ilan numaraları ayrı ilan kalır', () => {
  it('TCDD il il satırları (aynı kurum, meslek, son başvuru, detay metni) ayrı ilanlara düşer', async () => {
    const { repos, ctx } = await freshCtx();
    const detail = parseIskurDetail(fixture('iskur-esube-detay.html'));
    const outcomes = [];
    for (const [index, city] of CITIES.entries()) {
      const item = iskurRowToAnnouncement(
        row({ ilanNo: `0000986${String(2271 + index).padStart(4, '0')}`, city, locationText: `(${city.toLocaleUpperCase('tr')} / MERKEZ)` }),
        SOURCE_KEY,
        detail,
      );
      outcomes.push(await applyRawAnnouncement(item, ctx));
    }
    expect(outcomes.map((outcome) => outcome.action)).toEqual(CITIES.map(() => 'created'));
    expect(new Set(outcomes.map((outcome) => outcome.jobId)).size).toBe(CITIES.length);
    const jobs = await repos.store.find('jobs', {});
    expect(jobs).toHaveLength(CITIES.length);
  });

  it('aynı kurumun aynı ildeki farklı meslekleri (boyacı / sıhhi tesisatçı) ayrı ilandır', async () => {
    const { ctx } = await freshCtx();
    const base = { institution: 'KARAYOLLARI 6. BÖLGE MÜDÜRLÜĞÜ', city: 'Kayseri', quota: 1 };
    const body = 'Genel hususlar: adaylar Kamu İşçi Alımı Yönetmeliği kapsamında noter kurasıyla belirlenecektir. '.repeat(4);
    const first = await applyRawAnnouncement(
      iskurRowToAnnouncement(row({ ...base, ilanNo: '00009870001', occupation: 'Boyacı' }), SOURCE_KEY, body),
      ctx,
    );
    const second = await applyRawAnnouncement(
      iskurRowToAnnouncement(row({ ...base, ilanNo: '00009870002', occupation: 'Sıhhi Tesisatçı' }), SOURCE_KEY, body),
      ctx,
    );
    expect(first.action).toBe('created');
    expect(second.action).toBe('created');
    expect(second.jobId).not.toBe(first.jobId);
  });

  it('fikstür sayfasının satırları (farklı il, farklı ilan no) ayrı ilanlara düşer', async () => {
    const { repos, ctx } = await freshCtx();
    const rows = [
      ...parseIskurRows(loadHtml(fixture('iskur-esube-sonuc-1.html')), iskurSource.allowedHosts),
      ...parseIskurRows(loadHtml(fixture('iskur-esube-sonuc-2.html')), iskurSource.allowedHosts),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const detail = parseIskurDetail(fixture('iskur-esube-detay.html'));
    for (const listing of rows) await applyRawAnnouncement(iskurRowToAnnouncement(listing, SOURCE_KEY, detail), ctx);
    const jobs = await repos.store.find('jobs', {});
    const links = await repos.store.find('jobSources', {});
    expect(links).toHaveLength(rows.length);
    expect(jobs).toHaveLength(rows.length);
  });

  it('aynı ilan numarası yeniden görülünce aynı ilan güncellenir (kimlik yolu bozulmaz)', async () => {
    const { repos, ctx } = await freshCtx();
    const item = iskurRowToAnnouncement(row({}), SOURCE_KEY, null);
    const first = await applyRawAnnouncement(item, ctx);
    const again = await applyRawAnnouncement({ ...item, quota: 3 }, ctx);
    expect(again.jobId).toBe(first.jobId);
    expect(await repos.store.find('jobs', {})).toHaveLength(1);
  });
});

describe('decideDedupe: aynı kaynağın farklı kaynak-içi kimliği', () => {
  const candidate = (sourceKeys: string[]): DedupeCandidateJob => {
    const title = 'TCDD TAŞIMACILIK A.Ş GENEL MÜDÜRLÜĞÜ — Makinist işçi alımı (İŞKUR, Ankara)';
    return {
      id: 'job_tcdd_ankara',
      title,
      titleNormalized: normalizeTr(title),
      institution: 'TCDD TAŞIMACILIK A.Ş GENEL MÜDÜRLÜĞÜ',
      institutionNormalized: normalizeTr('TCDD TAŞIMACILIK A.Ş GENEL MÜDÜRLÜĞÜ'),
      normalizedUrl: 'https://esube.iskur.gov.tr/Istihdam/AcikIsIlanDetay.aspx?uiID=00009862271',
      originalRefNo: '00009862271',
      applicationEndDate: '2026-10-26',
      textExcerpt: 'Ortak genel hususlar metni '.repeat(20),
      sourceKeys,
      sourceItemIds: sourceKeys.includes(SOURCE_KEY) ? [`${SOURCE_KEY}::iskur-esube:00009862271`] : [],
    };
  };
  const raw: DedupeRawItem = {
    sourceKey: SOURCE_KEY,
    sourceItemId: 'iskur-esube:00009862396',
    title: 'TCDD TAŞIMACILIK A.Ş GENEL MÜDÜRLÜĞÜ — Makinist işçi alımı (İŞKUR, Edirne)',
    institution: 'TCDD TAŞIMACILIK A.Ş GENEL MÜDÜRLÜĞÜ',
    normalizedUrl: 'https://esube.iskur.gov.tr/Istihdam/AcikIsIlanDetay.aspx?uiID=00009862396',
    referenceNo: '00009862396',
    applicationEndDate: '2026-10-26',
    textExcerpt: 'Ortak genel hususlar metni '.repeat(20),
  };

  it('aday zaten aynı kaynaktan başka bir kimlikle bağlıysa birleştirilmez', () => {
    const decision = decideDedupe(raw, [candidate([SOURCE_KEY])]);
    expect(decision.action).toBe('create');
  });

  it('aday başka bir kaynaktan geldiyse (RG ↔ İŞKUR) kaynaklar arası birleştirme sürer', () => {
    const decision = decideDedupe(raw, [candidate(['resmigazete-cestili-ilanlar'])]);
    expect(decision.action).toBe('merge');
  });
});

export type { RawAnnouncement };
