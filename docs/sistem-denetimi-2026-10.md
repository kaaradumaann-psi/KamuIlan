# Sistem denetimi — 2026-10-15 çıktılarının satır satır incelemesi

Bu belge, geliştirici makinesinde (Windows, Node v24.21.0, `C:\Users\Halil\Desktop\kamuradar-main`)
2026-10-15 tarihinde alınan çıktılara dayanır: `npm run test:live`,
`npm run env:check`, `npm run eval:classification` (`--llm` dahil), `npm test`
ve üç yönetim paneli sayfası dökümü. Her bulgu **kanıtıyla** birlikte yazıldı;
bu dalda kodla düzeltilenler ve operatör kararı gerektirenler ayrıldı.

> **Önce şu:** o günkü tüm çıktılar `NODE_TLS_REJECT_UNAUTHORIZED=0` etkinken
> alındı. Bu anahtar TLS doğrulamasını tüm süreçte kapattığı için
> `test:live`'ın "12/24 kaynak erişilebilir" sonucu ve worker taramalarının
> bir kısmı **doğrulama açısından geçersizdir**: başarılı görünen bağlantı,
> sertifikanın denetlenmediği bir bağlantıdır. Anahtarı kaldırma adımları:
> [database-tls.md → kaldırma](./database-tls.md#node_tls_reject_unauthorized0-zaten-tanımlıysa-kaldırma).

## 0) Özet: ne yapıldı, ne yapılacak

| # | Bulgu | Durum |
| --- | --- | --- |
| 1 | `NODE_TLS_REJECT_UNAUTHORIZED=0` ile çalışılıyordu; sonuçlar güvenilmez | **Kodda bekçi eklendi**: `describeEnv` → `tlsVerification: KAPALI`, üretimde başlangıç engeli, `test:live`/`db:tls-doctor` ilk satırında uyarı + kaldırma adımları, sihirbazda riskli alan |
| 2 | `env:check` çıktısı `dbTls: no-verify` + MITM uyarısı | **Kodda**: sihirbaz `no-verify`'yi `!` öneki olmadan yazmaz; `.env`'de `verify`'e döndürme yolu belgelendi. Operatör: `.env`'i düzeltmeli |
| 3 | Worker geçmişinde `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (bddk, tmsf, ilan.gov.tr) + Node'un `--use-system-ca` önerisi | **Kodda gerçek çözüm**: eksik ara sertifika AIA'dan indirilip doğrulanarak zincire ekleniyor (`SOURCE_TLS_AIA_COMPLETION=1`), doğrulama açık kalıyor |
| 4 | `npm test` içinde `spawnSync npx ENOENT` (Windows) | **Kodda düzeltildi**: betikler `process.execPath` + tsx CLI ile çalıştırılıyor (`tests/helpers/run-tsx.ts`) |
| 5 | `tests/sources.test.ts` Resmî Gazete testi makineye göre değişiyordu (1 yerine 5 kayıt) | **Kodda düzeltildi**: `SOURCE_BROWSER_FALLBACK=0` testlerde zorunlu; Chromium gerçek ağa çıkamıyor |
| 6 | `.env` doldurma işi elle yapılıyordu, eksikler görünmüyordu | **Kodda**: `npm run env:setup` — 83 alanlık katalog, soru-cevap, güvenli yazım, yazımdan sonra gerçek denetim |
| 7 | Kaynak adaptörlerinde bozuk seçici/örüntü (İŞKUR, Sağlık, KGM, DSI, EPDK, TKGM, TMSF, İçişleri/Göç/AFAD) | **Operatör/kod işi**: bölüm 3'te kaynak kaynak listelendi |
| 8 | İnceleme kuyruğunda ilgisiz sayfalar (~%49 güven) ve 10 olası çift | **Ölçüm önce**: bölüm 4. Etiket kümesi olmadan eşik değiştirmek yasak (projenin kendi kuralı) |
| 9 | Kuyrukta 2991 bekleyen iş, 275 başarısız tarama, bayat heartbeat'ler, 1 ölü e-posta işi | **Operasyon**: bölüm 5 |
| 10 | `eval:classification` ölçüm vermedi (17 kayıt, 0 insan doğrulamalı) | **Doğru davranış**; çözüm `npm run eval:build-set` (bölüm 4) |

## 1) Ortam yapılandırması (`npm run env:check` çıktısı)

Çıktıdaki satırlar ve karşılıkları:

| Çıktı | Değerlendirme |
| --- | --- |
| `environment: development` | Doğru; üretim denetimi için `NODE_ENV=production npm run env:check` ayrıca koşulmalı |
| `baseUrl: https://pdas-corporations-south-desert.trycloudflare.com` | Cloudflare hızlı tünel adresi: her açılışta DEĞİŞİR. E-posta bağlantıları ve Telegram webhook bu adrese üretilir; kalıcı bir alan adı (`APP_BASE_URL`) kullanılmadan bildirimler bir sonraki tünelde ölür |
| `database: supabase/postgres` | Beklenen |
| `dbTls: no-verify` + MITM uyarısı | **Düzeltilmeli.** Geliştirmede uyarı, üretimde engel. `POSTGRES_SSL_MODE=verify` + gerekiyorsa `POSTGRES_SSL_CA_FILE` / `POSTGRES_SSL_CA_MERGE_SYSTEM=1`. Komut: `npm run env:setup -- --only POSTGRES_SSL_MODE,POSTGRES_SSL_CA_FILE,POSTGRES_SSL_CA_MERGE_SYSTEM` |
| `redis: yok` | Sorun değil: yerleşik Postgres kuyruğu kullanılıyor (panel "queue postgres" diyor) |
| `email: resend` | Sağlayıcı tanımlı; kabul edilen 1 / ölü 1 iş için bölüm 5 |
| `liveFetch: true`, `scheduler: true` | Geliştirmede canlı tarama açık: gerçek sitelere istek atılır. Bilinçli olmalı |
| `rateLimit: 120/60s` | Varsayılan; dışa açılımda düşürülmeli |
| `appSecretSet: true` | Tamam; uzunluk görünmez (maskeli), `env:setup -- --only APP_SECRET` ile doğrulanabilir |
| `telegram: @KamuIlanBildirim_BOT` | Kullanıcı adı var; üretimde `TELEGRAM_WEBHOOK_SECRET` zorunlu (denetim zaten bakar) |
| `aiAssistant: açık (gemini-2.5-flash)`, `llmClassifier: açık (günlük sınır 50)` | Anahtarlar tanımlı. Günlük sınır 50, panel "24 saatte 0 çağrı" diyor → sınıflandırıcı hiç çalışmamış (bölüm 5'teki kuyruk/heartbeat bulgusuyla tutarlı) |
| `✔ Ortam yapılandırması kullanılabilir.` | **Yanıltıcı değil ama eksik okunmamalı:** geliştirme kipinde `no-verify` yalnızca uyarıdır, bu yüzden ✔ görünür. `NODE_TLS_REJECT_UNAUTHORIZED=0` o gün süreçte tanımlıydı ve `env:check` bunu RAPORLAMIYORDU — artık raporluyor (`tlsVerification: KAPALI` satırı + uyarı bloğu) |

`LLM_COST_USD_PER_MTOK_INPUT/OUTPUT` boş olduğu için panel maliyeti
"bildirilmedi" gösteriyor. Doldurmak için:
`npm run env:setup -- --group llm`.

## 2) TLS / sertifika bulguları ve gerçek çözüm

Worker tarama geçmişindeki tekrarlayan hata:

```
UNABLE_TO_VERIFY_LEAF_SIGNATURE ... try running Node.js with --use-system-ca
kaynaklar: bddk-duyurular, tmsf-duyurular, ilan-gov-tr-personel
```

Teşhis: bu siteler TLS el sıkışmasında **ara sertifikayı göndermiyor**. Node'un
`--use-system-ca` önerisi burada yetmez, çünkü Windows sistem deposu
`getCACertificates('system')` üzerinden **yalnızca kökleri** verir; eksik olan
halka ara sertifikadır. Tarayıcılar bu halkayı sertifikanın AIA ("CA Issuers")
adresinden indirir — Node bunu yapmaz. Kullanıcıyı
`NODE_TLS_REJECT_UNAUTHORIZED=0`'a iten boşluk tam olarak burasıydı.

Bu dalda yapılan (doğrulama AÇIK kalarak):

1. `src/lib/tls-chain-completion.ts` — sunucunun sunduğu zincir okunur, eksik
   halka AIA adresinden indirilir ve **dört koşulla** kabul edilir: zincirin son
   halkasını gerçekten imzalamış olmalı, `basicConstraints CA:TRUE` olmalı,
   süresi geçerli olmalı, zincir **zaten güvenilen** bir köke bağlanmalı.
   Bağlanmazsa hiçbir halka eklenmez ve istek reddedilir. İndirme SSRF
   korumalıdır (http/https, kamuya açık IP, ≤2 yönlendirme, 1 MiB, ≤4 indirme).
2. `src/sources/fetcher.ts` — tamamlama başarılıysa o host için ek halkaları
   içeren ayrı bir undici ajanı kurulur ve istek **doğrulama açıkken** yeniden
   denenir (yeniden deneme bütçesini tüketmez). Host başına bir kez denenir.
   Anahtar: `SOURCE_TLS_AIA_COMPLETION` (varsayılan 1).
3. `src/lib/tls-trust.ts` — `NODE_TLS_REJECT_UNAUTHORIZED=0` bekçisi: uyarı
   metni + platforma özel kaldırma adımları; `describeTlsTrust()` bu durumda
   depo bilgisi yerine uyarıyı döndürür (`test:live` ve `db:tls-doctor` ilk
   satırı).
4. `src/config/env.ts` — üretimde **engel**, diğer ortamlarda yüksek sesli uyarı;
   `describeEnv()` → `tlsVerification` satırı (`env:check`, `env:setup`, worker
   başlangıcı, `/health`).
5. Kanıt: `tests/tls-chain-completion.test.ts` (openssl ile gerçek kök → ara →
   yaprak zinciri; alakasız/CA-olmayan/süresi-geçmiş sertifika REDDEDİLİYOR),
   `tests/tls-verification-guard.test.ts`.

Veritabanı tarafı için aynı ilke zaten bu dalda kuruluydu:
`POSTGRES_SSL_CA_FILE` + `POSTGRES_SSL_CA_MERGE_SYSTEM=1`, bağlantı dizesinde
TLS parametresi yasağı ve `npm run db:tls-doctor` (parola göndermeden zinciri
okur, kök nedeni ve yapılacakları yazar).

## 3) Kaynak sağlığı (`npm run test:live` + panel kapsam raporu)

Canlı denetim: **24 kaynaktan 12'si erişilebilir, 42 ilan**; rapor
`data/live-check-2026-10-15.json`. Panel: 28 kaynak tanımı, 24 etkin,
15 doğrulanmış, **14 ardışık başarısız**, 4 planlanmış; grup dağılımı
kurum 19 / çekirdek 7 / toplayıcı 1 / manuel 1.

| Kaynak | Kanıt | Kök neden | Öneri |
| --- | --- | --- | --- |
| `resmigazete-cestili` | ✓ 5 ilan, **126 sn**, `UND_ERR_HEADERS_TIMEOUT` yeniden denemeleri; worker'da "tarama zaman aşımına uğradı (60000 ms)" | Sunucu tarayıcı-dışı istemciyi yavaşlatıyor; bölüm sayfalama + PDF metin çıkarma bütçeyi aşıyor | `SCRAPE_TIMEOUT_MS` ve kaynak zaman aşımını Resmî Gazete için artırın (ör. 180000) ya da sayfa sayısını sınırlayın; tarayıcı yedeği zaten var (`SOURCE_BROWSER_FALLBACK=1`) |
| `bddk` | ✓ 5 ilan ama **66 sn**, detay URL başına 3× `ENOTFOUND bddk.org.tr` | DNS çözümlemesi kararsız (detay isteklerinde tekrar tekrar çözülüyor) | Host başına çözümü önbelleğe al/`keep-alive` süresini uzat; başarısız detaylar için kısmi kapsam notu zaten üretiliyor |
| `ilan-gov-tr-personel` | ✓ erişilebilir ama **0 ilan** | Liste seçicisi boş dönüyor (yapı değişmiş) ya da bağlantı örüntüsü uyuşmuyor | Adaptör seçicisini güncel sayfayla karşılaştırın; `npm run sources:report` kapsam notunu okuyun |
| `kariyerkapisi-isealim` | ✓ erişilebilir ama **0 ilan** | Aynı sınıf sorun: liste/örüntü uyuşmazlığı | Adaptör güncellemesi |
| `ilan-gov-tr-api-personel` | ✖ **HTTP 403** | API bot isteğini reddediyor (belgelenmiş durum) | Kaynağı devre dışı bırakın ya da resmî API erişim talebi açın; 403'ü yeniden denemek siteyi yorar |
| `iskur-kamu-memur-alim`, `iskur-kurumdisi-kamu-isci` | ✖ "beklenen bağlantı kalıbı `/\/ilan/i` bulunamadı"; özet = erişilebilirlik araç çubuğu metni | Sayfa iskeleti/erişilebilirlik katmanı okunuyor; gerçek liste JS ile geliyor ya da bağlantı kalıbı değişti | Bağlantı örüntüsünü güncel adrese göre düzeltin; içerik JS ile geliyorsa tarayıcı yedeğini bu kaynağa açın |
| `icisleri`, `goc-idaresi`, `afad` | ✖ özet = çerez onay modalı ("GİZLİLİK VE ÇEREZ POLİTİKASI") | Çerez rıza katmanı içerik yerine okunuyor | Seçiciyi içerik kabına daraltın; rıza metnini `readableText` öncesinde çıkarın (ör. `#cerez`, `.cookie`, `dialog` düğümleri) |
| `saglik-bakanligi-personel`, `kgm-duyurular` | ✖ özet **boş** | Seçici hiç eşleşmiyor (sayfa yenilenmiş) | Adaptör seçicisini yenileyin; boş özet "erişilemedi" değil "okunamadı" olarak işaretlenmeli |
| `dsi`, `epdk`, `tkgm`, `tmsf` | ✖ özet = yalnızca gezinme menüsü | Liste seçicisi menüyü yakalıyor | Liste kabını daraltın; `kurum-duyuru-listesi` adaptörünün menü eleme kurallarını bu kurumlar için genişletin |

Ortak not: `✖` görünen kaynakların bir kısmı o gün TLS hatası da üretiyordu
(bddk/tmsf/ilan-gov-tr). Bölüm 2'deki AIA tamamlaması ve
`NODE_TLS_REJECT_UNAUTHORIZED=0`'ın kaldırılmasından sonra `npm run test:live`
**yeniden** koşulmalı; liste ancak o zaman gerçeği gösterir.

Kapsam boşluğu listesi (panel, 15 kaynak): afad, bddk, dsi, epdk, goc, kgm,
resmigazete-cestili, saglik, tmsf, tkgm, ilan-gov-tr, ilan-gov-tr-api,
icisleri, iskur ×2 — yukarıdaki tabloyla birebir örtüşüyor.

## 4) Sınıflandırma kalitesi ve ölçüm (panel + `eval:classification`)

Panel: **68 açık inceleme** (58 alaka, 10 olası çift, 0 okunamayan), 279 denetim
olayları. İnceleme kuyruğunda iş ilanı olmayan sayfalar ~%49 güvenle görünüyor:
İçişleri "Sıkça Sorulan Sorular", TKGM proje sayfaları, KGM
`DuyuruDetay.aspx?Parameter=` haberleri, SPK "Başkan'ın Konuşmaları",
DSİ "SEMPOZYUM VE SERGİLER", ÖSYM e-YDS/TUS tercih duyuruları. Olası çiftler
%72–83 başlık benzerliğinde.

Okuma: bu bir **kabul hatası değil**. Motor kanıt kapısı çalıştırıyor;
başlıkta personel alımı ifadesi yoksa ya reddediyor ya da `review` bandına
(0.45–0.53 güven) alıyor — yani listeye girmiyor, insana soruluyor.
`src/ingest/dedupe.ts` eşikleri: birleştirme 0.86 (başlık) / 0.72 (metin),
inceleme 0.70. %72–83 benzerlik bu yüzden "olası çift" olarak incelemede.

Yapılması gereken sıra (projenin kendi kuralı: **ölçmeden eşik değiştirme**):

```bash
npm run eval:build-set        # gerçek kayıtlardan etiketleme sayfası üretir
# data/eval/worksheet-*.json dosyasını doldurun (expectedContentType + labeledBy + labeledAt)
npm run eval:build-set -- --import            # kuru çalıştırma: ne alınacak gösterir
npm run eval:build-set -- --import --apply    # kümeye yazar
npm run eval:classification                   # precision/recall (artık ölçülebilir)
npm run eval:classification -- --llm          # LLM kapısıyla karşılaştırma (gerçek çağrı)
```

O günkü `eval:classification` çıktısı tam olarak bunu söyledi: **17 kayıt,
hepsi sentetik (`spec-title`), 0 insan doğrulamalı gerçek kayıt** → betik
precision/recall raporlamayı REDDETTİ, `--llm` modunda 0 çağrı yaptı, alan
çıkarımı "ÖLÇÜLEMEDİ". Bu bir hata değil, ölçüm dürüstlüğüdür
(`docs/eval-gercek-veri.md`).

Etiket kümesi hazır olduktan sonra değerlendirilecek ayarlar (kanıtla):

- `REVIEW_THRESHOLD` / `ACCEPT_THRESHOLD` (`src/classification/engine.ts`):
  58 alaka incelemesinin kaçı gerçekten iş ilanıyla ilgisiz? Ölçüldükten sonra
  ya dışlama örüntüleri (`PROCESS_TITLE_EXCLUDE_PATTERN`,
  `INTERNAL_PROMOTION_EXCLUDE_PATTERN`) genişletilir ya da bant daraltılır.
  Aday dışlamalar (panel kanıtı): "sıkça sorulan sorular", "sempozyum",
  "sergi", "başkanın konuşmaları", "duyuru detay".
- `reviewTitleSimilarity` (0.70): 10 olası çiftin kaçı yanlış alarm? Ölçüm
  sonrası 0.75–0.80'e çekmek kuyruğu sessizce azaltır (birleştirme eşiği 0.86
  değişmeden).
- LLM kapısı: `kamuilan-sinif-v1` istemi, 24 saatte **0 çağrı**, günlük sınır 50.
  Sınıflandırıcı hiç çalışmamış; kuyruk birikmesi ve bayat heartbeat ile tutarlı.
  `LLM_COST_USD_PER_MTOK_*` boş olduğu için maliyet panelde "bildirilmedi".

## 5) Çalışma zamanı ve operasyon bulguları (panel)

| Göstergesi | Değer | Yorum / eylem |
| --- | --- | --- |
| Tarama kayıtları | 454, **275 başarısız**, ortalama 16 dk | Başarısızlık oranı ~%60. Ana nedenler: TLS (bölüm 2), bozuk seçiciler (bölüm 3), Resmî Gazete zaman aşımı. Düzeltmelerden sonra `npm run test:live` + 24 saatlik worker gözlemi ile yeniden ölçülmeli |
| Worker heartbeat | 14 kayıt; 13–38 saat bayat, biri 2 dk | Worker **sürekli çalışmıyor** (elle başlatılıp kapatılmış). Kuyruk birikmesinin ve "24 saatte 0 LLM çağrısı"nın ana nedeni bu. `npm run dev` ya da kalıcı süreç (Windows: görev zamanlayıcı / `npm run start:worker`) ile kesintisiz çalıştırın |
| Kuyruk (postgres) | bekleyen **2991**, etkin 1, ölü 0 | Biriken işler tarama görevleri. Worker sürekli çalıştığında erir; erimezse `SCAN_INTERVAL_MINUTES`/kaynak aralıkları gözden geçirilmeli. Bekleyen işlerin yaşı panelde görünmeli (bayat işler iptal edilebilir) |
| E-posta kuyruğu | bekleyen 0, kabul 1, başarısız 0, **ölü 1** | Bir e-posta işi yeniden denemeleri tüketti. Ölü işin yükünü inceleyin (Resend anahtarı/doğrulanmış alan adı/`EMAIL_FROM`); `APP_BASE_URL` tünel adresiyse bağlantılar geçersizdir |
| Denetim olayları | 279 | Beklenen; inceleme kararlarının kim tarafından verildiğini gösterir |
| Kaynaklar | 28 tanım, 24 etkin, 15 doğrulanmış, **14 ardışık başarısız**, 4 planlanmış | Ardışık başarısız 14 kaynak bölüm 3'teki listeyle örtüşüyor; onarılamayanlar devre dışı bırakılmalı ki kapsama oranı gerçeği göstersin |
| LLM kapısı | istem `kamuilan-sinif-v1`, 24 saatte 0 çağrı, maliyet bildirilmedi | Worker çalışmıyor + `LLM_COST_USD_PER_MTOK_*` boş. `npm run env:setup -- --group llm` |

## 6) Test paketi

O günkü `npm test` sonucu (kullanıcı makinesi): **2 başarısız | 799 başarılı |
4 atlanan (805) / 73 dosya**. İkisi de bu dalda düzeltildi:

1. `tests/eval-build-set.test.ts` → `spawnSync npx ENOENT`.
   Neden: Windows'ta `npx` bir `.cmd` sarmalayıcısıdır; Node güvenlik nedeniyle
   `.cmd`/`.bat` dosyalarını `shell: true` olmadan çalıştırmaz.
   Çözüm: `tests/helpers/run-tsx.ts` — betikler `process.execPath` +
   `node_modules/tsx/dist/cli.mjs` ile başlatılır (üç platformda aynı davranış).
   `tests/env-setup.test.ts` de aynı yardımcüyü kullanır.
2. `tests/sources.test.ts` → "bugünün nüshası çekilemezse dünküne düşer"
   beklenen 1, gelen 5.
   Neden: test sahte HTTP istemcisinde `UND_ERR_HEADERS_TIMEOUT` üretiyor ve
   adaptör tarayıcı yedeğine düşüyordu; Playwright kurulu makinelerde Chromium
   **gerçek siteyi** okuyordu (5 kayıt), kurulu olmayanlarda hata olduğu gibi
   kalıyordu (1 kayıt). Yani test makineye göre değişiyordu ve gerçek ağa
   çıkıyordu.
   Çözüm: `SOURCE_BROWSER_FALLBACK` anahtarı eklendi; `tests/setup.ts` bunu
   testlerde `0` yapar, `launchChromium` kapalıyken açıklayıcı bir hatayla
   reddeder (tarayıcı katmanının kendi testleri Playwright'ı mock'lar ve
   anahtarı bilinçli olarak açar).

Bu daldaki durum: **888 test / 77 dosya yeşil**, `npx eslint .` temiz,
`npx tsc --noEmit` temiz. Yeni testler: `tests/env-setup.test.ts` (34),
`tests/tls-chain-completion.test.ts` (16), `tests/tls-verification-guard.test.ts` (5),
`tests/db-tls-doctor.test.ts` (27), `tests/browser-session.test.ts` (+2).

Not: `prettier --check` repoda bu değişikliklerden ÖNCE de 93 dosyada
başarısızdı (biçimlendirme borcu); bu dalda biçimlendirme değişikliği yapılmadı.

## 7) Operatör için sıralı eylem listesi

```bash
# 1) Doğrulamayı kapatan anahtarı kaldır (Windows)
setx NODE_TLS_REJECT_UNAUTHORIZED ""        # yeni bir kabuk aç
node -e "console.log(process.env.NODE_TLS_REJECT_UNAUTHORIZED)"   # undefined

# 2) .env'i sihirbazla düzelt: TLS kararı + eksik anahtarlar
npm run env:setup                            # sorulara cevap ver, dosyaya yazsın
npm run env:setup -- --check                 # tüm ayarların maskeli raporu
npm run db:tls-doctor                        # veritabanı zinciri: kök neden + yapılacaklar

# 3) Bakım ve canlı doğrulama
npm run db:migrate
npm run test:live                            # ilk satır TLS durumunu söyler
npm test

# 4) Worker'ı kesintisiz çalıştır (kuyruk birikmesini ve bayat heartbeat'i bitirir)
npm run dev                                  # ya da: npm run start:worker

# 5) Ölçüm kümesini kur, sonra eşikleri tartış
npm run eval:build-set
npm run eval:classification
npm run eval:classification -- --llm

# 6) Maliyet raporu için LLM anahtarlarını doldur
npm run env:setup -- --group llm
```

Beklenen durum: `env:check` çıktısında `dbTls: verify`, `tlsVerification: açık`;
`test:live` ilk satırında uyarı YOK; bddk/tmsf/ilan.gov.tr için ya başarılı
tarama ya da "eksik zincir AIA ile tamamlanamadı" şeklinde **dürüst** bir ret
(sertifika tarafı doğrulanmış olur); `npm test` iki platform hatası olmadan yeşil.
