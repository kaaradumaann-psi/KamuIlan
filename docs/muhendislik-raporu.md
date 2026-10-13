# Kamuİlan — Mühendislik Raporu

**Ürün:** Kamuİlan — kamu personel alım ilanı toplama, doğrulama ve bildirim platformu
**Alan adı:** `kamuilan.halilkaraduman.com.tr` (Cloudflare)
**Depo:** `kaaradumaann-psi/kamuradar` · **Dil:** TypeScript (strict) · **Arayüz dili:** Türkçe
**Rapor tarihi:** 12 Ekim 2026 · **Sürüm:** `2026.10.1`

---

## 1. Yönetici özeti

Kamuİlan; Resmî Gazete, ilan.gov.tr, ÖSYM, İŞKUR, Kariyer Kapısı, MEB ve kurum sayfalarında yayımlanan
personel alım ilanlarını **gerçek ağ istekleriyle** toplayan, kural tabanlı **sınıflandırma** ile
personel ilanı olmayan içeriği eleyen, ilanları tekilleştirip **yapılandırılmış alanlara** çeviren,
son başvuru tarihlerini izleyen ve kriterlere uyan ilanları **e-posta ile bildiren** uçtan uca bir
sistemdir.

Sistem "her ilanı topladığını" iddia etmez. Hangi kaynağın canlı doğrulandığı, hangisinin yalnızca
adaptörünün yazıldığı, hangisinin planlandığı; son başarılı taramanın ne zaman olduğu ve hangi
kaynağın kaç taramadır başarısız olduğu arayüzde açıkça yazılıdır. İlan kayıtlarında her alanın
hangi katmandan (liste / detay sayfası / belge / bağlantı) çıkarıldığı "alan kaynağı" olarak
gösterilir; bulunamayan alan **tahmin edilmez**, "belirtilmemiş" olarak kalır.

Doğrulama özeti (bu depoda çalıştırılan komutlarla):

| Kontrol                           | Komut                       | Sonuç                                                                             |
| --------------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| Tip denetimi                      | `npm run typecheck`         | temiz (0 hata)                                                                    |
| Lint                              | `npm run lint`              | 0 hata, 0 uyarı                                                                   |
| Birim/entegrasyon/arayüz testleri | `npm test`                  | **165 test / 15 dosya — tamamı geçti**                                            |
| Üretim derlemesi                  | `npm run build`             | başarılı (102 modül, `dist/`)                                                     |
| Ortam doğrulaması                 | `npm run env:check`         | kullanılabilir (3 uyarı: sağlayıcı/secret/admin)                                  |
| Kapsam raporu                     | `npm run sources:report`    | 9 kayıtlı kaynak: 8 etkin, **3 canlı doğrulanmış**, 5 adaptör yazılmış, 18 planlı |
| Tasarım eşliği (psikolog/MMPI)    | `npm test -- design-system` | 5/5: stil sırası + 9 paylaşılan katmanın SHA-256'sı birebir aynı                  |
| Kaynak adaptörü sözleşmesi        | `npm test -- sources`       | 13/13: kayıt, çevrimdışı mod, ilan.gov.tr ayrıştırma                              |
| Biçim denetimi                    | `npx prettier --check`      | değiştirilen dosyalar temiz (depo geneli kapsam dışı)                             |

---

## 2. İstenenler ve karşılıkları

