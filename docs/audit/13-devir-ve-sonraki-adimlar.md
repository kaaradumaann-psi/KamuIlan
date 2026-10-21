# 13 — Devir ve Sonraki Adımlar

**Tarih:** 23.10.2026 · **main:** `4c15843` (#50 birleşmesi) · **Açık PR:** #51 (CI success; birleştirme depo sahibi kararıyla bekletiliyor)
**Amaç:** Bir sonraki oturumun (insan ya da yapay zekâ) baştan analiz yapmadan doğrudan
devam edebilmesi. Yapılanların kanıtı 07 §6–§8, risk durumu 03, birleşen PR listesi README §10–§11,
kaynak durumu 14.

---

## 00. 23.10.2026 durumu (güncel)

**Birleşen PR'lar (#37–#50):** hepsi CI `verify` success ile birleşti; liste README §11.

**#51 (tekilleştirme benzerlik önbelleği, head `bbddbed`):** CI success. #50 sonrası `main` ile
yerelde birleştirilmiş ağaçta typecheck 0 · lint 0 · vitest **144 dosya, 1526 geçti, 1 atlandı,
0 başarısız** (Windows, 23.10). Birleştirilmedi: depo sahibi kararı (3. seçenek) — birleştirmeden
önce güncel head SHA ve CI yeniden doğrulanmalı.

**Yerel tam paket (`main` `4c15843` öncesi #50 head `705793c`, Windows):** typecheck 0 · lint 0 ·
vitest **142 dosya, 1516 geçti, 1 atlandı, 0 başarısız**.

**Değişmeyen sınırlar:** üretime dağıtım yok · üretim DB'sine erişim yok · gerçek LLM sağlayıcı
çağrısı yok (anahtar yok) · insan etiketli kayıt 0 → kesinlik/duyarlılık üretilemez ·
gerçek Postgres ölçümü yok (yalnız PGlite).

**Açık teknik işler (öncelik sırası):**

| # | İş | Durum / engel |
| --- | --- | --- |
| 1 | Kaynak matrisi | 14 belgesi (statik envanter + izin + canlı kanıt) |
| 2 | İŞKUR liste | BLOCKED — statik HTML'de liste yok; robots `/api/` ve `/*?*` yasak; resmî veri kanalı gerekli |
| 3 | Bakanlık/kurum çok pozisyonlu tablo (Sayıştay tipi "(1 Kişi …)") | `extractOpenings` resmî toplamı okuyor (#48), pozisyon kırılımı yok |
| 4 | `q` araması / filtreli sayım (PGlite 570–720 ms) | `pg_trgm` kararı gerçek Postgres ölçümüne bağlı (R-03) |
| 5 | OCR satır güveni / tablo gürültüsü | Kod var, varsayılan kapalı (R-13) |
| 6 | `scrapeRuns` saklama süresi | Tablo sınırsız büyüyor; silme işi ayrı PR, üretimde çalıştırılmaz |
| 7 | Mock adaptörle uçtan uca veri E2E | E2E seed'inde ilan tohumu yok |
| 8 | Görsel regresyon | Referanslar CI (Linux) üzerinde üretilmeli |

## 0. 22.10.2026 oturumu — açık PR'lar (TARİHSEL; hepsi birleşti)

Her PR: kök neden kanıtı + eski kodda kırmızı test (mutasyon kontrolü) + tam paket
(yalnız bilinen 9 Windows ortam hatası). Birleştirme ve dağıtım yapılmadı.

| PR | Konu | Gerçek etki |
| --- | --- | --- |
| #37 | R-03: filtre/sıralama/sayfalama/sayım SQL'de (`src/db/postgres-exact.ts`) | `jobs` > 20.000'de **kabul hattı duruyordu**; `$ne` eksik alanı eşlemiyordu (eski ilanlar listeden düşüyordu). PGlite 50k: liste 3.480 → 158 ms |
| #38 | Birleştirmede `publishedAt` | Eski kapalı ilan tekrar görülünce `unknown` oluyordu |
| #39 | Eski sürümlü RET kararları yeniden değerlendirilir; `CLASSIFICATION_VERSION 2026.10.5` | #31 (Bursa) gibi düzeltmeler reddedilmiş kayıtlara hiç ulaşmıyordu; **`jobs:reclassify` ret kayıtlarına ulaşamaz** (K3 notu) |
| #40 | Arayüz: mobil hero, rota kaydırması, durum kartı, kısmi tarama, son kontrol | Telefonda ana sayfa araması kartın altında kalıyordu; şerit "başarılı tarama yok" diyordu |
| #41 | Birim çıkarımı; `EXTRACTION_VERSION 2026.10.5` | Kartlarda "SI KADRO ÜNVANI AÇIKLAMA MDF01 …" |
| #42 | Düzeltme ilanı → RG atfıyla hedef (yalnız düzeltme, iptal değil) | Gerçek düzeltmeler hep incelemeye düşüyordu |
| #43 | Kontenjan belge adedinden okunmaz; kadro tablosu toplamı | "3 adet vesikalık fotoğraf" → "3 kişi" |

**Birleştirme sırası önerisi:** #37 → #38 → #39 → #41 → #43 (aynı dosyalarda küçük çakışma
olabilir: `jobs-service.ts` birleştirme bloğu, `app.ts` sürüm satırı) → #40 → #42.

**Gerçek veriyle yerel doğrulama yöntemi** (tekrarlanabilir, depo dışı `.staging/ui/`):
dosya sürücüsü + `db:migrate` + yalnız Resmî Gazete tek canlı tarama (onaylı şartlar, 1,5 sn
aralık, `SCRAPE_USER_AGENT` "Bot" içermeyen kimlik) → `seed:admin` → `npm run start` +
`npm run preview` → `E2E_BASE_URL=http://localhost:4173 npx playwright test`. 22.10: 25 kayıt,
6 ilan, E2E 22/22.

**Bilinen ama bu oturumda yapılmayan:** Sayıştay tipi çok pozisyonlu ilanda kontenjan yalnız
ilk pozisyon; `q` metin araması ve filtreli sayım PGlite'ta 570–720 ms (trigram indeksi gerçek
Postgres ölçümünden sonra); düzeltme/iptal bildirimi yok (ürün kararı); OCR bağımlılığı (karar).

## 1. Mevcut durum (tek bakış)

| Alan | Durum | Kanıt |
| --- | --- | --- |
| Kod kalitesi | typecheck/lint temiz; 142 dosya / 1517 test (#50 head) | §00; yerel koşum 23.10 |
| Yerel test (Windows) | 1516 geçti · 0 başarısız · 1 atlandı | 9 ortam hatası #45 ile kök nedenden kapandı |
| CI (Linux) | `verify:all` + Playwright E2E her merge'de success | GitHub Actions `verify` |
| Gerçek veri | Resmî Gazete: 3 + 16 belge, yanlış kabul 0 (ajan etiketi) | 07 §8, §8.1 |
| Üretim | **Doğrulanmadı**; dağıtım yapılmadı, üretim DB'sine dokunulmadı | R-08 |
| Yayın kararı | İç/demo için koşullu; halka açık yayın için hazır değil | 08 |

## 2. Karar bekleyenler (depo sahibi)

Her madde için: ne yapılacak · nerede · kabul ölçütü.

| # | Karar | Nasıl uygulanır | Kabul ölçütü |
| --- | --- | --- | --- |
| K1 | **Herkese açık vitrin (R-01)** | Üretim ortamında `PUBLIC_LISTINGS_ENABLED=1`; önce `src/pages` gizlilik/SSS/giriş metinlerindeki "kapalı sistem" dili güncellenir; `public/robots.txt`'e `Sitemap: https://<alan>/api/sitemap.xml` eklenir | Oturumsuz `/ilanlar` açılır, `/panel` ve `/yonetim` giriş ister (`tests/herkese-acik-vitrin*.test.*`); `/api/sitemap.xml` 200 |
| K2 | **Tarayıcı kimliği (R-18)** | `src/config/env.ts` `SCRAPE_USER_AGENT` varsayılanından `Bot` sözcüğünü çıkarmak (kimlik + iletişim adresi korunur) ya da üretimde ortam değişkeniyle vermek | Üretim kaynak sağlığında Resmî Gazete son koşumu `complete`/`partial` |
| K3 | **Mevcut kayıtları yeniden işleme** | `npm run jobs:reclassify` (önce yedek: `jobs:restore` akışını oku). #25 haber kapısı, #27 tür, #31 Bursa, #33 kadro düzeltmeleri yalnız YENİ kayıtlara uygulanıyor | Bursa kurumlarının reddedilmiş ilanları geri gelir; kadro tablosu eski ilanlarda dolar |
| K4 | **Vekil güveni (R-09)** | Üretimde `TRUST_PROXY=cloudflare` (ya da gerçek vekil CIDR listesi) | API kökenine doğrudan, sahte `X-Forwarded-For` ile yapılan isteklerde hız sınırı aşılamaz |
| K5 | **DB yetki ayrımı (R-02)** | Staging Postgres'te uygulama rolü + kritik tablolarda RLS provası | Yetkisiz rol `SELECT` reddi (entegrasyon testi); tüm testler yeşil |
| K6 | **Altın küme (R-04)** | 100–200 gerçek kayıt insan etiketiyle (`docs/quality/LABELING-RUNBOOK.md`) | `eval:classification` insan etiketiyle kesinlik ≥0,95, yanlış kabul ≤%2 |
| K7 | **Üretim sağlığı (R-08)** | `/api/health` ve `/api/health/worker` çıktısının kayda geçirilmesi | 7 gün kesintisiz çalışma |
| K8 | **Canlı kaynak onayları** | Yeni kaynak için `config/source-terms.json` YEREL doldurulur (commit edilmez — `tests/source-terms.test.ts`) | `staging:capture --live` koşumu `partial`/`complete` |

## 3. Teknik iş listesi (öncelik sırasıyla)

> **23.10 notu:** Bu listenin 1 (#37), 2-üniversite (#48), 5 (#49, varsayılan kapalı),
> 6 (#42) ve 10 (#45) maddeleri birleşti. Güncel açık iş listesi §00'dadır.

### P1
1. **R-03 kalan — SQL'de sıralama/sayfalama.**
   - Durum: filtre SQL'de (#26); sıralama + `LIMIT/OFFSET` bellekte; eşleşen satır > 20.000 → açık hata.
   - Yaklaşım: ön filtre **tam** (üst küme değil) olduğunda `ORDER BY … LIMIT` SQL'e; liste sorgusundaki
     `$regex`/noktalı yol koşulları için ifade indeksleri (`classification.decision`, `status`, `updatedAt`).
   - Gerekli: staging Postgres (bu makinede yok). Doğruluk PGlite fark testiyle (`tests/postgres-store.test.ts`), hız gerçek Postgres'te ölçülmeli.
   - Kabul: 50.000 kayıtta `GET /api/jobs?page=1` < 200 ms ve dosya sürücüsüyle aynı sayfa.
2. **Çoklu kadro — üniversite ve bakanlık tabloları.**
   - Durum: yalnız mahalli idare tablosu (`src/extraction/openings.ts`).
   - Gerçek örnekler depo dışında: Akdeniz Üniversitesi (RG 20.10.2026-4-9), Sayıştay (16.10-4-1), Ankara BB (15.10-4-8).
   - Kural aynı: başlık doğrulanmadan satır okunmaz, sıra bozuksa tablo yok, her satır kanıtlı.
3. **İŞKUR kaynakları.**
   - Durum: statik HTML'de liste yok → `parse-failure` (07 §8). robots `/api/` ve `/*?*` yasak.
   - Seçenekler: resmî veri kanalı/izin; ya da `SOURCE_BROWSER_FALLBACK` ile tarayıcı (robots'a uygunluk ayrıca incelenmeli).
4. **ilan.gov.tr staging izni.** Birincil resmî kaynak; `src/config/staging.ts` allowlist'inde yok. Şartlar incelenip (K8) eklenirse gerçek recall ölçülebilir.

### P2
5. **R-13 OCR.** RG örneğinde PDF'lerin %31'i metin katmansız; bugün `documentTextMissing` ile incelemeye düşüyor.
6. **"DÜZELTME İLANI" / "İlan Açıklama Metni".** Bursa Uludağ örneklerinde (RG 17.10-4-12, 20.10-4-5) ret alıyor; düzeltme sinyali (`detectWithdrawalSignal`) hedef ilana bağlanmalı, aksi hâlde incelemeye.
7. **R-12/R-17 varsayılan liste.** Süreç duyuruları ve kapanan ilanlar varsayılan listede; ürün kararı sonrası `tests/kind-api.test.ts` güncellenir.

### P3
8. **R-11** hız sınırı sayacı DB'de → atomik/önbellek.
9. **R-15** CI'da haftalık `npm audit` / Dependabot.
10. **Windows yerel test hataları (9):** `.gitattributes` ile CSS/PDF fixture `eol=lf`; `staging-capture` testlerinde alt süreç çıkış kodu; `db-tls-doctor` yol genişletme.

## 4. Çalışma kuralları (bu depoda öğrenilenler)

- **Doğrulama:** Her düzeltme için testi eski koda karşı da koş (mutasyon kontrolü); geçmiyorsa test hatayı yakalamıyordur.
- **Sınıflandırma değişikliği:** `tests/classification*.test.ts` + 81 il taraması + depodaki 206 kayıtlık derlem farkı; karar değişimleri tek tek incelenir.
- **Gerçek veri:** fixture'a yalnız kurumsal metin; ihale yasaklama kararları kişi/şirket adı içerir → commit edilmez. `humanVerified: false` yazılır.
- **Canlı koşum:** `npm run staging:capture -- --source=<key> --live --max-requests=… --min-delay-ms=1500`; veri `.staging/` (git dışı); üretim DB anahtarları tanımlıysa komut reddeder.
- **Arka plan testleri:** ayrı worktree'de koş; aynı klasörde dal değiştirmek koşumu geçersiz kılar.
- **PR birleştirme:** CI success + `--match-head-commit`; birleştirme dağıtım tetiklemez (dağıtım elle `wrangler deploy`).
- **Belge düzenleme:** kaçış dizileri (`\b`, `\w`) içeren metni script dosyası ya da düzenleme aracıyla yaz; denetim karakteri taraması: `git grep -lP "[\x00-\x08\x0b\x0c\x0e-\x1f]" -- docs`.

## 5. Yerel çalışma alanı (depo dışı)

| Yol | İçerik | Not |
| --- | --- | --- |
| `D:\coding\claude\HANDOFF.md` | Kısa devir notu | Bu belgeye işaret eder |
| `D:\coding\claude\kamuradar` | Çalışma klonu (`main`) | |
| `D:\coding\claude\kamuradar-main` | Yardımcı worktree | `node_modules` asıl klona junction; silerken önce junction'ı kaldır |
| `D:\coding\claude\rg-check` | RG dizin sayfaları, PDF'ler, metinler, değerlendirme çıktıları | Kişi adı içerebilir; commit etme |
| `D:\coding\claude\kn-research` | KadroNerede herkese açık sayfa örnekleri | Yalnız gözlem kanıtı |
| `D:\coding\claude\source-terms.approved.local.json` | Onaylı RG + İŞKUR şartları | Canlı koşumda `config/source-terms.json` yerine geçici kopyalanır, sonra geri alınır |
| `D:\coding\claude\Kamuİlan` | Eski `main` (`4fd9acb`) kopyası, git değil | Güncel değil |

## 6. Bir sonraki oturumun ilk 5 adımı

1. `git -C D:\coding\claude\kamuradar pull` → `main` = `4c15843` ya da sonrası; `gh pr list` → #51 (ve sonraki docs/kod PR'ları).
2. Bu belge §00 + README §11 + 03 (R-03, R-04, R-13) + 14 oku; 2. bölümdeki kararlardan hangilerinin verildiğini sor.
3. `npm ci && npm run typecheck && npm run lint && npx vitest run` → 0 başarısız beklenir (Windows hataları #45 ile kapandı).
4. Karar yoksa 3. bölümdeki P1 listesinden sıradaki işi ayrı dalda yap; mutasyon kontrolü + tam paket + PR.
5. Oturum sonunda bu belgenin 1–3. bölümlerini güncelle.
