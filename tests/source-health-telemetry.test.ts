/**
 * Kaynak sağlık telemetrisi: sahte adaptörle gerçek tarama hattı (runSourceScrape) çalıştırılır.
 *
 * Kanıtlanan sözleşmeler:
 *  - Yapı hatası (AdapterStructureError) "structure", HTTP hatası "fetch" + son HTTP durumu,
 *    kullanılamayan kaynak "unavailable" olarak kaydedilir; hiçbiri başarı sayılmaz.
 *  - Son içerik çıkarma zamanı yalnızca ham kayıt çıkarıldığında güncellenir.
 *  - Daha önce kayıt veren kaynağın birden sıfır dönmesi "beklenmeyen sıfır" olarak işaretlenir.
 *  - Başarılı ve gerçekten boş bir tarama beklenmeyen sıfır değildir (ilk sıfır).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { classifyErrorType, runSourceScrape } from '../src/ingest/pipeline';
import type { SourceDefinition } from '../src/config/sources';
import type { SourceDoc } from '../src/db/schemas';
import { AdapterStructureError, AdapterUnavailableError } from '../src/sources/errors';
import { FetchError } from '../src/sources/fetcher';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../src/sources/types';

const NOW = new Date('2026-10-15T09:00:00+03:00');
const WORKER = 'worker-telemetry-test';

function definitionFor(key: string): SourceDefinition {
  return {
    key,
    name: `Test — ${key}`,
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Test Kurumu',
    listingUrl: 'https://ornek.test/ilanlar',
    homepageUrl: 'https://ornek.test/',
    adapterKey: 'test-adapter',
    method: 'html-list',
    status: 'method-defined',
    statusNote: 'Yalnızca testler için.',
    lastVerifiedAt: null,
    verificationEvidence: 'tests/source-health-telemetry.test.ts',
    coverageNote: 'Test.',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 0,
    maxConcurrency: 1,
    allowedHosts: ['ornek.test'],
    tags: ['test'],
  };
}

async function makeRepos(): Promise<Repos> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-telemetry-'));
  const store = new FileStore(dir);
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

async function seedSource(repos: Repos, key: string): Promise<SourceDoc> {
  await repos.sources.seed([definitionFor(key)]);
  const doc = await repos.sources.getByKey(key);
  if (!doc) throw new Error('Test kaynağı oluşturulamadı');
  return doc;
}

/** Sıradaki davranışı çalıştıran sahte adaptör. Her çağrıda `behaviour` yeniden okunur. */
function scriptedAdapter(behaviour: () => AdapterRunResult | Promise<AdapterRunResult>): SourceAdapter {
  return {
    key: 'test-adapter',
    label: 'Test adaptörü',
    method: 'html-list',
    notes: 'test',
    run: async (_ctx: AdapterContext) => behaviour(),
  };
}

const emptyResult = (): AdapterRunResult => ({
  items: [],
  requestCount: 1,
  notes: [],
  etag: null,
  lastModified: null,
  notModified: false,
  httpStatuses: [200],
  coverage: { status: 'complete', note: 'test: tüm sayfalar gezildi' },
});

const oneItemResult = (): AdapterRunResult => ({
  items: [
    {
      sourceKey: 'telemetry-a',
      sourceItemId: 'ilan-1001',
      url: 'https://ornek.test/ilan/1001',
      title: 'Test Kurumu Sözleşmeli Bilişim Personeli Alım İlanı',
      institution: 'Test Kurumu',
      sourceCategory: 'personel alımı',
      bodyText:
        'Kadro unvanı Bilişim Personeli. Kontenjan 2. Başvurular 01.10.2026 - 30.10.2026 tarihleri arasında alınacaktır.',
      attachments: [],
      extractionConfidence: 0.9,
    },
  ],
  requestCount: 1,
  notes: [],
  etag: null,
  lastModified: null,
  notModified: false,
  httpStatuses: [200],
  coverage: { status: 'complete', note: 'test: tüm sayfalar gezildi' },
});

