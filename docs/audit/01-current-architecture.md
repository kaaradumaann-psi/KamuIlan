# 01 — Mevcut Mimari (kanıta dayalı)

**Denetim tarihi:** 21 Ekim 2026
**Dal:** `arena/244c8afc-kamuradar` (taban: `main` @ `4fd9acb`, PR #24 birleşmiş)
**Yöntem:** Yalnızca depodaki gerçek kod, çalıştırılan komutlar ve gerçek kaynak sayfaları.
Hiçbir bulgu "dosya adına bakarak" yazılmadı; her satır okunan kod ya da komut çıktısıyla
ilişkilendirildi. Kanıt düzeyleri: **[1]** doğrudan kanıtlandı, **[2]** tekrarlanabilir testle
doğrulandı, **[3]** güçlü olasılık, ek kanıt gerekir, **[4]** doğrulanamadı, **[5]** kapsam dışı.

---

## 1. Çalışma dizini ve Git durumu [1]

| Öğe | Değer |
| --- | --- |
| Dizin | `/home/user/kamuradar` |
| Dal | `arena/244c8afc-kamuradar` |
| Taban commit | `4fd9acb` — "Merge pull request #24 …" |
| Uzak | `origin` → `github.com/kaaradumaann-psi/kamuradar` |
| Açık PR | Yok (PR #15–#24 birleşmiş; `main` = PR #24 birleşimi) |
| Çalışma ağacı (başlangıç) | Temiz |
| Node / npm | v22.22.3 / 10.9.8 (`engines.node >= 22.15.0` ile uyumlu) |

> Not: GitHub Actions'ta `arena/3432c91a-kamuradar` dalı için iki CI koşumu görünüyor
> ("kadronerede.com tersine mühendislik inceleme raporu"), ancak **bu dal uzakta yok** ve
> bir PR'ı yok. O dalın çıktısı depoya hiç ulaşmamış: o raporlar bu denetimde
> **kullanılmadı ve doğrulanmadı** [1].

## 2. Teknoloji yığını (package.json + kod)

- **Tek paket** (npm, tek `package.json`), TypeScript 5.9, ESM, `strict` +
  `noUncheckedIndexedAccess` + `noUnusedLocals` (tsconfig.json).
- **API:** Fastify 5 + `fastify-type-provider-zod` + Swagger (`/api/docs`, `DOCS_ENABLED`).
- **Arayüz:** React 19 + Vite 8 + React Router 7 + TanStack Query 5; CSS el yazımı
  (`src/styles/*`), Tailwind bağımlılığı yok.
- **Depolama:** `StoragePort` soyutlaması + üç sürücü: dosya (geliştirme), Postgres/Supabase
  (JSONB tablolar), MongoDB. Sorgu semantiği tek kod yolunda (`src/db/query.ts`).
- **Kuyruk:** Redis varsa BullMQ, yoksa veritabanı tabanlı yerleşik kuyruk.
- **Toplama:** `undici` + `cheerio` + `pdfjs-dist` (+ isteğe bağlı Playwright tarayıcı yedeği).
- **E-posta:** Resend HTTPS / SMTP / dosya taşıyıcı; `nodemailer`.
- **Dağıtım:** Cloudflare Workers (statik `dist/` + `/api/*` vekili) + ayrı API/worker süreci;
  `wrangler.jsonc` üretim alan adını ve `API_ORIGIN`'i sabitler.

## 3. Katmanlar ve gerçek kod yolları

```
src/config/     env (zod) + kaynak envanteri (28 tanım) + uygulama sabitleri
src/domain/     saf mantık: metin normalleştirme, Türkçe tarih, iller, URL, tipler
src/db/         22 koleksiyon şeması, dosya/postgres/mongo sürücüleri, 10 repo, indeksler
src/sources/    8 adaptör dosyası (10 kayıtlı adaptör kimliği) + SSRF korumalı HTTP istemcisi + envanter/sağlık/gözlem
src/extraction/ PDF metni + alan çıkarımı (her alan kaynağıyla: listing/detail/unstated)
src/classification/ deterministik kural motoru + içerik türü + değerlendirme kümesi
src/ingest/     kabul hattı: sürümleme, tekilleştirme, iptal sinyali, inceleme kuyruğu
src/ai/         isteğe bağlı LLM kapısı (bütçe, kanıt doğrulama, telemetri)
src/notifications/, src/email/, src/telegram/   eşleştirme → olay → outbox → taşıyıcı
src/worker/     yerleşik/BullMQ tüketici, zamanlayıcı, kilit, kalp atışı, kurtarma
src/server/     56 rota, RBAC, CSRF, hız sınırı, güvenlik başlıkları, serileştiriciler
src/pages/, src/components/, src/lib/, src/styles/   React arayüzü (giriş kapılı)
functions/api/[[path]].ts   Cloudflare vekili (/api → API süreci)
scripts/        31 operasyon betiği (kurulum, bakım, rapor, fixture, değerlendirme)
tests/          bu denetim sonunda 122 dosya / 1.409 test (bkz. 04)
e2e/            Playwright (tarayıcı kurulu olmadığı için bu ortamda KOŞULAMADI)
```

## 4. Uçtan uca akış (kodla doğrulandı)

1. **Zamanlayıcı** (`src/worker/scheduler.ts` + `scheduledTasks` koleksiyonu) aralığı gelen
   kaynakları kuyruğa yazar; kilit + TTL çift taramayı engeller. [1]
2. **Tarama** (`src/ingest/pipeline.ts` → adaptör → `src/sources/fetcher.ts`): ETag/Last-Modified,
   hız sınırı, üstel geri çekilme, gövde boyutu sınırı, her DNS cevabı için SSRF denetimi. [1]
3. **Sınıflandırma** (`src/classification/engine.ts`): `accept` / `reject` / `review`;
   `personnel_recruitment` dışındaki türler ilan akışına girmez (`content-type.ts`). [1][2]
4. **Alan çıkarımı** (`src/extraction/engine.ts`): her alan `fieldSources` ile kanıtlanır,
   çıkarılamayan alan `null` kalır. [1]
5. **Tekilleştirme** (`src/ingest/dedupe.ts`): resmî no → kanonik URL → kurum+unvan+dönem+metin;
   eşik aralığı `review`'a düşer. [1][2]
6. **İptal/düzeltme** (`src/ingest/jobs-service.ts`): bu denetimde **düzeltildi** — bkz. 03/06. [2]
7. **Bildirim** (`src/notifications/`, `src/email/`): benzersiz olay → outbox → taşıyıcı;
   "sağlayıcı kabul etti" kaydedilir, "teslim edildi" iddia edilmez. [1]
8. **Bakım** (`src/db/repos/jobs.ts`): `closeExpiredJobs`, `closeStalePublications`,
   `activateStartedJobs` — süresi dolan ilan "açık" kalmaz (durum veride tutulur, bakımla güncellenir). [1]

## 5. Kimlik, yetki ve sınırlar

- Oturum çerezi `HttpOnly` + `SameSite=Lax`; jeton veride **SHA-256 özeti** olarak durur
  (`src/server/routes/auth.ts`). Parola `scrypt`. [1]
- CSRF: double-submit (`kamuilan_csrf` çerezi + `x-csrf-token`); muafiyet listesi tam yol
  eşleşmesiyle sınırlı. Bu denetimde `/api/auth/unsubscribe` muafiyetten çıkarıldı (06). [2]
- Kimlik denemelerinde hesap bazlı + IP bazlı hız sınırı; kullanıcı numaralandırmasını önlemek
  için olmayan hesapta da scrypt maliyeti ödenir. [1]
- Yönetici uçları `requireAdmin` + rota deseni/çözülmüş yol denetimi ile korunur
  (`tests/guvenlik-yetki-regresyon.test.ts` yüzde kodlu yol kaçışını kapatıyor). [2]
- **Kendi kendine kayıt kapalı** (`ALLOW_PUBLIC_REGISTRATION=0`) ve **arayüz giriş kapılı**:
  oturumsuz ziyaretçi hiçbir ilan listesini göremez (`src/App.tsx` + `tests/app-gate.test.tsx`). [2]

## 6. Güvenlik yüzeyi (özet; ayrıntı 03)

- SSRF: host allowlist + tüm DNS cevaplarının genel-yönlendirilebilirlik denetimi +
  yönlendirmelerin elle izlenmesi (`src/sources/network-safety.ts`, `fetcher.ts`). [1]
- XSS: arayüzde `dangerouslySetInnerHTML` **yok**; dış bağlantılar serileştiricide
  `isHttpUrl` ile süzülür (`src/server/serializers.ts`). [1]
- CSP: `default-src 'self'; script-src 'self'; frame-ancestors 'none'` vb. (ölçüldü, §7). [1]
- Sırlar: depoda gerçek anahtar yok; `.env` gitignore'da; yalnızca test yer tutucuları var. [1]
- **RLS yok**: üretim yolu Supabase Postgres'e **sunucudan servis rolüyle** bağlanır
  (`POSTGRES_URL`), satır düzeyi güvenlik kullanılmaz; yetki uygulama katmanındadır. Bu bir
  mimari gerçek, açık: RLS'e dayalı bir model yok (03/R-02). [1]

## 7. Yerel ölçüm (bu ortamda çalıştırıldı)

```
npx tsc --noEmit           → 0 hata
npm run lint               → 0 hata
npm run build              → dist/ 653 KB (js gzip ~145 KB toplam), 411 ms
npm run db:migrate         → 49 indeks, 28 kaynak, 32 zamanlanmış görev (4 devre dışı)
GET /api/health            → status "degraded" (24 kaynağın taze taraması yok — dürüst uyarı)
GET /api/jobs              → güvenlik başlıkları + x-ratelimit-* başlıkları ölçüldü
```

`/api/health` yanıtı kaynak sağlığını **gerçek veriden** üretiyor: `sources.total=28,
enabled=24, verified=15, stale=24` — README'deki "27 kaynak" ifadesi güncelliğini yitirmiş
(03/R-14).

## 8. Bilinmeyenler / doğrulanamayanlar

| Konu | Durum |
| --- | --- |
| Üretim API'sinin canlı durumu (`api.kamuilan.halilkaraduman.com.tr`) | **[4]** Bu ortamdan erişilemedi (DNS/ağ kısıtı); çalıştığı varsayılmadı. |
| Üretim Supabase şeması ve veri hacmi | **[4]** Erişim yok; kod yalnızca şemayı tanımlıyor. |
| Cloudflare üretim yapılandırması (routes, secrets) | **[3]** `wrangler.jsonc` depoda; panonun gerçek durumu doğrulanamadı. |
| Gerçek kaynak taramasının canlı çalışması | **[4]** `SOURCE_LIVE_FETCH=0`; bu denetimde canlı tarama yapılmadı. |
| Playwright/E2E ve mobil tarayıcı davranışı | **[5]** Tarayıcı ikilisi yok → KOŞULAMADI (04). |

## 9. Bu denetim setinin tamamı

| Belge | İçerik |
| --- | --- |
| 01 | Bu belge — mimari |
| 02 | Yetenek envanteri (ne var, ne yok) |
| 03 | Risk kaydı R-01…R-17 |
| 04 | Test/doğrulama temeli |
| 05 | KadroNerede karşılaştırması |
| 06 | İyileştirme planı |
| 07 | Doğrulama sonuçları |
| 08 | Yayına hazırlık |
| 09 | REA değerlendirmesi (Phase 2) |
| 10 | Veri doğruluğu ve kaynak envanteri (Phase 4) |
| 11 | LLM + güvenlik + KVKK (Phase 5–6) |
| 12 | Kod kalitesi ve performans (Phase 7) |
