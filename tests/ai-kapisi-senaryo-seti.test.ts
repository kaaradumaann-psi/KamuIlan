/**
 * YAPAY ZEKÂ KAPISI CANLI DOĞRULAMA SETİ — setin işe yarar kaldığını korur.
 *
 * Kanıt (16.10.2026): mevcut `tests/fixtures/eval/labeled-set.json` ile
 * `npm run eval:classification -- --llm` koşulduğunda kural motoru HER kaydı
 * kendisi karara bağlıyor (belirsiz oranı %0) → yapay zekâ kapısı HİÇ
 * çağrılmıyor, yani o set kapıyı test etmiyor. `ai-kapisi-senaryolari.json`
 * bu yüzden var: dört metin de kural motorunu bilerek `review`da bırakır.
 *
 * Bu test yerel ve ücretsizdir (API çağrısı yapmaz). Gerçek çağrılı koşum:
 *   npm run eval:classification -- --file tests/fixtures/eval/ai-kapisi-senaryolari.json --llm --json data\ai-kapisi-sonuc.json
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classify } from '../src/classification/engine';
import { CONTENT_TYPES, type ContentType } from '../src/domain/types';

interface Senaryo {
  id: string;
  title: string;
  sourceCategory: string;
  body: string;
  expectedContentType: ContentType;
  note?: string;
}

const dosya = join(process.cwd(), 'tests/fixtures/eval/ai-kapisi-senaryolari.json');
const { records } = JSON.parse(readFileSync(dosya, 'utf8')) as { records: Senaryo[] };

describe('yapay zekâ kapısı senaryo seti', () => {
  it('set boş değil ve beklenen türler geçerli', () => {
    expect(records.length).toBeGreaterThanOrEqual(4);
    for (const kayit of records) {
      expect(CONTENT_TYPES).toContain(kayit.expectedContentType);
      expect(kayit.body.length).toBeGreaterThan(200);
    }
  });

  it('her senaryo kural motorunda BELİRSİZ kalır (kapı gerçekten çağrılır)', () => {
    const belirsiz = records.filter((kayit) => {
      const sonuc = classify({ title: kayit.title, body: kayit.body, sourceCategory: kayit.sourceCategory });
      return sonuc.decision === 'review';
    });
    expect(belirsiz.map((kayit) => kayit.id).sort()).toEqual(records.map((kayit) => kayit.id).sort());
  });

  it('senaryo sayısı tanı çağrı bütçesini aşmaz (≤5 gerçek çağrı)', () => {
    expect(records.length).toBeLessThanOrEqual(5);
  });

  it('enjeksiyon senaryosunun geçme ölçütü ilan kabulünü yasaklar', () => {
    const enjeksiyon = records.find((kayit) => kayit.id === 'kapi-C-enjeksiyon');
    expect(enjeksiyon).toBeDefined();
    expect(enjeksiyon?.expectedContentType).not.toBe('personnel_recruitment');
    expect(enjeksiyon?.note ?? '').toContain('personnel_recruitment OLMAMALI');
  });
});
