/**
 * Ortam denetimi: `npm run env:check`
 *
 * Hiçbir gizli değeri yazdırmaz; yalnızca maskeli özet ve sorun/uyarı listesi.
 * Sorun varsa çıkış kodu 1'dir (CI ve docker healthcheck bunu kullanır).
 */
import { describeEnv, getEnv, inspectEnvironment } from '../src/config/env';

function main(): void {
  let env;
  try {
    env = getEnv();
  } catch (error) {
    console.error('✖ Ortam değişkenleri okunamadı:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const inspection = inspectEnvironment(env);
  console.log('KamuRadar ortam özeti (gizli değer yok):');
  for (const [key, value] of Object.entries(describeEnv(env))) {
    console.log(`  ${key.padEnd(14)}: ${String(value)}`);
  }

  if (inspection.warnings.length > 0) {
    console.log('\nUyarılar:');
    for (const warning of inspection.warnings) console.log(`  ! ${warning}`);
  }
  if (inspection.problems.length > 0) {
    console.error('\nHatalar:');
    for (const problem of inspection.problems) console.error(`  ✖ ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n✔ Ortam yapılandırması kullanılabilir.');
}

main();