| #   | İstenen                                                  | Durum | Nerede / kanıt                                                                                                                                             |
| --- | -------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Gerçek kaynaklardan veri toplama                         | ✅    | `src/sources/adapters/*` (7 adaptör) + `src/sources/fetcher.ts`; `npm run sources:report`                                                                  |
| 2   | Kural tabanlı sınıflandırma (mükerrer/sonuç/ihale eleme) | ✅    | `src/classification/rules.ts`, `engine.ts`; 21 test                                                                                                        |
| 3   | Yapılandırılmış alan çıkarımı (~25 alan)                 | ✅    | `src/extraction/engine.ts`, `dictionaries.ts`, `pdf.ts`; 26 test                                                                                           |
| 4   | Tekilleştirme (resmî no → URL → benzerlik → inceleme)    | ✅    | `src/dedupe/engine.ts`, `src/ingest/pipeline.ts`; 14 test                                                                                                  |
| 5   | Son başvuru takibi ve değişiklik sınıfları               | ✅    | `src/domain/dates.ts`, `src/ingest/revisions.ts`                                                                                                           |
| 6   | Zamanlanmış, yeniden başlatmaya dayanıklı tarama         | ✅    | `src/worker/scheduler.ts`, `src/db/repos/system.ts` (görev/kilit/heartbeat)                                                                                |
| 7   | Kriterlere göre e-posta bildirimi (outbox + worker)      | ✅    | `src/notifications/service.ts`, `src/email/*`; 19 test                                                                                                     |
| 8   | Türkçe, mobil, erişilebilir arayüz                       | ✅    | `src/App.tsx`, `src/pages/*`, `src/styles/*` (psikolog/MMPI tasarım katmanları)                                                                            |
| 9   | Rol tabanlı yönetim paneli                               | ✅    | `src/pages/Admin.tsx`, `src/server/routes/admin.ts`                                                                                                        |
| 10  | Zod doğrulamalı REST API + OpenAPI                       | ✅    | `src/server/routes/*`, `/api/docs`                                                                                                                         |
| 11  | Güvenlik: parola, çerez, CSRF, hız sınırı, SSRF, KVKK    | ✅    | `src/server/passwords.ts`, `src/lib/x-csrf.ts`, `src/sources/fetcher.ts`, `docs/security-kvkk.md`                                                          |
| 12  | Testler (fixture tabanlı, canlı çağrı yok)               | ✅    | `tests/*` — 15 dosya / 165 test                                                                                                                            |
| 13  | Docker ile tek komut ortam + CI                          | ✅    | `infra/docker/*`, `.github/workflows/ci.yml`                                                                                                               |
| 14  | **Dışarıdan kayıt yok**                                  | ✅    | `POST /api/auth/register` varsayılan 403; hesaplar `POST /api/admin/users` ile davet edilir                                                                |
| 15  | **Tasarım psikolog/MMPI ile aynı**                       | ✅    | `src/styles/{screen,site,coherence,theme,workspace,dashboard,mobile,responsive,auth}.css` bu repolarla **bayt bayt aynı**; Kamuİlan katmanı `kamuilan.css` |
| 16  | **Ad Kamuİlan + alt alan adı**                           | ✅    | `src/site.ts`, `index.html`, e-posta şablonları, `APP_DOMAIN`                                                                                              |
| 17  | **Test aşamasında dakikada bir tarama**                  | ✅    | `.env.example` → `SCAN_INTERVAL_MINUTES=1`; kaynak başına aralık `intervalMinutes`                                                                         |
| 18  | **Veritabanı Supabase**                                  | ✅    | `src/db/postgres-store.ts` (gerçek `pg` + PGlite ile test edilen SQL ön filtre), `DATABASE_DRIVER=supabase                                                 | postgres` |
| 19  | **Barındırma Cloudflare**                                | ✅    | `dist/` statik SPA + `wrangler.jsonc` (`not_found_handling: single-page-application`, custom domain) + `functions/api/[[path]].ts` ile `/api` proxy'si     |
| 20  | **E-posta Resend**                                       | ✅    | `src/email/transport.ts` (`ResendEmailTransport`, 9 test), `EMAIL_PROVIDER=resend`                                                                         |
| 21  | **Bu mühendislik raporu**                                | ✅    | Bu dosya                                                                                                                                                   |
| 22  | **PR aç ve birleştir**                                   | ✅    | `arena/7f4c2af6-kamuradar` → `main`                                                                                                                        |
| 23  | **`.env` dosyası otomatik okunur**                       | ✅    | `src/config/load-env.ts` (bağımlılıksız); gerçek ortam değişkeni öncelikli, `.env.<NODE_ENV>` üst katman, `NODE_ENV=test`'te atlanır; 11 test              |
| 24  | **Tasarım eşliği otomatik denetlenir**                   | ✅    | `tests/design-system.test.ts` + `tests/fixtures/design-parity.json` (SHA-256); tanımsız sınıf ve Tailwind-benzeri yardımcı sınıf kullanımı reddedilir      |

---

## 3. Sistem uçtan uca nasıl çalışıyor?

```
                        ┌──────────────────────────── worker (ayrı süreç) ───────────────────────────┐
  zamanlayıcı (30 sn tik)│  görev seçimi → kilit (lease) → adaptör → fetcher → HTML/PDF → ilan listesi │
                        │      ↓                                                                     │
                        │  sınıflandırma (kabul / ret / inceleme)                                     │
                        │      ↓                                                                     │
                        │  çıkarım (unvan, kurum, kontenjan, il, tarih, KPSS, sertifika…)              │
                        │      ↓                                                                     │
                        │  tekilleştirme (resmî no → URL → benzerlik → inceleme kuyruğu)               │
                        │      ↓                                                                     │
                        │  ilan + sürüm + kaynak bağlantısı kaydı (atomik)                            │
                        │      ↓                                                                     │
                        │  bildirim eşleştirme (tercihler) → notification_event (idempotent)          │
                        │      ↓                                                                     │
                        │  e-posta kuyruğu (outbox) → gönderim → sonuç kaydı (accepted/failed)         │
                        └────────────────────────────────────────────────────────────────────────────┘
                                                               ↓
   tarayıcı →  Cloudflare (SPA + API proxy) →  Fastify API →  Supabase (PostgreSQL) / Redis-opsiyonel kuyruk
```

### 3.1 Tarama (scraper katmanı)

