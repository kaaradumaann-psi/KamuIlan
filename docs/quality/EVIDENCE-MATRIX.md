# Kanıt matrisi (iddia → komut → gerçek sonuç → sınır)

**Tarih:** 2026-10-17 · **Ağaç:** `ee45a23` + bu dalın commit edilmemiş/commit
edilecek değişiklikleri · **Ortam:** Linux sandbox + sahte/loopback ağ.

> Kural: Aşağıdaki **PASS** yalnızca yazılı komutun kapsamı içindir. "Yeşil test"
> canlı kaynağın çalıştığını, AI'ın doğru olduğunu veya güvenliğin tam olduğunu
> kanıtlamaz. PASS / BLOCKED / NOT RUN / INSUFFICIENT DATA / UNKNOWN ayrıdır.

| # | İddia | Komut | Gerçek sonuç | Tarih | Commit | Sınır |
|---|---|---|---|---|---|---|
| 1 | Çevrimdışı doğrulama geçiyor | `npm run verify:all` | **PASS** 9/9, exit 0 | 2026-10-17 | `ee45a23` (+dirty) | Ağ/LLM/DB/e-posta kapalı; E2E dahil değil |
| 2 | Testler geçiyor | `npm test` | **113 dosya / 1360 test PASS** | 2026-10-17 | `ee45a23` (+dirty) | Mock/fake ağ; canlı TLS değil |
| 3 | Kapsam ölçüldü | `npm run test:coverage` | stmts %77,51 · branch %67,91 · funcs %73,86 · lines %80,08 | 2026-10-17 | `ee45a23` (+dirty) | Kapsam ≠ doğruluk; `mongo-store` %0,86 |
| 4 | Tip/lint/build temiz | `npm run typecheck && npm run lint && npm run build` | PASS (verify:all içinde) | 2026-10-17 | `ee45a23` (+dirty) | Statik; çalışma zamanı güvenliği değil |
| 5 | Bağımlılık açığı yok | `npm audit --json` | 0 advisory (tüm seviyeler) | 2026-10-17 | `package-lock.json` | Bilinen advisory'ler; SAST değil |
| 6 | Depoda sır yok (desen taraması) | `git ls-files -z \| xargs -0 grep -IlE 'AIza…|sk-…|PRIVATE KEY|re_…'` | Yalnız test CA anahtarları + kasıtlı sahte test değerleri | 2026-10-17 | `ee45a23` | Desen tabanlı; tam güvence değil |
| 7 | PR #22 CI yeşil | `gh pr view 22 --json statusCheckRollup` | İki `verify` kontrolü **SUCCESS** | 2026-10-17 | merge `ee45a23` | CI E2E'yi çalıştırır; canlı kaynak/LLM yok |
| 8 | Staging kuru çalışması güvenli | `npm run staging:capture -- --source=resmigazete-cestili-ilanlar --dry-run` | exit **0**, 0 HTTP, 0 DB yazımı, rapor yazıldı | 2026-10-17 | `ee45a23` (+dirty) | Kuru çalışma; canlı erişim değil |
| 9 | Staging kapıları çalışıyor | `npx vitest run tests/staging-capture.test.ts` | 5/5 PASS (allowlist, ToS, prod DB, TLS, dry-run) | 2026-10-17 | `ee45a23` (+dirty) | Alt süreç testleri; gerçek WAF/robots değil |
| 10 | ToS/robots kapısı | `tests/source-terms.test.ts` + `config/source-terms.json` | 6/6 PASS; depodaki 4 kayıt **unknown** | 2026-10-17 | `ee45a23` (+dirty) | İnsan incelemesi yapılmadı; canlı koşum kapalı |
| 11 | Kaynak sözleşmesi | `npm run sources:report -- --static --json` | 28 tanım / 24 etkin / 10 adaptör / 0 fixture / 4 planlı | 2026-10-17 | `ee45a23` | Statik; HTTP/sağlık/ilan sayısı değil |
| 12 | Sınıflandırma ölçümü | `npm run eval:classification` | 17 `spec-title`, **0 gerçek-insan** → INSUFFICIENT DATA | 2026-10-17 | `ee45a23` | Sentetik başlık regresyonu; gerçek doğruluk değil |
| 13 | Alan çıkarımı ölçümü | `npm run eval:extraction` | 17 toplam, **0 gerçek** → INSUFFICIENT DATA; 0 LLM/0 ağ | 2026-10-17 | `ee45a23` (+dirty) | İnsan etiketi yok; yüzde üretilmedi |
| 14 | Varsayılan AI kapalı | `npm run verify:all` → `llm-doctor-offline.json` | `usedCalls: 0`; classifier/assistant `attempted: false` | 2026-10-17 | `ee45a23` (+dirty) | Çevrimdışı yapılandırma; canlı model kalitesi değil |
| 15 | Model fiyatı | Resmî doküman okuması | `gemini-3.1-flash-lite`: $0,25/$1,50 (1M; preview) | 2026-10-17 | — | Fatura değil; fiyat değişebilir; canlı çağrı yok |
| 16 | E2E | `npm run test:e2e` | **BLOCKED** — Chromium yok | 2026-10-17 | `ee45a23` | Bu sandbox'ta çalıştırılmadı; CI sonucu ayrı |
| 17 | Canlı kaynak | `curl -sI https://www.resmigazete.gov.tr/ilanlar` | **BLOCKED** — TLS `SSL_ERROR_SYSCALL` | 2026-10-17 | — | Tek deneme; tekrar edilmedi |
| 18 | Canlı AI/e-posta/DB | — | **NOT RUN** | — | — | Anahtar/ortam yok; iddia edilmez |
| 19 | CodeQL/SAST | — | **NOT RUN** (iş akışı yok) | — | — | `npm audit`/tip/lint yerine geçmez |
| 20 | Postgres RLS / gerçek Mongo | — | **NOT RUN** | — | — | Ortam yok; "doğrulandı" denmez |
| 21 | Windows PowerShell runbook | — | **NOT RUN** (bu Linux sandbox) | — | — | Komutlar operatörde çalıştırılmalı |

## Bu matrisin kanıtlamadığı şeyler

- "Tüm ilanlar toplanıyor" veya "kaynak çalışıyor" — canlı HTTP yok.
- "AI doğru" — insan etiketli gerçek veri yok; canlı model çağrısı yok.
- "Güvenli" — SAST/DAST/RLS/gerçek TLS testi yok; yalnızca sınırlı statik
  kontroller ve 0 advisory var.
- "E2E geçti" — yerel Chromium yok; yalnızca PR #22 CI kaydı var.

## Yeniden üretim sırası

```powershell
npm ci
npm run verify:all                 # rapor: artifacts/verify-all/<zaman>/report.json
npm run eval:extraction            # INSUFFICIENT DATA beklenir
npm run staging:capture -- --source=<izinli-kaynak> --dry-run
```

Artefakt: `artifacts/verify-all/2026-10-17T17-52-02-596Z/report.json`
(bu satır son çalıştırmayla güncellenir).
