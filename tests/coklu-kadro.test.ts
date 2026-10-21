/**
 * Çoklu kadro (unvan × kontenjan) — çıkarım, depolama ve API.
 *
 * Gerçek veri: Resmî Gazete 14.10.2026 (Keşan Belediyesi, 2 satır) ve 18.10.2026
 * (Karabağlar Belediyesi, 1 satır) ilanlarının PDF metin katmanındaki kadro
 * tabloları (`tests/fixtures/gercek-ilanlar/2026-10-kadro-tablolari.json`,
 * `humanVerified: false`). Önceki sürümde ilan yalnızca tek `quota` ve bağlamı
 * olmayan `titles[]` taşıyordu; iki farklı "Mühendis" kadrosu ayırt edilemiyordu.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractOpenings } from '../src/extraction/openings';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

interface FixtureItem {
  id: string;
  pdfUrl: string;
  institution: string;
  text: string;
  expected: {
    title: string;
    quota: number;
    serviceClass: string;
    degree: number;
    qualificationIncludes: string;
  }[];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/gercek-ilanlar/2026-10-kadro-tablolari.json'), 'utf8'),
) as { humanVerified: boolean; items: FixtureItem[] };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const task of cleanups.splice(0)) await task();
});

describe('extractOpenings — gerçek mahalli idare tabloları', () => {
  it('künye: insan doğrulaması yok, resmî PDF adresi var', () => {
    expect(fixture.humanVerified).toBe(false);
    for (const item of fixture.items) expect(item.pdfUrl).toMatch(/^https:\/\/www\.resmigazete\.gov\.tr\//);
  });

  it.each(fixture.items.map((item) => [item.id, item] as const))(
    '%s: satırlar, kontenjan ve nitelik',
    (_id, item) => {
      const openings = extractOpenings(item.text);
      expect(openings).toHaveLength(item.expected.length);
      item.expected.forEach((expected, index) => {
        const opening = openings[index]!;
        expect(opening).toMatchObject({
          title: expected.title,
          quota: expected.quota,
          serviceClass: expected.serviceClass,
          degree: expected.degree,
        });
        expect(opening.qualification).toContain(expected.qualificationIncludes);
        // Kanıt: okunan satır kaynak metinde birebir var.
        expect(item.text.replace(/\s+/g, ' ')).toContain(opening.evidence);
      });
    },
  );
});

describe('extractOpenings — kanıtsız tablo üretilmez', () => {
  const header =
    'aşağıda unvanı, sınıfı, derecesi, adedi belirtilen boş kadrolara memur alınacaktır.\nSıra No Kadro Ünvanı Hizmet Sınıfı Kadro Derecesi Kadro Adedi Niteliği\n';

  it('tablo başlığı yoksa benzer satırlar okunmaz', () => {
    expect(extractOpenings('1 Mühendis TH 8 2\n2 Tekniker TH 9 1\n')).toEqual([]);
  });

  it('sıra numarası atlanırsa (yarım/bozuk tablo) hiç kadro döndürmez', () => {
    expect(extractOpenings(`${header}1 Mühendis TH 8 2\n3 Tekniker TH 9 1\n`)).toEqual([]);
  });

  it('sıralı tabloda birden çok unvan ayrı ayrı okunur', () => {
    const openings = extractOpenings(
      `${header}1 Mühendis TH 8 2\nİnşaat mühendisliği programından mezun olmak.\nErkek/Kadın P3\n2 Zabıta Memuru GİH 10 3\nLise mezunu olmak.\nKPSS P94\n`,
    );
    expect(openings.map((opening) => [opening.title, opening.quota, opening.serviceClass])).toEqual([
      ['Mühendis', 2, 'TH'],
      ['Zabıta Memuru', 3, 'GİH'],
    ]);
    expect(openings[1]?.qualification).toBe('Lise mezunu olmak.');
  });
});

describe('kadro kırılımı uçtan uca: ingest → depo → GET /api/jobs/:id', () => {
  it('Keşan ilanının iki Mühendis kadrosu API detayında ayrı satırlar olarak döner', async () => {
    const item = fixture.items[0]!;
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-kadro-')));
    await store.init();
    const now = new Date('2026-10-21T09:00:00+03:00');
    const repos = createRepos(store, fixedClock(now));
    await repos.sources.seed();
    const raw = sozlesmeliPersonelIlani({
      sourceItemId: 'KADRO-KESAN',
      title: `${item.institution}: İLK DEFA ATANMAK ÜZERE MEMUR ALIM İLANI`,
      institution: item.institution,
      url: 'https://ornek.test/ilanlar/KADRO-KESAN',
      bodyText: `${item.text}\nBaşvurular 01.11.2026 - 10.11.2026 tarihleri arasında yapılacaktır.`,
    });
    const result = (await applyRawAnnouncement(raw, {
      repos,
      now,
      workerId: 'w-kadro',
      provenance: 'scraped',
    })) as {
      jobId: string | null;
    };
    expect(result.jobId).toBeTruthy();
    const app = await buildApp({
      repos,
      logger: createLogger('kadro-test', { level: 'silent' }),
      disableRateLimit: true,
    });
    cleanups.push(async () => {
      await app.close();
      await store.close();
    });

    const detail = (await app.inject({ method: 'GET', url: `/api/jobs/${result.jobId}` })).json() as {
      openings: { title: string; quota: number; qualification: string | null }[];
    };
    expect(detail.openings.map((opening) => [opening.title, opening.quota])).toEqual([
      ['Mühendis', 1],
      ['Mühendis', 1],
    ]);
    expect(detail.openings[0]?.qualification).toContain('inşaat');
    expect(detail.openings[1]?.qualification).toContain('elektrik');
  });

  it('tablosuz eski kayıt API sözleşmesini bozmaz: openings boş liste', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-kadro-eski-')));
    await store.init();
    const now = new Date('2026-10-21T09:00:00+03:00');
    const repos = createRepos(store, fixedClock(now));
    await repos.sources.seed();
    const result = (await applyRawAnnouncement(sozlesmeliPersonelIlani({ sourceItemId: 'KADRO-YOK' }), {
      repos,
      now,
      workerId: 'w-kadro',
      provenance: 'scraped',
    })) as { jobId: string | null };
    // Eski belge biçimi: alan hiç yok.
    await store.updateOne('jobs', { id: result.jobId! }, { openings: undefined } as never);
    const app = await buildApp({
      repos,
      logger: createLogger('kadro-test', { level: 'silent' }),
      disableRateLimit: true,
    });
    cleanups.push(async () => {
      await app.close();
      await store.close();
    });
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${result.jobId}` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { openings: unknown[] }).openings).toEqual([]);
  });
});
