# KamuRadar

Türkiye'deki **kamu personel alım ilanlarını** resmî kaynaklardan toplayan,
sınıflandıran, tekilleştiren, yapılandırılmış alanlara ayıran ve kullanıcı
tercihlerine göre **e-posta ile bildiren** tam yığın (full-stack) TypeScript
platformu.

Amaç bir prototip değil, çalışan bir sistem olmaktır: gerçek kaynaklar, gerçek
veritabanı, kalıcı arka plan işleri, gerçek e-posta hattı (geliştirme/üretim
ayrı), hata yönetimi, testler ve kurulum belgeleri.

## Dürüstlük ilkeleri (özet)

- **Kapsam eksiktir ve bu açıkça gösterilir.** Arayüz her zaman son başarılı
  taramayı, kaynak durumunu ve hangi kurumların henüz entegre edilmediğini yazar.
- **Doğrulanmamış kaynak "entegre" sayılmaz.** Canlı doğrulanmış kaynaklar
  `verified`, adaptörü yazılmış ama doğrulanmamışlar ayrı bir sayaçta gösterilir.
- **Veri uydurulmaz.** Çıkarılamayan alanlar "belirtilmemiş" kalır; her alanın
  hangi kanıttan geldiği (liste sayfası / ilan metni) kayıtlıdır.
- **Engel aşılmaz.** CAPTCHA, oturum duvarı veya coğrafi WAF engeli varsa kaynak
  bu durumuyla işaretlenir; otomatik çekim zorlanmaz.
- Ayrıntılı liste: [docs/limitations.md](./docs/limitations.md)

## Ne yapar?

1. **Toplar** — Resmî Gazete (Çeşitli İlânlar, PDF metni çıkarılarak),
   ilan.gov.tr personel alım listesi, ÖSYM duyuruları ve kurum sayfaları; kaynak
   başına en uygun yöntem (HTML → PDF → gerekiyorsa tarayıcı).
2. **Sınıflandırır** — deterministik kural motoru: kadrolu memur, sözleşmeli,
   kamu işçisi, akademik, kariyer meslekleri, kuruma özgü sınavlı, diğer.
   İhale/sonuç/tebliğ/atama/yönetmelik/burs-staj ilanları reddedilir; belirsiz
   kayıtlar **silinmez**, inceleme kuyruğuna gider.
3. **Çıkarır** — unvan, kurum, birim, kontenjan, il/ilçe, başvuru başlangıç/bitiş,
   yöntem, resmî bağlantı, başvuru bağlantısı, ekler, eğitim düzeyi, bölüm,
   KPSS türü/taban puanı, yaş, sertifika, deneyim, yabancı dil, özel koşullar.
4. **Tekilleştirir** — resmî ilan no → normalize URL → kurum+unvan+dönem+benzerlik.
   Benzer başlıklı farklı ilanlar **otomatik birleştirilmez**.
5. **Değişiklikleri izler** — son başvuru tarihi, şartlar, kontenjan, kapanış,
   başvuru bağlantısı, geri çekilme; sürüm ve değişen alan geçmişi tutulur.
6. **Bildirir** — tercihlerinize uyan yeni ilanlar için Türkçe HTML + düz metin
   e-posta; benzersiz olay kaydı (idempotent), outbox, yeniden deneme, ölü mektup
   yönetimi ve teslim kaydı ("sağlayıcı kabul etti" — "teslim edildi" değil).
7. **Yönetim sağlar** — kaynak CRUD, tarama geçmişi, hata ayrıntıları,
   sınıflandırma/tekilleştirme inceleme kuyruğu, e-posta kuyruğu, kapsam raporu,
   denetim kaydı (RBAC korumalı). Kapsam şu an **9 kayıtlı kaynak + 18 planlanan
   kurum**dur; hedef, kurumları tek tek canlı doğrulayarak listeyi büyütmektir.

## Hızlı başlangıç

