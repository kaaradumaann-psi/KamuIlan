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

## 8) Bu denetimden sonra uygulanan düzeltmeler (faz 4)

Denetimin 3. ve 4. bölümündeki iki kök neden kapatıldı. Değişiklikler kural/seçici
düzeyindedir; **hiçbir eşik değeri oynatılmadı** (insan eliyle doğrulanmış ölçüm kümesi
olmadan eşik değiştirmemek bu belgenin 4. bölümündeki karar).

### 8.1 Sayfa iskeleti artık içerik sayılmıyor

`src/lib/html.ts`:

- `PAGE_CHROME_SELECTORS` genişletildi ve dışa açıldı: çerez/KVKK onay modalları
  (`[role="dialog"]`, `[aria-modal="true"]`, `.modal*`, `cookie|cerez|consent|kvkk|gizlilik`
  sınıf/id desenleri) ve erişilebilirlik araç çubukları (`[role="toolbar"]`,
  `accessibilit*|erisilebilirlik*|a11y*`) artık menü/alt bilgi gibi iskelet sayılıyor.
- `chromeFreeText(html, limit)`: tanılama özetleri iskelet temizlendikten sonra üretiliyor.
- `describePageStructure(html, baseUrl)`: bağlantı sayısı, aynı alan adı sayısı, sık geçen
  yol önekleri (yalnızca ilk yol parçası; sorgu/anahtar sızmaz), script/iframe/form sayısı.
- `readableAnnouncementText(...)` varsayılan olarak iskeleti **kopya üzerinde** temizliyor
  (`{ stripChrome: false }` ile eski davranış korunur). Böylece gövde metni —yani sınıflandırma
  kanıtı— menü/modali içermiyor, ama çağıranın bağlantı taraması bozulmuyor.

Bu, canlı çıktıda görülen şu iki hata sınıfını kapatır:

| Kanıt (2026-10-15) | Eski davranış | Yeni davranış |
| --- | --- | --- |
| icisleri/goc/afad: `Sayfa özeti: "Modal content × … GİZLİLİK VE ÇEREZ POLİTİKASI …"` | Çerez modali sayfa içeriği sanıldı | Modal/modaldaki bağlantılar düşer; özet gerçek liste metnini gösterir |
| iskur ×2: `Sayfa özeti: "Erişilebilirlik Menüsü Ekran Okuyucu …"` | Erişilebilirlik araç çubuğu içerik sanıldı | Araç çubuğu iskelet sayılır; satırlar taranır |
| 58 inceleme kaydı (%45-57) | Menü/modali metni gövde kanıtı oldu | Gövde kanıtı iskeletsiz; dizin sayfaları başlıkta reddediliyor |

### 8.2 `Liste yapısı tanınmadı` hatası artık yol gösteriyor

`src/sources/adapters/anchor-list.ts`:

- Hata mesajı `Sayfa yapısı: N bağlantı (M aynı alan adı), S script, I iframe, F form,
  görünür metin K karakter, sık geçen yollar: /duyurular (12), …` bilgisini taşıyor ve özet
  iskelet temizlendikten sonra alınıyor.
- Sayfada hiç bağlantı yoksa mesaj açıkça `içerik büyük olasılıkla JavaScript ile yükleniyor
  (SOURCE_BROWSER_FALLBACK=1 ve Playwright gerekli)` diyor; bağlantı varsa
  `pathPattern/listContainers seçicileri bu yollara göre güncellenmeli` diyor.
- **Tarayıcı yedeği**: HTTP listesi satır üretmezse (kariyer-kapısı adaptöründeki kanıtlanmış
  yol) liste sayfası başsız Chromium ile çizilip yeniden ayrıştırılıyor. `SOURCE_BROWSER_FALLBACK=0`
  iken hiç çağrılmıyor; çizim de satır üretmezse HTTP davranışı korunuyor; tarayıcı
  başlatılamazsa neden **hata mesajında** da görünüyor (notlar hata fırlatılınca kayboluyordu).

### 8.3 Dizin/yardım sayfası başlıkları reddediliyor

`src/classification/rules.ts` → `TITLE_REJECT_RULES` (kesin ret, güven 0.92):

