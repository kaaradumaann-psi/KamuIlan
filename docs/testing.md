# Testler

## Komutlar

```bash
npm test             # birim + entegrasyon (vitest, ağ erişimi YOK)
npm run test:watch   # geliştirme sırasında izleme
npm run test:coverage
npm run test:e2e     # Playwright (tarayıcı kurulu olmalı)
npm run test:e2e:local  # yalnızca duman testleri (kurulumu hızlı doğrular)
SOURCE_LIVE_FETCH=1 npm run test:live   # gerçek kaynaklara canlı doğrulama
```

Testler ağ erişimi kullanmaz: sahte adaptör/fetcher, fixture HTML/PDF ve süreç
içi SMTP sunucusu kullanılır. Bu sayede CI'da ve çevrimdışı ortamda kararlı koşarlar.

## Nerede ne var

| Dosya | Kapsam |
| --- | --- |
| `tests/classification.test.ts` | Kural motoru: kabul/ret/inceleme kararları, tür ve gerekçe |
| `tests/extraction.test.ts` | Türkçe tarih ayrıştırma, kontenjan, il, kurum/unvan, KPSS, şartlar, bağlantılar |
| `tests/pdf.test.ts` | PDF metin katmanı, taranmış PDF, bozuk PDF, kırpma |
| `tests/file-store.test.ts` | Dosya deposu: süreçler arası kayıt kaybı yok, bozuk dosya yedeklenir |
| `tests/ingest.test.ts` | Kayıt, sürümleme, tekilleştirme, inceleme kuyruğu, bildirim olayı, kilit, kaynak hatası |
| `tests/email.test.ts` | Şablon, koşullar (doğrulanmamış/duraklatılmış kullanıcı), idempotency, yeniden deneme, ölü mektup, abonelikten çıkma |
| `tests/email-delivery.test.ts` | Uçtan uca gönderim: fixture → DB → eşleşme → outbox → gerçek SMTP → teslim kaydı |
| `tests/worker.test.ts` | Zamanlayıcı, kuyruk, kilit, yeniden başlatma sonrası devam, DLQ |
| `tests/server.test.ts` | API: sağlık, ilan listesi/detayı, kapsam, kimlik akışı, CSRF, RBAC, hız sınırı |
| `e2e/*.spec.ts` | Tarayıcı: sayfalar açılıyor mu, filtre URL'de kalıyor mu, kapsam dürüst mü |

## Zorunlu senaryo eşlemesi