- **Kaynak kayıtları veritabanındadır, kod değil.** `src/config/sources.ts` yalnızca açılış envanteridir;
  `npm run db:migrate` bunları `sources` koleksiyonuna yazar. Yeni kaynak eklemek için panelden
  (`POST /api/admin/sources`) kayıt açmak yeterlidir; kod değişikliği gerekmez. Adaptörü olmayan kaynak
  "adaptör yok" olarak işaretlenir ve **sessizce boş sonuç döndürmez** (uyarı üretir).
- **Tek çıktı sözleşmesi:** her adaptör `RawAnnouncement` üretir (kaynak anahtarı, kaynak içi kimlik, URL,
  başlık, metin, yayım zamanı, kurum, ekler, notlar). Böylece boru hattı adaptörden bağımsızdır.
- **En ucuz güvenilir yöntem:** HTML listelerde `cheerio`, belgelerde önce **PDF metin katmanı**
  (`pdfjs-dist`), yalnızca metin katmanı yoksa OCR notlanır (varsayılan kapalı). Playwright yalnızca
  Kariyer Kapısı için (liste JavaScript ile üretiliyor) ve **isteğe bağlıdır**; kurulu değilse tarama
  "atlandı" olarak kaydedilir, sistem çökelmez.
- **Ağ katmanı** (`src/sources/fetcher.ts`): alan adı izin listesi (SSRF), özel/yerel IP ve bulut metadata
  adreslerinin reddi, yönlendirme zincirinde her adımın yeniden doğrulanması, boyut/zaman aşımı sınırları,
  `429/503` için `Retry-After`'a saygılı gecikme, `ETag`/`Last-Modified` ile koşullu istek, kaynak başına
  en kısa istek aralığı, üstel geri çekilme + jitter, anlamlı `User-Agent`.
- **Hata sınıfları:** erişim kısıtı/JS zorunluluğu → `AdapterUnavailableError` (tarama `skipped`, hata
  sayılır ve 6 saatte bir yönetici uyarısı üretir); sayfa yapısı bozuldu ama sayfa geldi → `StructureError`
  (gürültü yapmadan "yapı değişmiş olabilir" notu); diğer hatalar → üstel geri çekilmeli yeniden deneme,
  `EMAIL`/`SCRAPE` ölü iş kuyruğu (`dead letter`) ve yönetim panelinde görünürlük.
- **Kaynak erişilemezse ilanlar silinmez:** kayıtlar korunur, kaynak "bayat" olarak işaretlenir ve
  `lastSeenAt` güncellenmez.

### 3.2 Sınıflandırma

Kural motoru üç karar üretir: **kabul**, **ret**, **inceleme**. Karar; eşleşen kurallar, gerekçe,
güven puanı ve kural sürümüyle birlikte kaydedilir (`CLASSIFICATION_VERSION`).

- Başlık kapsamlı negatif kurallar: ihale, satın alma, kiralama, tebliğ, sonuç listesi, atama kararı,
  yönetmelik, burs/staj — bunlar reddedilir.
- Tek anahtar kelimeyle karar verilmez: tür tespiti (kadrolu memur, sözleşmeli, kamu işçisi, akademik,
  kariyer mesleği, kuruma özgü sınavlı, diğer) birden çok sinyalin ağırlıklı toplamıdır.
- Güven eşiğin altında kalan içerik **silinmez**: inceleme kuyruğuna düşer (`review_queue`), yönetici
  kararı denetim kaydına yazılır.
- AI tamamen isteğe bağlıdır ve anahtar yoksa sistem çalışmaya devam eder; toplanan metin **yalnızca veri**
  olarak işlenir (talimat olarak yorumlanmaz).

### 3.3 Çıkarım

`text`, `requirements`, `fieldSources` ve `evidence` alanları üretilir: unvan(lar), kurum, birim, kontenjan,
il/ilçe, başvuru başlangıç/bitiş, başvuru yöntemi, resmî detay linki, başvuru linki, ekler, istihdam türü,
kadro, eğitim düzeyi, bölüm, KPSS türü/puanı/yılı, yaş, sertifika, deneyim, yabancı dil, özel koşullar,
yayım tarihi, son görülme, güven ve son doğrulama.

- **Tahmin yok.** Bulunamayan alan `null` kalır ve arayüzde "belirtilmemiş" yazar; "?" ile doldurulmaz.
- **Alan bazlı kaynak izi.** Her alan için `{ kind: listing | detail | document | link, snippet }` saklanır.
- **Tarih ayrıştırma** Türkiye saatine göre ve Türkçe ay adlarıyla yapılır (`20-30 Ekim 2026` gibi
  paylaşımlı aralıklar, `20.10.2026 23:59` gibi saatli ifadeler, `gg.aa.yyyy` alt dizgileri ayrı ayrı ele
  alınır). Metinde kesin tarih yoksa kesin tarih **üretilmez**.
- PDF'lerde metin katmanı yoksa kayıt incelemeye düşer, ek dosya bağlantısı korunur (OCR zorunlu değil).

### 3.4 Tekilleştirme

