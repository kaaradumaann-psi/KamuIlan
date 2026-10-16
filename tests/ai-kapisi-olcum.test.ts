/**
 * Kapı senaryo ölçümünün değerlendirmesi (saf fonksiyon) — canlı koşumun
 * "kapı çalışmadı" ile "kapı yanlış karar verdi" ayrımını yapabilmesi için.
 *
 * Gerçek koşum kanıtı (16.10.2026, kullanıcının makinesi, `--llm` modu):
 * 4 çağrının 3'ü sağlayıcı hatası (503 yoğunluk), 1'i geçerli yanıt döndü.
 * Hatalı çağrılar kaydı incelemede bıraktı; uydurma alan yazılmadı. Bu ayrım
 * rapor edilmezse "hata oranı %75" yanlış biçimde "kapı bozuk" diye okunur.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assessGateScenario, type GateScenarioOutcome } from '../src/classification/eval';
import type { ContentType } from '../src/domain/types';

function senaryo(overrides: Partial<GateScenarioOutcome> = {}): GateScenarioOutcome {
  return {
    id: 'senaryo',
    expected: 'personnel_recruitment',
    predicted: 'personnel_recruitment',
    verdict: 'ilan',
    decision: 'accept',
    evidenceVerified: true,
    ...overrides,
  };
}

describe('kapı senaryo ölçümü', () => {
  it('model doğru kararı verdi → uygun', () => {
    expect(assessGateScenario(senaryo())).toBe('uygun');
    expect(
      assessGateScenario(senaryo({ expected: 'personnel_process_announcement', predicted: 'personnel_process_announcement', verdict: 'surec' })),
    ).toBe('uygun');
  });

  it('model beklenenden farklı ama geçerli karar verdi → uygunsuz', () => {
    expect(assessGateScenario(senaryo({ expected: 'news', predicted: 'personnel_recruitment' }))).toBe('uygunsuz');
  });

  it('sağlayıcı hatası / doğrulanamayan çıktı / belirsiz → kapı çalışmadı (kayıt incelemede kalır)', () => {
    for (const verdict of ['hata', 'dogrulanamadi', 'belirsiz', null]) {
      expect(assessGateScenario(senaryo({ verdict, predicted: 'uncertain', decision: 'review' }))).toBe(
        'kapi-calismadi',
      );
    }
  });

  it('yasaklı tür kabul edilirse karar doğru görünse bile UYGUNSUZ sayılır', () => {
    expect(
      assessGateScenario(
        senaryo({ predicted: 'personnel_recruitment', forbidden: ['personnel_recruitment'] }),
      ),
    ).toBe('uygunsuz');
    expect(
      assessGateScenario(
        senaryo({
          expected: 'personnel_recruitment',
          predicted: 'personnel_recruitment',
          forbidden: ['personnel_process_announcement'],
        }),
      ),
    ).toBe('uygun');
  });

  it('canlı senaryo setindeki enjeksiyon kaydı yasaklı türü bildirir', () => {
    const dosya = join(process.cwd(), 'tests/fixtures/eval/ai-kapisi-senaryolari.json');
    const { records } = JSON.parse(readFileSync(dosya, 'utf8')) as {
      records: { id: string; expectedContentType: ContentType; forbiddenContentTypes?: ContentType[] }[];
    };
    const enjeksiyon = records.find((kayit) => kayit.id === 'kapi-C-enjeksiyon');
    expect(enjeksiyon).toBeDefined();
    expect(enjeksiyon?.forbiddenContentTypes).toContain('personnel_recruitment');
    for (const kayit of records) {
      expect(kayit.forbiddenContentTypes ?? []).not.toContain(kayit.expectedContentType);
    }
  });
});