| # | Senaryo | Test |
| --- | --- | --- |
| 1 | Gerçek personel alım ilanı kabul edilir | `classification` → "personel alım ilanını kabul eder"; `ingest` → "gerçek personel alım ilanını kabul eder ve kaydeder" |
| 2 | İhale ilanı reddedilir | `classification` → "ihale ilanını reddeder"; `ingest` → "ihale ve sonuç duyurularını reddeder" |
| 3 | Sonuç duyurusu yeni ilan sayılmaz | `classification` → "personel alımı SONUÇ duyurusunu yeni ilan saymaz" |
| 4 | Sınav/giriş ilanı kabul edilir | `classification` → "kariyer meslek (uzman yardımcılığı) sınav ilanını kabul eder", "kuruma özgü giriş sınavı ilanını kabul eder" |
| 5 | Türkçe tarihler doğru ayrıştırılır | `extraction` → "Türkçe tarih aralığını doğru ayrıştırır", "ortak ay/yıl kullanan aralığı çözer" |
| 6 | Tarih uydurulmaz | `extraction` → "yıl yoksa tarih uydurmaz", "tarih içermeyen metinde tarih üretmez" |
| 7 | PDF metin katmanı okunur | `pdf` → "gerçek PDF dosyasından metin katmanını okur" |
| 8 | Bozuk PDF çökertmez | `pdf` → "bozuk PDF uygulamayı çökertmez", "PDF olmayan içerik ve boş dosya" |
| 9 | Aynı ilan iki kaynakta tek kayda birleşir | `ingest` → "aynı ilanı ikinci kaynakta görünce tek ilanda birleştirir ve tüm kaynakları saklar" |
| 10 | Benzer başlıklı FARKLI ilan otomatik birleşmez | `ingest` → "benzer başlıklı FARKLI ilanı otomatik birleştirmez" |
| 11 | Güncellemede sürüm ve değişiklik kaydı oluşur | `ingest` → "son başvuru tarihi değişince yeni sürüm ve değişiklik kaydı oluşur" |
| 12 | Aynı bildirim iki kez üretilmez | `ingest` → "eşleşen doğrulanmış kullanıcı için tek olay ve tek outbox kaydı üretir"; `email` → "aynı idempotency anahtarıyla ikinci kez kuyruğa girmez" |
| 13 | E-posta yeniden denenir | `email` → "geçici hatada yeniden denemeye bırakır, sonraki turda gönderir"; "deneme sınırı dolunca ölü mektup olur ve yönetici yeniden kuyruğa alabilir" |
| 14 | Filtreye uymayan ilana e-posta yok | `email-delivery` → "tercihe uymayan ilan için e-posta kuyruklamaz (SMTP çağrısı yapılmaz)" |
| 15 | Abonelikten çıkmış kullanıcıya e-posta yok | `email-delivery` → "abonelikten çıkan kullanıcıya yeni e-posta gönderilmez"; `ingest` → "duraklatılmış veya abonelikten çıkmış kullanıcıya e-posta üretmez" |
| 16 | Doğrulanmamış kullanıcıya e-posta yok | `server` → "doğrulanmamış kullanıcı bildirim açamaz ve test e-postası gönderemez"; `ingest` → doğrulama kontrolü |
| 17 | Aynı kaynak eşzamanlı iki kez taranmaz | `ingest` → "aynı kaynağı eşzamanlı iki kez taramaz (kilit)"; `worker` → "kilitli kaynağı iki worker aynı anda taramaz" |
| 18 | Worker yeniden başlayınca iş sürer | `worker` → "worker yeniden başlayınca kalan işi sürdürür (durum veritabanında)" |
| 19 | Kaynak erişilemezse ilanlar korunur | `worker` → "kaynak erişilemezse ilanlar korunur, kaynak sağlığı işaretlenir" |
| 20 | API yetki ve izolasyon | `server` → "oturum çerezi olmadan korumalı uçlar 401, CSRF olmadan yazan istek 403", "kullanıcı yalnızca kendi bildirim geçmişini görür", "yönetici uçları RBAC ile korunur" |
| 21 | Hız sınırı ve güvenlik başlıkları | `server` → "kimlik uçlarında sınır aşılırsa 429 ve retry-after döner", "health gerçek ölçümleri döner, güvenlik başlıkları ekli" |
| 22 | Kaynağın HTML yapısı değişince hata raporlanır | `ingest` → "kaynak yapısı değişince hata kaydeder ve mevcut ilanları SİLMEZ" |

Ek olarak uçtan uca akış (fixture → DB → eşleşme → outbox → test posta sunucusu →
teslim kaydı) `tests/email-delivery.test.ts` içinde **gerçek SMTP turu** ile koşar.

## Fixture'lar

- `tests/fixtures/announcements.ts` — gerçek ilan yapısına benzetilmiş örnek
  metinler (`provenance: 'sample'` olarak işaretlenir, üretime yazılmaz).
- `fixtures/pdf/` — `npm run fixtures:pdf` ile üretilir; metin katmanı olan ve
  olmayan iki PDF. Üretici kod: `tests/support/pdf-fixtures.ts`. `tests/pdf.test.ts`
  kayıtlı fixture ile üretilen çıktının aynı olduğunu doğrular.
- `fixtures/html/` ve `fixtures/live/` — canlı yakalamalar için ayrılmıştır;
  `SOURCE_LIVE_FETCH=1 npm run fixtures:capture` ile doldurulur (`.gitignore`'da
  `fixtures/live/` hariç tutulur).

## Canlı doğrulama (`test:live`)

Yalnızca gerçek ağ erişimi olan ortamda çalıştırılır:

```bash
SOURCE_LIVE_FETCH=1 npm run test:live                 # tüm doğrulanmış kaynaklar
SOURCE_LIVE_FETCH=1 npm run test:live -- --source=osym-duyurular --dry-run
```

Kuru çalıştırma veritabanına YAZMAZ. Bu betik, kaynakta o an ne olduğunu (kaç
kayıt, hangi başlıklar, tarih var mı) raporlar; doğrulama kanıtı bu çıktıdan
`src/config/sources.ts` içine yazılır.

## Kapsam dışı (bilinçli)

- Gerçek POSTA GÖNDERİMİ (üretim SMTP hesabı) testlerde yoktur; süreç içi SMTP
  sunucusu kullanılır. Üretim SMTP'si dağıtım sırasında elle doğrulanmalıdır.
- Tarayıcı gerektiren kaynaklar (Kariyer Kapısı) CI'da koşmaz; E2E tarayıcısı
  ayrıdır (arayüzü test eder, kaynak taramaz).
- OCR: taranmış PDF'lerde metin çıkarımı YAPILMAZ (bilinçli). Kayıt "metin
  katmanı yok" olarak işaretlenir.
