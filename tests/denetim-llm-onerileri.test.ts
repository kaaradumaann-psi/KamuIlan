/** Bağımsız LLM denetimi (27.10.2026) önerileri: yeterlik sınavı / kış okulu başlıkları kurallarla reddedilir. */
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';

describe('başlık ret: yeterlik sınavı ve kış/yaz okulu', () => {
  it.each([
    '2026 Elektronik İngilizce Yeterlik Sınavı (e-TEP 2026/4) Başvuruları',
    '2026 Elektronik Yabancı Dil Olarak Türkçe Sınavı (e-YDTS/2-Türkçe) Başvuruların Alınması',
    'TÜBİTAK Kış Okulu Başvuruları Başladı',
  ])('%s → reject', (title) => {
    const result = classify({ title, body: 'Başvurular 01.11.2026 - 10.11.2026 tarihleri arasında alınacaktır. Kontenjan 50 kişidir.' });
    expect(result.decision).toBe('reject');
  });

  it('gerçek alım ilanı etkilenmez', () => {
    const result = classify({
      title: 'Sözleşmeli Bilişim Personeli Alım İlanı',
      body: 'Kurumumuza 5 (beş) sözleşmeli bilişim personeli alınacaktır. Başvurular 01.11.2026 - 10.11.2026.',
    });
    expect(result.decision).not.toBe('reject');
  });
});
