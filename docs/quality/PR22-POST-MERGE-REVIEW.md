# PR #22 — birleşme sonrası inceleme (post-merge review)

**PR:** https://github.com/kaaradumaann-psi/kamuradar/pull/22
**Durum:** MERGED (2026-10-17T16:17:46Z), merge commit `ee45a23d5fde466a4d7803acfa73e8433d68d719`
**İnceleme tarihi:** 2026-10-17
**İncelenen ağaç:** `ee45a23` + bu dalın çalışma ağacı (aşağıdaki düzeltmeler)
**Kapsam:** `src/ai/*`, `src/server/routes/ai.ts`, `src/sources/fetcher.ts`,
`src/lib/offline-network.ts`, DB store'ları, e-posta taşıyıcısı, env doğrulama,
TLS, `scripts/verify-all.ts`, `live-check`, `capture-fixtures`, `llm-doctor`,
CI iş akışı.

> **Ayrım:** Bu belge "birleşme kapısı kodu" ile "canlı doğruluk" iddiasını
> ayırır. Aşağıdaki PASS'ler yalnızca çevrimdışı/statik kanıttır. Hiçbir canlı
> kaynak, sağlayıcı, e-posta veya üretim veritabanı çağrısı yapılmadı.

## 1. Bugünkü kanıt

| Kontrol | Komut | Sonuç | Sınır |
|---|---|---|---|
| Çevrimdışı doğrulama | `npm run verify:all` | **PASS** (9/9 adım, exit 0) | E2E hariç; canlı ağ yok |
| Testler | `npx vitest run` | **1360 test / 113 dosya PASS** | Mock/fake ağ |
| Kapsam | `vitest --coverage` | stmts **%77,51** · branch **%67,91** · funcs **%73,86** · lines **%80,08** | Kapsam ≠ doğruluk |
| Tip/lint/build | `typecheck` / `lint` / `build` | PASS | Statik |
| Bağımlılık | `npm audit --json` | 0 advisory (tüm seviyeler) | Lockfile kapsamı; SAST değil |
| Sır taraması | `git ls-files -z \| xargs -0 grep -IlE 'AIza\|sk-\|BEGIN.*PRIVATE\|…'` | Yalnız `tests/fixtures/tls-aia/*.key` (test CA) | Desen tabanlı; tam güvence değil |
| E2E | `npm run test:e2e` | **BLOCKED** — bu sandbox'ta Chromium yok | CI'da ayrı çalışır |
| Canlı kaynak | tek `curl -sI https://www.resmigazete.gov.tr/ilanlar` | **BLOCKED** — TLS/SSL_ERROR_SYSCALL | Ağ sandbox'ı; tekrar denenmedi |
| Canlı AI/e-posta/DB | — | **NOT RUN** | Anahtar/ortam yok |

## 2. Bulgular

### M1 — Erişim kısıtı (401/403/429/WAF) "failed" sayılıyordu — **DÜZELTİLDİ**
**Dosya:** `src/ingest/pipeline.ts` (catch bloğu)
**Önce:** `AdapterUnavailableError` ve `AdapterStructureError` özel işleniyor;
`SourceAccessError` genel `failed` dalına düşüyordu. 403/429 alan bir kaynak,
"başarısız tarama" olarak sağlık geçmişini kirletiyor ve operatöre "tekrar dene"
mesajı veriyordu.
**Etki:** Orta. Kısıt aşılmadığı hâlde kaynak bozuk sanılabilir; retry/uyarı
döngüsü yanlış sınıflandırılır.
**Düzeltme:** `SourceAccessError` artık `skipped` + `httpStatus` olarak kaydedilir;
mesaj "Kaynak erişimi kısıtlı (HTTP N)" der. Regresyon testi:
`tests/ingest.test.ts` → "erişim kısıtı … ATLAMA olarak kaydedilir".
**Kalan:** `errorType` hâlâ `other`; panelde ayrı "erişim" etiketi yok.