| Kural | Canlı çıktıda gördüğü başlıklar |
| --- | --- |
| `ret-baslik.sss` | "Sıkça Sorulan Sorular" |
| `ret-baslik.politika-belgesi` | "Bilgi Güvenliği Politikası", "Gizlilik ve Çerez Politikası", "KVKK Politikası" |
| `ret-baslik.etkinlik-konusma` | "SEMPOZYUM VE SERGİLER", "Başkan'ın Konuşmaları", TEKNOFEST/ödül töreni haberleri |
| `ret-baslik.dizin-sayfasi` | "HABERLER & DUYURULAR", "Basın Açıklamaları", "projeler", "İç Kontrol Çalışmaları", "Foto Galeri" |
| `ret-baslik.sayi-istatistik` | "Radar uygulama sayıları", "2026 yılı istatistikleri" |
| `ret-baslik.dil-akademik-sinav` | "e-YDS 2026/10 İngilizce Sınavı Başvuruları", "2026-TUS 2. Dönem Tercih İşlemleri", "2026-ALES/2 Başvuru Kılavuzu" |

Etkinlik/istatistik/dil kuralları başlıkta `alim|istihdam|personel|memur|isci|kadro|sozlesmeli|…`
geçiyorsa devreye girmez; yani "Sergi salonunda görevlendirilecek temizlik personeli alımı"
veya "YDS Şartlı 50 Sözleşmeli Personel Alımı" reddedilmez.

### 8.4 Kopya incelemesi (10 çift, %72-83)

Eşikler **bilerek** değiştirilmedi: `mergeTitleSimilarity 0.86` / `reviewTitleSimilarity 0.70`
(`src/ingest/dedupe.ts`). %72-83 benzerlik, aynı ilanın farklı kurumlardaki kopyasıyla
"aynı kurumun güncellenmiş ilanı"nı ayırt edemediğimiz bölge; otomatik birleştirme gerçek
ilan kaybı riski taşır. Doğru sıra: `npm run eval:build-set` ile insan etiketli küme → sonra
eşik kararı.

### 8.5 Testler ve doğrulama

- Yeni dosyalar: `tests/html-chrome.test.ts` (10), `tests/liste-gurultu-regresyon.test.ts` (8),
  `tests/classification-dizin-gurultusu.test.ts` (24).
- Tüm paket: **932 test / 80 dosya yeşil**, `npm run lint` ve `npm run typecheck` temiz.
- Mevcut regresyon paketleri etkilenmedi: `tests/yanlis-ilan-regresyon.test.ts` (36),
  `tests/non-job-filter.test.ts` (36), `tests/classification.test.ts` (28),
  `tests/report-review-fixes.test.ts` (26), `tests/reclassify-roundtrip.test.ts` (6).

### 8.6 Bu ortamda doğrulanamayanlar — Windows'ta koşulmalı

Geliştirme kabuğunda dış ağ yok; bu yüzden aşağıdakiler **fixture ile** kanıtlandı, canlı
siteyle değil. Kendi makinenizde sırayla:

```bash
npm i -D playwright && npx playwright install chromium   # tarayıcı yedeği için
npm run env:setup -- --check                             # SOURCE_BROWSER_FALLBACK=1 görünüyor mu
npm run test:live                                        # 24 kaynak: erişim + liste yapısı
npm run eval:build-set && npm run eval:classification    # etiketli küme, sonra eşik kararı
```

`test:live` çıktısında beklenen değişim: icisleri/goc/afad özetlerinde çerez modali metni yok;
iskur için ya tarayıcıyla satır bulunur ya da "içerik JavaScript ile yükleniyor" teşhisi;
dsi/epdk/tkgm/tmsf/kgm/saglik için özet yerine bağlantı sayımı + sık geçen yollar (seçiciyi
hangi yola göre güncelleyeceğiniz doğrudan görünür). Panelde 58 "ilgililik" kaydının büyük
bölümü artık inceleme kuyruğuna düşmemeli; düşenler gerçek gövde kanıtı taşır.

### 8.7 Depodaki 58 inceleme kaydı: kural tek başına yetmez, yeniden sınıflandırma şart

Yeni kurallar yalnızca **bundan sonra** sınıflanan kayıtları etkiler; paneldeki kuyruk eski
kural setiyle yazılmış kararlardan oluşur. Aynı başlıklarla eski (`a1e12d6`) ve yeni
(`b4b1f60`) `rules.ts` üzerinde A/B ölçümü yapıldı:

