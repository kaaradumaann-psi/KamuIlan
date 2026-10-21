/**
 * Test-only bootstrap: Playwright'ın ilan akışı testleri için deterministik örnek ilanlar.
 *
 * Kayıtlar gerçek ilan hattından (`applyRawAnnouncement`: sınıflandırma, alan çıkarımı,
 * tekilleştirme) geçer ve `provenance: 'sample'` olarak işaretlenir; arayüzde "örnek veri"
 * etiketiyle görünür. Başvuru tarihleri bugüne göre hesaplanır, böylece testler takvimle
 * eskimez. Yalnız NODE_ENV=test + dosya deposunda çalışır (seed:e2e-sources ile aynı kapılar).
 *
 * Tohum:
 *  - Zabıta memuru (belediye, 12 kişi, İzmir) → yayımlanmalı.
 *  - Sözleşmeli bilişim personeli, iki pozisyon "(1 Kişi – …)" → kadro kırılımı.
 *  - Haber dili ("Bakan duyurdu …") → reddedilmeli; listede görünmemeli.
 */
import { getEnv, inspectEnvironment } from '../src/config/env';
import { closeStore, initStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import type { RawAnnouncement } from '../src/domain';

const SOURCE_KEY = 'e2e-ornek-veri';
const DAY = 24 * 3_600_000;

/** İstanbul takvim günü, "GG.AA.YYYY". */
function trDate(at: Date): string {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(at).split('-');
  return `${day}.${month}.${year}`;
}

export function e2eAnnouncements(now: Date): RawAnnouncement[] {
  const start = trDate(new Date(now.getTime() - DAY));
  const end = trDate(new Date(now.getTime() + 14 * DAY));
  const publishedAt = new Date(now.getTime() - 2 * DAY).toISOString();
  const base = { sourceKey: SOURCE_KEY, publishedAt, sourceCategory: 'personel alımı', attachments: [], extractionConfidence: 0.5 };
  return [
    {
      ...base,
      sourceItemId: 'E2E-ZABITA',
      url: 'https://ornek.kamuilan.test/ilan/E2E-ZABITA',
      title: 'Örnekköy Belediye Başkanlığından: Zabıta Memuru Alım İlanı',
      institution: 'Örnekköy Belediye Başkanlığı',
      bodyText: `
Örnekköy Belediye Başkanlığından:
Belediyemiz bünyesinde 657 sayılı Devlet Memurları Kanunu'na tabi kadrolu zabıta memuru alımı yapılacaktır.
Kontenjan: 12 kişi. İl: İzmir.
Başvuru şartları: Lise mezunu olmak, 2026 yılı KPSS (P94) puanına sahip olmak, 18 yaşını doldurmuş olmak.
Başvurular ${start} tarihinde saat 09:00'da başlayacak olup ${end} tarihinde saat 23:59'da sona erecektir.
Başvurular Kariyer Kapısı üzerinden elektronik ortamda alınacaktır.
`,
    },
    {
      ...base,
      sourceItemId: 'E2E-BILISIM',
      url: 'https://ornek.kamuilan.test/ilan/E2E-BILISIM',
      title: 'Örnek Denetim Başkanlığından: Sözleşmeli Bilişim Personeli Alım İlanı',
      institution: 'Örnek Denetim Başkanlığı',
      bodyText: `
Örnek Denetim Başkanlığından:
SÖZLEŞMELİ BİLİŞİM PERSONELİ ALIM İLANI
Başkanlığımız Bilgi İşlem Birim Başkanlığında istihdam edilmek üzere, 375 sayılı Kanun Hükmünde Kararname'nin
Ek 6. maddesi uyarınca sözlü sınav sonucunda oluşacak başarı sırasına göre 2 (iki) Sözleşmeli Bilişim Personeli alınacaktır.
İl: Ankara.
B. ÖZEL ŞARTLAR
1. Kıdemli Yazılım Geliştirme Uzmanı (B Grubu)
(1 Kişi – Tam Zamanlı – Brüt Sözleşme Ücret Tavanının 4 Katına Kadar)
a) Yazılım geliştirme alanında en az 10 yıl çalışmış olmak.
2. Sistem Uzmanı (D Grubu)
(1 Kişi – Tam Zamanlı – Brüt Sözleşme Ücret Tavanının 2 Katına Kadar)
a) Sistem yönetimi alanında en az 3 yıl çalışmış olmak.
Başvurular ${start} tarihinde başlayacak olup ${end} tarihinde saat 23:59'da sona erecektir.
Başvurular Kariyer Kapısı üzerinden elektronik ortamda alınacaktır.
`,
    },
    {
      ...base,
      sourceItemId: 'E2E-HABER',
      url: 'https://ornek.kamuilan.test/haber/E2E-HABER',
      title: 'Bakan duyurdu: Örnekdiyar kurumlarına 5 bin personel alımı yapılacak',
      institution: 'Örnek Haber Ajansı',
      bodyText: `
Bakan bugün yaptığı açıklamada Örnekdiyar kurumlarına önümüzdeki yıl içinde 5 bin personel alımı yapılacağını duyurdu.
Bakan, alımların hangi kadrolara yapılacağının ilerleyen günlerde açıklanacağını bildirdi. Açıklamada başvuru tarihi,
başvuru yeri ve şartlarına ilişkin bir bilgi yer almadı. Konuya ilişkin ayrıntıların daha sonra paylaşılacağı aktarıldı.
`,
    },
  ];
}

async function main(): Promise<void> {
  const env = getEnv();
  const unsafe: string[] = [];
  if (env.NODE_ENV !== 'test') unsafe.push('NODE_ENV must be test');
  if (env.DATABASE_DRIVER !== 'file') unsafe.push('DATABASE_DRIVER must be file');
  if (env.SOURCE_LIVE_FETCH) unsafe.push('SOURCE_LIVE_FETCH must be disabled');
  if (env.SCHEDULER_ENABLED) unsafe.push('SCHEDULER_ENABLED must be disabled');
  if (env.LLM_CLASSIFIER_ENABLED) unsafe.push('LLM_CLASSIFIER_ENABLED must be disabled');
  if (env.EMAIL_PROVIDER !== 'file') unsafe.push('EMAIL_PROVIDER must be file');
  if (unsafe.length) throw new Error(`E2E ilan seed'i güvenlik nedeniyle durduruldu: ${unsafe.join('; ')}.`);
  const inspection = inspectEnvironment(env);
  if (!inspection.ok) throw new Error(`E2E ilan seed'i ortam doğrulamasını geçemedi: ${inspection.problems.join('; ')}.`);

  const store = await initStore();
  try {
    if (store.driver !== 'file') throw new Error("E2E ilan seed'i yalnızca dosya deposunda çalışabilir.");
    const repos = createRepos(store);
    if ((await store.count('jobs', { provenance: 'scraped' })) > 0) {
      throw new Error("Depoda gerçek (scraped) ilan var; E2E ilan seed'i örnek veriyi karıştırmaz.");
    }
    await repos.sources.seed([
      {
        key: SOURCE_KEY,
        name: 'E2E — örnek veri (gerçek kaynak değildir)',
        group: 'kurum',
        sourceType: 'manual',
        institution: 'Kamuİlan E2E',
        listingUrl: 'https://ornek.kamuilan.test/ilanlar',
        homepageUrl: 'https://ornek.kamuilan.test/',
        adapterKey: 'manual-entry',
        method: 'manual-entry',
        status: 'disabled',
        statusNote: 'Yalnızca E2E örnek verisi; tarama yapılmaz.',
        lastVerifiedAt: null,
        verificationEvidence: 'Doğrulanmadı: gerçek bir kaynak değildir.',
        coverageNote: 'E2E kaydı; kapsam raporunda gerçek kaynak sayılmaz.',
        enabled: false,
        intervalMinutes: 1_440,
        minRequestIntervalMs: 5_000,
        maxConcurrency: 1,
        allowedHosts: ['ornek.kamuilan.test'],
        conditionalRequests: false,
        tags: ['demo', 'e2e'],
      },
    ]);
    const now = repos.clock.now();
    for (const raw of e2eAnnouncements(now)) {
      const outcome = await applyRawAnnouncement(raw, { repos, now, workerId: 'seed-e2e-jobs', provenance: 'sample' });
      console.log(`• ${raw.sourceItemId}: ${outcome.action}`);
    }
  } finally {
    await closeStore();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/seed-e2e-jobs.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
