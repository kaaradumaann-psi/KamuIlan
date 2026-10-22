/**
 * Etiketleme çalışma sayfasından çevrimdışı HTML formu üretir (teknik olmayan etiketleyici için).
 *
 *   npm run eval:build-set                 → data/eval-worksheet.json (gerçek kayıtlar, salt okunur)
 *   npm run eval:label-page                → data/etiketleme.html (tarayıcıda açın)
 *   npm run eval:label-page -- --in <dosya> --out <dosya>
 *
 * Çıktı git dışıdır (data/); gerçek ilan alıntıları içerir, paylaşmayın.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderLabelPage } from '../src/classification/label-page';

const arg = (flag: string, fallback: string): string => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? (process.argv[index + 1] as string) : fallback;
};
const input = arg('--in', join(process.cwd(), 'data', 'eval-worksheet.json'));
const output = arg('--out', join(process.cwd(), 'data', 'etiketleme.html'));
const worksheet = JSON.parse(readFileSync(input, 'utf8')) as { records: unknown[] };
writeFileSync(output, renderLabelPage(worksheet), 'utf8');
console.log(`Etiketleme sayfası: ${output} (${worksheet.records.length} kayıt). Tarayıcıda açın; bitince "Dışa aktar".`);
console.log('Sonra: npm run eval:build-set -- --import <indirilen dosya>   (doğrular, yazmaz)');
