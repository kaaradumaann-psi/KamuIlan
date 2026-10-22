/**
 * `npm run durum` — ölçülemeyen şey sağlıklı sayılmaz; worker durunca KRİTİK; loglardan son hatalar.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { getEnv } from '../src/config/env';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { fixedClock } from '../src/lib/clock';
import { buildStatusReport, formatStatusReport, readRecentErrors } from '../src/ops/status-report';

const NOW = new Date('2026-10-22T12:00:00Z');
let dir: string;
let store: FileStore;
let repos: Repos;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-durum-'));
  store = new FileStore(dir);
  await store.init();
  repos = createRepos(store);
  await repos.sources.seed(SOURCE_DEFINITIONS.slice(0, 3));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const env = () => getEnv({ NODE_ENV: 'test', EMAIL_PROVIDER: 'file' });

describe('durum raporu', () => {
  it('worker kalp atışı yoksa API cevap verse bile genel durum KRİTİK ve yapılacak iş yazılır', async () => {
    const report = await buildStatusReport(repos, env(), NOW, []);
    expect(report.level).toBe('critical');
    const worker = report.checks.find((check) => check.area.startsWith('Arka plan'));
    expect(worker?.level).toBe('critical');
    expect(worker?.action).toContain('start:worker');
    expect(formatStatusReport(report)).toContain('GENEL: KRİTİK');
  });

  it('taze kalp atışı + başarılı tarama → kritik değil; ölçülemeyen Telegram "bilinmiyor"', async () => {
    const clocked = createRepos(store, fixedClock(new Date(NOW.getTime() - 30_000)));
    await clocked.heartbeats.beat({ workerId: 'w1', role: 'worker', version: 'test', status: 'running', processedJobs: 0 });
    const report = await buildStatusReport(repos, env(), NOW, []);
    expect(report.checks.find((check) => check.area.startsWith('Arka plan'))?.level).toBe('healthy');
    expect(report.checks.find((check) => check.area === 'Telegram')?.level).toBe('unknown');
    expect(report.level).not.toBe('critical');
  });

  it('log dosyasından yalnız hata satırları, en yeni önce, bağlamıyla okunur', () => {
    const path = join(dir, 'worker.log');
    writeFileSync(
      path,
      [
        JSON.stringify({ level: 30, time: '2026-10-22T10:00:00Z', name: 'worker', msg: 'tik' }),
        JSON.stringify({ level: 50, time: '2026-10-22T10:05:00Z', name: 'scrape', msg: 'tarama başarısız', sourceKey: 'resmigazete', err: { message: 'zaman aşımı' } }),
        'json olmayan satır',
        JSON.stringify({ level: 60, time: '2026-10-22T11:00:00Z', name: 'api', msg: 'çöktü' }),
      ].join('\n'),
    );
    const errors = readRecentErrors([path]);
    expect(errors.map((error) => error.message)).toEqual(['çöktü', 'tarama başarısız — zaman aşımı']);
    expect(errors[1]?.context).toBe('sourceKey=resmigazete');
  });
});
