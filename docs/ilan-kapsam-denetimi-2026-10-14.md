# İlan çekim kapsamı uçtan uca denetimi — 14 Ekim 2026

**Dal:** `arena/e2992e7e-kamuradar`
**Kapsam sorusu:** "Her ilanı düzgün şekilde çekiyor mu? Sayfalardaki ilk ilanları mı çekiyor? İkinci sayfasına geçiyor mu, o ilanları çekiyor mu? İlan çekmediği sayfa var mı?"
**Yöntem:** (a) tüm tarama hattının kod denetimi (adaptörler → sayfalama → bütçe → tekilleştirme → sınıfıflandırma → kayıt → tarama belleği), (b) her adaptör ailesi için çok sayfalı sahte kaynaklarla çevrimdışı uçtan uca simülasyon (`npm run audit:drain`), (c) gerçek adaptör + gerçek hatt + gerçek detay bütçesiyle çok koşumlu regresyon testleri (`tests/list-drain.test.ts`).
**Canlı ağ notu:** Bu ortamdan Türkiye'deki resmî kaynaklara erişim kapalı (yalnız GitHub/npm/pypi); bu yüzden canlı doğrulama (`npm run test:live`) burada **çalıştırılamadı**. Aşağıdaki kanıtlar fixture tabanlı simülasyon ve kod denetimine dayanır. Canlı doğrulama, ağ erişimi olan bir kurulumda `npm run test:live` ile tekrarlanmalıdır.

---

## 1. Kısa cevaplar

| Soru                                | Cevap                                                                                                                                                                                                                                                                    | Kanıt                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 2. ve sonraki sayfalara geçiyor mu? | **Evet.** 6 listenin tamamı sayfaları takip ediyor: ilan.gov.tr `currentPage=N` ile 20 sayfaya kadar; İŞKUR/kurum/MEB adaptörü ortak `detectNextPage` ile 10 sayfaya kadar; ÖSYM 10, SBB 10, Kariyer Kapısı 10, Resmî Gazete gün başına 10 sayfa.                        | §3 senaryo 1, `tests/sources.test.ts`, `tests/pagination.test.ts`    |
| 2. sayfadaki ilanları çekiyor mu?   | **Evet** — sayfa keşfi ve kayıt tam. Simülasyonda 3 sayfadaki 13/13, 2. sayfadaki 2/2, 1/1, 1/1 ilan alındı.                                                                                                                                                             | §3 senaryo 1                                                         |
| Sadece ilk ilanları mı çekiyor?     | **Keşifte hayır; İŞLEMEDE bir bütçe sınırı var:** her koşumda kaynak başına en fazla 8 detay işlenir (html-list). Fazlası "ertelenir" ve sonraki koşumlarda tamamlanır (8+8+4 = 20/20 senaryosu doğrulandı).                                                             | §3 senaryo 2                                                         |
| İlan çekilmeyen sayfa var mı?       | **Düzeltme ÖNCESİ kritik bir açık vardı:** 1. sayfada 8+ ihale/sonuç duyurusu varsa, bunlar her koşumda yeniden "yeni" sayılır ve 8'lik detay bütçesinin tamamını yutardı → 2. sayfadaki gerçek personel alım ilanları **hiçbir koşumda** çekilmezdi. Düzeltildi (§2.1). | §3 senaryo 3 (düzeltme öncesi 4 koşumda 0/3, sonrası 2. koşumda 3/3) |

## 2. Bulgular

### 2.1 KRİTİK — Ret/inceleme kayıtları tarama belleğine yazılmıyordu (açlık / starvation)

**Belirti (kullanıcı hissi):** "Sanki sadece ilk sıradaki ilanları çekiyor, ilerideki ilanlar gelmiyor."
**Kök neden:** `applyRawAnnouncement` yalnız kabul edilen kayıtlar için `jobSources` bağı yazıyordu. Reddedilen (ihale, sonuç, atama vb.) ve incelemeye alınan kayıtlar için bağıt oluşmadığından `loadKnownItemIds` bunları "görülmüş" saymıyordu. Adaptörün `selected = [...fresh, ...pendingDetail].slice(0, bütçe)` sıralaması sayfa sırasını izlediği için liste başındaki retler her koşumda 8'lik bütçenin tamamını yeniden kullanıyor; sayfa 2+'daki gerçek ilanlar süresiz "erteleniyordu". Aynı açık iptal/düzeltme sinyallerinde de vardı (her koşumda yeni sürüm yazılırdı).
**Kanıt (düzeltme öncesi `npm run audit:drain`):** 1. sayfada 8 ihale duyurusu, 2. sayfada 3 personel alımı ilanı olan kaynakta 4 koşum boyunca `reddedilen=8, birikim=0/11` — 2. sayfadaki 3 ilanın tamamı kayıp.
**Düzeltme:**