### M2 — 0 sonuç, "başarılı tarama" olarak görünebiliyor — **KISMEN DÜZELTİLDİ**
**Dosya:** `src/db/repos/sources.ts:289` (`health.unexpectedZero`)
**Kök neden:** Heuristik yalnızca `discoveredCount=0 && success && (önceki>0 ||
emptyStreak>=3)` durumunda işaret koyar. İlk çalıştırmada HTML değişmişse veya
kart seçicisi bozulmuşsa, adaptör hata fırlatmadığı sürece ilk iki koşum
"beklenmedik sıfır" olarak görünmez.
**Etki:** Orta. Sessiz kapsam kaybı; panelde "0 ilan" normal görünebilir.
**Düzeltme (bu dal):** Staging raporu 0 sonucu `not-observed` / `confirmed-empty`
/ `blocked` / `parse-failure` / `unknown` olarak ayırır; `confirmed-empty`
yalnızca kapsam `complete` **ve** operatör açık onayıyla üretilir. Genel worker
için heuristik değiştirilmedi (davranış değişikliği riski).
**Öneri:** Kaynak sağlık panelinde `lastRun.coverage` ve `zeroResultReason`
alanlarını birlikte göster; `success && zero` durumunu "doğrulanmadı" etiketiyle
göster.

### M3 — Sağlayıcı/e-posta/Telegram istemcileri 30x yönlendirmeyi izliyordu — **DÜZELTİLDİ**
**Dosya:** `src/ai/llm.ts` (`fetchImpl` çağrısı), `src/email/transport.ts` (Resend),
`src/telegram/client.ts`
**Kök neden:** Node `fetch` varsayılan olarak yönlendirmeleri izler. Kimlik
başlığı (`Authorization` / `x-goog-api-key`) taşıyan bir istek 30x ile başka
host'a yönlendirilirse anahtarın sızma riski vardır. Uygulama sağlayıcı uç
noktasını operatörden alır; kötü niyetli/yanlış yapılandırılmış bir uç nokta
veya aradaki yönlendirme bunu tetikleyebilir.
**Etki:** Orta (kimlik bilgisi sızıntısı; TLS açık olsa bile).
**Düzeltme:** Üç istemcide de `redirect: 'error'`; LLM testinde
`init.redirect === 'error'` regresyon iddiası. Yönlendirme artık açık hata verir.
**Kalan:** Sağlayıcı meşru bir yönlendirme kullanıyorsa operatör doğrudan uç
noktayı yapılandırmalıdır.

### L1 — Detay bütçesi adaptör yöntem dizesine bağlı
**Dosya:** `src/ingest/pipeline.ts:144-149, 326-330`
**Kök neden:** `detailFetchBudget(source.method)` `'browser' | 'pdf-index' |
diğer` ayrımını kaynak tanımındaki serbest metin `method` alanına bağlar.
Adaptör değişip `method` güncellenmezse bütçe sessizce 8'e düşer/25'e çıkar.
**Etki:** Düşük. Yanlış bütçe; tarama süresi veya kapsamı beklenmedik değişir.
**Düzeltme (bu dal):** Staging komutu `maxDetailFetches` üst sınırını ayrıca
geçirir (yöntem tavanını yükseltmeden). Kalıcı çözüm: bütçeyi adaptör
kapasitesine (ör. `adapter.detailBudget`) taşımak.

### L2 — Not/durum kodları kesiliyor, geç hatalar görünmeyebilir
**Dosya:** `src/ingest/pipeline.ts:336-337`
**Kök neden:** `httpStatuses` 50, adaptör notları 18 ile sınırlandırılıyor. Uzun
bir taramada son sayfaların 5xx/403 durumları kesilebilir.
**Etki:** Düşük. Teşhis zorlaşır; sayaçlar yanlış "temiz" görünebilir.
**Düzeltme (bu dal):** Staging raporu ayrı `httpStatus` ve toplam sayaçlar taşır.
**Öneri:** Durum kodlarını frekans tablosu olarak (ilk/son değil) sakla.

### L3 — `.env.example` canlı taramayı açık bırakıyordu — **DÜZELTİLDİ**
**Dosya:** `.env.example:85,105,110`; `src/config/env-spec.ts:547,600,626`
**Önce:** `SCHEDULER_ENABLED=1`, `SOURCE_LIVE_FETCH=1`,
`SOURCE_BROWSER_FALLBACK=1`. Dosyayı `.env` olarak kopyalayan operatör, tek
komutla 24 kaynağa istek atabilecek ve Chromium'u devreye alabilecekti.
**Etki:** Yüksek (kazara ağ/hukuk ihlali). PR #22'nin `live-check` bütçeleri bu
riski azaltıyor ama `start:worker` yolu için varsayılan hâlâ açıktı.
**Düzeltme:** Şema ve örnek dosya **0/0/0**. `SOURCE_LIVE_FETCH=1` tek başına
yetmez; `SCHEDULER_ENABLED=1` ayrıca açılmalı ve doküman iki aşamalı opt-in
olduğunu söyler. Regresyon: `tests/safe-defaults.test.ts`.

