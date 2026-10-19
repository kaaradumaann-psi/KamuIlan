import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { STAGING_SOURCE_ALLOWLIST } from '../src/config/staging';
import { assessSourceTerms, loadSourceTerms, SOURCE_TERMS_PATH, type SourceTermsEntry } from '../src/sources/terms';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'kamuradar-terms-'));
}

function writeTerms(root: string, doc: unknown): void {
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, SOURCE_TERMS_PATH), JSON.stringify(doc, null, 2));
}

const validEntry: SourceTermsEntry = {
  sourceKey: 'resmigazete-cestili-ilanlar',
  decision: 'allowed',
  reviewedAt: '2026-10-01',
  reviewedBy: 'operatör',
  robotsUrl: 'https://www.resmigazete.gov.tr/robots.txt',
  termsUrl: 'https://www.resmigazete.gov.tr/kullanim-sartlari',
  allowsStorage: true,
  notes: '',
};

describe('kaynak erişim şartları kapısı', () => {
  it('depodaki şablon geçerlidir ve tüm kaynaklar başlangıçta unknown', () => {
    const loaded = loadSourceTerms(process.cwd());
    expect(loaded.status).toBe('available');
    for (const key of STAGING_SOURCE_ALLOWLIST) {
      const entry = loaded.entries.get(key);
      expect(entry, key).toBeTruthy();
      expect(entry?.decision).toBe('unknown');
    }
  });

  it('allowlist ile şablon kayıtları birbirinden kopmaz', () => {
    const loaded = loadSourceTerms(process.cwd());
    expect([...loaded.entries.keys()].sort()).toEqual([...STAGING_SOURCE_ALLOWLIST].sort());
    for (const key of STAGING_SOURCE_ALLOWLIST) {
      const definition = SOURCE_DEFINITIONS.find((item) => item.key === key);
      expect(definition, key).toBeTruthy();
      expect(definition?.enabled, key).toBe(true);
    }
  });

  it('dosya yoksa missing, bozuk JSON ise invalid', () => {
    expect(loadSourceTerms(tempRoot()).status).toBe('missing');
    const root = tempRoot();
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, SOURCE_TERMS_PATH), '{bozuk');
    expect(loadSourceTerms(root).status).toBe('invalid');
  });

  it('şema dışı alan ve tekrarlanan sourceKey reddedilir', () => {
    const root = tempRoot();
    writeTerms(root, { version: 1, kaynaklar: [] });
    expect(loadSourceTerms(root).status).toBe('invalid');

    const duplicate = tempRoot();
    writeTerms(duplicate, { version: 1, sources: [validEntry, validEntry] });
    const result = loadSourceTerms(duplicate);
    expect(result.status).toBe('invalid');
    expect(result.errors.join(' ')).toContain('birden fazla');
  });

  it('canlı koşum yalnızca tam ve taze insan incelemesiyle açılır', () => {
    const now = new Date('2026-10-17T00:00:00Z');
    expect(assessSourceTerms(null, now).allowed).toBe(false);
    expect(assessSourceTerms({ ...validEntry, decision: 'blocked' }, now).allowed).toBe(false);
    expect(assessSourceTerms({ ...validEntry, decision: 'unknown' }, now).allowed).toBe(false);
    expect(assessSourceTerms({ ...validEntry, reviewedBy: '  ' }, now).allowed).toBe(false);
    expect(assessSourceTerms({ ...validEntry, reviewedAt: null }, now).allowed).toBe(false);
    expect(assessSourceTerms({ ...validEntry, allowsStorage: null }, now).allowed).toBe(false);
    expect(assessSourceTerms({ ...validEntry, allowsStorage: false }, now).allowed).toBe(false);
    expect(assessSourceTerms({ ...validEntry, robotsUrl: 'http://example.com/robots.txt' }, now).allowed).toBe(false);
    expect(assessSourceTerms({ ...validEntry, termsUrl: null }, now).allowed).toBe(false);
    expect(assessSourceTerms({ ...validEntry, reviewedAt: '2024-01-01' }, now).allowed).toBe(false);
    expect(assessSourceTerms(validEntry, now)).toMatchObject({ allowed: true });
  });

  it('değerlendirme ham değer döndürür ama karar gerekçesini Türkçe açıklar', () => {
    const assessment = assessSourceTerms(null);
    expect(assessment.entry).toBeNull();
    expect(assessment.reason).toContain('unknown');
  });
});