Sıra: **resmî ilan numarası → ilan numarası → normalize edilmiş kanonik URL → kurum+unvan+dönem benzerliği
→ elle inceleme**. Benzer başlıklı farklı ilanlar otomatik birleştirilmez; şüpheli eşleşmeler
`review_queue` içine `dedupe` tipiyle düşer.

Her ilanda `contentHash`, `dedupeKey`, `version`, önceki sürüm ve değişen alanlar tutulur. Değişiklik
sınıfları: yeni ilan, son başvuru değişikliği, koşul değişikliği, kontenjan değişikliği, kapanış, başvuru
bağlantısı değişikliği, geri çekilme. İlanın tüm kaynak bağlantıları korunur (`job_sources`), hiçbiri
diğerinin yerine geçmez.

### 3.5 Zamanlama ve dayanıklılık

- Kalıcı görev tablosu (`scheduled_tasks`): kaynak başına aralık, `nextRunAt`, `lastRunAt`, kaçırılan
  çalışma sayısı. Süreç yeniden başlasa da plan kaybolmaz.
- Kilit tablosu (`locks`) + sahiplik lease'i: aynı kaynak için **eşzamanlı ikinci tarama başlamaz**; süresi
  geçen kilitler temizlenir.
- Heartbeat (`worker_heartbeats`): worker durumu, son kalp atışı, işlenen iş sayısı; 120 saniyeden uzun
  sessizlik "bayat" sayılır ve `/api/health` ile panelde uyarı olur.
- **Tarama ile e-posta ayrıdır:** tarama yavaşlasa da gönderim kuyruğu kendi worker'ıyla ilerler.
- Gecikme ölçüsü: `scheduleDelayMs` her taramada kaydedilir; panelde "planlanan saatten sapma" olarak
  görünür. `setInterval` yok; zamanlayıcı tablo güdümlü tik ile çalışır.
- Test aşaması için varsayılan `SCAN_INTERVAL_MINUTES=1` (test/demo), üretim için kaynak başına
  30–360 dakika önerilir. Bulut ortamı uyuduğunda saatlik/dakikalık taramanın gecikebileceği
  `docs/limitations.md` ve `docs/operations.md` içinde yazılıdır.

### 3.6 Bildirim ve e-posta

Akış: **doğrulama → tekilleştirilmiş ilan → tercih eşleştirme → tekil olay (`notification_events`) →
işlemsel outbox → worker gönderimi → sonuç kaydı**.

- **Doğrulanmamış adrese bildirim gitmez.** Doğrulama bağlantısı, şifre sıfırlama ve davet e-postaları da
  aynı altyapıyı kullanır.
- Eşleşme, ilan sürümüyle birlikte kaydedilir; aynı ilan için aynı sürüm tekrar gönderilmez (idempotent).
- Gönderim durumu dürüsttür: `accepted` = sağlayıcı 2xx döndü (**"sağlayıcıya iletildi"**), teslim
  garantisi iddia edilmez. 4xx/5xx ve ağ hataları gövdesiyle kaydedilir; sınırlı sayıda üstel geri
  çekilmeli yeniden deneme, ardından ölü kuyruk ve panelde manuel yeniden kuyruklama.
- E-postalar Türkçe, mobil uyumlu HTML + düz metin olarak gönderilir; içinde unvan, kurum, istihdam türü,
  kontenjan, il, son başvuru, resmî + başvuru bağlantısı, **eşleşme gerekçesi**, tercih ve çıkış
  bağlantıları bulunur. İşlemsel e-postalarda pazarlama/tercih alt bilgisi kullanılmaz.
- Geliştirmede sağlayıcı yoksa dosya taşıyıcısı kullanılır (`data/mail/`) ve arayüz/panel bunun **test
  gönderimi** olduğunu yazar; üretimde sağlayıcı yoksa sistem başlangıçta uyarır ve Resend anahtarı
  olmadan gönderim yapmaz.

### 3.7 Arayüz

- **Genel (oturumsuz):** ana sayfa (gerçek sayılar, son başarılı tarama, sistem durumu, tür dağılımı, son
  eklenenler, yaklaşan son başvurular), ilan arama (filtreler URL'de → paylaşılabilir bağlantı, sıralama,
  sayfalama), ilan detayı (standart alanlar, koşullar, ekler, tüm kaynaklar, alan bazlı kaynak izi,
  belirsizlik uyarıları, resmî ilan bağlantısı), kaynaklar/kapsam, SSS, gizlilik & KVKK, kullanım koşulları.
- **Oturumlu:** bildirim tercihleri paneli (unvan, kurum, il, istihdam türü, eğitim, bölüm, KPSS, puan,
  gün, anahtar kelime, sadece yeni, değişiklikler, kamu işçisi/akademik dahil-hariç, duraklat, test
  e-postası, hesabı sil), bildirim geçmişi.