```bash
npm install
cp .env.example .env
npm run env:check     # ortam değişkeni doğrulaması
npm run dev           # arayüz + API + worker + geliştirme posta sunucusu
```

| Adres | Ne |
| --- | --- |
| http://localhost:5173 | Arayüz |
| http://localhost:3000/api/health | API sağlık |
| http://localhost:3000/api/docs | API dokümanı (Swagger) |
| http://localhost:1080 | Geliştirme posta kutusu (gerçek e-posta GİTMEZ) |

İlk yönetici:

```bash
ADMIN_EMAIL=yonetici@example.com ADMIN_PASSWORD="uzun-rastgele-parola" npm run seed:admin
```

Ayrıntılı kurulum: [docs/setup.md](./docs/setup.md) ·
Docker ile: `cd infra/docker && docker compose up --build`

## Komutlar

| Komut | Açıklama |
| --- | --- |
| `npm run dev` | Arayüz + API + worker + geliştirme SMTP (tek komut) |
| `npm run dev:api` / `dev:worker` / `dev:web` / `dev:smtp` | Parça parça çalıştırma |
| `npm run build` / `npm run preview` | Arayüz derlemesi / önizleme (4173) |
| `npm start` / `npm run start:worker` | Üretim: API / worker |
| `npm test` | Vitest (birim + entegrasyon, ağ erişimi yok) |
| `npm run test:e2e` | Playwright tarayıcı testleri |
| `SOURCE_LIVE_FETCH=1 npm run test:live` | Gerçek kaynaklara canlı doğrulama |
| `npm run typecheck` / `npm run lint` | Tip kontrolü / lint |
| `npm run db:indexes` / `npm run db:migrate` | İndeksler / envanter + görevler |
| `npm run sources:report [-- --json]` | Kapsam raporu (insan/makine okunur) |
| `npm run seed:admin` | İlk yönetici (ADMIN_EMAIL/ADMIN_PASSWORD) |
| `npm run seed:demo` | Örnek veri (`provenance: 'sample'`) |
| `npm run fixtures:pdf` / `fixtures:capture` | Test fixture üretimi / canlı yakalama |

## Mimari ve belgeler

- [Mimari](./docs/architecture.md) — katmanlar, uçtan uca akış, kararlar
- [Kaynaklar ve kapsam](./docs/sources.md) — hangi kaynak doğrulandı, hangisi bekliyor
- [Yeni kaynak ekleme](./docs/source-onboarding.md)
- [Veri modeli](./docs/data-model.md)
- [Kurulum](./docs/setup.md) · [Dağıtım](./docs/deployment.md) · [İşletim](./docs/operations.md)
- [Güvenlik ve KVKK](./docs/security-kvkk.md)
- [Testler](./docs/testing.md) · [Dürüst sınırlar](./docs/limitations.md)

## Teknoloji

TypeScript (strict, `noUncheckedIndexedAccess`), Node 22, Fastify 5 + zod,
MongoDB veya dosya deposu, Redis/BullMQ veya yerleşik kalıcı kuyruk,
React 19 + Vite + Tailwind, vitest + Playwright, pino günlükleri.

## Testler

108 birim/entegrasyon testi, 9 dosya; hiçbiri dış ağa çıkmaz (sahte adaptör,
fixture HTML/PDF ve süreç içi SMTP sunucusu). Zorunlu 22 senaryonun eşlemesi,
uçtan uca gönderim testi ve E2E akışı: [docs/testing.md](./docs/testing.md).

## Lisans ve kullanım

Kişisel/istihdam bilgisi toplama aracıdır. Kaynakların kullanım koşullarına,
`robots.txt` kurallarına ve hız sınırlarına uyulması; engellerin (CAPTCHA, oturum
duvarı, coğrafi kısıt) aşılmaması esastır. İlanlar yeniden yayımlanmaz; her kayıt
resmî kaynağına bağlantı verir.
