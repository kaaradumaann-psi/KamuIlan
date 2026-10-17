# Testler

## Komutlar

```bash
npm run verify:all   # typecheck + lint + test + coverage + build + offline contracts/reports
npm test              # birim + entegrasyon (Vitest, dış erişim engellenir)
npm run test:watch    # geliştirme sırasında izleme
npm run test:coverage
npm run test:e2e      # Playwright; izole API/DB ve yönetici hesabı gerekir
npm run test:e2e:local # smoke.spec.ts; aynı izole API/DB ve yönetici hesabı gerekir
```

`verify:all` ve canlı doğrulama komutlarının izolasyon, rapor ve operatör koşulları:
[quality/OFFLINE-VERIFY.md](./quality/OFFLINE-VERIFY.md). Live kaynaklar bu komutun parçası değildir.

Vitest testleri sahte adaptör/fetcher, fixture HTML/PDF ve süreç içi SMTP
sunucusu kullanır; gerçek resmi kaynaklara istek atmaz. E2E Playwright testi
ise çalışan API ve Vite arayüzü, test için ayrılmış veritabanı ve yönetici hesabı
ister. `loginAsAdmin` sabit/sample kimlik bilgisi içermez: `E2E_ADMIN_EMAIL` /
`E2E_ADMIN_PASSWORD` veya `ADMIN_EMAIL` / `ADMIN_PASSWORD` verilmezse açıkça
başarısız olur. Varsayılan Playwright webServer yalnızca Vite'ı başlatır; API
ayrıca başlatılmalıdır. Üretim veritabanı veya gerçek hesap kullanmayın. GitHub
Actions her iş için rastgele test sırrı ve E2E hesabı üretir.

14 Ekim 2026 denetimindeki **40 test dosyası / 390 Vitest testi** ve **12 Playwright
E2E testi** tarihsel baseline'dır, bu değişikliklerin sonucu değildir. Güncel
sonuç için `npm run verify:all` ve E2E'yi ayrı çalıştırın; rapordaki gerçek
çıkış kodlarını esas alın. Dosya deposu kullanan test verileri geçici dizinlerde tutulur.

### Tasarım sözleşmesi testi

`tests/design-system.test.ts`, bu deponun yerel tasarım sözleşmesini otomatik
olarak denetler. 14.10.2026 tarihli noktasal GitHub blob-hash karşılaştırmasında
`kaaradumaann-psi/psikolog` `main` commit'i
`9ec1d9f393f3470ff8ea0d42372a62d0e3e0c135` ile dokuz ortak CSS katmanının 9/9'u;
MMPI-566 `kaaradumaann-psi/Repo123` `main` commit'i
`4b28579f93d3e76bb54be963f4427fef66782dd1` ile 3/9'u eşleşti. Bu sınırlı
commit/hash karşılaştırması tam depo veya sürekli parity iddiası değildir. Test
GitHub depolarını çağırmadığı için gelecekteki çapraz-depo eşitliğini kanıtlamaz:

1. `src/main.tsx` içindeki yerel stil sırası ve `responsive.css`'in sonda olması
   denetlenir (`screen → auth → dashboard → site → mobile → theme → coherence →
   workspace → kamuilan → responsive`); dış depolarla sıra/uygulama parity'si
   otomatik ölçülmez.
2. Dokuz yerel katman, `tests/fixtures/design-parity.json` içindeki sabit
   SHA-256 tabanıyla eşleştirilir. Bu taban psikolog deposuyla 14.10.2026
   snapshot'ında eşleşiyordu; altı dosyanın Repo123'ten ayrışması bilinmektedir.
3. Arayüzde `src/styles/*.css` içinde tanımlı olmayan sınıf kullanılamaz
   (yazım hatasıyla sessizce biçimsiz kalan öğe kalmaz).
4. Yardımcı (utility) sınıf kullanılamaz: `flex`, `gap-2`, `text-sm`,
   `sm:col-span-2`, `dark:*` kalıpları reddedilir. Her sınıf anlam taşır.

