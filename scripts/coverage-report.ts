/**
 * Kaynak kapsam raporu: `npm run sources:report`
 *
 * Gerçek durumu yazar: hangi kaynak doğrulandı, en son ne zaman başarılı tarandı,
 * kaç ilan üretti, hangi kaynaklar planlanıyor ama henüz entegre edilmedi.
 * Hiçbir zaman "tüm ilanlar toplanıyor" denmez.
 */
import { initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { listAdapters } from '../src/sources/registry';
import { toIstanbulDateOnly } from '../src/domain';

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

async function main(): Promise<void> {
  const store = await initStore();
  const repos = createRepos(store);
  await repos.sources.seed(SOURCE_DEFINITIONS);
  const coverage = await repos.sources.coverage();
  const now = repos.clock.now();

  // CI/otomasyon için makine okunur çıktı: `npm run sources:report -- --json`
  if (process.argv.includes('--json')) {
    const adapters = new Map(listAdapters().map((adapter) => [adapter.key, adapter]));
    console.log(
      JSON.stringify(
        {
          generatedAt: now.toISOString(),
          summary: coverage.summary,
          sources: coverage.sources.map((entry) => ({
            key: entry.key,
            status: entry.status,
            enabled: entry.enabled,
            verified: entry.verified,
            built: entry.built,
            adapterRegistered: adapters.has(
              SOURCE_DEFINITIONS.find((definition) => definition.key === entry.key)?.adapterKey ?? '',
            ),
            intervalMinutes: entry.intervalMinutes,
            lastSuccessAt: entry.health.lastSuccessAt,
            consecutiveFailures: entry.health.consecutiveFailures,
            verificationEvidence: entry.verificationEvidence,
          })),
          planned: coverage.planned.map((planned) => ({ id: planned.id, name: planned.name })),
          disclaimer:
            'Kapsam eksiktir: bazı kurumlar yalnızca kendi sayfalarında ilan yayımlar. Planlanan kaynaklar listede açıkça durur.',
        },
        null,
        2,
      ),
    );
    await closeStore();
    return;
  }

  const adapterCount = coverage.sources.filter((entry) => entry.built).length;
  console.log(`\nKamuİlan kaynak kapsamı — ${toIstanbulDateOnly(now)}`);
  console.log(
    `${coverage.summary.total} kayıtlı kaynak (etkin ${coverage.summary.enabled}, geçmiş canlı doğrulama kaydı bulunan ${coverage.summary.verified}, ` +
      `adaptörü yazılmış ${adapterCount}, canlı doğrulama bekleyen hazır ${coverage.summary.built}), ` +
      `planlanan ${coverage.summary.planned}, üst üste başarısız ${coverage.summary.failing}, bayat ${coverage.summary.stale}\n`,
  );

  console.log(
    pad('KAYNAK', 34),
    pad('DURUM', 16),
    pad('ETKİN', 6),
    pad('SON BAŞARI', 20),
    pad('HATA', 5),
    'ARALIK',
  );
  for (const entry of coverage.sources) {
    console.log(
      pad(entry.key, 34),
      pad(entry.status, 16),
      pad(entry.enabled ? 'evet' : 'hayır', 6),
      pad(entry.health.lastSuccessAt ? toIstanbulDateOnly(new Date(entry.health.lastSuccessAt)) : '—', 20),
      pad(String(entry.health.consecutiveFailures), 5),
      `${entry.intervalMinutes} dk`,
    );
  }

  const adapters = new Map(listAdapters().map((adapter) => [adapter.key, adapter]));
  console.log('\nDoğrulanmış kaynakların adaptör eşleşmesi:');
  for (const definition of SOURCE_DEFINITIONS.filter((source) => source.status === 'verified')) {
    const adapter = adapters.get(definition.adapterKey);
    console.log(
      `  ${adapter ? '✔' : '✖'} ${definition.key} → ${definition.adapterKey}${adapter ? ` (${adapter.method})` : ' (adaptör kayıtlı değil!)'}`,
    );
  }

  console.log('\nPlanlanan (henüz entegre edilmemiş) kaynaklar:');
  for (const planned of coverage.planned) {
    console.log(`  • ${planned.name} — ${planned.indirectCoverage}`);
  }

  const gaps = coverage.sources.filter((entry) => entry.enabled && !entry.verified);
  if (gaps.length > 0) {
    console.log('\nCanlı doğrulaması yapılmamış etkin kaynaklar (iddia edilmez):');
    for (const gap of gaps) console.log(`  ! ${gap.key} — ${gap.statusNote}`);
  }

  console.log(
    '\nNot: Bu liste eksiksiz değildir. Bazı kurumlar yalnızca kendi sayfalarında ilan yayımlar; ' +
      'kapsam boşlukları yukarıdaki "planlanan" bölümünde açıkça durur.',
  );
  console.log('Kapsamı genişletmek için: docs/source-onboarding.md');
  await closeStore();
}

main().catch(async (error: unknown) => {
  console.error('Kapsam raporu oluşturulamadı:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await closeStore().catch(() => undefined);
});