| Başlık | 2026.10.1 | 2026.10.2 |
| --- | --- | --- |
| Sıkça Sorulan Sorular | reject 0.92 (`sayfa-arayuzu`) | reject 0.92 (`sayfa-arayuzu`, `sss`, `dizin-sayfasi`) |
| Bilgi Güvenliği Politikası | reject 0.92 (`sayfa-arayuzu`) | reject 0.92 (+ `politika-belgesi`) |
| Basın Açıklamaları | reject 0.92 (`basin-konferans-rapor`) | reject 0.92 (+ `dizin-sayfasi`) |
| Başkan'ın Konuşmaları | reject 0.80 (kural kimliği yok) | reject 0.92 (`etkinlik-konusma`) |
| HABERLER & DUYURULAR | reject 0.80 (kural kimliği yok) | reject 0.92 (`dizin-sayfasi`) |
| İç Kontrol Çalışmaları | reject 0.80 (kural kimliği yok) | reject 0.92 (`dizin-sayfasi`) |
| Radar uygulama sayıları | reject 0.80 (kural kimliği yok) | reject 0.92 (`sayi-istatistik`) |
| e-YDS 2026/10 … Başvuruları | reject 0.80 (kural kimliği yok) | reject 0.92 (`dil-akademik-sinav`) |
| 2026-TUS 2. Dönem Tercih | reject 0.92 (`ogrenci-kabul-tercih`) | reject 0.92 (+ `dil-akademik-sinav`) |

Sonuç: bu başlıklar **yalnızca başlıkla** sınıflandığında zaten reddediliyordu. Panelde
%45-57 güvenle bekleyen 58 kayıt ya eski sürümle yazılmış ya da gövdesi iskelet metniyle
şişmiş kayıtlardır; yani düzeltmenin depoya işlemesi için yeniden sınıflandırma gerekir.
`reclassifyJob` politikası bunu destekler: açık ret sinyali (başlık/gövde ret kuralı ya da
alım kanıtı yokluğu) `review` kararını `reject`'e çevirir ve kayıt akıştan çıkar (silinmez).

```bash
npm run jobs:reclassify                      # KURU ÇALIŞTIRMA: özet, hiçbir şey yazmaz
npm run jobs:reclassify -- --report reclassify.json   # kayıt bazlı rapor (yazmaz)
npm run jobs:reclassify -- --apply           # önce tam yedek alır, sonra yazar
npm run jobs:restore -- <yedek-dosyası>      # geri dönüş
```

Not: zaten `reject` olan kayıtlarda gerekçe/kural/sürüm alanları yenilendiği için `--apply`
yazma yoğun bir işlemdir; yedek otomatik alınır ama kuru çalıştırma özetini görmeden
uygulamayın.

### 8.8 Sürüm damgaları

`src/config/app.ts` kuralı: "kural değişince artırılır".

| Sabit | Değer | Neden |
| --- | --- | --- |
| `CLASSIFICATION_VERSION` | `2026.10.1` → **`2026.10.2`** | 6 yeni başlık ret kuralı |
| `EXTRACTION_VERSION` | `2026.10.1` → **`2026.10.2`** | Gövde metni iskeletten arındırılarak çıkarılıyor |
| `DEDUPE_VERSION` | `2026.10.1` (değişmedi) | Tekilleştirme algoritması/eşikleri değişmedi |
| `APP_VERSION` | `2026.10.1` (değişmedi) | Uygulama sürümü ayrı tutulur |

`/api/health` çıktısındaki `versions.classification` ve `versions.extraction` değerleri
`2026.10.2` görünmüyorsa yeni kod çalışmıyordur (panel ekran görüntüsünde bu iki alan
dağıtımın gerçekten yüklendiğini doğrulamak için kullanılabilir).

### 8.9 Yeniden kontrolde bulunan ve düzeltilen ek kusur

Faz 4'ün ilk halinde tarayıcı ön-kontrolü liste sayfasını **iki kez** ayrıştırıyordu
(ön-kontrol + döngünün 1. sayfası) ve tarayıcı sabitları import bloğunun ortasında
duruyordu. İkisi de giderildi: ön-kontrolün ayrıştırma sonucu döngüde yeniden kullanılıyor
(tarayıcı çizimi başarılıysa çizimin ayrıştırması kullanılıyor), sabitlar importların
altında. `liveFetch=false` iken adaptör ağa çıkmadığı için tarayıcı yedeği de çağrılmıyor
(doğrulama modu korunur). Ek dosya/başvuru bağlantıları bu değişiklikten etkilenmez:
`readDetail` bağlantıları **temizlenmemiş** DOM'dan toplar, iskelet temizliği yalnızca metin
çıkarımının kopyasında yapılır.