- **Yönetici:** genel bakış, kaynak CRUD + manuel tarama, tarama geçmişi (hata ayrıntıları, HTTP kodları),
  inceleme kuyruğu (çöz/geç), e-posta kuyruğu ve yeniden deneme, kuyruk/kilit/görev durumu, kapsam raporu,
  kullanıcı davet etme, denetim kaydı.
- **Tasarım dili** psikolog/MMPI çalışma alanlarıyla aynıdır: aynı token seti, aynı bileşen sınıfları
  (`.portal-layout`, `.workspace-sidebar`, `.app-header`, `.card-elevated`, `.modern-data-table`,
  `.btn-*`, `.tag-*`), aynı tipografi ve boşluk ölçeği. Dar ekranda aynı hedefler erişilebilir menü
  paneline taşınır.
- **Erişilebilirlik:** "ana içeriğe atla" bağlantısı, `aria-current` işaretli gezinme, `role="alert"`
  hatalar, klavye ile tam gezinme, odak tuzağı ve Esc ile kapanan diyaloglar, tablo başlıkları (`<th
scope>` / `caption`), renk-dışı durum etiketleri.
- **Kayıt yoktur:** giriş ekranında "Halka açık kayıt yoktur. Hesabınız yönetici tarafından açılır."
  yazılıdır; kayıt ucu sunucuda kapalıdır.

### 3.8 API

`/api/health`, `/api/jobs` (+ `:id`, `:id/sources`, `:id/revisions`, `deadlines/upcoming`, `stats`),
`/api/sources` (+ `:key/status`), `/api/notifications/*` (tercihler, duraklat, geçmiş, test),
`/api/auth/*` (kayıt [kapalı], giriş, çıkış, oturum, doğrulama, şifre sıfırlama, çıkma, hesap silme),
`/api/admin/*` (kaynak CRUD + tarama, tarama geçmişi, inceleme kuyruğu, e-posta kuyruğu, kuyruk/kilit,
kapsam, kullanıcılar, denetim).

Tüm gövde/sorgu parametreleri **Zod** ile doğrulanır, hatalar tek biçimde döner
(`{ error: { code, message, details } }`), şemalar OpenAPI'ye dönüştürülür ve `/api/docs` adresinde
yayımlanır. HTTP katmanında iş kuralı yoktur; uçlar depoları/servisleri çağırır. Kullanıcıya ait kaynaklara
erişim oturum sahibiyle sınırlıdır (başka kullanıcının tercihi/geçmişi okunamaz).

---

## 4. Veri modeli ve depolama

Koleksiyonlar (Zod şemaları `src/db/schemas.ts`): `sources`, `jobs`, `jobSources`, `jobRevisions`, `users`,
`notificationPreferences`, `notificationEvents`, `emailOutbox`, `scrapeRuns`, `reviewQueue`, `auditLogs`,
`workerHeartbeats`, `locks`, `scheduled_tasks`, `rate_limits`, `authTokens`, `sessions`.

- Benzersizlik: `users.emailNormalized`, `jobs.dedupeKey`, `jobs.normalizedUrl`,
  `jobSources(sourceKey, sourceItemId)`, `notificationEvents(userId, jobId, jobVersion, kind)` — mükerrer
  kayıt ve mükerrer bildirim veritabanı seviyesinde engellenir.
- Sorgu indeksleri: durum + son başvuru, kurum, il, tür, yayım zamanı, kaynak anahtarı, kuyruk durumları,
  inceleme durumu, outbox durumu + sonraki deneme. `npm run db:indexes` idempotenttir (44 indeks).
- **PostgreSQL yolu** (`src/db/postgres-store.ts`): her koleksiyon `id text` + `data jsonb` tablosudur;
  sorgular önce JSONB ön filtreye (GIN `jsonb_path_ops`) çevrilir, kesin eşleşme uygulamada yapılır.
  Ön filtre üretilemeyen sorgularda tarama güvenli biçimde sınırlandırılır (`MAX_SCAN_ROWS`).
  Bu katman gerçek `pg` havuzuyla çalışır ve **PGlite** ile test edilir (`tests/postgres-store.test.ts`),
  yani SQL üretimi canlı veritabanı olmadan doğrulanabilir.
- **Supabase** aynı PostgreSQL yolunu kullanır (`DATABASE_DRIVER=supabase`), tablolar `<prefix>_<koleksiyon>`
  adıyla oluşturulur; anahtarlar yalnızca sunucudadır.
- Sürücü seçimi `DATABASE_DRIVER` iledir: `file` (geliştirme), `postgres`/`supabase` (üretim),
  `mongo` (eski kurulumlar). Dosya sürücüsü atomik yazma ve dosya kilidi kullanır.

---

## 5. Kaynak envanteri ve doğrulama durumu

`npm run sources:report` çıktısından (12 Ekim 2026):

