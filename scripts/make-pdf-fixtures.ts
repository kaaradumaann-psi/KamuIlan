/**
 * PDF fixture üreticisi: `npm run fixtures:pdf`
 *
 * fixtures/pdf altındaki dosyalar testlerde okunur. Üretici kod
 * tests/support/pdf-fixtures.ts içinde tutulur ki testler ile fixture'lar
 * aynı kaynaktan gelsin (bkz. tests/pdf.test.ts tutarlılık testi).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleAnnouncementPdf, scannedAnnouncementPdf } from '../tests/support/pdf-fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const targetDir = resolve(join(here, '..', 'fixtures', 'pdf'));
mkdirSync(targetDir, { recursive: true });

const files: { name: string; data: Buffer; note: string }[] = [
  {
    name: 'ornek-ilan.pdf',
    data: sampleAnnouncementPdf(),
    note: 'metin katmanı var (sözleşmeli personel alım ilanı)',
  },
  {
    name: 'taranmis-ornek.pdf',
    data: scannedAnnouncementPdf(),
    note: 'metin katmanı yok (taranmış görüntü benzeri)',
  },
];

for (const file of files) {
  const path = join(targetDir, file.name);
  writeFileSync(path, file.data);
  console.log(`• ${file.name} (${file.data.byteLength} bayt) — ${file.note}`);
}
console.log(`✔ PDF fixture'ları hazır: ${targetDir}`);