### I1 — `SCHEDULER_ENABLED=0` e-posta/Telegram kuyruğunu durdurmaz (bilinçli)
**Dosya:** `src/worker/runtime.ts:144-159`; test: `tests/worker.test.ts:172`
Worker her tick'te e-posta ve Telegram outbox'ını işler; scheduler kapalı olsa
da bekleyen bildirimler gider. Bu, "zamanlayıcıyı kapatınca hiçbir şey
gönderilmez" beklentisini boşa çıkarır. Staging komutu bu yüzden worker
başlatmaz ve `EMAIL_PROVIDER=file` kullanır. Doküman bunu açıkça yazmalı.

### I2 — `.env.example` `EMAIL_PROVIDER=smtp` (şema varsayılanı `file`)
**Dosya:** `.env.example` (e-posta bölümü); `src/config/env-spec.ts` (enum)
Geliştirme için bilinçli: `dev-all` loopback SMTP'yi başlatır, böylece davet /
doğrulama e-postaları gerçek hattan geçer. Üretimde `resend`/`smtp` zorunludur.
"Sağlayıcı kabul etti" **teslim** değildir; `file` taşıyıcısı gerçek e-posta
göndermez.

### I3 — Mongo yolu pratikte test edilmemiş
**Dosya:** `src/db/mongo-store.ts`
Kapsam **%0,86**. Gerçek Mongo bu ortamda **NOT RUN**; "Mongo destekleniyor"
ifadesi "Mongo doğrulandı" diye okunmamalıdır.

### L4 — LLM yanıtı sınırsız okunuyor (kısmi)
**Dosya:** `src/ai/llm.ts:924` (`(await response.text()).slice(0, MAX_RESPONSE_CHARS)`)
**Kök neden:** Yanıt önce tamamen belleğe alınır, sonra karakter sınırına
kırpılır. Sağlayıcı (veya aradaki vekil) çok büyük gövde döndürürse bellek
baskısı oluşabilir.
**Etki:** Düşük. Zaman aşımı ve sağlayıcı güveni riski sınırlar; yine de sert
bir bayt tavanı yok.
**Öneri:** `content-length` + akışlı okuma ile `MAX_RESPONSE_BYTES` sert sınırı.

### L5 — Tarayıcı yolu PDF indirmesi HttpClient sayaçlarına sayılmıyor
**Dosya:** `src/sources/adapters/resmigazete.ts:136` (`page.evaluate` içinde `fetch`)
**Kök neden:** Tarayıcı oturumu 15 MB boyut ve 30 sn gezinme sınırı uygular ve
route guard host allowlist'i korur; ancak bu indirmeler `HttpClient`
`binaryFetchesMade`/`requestsMade` sayaçlarına eklenmez.
**Etki:** Düşük. Operatör staging'de tarayıcı kapalıdır; üretimde bütçe raporu
eksik kalabilir.
**Öneri:** Tarayıcı indirmelerini ayrı sayaçla raporla veya staging'de yalnız
HTTP yolunu kullan (mevcut davranış).

### I4 — `verify:all` E2E çalıştırmaz
`scripts/verify-all.ts` E2E'yi bilinçli olarak dışarıda bırakır ve
`E2E: BLOCKED/NOT RUN` yazar. CI iş akışı ayrı `test:e2e` adımı içerir. Yerel
`verify:all` PASS'i E2E PASS'i değildir.

## 3. Birleşme kapısı değerlendirmesi

- Kritik/yüksek **runtime** bulgu: **yok** (statik + çevrimdışı incelemede).
  L3 yüksek etkiliydi; bu dalda düzeltildi.
- `verify:all` 9/9 PASS; tip/lint/build PASS; audit 0; test sayıları artık
  `report.json` içindeki `testSummary` alanında (1353 → 1360 test).
- Canlı doğruluk, kaynak erişimi, AI kalitesi: **kanıtlanmadı** ve bu PR'ın
  kapsamı dışında. "Yeşil CI = tüm ilanlar toplanıyor" değildir.
- Geri alma gerekmiyor. Kalan işler M2/L1/L2 önerileri ve canlı ölçüm.

## 4. Yeniden üretim

```powershell
npm ci
npm run verify:all
npm run eval:extraction
npx vitest run tests/ingest.test.ts tests/safe-defaults.test.ts
```

Canlı denemeler (yetkili ortam, ayrı opt-in):
[docs/setup.md](../setup.md) ve [STAGING-RUNBOOK.md](./STAGING-RUNBOOK.md).