## 9) 2026-10-16 canlı panel dökümü — bulgular, kök nedenler, düzeltmeler

Beş ekran dökümü (Yönetim → İncelenecek ilanlar, Genel bakış, Kaynaklar, Tarama
geçmişi/Hata bildirimleri, Panelim + ana sayfa) satır satır değerlendirildi.
Aşağıdaki tabloda her bulgu, kök nedeni ve uygulanan düzeltme birlikte verilir;
"operatör" satırları kod değişikliğiyle çözülemeyen, makinede yapılması gereken
adımlardır.

### 9.1 "Yapay zekâ çok etkin değil" — kök neden yapılandırmaydı

Panel verisi: `gemini-2.5-flash`, istem `kamuilan-sinif-v1`, günlük sınır 50;
son 24 saatte **2 çağrı, 0 önbellek isabeti, 2 hata, %100 hata oranı, 0 token,
p50 324 ms**. İnceleme kartlarında "model denetimine ulaşılamadı / Sağlayıcı
HTTP 404 döndü".

0 token + ~320 ms + %100 hata üçlüsü modelin "zayıf" olduğunu değil, isteğin
**hiçbir modele ulaşmadığını** gösterir. İstemci `${LLM_BASE_URL}/chat/completions`
çağırır; Google'ın yerel kökü (`…/v1beta`) bu yolu bilmez, OpenAI uyumlu uç
`…/v1beta/openai/chat/completions` adresindedir. Sonuç: kapı her kayıtta hata
döner, kararlar kurallarda kalır, inceleme kuyruğu insana yığılır.

Uygulanan düzeltmeler:

| # | Düzeltme | Dosya |
| --- | --- | --- |
| 1 | **(GÜNCELLENDİ — bkz. §9.7)** Google kökü birincil `generateContent` API'sine yönlendirilir: `POST {kök}/models/{model}:generateContent` + `x-goog-api-key`. OpenAI uyumluluk kabuğu (`…/v1beta/openai/chat/completions`) her anahtar/bölge/model için çalışmıyor ve canlıda 404 döndü | `src/ai/llm.ts` → `resolveLlmEndpoint()`, `buildGeminiRequestBody()`, `parseGeminiResponse()` |
| 2 | Sağlayıcı hata gerekçesi artık **hangi uca hangi modelle** gidildiğini ve ilk denenecek adımı yazar (404/401/403/400/429/413 ayrı ayrı); API anahtarı asla yazılmaz | `src/ai/llm.ts` → `statusHint()` |
| 3 | Uç/model uyuşmazlığı (OpenAI ucuna Gemini, Google ucuna GPT) `env:check` çıktısında uyarı olarak görünür — engelleyici değil, yanlış pozitif olabilir | `src/config/env.ts`, `describeLlmEndpointRisk()` |
| 4 | Yeni tanı komutu: tek gerçek çağrı yapar, ucu/modeli/anahtarı (yalnızca uzunluğu)/kotaları/maliyet ayarını ve canlı çağrı sonucunu raporlar; hata durumunda sıralı kontrol listesi basar | `scripts/llm-doctor.ts` → `npm run llm:doctor` (`--offline`, `--json`) |
| 5 | `.env.example` ve karar belgesine sağlayıcı bazında kök adres örnekleri + 404 tanı tablosu | `.env.example`, `docs/llm-karari.md` §7 |

Kilitlenen davranış: `tests/llm-uc-nokta.test.ts` (13 test) — uç kurulumu,
uyuşmazlık uyarısı, 404/401/429 gerekçeleri, istek gövdesi, anahtar sızıntısı yok.

### 9.2 Tarama bulguları (10 kaynak üst üste başarısız, 292 başarısız koşum)

