# Kaynak kalitesi paneli — katmanlar ve dürüstlük kuralları

**Durum:** API alanları ve saf sınıflandırma kodu mevcut ve testli. Canlı kaynak
verisi **yok** (ağ BLOCKED); aşağıdaki örnekler kod sözleşmesidir, gerçek
tarama sonucu değildir.

## 1. Katmanlar birbirine karıştırılmaz

| Katman | Alan | Ne kanıtlar? | Ne kanıtlamaz? |
|---|---|---|---|
| Envanter | `status`, `enabled`, `verified` | Kaynak tanımı var / canlı doğrulama kaydı var | Şu an erişilebilir olduğunu |
| Adaptör | `built`, `adapterKey`, `method` | Kod yolu kayıtlı | Seçicinin hâlâ doğru olduğunu |
| HTTP | `lastHttpStatus`, `lastErrorType` | Son isteğin durumu | Sayfanın tamamının okunduğunu |
| Listeleme/kapsam | `lastRun.coverageStatus`, `coverageNote` | Adaptörün beyan ettiği kapsam | Bağımsız doğrulanmış tamlık |
| Detay/PDF | Staging raporunda `http.textFetchesMade` / `binaryFetchesMade` | Kaç belge denendiği | Kaçının ayrıştırıldığı |
| Kayıt | `lastDiscoveredCount`, `lastAcceptedCount`, `lastRejectedCount`, `lastReviewCount` | Ham/giren/elenen/inceleme sayısı | Doğruluk veya mükerrerlik oranı |
| Yeni/benzersiz | `jobsCreated`, `itemsMerged` (koşum) | Yeni iş kaydı / birleşme | Kapsamın tam olduğunu |
| 0 sonuç nedeni | `observation.zeroResultReason` | `not-run` / `not-observed` / `blocked` / `parse-failure` / `unknown` | `confirmed-empty` (insan onayı ister) |
| Son tam başarı | `lastSuccessAt`, `coverage=complete` | En son başarılı tam koşum | Bugün de aynı sonucu |
| Hata/retry | `consecutiveFailures`, `lastErrorMessage` | Tekrarlayan arıza | Kök nedeni |
| robots/ToS | `config/source-terms.json` | İnsan inceleme kararı | Worker'ın otomatik uyduğunu |

> **Kural:** HTTP 200, `verified`, `lastSuccessAt`, adaptör kaydı veya statik
> envanter **tek başına "kaynak çalışıyor" demek değildir.** Bu ifadeler ayrı
> ayrı ve tarihli gösterilir.

## 2. API sözleşmesi

`GET /api/sources` her kaynak için `observation` döndürür:

```json
{
  "inventoryStatus": "verified",
  "adapterRegistered": true,
  "lastHttpStatus": 200,
  "lastErrorType": null,
  "discoveredCount": 0,
  "acceptedCount": 0,
  "coverage": "complete",
  "zeroResultReason": "not-observed",
  "lastFullSuccessAt": "2026-10-17T10:00:00.000Z",
  "unexpectedZero": false,
  "confirmedEmpty": false,
  "disclaimer": "Envanter/adaptör/HTTP kaydı tek başına ..."
}
```

Sınıflandırma `src/sources/observation.ts` içinde saf fonksiyondur; 6 birim
testi vardır (`tests/source-observation.test.ts`):

- hiç koşmadı → `not-run`
- sonuç var → `null`
- yapı hatası → `parse-failure`
- 401/403/429/5xx → `blocked`
- failed/skipped/locked → `unknown`
- success + complete + 0 → `not-observed` (**otomatik `confirmed-empty` yok**)

## 3. Adaptör fixture regresyonu ve seçici değişimi

- Her adaptörün fixture'ı `fixtures/html/manifest.json` içinde kaynak + tarih +
  HTTP + SHA-256 + redaction notu ile doğrulanır (`tests/source-inventory.test.ts`).
- **Beklenmeyen 0 kart** sinyali iki yerde:
  1. `health.unexpectedZero` (ilk iki koşumda zayıf; ilk çalıştırma + seçici
     değişimi sessiz kalabilir — bilinen sınır),
  2. staging raporu (`not-observed` / `parse-failure` / `blocked`).
- **Seçici değişimi otomatik tespiti yoktur.** Bir sonraki adım, her adaptör için
  "beklenen minimum kart sayısı + zorunlu alan" fixture iddiası eklemektir.
  Bu yapılmadan "seçici izleniyor" denmez.

## 4. Bilinen boşluklar (açıkça)

1. Sayfalama/detay/PDF sayıları **koşum başına veritabanına yazılmıyor**;
   yalnızca staging raporunda ve adaptör notlarında (18 ile sınırlı) var.
2. `unexpectedZero` ilk iki koşumda güvenilir değil.
3. robots/ToS kapısı **worker** yolunda zorunlu değil; yalnızca operatör staging
   komutunda zorunlu (`docs/limitations.md`).
4. Gerçek fixture yoksa `fixtureManifest.status = none`; bu "test edildi" değil,
   **açık boşluk** demektir.
5. Panelde kaynak başına "son 20 koşum" API'de var (`/api/sources/:key/status`),
   ancak UI'da ayrı sayfalama grafiği yok.

## 5. Doğrulama

```powershell
npm run sources:report -- --static --json
npx vitest run tests/source-inventory.test.ts tests/source-observation.test.ts
```

Statik çıktı 28 kaynak / 24 etkin / 10 adaptör / 0 fixture / 4 planlıdır
(2026-10-17). Canlı HTTP, ilan sayısı ve doğruluk **NOT RUN**.
