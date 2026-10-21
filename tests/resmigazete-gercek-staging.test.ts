/**
 * Resmî Gazete — gerçek staging koşumu regresyonu (21.10.2026).
 *
 * Bütçeli canlı koşumda (`npm run staging:capture`, 5 istek) bulunan hata:
 * "<Kurum>dan:" + büyük harfli başlık biçimindeki PDF'lerde 11 karakterlik
 * "İPTAL İLANI" kısa satır eşiğine takılıyor, gövdedeki "ilan iptal edilmiştir."
 * başlık oluyordu. Kayıt yine güvenle incelemeye düşüyordu ama başlık kurumu
 * ve duyuru türünü göstermiyordu.
 *
 * KANIT DÜZEYİ: gerçek resmî PDF metni (projenin PDF çıkarıcısı çıktısı);
 * beklenen değerler ajan tarafından yazıldı, insan doğrulaması YOK.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveTitle } from '../src/sources/adapters/resmigazete';
import { classify } from '../src/classification/engine';
import { detectWithdrawalSignal } from '../src/ingest/jobs-service';

interface Item {
  id: string;
  pdfUrl: string;
  text: string;
  expected: {
    title: string;
    withdrawal: 'withdrawn' | 'correction' | null;
    isRecruitmentAd: boolean;
    decision?: string;
  };
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/gercek-ilanlar/2026-10-21-resmigazete-staging.json'), 'utf8'),
) as { humanVerified: boolean; items: Item[] };

describe('Resmî Gazete gerçek PDF metinleri', () => {
  it('künye doğru: insan doğrulaması yok olarak işaretli, resmî PDF adresi var', () => {
    expect(fixture.humanVerified).toBe(false);
    for (const item of fixture.items) expect(item.pdfUrl).toMatch(/^https:\/\/www\.resmigazete\.gov\.tr\//);
  });

  it.each(fixture.items.map((item) => [item.id, item] as const))(
    '%s: başlık "<Kurum>dan: BAŞLIK" biçiminde',
    (_id, item) => {
      expect(deriveTitle(item.text, '', null, '2026-10-21')).toBe(item.expected.title);
    },
  );

  it.each(fixture.items.map((item) => [item.id, item] as const))(
    '%s: iptal sinyali ve karar',
    (_id, item) => {
      const title = deriveTitle(item.text, '', null, '2026-10-21');
      expect(detectWithdrawalSignal(title, item.text)).toBe(item.expected.withdrawal);
      const result = classify({ title, body: item.text });
      if (!item.expected.isRecruitmentAd) expect(result.decision).not.toBe('accept');
      // Gerçek alım ilanı sessizce reddedilmemeli (kabul ya da inceleme).
      if (item.expected.isRecruitmentAd) expect(result.decision).not.toBe('reject');
      if (item.expected.decision) expect(result.decision).toBe(item.expected.decision);
    },
  );

  it('künye biçimi yoksa eski başlık kuralı aynen çalışır', () => {
    const text = 'Sözleşmeli Personel Alım İlanı Kurumumuza 3 personel alınacaktır.';
    expect(deriveTitle(text, '', null, '2026-10-21')).toBe(text);
    expect(deriveTitle('', 'Ankara Üniversitesi Rektörlüğünden:', null, '2026-10-21')).toBe(
      'Ankara Üniversitesi Rektörlüğünden — 2026-10-21',
    );
  });
});