| Bulgu (döküm) | Kök neden | Düzeltme |
| --- | --- | --- |
| `resmigazete`: "zaman aşımına uğradı (60000 ms)", 21 ardışık başarısızlık; canlı koşumda tek nüsha **560 s** | Adaptörlerin TOPLAM süre sınırı yoktu: pipeline `SCRAPE_TIMEOUT_MS` dolunca koşumu çöpe atıyor, PDF indirmeleri ucu açık sürüyordu | `src/sources/scan-budget.ts` (bütçe/iptal yardımcıları), `AdapterContext.deadlineAt`, `pipeline.ts` marjı, `resmigazete.ts` PDF bütçesi (`PDF_TIMEOUT_MS=25 s`, `MIN_PDF_BUDGET_MS=8 s`, gün/sayfa/satır döngülerinde bütçe kontrolü, kısmi kapsam) |
| `bddk` + diğerleri: 60 s tavanı yavaş resmî siteler için düşüktü | Varsayılan bütçe | `SCRAPE_TIMEOUT_MS` varsayılanı **60 000 → 120 000** ms (şema + katalog + `.env.example` birlikte; katalog sınırı şemayla aynı: 5 000–300 000) |
| `epdk` (436 `/Detay` bağlantısı görünür, 0 satır), `dsi`, `kgm`, `saglik-bakanligi-personel`, `iskur`, `yok`: "Liste yapısı tanınmadı" | Satırlar beklenen kapsayıcının (`main`, `#content` …) DIŞINDAYSA aday listesi boş kalıyordu | `anchor-list.ts`: kapsayıcıda eşleşme yoksa **belge geneline düşer** (`rootFallbackUsed` → "tüm belge tarandı" notu) |
| `iskur`: "Ana Sayfa İlanlar Kamu Memur Alım İlanları" kuyruğa ilan diye düşüyordu; menü/kategori bağlantıları satır sayılıyordu | Dizin/kategori yolları (`/haberler`, `/basin-aciklamalari-yeni`, `/`) detay bağlantısıyla aynı kalıba uyuyordu | `isCategoryIndexPath()`: rakam içermeyen, kök/tek segmentli ve tüm parçaları dizin sözcüğüyle başlayan yollar adaylıktan çıkar (gerçek ilan adresleri korunur — 8 canlı adres biçimiyle test edildi) |
| Hata metni operatöre yol göstermiyordu ("Liste yapısı tanınmadı" + sayı dökümü) | Ayrıştırma teşhisi ve tarayıcı sonucu metinde yoktu | Yapı hatası artık şunu taşır: kapsayıcı seçici, **desen eşleşmesi kapsamda X / belgede Y**, 3 yönlü ipucu ve `Tarayıcı yedeği: <sonuç>` (kapalı / denenmedi / çizim N satır / çizim de satır üretmedi / boş sayfa / kullanılamadı: …) |
| `afad`, `goc`, `icisleri`, `spk`, `meb`, `osym`: "kısmi" — detay bütçesi yetmedi | Bütçe bitince koşum sert zaman aşımıyla **tamamen** düşüyordu | `anchor-list.ts` detay döngüsü bütçe bitince yeni indirme başlatmaz; satır **liste bilgisiyle kaydedilir** ve kapsam `partial` işaretlenir (detay metni sonraki taramada tamamlanır) |
| `tmsf`: tarayıcıda `ERR_CERT_AUTHORITY_INVALID` | Kurum kökü makinede güvenilmiyor; Chromium, TLS doğrulaması kapalı olsa bile sertifikayı denetler | Kod tarafı: AIA zincir tamamlama (`SOURCE_TLS_AIA_COMPLETION=1`). Operatör: kurum kökünü `NODE_EXTRA_CA_CERTS=./certs/kurum-koku.pem` ile ekle |
| `kariyerkapisi`, `ilan-gov-tr-personel`: "İlk sayfadan satır okunamadığı için kaynak kapsamı bilinmiyor" | Not, sunucunun ne döndürdüğünü ve sonraki adımı söylemiyordu | Not artık HTTP durumlarını, karakter sayısını, tarayıcı çizimi kullanılıp kullanılmadığını ve `npm run test:live -- --source=<anahtar>` komutunu içerir |
| Kuyrukta **2998 bekleyen** iş | Zamanlanmış işler birikir (worker kapalı/yavaş); biriken işlerin tek tek koşulması aynı kaynağı saatlerce döver ve paneli "tıkanmış" gösterir | `BuiltinQueueRepo.collapseSupersededPending()`: aynı kaynağın bekleyen zamanlanmış taramalarından yalnızca EN YENİSİ korunur, eskiler gerekçesi iş yüküne yazılarak kapatılır; worker her tikte en çok 200 iş katlar. **Elle tetiklenen işler asla kapatılmaz** (`tests/worker.test.ts` → 3 yeni test) |

### 9.3 İnceleme kuyruğu gürültüsü (60 ilgililik + 12 tekilleştirme)

