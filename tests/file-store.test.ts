/**
 * Dosya deposu testleri.
 *
 * Neden önemli: geliştirmede API, worker ve betikler (ör. `npm run seed:demo`)
 * AYNI dosyayı paylaşan ayrı süreçlerdir. Depo, başka bir sürecin yazdığını
 * görmezse kendi eski bellek kopyasını diske yazar ve o kayıtları ezer. Bu test
 * tam olarak o senaryoyu ölçer (regresyon: seed:demo ile eklenen ilanlar worker'ın
 * kalp atışı yazımıyla silinmişti).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import type { SourceDefinition } from '../src/config/sources';

function definition(key: string, name: string): SourceDefinition {
  return {
    key,
    name,
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Test Kurumu',
    homepageUrl: 'https://ornek.test/',
    listingUrl: 'https://ornek.test/ilanlar',
    adapterKey: 'test-liste',
    method: 'html-list',
    status: 'method-defined',
    statusNote: 'Yalnızca testler için sahte kaynak tanımı.',
    lastVerifiedAt: null,
    verificationEvidence: 'Testlerde canlı erişim yapılmaz.',
    coverageNote: 'Test kapsamı.',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 0,
    maxConcurrency: 1,
    allowedHosts: ['ornek.test'],
    tags: ['test'],
  };
}

describe('dosya deposu — süreçler arası tutarlılık', () => {
  it('başka bir sürecin yazdığı kayıtları okur ve kendi yazımıyla ezmez', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kamuradar-filestore-'));

    // İki ayrı depo = iki ayrı süreç (aynı dosya).
    const first = new FileStore(dir);
    await first.init();
    const second = new FileStore(dir);
    await second.init();

    const reposFirst = createRepos(first);
    const reposSecond = createRepos(second);

    await reposFirst.sources.seed([definition('kaynak-bir', 'Birinci kaynak')]);

    // İkinci süreç, yazma yapmadan önce birinci sürecin yazdığını GÖRMELİ.
    const seenBySecond = await reposSecond.sources.getByKey('kaynak-bir');
    expect(seenBySecond).not.toBeNull();

    // İkinci süreç kendi kaydını yazar; birinci kayıt korunmalı.
    await reposSecond.sources.seed([definition('kaynak-iki', 'İkinci kaynak')]);

    // Üçüncü bir okuyucu (ör. yeni bir betik) iki kaynağı da görmeli.
    const reader = new FileStore(dir);
    await reader.init();
    const keys = (await reader.find('sources')).map((row) => row.key).sort();
    expect(keys).toEqual(['kaynak-bir', 'kaynak-iki']);
  });

  it('bozuk dosyayı yedekleyip temiz durumla devam eder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kamuradar-filestore-corrupt-'));
    const store = new FileStore(dir);
    await store.init();
    const repos = createRepos(store);
    await repos.sources.seed([definition('kaynak-bir', 'Birinci kaynak')]);

    // Dosyayı bozalım: sonraki açılış hata vermemeli, bozuk kopya saklanmalı.
    const { writeFileSync, readdirSync } = await import('node:fs');
    writeFileSync(join(dir, 'kamuradar.json'), '{ bu geçerli json değil', 'utf8');

    const fresh = new FileStore(dir);
    await expect(fresh.init()).rejects.toThrow(/Veri dosyası okunamadı/);
    expect(readdirSync(dir).some((file) => file.includes('.corrupt-'))).toBe(true);
  });
});