| Kaynak                          | Yöntem                | Durum                               | Not                                                                             |
| ------------------------------- | --------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| Resmî Gazete — Çeşitli İlânlar  | PDF dizini            | **Canlı doğrulandı**                | Günlük bölüm sayfası + ilan PDF'leri; metin katmanı okunur                      |
| ilan.gov.tr — personel alımları | HTML liste            | **Canlı doğrulandı**                | Sayfalama, kurum/il filtreleri                                                  |
| ÖSYM — duyurular                | HTML liste            | **Canlı doğrulandı**                | Duyuru listesi + detay sayfası                                                  |
| İŞKUR — kamu memur alımı        | HTML liste            | Adaptör yazıldı, canlı doğrulanmadı | Liste yapısı bu ortamdan doğrulanamadı; yapı değişirse `structure` hatası verir |
| İŞKUR — kurum dışı kamu işçisi  | HTML liste            | Adaptör yazıldı, canlı doğrulanmadı | Adres ana sayfadaki resmî bağlantıdan alındı                                    |
| MEB — personel duyuruları       | HTML liste            | Adaptör yazıldı, canlı doğrulanmadı | "TÜM HABERLER" listesi                                                          |
| Kariyer Kapısı — işe alım       | Tarayıcı (Playwright) | Adaptör yazıldı, koşullu            | Liste JavaScript ile üretiliyor; tarayıcı kurulu değilse tarama "atlandı"       |
| Kamuİlan (SBB) merkezî ekran    | HTML/JSON             | Erişim kısıtlı                      | Bu ortamdan WAF 403; kısıt aşılmaz, engellenmediği ortamda otomatik denenir     |
| e-Devlet/eşube                  | Elle yöntem           | Kayıt                               | Otomatik erişim yok; kullanıcıya elle başvuru yolu gösterilir                   |

**Kurum kaynakları:** bakanlıklar, başkanlıklar ve düzenleyici kurumlar (Sağlık, Adalet, İçişleri,
AFAD, SGK, GİB, TÜİK, DSİ, KGM, Tapu-Kadastro, TÜBİTAK, YÖK, BDDK, SPK, EPDK, RTÜK, TMSF) genel
`kurum-duyuru-listesi` adaptörüyle taranmaya hazırdır (canlı doğrulama bekler; yapı uymazsa sessiz
boş yerine hata kaydeder). **Tek kaynak yapılamayan:** üniversiteler (125), üniversite hastaneleri
ve belediyeler — merkezî kaynaklarla dolaylı kapsanır. Ayrıntı: `docs/sources.md`, kaynak ekleme
rehberi: `docs/source-onboarding.md`.

> **Dürüstlük notu:** Canlı doğrulama yalnızca bu deponun çalıştığı ortamdan gerçekten erişilip liste
> okunabilen kaynaklar için yapılmıştır. Adaptörü yazılmış olmak "doğrulandı" anlamına gelmez ve arayüzde
> ayrı etiketle gösterilir.

---

## 6. Güvenlik ve KVKK

- Parolalar `scrypt` (N=16384) + kullanıcıya özel tuz; düz metin parola hiçbir zaman üretilmez/saklanmaz.
  Yönetici davetinde rastgele bir sır hash'lenir, kullanıcı tek kullanımlık bağlantıyla kendi parolasını belirler.
- Oturum çerezleri `HttpOnly`, `Secure` (üretim), `SameSite=Lax`; durum değiştiren isteklerde CSRF jetonu
  (`X-CSRF-Token`) zorunludur.
- Hız sınırı: genel uçlar ve kimlik uçları için ayrı limitler; şifre sıfırlama/giriş denemeleri ek korunur.
- SSRF savunması: yalnızca izin listesindeki alan adları, özel/yerel IP ve metadata adreslerinin reddi,
  yönlendirmelerin her adımda yeniden doğrulanması, boyut/süre sınırları, indirilen dosyaların tür kontrolü.
- Toplanan HTML/PDF **güvenilmeyen veri**dir: içeriği çalıştırılmaz, arayüzde düz metin olarak gösterilir,
  bağlantılar `noopener noreferrer` ile açılır.
