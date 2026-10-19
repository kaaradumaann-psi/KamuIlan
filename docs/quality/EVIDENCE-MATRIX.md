# Kanıt matrisi (iddia → komut → gerçek sonuç → sınır)

**Tarih:** 2026-10-19 · **Ağaç:** `639318d` (PR #23 merge) + bu dalın doğrulama
sonrası commit edilecek değişiklikleri · **Ortam:** Linux sandbox; dış ağ yok,
LLM/e-posta/Telegram/üretim DB anahtarı yok.

> Kural: Aşağıdaki **PASS** yalnızca yazılı komutun kapsamı içindir. "Yeşil test"
> canlı kaynağın çalıştığını, AI'ın doğru olduğunu veya güvenliğin tam olduğunu
> kanıtlamaz. PASS / BLOCKED / NOT RUN / INSUFFICIENT DATA / UNKNOWN ayrıdır.
> Makine etiketi altın etiket değildir.

| # | İddia | Komut / kanıt | Gerçek sonuç | Tarih | Commit / artefakt | Sınır |
|---|---|---|---|---|---|---|
| 1 | Çevrimdışı doğrulama geçiyor | `npm run verify:all` | **PASS** 10/10 adım, exit 0 | 2026-10-19 | `639318d` (+değişiklikler) · `artifacts/verify-all/2026-10-19T12-07-20-195Z/` | Ağ/LLM/DB/e-posta kapalı; canlı doğruluk değil |
| 2 | Testler geçiyor | `npm test` (verify içinde) | **114 dosya / 1373 test PASS** | 2026-10-19 | aynı artefakt | Mock/fake ağ; canlı TLS değil |
| 3 | Kapsam ölçüldü | `npm run test:coverage` | stmts **%77,54** · branch **%68,03** · funcs **%73,89** · lines **%80,11** | 2026-10-19 | aynı artefakt | Kapsam ≠ doğruluk |
| 4 | Tip/lint/build temiz | `typecheck` / `lint` / `build` | PASS (10 adımın 1, 2, 5'i) | 2026-10-19 | aynı artefakt | Statik; çalışma zamanı güvenliği değil |
| 5 | Bilinen bağımlılık açığı yok | `npm audit --omit=dev --json` | info/low/moderate/high/critical **0** | 2026-10-19 | `package-lock.json` | Yalnız advisory; SAST değil |
| 6 | Depoda bilinen sır deseni yok | `git ls-files -z \| xargs -0 grep -IlE …` | Yalnız 3 test CA anahtarı + `tests/llm-gemini.test.ts` sahte değerleri | 2026-10-19 | çalışma ağacı | Desen tabanlı; tam güvence değil |
| 7 | PR #22 birleşti | `gh pr view 22` | **MERGED** 2026-10-17T16:17:46Z, `ee45a23` | 2026-10-17 | merge `ee45a23` | Birleşme kodu; canlı doğruluk değil |
| 8 | PR #23 birleşti ve CI yeşil | `gh pr view 23` / `gh run view 39246728683` | **MERGED** 2026-10-19T11:43:43Z, `639318d`; CI **SUCCESS**, Playwright adımı dahil | 2026-10-19 | run `39246728683` | CI E2E ayrı satır 18 |
| 9 | Staging kuru çalışması güvenli | `npm run staging:capture -- --source=resmigazete-cestili-ilanlar --dry-run` | exit **0**, 0 HTTP, 0 DB yazımı, rapor yazıldı | 2026-10-19 | `.staging/…/staging-report.json` | Kuru çalışma; canlı erişim değil |
| 10 | Staging kapıları | `npx vitest run tests/staging-capture.test.ts` | **6/6 PASS**: allowlist, ToS, `DATABASE_URL`, prod DB, TLS, dry-run | 2026-10-19 | `tests/staging-capture.test.ts` | Alt süreç; gerçek WAF/robots değil |
| 11 | 0 sonuç başarı sayılmıyor | `tests/staging-report.test.ts` | **17/17 PASS**; doğrulanmamış 0 → `exit 6` | 2026-10-19 | `src/staging/report.ts` | Rapor sözleşmesi; canlı kaynak değil |
| 12 | ToS/robots kapısı staging'de var | `tests/source-terms.test.ts` + `config/source-terms.json` | **6/6 PASS**; depodaki 4 kayıt **unknown** | 2026-10-19 | `src/sources/terms.ts` | İnsan incelemesi yapılmadı |
| 13 | `test:live` da ToS kapısından geçiyor | `npx vitest run tests/live-check-terms-gate.test.ts` | **1/1 PASS**, exit **5**, HTTP istemcisi kurulmadı | 2026-10-19 | `scripts/live-check.ts` | Kapı testi; canlı erişim değil |
| 14 | Kaynak sözleşmesi | `npm run sources:report -- --static --json` | **28** tanım / **24** etkin / **10** adaptör / **0** fixture / 4 planlı | 2026-10-19 | `source-inventory.json` | Statik; HTTP/sağlık değil |
| 15 | Sınıflandırma ölçümü | `npm run eval:classification` | 17 `spec-title`, **0 gerçek-insan** → **INSUFFICIENT DATA** | 2026-10-19 | `classification-evaluation.json` | Sentetik regresyon; gerçek doğruluk değil |
| 16 | Alan çıkarımı ayrı ölçülüyor | `npm run eval:extraction` | 17 toplam, **0 gerçek**, 0 ölçülebilir, alan metriği yok → **INSUFFICIENT DATA** | 2026-10-19 | `extraction-evaluation.json` | İnsan etiketi yok; yüzde üretilmedi |
| 17 | Varsayılan AI kapalı | `llm-doctor-offline.json` | `usedCalls: 0`; classifier/assistant `attempted: false` | 2026-10-19 | aynı artefakt | Yapılandırma; model kalitesi değil |
| 18 | Model adayı ve fiyatı | Resmî Google docs (2026-10-19) | `gemini-3.1-flash-lite` **Stable**; 1.048.576/65.536; $0,25/$1,50 (1M) | 2026-10-19 | `AI-MODEL-COST.md` | Fatura değil; canlı çağrı **NOT RUN** |
| 19 | Yerel E2E | `npm run test:e2e` | **BLOCKED** — Chromium yok; çalıştırılmadı | 2026-10-19 | — | Bu sandbox; PASS sayılmaz |
| 20 | CI E2E | GitHub run `39246728683`, adım 14 | **SUCCESS** (`Uçtan uca testler`) | 2026-10-19 | `639318d` | CI ortamı; yerel sandbox değil |
| 21 | Canlı kaynak erişimi | `npm run test:live -- --live --source=osym-duyurular --max-requests=1 --max-pages=1 --max-details=0 --min-delay-ms=1000` | **1 HTTP denemesi / 0 kayıt / exit 1**; TLS `ECONNRESET` | 2026-10-19T11:59Z | `artifacts/live-check/live-check-2026-10-19T11-59-07-342Z.json` | Ağ sandbox'ı; **tek deneme**, tekrar edilmedi; kaynak sağlığı kanıtı değil |
| 22 | ToS kapısı canlı denemeden önce yoktu | Kod incelemesi + olay kaydı | `test:live` terms kapısını atlıyordu; 21. satır bu boşlukla yapıldı, şimdi **düzeltildi** (13) | 2026-10-19 | `scripts/live-check.ts` | Süreç bulgusu; gizlenmez |
| 23 | Çalışma zamanı güvenli varsayılanları | `npm run env:check` | `liveFetch:false`, `scheduler:false`, `browserFallback:kapalı`, TLS açık | 2026-10-19 | `src/config/env.ts` | Geliştirme ortamı; üretim değil |
| 24 | Gerçek insan etiketli küme | `tests/fixtures/eval/labeled-set.json` | **0 / 145**; 17 kayıt yalnız `spec-title`; kategori hedefleri karşılanmadı | 2026-10-19 | fixture | **INSUFFICIENT DATA**; insan emeği gerekir |
| 25 | Canlı AI/e-posta/DB | — | **NOT RUN** | — | — | Anahtar/ortam yok; iddia edilmez |
| 26 | CodeQL/SAST/DAST | — | **NOT RUN** (CodeQL iş akışı yok) | — | — | `npm audit`/tip/lint yerine geçmez |
| 27 | Postgres RLS / gerçek Mongo | — | **NOT RUN** | — | — | Ortam yok; "doğrulandı" denmez |
| 28 | Windows PowerShell runbook | — | **NOT RUN** (bu Linux sandbox) | — | `OPERATOR-POWERSHELL-RUNBOOK.md` | Operatörde çalıştırılmalı |

## Bu matrisin kanıtlamadığı şeyler

- "Tüm ilanlar toplanıyor" veya "kaynak çalışıyor" — canlı HTTP yok; tek deneme
  TLS hatasıyla bitti.
- "AI doğru" — 0 insan etiketli gerçek kayıt, 0 canlı model çağrısı.
- "Güvenli" — SAST/DAST/RLS/gerçek TLS testi yok; yalnızca sınırlı statik
  kontroller ve 0 bilinen advisory var.
- "145 kayıt tamam" — küme 0/145; sentetik 17 kayıt hedefe sayılmaz.
- "E2E geçti" — yalnızca CI'da geçti; bu sandbox'ta **BLOCKED**.

## Yeniden üretim sırası

```powershell
npm ci
npm run verify:all                 # rapor: artifacts/verify-all/<zaman>/report.json
npm run eval:classification
npm run eval:extraction            # INSUFFICIENT DATA beklenir
npm run staging:capture -- --source=<izinli-kaynak> --dry-run
```

Son doğrulama artefaktı:
`artifacts/verify-all/2026-10-19T12-07-20-195Z/report.json`.