Kuyruktaki kayıtların büyük kısmı kurum sitelerinin menü/dizin/etkinlik
sayfalarıydı: İçişleri SSS-politika-basın-radar sayıları-atama kararnamesi-iç
kontrol, TKGM `/haberler` + projeler ("Güncel" öneki başlığa yapışmış,
"…DuyuruDuyuru07 Eylül 2026"), SPK basın duyuruları + başkanın konuşmaları,
DSİ SEMPOZYUM + İngilizce teknik şartname, KGM rayiç fiyat/restorasyon
açılışları/GICC/Japonya heyeti, TÜBİTAK Teknofest + araştırma çağrıları,
ÖSYM e-YDS + TUS tercih, İŞKUR kırıntı başlığı.

- Başlık kuralları: mevcut ret kurallarına `ret-baslik.kurumsal-etkinlik`
  eklendi (rayiç fiyat/fiyat listesi, açılış, temel atma, heyet, ziyaret,
  protokol imza töreni, iş birliği protokolü, yarışma, festival, fuar, turnuva,
  kutlama, bayram/yeni yıl mesajı, taziye). Alım/istihdam/personel/memur/işçi/
  kadro/sözleşmeli/kura/atama/giriş sınavı/temin/başvuru/yeterlik geçen
  başlıklar kurala **takılmaz** (3 yanlış pozitif koruma testi eklendi).
- `CLASSIFICATION_VERSION` → **2026.10.4** (kural seti değişti; depodaki
  kararlar ancak yeniden sınıflandırmayla güncellenir).
- Başlık temizliği (`cleanTitle`): satıra yapışan rozet/tarih
  ("…Alım İlanıDuyuru28 Eylül 2026"), baştaki yapışık rozet ("Güncel3 Boyutlu…"),
  "Ana Sayfa " kırıntısı, "İlân No: ILN01234567" etiketi, tekrarlanan kelime
  ("DuyuruDuyuru") ve sonda yapışık Türkçe tarih düşürülür — 11 gerçek panel
  dizesi üzerinde doğrulandı, gerçek başlıklar bozulmuyor.

**Önemli:** depodaki 72 inceleme kaydı kendiliğinden temizlenmez. Operatör adımı:

```bash
npm run jobs:reclassify            # kuru çalıştırma: ne değişecek görünür
npm run jobs:reclassify -- --report data/reclassify.json
npm run jobs:reclassify -- --apply # otomatik yedek alır
# geri almak gerekirse: npm run jobs:restore -- <yedek-dosyası>
```

### 9.4 Panel doğruluk hataları

| Bulgu | Kök neden | Düzeltme |
| --- | --- | --- |
| Genel bakış: 17 worker satırından yalnızca 1'i "bayat"; **42–47 saat önce durmuş süreçler yeşil "çalışıyor"** | Rozet yalnızca `stale` alanına bakıyordu; `stale` bilinçli kapanışlarda (`status='stopped'`) yanlış alarm üretmemek için `false` kalır | `describeWorkerState()` ile **üç durum**: `bayat` (sessiz kalan) / `çalışıyor` / `durdu` (+ `başlıyor`, `duruyor`, bilinmeyen durum açıkça yazılır). Satırlar en yeni kalp atışına göre sıralanır, 6'dan fazlası "Ayrıca N eski worker kaydı var" diye özetlenir (`src/lib/format.ts`, `src/pages/Admin.tsx`, `tests/worker-durum-etiketi.test.ts`, `tests/admin-render.test.tsx`) |
| Ana sayfa bilgi bandı kalıcı sarı | Uyarı tonu "N kaynağa ulaşılamıyor" ile de tetikleniyordu; bazı kurum siteleri her koşulda erişilemez | Ton yalnızca kullanıcının gördüğü sonucu etkileyen durumlarda uyarı: sistem kapalı, veriler bir günden eski, worker yok/başlıyor. Erişilemeyen kaynak sayısı cümlenin içinde **sonucuyla** açıklanır ("o kurumlara ait yeni ilanlar listeye gecikmeli düşebilir") |

### 9.5 Bu turun test paketi

- `tests/liste-gurultu-regresyon.test.ts` — 22 test (kapsam dışı liste/düşme,
  kategori filtresi, tarayıcı sonucu metni, zaman bütçesi, `cleanTitle`)
