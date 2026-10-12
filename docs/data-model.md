# Veri modeli

Tüm koleksiyonlar `src/db/schemas.ts` içinde zod ile tanımlanır; **tek doğrulama
noktası** burasıdır (yazma sırasında `validateDocument` çağrılır). İndeksler
`src/db/indexes.ts`ten `npm run db:indexes` ile üretilir (44 tanım).

Kimlikler `createId(prefix)` ile üretilir (`src_`, `job_`, `usr_`, `eml_`...).
Tarihler ISO 8601 (UTC) saklanır; gösterim ve tarih yorumlama
**Europe/Istanbul** saat diliminde yapılır.

## Koleksiyonlar

| Koleksiyon | Amaç | Kritik alanlar | Benzersizlik |
| --- | --- | --- | --- |
| `sources` | Kaynak envanteri + sağlık | `key`, `adapterKey`, `status`, `verification{verified,built,...}`, `health{lastRunAt,lastSuccessAt,consecutiveFailures,...}`, `scrapeIntervalMinutes`, `allowHosts` | `key` |
| `jobs` | Kanonik ilan kaydı | `title`, `titleNormalized`, `institution`, `city`, `employmentType`, `status`, `applicationStartAt/EndAt/EndDate`, `quota`, `requirements{...}`, `classification{decision,...}`, `fieldSources`, `attachments`, `dedupeKey`, `normalizedUrl`, `provenance`, `version` | `dedupeKey`, `normalizedUrl` |
| `jobSources` | İlan ↔ kaynak bağlantıları | `jobId`, `sourceKey`, `sourceItemId`, `url`, `title`, `publishedAt`, `firstSeenAt`, `lastSeenAt`, `active`, `rawContentHash` | `(sourceKey, sourceItemId)` |
| `jobRevisions` | Değişiklik geçmişi | `jobId`, `version`, `changeTypes`, `changedFields`, `previous`, `current`, `summary` | `(jobId, version)` |
| `users` | Hesaplar | `email`, `emailNormalized`, `passwordHash/Salt/Algo`, `role`, `emailVerified`, `status` | `emailNormalized` |
| `sessions` | Oturumlar | `userId`, `tokenHash`, `csrfToken`, `expiresAt`, `lastSeenAt` | `tokenHash` |
| `tokens` | Doğrulama/sıfırlama/abonelik jetonları | `userId`, `type` (`email-verify`/`password-reset`/`unsubscribe`), `tokenHash`, `expiresAt`, `usedAt` | `(type, tokenHash)` |
| `notificationPreferences` | Tercihler | `userId`, `enabled`, `paused`, `mode` (`instant`/`daily-digest`), `onlyNewJobs`, `notifyOnChanges`, `filters{keywords,titles,institutions,cities,employmentTypes,educationLevels,departments,kpssScoreTypes,kpssMinScore,minDaysUntilDeadline}` | `userId` |
| `notificationEvents` | Bildirim olayları | `userId`, `jobId`, `kind` (`new-job`/`job-changed`), `jobVersion`, `idempotencyKey`, `status`, `matchedOn[]` | `idempotencyKey` |
| `emailOutbox` | Gönderim kuyruğu | `toEmail`, `subject`, `template`, `payload`, `status` (`pending/sending/accepted/failed/dead/suppressed`), `attempts`, `nextAttemptAt`, `claimedBy`, `leaseExpiresAt`, `acceptedAt`, `lastError`, `providerMessageId` | `idempotencyKey` |
| `scrapeRuns` | Tarama geçmişi | `sourceKey`, `trigger`, `status`, `startedAt/finishedAt/durationMs`, `itemsFound/Accepted/Rejected/Review`, `jobsCreated/Updated`, `itemsMerged`, `errorCount`, `errors[]`, `result`, `scheduleDelayMs` | — (indeks: `sourceKey+startedAt`) |
| `reviewQueue` | İnceleme kuyruğu | `kind` (`classification`/`dedupe`/`extraction`), `status`, `candidate`/`target` özetleri, `reason`, `resolution`, `resolvedBy` | — |
| `auditLogs` | Denetim kaydı | `actorId`, `actorEmail`, `action`, `target`, `details`, `createdAt` | — |
| `scheduledTasks` | Zamanlama durumu | `name`, `sourceKey`, `intervalMinutes`, `nextRunAt`, `lastRunAt`, `lastStatus`, `enabled` | `name` |
| `queueJobs` | Yerleşik kuyruk | `queue`, `name`, `payload`, `status`, `attempts`, `availableAt`, `lastError` | `dedupeKey` |
| `locks` | Kaynak kilitleri | `resource`, `owner`, `expiresAt`, `heartbeatAt` | `resource` |
| `workerHeartbeats` | Worker durumu | `workerId`, `role`, `status`, `lastHeartbeatAt`, `processedJobs` | `workerId` |
| `clusters` | Tekilleştirme kümeleri | `jobId`, `candidates[]`, `method`, `confidence` | — |
| `savedJobs` | Kullanıcı kayıtları (arayüz) | `userId`, `jobId`, `createdAt` | `(userId, jobId)` |
| `rateLimits` | Hız sınırı sayaçları | `key`, `count`, `windowStart`, `expiresAt` | `key` |

## Alan kaynakları (per-field provenance)

`jobs.fieldSources`, hangi alanın hangi kanıttan geldiğini tutar:

```json
{
  "applicationEndDate": { "kind": "listing", "snippet": "Son başvuru: 30.10.2026" },
  "quota":               { "kind": "detail",  "snippet": "Kontenjan: 25 kişi" },
  "city":                { "kind": "detail",  "snippet": "Görev yeri Ankara" }
}
```

`kind` değerleri: `listing` (kaynağın yapılandırılmış alanı), `detail` (ilan
metni/PDF), `unstated` (metinde yok). Arayüz her alanın yanında bu bilgiyi
gösterir; çıkarılamayan alanlar `null` kalır ve "belirtilmemiş" yazılır.

## Durum ve değişiklik sınıfları

- İlan durumu: `active` (başvuru açık), `upcoming` (henüz başlamadı), `closed`
  (süre bitti), `review` (belirsiz), `rejected` (kapsam dışı), `withdrawn` (iptal).
- Değişiklik sınıfları (`jobRevisions.changeTypes`): `new-job`, `deadline-changed`,
  `requirement-changed`, `quota-changed`, `closed`, `application-url-changed`,
  `withdrawn`, `source-added`, `merged`.

## Tekilleştirme sırası

1. Resmî ilan numarası (`originalRefNo`) aynıysa → aynı ilan.
2. Normalize edilmiş URL aynıysa → aynı ilan.
3. Kurum + unvan + dönem + başlık benzerliği eşik üstündeyse → **otomatik birleştirme
   yapılmaz**, inceleme kuyruğuna düşer (`dedupe`).
4. Yalnızca yönetici kararı birleştirir; birleştirmede tüm `jobSources` kayıtları ve
   sürüm geçmişi korunur, değişiklik sınıfı `merged` yazılır.

## Saklama ve temizlik

- Süresi geçmiş oturumlar, jetonlar, kilitler ve hız sınırı kayıtları worker'ın
  bakım işiyle temizlenir.
- `scrapeRuns` kayıtları kaynak sağlığı için gereklidir; uzun vadede arşivleme
  (ör. 90 günden eskileri ayrı koleksiyona taşıma) yapılabilir.
- `emailOutbox` içindeki `dead` kayıtlar yönetici panelinden incelendikten sonra
  silinebilir; otomatik silinmez.