- Yeni `sourceItemDecisions` koleksiyonu (benzersiz `sourceKey+sourceItemId`, gövde metni varlığıyla birlikte) — ret/inceleme/sinyal kararları kalıcı tarama belleği olarak yazılır (`src/db/schemas.ts`, `src/db/indexes.ts`, `src/db/repos/jobs.ts`).
- `loadKnownItemIds` bu kayıtları da "görüldü" sayar; `loadKnownItemIdsWithDetail` yalnız gövde metni yakalanmış olanları "detaylı" sayar (metinsiz retler detay gelince yeniden değerlendirilebilir: ret→kabul düzeltmesi mümkün kalır).
- İptal/düzeltme sinyalleri artık hedef ilana bağlanan bir `jobSources` kaydı üretir; aynı sinyal tekrar geldiğinde yeni sürüm yazılmaz.
  **Doğrulama:** `tests/list-drain.test.ts` (7 test) + `npm run audit:drain` senaryo 3. Düzeltme sonrası: koşum 1 retleri belleğe alır, koşum 2'de 3/3 ilan yakalanır.

### 2.2 DÜŞÜK — Jenerik yol sonlu ilan kimliği çakışması

`/TR-120694/duyuru-detay` gibi URL'lerde kimlik `duyuru-detay` sayılıyordu; listedeki TÜM ilanlar aynı `sourceItemId`'yi alıp yalnız ilki işlenebilirdi (kalanlar sessizce kaybolurdu). Düzeltildi: yol sonu rakamsızsa kimlikteki önceki sayısal segment (`TR-120694`) kimliğe katılır (`src/sources/adapters/anchor-list.ts`). Regresyon testi: `/TR-<id>/duyuru-detay` iki farklı ilan → iki farklı kimlik.

### 2.3 Kasıtlı ve doğru davranışlar (ayıp değil, sınır olarak kayıtlı)

- **Detay bütçesi 8/koşum (html-list), 25/koşum (pdf-index):** pahalı indirmeleri sınırlar; fazlası ertelenir ve sonraki taramalarda tamamlanır (senaryo 2: 8+8+4 = 20/20). Yoğun günlerde bir kaynağın tüm yeni ilanları 2-3 koşumda toplanır.
- **Sayfa üst sınırları:** ilan.gov.tr 20, diğer listeler 10, Resmî Gazete gün başına 10 sayfa. Sınır aşılırsa kapsam `partial` olarak raporlanır (sessiz kırpma yok).
- **Kapsam dürüstlüğü:** son sayfa yalnız açık işaretle (devre dışı "Sonraki", kendine dönen rel="last", açık "sonuç bulunamadı") `complete` sayılır; aksi hâlde `unknown`. Yinelenen sayfa/tekrar eden kimlik döngüsü görülürse kapsam `unknown`'a düşer.
- **MEB RSS beslemesi:** JS ile yüklenen liste yerine resmî RSS okunur; RSS'in tüm arşiv olduğu doğrulanamaz → kapsam `unknown` olarak etiketli (bilinçli).
- **GIB/TÜİK/e-Şube:** JS kabuğu/oturum gerektirdiği için `enabled: false` + `needs-manual-method`; envanterde açıkça "kapsam dışı" duruyor.
- **SBB Kamu İlan:** bu ortamdan coğrafi kısıt (403) alıyor; kısıt **aşılmıyor**, kaynak erişilebilir olduğunda otomatik devreye girer.
- **304 (içerik değişmedi) yanıtları:** liste gezilmez → kapsam `unknown`; içerik değişmediği için veri kaybı yok.
- **`KNOWN_ITEMS_LOOKBACK = 5.000`:** bir kaynağın görülmüş kimlik belleği son 5.000 kayıtla sınırlı. Bu sayıyı aşan devasa arşivlerde eski kayıtlar "yeni" gibi yeniden değerlendirilebilir (kaynak başına pratik sınırın çok üstünde; not olarak kayıtlı).