- `tests/llm-uc-nokta.test.ts` — 13 test
- `tests/worker.test.ts` — 22 test (3 yeni: kuyruk katlama)
- `tests/worker-durum-etiketi.test.ts` — 7 test
- `tests/classification-dizin-gurultusu.test.ts` + `tests/siniflandirma-unvan-temin.test.ts` — 85 test
- Önceki turlar: TLS zincir tamamlama (16), `db-tls-doctor` (27), `dev-all`
  kapanışı (7), sınıflandırma kanıt kapısı.

### 9.6 Operatör adımları (kod değişikliğiyle çözülemeyenler)

```bat
:: 1) TLS doğrulamasını kapatan geçici çözümü kaldır (yeni bir kabuk aç)
setx NODE_TLS_REJECT_UNAUTHORIZED ""

:: 2) .env'de veritabanı TLS kararı "verify" olsun (no-verify KALMAMALI)
::    POSTGRES_SSL_MODE=verify
::    db-tls-doctor "missing-provider-root" diyorsa Supabase kökünü indir:
::    certs/supabase-ca.crt + POSTGRES_SSL_CA_FILE=./certs/supabase-ca.crt
npm run db:tls-doctor
npm run env:check

:: 3) Tarayıcı yedeği için Chromium (PowerShell npm.ps1'i engelliyorsa cmd kullan)
npx playwright install chromium

:: 4) LLM kapısını doğrula, sonra kuyruğu erittir
npm run llm:doctor
npm run llm:review-assist
npm run jobs:reclassify -- --apply

:: 5) Worker'ı kesintisiz çalıştır (birikmiş kuyruk otomatik katlanır)
npm run dev:worker

:: 6) Kaynakları canlı doğrula (kaynak başına bütçe artık 120 s)
npm run test:live
```

Terminal Türkçe karakterleri bozuyorsa: `chcp 65001`. PowerShell betikleri
engelliyorsa: `cmd` içinde `npm.cmd …` ya da
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

---

## 9.7 Gemini bağlantı hatasının kök nedeni ve kalıcı düzeltmesi (2026-10-16, ikinci tur)

### Kanıt (operatörün kendi makinesinde, aynı API anahtarıyla)