async function run(repos: Repos, source: SourceDoc, adapter: SourceAdapter) {
  return runSourceScrape({
    repos,
    source,
    trigger: 'schedule',
    workerId: WORKER,
    adapter,
    logger: createLogger('test', { level: 'silent' }),
    queueNotifications: false,
    liveFetch: true,
  });
}

async function health(repos: Repos, key: string) {
  const doc = await repos.sources.getByKey(key);
  if (!doc) throw new Error('kaynak yok');
  return doc.health;
}

describe('kaynak sağlık telemetrisi', () => {
  it('yapı hatası "structure" olarak kaydedilir ve başarı sayılmaz', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos, 'telemetry-structure');
    const adapter = scriptedAdapter(async () => {
      throw new AdapterStructureError('telemetry-structure', 'Liste yapısı tanınmadı');
    });
    await run(repos, source, adapter);
    const h = await health(repos, 'telemetry-structure');
    expect(h.lastErrorType).toBe('structure');
    expect(h.consecutiveFailures).toBe(1);
    expect(h.lastSuccessAt).toBeNull();
  });

  it('HTTP hatası "fetch" ve son HTTP durumunu kaydeder', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos, 'telemetry-fetch');
    const adapter = scriptedAdapter(async () => {
      throw new FetchError('https://ornek.test/ilanlar', 'Sunucu hatası', 503, true);
    });
    await run(repos, source, adapter);
    const h = await health(repos, 'telemetry-fetch');
    expect(h.lastErrorType).toBe('fetch');
    expect(h.lastHttpStatus).toBe(503);
  });

  it('kullanılamayan kaynak "unavailable" olarak kaydedilir (atlama, hata değil)', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos, 'telemetry-unavailable');
    const adapter = scriptedAdapter(async () => {
      throw new AdapterUnavailableError('telemetry-unavailable', 'Tarayıcı çalışma zamanı yok', 'playwright');
    });
    await run(repos, source, adapter);
    const h = await health(repos, 'telemetry-unavailable');
    expect(h.lastErrorType).toBe('unavailable');
    expect(h.consecutiveSkips).toBe(1);
  });

  it('içerik çıkarma zamanı yalnızca ham kayıt işlendiğinde güncellenir', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos, 'telemetry-extract');
    await run(repos, source, scriptedAdapter(emptyResult));
    expect((await health(repos, 'telemetry-extract')).lastExtractionAt).toBeNull();
    await run(repos, source, scriptedAdapter(oneItemResult));
    const after = await health(repos, 'telemetry-extract');
    expect(after.lastExtractionAt).not.toBeNull();
    expect(after.lastErrorType).toBeNull();
  });

  it('ilk boş tarama beklenmeyen sıfır değildir', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos, 'telemetry-zero-first');
    await run(repos, source, scriptedAdapter(emptyResult));
    expect((await health(repos, 'telemetry-zero-first')).unexpectedZero).toBe(false);
  });

  it('daha önce kayıt veren kaynağın birden sıfır dönmesi beklenmeyen sıfır olarak işaretlenir', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos, 'telemetry-zero-drop');
    await run(repos, source, scriptedAdapter(oneItemResult));
    expect((await health(repos, 'telemetry-zero-drop')).unexpectedZero).toBe(false);
    await run(repos, source, scriptedAdapter(emptyResult));
    expect((await health(repos, 'telemetry-zero-drop')).unexpectedZero).toBe(true);
  });

  it('hata türü sınıflandırması', () => {
    expect(classifyErrorType(new AdapterUnavailableError('k', 'm', 'r'), 0)).toBe('unavailable');
    expect(classifyErrorType(new AdapterStructureError('k', 'm'), 0)).toBe('structure');
    expect(classifyErrorType(new FetchError('u', 'm', 500, true), 0)).toBe('fetch');
    expect(classifyErrorType(new Error('başka'), 0)).toBe('other');
    expect(classifyErrorType(null, 2)).toBe('item');
    expect(classifyErrorType(null, 0)).toBeNull();
  });
});
