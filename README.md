# Kamuİlan

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
   denetim kaydı (RBAC korumalı). Kapsam şu an **27 kayıtlı kaynak**tır: merkezî
   kaynaklara ek olarak bakanlıklar, başkanlıklar ve düzenleyici kurumlar genel
   kurum adaptörüyle taranır; canlı doğrulaması yapılmamış olanlar arayüzde
   "adaptörü yazılmış" olarak işaretlenir. Yalnızca 4 toplu grup (üniversiteler,
   üniversite hastaneleri, belediyeler) merkezî kaynaklarla dolaylı kapsanır.

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

Sonraki kullanıcılar (uygulama kendi kullanıcı tablosunu kullanır; **Supabase Auth
kullanılmaz**, panodan eklenen kullanıcı giriş yapmaz):

```bash
npm run user:create -- --email kisi@ornek.com --name "Ad Soyad"      # davet bağlantısı üretir
npm run user:create -- --email kisi@ornek.com --password "Güçlü-Parola1" --force
```

**Kendi kendine kayıt YOKTUR.** Kamuİlan'da hesap açmanın tek yolu yöneticinin
davetidir: yönetim panelindeki *Kullanıcı davet et* formu hesabı açar ve davetliye
tek kullanımlık **şifre belirleme** bağlantısı e-posta ile gider
(`ALLOW_PUBLIC_REGISTRATION=0`). Bu, sahte/istenmeyen hesapları ve bildirim
listesinin dışarıdan büyümesini engeller.

Ayrıntılı kurulum: [docs/setup.md](./docs/setup.md) ·
Docker ile: `cd infra/docker && docker compose up --build`

## Komutlar

| Komut | Açıklama |
| --- | --- |
| `npm run dev` | Arayüz + API + worker + geliştirme SMTP (tek komut) |
| `npm run dev:api` / `dev:worker` / `dev:web` / `dev:smtp` | Parça parça çalıştırma |
| `npm run build` / `npm run preview` | Arayüz derlemesi / önizleme (4173) |
| `npm start` / `npm run start:worker` | Üretim: API / worker |
| `npm test` | Vitest (birim + entegrasyon + arayüz kabuğu, ağ erişimi yok) |
| `npm run test:e2e` | Playwright tarayıcı testleri |
| `SOURCE_LIVE_FETCH=1 npm run test:live` | Gerçek kaynaklara canlı doğrulama |
| `npm run typecheck` / `npm run lint` | Tip kontrolü / lint |
| `npm run db:indexes` / `npm run db:migrate` | İndeksler / envanter + görevler |
| `npm run sources:report [-- --json]` | Kapsam raporu (insan/makine okunur) |
| `npm run seed:admin` | İlk yönetici (ADMIN_EMAIL/ADMIN_PASSWORD) |
| `npm run user:create` | Kullanıcı aç / davet et / parola belirle (`--email`, `--admin`, `--password`, `--force`) |
| `npm run seed:demo` | Örnek veri (`provenance: 'sample'`) |
| `npm run fixtures:pdf` / `fixtures:capture` | Test fixture üretimi / canlı yakalama |
| `npm run env:check` | Ortam değişkeni doğrulaması (eksik/tehlikeli ayar uyarıları) |

## Mimari ve belgeler

- [Mühendislik raporu](./docs/muhendislik-raporu.md) — istenenler ↔ yapılanlar, uçtan uca akış, doğrulama sonuçları
- [Uçtan uca denetim raporu](./docs/denetim-raporu-2026-10-13.md) — bulunan hatalar, düzeltmeler ve kanıtlar
- [Doğrulama kaydı](./docs/dogrulama-2026-10-13.md) — kaynak doğrulamaları ve koşum sonuçları
- [Mimari](./docs/architecture.md) — katmanlar, uçtan uca akış, kararlar
- [Kurulum ayrıntıları](./docs/setup.md) — Supabase/Cloudflare/Resend anahtarları, davet akışı
- [Kaynaklar ve kapsam](./docs/sources.md) — hangi kaynak doğrulandı, hangisi bekliyor
- [Yeni kaynak ekleme](./docs/source-onboarding.md)
- [Veri modeli](./docs/data-model.md)
- [Kurulum](./docs/setup.md) · [Dağıtım](./docs/deployment.md) · [İşletim](./docs/operations.md)
- [Güvenlik ve KVKK](./docs/security-kvkk.md)
- [Testler](./docs/testing.md) · [Dürüst sınırlar](./docs/limitations.md)

