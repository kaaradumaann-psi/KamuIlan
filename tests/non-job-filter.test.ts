import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';

/**
 * Kullanıcının yerel ilan akışında iş ilanı dışında kalan gerçek başlıklar.
 * Bu başlıklar hiçbir koşulda "accept" olmamalıdır.
 */
const NON_JOB_TITLES = [
  'Çerez politikamız',
  'TÜBİTAK 2026 Lisansüstü Burs Programı Sonuçları Belli Oldu',
  'MEB Öğretmen Yer Değiştirme Sonuçları',
  'SGK Gayrimenkul Satış İlanı',
  'YÖK Rektör Adaylığı Duyurusu',
  'Bank Mellat Basın Duyurusu',
  'Uluslararası Konferans Duyurusu',
  'Üniversite İzleme ve Değerlendirme Raporu',
  'Öncelikli Alanlardaki Doktora Programlarına Öğrenci Seçme Sınavı için Başvurular Uzatılmıştır',
  'Hindistan ITEC Kapsamında Verilen Uzmanlık Eğitimlerine Başvurular',
  'Uluslararası Araştırma Programları 2026 Yılı Başvuru Duyurusu',
  'TÜBİTAK 1001 Proje Çağrısı Açıldı',
  '2026-YKS Ek Yerleştirme Tercihleri Başladı',
  'Gayrimenkul Satış İlanı (Ankara İli)',
  'Hazine ve Maliye Bakanlığı Personel Dairesi Başkanlığı Duyurusu',
];

const GENERIC_BODY =
  'Duyuru metni aşağıda yer almaktadır. Ayrıntılı bilgi için kurum internet sitesini ziyaret ediniz.';

describe('iş ilanı dışındaki başlıklar kabul edilmez', () => {
  for (const title of NON_JOB_TITLES) {
    it(`"${title}" kabul edilmez`, () => {
      const result = classify({ title, body: GENERIC_BODY, sourceCategory: 'personel alımı' });
      expect(result.decision).not.toBe('accept');
    });
  }

  it('kaynak kategorisi "personel alımı" olsa bile metinde alım ifadesi yoksa kabul edilmez', () => {
    const result = classify({
      title: 'Kamu Kurumu Genel Duyuru',
      body: GENERIC_BODY,
      sourceCategory: 'personel alımı',
    });
    expect(result.decision).toBe('reject');
  });
});

/**
 * Gerçek bir personel alımının kura, sınav, sonuç aşamaları: iş ilanı değil, ama
 * kullanıcı akışta görmek istiyor. Ayrı `kind: 'process'` kategorisinde kabul edilir.
 */
const PROCESS_TITLES: Array<[string, string]> = [
  [
    'Karayolları Genel Müdürlüğü 50 İşçi Alımına İlişkin Noter Kurası Duyurusu',
    'Karayolları Genel Müdürlüğü 50 işçi alımına ilişkin noter huzurunda kura çekimi yapılacaktır.',
  ],
  [
    'Sözleşmeli Bilişim Personeli Sözlü/Uygulama Sınavına Çağrılacak Adaylar',
    'Sözleşmeli bilişim personeli alımı sınavına çağrılacak adaylar listesi aşağıdadır.',
  ],
  [
    'Bakanlık Merkez Teşkilatı Destek Personeli (Şoför) Uygulamalı Sınav Yeri ve Tarihlerine İlişkin Duyuru',
    'Destek personeli (şoför) alımı uygulamalı sınav yeri ve tarihleri aşağıda yer almaktadır.',
  ],
  [
    'Sözleşmeli Zabıt Katibi Uygulamalı Sınav Metinleri ve Değerlendirme Kriterleri',
    'Sözleşmeli zabıt katibi alımı uygulamalı sınav metinleri ve değerlendirme kriterleri yayımlanmıştır.',
  ],
  [
    'Sağlık Bakanlığı Sözleşmeli Sağlık Personeli Yerleştirme Sonuçları',
    'Sözleşmeli sağlık personeli alımı yerleştirme sonuçları ilan edilmiştir.',
  ],
  [
    '2026 Yılı Sözleşmeli Personel Alımı Sonuçları Açıklandı',
    'Sözleşmeli personel alımı için başvuru yapan adayların sonuçları ilan edilmiştir.',
  ],
];
for (const [title, body] of PROCESS_TITLES) {
  it(`süreç duyurusu: "${title}" kabul edilir, kind=process`, () => {
    const result = classify({ title, body, sourceCategory: 'personel alımı' });
    expect(result.decision).toBe('accept');
    expect(result.kind).toBe('process');
  });
}

const PROCESS_EXCLUDED_TITLES = [
  'Kamu Personeli Yer Değiştirme Sonuçları',
  'Görevde Yükselme Sınavı Sonuçları Açıklandı',
  'Personel Unvan Değişikliği Sınav Sonuçları',
  'Personel Alımı Basın Duyurusu Sonuçları',
];
describe('süreç duyurusu dışlamaları reddedilir', () => {
  for (const title of PROCESS_EXCLUDED_TITLES) {
    it(`"${title}" süreç sayılmaz`, () => {
      const result = classify({ title, body: GENERIC_BODY, sourceCategory: 'personel alımı' });
      expect(result.decision).not.toBe('accept');
    });
  }
});

