/**
 * `.env.example` dosyasını `src/config/env-spec.ts`'ten üretir.
 *
 *   npm run env:example            → dosyayı yazar
 *   npm run env:example -- --check → farklıysa çıkış 1 (CI / test)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEnvExample } from '../src/config/env-example';

const path = join(process.cwd(), '.env.example');
const next = renderEnvExample();
if (process.argv.includes('--check')) {
  const current = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  if (current !== next) {
    console.error('.env.example güncel değil: npm run env:example çalıştırın.');
    process.exitCode = 1;
  } else {
    console.log('.env.example güncel.');
  }
} else {
  writeFileSync(path, next, 'utf8');
  console.log(`.env.example yazıldı (${next.split('\n').length} satır).`);
}
