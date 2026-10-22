/**
 * Kaynak kullanım şartları kapısı tarama hattında (22.10.2026 üretim provası bulgusu: kapı yalnız
 * staging betiklerinde kullanılıyordu; worker şartları "blocked" bir kaynağı bile tarayabilirdi).
 */
import { describe, expect, it } from 'vitest';
import { sourceTermsGate, type SourceTermsLoadResult, type SourceTermsEntry } from '../src/sources/terms';

const NOW = new Date('2026-10-22T10:00:00Z');

function loaded(entries: SourceTermsEntry[]): SourceTermsLoadResult {
  return { status: 'available', path: 'config/source-terms.json', entries: new Map(entries.map((e) => [e.sourceKey, e])), errors: [] };
}

const allowed: SourceTermsEntry = {
  sourceKey: 'izinli',
  decision: 'allowed',
  reviewedAt: '2026-10-21',
  reviewedBy: 'operatör',
  robotsUrl: 'https://ornek.gov.tr/robots.txt',
  termsUrl: 'https://ornek.gov.tr/',
  allowsStorage: true,
  notes: '',
};
const blocked: SourceTermsEntry = { ...allowed, sourceKey: 'yasakli', decision: 'blocked' };
const terms = loaded([allowed, blocked]);

describe('sourceTermsGate', () => {
  it('blocked kaynak her iki politikada atlanır', () => {
    expect(sourceTermsGate('yasakli', 'warn', terms, NOW).skip).toBe(true);
    expect(sourceTermsGate('yasakli', 'enforce', terms, NOW).skip).toBe(true);
  });

  it('incelenmiş + allowed kaynak notsuz taranır', () => {
    expect(sourceTermsGate('izinli', 'enforce', terms, NOW)).toEqual({ skip: false, note: null });
  });

  it('kaydı olmayan kaynak: warn → taranır + not; enforce → atlanır', () => {
    const warn = sourceTermsGate('bilinmeyen', 'warn', terms, NOW);
    expect(warn.skip).toBe(false);
    expect(warn.note).toContain('incelenmedi');
    const enforce = sourceTermsGate('bilinmeyen', 'enforce', terms, NOW);
    expect(enforce.skip).toBe(true);
    expect(enforce.note).toContain('SOURCE_TERMS_POLICY=enforce');
  });

  it('inceleme 365 günden eskiyse enforce taramaz', () => {
    const stale = loaded([{ ...allowed, reviewedAt: '2025-01-01' }]);
    expect(sourceTermsGate('izinli', 'enforce', stale, NOW).skip).toBe(true);
  });
});

describe('runSourceScrape + SOURCE_TERMS_POLICY=enforce', () => {
  it('şartları doğrulanmamış kaynak ağa çıkmadan "atlandı" kaydedilir', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { FileStore } = await import('../src/db/file-store');
    const { createRepos } = await import('../src/db/repos');
    const { runSourceScrape } = await import('../src/ingest/pipeline');
    const { resetEnvCache } = await import('../src/config/env');
    const { SOURCE_DEFINITIONS } = await import('../src/config/sources');
    const dir = mkdtempSync(join(tmpdir(), 'kamuilan-sartlar-'));
    const store = new FileStore(dir);
    const previous = { policy: process.env.SOURCE_TERMS_POLICY, live: process.env.SOURCE_LIVE_FETCH };
    process.env.SOURCE_TERMS_POLICY = 'enforce';
    resetEnvCache();
    try {
      await store.init();
      const repos = createRepos(store);
      // 22.10.2026 incelemesinde kararı `unknown` kalan kaynak (yasal uyarı bağlantısı çözülmüyor).
      const definition = SOURCE_DEFINITIONS.find((entry) => entry.key === 'kamuilan-sbb')!;
      await repos.sources.seed([definition]);
      // #84 öncesi üretimde yazılmış eski durum: politika atlaması "Bilinmeyen hata" sayılmıştı.
      await repos.sources.recordHealth(definition.key, {
        lastRunAt: '2026-10-22T17:39:43.000Z', success: false, durationMs: 30, discoveredCount: 0, acceptedCount: 0, skipped: true,
      });
      expect((await repos.sources.getByKey(definition.key))!.health.lastErrorMessage).toBe('Bilinmeyen hata');
      const source = (await repos.sources.getByKey(definition.key))!;
      const requests: string[] = [];
      const http = {
        fetchText: async (url: string) => {
          requests.push(url);
          throw new Error('ağa çıkılmamalıydı');
        },
        fetchBinary: async (url: string) => {
          requests.push(url);
          throw new Error('ağa çıkılmamalıydı');
        },
        close: async () => undefined,
      };
      const result = await runSourceScrape({ repos, source, trigger: 'manual', workerId: 'w', liveFetch: true, http: http as never, queueNotifications: false });
      expect(result.status).toBe('skipped');
      expect(result.notes.join(' ')).toContain('SOURCE_TERMS_POLICY=enforce');
      expect(requests).toEqual([]);

      // Üretim bulgusu (22.10.2026, Oracle): politika atlaması "Bilinmeyen hata" ile başarısızlık
      // sayılıyor, durum raporu sahte KRİTİK veriyordu. Atlama sağlık sayaçlarına yazılmaz.
      await runSourceScrape({ repos, source, trigger: 'manual', workerId: 'w', liveFetch: true, http: http as never, queueNotifications: false });
      const health = (await repos.sources.getByKey(definition.key))!.health;
      expect(health.consecutiveFailures).toBe(0);
      expect(health.lastErrorAt).toBeNull();
      expect(health.lastErrorMessage).toBeNull();
      const coverage = await repos.sources.coverage({ termsPolicy: 'enforce' });
      expect(coverage.summary).toMatchObject({ failing: 0, stale: 0, awaitingTerms: 1 });
      expect(coverage.sources.find((entry) => entry.key === definition.key)?.termsGated).toBe(true);
    } finally {
      if (previous.policy === undefined) delete process.env.SOURCE_TERMS_POLICY;
      else process.env.SOURCE_TERMS_POLICY = previous.policy;
      resetEnvCache();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('varsayılan politika (22.10.2026 kullanıcı kararı)', () => {
  it('SOURCE_TERMS_POLICY tanımsız/boşsa enforce', async () => {
    const { getEnv } = await import('../src/config/env');
    expect(getEnv({ NODE_ENV: 'test', SOURCE_TERMS_POLICY: undefined }).SOURCE_TERMS_POLICY).toBe('enforce');
    expect(getEnv({ NODE_ENV: 'test', SOURCE_TERMS_POLICY: '' }).SOURCE_TERMS_POLICY).toBe('enforce');
  });
});