| İstek | Sonuç |
| --- | --- |
| `GET /v1beta/models` | 200 |
| `GET /v1beta/openai/models` | 200 — `models/gemini-2.5-flash` listede VAR |
| `POST /v1beta/openai/chat/completions` | **HTTP 404** |
| `npm run llm:doctor` | **HTTP 404** (paneldeki %100 hata · 0 token'ın kaynağı) |

**Kök neden:** anahtar ve model geçerli; hata **uçta**. Google'ın
`/v1beta/openai/…` katmanı birincil API değil, kısmî bir OpenAI uyumluluk
kabuğudur; her anahtar/bölge/model kombinasyonu için `chat/completions`
sunmaz. "Model listede görünüyor" sohbet ucunun çalıştığını kanıtlamaz: liste
ucu ile sohbet ucu farklı yönlendiricilerdir. Eski istemci Google kökünü
otomatik olarak bu kabuğa çeviriyordu (§9.1 satır 1'in ilk hâli), dolayısıyla
kapı her kayıtta 404 aldı.

**Neden panelde sadece "Sağlayıcı HTTP 404 döndü" yazıyordu:** istemci 2xx
olmayan yanıtların gövdesini okumuyordu. Google 404'te açıklayıcı bir JSON
hata gövdesi döndürür (`error.message`); bu bilgi atılıyordu. Doktor da
"liste çalışıyor ama sohbet 404 ⇒ sorun uçta" çıkarımını otomatik yapmıyordu.

### Düzeltme

| # | Ne | Nerede |
| --- | --- | --- |
| 1 | İki taşıyıcılı uç çözümü: Google kökü → `POST {kök}/models/{model}:generateContent` + `x-goog-api-key`; diğer kökler → `{kök}/chat/completions` + `Authorization: Bearer` (bayt düzeyinde aynı eski davranış) | `src/ai/llm.ts` → `resolveLlmEndpoint()`, `googleApiVersionPath()`, `isGoogleAiHost()` |
| 2 | Sistem mesajı `systemInstruction.parts[]`, roller `user`/`model`, ardışık aynı rol birleştirilir, `generationConfig.{temperature,maxOutputTokens}`, JSON modu `responseMimeType: application/json` | `src/ai/llm.ts` → `buildGeminiRequestBody()` |
| 3 | Yanıt eşlemesi: `candidates[0].content.parts[].text` birleştirilir; token'lar `usageMetadata.promptTokenCount` / `candidatesTokenCount` (yoksa `totalTokenCount`); boş yanıta `finishReason`/`finishMessage`/`promptFeedback.blockReason` gerekçesi yazılır | `src/ai/llm.ts` → `parseGeminiResponse()` |
| 4 | **Sağlayıcı mesajı artık gerekçeye taşınır** (iki taşıyıcıda da): `error.message` ayıklanır, anahtar metinden çıkarılır, 240 karakterle sınırlanır; durum koduna göre ipucu eklenir (401/403 anahtar-yetki, 404 uç-model, 429 kota, 5xx sağlayıcı) | `src/ai/llm.ts` → `providerErrorMessage()`, `statusHint()` |
| 5 | Yeniden deneme politikası değişmedi: 429/5xx/zaman aşımı geçici, 400/401/403/404 kalıcı → kota tüketmez | `callChatCompletion()` |
| 6 | Doktor taşıyıcıyı, tam istek adresini, istenen model kimliğini ve anahtar başlığını yazar; `--compat`/`--native` ile taşıyıcı zorlanır; başarısız çağrıda **model listesi denetimi** yapar ("listedeyse sorun uçta", listede değilse benzer model önerir) ve karşı taşıyıcı komutunu verir | `scripts/llm-doctor.ts` → `probeModelList()`, `DoctorReport.modelList` |
| 7 | Ortam uyarıları: Google kökünde `google/` önekli model "Gemini yerel API bu öneki kabul etmez"; Google olmayan kökte `gemini-…` modeli "kök/uyumlu biçim gerekli" | `src/ai/llm.ts` → `describeLlmEndpointRisk()` |

Değişmeyenler: `LlmResult` sözleşmesi, `classifier.ts`/`suggest.ts`/panel,
önbellek-telemetri-kota katmanı, Supabase bağlantısı, diğer sağlayıcıların
davranışı. **Yeni bağımlılık yok** (yalnızca yerleşik `fetch`). Anahtar hiçbir
yeni yerde loglanmaz; URL'ye yazılmaz.

### Testler ve doğrulama durumu

`tests/llm-gemini.test.ts` (40 test): uç çözümü (`/openai` kökü, yapıştırılmış
`:generateContent` ucu, sürüm yolları v1/v1alpha/v1internal), model
normalizasyonu, gövde dönüşümü (sistem/kullanıcı/asistan, boş sistem,
önbelleksiz tek mesaj, `maxOutputTokens` yokken anahtarın çıkmaması), yanıt
ayrıştırma (çok parça, boş aday, `blockReason`, `MAX_TOKENS`, `SAFETY`,
bozuk JSON), başarı + token aktarımı, 400/401/403/404/429/503 sınıflandırması
ve gerekçe metinleri, anahtar sızmama denetimi (gerekçe/telemetri/URL), zaman
aşımı, ağ hatası, JSON modu, gerçek soketli Google biçimli taklit sunucu (hem
yerel hem kabuk ucu) ve **kuyruk uçtan uca denetimi**: 404'te kayıt `review`da
kalır + `llmAnalyses.status='error'` + `summary().errors=1`; başarıda `review →
accept(kind:'job')` + `contentType='personnel_recruitment'` + token'lar; 429
yeniden denenir, 404 denenmez.

Doğrulanamayan tek adım: **gerçek `generativelanguage.googleapis.com` çağrısı.**
Denetim ortamının genel internet erişimi yok (yalnızca github/npm/pypi
açık) ve `/etc/hosts` salt okunur olduğu için Google ana makine adı
yerelleştirilemedi. Bu yüzden canlı uçtan uca doğrulama operatörde:

```bat
npm run llm:doctor              :: yerel generateContent taşıyıcısı
npm run llm:doctor -- --compat  :: aynı 404'ü eski kabukla karşılaştırın
```

Beklenen: `Taşıyıcı: gemini-native`, `İstek ucu:
https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
`✓ Canlı çağrı başarılı: HTTP 200 … (N girdi / M çıktı token)`. İstek/yanıt
alan adları Google'ın birincil API biçimine göredir; resmî belgeye bu
ortamdan erişilemediği için alan adları canlı çağrıyla teyit edilmelidir
(doktor, beklenmeyen bir gövdede sağlayıcının kendi mesajını yazar).
