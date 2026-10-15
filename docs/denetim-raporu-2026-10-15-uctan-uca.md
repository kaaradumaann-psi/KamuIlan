# Kamuİlan uçtan uca denetim raporu — 15 Ekim 2026 (bu tur)

Etiketler: **DOĞRULANDI** · **TEST EDİLDİ (MOCK)** · **KISMEN DOĞRULANDI** ·
**ENGELLENDİ** · **VERİ YETERSİZ** · **DOĞRULANMADI** · **UYGULANAMAZ**.
Önceki turların kanıtı korunur: `docs/denetim-raporu-2026-10-15-devam.md` (PR #15),
`docs/eval-gercek-veri.md`, `docs/limitations.md`. Bu rapor yalnızca bu turda
yeniden ölçülen/doğrulanan durumu yazar; eski sonuçlar yeni gibi sunulmaz.

## 1. Git/PR/CI durumu — DOĞRULANDI

- Başlangıç: `origin/main` = yerel `main` = bu dalın tabanı **`b6592b4`** (PR #16 merge).
  Çalışma ağacı temiz başladı. PR #13–#16'nın MERGED olduğu `gh pr list --state all`
  ile yeniden doğrulandı.
- **PR #3 artık AÇIK DEĞİL: CLOSED (birleştirilmeden), 2026-10-15T10:36:20Z.**
  Önceki raporun "hâlâ açık" bilgisi güncel değil. Kapsam değerlendirmesi §14'te.
- Açık PR yoktu; bu turda **PR #17** açıldı (`arena/dc762ba8-kamuradar` → `main`).
- Bu turun commit'leri: `f1b7143` fix(db) TLS URL reddi · `5ca5a69` fix(classification)
  haber etiketi · `25f8ea2` test(e2e) mobil/erişilebilirlik · `b82a684`, `a6b4774`,
  `a9632d3` test(e2e) CI bulgusu düzeltmeleri · bu rapor.
- CI `verify` (PR #17, `a9632d3`): **pass (1m55s)** — typecheck, lint, `npm test`,
  build, env:check, kapsam raporu ve **Playwright 18/18** dahil. `--no-verify` /
  `--auto` kullanılmadı. İlk iki CI koşumu e2e'de başarısız oldu (aşağıda §12);
  hatalar gizlenmedi, kök nedenleriyle düzeltildi.

## 2. Mimari ve dosya denetimi — KISMEN DOĞRULANDI

Mimari önceki raporlardaki gibidir (tek paket: Fastify API + worker/scheduler +
React/Vite arayüz; `src/{sources,classification,extraction,ingest,notifications,
email,telegram,ai,db,server,worker}`). Bu turda yeniden yazım yapılmadı.

Kod incelemesinde bulunan ve **düzeltilen** iki gerçek kusur §8 ve §5'tedir.
İncelenip bilinçli korunanlar:

- Tüm üretim bağımlılıkları kullanılıyor (dinamik import'lar dahil:
  `@fastify/static`, `pdfjs-dist`, `bullmq`, `tsx` script'lerde). Kaldırılan
  bağımlılık yok. `npm ci` audit: **0 güvenlik açığı**; yalnızca eslint 9 için
  "artık desteklenmiyor" uyarısı var — toplu yükseltme yapılmadı (regresyon riski,
  P3 notu).
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` çalışma
  zamanı kodunda **hiç kullanılmıyor** (yalnızca env şeması + `.env.example`);
  gerçek yol `POSTGRES_URL` üzerinden `pg` havuzudur. Tarayıcı Supabase REST'e
  hiç konuşmaz. Değişkenler, dokümante edilmiş panel/migration amaçlarıyla korundu;
  kaldırılmaları operatör kurulumlarını kırabileceği için bu turda yapılmadı.
- Sessiz hata yutan boş `catch {}` üretim kodunda bulunmadı; demo kayıtları
  `provenance: 'sample'` ile işaretli ve `seed:demo` üretimde `--force` olmadan
  çalışmaz (koddan doğrulandı).
- Günlük özet (digest): şablon/şema var, panelde seçenek **disabled** ve
  "henüz kullanılamıyor" diye gösteriliyor; varmış gibi sunan yüzey yok.

## 3. Bağımlılık ve entegrasyonlar — DOĞRULANDI (kod) / canlı: ENGELLENDİ

Supabase/PostgreSQL (`pg`), Resend/SMTP/dosya e-posta, Telegram, Cloudflare
(`wrangler.jsonc` + `functions/api/[[path]].ts` vekili), LLM (OpenAI-uyumlu,
varsayılan kapalı), BullMQ (yalnızca `REDIS_URL` varsa; yoksa veritabanı kuyruğu)
önceki mimariyle aynı; hiçbiri kaldırılmadı, kaldırma gerekçesi oluşmadı.
Hata davranışları (outbox'ta kalma, sınırlı retry, sağlayıcı yoksa gönderim yok)
önceki turda mock ile test edilmişti; bu turda ilgili testler yeniden yeşil.

## 4. Canlı kaynaklar — ENGELLENDİ (taze kanıt)

- `npm run test:live -- --source=osym-duyurular` bu turda **yeniden koşuldu**:
  `https://www.osym.gov.tr/Duyurular/Index` TLS el sıkışmasında
  `ECONNRESET: Client network socket disconnected before secure TLS connection
  was established` (3 deneme, ~7,8 sn). Sandbox çıkış izinleri yalnızca
  github/npm/pypi olduğundan diğer kaynaklara da ulaşılamaz.
- TLS doğrulaması kapatılmadı, agresif tarama yapılmadı, hiçbir kaynak
  "canlıda doğrulandı" işaretlenmedi. Kaynak başına HTTP/ETag-304/parse/alan
  atıf/çift kayıt durumu: **DOĞRULANMADI** (önceki turla aynı engel).
- Operatör kontrol listesi hazırdır: `docs/eval-gercek-veri.md` §2 ve
  `docs/denetim-raporu-2026-10-15-devam.md` §13.2.

## 5. Sınıflandırma ve LLM — TEST EDİLDİ (MOCK) / gerçek sağlayıcı: ENGELLENDİ

LLM kapısının güvenlik sınırları (yalnızca `review`da çalışma, kanıt birebir
doğrulama, varsayılan kapalı, hata → review'da kalma) kodda ve testlerde aynen
korundu; bu turda LLM hattına dokunulmadı.

**Düzeltilen kusur (P2, etiket doğruluğu):** `news → other` karışıklığı.
Kök neden: kaynağın kendi kategorisi (`Haberler`) içerik türü eşlemesinde hiç
kullanılmıyordu. `contentTypeOf` artık normalize kategoriyi de alır; başlıkta
daha özgül tür (öğrenci/eğitim/etkinlik/rapor) yoksa ve kategori "haber"
diyorsa ret etiketi `news` olur (`5ca5a69`). Bu **yalnızca ret etiketidir**:
kabul/ret kararı, ilan listesi, bildirim ve LLM davranışı değişmez; hiçbir
kayıt bu yolla ilana dönüşmez. Regresyon testleri: `tests/content-type.test.ts`
(+2). Eski birim testteki toptan "Haberler" kategorisi, fixture'daki gerçek
değerle (`other` örneği `Duyurular`) hizalandı — test zayıflatılmadı.

Gerçek sağlayıcı çağrısı: anahtar/ağ yok → **ENGELLENDİ**, sahte sonuç üretilmedi.

## 6. Gerçek veri değerlendirmesi — VERİ YETERSİZ

`npm run eval:classification` (bu tur, düzeltme sonrası): 17 kayıt, gerçek
kaynaklı **0**, insan etiketli **0**; news recall **%50 → %100**, yanlış
kabul/ret **%0**, karışıklık hücresi kalmadı. **Bu sentetik/spec-title
regresyonudur; saha precision/recall iddiası değildir** — çıktıdaki
`VERİ YETERSİZ` uyarısı aynen korunuyor. `expectedFields` olmadığı için alan
çıkarımı doğruluğu yine **ÖLÇÜLEMEDİ**. Hedef (145 kayıt) ve akış
`docs/eval-gercek-veri.md`dedir; engel ağ erişimidir.

## 7. Alan çıkarımı — DOĞRULANDI (kod) / doğruluk: VERİ YETERSİZ

Kanıta dayalı çıkarım (`setField` + alıntı; kanıtsız alan `null`), tarih rolü
ayrımı (`tests/date-roles.test.ts`) ve dedupe davranışları bu turda yeniden
yeşil olan testlerle kilitlidir. Yapısal sınav/kura/sonuç tarihi alanı
(`processEventAt`) önceki turdaki gibi **bilinçli olarak eklenmedi** (P3,
ürün kararı ister): yanlış rol atamasının maliyeti alanın yokluğundan büyüktür.

## 8. Supabase/PostgreSQL — TLS düzeltildi; RLS: UYGULANAMAZ+ENGELLENDİ

**Düzeltilen güvenlik kusuru (P1):** Önceki rapor "URL'de `sslmode`
reddediliyor" diyordu; kodda karşılığı **yoktu**. Canlı kanıt (yerel node +
pg 8.x): `ConnectionParameters`, havuzun açık `ssl` nesnesini
`parse(connectionString)` ile **ezer** — `POSTGRES_URL=...?sslmode=disable`
+ `POSTGRES_SSL_MODE=verify`, TLS'i sessizce kapatıyordu; `sslrootcert` de
`POSTGRES_SSL_CA_FILE`'i eziyordu.
- Artık `postgresUrl()` şu parametreleri içeren URL'yi sır sızdırmayan hatayla
  reddeder: `sslmode, ssl, sslrootcert, sslcert, sslkey, sslnegotiation,
  uselibpqcompat` (fail-closed). `inspectEnvironment` aynı çelişkiyi
  `env:check`'te sorun sayar; böylece üretim başlangıcı da engellenir.
- `.env.example` ("sslmode kazanır" diyordu), `env.ts` ve `postgres-store.ts`
  yorumları gerçek davranışla hizalandı. Eksik
  `LLM_COST_USD_PER_MTOK_INPUT/OUTPUT` `.env.example`'a eklendi.
- Testler: `tests/postgres-tls-config.test.ts` 16 → **19** (URL ezme
  senaryoları + temiz URL geçişi). Bilinen kırılma: URL'sinde `sslmode=`
  taşıyan mevcut kurulum başlangıçta açık hatayla durur; mesaj parametreyi
  kaldırmayı söyler. Sessiz güvenlik düşüşüne bilinçli tercihtir.

**Önceki rapor düzeltmesi:** "Supabase tarafında RLS politikaları kodda
tanımlı" ifadesi **doğru değildir** — depoda RLS/`CREATE POLICY` SQL'i yoktur.
Gerçek durum: tarayıcı Supabase REST/PostgREST'e hiç bağlanmaz; tüm veri
erişimi sunucu tarafı `pg` havuzu + uygulama katmanı oturum/RBAC ile yapılır.
Bu mimaride RLS **UYGULANAMAZ**; ancak Supabase projesinde tabloların
PostgREST'e anon anahtarla açık olup olmadığı operatör tarafında
doğrulanmalıdır — kimlik bilgisi olmadığından **ENGELLENDİ**.

Migrasyon/indeks (`db:migrate`, `db:indexes`) üretimde çalıştırılmadı
(yetki/hedef belirsiz); yerel testler yeşildir. Bağlantı testi ≠ migrasyon
kanıtı ayrımı korunur.

## 9. Bildirimler — TEST EDİLDİ (MOCK) / gerçek teslimat: ENGELLENDİ

Outbox güvenilirliği testleri (yalnızca yeni kabul edilmiş ilan, re-scan'de
çift bildirim yok, sağlayıcı hatasında kayıt pending kalır, sınırlı retry,
geliştirmede varsayılan kapalı) bu turda yeniden yeşil. Gerçek Resend/Telegram
teslimatı: izinli test hesabı/hedefi yok → **ENGELLENDİ**; sayı uydurulmadı.

## 10. Güvenlik ve kişisel veriler — KISMEN DOĞRULANDI

Bu turda düzeltilen tek güvenlik kusuru §8'deki TLS ezmesidir. Yeniden
doğrulananlar: güvenlik başlıkları (CSP `default-src 'self'`, `nosniff`,
`frame-ancestors 'none'`), oturum çerezi `HttpOnly + SameSite=Lax + Secure
(üretim)`, CSRF double-submit (tam yol muafiyeti), SSRF beyaz listesi +
yönlendirme denetimi, loglarda `redact`, `dangerouslySetInnerHTML` yokluğu.
Yük testi / sızma testi yapılmadı (**DOĞRULANMADI** olarak kalır).

## 11. Performans — ölçüldü (yerel, sınırlı)

Ölçüm öncesi/sonrası kod değişikliği **yapılmadı**; yalnızca ölçüm:
kısa gövdeli tek kayıtla 2.000 tekrar — `classify` ~0,10 ms/op,
`extract` ~8,1 ms/op (sandbox CPU'su; üretim iddiası değildir). Çıkarım,
sınıflandırmadan ~80 kat pahalıdır ama kayıt başına mutlak maliyeti
milisaniyeler düzeyindedir; ağ/detay indirme hattın asıl maliyetidir.
Karmaşık paralellik/önbellek eklenmedi (doğruluk > küçük hız kazancı).

## 12. Frontend ve erişilebilirlik — CI'da DOĞRULANDI (bu tur)

Önceki açık madde (mobil/klavye/kontrast hiç koşulamamıştı) kapatıldı:
`e2e/accessibility.spec.ts` (6 test) CI'da yeşil — landmark + erişilebilir
adlar, atlama bağlantısı (odakta görünür → `#main` odağı), Tab ile
etkileşimli öğeye ulaşma, hesaplanan stillerden WCAG kontrastı (başlık ≥3,
ana metin ≥4,5), 390px mobilde yatay taşma yok + mobil menü + filtre formu.
CI yolculuğu dürüstçe: ilk koşum 3, ikinci 2, üçüncü 1 başarısızlık verdi;
kök nedenler (mobilde gizli `Çıkış` düğmesine bağlı giriş kanıtı, render
beklemeden kontrast ölçümü, filtresiz girişte açık panelin düğme adı) tek tek
düzeltildi (`b82a684`, `a6b4774`, `a9632d3`). Son CI: **Playwright 18/18**.
Sınırlar: küçük soluk etiket metinlerinin kontrastı ölçülmedi (axe-core gibi
yeni bağımlılık eklenmedi); yerel koşum Chromium indirilemediği için
**ENGELLENDİ**, kanıt CI'dır.

## 13. Test sonuçları — DOĞRULANDI

| Komut | Sonuç (bu tur) |
|---|---|
| `npm test` | **71 dosya / 788 test yeşil** (783 + 5 yeni) |
| `npm run typecheck` / `lint` | 0 hata |
| `npm run build` | başarılı |
| `npm run env:check` | kullanılabilir (TLS satırı dahil) |
| `npm run eval:classification` | 17 sentetik kayıt; news R %100; **VERİ YETERSİZ** |
| `npm run test:live -- --source=osym-duyurular` | **ENGELLENDİ**: `ECONNRESET` (TLS) |
| `npx playwright install chromium` (yerel) | **ENGELLENDİ**: CDN'e ulaşılamıyor |
| CI `verify` (PR #17) | **pass**; Playwright **18/18** |

## 14. Açık kalan işler

| Öncelik | İş | Durum/gerekçe |
|---|---|---|
| P1 | Canlı kaynak doğrulaması (kaynak başına HTTP/304/parse/atıf) | ENGELLENDİ — ağ izni olan operatör ortamı gerekir |
| P1 | Gerçek etiketli küme (145 kayıt, `expectedFields` dahil) | VERİ YETERSİZ — canlı tarama + insan etiketi gerekir |
| P1 | Gerçek LLM sağlayıcı koşumu (düşük bütçe, fiyat doğrulama) | ENGELLENDİ — anahtar + ağ |
| P1 | Gerçek e-posta/Telegram teslimatı (tek izinli hedef) | ENGELLENDİ — test hesabı/hedefi |
| P2 | Supabase projesinde PostgREST/anon maruziyeti denetimi | ENGELLENDİ — proje erişimi; mimaride RLS UYGULANAMAZ |
| P2 | Üretimde `db:migrate`/`db:indexes` durumu | ENGELLENDİ — yetki/hedef doğrulanmadan çalıştırılmaz |
| P3 | Yapısal sınav/kura/sonuç tarihi alanı | Ürün kararı ister; bu turda eklenmedi |
| P3 | eslint 9 → güncel sürüm | Toplu yükseltme yapılmadı; ayrı küçük PR ister |
| — | PR #3 (Cloudflare vekili + dakikalık tarama + yüzeyler) | **Kapatılmış (birleştirilmeden).** Vekil kısmı `main`'de zaten var (`functions/api/[[path]].ts` + `wrangler.jsonc`); dakikalık tarama parçası bilinçli alınmadı — scheduler tabanı 15 dk ve kaynak başına 60–360 dk aralıklar kaynakları korur, dev'de dakikada bir tarama 24 resmî siteye gereksiz yük olur. Yeniden açılması ürün kararıdır; bu turda dokunulmadı. |

## 15. Üretime hazır olma kararı

| Kontrol | Durum |
|---|---|
| Git/PR/CI durumu doğrulandı | geçti |
| Kaynak envanteri/adaptörler denetlendi | geçti (kod) |
| Canlı kaynak erişimi/parse | **engellendi** |
| Mükerrer kayıt/bildirim kontrolü | geçti (mock testler) |
| Sınıflandırma güvenlik kapıları | geçti |
| Etiketli veri akışı | geçti (araç) / küme: **veri yetersiz** |
| Saha doğruluğu ölçüldü | **veri yetersiz** (iddia üretilmedi) |
| Kanıta dayalı alan çıkarımı | geçti (kod/test) |
| PostgreSQL TLS | geçti (URL ezme kusuru kapatıldı) |
| Migrasyon/indeks (üretim) | **engellendi** |
| RLS | **uygulanamaz** (REST maruziyeti: engellendi) |
| Outbox güvenilirliği | geçti (mock) / gerçek teslimat: **engellendi** |
| API/dış kaynak güvenliği | kısmen (yük/sızma testi yok) |
| Gizli/kişisel veri sızıntısı kontrolü | geçti (kod/test) |
| Performans ölçümü | geçti (yerel sınırlı ölçüm) |
| Mobil/erişilebilirlik | geçti (CI; soluk metin kontrastı hariç) |
| Env/dokümantasyon uyumu | geçti (bu tur düzeltildi) |
| Kullanılmayan bağımlılık/entegrasyon | geçti (kaldırılan yok, gerekçeli) |
| Test/lint/tür/build güncel | geçti |
| CI + PR süreçleri | geçti (PR #17) |

**Karar:** Sistem, bu sandbox'ta kanıtlanabilen her kapıdan geçmektedir ve
bilinen bir P0/P1 kod kusuru kalmamıştır. **Üretime hazır kararı, canlı
ortam kanıtları (kaynak erişimi, gerçek etiketli doğruluk, gerçek teslimat,
üretim veritabanı durumu) olmadan verilemez** — bunlar ağ/kimlik/yetki
engellidir ve yukarıda tek tek işaretlenmiştir. Mock/sentetik başarılar
canlı başarı gibi sunulmamıştır.