## Üretim yığını

| Katman | Seçim | Not |
| --- | --- | --- |
| Veritabanı | **Supabase Postgres** (`DATABASE_DRIVER=supabase`) | Koleksiyonlar `kamuilan_<koleksiyon>` tablolarında JSONB olarak durur; GIN indeksi + ifade indeksleri `npm run db:indexes` ile kurulur |
| Alan adı / barındırma | **Cloudflare** (`kamuilan.halilkaraduman.com.tr`) | Arayüz statik derleme olarak Cloudflare'de; `/api` API'ye yönlendirilir |
| E-posta | **Resend** (`EMAIL_PROVIDER=resend`) | `RESEND_API_KEY` sunucu tarafında; taşıyıcı HTTPS API'dir, SDK bağımlılığı yoktur |
| Alternatifler | MongoDB (eski kurulum), SMTP, Docker Compose | Kod tabanı üç depo sürücüsünü ve dört e-posta taşıyıcısını destekler |

**Test aşaması:** `SCAN_INTERVAL_MINUTES=1` (her dakika tarama) ile gelinir; bu
ayar yalnızca test içindir, üretimde kaynak temsiline saygı için 30–360 dakika
önerilir (`SCAN_INTERVAL_MINUTES=0` → kaynak başına `intervalMinutes` kullanılır).

## Arayüz tasarımı

Arayüz, psikolog ve MMPI çalışma alanlarıyla **aynı tasarım katmanlarını** kullanır:
`src/styles/screen.css`, `site.css`, `coherence.css`, `theme.css`, `workspace.css`,
`dashboard.css`, `mobile.css`, `responsive.css` ve `auth.css` bu repolarda birebir
kopyadır; Kamuİlan'a özgü yüzeyler `kamuilan.css` içindedir. Kabuk (sol gezinme,
üst başlık, alt bilgi, dar ekran menüsü) referans uygulamalarla aynı sınıf
sözlüğünü kullanır. Yardımcı sınıf üreten CSS eklentisi kullanılmaz.

## Teknoloji

TypeScript (strict, `noUncheckedIndexedAccess`), Node 22, Fastify 5 + zod,
Supabase Postgres / MongoDB / dosya deposu (aynı `StoragePort`), Redis/BullMQ
veya yerleşik kalıcı kuyruk, Resend/SMTP/dosya e-posta taşıyıcıları,
React 19 + Vite, vitest + Playwright, pino günlükleri.

## Testler

136 birim/entegrasyon testi, 12 dosya; hiçbiri dış ağa çıkmaz (sahte adaptör,
fixture HTML/PDF, süreç içi SMTP sunucusu, PGlite ile gerçek Postgres davranışı ve
sahte Resend uç noktası). Zorunlu 22 senaryonun eşlemesi, uçtan uca gönderim testi
ve E2E akışı: [docs/testing.md](./docs/testing.md).

## Lisans ve kullanım

Kişisel/istihdam bilgisi toplama aracıdır. Kaynakların kullanım koşullarına,
`robots.txt` kurallarına ve hız sınırlarına uyulması; engellerin (CAPTCHA, oturum
duvarı, coğrafi kısıt) aşılmaması esastır. İlanlar yeniden yayımlanmaz; her kayıt
resmî kaynağına bağlantı verir.
