/**
 * SINIFLANDIRMA — HABER DİLİ REGRESYONU (P1 veri doğruluğu)
 *
 * Bulgu (21.10.2026): deterministik sınıflandırıcı, personel alımından HABER VEREN
 * kurumsal metinleri iş ilanı olarak `accept` ediyordu. Tekrarlanan prob (aşağıdaki
 * 9 başlık, düzeltme öncesi motor): "Vali, personel alımı yapılacağını açıkladı",
 * "Bakan Yılmaz: 2027 yılında 100 bin personel alınacak", "Memur alımı müjdesi",
 * "Memur Alımı Konusunda Meclis Araştırma Önergesi", "Personel alımına ilişkin
 * açıklama", "İŞKUR üzerinden 5 bin personel alımı yapılacak", "Aday Memur Alımı
 * Hakkında Bilgilendirme", "2026 Yılı İlk Yarısında Kamu Personel Alımı Rekoru",
 * "Belediye Başkanı: 'Zabıta memuru alımı yapacağız'" → 9/9 `accept`.
 * Bu, "kurumsal haber yayımlama" riskinin somut kanıtıydı.
 *
 * Düzeltme: `detectNewsReport()` (haber/aktarım dili + somut başvuru kanıtı yok →
 * reject; somut kanıt varsa → review). Hiçbir kayıt sessizce atılmaz.
 *
 * KANIT DÜZEYİ [2] — tekrarlanabilir testle doğrulandı.
 * SINIRLILIK [4]: başlıklar resmî kurum haber dili ÖRNEKLENEREK yazıldı; canlı
 * kaynaktan toplanmış, insan tarafından etiketlenmiş bir altın küme DEĞİLDİR.
 * Bu yüzden bu dosya "gerçek dünya kesinliği ölçüldü" iddiası taşımaz; yalnızca
 * bilinen hata sınıfının bir daha geri gelmemesini garanti eder.
 */
import { describe, expect, it } from 'vitest';
import { classify, detectNewsReport, normalizeForClassification } from '../src/classification/engine';

/** Haber/duyuru metinleri — iş ilanı DEĞİL. */
const NEWS_CASES: { title: string; body: string }[] = [
  {
    title: 'Vali, personel alımı yapılacağını açıkladı',
    body: 'Vali, il genelinde yeni personel alımı yapılacağını belirterek başvuruların önümüzdeki ay başlayacağını söyledi.',
  },
  {
    title: 'Bakan Yılmaz: 2027 yılında 100 bin personel alınacak',
    body: 'Bakan, katıldığı programda yaptığı açıklamada 2027 yılında 100 bin personel alınacağını söyledi.',
  },
  {
    title: 'Belediye Başkanı: "Zabıta memuru alımı yapacağız"',
    body: 'Başkan, gazetecilerin sorularını yanıtlarken zabıta memuru alımı yapılacağını belirtti.',
  },
  {
    title: 'Memur alımı müjdesi',
    body: 'Kamu çalışanlarına müjde geldi. Yeni yılda memur alımı yapılacağı öğrenildi.',
  },
  {
    title: 'Memur Alımı Konusunda Meclis Araştırma Önergesi',
    body: 'Önerge kapsamında kamu kurumlarında memur alımı süreçleri incelenecektir.',
  },
  {
    title: 'Personel alımına ilişkin açıklama',
    body: 'Son günlerde basında yer alan personel alımı haberleri üzerine açıklama yapılmıştır.',
  },
  {
    title: 'İŞKUR üzerinden 5 bin personel alımı yapılacak',
    body: 'İŞKUR aracılığıyla 5 bin personel alımı gerçekleştirileceği bildirildi.',
  },
  {
    title: 'Aday Memur Alımı Hakkında Bilgilendirme',
    body: 'Aday memur alımı sürecine ilişkin bilgilendirme toplantısı yapılacaktır.',
  },
  {
    title: '2026 Yılı İlk Yarısında Kamu Personel Alımı Rekoru',
    body: 'Yılın ilk yarısında kamu kurumları toplam 45 bin personel alımı gerçekleştirdi.',
  },
];

/** Gerçek ilan dili — bunlar KABUL edilmeli (yanlış ret koruması). */
const REAL_ADS: { title: string; body: string }[] = [
  {
    title: 'Sözleşmeli Personel Alım İlanı',
    body:
      'Kurumumuzda istihdam edilmek üzere 10 sözleşmeli personel alınacaktır. ' +
      'Başvurular 01.11.2026 - 10.11.2026 tarihleri arasında yapılacaktır. ' +
      'Lisans mezunu olmak ve 2026 KPSS P3 puanına sahip olmak gerekmektedir.',
  },
  {
    title: 'Kurumumuz Sözleşmeli Personel Alımı Yapacaktır',
    body:
      'Kurumumuzda istihdam edilmek üzere 12 sözleşmeli personel alınacaktır. ' +
      'Başvurular 01.11.2026-12.11.2026 tarihleri arasında e-Devlet üzerinden yapılacaktır.',
  },
  {
    title: 'Sözleşmeli Personel Alımı Yapılacağı Duyurulur',
    body:
      'Kurumumuzda 657 sayılı Kanunun 4/B maddesi kapsamında 20 sözleşmeli personel alınacaktır. ' +
      'Son başvuru tarihi 18.11.2026.',
  },
];

describe('haber dili kapısı', () => {
  it('haber/duyuru başlıklarını iş ilanı olarak kabul etmez', () => {
    const accepted: string[] = [];
    for (const item of NEWS_CASES) {
      const result = classify(item);
      if (result.decision === 'accept') accepted.push(item.title);
      expect(result.decision, item.title).toBe('reject');
    }
    expect(accepted).toEqual([]);
  });

  it('haber kaydı "process" olarak da yayımlanmaz', () => {
    for (const item of NEWS_CASES) {
      expect(classify(item).kind, item.title).not.toBe('process');
    }
  });

  it('gerçek ilan dili etkilenmez (yanlış ret yok)', () => {
    for (const item of REAL_ADS) {
      const result = classify(item);
      expect(result.decision, `${item.title} → ${result.reasons.join(' | ')}`).toBe('accept');
      expect(result.kind).toBe('job');
    }
  });

  it('haber dili + somut başvuru kanıtı → inceleme (silinmez, yayımlanmaz)', () => {
    const result = classify({
      title: 'Vali, 50 personel alınacağını açıkladı',
      body:
        'İlimizde 50 sözleşmeli personel alınacaktır. ' +
        'Başvurular 01.12.2026 tarihine kadar e-Devlet üzerinden yapılacaktır.',
    });
    expect(result.decision).toBe('review');
    expect(result.rules).toContain('haber.aktarim-fili');
  });

  it('aktarma fiili gövdede de yakalanır', () => {
    const gate = detectNewsReport(
      normalizeForClassification('İŞKUR üzerinden 5 bin personel alımı yapılacak'),
      normalizeForClassification('İŞKUR aracılığıyla 5 bin personel alımı gerçekleştirileceği bildirildi.'),
    );
    expect(gate?.decision).toBe('reject');
  });

  it('resmî edilgen ilan kalıbı ("Duyurulur") haber sayılmaz', () => {
    const gate = detectNewsReport(
      normalizeForClassification('Sözleşmeli Personel Alımı Yapılacağı Duyurulur'),
      normalizeForClassification('20 sözleşmeli personel alınacaktır. Son başvuru tarihi 18.11.2026.'),
    );
    expect(gate).toBeNull();
  });
});
