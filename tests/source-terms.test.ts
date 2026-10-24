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
  it('depodaki kararlar: kullanıcı beyanıyla ilan.gov.tr erişimi açılır; diğer kararlar korunur', () => {
    const loaded = loadSourceTerms(process.cwd());
    expect(loaded.status).toBe('available');
    const expected: Record<string, 'allowed' | 'blocked' | 'unknown'> = {
      'resmigazete-cestili-ilanlar': 'allowed',
      'osym-duyurular': 'allowed',
      'iskur-kamu-memur-alim': 'blocked',
      'iskur-kurumdisi-kamu-isci': 'blocked',
      // 23.10.2026 eki: e-Şube kamu ilanları (site sahibi onayı).
      'iskur-esube-acik-is': 'allowed',
      'ilan-gov-tr-personel': 'allowed',
      'ilan-gov-tr-api-personel': 'allowed',
      'kariyerkapisi-isealim': 'allowed',
      'meb-personel-duyurular': 'allowed',
      'kamuilan-sbb': 'unknown',
      'saglik-bakanligi-personel': 'allowed',
      'adalet-bakanligi-duyurular': 'allowed',
      'icisleri-bakanligi-duyurular': 'blocked',
      'goc-idaresi-duyurular': 'blocked',
      'afad-duyurular': 'allowed',
      'sgk-duyurular': 'blocked',
      'dsi-duyurular': 'allowed',
      'kgm-duyurular': 'blocked',
      'tkgm-duyurular': 'allowed',
      'tubitak-duyurular': 'allowed',
      'yok-duyurular': 'allowed',
      'bddk-duyurular': 'allowed',
      'spk-duyurular': 'allowed',
      'epdk-duyurular': 'allowed',
      'tmsf-duyurular': 'allowed',
    };
    expect([...loaded.entries.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [key, decision] of Object.entries(expected)) {
      const entry = loaded.entries.get(key) ?? null;
      expect(entry?.decision, key).toBe(decision);
      // allowed kayıtlar kapıdan eksiksiz geçer; diğerleri hiçbir koşulda geçmez.
      expect(assessSourceTerms(entry, new Date('2026-10-24')).allowed, key).toBe(decision === 'allowed');
    }
  });

  it('kayıtlar envanterle tutarlı: her anahtar envanterde, otomatik taranan her kaynağın kaydı var', () => {
    const loaded = loadSourceTerms(process.cwd());
    expect(loaded.status).toBe('available');
    for (const key of loaded.entries.keys()) {
      expect(SOURCE_DEFINITIONS.find((item) => item.key === key), key).toBeTruthy();
    }
    for (const definition of SOURCE_DEFINITIONS.filter((item) => item.enabled && item.method !== 'manual-entry')) {
      expect(loaded.entries.has(definition.key), definition.key).toBe(true);
    }
    for (const key of STAGING_SOURCE_ALLOWLIST) {
      expect(SOURCE_DEFINITIONS.find((item) => item.key === key)?.enabled, key).toBe(true);
      expect(loaded.entries.has(key), key).toBe(true);
    }
  });

  it('incelenmiş kayıtların URL\'leri ilgili kaynağın izinli hostlarında; blocked/unknown saklamaya izin vermez', () => {
    const loaded = loadSourceTerms(process.cwd());
    for (const entry of loaded.entries.values()) {
      if (entry.decision === 'unknown' && !entry.reviewedAt) continue;
      const hosts = SOURCE_DEFINITIONS.find((item) => item.key === entry.sourceKey)?.allowedHosts ?? [];
      for (const url of [entry.robotsUrl, entry.termsUrl]) {
        expect(url, entry.sourceKey).toMatch(/^https:\/\//);
        expect(hosts, `${entry.sourceKey} ${url}`).toContain(new URL(url ?? '').hostname);
      }
      if (entry.decision !== 'allowed') expect(entry.allowsStorage, entry.sourceKey).not.toBe(true);
      expect(entry.notes.length, entry.sourceKey).toBeGreaterThan(0);
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