## Nerede ne var

| Dosya                            | Kapsam                                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/classification.test.ts`   | Kural motoru: kabul/ret/inceleme kararları, tür ve gerekçe                                                                                                                                                |
| `tests/extraction.test.ts`       | Türkçe tarih ayrıştırma, kontenjan, il, kurum/unvan, KPSS, şartlar, bağlantılar                                                                                                                           |
| `tests/pdf.test.ts`              | PDF metin katmanı, taranmış PDF, bozuk PDF, kırpma                                                                                                                                                        |
| `tests/file-store.test.ts`       | Dosya deposu: süreçler arası kayıt kaybı yok, bozuk dosya yedeklenir                                                                                                                                      |
| `tests/ingest.test.ts`           | Kayıt, sürümleme, tekilleştirme, inceleme kuyruğu, bildirim olayı, kilit, kaynak hatası                                                                                                                   |
| `tests/email.test.ts`            | Şablon, koşullar (doğrulanmamış/duraklatılmış kullanıcı), idempotency, yeniden deneme, ölü mektup, abonelikten çıkma                                                                                      |
| `tests/email-delivery.test.ts`   | Uçtan uca gönderim: fixture → izole DB → eşleşme → outbox → süreç içi SMTP test sunucusu → teslim kaydı (gerçek sağlayıcı yok)                                                                          |
| `tests/worker.test.ts`           | Zamanlayıcı, kuyruk, kilit, yeniden başlatma sonrası devam, DLQ                                                                                                                                           |
| `tests/server.test.ts`           | API: sağlık, ilan listesi/detayı, kapsam, kimlik akışı (kapalı kayıt + davet), CSRF, RBAC, hız sınırı                                                                                                     |
| `tests/postgres-store.test.ts`   | Supabase/Postgres deposu (PGlite = gerçek Postgres 16): tablo/indeks kurulumu, JSONB ön filtresi ↔ dosya sürücüsü eşdeğerliği, benzersiz indeks çakışması, satır kilidi, zod doğrulaması                  |
| `tests/resend-transport.test.ts` | Resend taşıyıcısı (ağa çıkmaz): istek biçimi, 2xx/4xx yorumu, maskeleme, zaman aşımı, taşıyıcı seçimi, davet şablonu                                                                                      |
| `tests/ui.test.tsx`              | Arayüz kabuğu (jsdom): kabuk çizimi, kamuya açık sayfalar, oturumsuz panelde giriş kartı, **kayıt bağlantısı yok** kontrolü                                                                               |
| `tests/design-system.test.ts`    | **Tasarım sözleşmesi:** katman sırası (`main.tsx`), paylaşılan 9 katmanın SHA-256 eşitliği, tanımsız sınıf yasağı, yardımcı (utility) sınıf yasağı, `responsive.css` en sonda                             |
| `tests/env-loader.test.ts`       | `.env` yükleyici: ayrıştırma, tırnak/yorum/export, ortam önceliği, `.env.<NODE_ENV>` geçersiz kılma, testte yüklememe                                                                                     |
| `tests/sources.test.ts`          | Kaynak adaptörleri ve envanter: kayıt defteri sözleşmesi, her `adapterKey` kayıtlı mı, canlı erişim kapalıyken ağa çıkılmaması, fixture HTML ile alan çıkarımı, bozuk yapıda boş liste, idempotent tarama |
| `e2e/*.spec.ts`                  | Tarayıcı: sayfalar açılıyor mu, filtre URL'de kalıyor mu, kapsam dürüst mü                                                                                                                                |

## Zorunlu senaryo eşlemesi

| #   | Senaryo                                         | Test                                                                                                                                                                         |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Gerçek personel alım ilanı kabul edilir         | `classification` → "personel alım ilanını kabul eder"; `ingest` → "gerçek personel alım ilanını kabul eder ve kaydeder"                                                      |
| 2   | İhale ilanı reddedilir                          | `classification` → "ihale ilanını reddeder"; `ingest` → "ihale ve sonuç duyurularını reddeder"                                                                               |
| 3   | Sonuç duyurusu yeni ilan sayılmaz               | `classification` → "personel alımı SONUÇ duyurusunu yeni ilan saymaz"                                                                                                        |
| 4   | Sınav/giriş ilanı kabul edilir                  | `classification` → "kariyer meslek (uzman yardımcılığı) sınav ilanını kabul eder", "kuruma özgü giriş sınavı ilanını kabul eder"                                             |
| 5   | Türkçe tarihler doğru ayrıştırılır              | `extraction` → "Türkçe tarih aralığını doğru ayrıştırır", "ortak ay/yıl kullanan aralığı çözer"                                                                              |
| 6   | Tarih uydurulmaz                                | `extraction` → "yıl yoksa tarih uydurmaz", "tarih içermeyen metinde tarih üretmez"                                                                                           |
| 7   | PDF metin katmanı okunur                        | `pdf` → "gerçek PDF dosyasından metin katmanını okur"                                                                                                                        |
| 8   | Bozuk PDF çökertmez                             | `pdf` → "bozuk PDF uygulamayı çökertmez", "PDF olmayan içerik ve boş dosya"                                                                                                  |
| 9   | Aynı ilan iki kaynakta tek kayda birleşir       | `ingest` → "aynı ilanı ikinci kaynakta görünce tek ilanda birleştirir ve tüm kaynakları saklar"                                                                              |
| 10  | Benzer başlıklı FARKLI ilan otomatik birleşmez  | `ingest` → "benzer başlıklı FARKLI ilanı otomatik birleştirmez"                                                                                                              |
| 11  | Güncellemede sürüm ve değişiklik kaydı oluşur   | `ingest` → "son başvuru tarihi değişince yeni sürüm ve değişiklik kaydı oluşur"                                                                                              |
| 12  | Aynı bildirim iki kez üretilmez                 | `ingest` → "eşleşen doğrulanmış kullanıcı için tek olay ve tek outbox kaydı üretir"; `email` → "aynı idempotency anahtarıyla ikinci kez kuyruğa girmez"                      |
| 13  | E-posta yeniden denenir                         | `email` → "geçici hatada yeniden denemeye bırakır, sonraki turda gönderir"; "deneme sınırı dolunca ölü mektup olur ve yönetici yeniden kuyruğa alabilir"                     |
| 14  | Filtreye uymayan ilana e-posta yok              | `email-delivery` → "tercihe uymayan ilan için e-posta kuyruklamaz (SMTP çağrısı yapılmaz)"                                                                                   |
| 15  | Abonelikten çıkmış kullanıcıya e-posta yok      | `email-delivery` → "abonelikten çıkan kullanıcıya yeni e-posta gönderilmez"; `ingest` → "duraklatılmış veya abonelikten çıkmış kullanıcıya e-posta üretmez"                  |
| 16  | Doğrulanmamış kullanıcıya e-posta yok           | `server` → "doğrulanmamış kullanıcı bildirim açamaz ve test e-postası gönderemez"; `ingest` → doğrulama kontrolü                                                             |
| 16b | Dışarıdan kayıt kapalı, hesaplar davetle açılır | `server` → "dışarıdan kayıt kapalıdır: /api/auth/register hesap açmaz", "yönetici daveti hesabı açar; kullanıcı tek kullanımlık bağlantıyla kendi parolasını belirler"       |
| 17  | Aynı kaynak eşzamanlı iki kez taranmaz          | `ingest` → "aynı kaynağı eşzamanlı iki kez taramaz (kilit)"; `worker` → "kilitli kaynağı iki worker aynı anda taramaz"                                                       |
| 18  | Worker yeniden başlayınca iş sürer              | `worker` → "worker yeniden başlayınca kalan işi sürdürür (durum veritabanında)"                                                                                              |
| 19  | Kaynak erişilemezse ilanlar korunur             | `worker` → "kaynak erişilemezse ilanlar korunur, kaynak sağlığı işaretlenir"                                                                                                 |
| 20  | API yetki ve izolasyon                          | `server` → "oturum çerezi olmadan korumalı uçlar 401, CSRF olmadan yazan istek 403", "kullanıcı yalnızca kendi bildirim geçmişini görür", "yönetici uçları RBAC ile korunur" |
| 21  | Hız sınırı ve güvenlik başlıkları               | `server` → "kimlik uçlarında sınır aşılırsa 429 ve retry-after döner", "health gerçek ölçümleri döner, güvenlik başlıkları ekli"                                             |
| 22  | Kaynağın HTML yapısı değişince hata raporlanır  | `ingest` → "kaynak yapısı değişince hata kaydeder ve mevcut ilanları SİLMEZ"                                                                                                 |

Ek olarak uçtan uca akış (fixture → izole DB → eşleşme → outbox → süreç içi
SMTP test sunucusu → teslim kaydı) `tests/email-delivery.test.ts` içinde çalışır;
gerçek e-posta sağlayıcısına gönderim yapılmaz.

## Fixture'lar

- `tests/fixtures/announcements.ts` — gerçek ilan yapısına benzetilmiş örnek
  metinler (`provenance: 'sample'` olarak işaretlenir, üretime yazılmaz).
- `fixtures/pdf/` — `npm run fixtures:pdf` ile üretilir; metin katmanı olan ve
  olmayan iki PDF. Üretici kod: `tests/support/pdf-fixtures.ts`. `tests/pdf.test.ts`
  kayıtlı fixture ile üretilen çıktının aynı olduğunu doğrular.
- `fixtures/html/` — yalnız tek kaynak için açık opt-in capture komutunun yerel
  çıktısıdır; `fixtures/html/manifest.json` hash/provenans/scrub beyanını taşır.
  Otomatik redaction kusursuz değildir; insan PII/lisans/ToS incelemeden commit etmeyin.
  `fixtures/live/` tarihsel olarak ayrılmıştır ve manifestli HTML/JSON snapshot
  sözleşmesinin yerine geçmez.

## Canlı doğrulama (`test:live`)

Yalnızca açık yetki ve gerçek ağ erişimi bulunan operatör ortamında çalıştırılır;
`--live`, kaynak seçimi ve tüm istek/page/detail sınırları zorunludur. Dar bir
PowerShell örneği, rapor biçimi ve kapsam açıklaması için
[quality/OFFLINE-VERIFY.md](./quality/OFFLINE-VERIFY.md) bölümüne bakın.
`test:live` üretim DB'sine bağlanmaz/yazmaz; HTTP denemelerini global bütçeyle
sınırlar ve başlık örnekleri yerine hash üretir. Kaynak sağlığı ancak bu canlı
koşumun çıktısı ve tarihiyle kanıtlanabilir; statik envanter canlı kanıt değildir.

## Kapsam dışı (bilinçli)

- Gerçek POSTA GÖNDERİMİ yoktur: uçtan uca akış süreç içi SMTP sunucusuyla, üretim
  yolu (Resend) ise ağ çağrısı enjekte edilerek (sahte uç nokta) doğrulanır. Resend
  anahtarı ve alan adı doğrulaması dağıtım sırasında elle sınanmalıdır.
- Gerçek Supabase bağlantısı testlerde kurulmaz; sürücü PGlite (Postgres 16, WASM)
  üzerinde gerçek SQL ile çalıştırılır.
- Tarayıcı gerektiren kaynaklar (Kariyer Kapısı) CI'da koşmaz; E2E tarayıcısı
  ayrıdır (arayüzü test eder, kaynak taramaz).
- OCR: taranmış PDF'lerde metin çıkarımı YAPILMAZ (bilinçli). Kayıt "metin
  katmanı yok" olarak işaretlenir.
