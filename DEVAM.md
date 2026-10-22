# DEVAM — kaynak/iskur-esube-rg-gecmis (WIP, 23.10.2026)

## Yapılanlar
- İŞKUR e-Şube adaptörü `src/sources/adapters/iskur-esube.ts` (registry: `iskur-esube-kamu`): GET form → kamuRadio postback → `btnNext` sayfalama (≤30), çerez bellekte, detay girişsiz `AcikIsIlanDetay.aspx?uiID=`. CAPTCHA/viewstate yoksa `SourceAccessError` (atlatma yok).
- Canlı deneme (23.10.2026, kimlikli UA, ≥5 sn): **Toplam Kayıt 90 = 90 satır, 6 sayfa, kapsam tam**, 9 istek hepsi 200; 2 detay okundu. Başlık "… işçi alımı (İŞKUR, il)" ile 90/90 `accept` (eski başlıkla 78 reject).
- Çok satırlı (TCDD il il) ilanlar: İŞKUR her il için ayrı ilan no veriyor → her satır ayrı RawAnnouncement (kendi il/kontenjan/son başvuru).
- `src/config/sources.ts` kaydı enabled, 150 dk, 5000 ms, robotsDisallow; `config/source-terms.json` allowed kaydı; docs eki; seed: manual-entry→otomatik adaptöre geçişte enabled/aralık bir kez uygulanır (`src/db/repos/sources.ts`).
- Fetcher: `formBody` (x-www-form-urlencoded), set-cookie `\n` ile birleşir.
- RG geri tarama: `src/sources/adapters/resmigazete-backfill.ts` + `resmigazete.ts`; env `RG_BACKFILL_DAYS` (0=kapalı, ≤120), `RG_BACKFILL_DAYS_PER_RUN` (vars. 3). İlerleme `sources.adapterState.rgBackfill` (anchorDate sabit, doneDates, skippedDates 3 denemede, completedAt → bir daha istek yok); pipeline yalnız hatasız koşumda yazar. Olağan günlerden sonra kalan PDF bütçesiyle; RG istek aralığı ≥2 sn. `.env.example` yeniden üretildi.
- Testler: `tests/iskur-esube-rg-geri-tarama.test.ts` (11 test, geçiyor) + fikstürler `tests/fixtures/kaynak-html/iskur-esube-*.html`; source-inventory (adapterCount 11) ve source-terms beklentileri güncellendi.

## Test durumu
- `tsc --noEmit` 0, `eslint src tests scripts functions` 0.
- `vitest run`: son tam koşuda yalnız alt süreç testleri (env-setup, eval-build-set, live-check-terms-gate, staging-capture) kırmızı — neden worktree'de `node_modules/tsx` yok (ortam); kod kaynaklı değil. source-inventory/source-terms düzeltmesi sonrası tam koşu doğrulanmadı.

## Sıradaki adımlar
1. Ana depoda (node_modules olan yerde) `npx vitest run` ile tam doğrulama.
2. PR aç (`gh pr create --base main`). Sunucuda geri tarama için `RG_BACKFILL_DAYS=60` ayarla.
