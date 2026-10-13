/**
 * Demo veri: `npm run seed:demo`
 *
 * Amaç: arayüzü ve bildirim hattını gerçek kaynak olmadan deneyebilmek.
 *
 * Güvenlik kuralları (kullanıcı şartı):
 *  - Üretimde ÇALIŞMAZ (`--force` ile bile varsayılan olarak reddeder; üretim için
 *    ayrıca NODE_ENV=production ve --force birlikte gerekir).
 *  - Eklenen kayıtlar `provenance: 'sample'` olarak işaretlenir; arayüzde
 *    "örnek veri" etiketiyle görünür ve gerçek ilan gibi sunulmaz.
 *  - Veritabanında gerçek (scraped) ilan varsa üzerine yazmaz; ek yükleme yapmaz.
 *  - Sahte başvuru bağlantısı üretilmez.
 */
import { initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { hashPassword, validatePasswordStrength } from '../src/server/passwords';
import { getEnv } from '../src/config/env';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { ensureScheduledTasks } from '../src/worker/scheduler';
import { createLogger } from '../src/lib/logger';
import { maskEmail } from '../src/domain/text';
import type { RawAnnouncement } from '../src/domain';

const LOGGER = createLogger('seed-demo', { level: 'info' });
const DEMO_SOURCE_KEY = 'demo-ornek-veri';

function sampleAnnouncements(): RawAnnouncement[] {
  return [
    {
      sourceKey: DEMO_SOURCE_KEY,
      sourceItemId: 'DEMO-2026-0001',
      url: 'https://ornek.kamuilan.test/ilan/DEMO-2026-0001',
      title: 'Örnek Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı',
      institution: 'Örnek Üniversitesi Rektörlüğü',
      publishedAt: '2026-10-12T00:00:00+03:00',
      sourceCategory: 'personel alımı',
      attachments: [{ url: 'https://ornek.kamuilan.test/ek/kilavuz.pdf', label: 'Başvuru kılavuzu', kind: 'pdf' }],
      extractionConfidence: 0.5,
      bodyText: `
Örnek Üniversitesi Rektörlüğünden:
Üniversitemiz birimlerinde istihdam edilmek üzere 657 sayılı Devlet Memurları Kanunu'nun 4/B maddesi kapsamında
sözleşmeli personel alımı yapılacaktır.
Alınacak personel: Hemşire, Sağlık Teknikeri.
Kontenjan: 25 kişi. İl: Ankara.
Başvuru şartları: İlgili ön lisans veya lisans programlarından mezun olmak, 2026 yılı KPSS (P3) puanına sahip olmak,
KPSS taban puanı 70 ve üzeri olmak, 18 yaşını doldurmuş ve 35 yaşını bitirmemiş olmak.
Başvurular 20.10.2026 tarihinde saat 09:00'da başlayacak olup 30.10.2026 tarihinde saat 23:59'da sona erecektir.
Başvurular Kariyer Kapısı üzerinden elektronik ortamda alınacaktır.
`,
    },
    {
      sourceKey: DEMO_SOURCE_KEY,
      sourceItemId: 'DEMO-2026-0002',
      url: 'https://ornek.kamuilan.test/ilan/DEMO-2026-0002',
      title: 'Örnek Belediyesi Başkanlığından: Zabıta Memuru Alım İlanı',
      institution: 'Örnek Belediyesi Başkanlığı',
      publishedAt: '2026-10-11T00:00:00+03:00',
      sourceCategory: 'personel alımı',
      attachments: [],
      extractionConfidence: 0.5,
      bodyText: `
Örnek Belediyesi Başkanlığından:
Belediyemiz bünyesinde 657 sayılı Devlet Memurları Kanunu'na tabi kadrolu zabıta memuru alımı yapılacaktır.
Kontenjan: 12 kişi. İl: İzmir.
Başvuru şartları: Lise mezunu olmak, 2026 yılı KPSS (P94) puanına sahip olmak, 18 yaşını doldurmuş olmak.
Başvurular 02.11.2026 tarihinde saat 09:00'da başlayacak olup 11.11.2026 tarihinde saat 23:59'da sona erecektir.
Başvurular Kariyer Kapısı üzerinden elektronik ortamda alınacaktır.
`,
    },
    {
      sourceKey: DEMO_SOURCE_KEY,
      sourceItemId: 'DEMO-2026-0003',
      url: 'https://ornek.kamuilan.test/ilan/DEMO-2026-0003',
      title: 'Örnek Üniversitesi Rektörlüğünden: Öğretim Görevlisi Alım İlanı (Akademik)',
      institution: 'Örnek Üniversitesi Rektörlüğü',
      publishedAt: '2026-10-10T00:00:00+03:00',
      sourceCategory: 'akademik kadro',
      attachments: [],
      extractionConfidence: 0.5,
      bodyText: `
Örnek Üniversitesi Rektörlüğünden:
Üniversitemiz birimlerine 2547 sayılı Kanun kapsamında öğretim görevlisi alınacaktır.
Kadro sayısı: 4. İl: Eskişehir.
Adaylarda aranan şartlar: Doktora derecesine sahip olmak, ilgili alanda yayın yapmış olmak.
Başvurular 15.10.2026 tarihinde başlayacak olup 29.10.2026 tarihinde sona erecektir.
Başvurular üniversitemiz Personel Daire Başkanlığına şahsen veya posta yoluyla yapılacaktır.
`,
    },
  ];
}

async function seedAdmin(email: string, password: string): Promise<void> {
  const store = await initStore();
  const repos = createRepos(store);
  const existing = await repos.users.findByEmail(email);
  if (existing) {
    console.log(`• yönetici zaten var: ${maskEmail(email)} (şifre değiştirilmedi)`);
    return;
  }
  const strength = validatePasswordStrength(password, { email });
  if (!strength.valid) {
    console.error(`✖ ADMIN_PASSWORD politikaya uymuyor: ${strength.problems.join(' ')}`);
    process.exitCode = 1;
    return;
  }
  const { hash, salt } = await hashPassword(password);
  await repos.users.create({
    email,
    passwordHash: hash,
    passwordSalt: salt,
    displayName: 'Yönetici',
    role: 'admin',
    emailVerified: true,
  });
  console.log(`• yönetici oluşturuldu: ${maskEmail(email)} (şifre yalnızca ortam değişkeninde tutulur)`);
}

async function main(): Promise<void> {
  const env = getEnv();
  const force = process.argv.includes('--force');
  if (env.NODE_ENV === 'production' && !force) {
    console.error('✖ Üretim ortamında örnek veri yüklenmez. Gerçekten istiyorsanız --force kullanın (önerilmez).');
    process.exitCode = 1;
    return;
  }

  const store = await initStore();
  const repos = createRepos(store);
  const scrapedJobs = await repos.store.count('jobs', { provenance: 'scraped' });
  if (scrapedJobs > 0 && !force) {
    console.error(
      `✖ Veritabanında ${scrapedJobs} gerçek (scraped) ilan var. Örnek veri eklemek veriyi karıştırır. ` +
        'Devam etmek için --force kullanın (önerilmez).',
    );
    process.exitCode = 1;
    await closeStore();
    return;
  }

  console.log('⚠ Bu komut ÖRNEK veri ekler: kayıtlar "sample" olarak işaretlenir ve arayüzde "örnek veri" etiketiyle görünür.');
  await repos.sources.seed(SOURCE_DEFINITIONS);
  await repos.sources.seed([
    {
      key: DEMO_SOURCE_KEY,
      name: 'Demo — örnek veri (gerçek kaynak değildir)',
      group: 'kurum',
      sourceType: 'manual',
      institution: 'Kamuİlan demo',
      listingUrl: 'https://ornek.kamuilan.test/ilanlar',
      homepageUrl: 'https://ornek.kamuilan.test/',
      adapterKey: 'manual-entry',
      method: 'manual-entry',
      status: 'disabled',
      statusNote: 'Yalnızca demo verisi için var; tarama yapılmaz.',
      lastVerifiedAt: null,
      verificationEvidence: 'Doğrulanmadı: gerçek bir kaynak değildir.',
      coverageNote: 'Demo kaydı; kapsam raporunda gerçek kaynak sayılmaz.',
      enabled: false,
      intervalMinutes: 1_440,
      minRequestIntervalMs: 5_000,
      maxConcurrency: 1,
      allowedHosts: ['ornek.kamuilan.test'],
      conditionalRequests: false,
      tags: ['demo', 'ornek-veri'],
    },
  ]);

  let created = 0;
  for (const raw of sampleAnnouncements()) {
    const outcome = await applyRawAnnouncement(raw, {
      repos,
      now: repos.clock.now(),
      workerId: 'seed-demo',
      provenance: 'sample',
    });
    if (outcome.action === 'created' || outcome.action === 'updated') created += 1;
    console.log(`• ${outcome.action}: ${raw.title.slice(0, 70)}`);
  }

  const tasks = await ensureScheduledTasks(repos, LOGGER, env.SCAN_INTERVAL_MINUTES);
  console.log(`• zamanlanmış görevler: toplam ${tasks.total} (yeni ${tasks.created})`);

  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    await seedAdmin(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
  } else {
    console.log('• ADMIN_EMAIL/ADMIN_PASSWORD tanımlı değil: yönetici hesabı oluşturulmadı.');
  }

  console.log(
    `\n✔ Demo veri hazır (${created} ilan). Not: Bunlar GERÇEK ilan değildir; ` +
      'gerçek veriyi görmek için worker çalışırken kaynak taraması yapın (npm run dev veya admin panelden "şimdi tara").',
  );
  await closeStore();
}

main().catch(async (error: unknown) => {
  console.error('Demo veri yüklenemedi:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await closeStore().catch(() => undefined);
});
