# Denetim Seti — Giriş Noktası

**Proje:** Kamuİlan · **Tarih:** 21 Ekim 2026 · **Dal:** `arena/244c8afc-kamuradar`
**Temel commit:** `4fd9acbb376316cf9e4a53bfd420cc8f385b46dc` (+ bu dalın düzeltmeleri)
**PR:** [#25](https://github.com/kaaradumaann-psi/kamuradar/pull/25)

Bu klasör, sistemin **kanıta dayalı** denetimini içerir. Amaç: "çalışıyor gibi görünüyor"
ile "kanıtlandı" arasındaki farkı yazıya dökmek. Hiçbir satır tahminle yazılmadı.

---

## 1. Nasıl okunur (5 dakikalık yol)

1. **[08-release-readiness.md](08-release-readiness.md)** — tek paragrafta hüküm ve yayın kapıları.
2. **[03-risk-register.md](03-risk-register.md)** — 17 risk, öncelik sırasıyla.
3. **[07-verification-results.md](07-verification-results.md)** — ne çalıştırıldı, ne çalıştırılamadı.
4. **[06-remediation-plan.md](06-remediation-plan.md)** — ne yapıldı, ne karar bekliyor.
5. **[05-kadronerede-benchmark.md](05-kadronerede-benchmark.md)** — pazar karşılaştırması.

Derinleşmek için 01, 02, 09–12.

---

## 2. Belgeler ve içerikleri

| # | Belge | Ne anlatır | Kime yarar |
| --- | --- | --- | --- |
| 01 | [Mimari](01-current-architecture.md) | Yığın, katmanlar, uçtan uca akış, kimlik/CSRF/SSRF özeti, yerel ölçümler, **bilinmeyenler tablosu** | Geliştirici, mimar |
| 02 | [Mevcut yetenekler](02-existing-capabilities.md) | Kanıtlı özellik envanteri + **açıkça olmayanlar** listesi | Ürün, geliştirici |
| 03 | [Risk kaydı](03-risk-register.md) | R-01…R-17: kanıt, etki, kök neden, kapanış ölçütü | Yönetici, geliştirici |
| 04 | [Test temeli](04-test-baseline.md) | Çalıştırılan/çalıştırılamayan kontroller, kapsam tablosu, test kalitesi notları | Test, CI |
| 05 | [KadroNerede karşılaştırması](05-kadronerede-benchmark.md) | 14 satırlık özellik tablosu: kanıt · bizim durum · etki · karmaşıklık · öneri · doğrulama testi | Ürün |
| 06 | [İyileştirme planı](06-remediation-plan.md) | YAPILDI / KARAR / AÇIK / ENGELLİ; her maddede 7 alan | Yönetici |
| 07 | [Doğrulama sonuçları](07-verification-results.md) | 13 otomatik kontrol, önce/sonra kanıt tablosu, ortam bilgisi | Herkes |
| 08 | [Yayına hazırlık](08-release-readiness.md) | 11 boyut, yayın kapıları, geri alma, sonraki 3 adım | Yönetici |
| 09 | [REA değerlendirmesi](09-rea-degerlendirmesi.md) | `rea-agents` 6.7.0 gerçek çalıştırma kanıtı; ne yapar / ne yapamaz | Araç değerlendirmesi |
| 10 | [Veri doğruluğu ve kaynak envanteri](10-veri-dogrulugu-ve-kaynak-envanteri.md) | 28 kaynağın güven katmanı, sınıflandırma ayrımları, tarih/durum kuralları, tekilleştirme, **ölçülmeyen kesinlik** | Veri kalitesi |
| 11 | [LLM + güvenlik + KVKK](11-llm-guvenlik-kvkk.md) | Bütçe/timeout/retry/kanıt doğrulama, prompt injection, güvenlik tablosu, KVKK yükümlülükleri, **açık riskler** | Güvenlik, hukuk |
| 12 | [Kod kalitesi ve performans](12-kod-kalitesi-performans.md) | Ölçülen metrikler, paket boyutu, sunucu tarafı riskler, ölçülmeyenler | Geliştirici |

### Kanıt düzeyleri (tüm belgelerde kullanılır)

| Etiket | Anlamı |
| --- | --- |
| **[1]** | Doğrudan kanıtlandı — kod okundu, komut çalıştırıldı, sayfa gözlendi |
| **[2]** | Tekrarlanabilir testle doğrulandı — test dosyası adı verilir |
| **[3]** | Güçlü olasılık — ek kanıt gerekir |
| **[4]** | Henüz doğrulanamadı — erişim/ortam yok |
| **[5]** | Kapsam dışı — bilinçli olarak yapılmadı |

---

## 3. Tek sayfalık sonuç

**Sistem çalışıyor.** 28 kaynak tanımı (24 etkin), 56 API rotası, 22 koleksiyon,
8 adaptör dosyası, e-posta + Telegram bildirimi, 9 sekmeli yönetim paneli.
`typecheck`, `lint`, `build` temiz; **122 test dosyası / 1.409 test** geçiyor; kapsam %77,5;
`npm audit` 0 açık; tüm bağımlılık lisansları izin verici.

**Ama üç şey eksik ve bunlar ürünü doğrudan etkiliyor:**
1. **Halka açık erişim yok** — oturum yoksa hiçbir ilan görünmüyor, hesap davetle açılıyor.
2. **Gerçek kalite ölçümü yok** — insan etiketli kayıt sayısı **0**; kesinlik/duyarlılık bilinmiyor.
3. **Veritabanı katmanında yetki ayrımı yok** — RLS yok, tek servis kimliği.

**Bu denetimde 8 bulgu düzeltildi** (2'si P0), 36 test eklendi, şema/veri göçü yapılmadı.

---

## 4. Bu dalda değişen kod (özet)

| Dosya | Değişiklik | Neden |
| --- | --- | --- |
| `src/ingest/jobs-service.ts` | `selectWithdrawalTarget()` kanıt kuralı | İptal duyurusu ilgisiz ilanı kapatıyordu |
| `src/classification/rules.ts` + `engine.ts` | `detectNewsReport()` haber/duyuru kapısı | Kurumsal haberler iş ilanı sayılıyordu |
| `src/db/query.ts` | `$exists` iki yönlü | Alanı olan belgeler `$exists:false` ile eşleşiyordu |
| `src/db/repos/jobs.ts` + `src/server/routes/jobs.ts` | `hasApplicationUrl` üç durumlu | `?hasApplicationUrl=false` tersini yapıyordu |
| `functions/api/[[path]].ts` | `buildForwardHeaders()` | İstemci IP sahteciliği → hız sınırı atlatma |
| `src/server/app.ts` | `unsubscribe` CSRF muafiyeti kaldırıldı | Zorla oturum kapatma yüzeyi |
| `README.md` | 27 → 28 kaynak, denetim bağlantısı | Bayat bilgi (R-14) |
| `src/classification/rules.ts` + `engine.ts` (bağımsız doğrulama) | Konuşmacı kalıbı görev unvanını ad sanmıyor; başlık "ilan" içeriyorsa haber kapısı en fazla `review` | Haber kapısı "Müdür Yardımcısı Alım İlanı" gibi gerçek ilanları reddediyordu (07 §6.2) |

**Yeni testler:** `ilan-iptal-guvenligi`, `guvenlik-cikis-csrf`, `api-filtre-sozlesmesi`,
`sorgu-motoru-exists`, `vekil-istemci-ip`, `gercek-ilan-regresyon`,
`classification-haber-dili`, `gercek-kaynak-icisleri-regresyon` (toplam **36 test**).
**Yeni fixture'lar:** 20 gerçek ilan gözlemi + 10 gerçek İçişleri duyurusu (`humanVerified: false`).

---

## 5. Doğrulama: iddiaları kendin kontrol et

```bash
npm ci
npm run typecheck              # 0 hata
npm run lint                   # 0 hata
npx vitest run                 # 122 dosya / 1.409 test
npx vitest run --coverage      # %77,5 ifade / %80,1 satır
npm run verify:all             # 10 adım; artifacts/verify-all/<zaman>/report.json
npm audit                      # 0 açık
npx playwright test            # yerelde BLOCKED; CI'da 20 test PASS (run 39597847874)
```

`verify:all` raporu kendi kanıtını yazar: `Dış HTTP guard: … outbound 0`, `Gerçek-insan etiketi: 0`,
`LLM doctor çağrısı: 0`, `E2E: BLOCKED`.

---

## 6. Yapılamayanlar — "dokunulmadı" listesi

Aşağıdakiler **bilinçli olarak yapılmadı**. Sebebi izin/erişim ya da insan emeği gerektirmesi;
teknik yetersizlik değil.

| Konu | Neden yapılmadı | Kim yapabilir |
| --- | --- | --- |
| Üretim veritabanına yazma / şema değişikliği | Geri dönüşü zor, açık izin gerekir | Proje sahibi + DBA |
| RLS / ayrı DB rolü (R-02) | Üretim DB'sine dokunur | DBA |
| Üretime dağıtım ve sağlık doğrulaması (R-08) | Erişim yok | Dağıtım sahibi |
| Gerçek LLM çağrısı (ücret) | Ücret doğurur; anahtar yok → **0 çağrı** | Proje sahibi onayı |
| 150 kayıt insan etiketleme (R-04) | Etiket **insan** kararı; ajan etiketi ölçüm sayılmaz | Alan uzmanı |
| Canlı kaynak taraması | Ortamda dış ağ kapalı | CI/üretim benzeri ortam |
| Tarayıcı E2E — yalnızca **yerel** (R-10) | Bu sandbox'ta Chromium yok; **CI'da 20 test geçiyor** | Yerelde `playwright install` |
| PDF/OCR kapsamı (R-13) | OCR bağımlılığı eklenmedi | Geliştirici + karar |
| Ölçek (20.000 satır sınırı, R-03) | Filtre SQL'e taşındı (kısmi); SQL sıralama/sayfalama ve gerçek Postgres yük testi yapılmadı (Postgres/Docker yok) | Geliştirici + staging DB |
| Herkese açık vitrin (R-01) | Ürün + KVKK politikası kararı | Proje sahibi |
| KadroNerede'nin iç işleyişi | Bilinmiyor; tahmin edilmedi, REA ile de çıkarılamaz | — (kapsam dışı) |
| Üçüncü taraf sitelerde test/tarama | Yetkisiz erişim olurdu | Yapılmadı, yapılmayacak |

---

## 7. Devir notu (bu depoyu devralan geliştirici veya yapay zekâ için)

**Önce bunu oku:** Bu depoda "yeşil test" = "doğru ürün" değildir. Testler kural motorunu ve API
sözleşmesini doğrular; **gerçek dünya doğruluğu ölçülmemiştir** (04 §4, 10 §5).

**Yapılmaması gerekenler**
- `kind-api.test.ts`'i "varsayılan listede süreç duyurusu olmasın" diye değiştirme — bu **ürün kararı**
  (03/R-12). Önce karar, sonra test.
- `ALLOW_PUBLIC_REGISTRATION` / `src/App.tsx` kapısını izinsiz açma — KVKK ve ürün kararı (R-01).
- `TRUST_PROXY` ayarını vekil olmadan `1` yapma (R-09).
- `LLM_*` fiyat değişkenlerini uydurma değerle doldurma; fiyat yoksa çağrı yapılmaması **doğru** davranış.
- Sınıflandırma eşiklerini (kabul ≥3, inceleme ≥1) test kırmızıya düştü diye gevşetme —
  yanlış ilan yayımlamak, ilan kaçırmaktan daha pahalıdır.

**Öncelik sırası (06 §5):** karar paketi (R-01, R-02) → insan etiketleme (R-04) →
ölçek (R-03) → CI (R-10, R-15).

**Yeni bir hata sınıfı bulduğunda:** gerçek kaydı fixture'a ekle (`tests/fixtures/gercek-ilanlar/`),
`humanVerified: false` yaz, düzeltmeyi testle kilitle. Sentetik test tek başına kanıt sayılmaz.

---

## 8. Değişiklik günlüğü (bu denetim)

| Commit | İçerik |
| --- | --- |
| `50d84e4` | İptal hedefi kanıt kuralı + gerçek korpus regresyonu |
| `d72f909` | Haber dili kapısı + gerçek İçişleri duyurusu regresyonu |
| `4131b5a` | Filtre sözleşmesi, `$exists`, vekil IP, CSRF muafiyeti |
| `37a9344` | 01–08 belgeleri |
| `ef1a8ac`, `911b0b4` | Belge sayı düzeltmeleri |
| `739eee3` | 09–12 belgeleri |
| `82385f9` | Bu giriş noktası, README düzeltmesi, E2E kanıtı |
| bağımsız doğrulama (2 commit) | Haber kapısı yan etkisi düzeltmesi (+3 test) · 07 §6, 03/R-07, 06 güncellemesi |

Her commit bağımsız geri alınabilir; şema değişikliği ve veri göçü yok.

---

## 9. Bağımsız doğrulama (Claude Code, 21.10.2026)

Arena'nın iddiaları ayrı bir ortamda yeniden koşuldu; ayrıntı **[07 §6](07-verification-results.md)**.

- **Testler hatayı yakalıyor:** PR'ın 36 testi düzeltme öncesi koda karşı koşuldu → 18 kırmızı;
  7 düzeltmenin her birinin en az bir testi eski kodda kırılıyor.
- **Yeni bulgu (P1, düzeltildi):** haber kapısı görev unvanlı gerçek ilanları (`Müdür Yardımcısı
  Alım İlanı`, `Vali Yardımcısı Kadrosu Personel Alımı`) reddediyordu. +3 test.
- **Kanıt düzeyi düzeltmesi:** 03/R-07'deki web aramasına dayalı haber örnekleri [1] → [4].
- **Düzeltilen ifade:** 07 §4'teki İçişleri satırı düzeltme kanıtı değil, temel çizgi
  (test eski kodda da geçiyor).
- **Açık güvenlik notu (R-09):** API kökeni doğrudan erişilebiliyorsa `X-Forwarded-For`
  sahtelemesi vekil atlanarak hâlâ mümkün; üretimde doğrulanmadı (07 §6.5).

**İnsan kararı / harici erişim gerektirenler (tek liste):** R-01 erişim modeli + KVKK metni ·
R-12/R-17 varsayılan liste ve arşiv sekmesi · R-02 DB rolleri/RLS (staging Postgres provası) ·
R-09 API kökeninin yalnızca Cloudflare'den erişilebilirliği · R-04 insan etiketli altın küme ·
R-08 üretim sağlık uçları.
