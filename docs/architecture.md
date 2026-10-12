# Mimari

KamuRadar tek bir Node.js/TypeScript paketidir (npm, tek `package.json`).
Mikroservis yoktur; API, worker ve arayüz aynı kod tabanını paylaşır.
Amaç: kamu personel alım ilanlarını **kaynaklı** biçimde toplamak, sınıflandırmak,
tekilleştirmek, yapılandırılmış alanlara ayırmak ve kullanıcı tercihlerine göre
e-posta ile bildirmek.

## Katmanlar

```
src/
  config/        ortam değişkenleri (zod ile doğrulanır) + kaynak envanteri
  domain/        saf alan mantığı: metin normalleştirme, Türkçe tarih ayrıştırma,
                 iller, tipler (yan etkisi yok, test edilebilir)
  db/            depolama soyutlaması (MongoDB veya dosya), şemalar, indeksler,
                 koleksiyon deposu sınıfları (repos)
  sources/       kaynak adaptörleri + HTTP istemcisi (SSRF koruması, ETag,
                 hız sınırı, yeniden deneme, boyut sınırı) + kayıt defteri
  extraction/    PDF metin çıkarımı ve alan çıkarımı (unvan, kontenjan, tarih,
                 KPSS, bölüm, şartlar...) — her alanın KAYNAĞI işaretlenir
  classification/ deterministik kural motoru (kabul / ret / inceleme)
  ingest/        kabul hattı: sürümleme, tekilleştirme, inceleme kuyruğu,
                 bildirim olayı üretimi, tarama orkestrasyonu
  notifications/ tercih eşleştirme (matcher) + bildirim olayı/outbox üretimi
  email/         SMTP/dosya taşıyıcıları, şablonlar (TR), gönderim servisi
  worker/        kalıcı kuyruk tüketicisi, zamanlayıcı, kurtarma/kilitleme
  server/        Fastify HTTP API (zod şemaları, RBAC, hız sınırı, dokümanlar)
  pages/, components/, lib/, styles/   React arayüzü (Vite + Tailwind)
scripts/         operasyon betikleri (kurulum, bakım, rapor, fixture, dev)
tests/           vitest birim/entegrasyon testleri
e2e/             Playwright tarayıcı testleri
infra/           docker-compose + Dockerfile + MongoDB başlangıç betiği
```

## Uçtan uca akış

1. **Zamanlayıcı** (worker) veritabanındaki `scheduledTasks` kayıtlarını okur ve
   aralığı gelmiş kaynaklar için kuyruğa iş yazar. Zamanlama durumu veritabanında
   olduğu için worker yeniden başlasa da kaldığı yerden devam eder; aynı kaynağın
   iki kez taranmasını kilitleme (lock + TTL) engeller.
2. **Tarama** (`runSourceScrape`): kaynağın adaptörü çalışır, HTTP istemcisi
   ETag/Last-Modified ile değişmemiş sayfayı atlar (`skipped`), hata olursa
   üstel geri çekilme ile yeniden dener.
3. **Sınıflandırma**: kural motoru her kaydı `accept` / `reject` / `review`
   olarak etiketler; karar, tür, gerekçe, eşleşen kurallar ve sürüm kaydedilir.
   Belirsiz kayıtlar SİLİNMEZ, inceleme kuyruğuna gider.
4. **Alan çıkarımı**: başlık ve gövde metninden yapılandırılmış alanlar çıkarılır;
   her alan `listing` / `detail` / `unstated` kaynağıyla işaretlenir, çıkarılamayan
   alan `null` kalır (uydurma yok) ve belirsizlik listesine yazılır.
5. **Tekilleştirme**: resmî ilan no → normalize URL → kurum+unvan+dönem+benzerlik
   sırasıyla denenir. Benzer başlıklı FARKLI ilanlar otomatik birleştirilmez;
   şüpheli durumlar inceleme kuyruğuna düşer. Birleştirmede tüm kaynak bağlantıları
   korunur (tek ilan → çok kaynak).
6. **Değişiklik takibi**: içerik özeti değiştiğinde yeni sürüm + değişen alanlar
   kaydedilir; değişiklik sınıfı (yeni ilan, son tarih, şart, kontenjan, kapanış,
   başvuru bağlantısı, geri çekilme) belirlenir.
7. **Bildirim**: eşleşen kullanıcılar için (kullanıcı, ilan, tür, sürüm) benzersiz
   olay yazılır ve e-posta outbox'a eklenir. Gönderim tarama akışından AYRIDIR.
8. **E-posta**: worker outbox'ı talep eder (lease), şablonu üretir, taşıyıcıya
   verir; sağlayıcı kabulünü kaydeder ("teslim edildi" iddiası kurulmaz), hata
   durumunda üstel geri çekilme ile yeniden dener, sınır dolunca ölü mektup olur
   ve yönetici panelinden yeniden kuyruğa alınabilir.

## Kritik tasarım kararları

- **Uydurma yok**: çıkarılamayan alan `null`'dur ve arayüzde "belirtilmemiş"
  görünür. Sistem istatistikleri yalnızca veritabanındaki gerçek kayıtlardan
  hesaplanır.
- **Doğrulama ≠ adaptör yazımı**: kaynak `verification.verified` yalnızca canlı
  erişim kanıtı varsa `true`; adaptörü yazılmış ama doğrulanmamış kaynaklar
  `verification.built` ile ayrı sayılır.
- **Kaynak envanteri veridedir**: kaynaklar kod değil, `sources` koleksiyonu
  kayıtlarıdır (`src/config/sources.ts` başlangıç envanteri). Yeni kaynak eklemek
  için kod değişikliği şart değildir; adaptör eşleşmesi `adapterKey` ile yapılır.
- **Kalıcı kuyruk**: `setInterval` yoktur. Kuyruk ya MongoDB tabanlı yerleşik
  kuyruk ya da Redis/BullMQ'dur; iş durumu veritabanındadır.
- **Tek paket, güçlü sınırlar**: adaptörler birbirinden bağımsızdır, iş mantığı
  HTTP katmanında değildir, paylaşılan tipler `src/domain` + `src/db/schemas`te
  toplanır.

## Depolama

- **Geliştirme** (öntanımlı): `data/kamuradar.json` dosya deposu. Kurulum
  gerektirmez; atomik yazma (tmp + rename) ve süreçler arası değişiklik algılama
  (dosya zaman damgası) kullanır. API, worker ve betikler bu dosyayı paylaşabilir;
  yine de paylaşımlı kilit yoktur, bu yüzden üretimde MongoDB zorunludur
  (uygulama üretimde dosya deposuyla başlamayı reddeder).
- **Üretim**: MongoDB (`MONGODB_URI`), indeksler `src/db/indexes.ts`ten
  `npm run db:indexes` ile (ve API açılışında) oluşturulur.
- **Kuyruk**: `REDIS_URL` varsa BullMQ, yoksa yerleşik (veritabanı) kuyruk.

## İlgili belgeler

- Veri modeli: [data-model.md](./data-model.md)
- Kaynak envanteri ve kapsam durumu: [sources.md](./sources.md)
- Yeni kaynak ekleme: [source-onboarding.md](./source-onboarding.md)
- Güvenlik ve KVKK: [security-kvkk.md](./security-kvkk.md)
- Kurulum: [setup.md](./setup.md) · Dağıtım: [deployment.md](./deployment.md)
- İşletim: [operations.md](./operations.md) · Testler: [testing.md](./testing.md)
- Dürüst sınırlar: [limitations.md](./limitations.md)