### 2.4 Sınırlar (bu denetimde DOĞRULANMAYAN alanlar)

- **Canlı kaynak davranışı:** canlı sayfa yapıları, sayfalama işaretleri ve WAF/robots davranışı bu ortamdan doğrulanamadı. `npm run test:live` ağ erişimi olan kurulumda koşulmalı; `src/config/sources.ts` içindeki `verificationEvidence` tarihsel kanıtlardır.
- **Playwright E2E:** tarayıcı indirme CDN'i bu ortamdan erişilemediği için `npm run test:e2e` koşulamadı (önceki denetimde 12/12 geçmişti; GitHub Actions PR check'i ayrıca yeşil olmalı).
- **Üretim veritabanı:** `sourceItemDecisions` koleksiyonu şemaya eklendi (FileStore/Postgres/Mongo otomatik oluşturur). Üretimde migration (`npm run db:migrate`) bakım penceresinde doğrulanmalı. Sınıflandırma kural sürümü (`CLASSIFICATION_VERSION`) yükseltilirse eski ret kararları kasıtlı olarak yeniden değerlendirilmez; kural değişikliğinde karar kayıtları ayrıca temizlenmeli/yeniden tarama planlanmalıdır.

## 3. Uçtan uca simülasyon kanıtı (`npm run audit:drain`)

```
■ Sayfa keşfi: adaptörler 2. sayfaya geçiyor mu, o ilanları alıyor mu?
  ✓ anchor-list: 2 liste sayfası gezildi, sayfa 2'den 2/2 ilan alındı, kapsam=complete
  ✓ ilan.gov.tr: 4 sayfa istendi (currentPage=N), 3 sayfadaki 13/13 ilan alındı, kapsam=complete
  ✓ ÖSYM: 2 sayfa gezildi, sayfa 2 ilanı alındı, kapsam=complete
  ✓ SBB: 2 sayfa gezildi, sayfa 2 ilanı alındı, kapsam=complete

■ Drenaj: bütçe aşımında ertelenen ilanlar sonraki koşumlarda tamamlanıyor
  Koşum 1: birikim=8/20 → Koşum 2: 16/20 → Koşum 3: 20/20
  ✓ 20 ilanın tamamı 3 koşumda (8+8+4) yakalandı; ertelenen ilan kaybolmadı.

■ Açlık: 1. sayfa retlerle dolu, 2. sayfada gerçek ilanlar
  Koşum 1: 8 ret işlendi → Koşum 2: 2. sayfadaki 3/3 ilan yakalandı
  ✓ (düzeltme öncesi bu senaryo 4 koşumda 0/3 ile KALIYORDU)
```

## 4. Yerel doğrulama listesi

- `npx vitest run` → **41 dosya / 397 test geçti** (önceki 390 + yeni 7 regresyon testi).
- `npm run typecheck` → geçti. `npm run lint` → geçti. `npx vite build` → geçti.
- `npm run audit:drain` → 3/3 senaryo geçti (konsol kanıtı §3).

## 5. Değişen dosyalar

| Dosya                                       | Değişiklik                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/db/schemas.ts`, `src/db/indexes.ts`    | Yeni `sourceItemDecisions` koleksiyonu + benzersiz indeks                             |
| `src/db/repos/jobs.ts`                      | `recordSourceItemDecision` / `listSourceItemDecisions` / `findSourceItemDecision`     |
| `src/ingest/jobs-service.ts`                | Ret/inceleme kararlarının belleğe yazılması; iptal sinyallerinin kaynak bağı üretmesi |
| `src/ingest/pipeline.ts`                    | `loadKnownItemIds(WithDetail)` karar kayıtlarını da kapsar                            |
| `src/sources/adapters/anchor-list.ts`       | Jenerik yol sonlu kimlik çakışması düzeltmesi                                         |
| `scripts/audit-list-drain.ts`               | Yeni çevrimdışı kapsam/drenaj denetim aracı (`npm run audit:drain`)                   |
| `tests/list-drain.test.ts`                  | 7 regresyon testi (açlık, drenaj, karar belleği, sinyal idempotentliği, kimlik)       |
| `infra/mongo/init-mongo.js`, `package.json` | Koleksiyon listesi + npm script                                                       |
