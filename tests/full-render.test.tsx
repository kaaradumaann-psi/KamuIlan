// @vitest-environment jsdom
/**
 * Tam sayfa render süpürmesi: her sayfa, GERÇEK sunucu cevaplarıyla
 * (in-process Fastify + dosya deposu + ingest hattından geçmiş gerçek ilan)
 * hatasız açılmalı ve başlığını göstermelidir. Şekil uyumsuzlukları
 * (beyaz ekran sınıfı hatalar) burada yakalanır.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.APP_SECRET = 'full-render-secret-0123456789abcdef';
process.env.SOURCE_LIVE_FETCH = '0';

const payloads = new Map<string, unknown>();
const apiMock = {
  get: vi.fn(async (url: string) => {
    const data = payloads.get(url);
    if (data === undefined) throw new Error(`mock yok: ${url}`);
    return data;
  }),
  post: vi.fn(async () => ({ message: 'ok', saved: true })),
  patch: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
  del: vi.fn(async () => ({})),
};
vi.mock('../src/lib/api', () => ({ api: apiMock, errorMessage: (e: unknown) => String(e) }));

const { FileStore } = await import('../src/db/file-store');
const { createRepos } = await import('../src/db/repos/index');
const { fixedClock } = await import('../src/lib/clock');
const { hashPassword } = await import('../src/server/passwords');
const { buildApp } = await import('../src/server/app');
const { createLogger } = await import('../src/lib/logger');
const { applyRawAnnouncement } = await import('../src/ingest/jobs-service');
const { sozlesmeliPersonelIlani, belirsizDuyuru } = await import('./fixtures/announcements');
const { HomePage } = await import('../src/pages/Home');
const { JobsPage } = await import('../src/pages/Jobs');
const { JobDetailPage } = await import('../src/pages/JobDetail');
const { SourcesPage } = await import('../src/pages/Sources');
const { PanelPage } = await import('../src/pages/Panel');
const { SavedJobsPage } = await import('../src/pages/Saved');
const {
  FaqPage,
  ForgotPasswordPage,
  LoginPage,
  NotFoundPage,
  PrivacyPage,
  ResetPasswordPage,
  TermsPage,
  UnsubscribePage,
  VerifyEmailPage,
} = await import('../src/pages/auth');
const { SessionProvider } = await import('../src/lib/session');

const NOW = new Date('2026-10-12T09:00:00+03:00');
const CREDENTIAL = ['Guclu', 'Parola', '2026!'].join('-');
let jobId = '';

afterEach(() => cleanup());

function renderPage(ui: React.ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>{ui}</SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-full-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
  await repos.sources.seed([
    {
      key: 'test-kaynak',
      name: 'Test Kaynağı',
      group: 'kurum',
      sourceType: 'institution-page',
      institution: 'Test Kurumu',
      homepageUrl: 'https://ornek.test/',
      listingUrl: 'https://ornek.test/ilanlar',
      adapterKey: 'manual-entry',
      method: 'manual-entry',
      status: 'method-defined',
      statusNote: 'render testi',
      lastVerifiedAt: null,
      verificationEvidence: 'test',
      coverageNote: 'test',
      enabled: true,
      intervalMinutes: 60,
      minRequestIntervalMs: 0,
      maxConcurrency: 1,
      allowedHosts: ['ornek.test'],
      conditionalRequests: false,
      tags: ['test'],
    },
  ]);

  const { hash, salt } = await hashPassword(CREDENTIAL);
  const userRes = await repos.users.create({
    email: 'aday@ornek.test',
    passwordHash: hash,
    passwordSalt: salt,
    displayName: 'Test Aday',
    emailVerified: true,
  });
  const userId = userRes.user?.id ?? '';

  const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
    repos,
    now: NOW,
    workerId: 'render-test',
    provenance: 'sample',
  });
  expect(outcome.action).toBe('created');
  jobId = outcome.jobId ?? '';
  expect(jobId).not.toBe('');
  // İnceleme kuyruğunda da bir kayıt olsun (belirsiz duyuru).
  await applyRawAnnouncement(belirsizDuyuru(), {
    repos,
    now: NOW,
    workerId: 'render-test',
    provenance: 'sample',
  });
  await repos.savedJobs.toggle(userId, jobId);
  await repos.heartbeats.beat({
    workerId: 'kamuilan-test',
    role: 'worker',
    version: 'test',
    status: 'running',
    processedJobs: 1,
    lastError: null,
  });

  const app = await buildApp({
    repos,
    logger: createLogger('full-render', { level: 'silent' }),
    disableRateLimit: true,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'aday@ornek.test', password: CREDENTIAL },
  });
  expect(login.statusCode).toBe(200);
  const cookie = (login.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).join('; ');

  const urls = [
    '/api/auth/session',
    '/api/jobs',
    `/api/jobs/${jobId}`,
    '/api/jobs/stats',
    '/api/jobs/deadlines/upcoming',
    '/api/sources',
    '/api/health',
    '/api/me/saved-jobs',
    '/api/notifications/preferences',
    '/api/notifications/history',
  ];
  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode, url).toBe(200);
    payloads.set(url, res.json());
  }
  await app.close();
  await store.close();
});

describe('Sayfalar (gerçek API cevaplarıyla)', () => {
  it('ana sayfa', async () => {
    renderPage(<HomePage />);
    expect(
      await screen.findByRole('heading', { level: 1, name: /Kamu personel alım ilanları/ }),
    ).toBeTruthy();
  });

  it('ilan listesi gerçek ilanı gösterir', async () => {
    renderPage(<JobsPage />, '/ilanlar');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Kamu personel alım ilanları' }),
    ).toBeTruthy();
    expect((await screen.findAllByText(/Sözleşmeli Personel Alım İlanı/)).length).toBeGreaterThan(0);
  });

  it('ilan detayı', async () => {
    renderPage(
      <Routes>
        <Route path="/ilanlar/:id" element={<JobDetailPage />} />
      </Routes>,
      `/ilanlar/${jobId}`,
    );
    expect((await screen.findAllByText(/Sözleşmeli Personel Alım İlanı/)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Başvuru kontrol listesi/)).toBeTruthy();
  });

  it('kaynaklar', async () => {
    renderPage(<SourcesPage />, '/kaynaklar');
    expect(await screen.findByRole('heading', { level: 1, name: 'İlanları nereden alıyoruz?' })).toBeTruthy();
  });

  it('panel (tercihler + geçmiş)', async () => {
    const first = renderPage(<PanelPage view="preferences" />, '/panel');
    expect(await screen.findByRole('heading', { level: 1, name: 'Panelim' })).toBeTruthy();
    first.unmount();
    renderPage(<PanelPage view="history" />, '/panel/gecmis');
    expect(await screen.findByText(/Henüz bildirim üretilmedi/)).toBeTruthy();
  });

  it('kaydettiklerim gerçek kaydı listeler', async () => {
    renderPage(<SavedJobsPage />, '/panel/kaydedilenler');
    expect(await screen.findByRole('heading', { level: 1, name: /Kaydettiğim ilanlar/ })).toBeTruthy();
    expect((await screen.findAllByText(/Sözleşmeli Personel Alım İlanı/)).length).toBeGreaterThan(0);
  });

  it('giriş ve SSS', async () => {
    const first = renderPage(<LoginPage />, '/giris');
    expect(await screen.findByRole('heading', { level: 1, name: 'Giriş yap' })).toBeTruthy();
    first.unmount();
    renderPage(<FaqPage />, '/sss');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sıkça sorulan sorular' })).toBeTruthy();
  });
});

describe('Bilgi ve işlem sayfaları (bağlantılar kırık olmasın)', () => {
  it('parola/doğrulama/abonelik sayfaları hatasız açılır', async () => {
    for (const [element, expected] of [
      [<ForgotPasswordPage key="f" />, 'Parolamı unuttum'],
      [<ResetPasswordPage key="r" />, 'Bağlantı eksik'],
      [<VerifyEmailPage key="v" />, 'E-posta doğrulama'],
      [<UnsubscribePage key="u" />, 'Bildirimden çıkma'],
    ] as const) {
      const view = renderPage(element as React.ReactNode, '/');
      expect(await screen.findByRole('heading', { level: 1, name: expected })).toBeTruthy();
      view.unmount();
    }
  });

  it('404 ve politika sayfaları hatasız açılır', async () => {
    const notFound = renderPage(<NotFoundPage />, '/404');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sayfa bulunamadı' })).toBeTruthy();
    notFound.unmount();

    const privacy = renderPage(<PrivacyPage />, '/gizlilik');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Gizlilik ve KVKK Politikası' }),
    ).toBeTruthy();
    privacy.unmount();

    renderPage(<TermsPage />, '/kullanim');
    expect(await screen.findByRole('heading', { level: 1, name: 'Kullanım Koşulları' })).toBeTruthy();
  });
});
