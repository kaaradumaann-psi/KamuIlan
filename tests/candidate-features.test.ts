/**
 * Memur adayı özellikleri — regresyon testleri.
 *
 * Kapsanan düzeltmeler:
 *  - Ön yüz sözlüğü ile sunucu sözlüğü aynıdır (istihdam/eğitim etiketleri her
 *    kanonik değeri karşılar; aksi halde filtreler boş döner, kartlar "Belirsiz").
 *  - Filtre URL roundtrip'i yeni aday filtrelerini (eğitim/KPSS/bölüm) korur.
 *  - Takvim (.ics) yalnızca gerçek son başvuru tarihinden üretilir.
 *  - Kaydedilen ilanlar: oturumsuz 401, kullanıcı izolasyonu, toggle davranışı.
 *  - Jetonlu abonelikten çıkma oturumsuz çalışır (e-posta bağlantısı).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDUCATION_LEVELS, EMPLOYMENT_TYPES } from '../src/domain/types';
import { EDUCATION_LABELS, EMPLOYMENT_TYPE_LABELS } from '../src/lib/format';
import { EMPTY_FILTERS, filtersFromParams, filtersToParams } from '../src/components/Filters';
import { buildDeadlineIcs } from '../src/lib/calendar';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { hashPassword } from '../src/server/passwords';
import { buildApp } from '../src/server/app';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const TEST_CREDENTIAL = ['Guclu', 'Parola', '2026!'].join('-');

describe('aday sözlüğü sözleşmesi', () => {
  it('her kanonik istihdam türünün arayüz etiketi vardır', () => {
    for (const type of EMPLOYMENT_TYPES) {
      expect(EMPLOYMENT_TYPE_LABELS[type], type).toBeTruthy();
    }
  });

  it('her kanonik eğitim düzeyinin arayüz etiketi vardır', () => {
    for (const level of EDUCATION_LEVELS) {
      expect(EDUCATION_LABELS[level], level).toBeTruthy();
    }
  });
});

describe('filtre URL sözleşmesi', () => {
  it('eğitim, bölüm ve KPSS filtreleri URL roundtripinde korunur', () => {
    const params = filtersToParams(
      { ...EMPTY_FILTERS, education: 'lisans', department: 'hemşirelik', kpssType: 'P3', kpssScore: '72' },
      1,
    );
    const parsed = filtersFromParams(params);
    expect(parsed.education).toBe('lisans');
    expect(parsed.department).toBe('hemşirelik');
    expect(parsed.kpssType).toBe('P3');
    expect(parsed.kpssScore).toBe('72');
  });
});

describe('takvim dosyası', () => {
  it('son başvuru tarihi yoksa dosya üretmez (tarih uydurmaz)', () => {
    expect(
      buildDeadlineIcs({
        id: 'job_1',
        title: 'İlan',
        institution: 'Kurum',
        applicationEndDate: null,
        applicationEndAt: null,
        detailUrl: 'https://ornek.test',
      }),
    ).toBeNull();
  });

  it('gerçek tarihten tüm gün etkinliği + 1 gün önce hatırlatma üretir', () => {
    const ics = buildDeadlineIcs(
      {
        id: 'job_1',
        title: 'Hemşire alımı',
        institution: 'Kurum',
        applicationEndDate: '2026-10-30',
        applicationEndAt: null,
        detailUrl: 'https://ornek.test/ilan',
      },
      NOW,
    );
    expect(ics).toContain('DTSTART;VALUE=DATE:20261030');
    expect(ics).toContain('TRIGGER:-P1D');
    expect(ics).toContain('Son başvuru: Hemşire alımı');
  });
});

describe('kaydedilen ilanlar ve jetonlu çıkış (API)', () => {
  it('kaydetme oturum ister, kullanıcılar birbirinin listesini göremez, jetonlu çıkış oturumsuz çalışır', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-candidate-')));
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));
    await repos.sources.seed();
    const applied = await applyRawAnnouncement(sozlesmeliPersonelIlani({ sourceKey: 'test-kaynak' }), {
      repos,
      now: NOW,
      workerId: 'candidate-test',
      provenance: 'sample',
    });
    const jobId = applied.jobId as string;
    expect(jobId).toBeTruthy();

    async function makeUser(email: string): Promise<string> {
      const { hash, salt } = await hashPassword(TEST_CREDENTIAL);
      const created = await repos.users.create({
        email,
        passwordHash: hash,
        passwordSalt: salt,
        displayName: 'Aday',
        emailVerified: true,
      });
      return created.user.id;
    }
    const firstId = await makeUser('aday1@ornek.test');
    await makeUser('aday2@ornek.test');
    await repos.notifications.upsertPreference(firstId, { enabled: true, filters: {} });

    const app = await buildApp({
      repos,
      logger: createLogger('candidate-test', { level: 'silent' }),
      disableRateLimit: true,
    });
    try {
      const anon = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/save`, payload: {} });
      expect(anon.statusCode).toBe(401);

      async function login(email: string): Promise<{ cookie: string; csrf: string }> {
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email, password: TEST_CREDENTIAL },
        });
        expect(response.statusCode).toBe(200);
        const csrf = (response.json() as { csrfToken: string }).csrfToken;
        const session = (response.cookies as { name: string; value: string }[]).find(
          (c) => c.name === 'kamuilan_session',
        );
        const csrfCookie = (response.cookies as { name: string; value: string }[]).find(
          (c) => c.name === 'kamuilan_csrf',
        );
        return { cookie: `kamuilan_session=${session?.value}; kamuilan_csrf=${csrfCookie?.value}`, csrf };
      }
      const first = await login('aday1@ornek.test');
      const second = await login('aday2@ornek.test');

      // CSRF: oturum çerezi tek başına yetmez; başlıksız değiştiren istek 403.
      const noCsrf = await app.inject({
        method: 'POST',
        url: `/api/jobs/${jobId}/save`,
        payload: {},
        headers: { cookie: first.cookie },
      });
      expect(noCsrf.statusCode).toBe(403);

      const saved = await app.inject({
        method: 'POST',
        url: `/api/jobs/${jobId}/save`,
        payload: {},
        headers: { cookie: first.cookie, 'x-csrf-token': first.csrf },
      });
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as { saved: boolean }).saved).toBe(true);

      // Bildirim tercihi: 9 KPSS türünün tamamı seçilebilir olmalı (şema sınırı).
      const prefSave = await app.inject({
        method: 'PUT',
        url: '/api/notifications/preferences',
        payload: {
          enabled: true,
          filters: { kpssScoreTypes: ['P1', 'P2', 'P3', 'P10', 'P93', 'P94', 'P121', 'P124', 'DHBT'] },
        },
        headers: { cookie: first.cookie, 'x-csrf-token': first.csrf },
      });
      expect(prefSave.statusCode).toBe(200);

      const mine = await app.inject({
        method: 'GET',
        url: '/api/me/saved-jobs',
        headers: { cookie: first.cookie },
      });
      expect((mine.json() as { total: number }).total).toBe(1);
      const other = await app.inject({
        method: 'GET',
        url: '/api/me/saved-jobs',
        headers: { cookie: second.cookie },
      });
      expect((other.json() as { total: number }).total).toBe(0);

      // KPSS uygunluk filtresi: taban 70 olan ilan, puanı 72 olan adaya görünür, 60 olana görünmez.
      const eligible = await app.inject({ method: 'GET', url: '/api/jobs?kpssMaxScore=72' });
      expect((eligible.json() as { total: number }).total).toBeGreaterThanOrEqual(1);
      const ineligible = await app.inject({ method: 'GET', url: '/api/jobs?kpssMaxScore=60' });
      expect((ineligible.json() as { total: number }).total).toBe(0);
      // İstihdam filtresi kanonik değerle çalışır (sözleşmeli).
      const byType = await app.inject({ method: 'GET', url: '/api/jobs?employmentType=sozlesmeli' });
      expect((byType.json() as { total: number }).total).toBeGreaterThanOrEqual(1);
      const wrongType = await app.inject({ method: 'GET', url: '/api/jobs?employmentType=isci' });
      expect((wrongType.json() as { total: number }).total).toBe(0);
      // Serializer arayüzün beklediği etiketleri üretir.
      const list = (await app.inject({ method: 'GET', url: '/api/jobs' })).json() as {
        items: { employmentTypeLabel: string; statusLabel: string }[];
      };
      expect(list.items[0]?.employmentTypeLabel).toBeTruthy();
      expect(list.items[0]?.statusLabel).toBeTruthy();

      // Jetonlu çıkış: oturumsuz POST çalışmalı (e-posta istemcisi senaryosu).
      const { randomToken } = await import('../src/domain/ids');
      const token = randomToken(24);
      await repos.users.createToken({ userId: firstId, type: 'unsubscribe', token, ttlMinutes: 60 });
      const unsub = await app.inject({ method: 'POST', url: '/api/auth/unsubscribe', payload: { token } });
      expect(unsub.statusCode).toBe(200);
      const preference = await repos.notifications.getPreference(firstId);
      expect(preference?.enabled).toBe(false);
    } finally {
      await app.close();
      await store.close();
    }
  });
});