describe('gerçek personel ilanları kabul edilir', () => {
  const JOB_TITLES: Array<[string, string]> = [
    [
      'Sözleşmeli Bilişim Personeli Alımı İlanı',
      'Sözleşmeli bilişim personeli alımı yapılacaktır. Başvurular 20.10.2026 tarihine kadar yapılacaktır.',
    ],
    [
      'Savunma Sanayii Uzman Yardımcılığı Giriş Sınavı',
      'Uzman yardımcısı olarak istihdam edilmek üzere aday alınacaktır.',
    ],
    ['TMSF Personel Alım İlanı 2026', 'TMSF bünyesinde personel alımı yapılacaktır.'],
  ];
  for (const [title, body] of JOB_TITLES) {
    it(`"${title}" kabul edilir`, () => {
      const result = classify({ title, body, sourceCategory: 'personel alımı' });
      expect(result.decision).toBe('accept');
      expect(result.kind).toBe('job');
    });
  }
});

import { sanitizeRawAnnouncement } from '../src/ingest/sanitize';
import { buildJobDocument } from '../src/ingest/jobs-service';
import { reclassifyJob } from '../src/ingest/reclassify';
import type { JobDoc } from '../src/db/schemas';
import type { RawAnnouncement } from '../src/domain';

const NOW = new Date('2026-10-14T09:00:00+03:00');

function rawOf(title: string, bodyText: string, extra: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return {
    sourceKey: 'ilan-gov-tr-api-personel',
    sourceItemId: `t-${title.length}`,
    title,
    url: 'https://www.ilan.gov.tr/ilan/1',
    attachments: [],
    bodyText,
    ...extra,
  } as RawAnnouncement;
}

describe('ham ilan temizliği (tüm adaptörler)', () => {
  it('başlıktaki sayfa kabuğunu kaldırır', () => {
    const cleaned = sanitizeRawAnnouncement(
      rawOf(
        'Daha yüksek erişilebilirlik modunu aç Karayolları Genel Müdürlüğü Sözleşmeli Personel Alımı',
        'Başvurular yapılacaktır.',
      ),
    );
    expect(cleaned.title).toBe('Karayolları Genel Müdürlüğü Sözleşmeli Personel Alımı');
  });

  it('yalnızca kabuk olan başlık kaybolmaz; ham hali korunur', () => {
    const cleaned = sanitizeRawAnnouncement(rawOf('Ana içeriğe atla', 'Gövde'));
    expect(cleaned.title).toBe('Ana içeriğe atla');
  });

  it('gövdeden çerez bildirimini çıkarır, ilan içeriğini korur', () => {
    const cleaned = sanitizeRawAnnouncement(
      rawOf(
        'Sözleşmeli Bilişim Personeli Alımı',
        'Çerez politikamız gereği ... Sözleşmeli bilişim personeli alımı yapılacaktır.',
      ),
    );
    expect(cleaned.bodyText).toContain('Sözleşmeli bilişim personeli alımı yapılacaktır.');
    expect(cleaned.bodyText).not.toContain('Çerez politikamız');
  });
});

describe('mevcut kayıtların yeniden sınıflandırması', () => {
  function jobFor(title: string, textExcerpt: string, decision: 'accept' | 'reject' = 'accept'): JobDoc {
    const raw = rawOf(title, textExcerpt, { institution: 'Test Kurumu', publishedAt: '2026-10-10' });
    const classification = classify({ title, body: textExcerpt });
    const doc = buildJobDocument(raw, { ...classification, decision }, { now: NOW, provenance: 'scraped' });
    return {
      ...doc,
      id: 'job-1',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      firstSeenAt: NOW.toISOString(),
      lastSeenAt: NOW.toISOString(),
      version: 1,
    } as unknown as JobDoc;
  }

  it('Basın duyurusu olarak kabul edilmiş eski kaydı akıştan çıkarır', () => {
    const job = jobFor('Bank Mellat Basın Duyurusu', 'Banka basın duyurusu metni.', 'accept');
    job.classification = { ...job.classification, decision: 'accept' };
    const result = reclassifyJob(job, NOW);
    expect(result.decisionFrom).toBe('accept');
    expect(result.decisionTo).not.toBe('accept');
    expect(result.patch.classification?.decision).toBe(result.decisionTo);
  });

  it('gerçek personel ilanını kabul ederek korur', () => {
    const job = jobFor(
      'Sözleşmeli Bilişim Personeli Alımı İlanı',
      'Sözleşmeli bilişim personeli alımı yapılacaktır. Başvurular 20.10.2026 tarihine kadar yapılacaktır.',
    );
    const result = reclassifyJob(job, NOW);
    expect(result.decisionTo).toBe('accept');
  });

  it('kabuk ifadesi bulaşmış başlığı temizler ve değişiklik işaretler', () => {
    const job = jobFor(
      'Sözleşmeli Bilişim Personeli Alımı İlanı',
      'Sözleşmeli bilişim personeli alımı yapılacaktır. Başvurular 20.10.2026 tarihine kadar yapılacaktır.',
    );
    job.title = 'Daha yüksek erişilebilirlik modunu aç Sözleşmeli Bilişim Personeli Alımı İlanı';
    const result = reclassifyJob(job, NOW);
    expect(result.titleCleaned).toBe(true);
    expect(result.patch.title).toBe('Sözleşmeli Bilişim Personeli Alımı İlanı');
  });

  it('değişiklik yoksa patch boş döner (idempotent)', () => {
    const job = jobFor(
      'Sözleşmeli Bilişim Personeli Alımı İlanı',
      'Sözleşmeli bilişim personeli alımı yapılacaktır. Başvurular 20.10.2026 tarihine kadar yapılacaktır.',
    );
    const first = reclassifyJob(job, NOW);
    const applied = { ...job, ...first.patch } as JobDoc;
    const second = reclassifyJob(applied, NOW);
    expect(second.changed).toBe(false);
  });
});