- Günlüklerde e-posta adresleri maskelenir; sırlar günlüğe yazılmaz; yönetici işlemleri denetim kaydına
  (aktör, hedef, zaman, IP hash'i) düşer.
- KVKK: hesap silindiğinde e-posta anonimleştirilir, tercihler ve oturumlar kaldırılır, bildirim kayıtları
  anonim tutulur; saklama süreleri gizlilik politikasında yazılıdır. Ayrıntı: `docs/security-kvkk.md`.

---

## 7. Test ve doğrulama

| Test dosyası                     | Test    | Kapsam                                                                                                                |
| -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `tests/classification.test.ts`   | 21      | ret/kabul/inceleme kararları, tür tespiti, sürüm ve gerekçe                                                           |
| `tests/extraction.test.ts`       | 26      | alan çıkarımı, tarih biçimleri, KPSS/kontenjan, tahmin yasağı                                                         |
| `tests/ingest.test.ts`           | 14      | tekilleştirme, sürümleme, kaynak bağlantıları, değişiklik sınıfları                                                   |
| `tests/sources.test.ts`          | 13      | **kayıt sözleşmesi**, `SOURCE_LIVE_FETCH=0` davranışı, ilan.gov.tr ayrıştırma, `blockElementText`/`İlan No` tuzakları |
| `tests/env-loader.test.ts`       | 11      | `key: value` ayrıştırma, tırnak/kaçış, çok satırlı değer, gerçek ortam önceliği, sır gizleme                          |
| `tests/email.test.ts`            | 10      | şablonlar, tercih eşleştirme, eşleşme gerekçesi                                                                       |
| `tests/resend-transport.test.ts` | 9       | Resend istek biçimi, hata eşlemesi, zaman aşımı, sağlayıcı seçimi                                                     |
| `tests/pdf.test.ts`              | 7       | gerçek PDF metin katmanı, bozuk PDF dayanıklılığı, metin sınırlama                                                    |
| `tests/design-system.test.ts`    | 5       | stil sırası, 9 katmanın SHA-256 eşliği, tanımsız sınıf ve yardımcı sınıf yasağı                                       |
| `tests/ui.test.tsx`              | 5       | kabuk çizimi (jsdom): kamuya açık sayfalar, oturumsuz panelde giriş kartı, kayıt bağlantısı yok                       |
| `tests/worker.test.ts`           | 15      | zamanlama, kilit, atlanan/failing kaynak davranışı, uyarı sıklığı                                                     |
| `tests/server.test.ts`           | 15      | API sözleşmeleri, RBAC, CSRF, kayıt kapalı, maskeli e-posta                                                           |
| `tests/email-delivery.test.ts`   | 5       | gerçek SMTP sunucusuyla uçtan uca gönderim                                                                            |
| `tests/postgres-store.test.ts`   | 7       | gerçek SQL üretimi ve JSONB yolu (PGlite), dosya sürücüsüyle parite                                                   |
| `tests/file-store.test.ts`       | 2       | dosya sürücüsü atomik yazma/sorgu davranışı                                                                           |
| **Toplam**                       | **165** | **15 dosya**                                                                                                          |

Testler **canlı kaynağa istek atmaz** (fixture'lar ve sahte taşıyıcılar kullanılır); dosya değişiklikleri
geçici dizinlerde yapılır. E2E (`e2e/smoke.spec.ts`, `e2e/sources.spec.ts`) API + arayüz ayağa kalkmış
hâlde çalışır ve "dürüstlük" kontrollerini yapar (ör. arayüzdeki "canlı doğrulanmış" sayısının tablodaki
işaretli satır sayısına eşit olması).

**Bu ortamda çalıştırılan komutlar ve sonuçları:** `npm run typecheck` ✅ · `npm run lint` ✅ ·
`npm test` ✅ 165/165 · `npm run build` ✅ · `npm run env:check` ✅ · `npm run sources:report` ✅ ·
Playwright tarayıcıları bu ortamda indirilemediği için **E2E koşulamadı** (kurulum adımları
`docs/testing.md` içinde).

> **Sonraki turlar (13.10.2026):** yukarıdaki tablo ilk teslimatın fotoğrafıdır.
> Giriş/oturum düzeltmeleri ve uçtan uca denetim turundan sonra suite
> **28 dosya / 273 teste** çıktı; eklenen dosyalar:
> `tests/login-page.test.tsx`, `tests/api-client-error.test.ts`,
> `tests/auth-session-setup.test.ts`, `tests/audit-fixes.test.ts` (27 regresyon
> testi), `tests/panel-preferences.test.tsx`. Ayrıntı ve kanıtlar:
> [denetim-raporu-2026-10-13.md](./denetim-raporu-2026-10-13.md).

---

## 8. Kurulum ve çalıştırma (özet)

Tam kurulum, üretim ve sorun giderme: **`docs/setup.md`** · Dağıtım: **`docs/deployment.md`** ·
İşletim: **`docs/operations.md`** · Sınırlar: **`docs/limitations.md`**.

```bash
npm install                                   # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ile tarayıcısız
cp .env.example .env                          # sırları doldurun (aşağıdaki listeye bakın)
npm run env:check                             # eksik/yanlış değişkenleri raporlar
npm run db:migrate                            # kaynak envanteri + indeksler + görevler
npm run dev                                   # arayüz 5173, API 3000, worker, posta kutusu 1080
npm run seed:admin                            # ilk yönetici (ADMIN_EMAIL/ADMIN_PASSWORD)
```

Tek komut alternatifi: `cd infra/docker && docker compose up --build`
(yerel PostgreSQL ile: `DATABASE_DRIVER=postgres docker compose --profile postgres up --build`).

**Gerekli ortam anahtarları:** `APP_SECRET` (zorunlu, ≥32 karakter), `DATABASE_DRIVER` +
`POSTGRES_URL` (Supabase: `POSTGRES_SSL=true`) veya `SUPABASE_URL`/`SUPABASE_ANON_KEY`/
`SUPABASE_SERVICE_ROLE_KEY`, `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM`,
`APP_BASE_URL`/`APP_DOMAIN`, `SCAN_INTERVAL_MINUTES`, `SOURCE_ALLOWED_HOSTS`,
`ADMIN_EMAIL`/`ADMIN_PASSWORD` (ilk kurulum), `ALLOW_PUBLIC_REGISTRATION=0`.
Ayrıntılı tablo: `docs/setup.md` § Ortam değişkenleri.

---

## 9. Bilinen sınırlar ve dürüst notlar

1. **Kapsam eksiktir.** 18 kurum grubu planlanmış durumda; ilanları kısmen ilan.gov.tr ve Resmî Gazete
   üzerinden gelir ama kendi sayfaları entegre değildir. Arayüz bunu yazar.
2. **Canlı doğrulama ortamı kısıtlıydı.** Bu ortamdan bazı alan adlarına erişilemedi; bu nedenle 5 kaynak
   "adaptör yazıldı, canlı doğrulanmadı" olarak işaretli ve öyle gösteriliyor. Kısıt aşılmaya çalışılmadı.
3. **Supabase/Cloudflare/Resend bu ortamdan erişilemediği için** SQL katmanı PGlite ile, e-posta sağlayıcısı
   sahte `fetch` ile, gönderim akışı gerçek SMTP ile test edildi. Üretim bağlantıları **kullanıcı
   tarafından doğrulanmalıdır** (kontrol listesi: `docs/deployment.md`).
4. **Günlük özet (daily-digest) modu** veri modelinde ve tercihlerde var; gönderim planı bir sonraki
   sürümde zamanlanacaktır. Şu an `instant` akışı uçtan uca çalışır.
5. **E2E testleri bu ortamda koşulamadı** (tarayıcı indirmesi engelli). CI iş akışı bunu otomatik yapar.
6. Kariyer Kapısı yalnızca Playwright kuruluysa taranır; kurulu değilse tarama "atlandı" olarak kaydedilir
   ve panelde görünür — sistem bu durumda çökelmez, ilan silmez.
7. Kozmetik: `users.emailNormalized` benzersiz indeks adı bir kez `uniq`, ikinci kez `uniq` ekini alıyor
   (davranış doğru, ad yalnızca güvenlik ağı olarak `ON CONFLICT DO NOTHING` ile korunuyor).

---

## 10. Aşamalı teslimat günlüğü

| Aşama | İçerik                                                                         | Durum |
| ----- | ------------------------------------------------------------------------------ | ----- |
| 1     | Depo iskeleti, yapılandırma, ortam doğrulaması, veri modeli                    | ✅    |
| 2     | Depo katmanı (dosya + MongoDB + PostgreSQL/Supabase), indeksler                | ✅    |
| 3     | Kaynak adaptörleri + ağ katmanı (SSRF, geri çekilme, koşullu istek)            | ✅    |
| 4     | Sınıflandırma + çıkarım (PDF dahil)                                            | ✅    |
| 5     | Boru hattı: tekilleştirme, sürümleme, inceleme kuyruğu                         | ✅    |
| 6     | Zamanlama, kilit, heartbeat, bakım işleri                                      | ✅    |
| 7     | E-posta: tercihler, outbox, Resend/SMTP, şablonlar, çıkış                      | ✅    |
| 8     | API: genel uçlar, kimlik, yönetim, OpenAPI                                     | ✅    |
| 9     | Arayüz: kamu portalı, panel, yönetim, bilgi sayfaları (psikolog/MMPI tasarımı) | ✅    |
| 10    | Testler, dokümantasyon, Docker, CI, kapsam raporu                              | ✅    |
| 11    | Giriş/oturum uçtan uca düzeltmeleri + hesap araçları (`user:create`)            | ✅    |
| 12    | Uçtan uca denetim: arama, tarih/saat, güvenlik, arayüz ([rapor](./denetim-raporu-2026-10-13.md)) | ✅    |

---

## 11. Sonraki adımlar (üretim kontrol listesi)

1. Supabase projesi açın; `POSTGRES_URL` (pooler) ve `POSTGRES_SSL=true` ile `DATABASE_DRIVER=supabase`.
2. `npm run db:indexes` ve `npm run db:migrate` komutlarını çalıştırın (idempotent).
3. Resend'de alan adını doğrulayın; `RESEND_API_KEY` ve `EMAIL_FROM` değerlerini girin.
4. `npm run seed:admin` ile ilk yöneticiyi açın; `ALLOW_PUBLIC_REGISTRATION=0` kaldığını doğrulayın.
5. Cloudflare'de alan adını bağlayın (`docs/deployment.md`); Worker/cron ile tarama saatlerini planlayın.
6. `npm run sources:report` çıktısını gözden geçirin; "adaptör yazıldı, doğrulanmadı" kaynakları Türkiye'den
   erişimle doğrulayıp `verification` durumlarını panelden güncelleyin.
7. Yedekleme/geri yükleme provasını ve `docs/operations.md` izleme adımlarını uygulayın.
