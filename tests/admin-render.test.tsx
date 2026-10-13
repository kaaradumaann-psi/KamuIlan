// @vitest-environment jsdom
/**
 * Yönetim paneli render regresyonu: sayfa, GERÇEK sunucu cevaplarıyla
 * (in-process Fastify + dosya deposu) tüm sekmelerde hatasız açılmalıdır.
 * Beyaz ekran hatası bu testle yakalanir.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.APP_SECRET = 'render-test-secret-0123456789abcdef';
process.env.SOURCE_LIVE_FETCH = '0';

const payloads = new Map<string, unknown>();
const apiMock = {
  get: vi.fn(async (url: string) => {
    const data = payloads.get(url);
    if (data === undefined) throw new Error(`mock yok: ${url}`);
    return data;
  }),
  post: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
};
vi.mock('../src/lib/api', () => ({ api: apiMock, errorMessage: (e: unknown) => String(e) }));

const { FileStore } = await import('../src/db/file-store');
const { createRepos } = await import('../src/db/repos/index');
const { fixedClock } = await import('../src/lib/clock');
const { hashPassword } = await import('../src/server/passwords');
const { buildApp } = await import('../src/server/app');
const { createLogger } = await import('../src/lib/logger');
const { AdminPage } = await import('../src/pages/Admin');

const NOW = new Date('2026-10-13T09:00:00+03:00');
const CREDENTIAL = ['Guclu', 'Parola', '2026!'].join('-');

beforeAll(async () => {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-render-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
  const { hash, salt } = await hashPassword(CREDENTIAL);
  const admin = await repos.users.create({
    email: 'admin@ornek.test',
    passwordHash: hash,
    passwordSalt: salt,
    displayName: 'Yönetici',
    emailVerified: true,
  });
  if (admin.user) {
    await repos.store.updateOne('users', { id: admin.user.id }, { role: 'admin' });
  }
  // Worker kalp atışı + başarısız bir tarama: kullanıcının gerçek durumu.
  await repos.heartbeats.beat({
    workerId: 'kamuilan-test',
    role: 'worker',
    status: 'running',
    version: 'test',
    processedJobs: 3,
    lastError: null,
  });
  const run = await repos.runs.start({
    sourceKey: 'resmigazete-cestili-ilanlar',
    trigger: 'schedule',
    workerId: 'kamuilan-test',
  });
  await repos.runs.finish(
    run.id,
    {
      itemsFound: 0,
      itemsAccepted: 0,
      itemsRejected: 0,
      itemsReview: 0,
      jobsCreated: 0,
      jobsUpdated: 0,
      itemsMerged: 0,
      revisionsCreated: 0,
      httpStatuses: [],
      errors: ['fetch failed'],
      notes: [],
    },
    'failed',
    'hata',
  );

  const app = await buildApp({
    repos,
    logger: createLogger('render-test', { level: 'silent' }),
    disableRateLimit: true,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@ornek.test', password: CREDENTIAL },
  });
  expect(login.statusCode).toBe(200);
  const cookie = (login.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).join('; ');
  const urls = [
    '/api/admin/overview',
    '/api/health',
    '/api/admin/sources',
    '/api/admin/scrape-runs',
    '/api/admin/review-queue',
    '/api/admin/email-outbox',
    '/api/admin/queue',
    '/api/admin/coverage-report',
    '/api/admin/audit-logs',
    '/api/admin/users',
  ];
  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode, url).toBe(200);
    payloads.set(url, res.json());
  }
  await app.close();
  await store.close();
});

describe('Yönetim paneli (gerçek API cevaplarıyla)', () => {
  it('tüm sekmelerde hatasız render olur', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <AdminPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Yönetim paneli')).toBeTruthy();
    expect(await screen.findByText('Otomatik kontrol durumu')).toBeTruthy();

    for (const label of [
      'Kaynaklar',
      'Tarama geçmişi',
      'İncelenecek ilanlar',
      'E-posta gönderimi',
      'İş sırası',
      'Kapsam durumu',
      'Kullanıcılar',
      'İşlem geçmişi',
      'Genel bakış',
    ]) {
      fireEvent.click(screen.getByRole('tab', { name: label }));
      await waitFor(() => expect(document.body.textContent?.length).toBeGreaterThan(50));
    }
  });
});
