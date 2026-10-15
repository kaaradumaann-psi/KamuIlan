/**
 * Güvenlik denetimi (2026-10-15) — tıklanabilir bağ sınırı.
 *
 * Toplanan içerik ve yönetici girişi güvenilmeyen veridir. `new URL('javascript:alert(1)')`
 * geçerli bir URL olduğu için `z.string().url()` tek başına yetmez; panelde çizilen
 * `href` üzerinden betik çalıştırılabilir (stored XSS). Sınır iki yerde kapatıldı:
 *  1) serializer — arayüze giden her dış bağ http(s) değilse güvenli yedeğe düşer,
 *  2) yönetici kaynak uçları — listingUrl/homepageUrl http(s) olmak zorundadır.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { JobDoc } from '../src/db/schemas';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { resetEnvCache } from '../src/config/env';
import { hashPassword } from '../src/server/passwords';
import { buildJobDocument } from '../src/ingest/jobs-service';
import { toPublicJobDetail, toPublicJobSummary, toReviewItem } from '../src/server/serializers';
import { isHttpUrl } from '../src/domain/urls';
import type { RawAnnouncement } from '../src/domain';

const NOW = new Date('2026-10-15T09:00:00+03:00');
const LOGGER = createLogger('guvenlik-url', { level: 'silent' });
const CREDENTIAL = ['Guclu', 'Parola', '2026!'].join('-');

let openApps: FastifyInstance[] = [];
let openStores: FileStore[] = [];

afterEach(async () => {
  for (const app of openApps) await app.close();
  for (const store of openStores) await store.close();
  openApps = [];
  openStores = [];
  resetEnvCache();
});

function jobWith(url: string): JobDoc {
  const raw = {
    sourceKey: 'sgk-duyurular',
    sourceItemId: 'job-url-1',
    title: 'SGK 100 Sözleşmeli Personel Alım İlanı',
    url,
    attachments: [{ url, label: 'İlan PDF', kind: 'pdf' as const }],
    bodyText: 'Kurumumuza 100 sözleşmeli personel alınacaktır. Başvurular e-Devlet üzerinden yapılır.',
    institution: 'Sosyal Güvenlik Kurumu',
    publishedAt: '2026-10-14',
  } as unknown as RawAnnouncement;
  const doc = buildJobDocument(raw, {
    decision: 'accept',
    kind: 'job',
    employmentType: 'sozlesmeli',
    confidence: 0.9,
    reasons: ['test'],
    rules: [],
    negativeSignals: [],
    version: '2026.10.2',
  } as never, { now: NOW, provenance: 'scraped' });
  return {
    ...doc,
    id: 'job-url-1',
    detailUrl: url,
    applicationUrl: url,
    attachments: [{ url, label: 'İlan PDF', kind: 'pdf' as const }],
  } as unknown as JobDoc;
}

describe('isHttpUrl', () => {
  it('http(s) dışı şemaları reddeder', () => {
    expect(isHttpUrl('https://www.sgk.gov.tr/duyuru/1')).toBe(true);
    expect(isHttpUrl('http://sgk.gov.tr/duyuru/1')).toBe(true);
    expect(isHttpUrl('javascript:alert(document.cookie)')).toBe(false);
    expect(isHttpUrl('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('//sgk.gov.tr/duyuru')).toBe(false);
    expect(isHttpUrl('sgk.gov.tr/duyuru')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });

  it('şema içine gizlenmiş sekme/satır sonu atlatamaz', () => {
    // Tarayıcılar URL içindeki \t ve \n karakterlerini yok sayar.
    expect(isHttpUrl('java\tscript:alert(1)')).toBe(false);
    expect(isHttpUrl('java\nscript:alert(1)')).toBe(false);
    expect(isHttpUrl(' javascript:alert(1)')).toBe(false);
  });
});

describe('serializer dış bağ sınırı', () => {
  it('zararlı detailUrl arayüze "#" olarak gider', () => {
    const summary = toPublicJobSummary(jobWith('javascript:alert(document.cookie)'), NOW);
    expect(summary.detailUrl).toBe('#');
    expect(summary.hasApplicationUrl).toBe(false);
  });

  it('zararlı applicationUrl ve ekler detayda yer almaz', () => {
    const detail = toPublicJobDetail(jobWith('javascript:alert(1)'), { sources: [], now: NOW });
    expect(detail.applicationUrl).toBeNull();
    expect(detail.attachments).toEqual([]);
  });

  it('meşru adresler değişmeden geçer', () => {
    const url = 'https://www.sgk.gov.tr/duyuru/2026-personel-alimi';
    const summary = toPublicJobSummary(jobWith(url), NOW);
    const detail = toPublicJobDetail(jobWith(url), {
      sources: [{ sourceKey: 'sgk-duyurular', url: 'javascript:alert(1)', title: 'Kayıt' } as never],
      now: NOW,
    });
    expect(summary.detailUrl).toBe(url);
    expect(summary.hasApplicationUrl).toBe(true);
    expect(detail.applicationUrl).toBe(url);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.sources[0]?.url).toBe('');
  });

  it('inceleme kuyruğu adresi de temizlenir', () => {
    const item = toReviewItem({
      id: 'rev-1',
      kind: 'relevance',
      sourceKey: 'sgk-duyurular',
      title: 'Şüpheli kayıt',
      url: 'javascript:alert(1)',
      reason: 'test',
      confidence: 0.5,
      payload: {},
      candidateJobIds: [],
      status: 'open',
      createdAt: NOW.toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    });
    expect(item.url).toBe('');
  });
});

describe('yönetici kaynak uçları http(s) ister', () => {
  it('javascript: listingUrl ile kaynak oluşturulamaz', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-url-')));
    await store.init();
    openStores.push(store);
    const repos: Repos = createRepos(store, fixedClock(NOW));
    await repos.sources.seed();
    const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
    openApps.push(app);

    const { hash, salt } = await hashPassword(CREDENTIAL);
    await repos.users.create({
      email: 'yonetici@ornek.test',
      passwordHash: hash,
      passwordSalt: salt,
      displayName: 'Yönetici',
      role: 'admin',
      emailVerified: true,
    });
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'yonetici@ornek.test', password: CREDENTIAL },
    });
    const cookies = loginRes.cookies as { name: string; value: string }[];
    const session = cookies.find((item) => item.name === 'kamuilan_session')?.value ?? '';
    const csrf = cookies.find((item) => item.name === 'kamuilan_csrf')?.value ?? '';
    const headers = { cookie: `kamuilan_session=${session}; kamuilan_csrf=${csrf}`, 'x-csrf-token': csrf };

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/sources',
      headers,
      payload: {
        key: 'zararli-kaynak',
        name: 'Zararlı Kaynak',
        institution: 'Test Kurumu',
        listingUrl: 'javascript:alert(document.cookie)',
        homepageUrl: 'https://ornek.test',
        allowedHosts: ['ornek.test'],
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('http');
  });
});
