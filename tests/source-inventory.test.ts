import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import {
  buildStaticSourceInventory,
  inspectFixtureManifest,
  renderSourceMatrixMarkdown,
} from '../src/sources/inventory';

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'kamuilan-source-inventory-'));
}

function writeManifestFixture(root: string, sourceUrl: string) {
  const fixtureDirectory = join(root, 'fixtures', 'html');
  mkdirSync(fixtureDirectory, { recursive: true });
  const source = SOURCE_DEFINITIONS.find((item) => item.method !== 'manual-entry')!;
  const relativeFile = `fixtures/html/${source.key}-2026-10-17.html`;
  const bytes = Buffer.from('<html><body>synthetic redacted fixture</body></html>', 'utf8');
  writeFileSync(join(root, relativeFile), bytes);
  const manifest = {
    version: 1,
    generatedAt: '2026-10-17T12:00:00.000Z',
    entries: [
      {
        sourceKey: source.key,
        sourceUrl,
        file: relativeFile,
        capturedAt: '2026-10-17T11:59:00.000Z',
        bytes: bytes.length,
        contentType: 'text/html; charset=utf-8',
        status: 200,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        captureMethod: 'capture-fixtures/v1 HttpClient.fetchText (one listing request; no PDF/detail)',
        redacted: true,
        redactionNotes: ['synthetic test fixture; no real personal data'],
      },
    ],
  };
  writeFileSync(join(fixtureDirectory, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return source;
}

describe('statik kaynak envanteri ve fixture manifest sözleşmesi', () => {
  it('kaynak key/adapter/allowlist sözleşmesini ağ veya DB açmadan doğrular', () => {
    const report = buildStaticSourceInventory();
    expect(report.mode).toBe('offline-static');
    expect(report.sourceContract).toMatchObject({
      sourceKeysUnique: true,
      missingAdapters: [],
      listingHostNotAllowlisted: [],
      sourceCount: 28,
      adapterCount: 12,
    });
    expect(report.runtimeEvidence).toEqual({
      liveFetch: 'NOT RUN',
      productionDatabase: 'NOT READ',
      sourceHealth: 'UNKNOWN',
      zeroResultReason: 'NOT OBSERVED',
    });
    expect(report.fixtureManifest.status).toBe('none');
    expect(report.summary.fixtureSnapshots).toBe(0);
  });

  it('yalnızca allowlist hostlu, hashli ve scrub durumu belgeli HTML/JSON snapshot kabul eder', () => {
    const root = temporaryRoot();
    const source = SOURCE_DEFINITIONS.find((item) => item.method !== 'manual-entry')!;
    writeManifestFixture(root, source.listingUrl);

    const result = inspectFixtureManifest(root);

    expect(result.status).toBe('available');
    expect(result.validCount).toBe(1);
    expect(result.entries[0]).toMatchObject({ sourceKey: source.key, valid: true });
  });

  it('secret benzeri query parametresi olan fixture provenance URL’sini reddeder', () => {
    const root = temporaryRoot();
    const source = SOURCE_DEFINITIONS.find((item) => item.method !== 'manual-entry')!;
    const url = new URL(source.listingUrl);
    url.searchParams.set('apiKey', 'must-not-be-committed');
    writeManifestFixture(root, url.toString());

    const result = inspectFixtureManifest(root);

    expect(result.status).toBe('invalid');
    expect(result.errors.join(' ')).toContain('hassas token/session/auth query');
    expect(JSON.stringify(result)).not.toContain('must-not-be-committed');
  });

  it('manifest dışındaki HTML/JSON dosyalarını rapora almadan fail-closed reddeder', () => {
    const root = temporaryRoot();
    const fixtureDirectory = join(root, 'fixtures', 'html');
    mkdirSync(fixtureDirectory, { recursive: true });
    writeFileSync(join(fixtureDirectory, 'private-email@example.test.html'), '<html></html>', 'utf8');
    writeFileSync(join(fixtureDirectory, 'manifest.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8');

    const result = inspectFixtureManifest(root);

    expect(result.status).toBe('invalid');
    expect(result.errors.join(' ')).toContain('Manifestte bulunmayan 1');
    expect(JSON.stringify(result)).not.toContain('private-email@example.test');
  });

  it('hash/redaction/path hatalı fixture manifestini reddeder', () => {
    const root = temporaryRoot();
    const fixtureDirectory = join(root, 'fixtures', 'html');
    mkdirSync(fixtureDirectory, { recursive: true });
    const source = SOURCE_DEFINITIONS.find((item) => item.method !== 'manual-entry')!;
    writeFileSync(join(fixtureDirectory, 'snapshot.html'), '<html>not scrubbed</html>', 'utf8');
    writeFileSync(
      join(fixtureDirectory, 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            sourceKey: source.key,
            sourceUrl: source.listingUrl,
            file: '../outside.html',
            capturedAt: '2026-10-17T11:59:00.000Z',
            contentType: 'text/html',
            status: 200,
            sha256: '0'.repeat(64),
            captureMethod: 'synthetic-contract-test',
            redacted: false,
            redactionNotes: [],
          },
        ],
      }),
      'utf8',
    );

    const result = inspectFixtureManifest(root);

    expect(result.status).toBe('invalid');
    expect(result.invalidCount).toBe(1);
    expect(result.entries[0]?.errors.join(' ')).toMatch(/göreli|redacted/);
  });
});

describe('kaynak kapsam matrisi', () => {
  it('tüm kaynakları canlı kanıtı NOT RUN olarak işaretler ve fixture yokluğunu gizlemez', () => {
    const report = buildStaticSourceInventory();
    const markdown = renderSourceMatrixMarkdown(report);
    expect(markdown).toContain('Kaynak kapsam matrisi (statik envanter)');
    expect(markdown).toContain('NOT RUN / UNKNOWN');
    expect(markdown).toContain('fixture snapshot: **0**');
    expect(markdown).toContain('| YOK |');
    expect(markdown).toContain('Bu matrisin kanıtlamadığı şeyler');
  });

  it('kaynak URL ve hücre içeriğindeki dikey çizgiyi Markdown tablosunu bozmadan kaçırır', () => {
    const report = buildStaticSourceInventory();
    const markdown = renderSourceMatrixMarkdown(report);
    const rows = markdown.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| sourceKey') && !line.startsWith('|---'));
    expect(rows.length).toBe(report.sources.length);
    for (const row of rows) {
      // 9 sütun + baştaki/sondaki boş parçalar = 11.
      expect(row.split('|').length).toBe(11);
    }
  });
});
