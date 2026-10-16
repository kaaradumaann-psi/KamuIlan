/**
 * TEK SENARYOLUK CANLI DOĞRULAMA SETİ — bütünlük ve kural motoru davranışı.
 *
 * Neden var: 16.10.2026 canlı koşumlarında sağlayıcı, 4 çağrılık seti kota/yoğunluk
 * nedeniyle (HTTP 429 `RESOURCE_EXHAUSTED`, HTTP 503 `UNAVAILABLE`) reddetti ve ölçüm
 * yapılamadı. Kota kısıtlıyken bile "kapı geçerli ve doğru çıktı üretiyor mu?" sorusunu
 * **tek** gerçek çağrıyla yanıtlayabilmek için bu set eklendi:
 *   npm run eval:classification -- --file tests/fixtures/eval/ai-kapisi-tek-senaryo.json --llm --json data\ai-kapisi-tek.json
 *
 * Bu test yereldir ve API çağrısı yapmaz. Amaçları:
 *  1) setin tek kaydının 4 senaryoluk setteki `kapi-A-ilan` ile BİREBİR aynı kalması (kopya sapmasın),
 *  2) kaydın kural motorunda gerçekten `review` kalması (kapı çağrılmazsa set işe yaramaz).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classify } from '../src/classification/engine';

interface Senaryo {
  id: string;
  title: string;
  sourceCategory: string;
  bodyKind?: string;
  body: string;
  expectedContentType: string;
}

function oku(yol: string): Senaryo[] {
  const tam = join(process.cwd(), yol);
  return (JSON.parse(readFileSync(tam, 'utf8')) as { records: Senaryo[] }).records;
}

const tek = oku('tests/fixtures/eval/ai-kapisi-tek-senaryo.json');
const dort = oku('tests/fixtures/eval/ai-kapisi-senaryolari.json');

describe('tek senaryoluk kapı doğrulama seti', () => {
  it('tek kayıt içerir ve bu kayıt 4 senaryoluk setteki kapi-A-ilan ile birebir aynıdır', () => {
    expect(tek).toHaveLength(1);
    const a = dort.find((kayit) => kayit.id === 'kapi-A-ilan');
    expect(a).toBeDefined();
    expect(tek[0]).toEqual(a);
  });

  it('beklenen tür personel alımıdır ve gövde yeterince uzundur', () => {
    expect(tek[0]?.expectedContentType).toBe('personnel_recruitment');
    expect((tek[0]?.body ?? '').length).toBeGreaterThan(200);
  });

  it('kural motoru bu kaydı `review`da bırakır (kapı gerçekten çağrılır)', () => {
    const kayit = tek[0];
    if (!kayit) throw new Error('kayıt yok');
    const sonuc = classify({
      title: kayit.title,
      body: kayit.body,
      sourceCategory: kayit.sourceCategory,
      sourceKey: 'eval',
    });
    expect(sonuc.decision).toBe('review');
  });
});
