# Veri modeli

Tüm koleksiyonlar `src/db/schemas.ts` içinde zod ile tanımlanır; **tek doğrulama
noktası** burasıdır (yazma sırasında `validateDocument` çağrılır). İndeksler
`src/db/indexes.ts`ten `npm run db:indexes` ile üretilir (44 tanım).

Kimlikler `createId(prefix)` ile üretilir (`src_`, `job_`, `usr_`, `eml_`...).
Tarihler ISO 8601 (UTC) saklanır; gösterim ve tarih yorumlama
**Europe/Istanbul** saat diliminde yapılır.

## Koleksiyonlar

| Koleksiyon                | Amaç                                   | Kritik alanlar                                                                                                                                                                                                                                                                                                                                                                                                      | Benzersizlik                      |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `sources`                 | Kaynak envanteri + sağlık              | `key`, `adapterKey`, `status`, `verification{verified,built,...}`, `health{lastRunAt,lastSuccessAt,consecutiveFailures,...}`, `scrapeIntervalMinutes`, `allowHosts`                                                                                                                                                                                                                                                 | `key`                             |
| `jobs`                    | Kanonik ilan kaydı                     | `title`, `titleNormalized`, `institution`, `city`, `employmentType`, `status`, `applicationStartAt/EndAt/EndDate`, `quota`, `requirements{...}`, `classification{decision,...}`, `fieldSources`, sınırlı/redakte `textExcerpt`, arama için türetilmiş `textNormalized`, retained-excerpt `contentHash`, `attachments`, `dedupeKey`, `normalizedUrl`, `provenance`, `version`                                                                                                                                               | `dedupeKey`, `normalizedUrl`      |
| `jobSources`              | İlan ↔ kaynak bağlantıları             | `jobId`, `sourceKey`, `sourceItemId`, `url`, `title`, `publishedAt`, `firstSeenAt`, `lastSeenAt`, `active`, `capturedTextCharacterCount`, `capturedTextStatus`; kaynak gövdesi, `rawExcerpt` ve kullanılmayan gövde hash'i tutulmaz; eski değerler `db:migrate` ile temizlenir                                                                                                                                                                                                       | `(sourceKey, sourceItemId)`       |
| `jobRevisions`            | Değişiklik geçmişi                     | `jobId`, `version`, `changeTypes`, `changedFields`, `previous`, `current`, `summary`; metin snapshot'ları sınırlı/redakte tutulur ve göçte temizlenir                                                                                                                                                                                                                                                                | `(jobId, version)`                |
| `users`                   | Hesaplar                               | `email`, `emailNormalized`, `passwordHash/Salt/Algo`, `role`, `emailVerified`, `status`                                                                                                                                                                                                                                                                                                                             | `emailNormalized`                 |
| `sessions`                | Oturumlar                              | `userId`, `tokenHash`, `csrfToken`, `expiresAt`, `lastSeenAt`                                                                                                                                                                                                                                                                                                                                                       | `tokenHash`                       |
| `tokens`                  | Doğrulama/sıfırlama/abonelik jetonları | `userId`, `type` (`email-verify`/`password-reset`/`unsubscribe`), `tokenHash`, `expiresAt`, `usedAt`                                                                                                                                                                                                                                                                                                                | `(type, tokenHash)`               |
| `notificationPreferences` | Tercihler                              | `userId`, `enabled` (açık kullanıcı işlemi olmadan `false`), `paused`, `mode` (`instant`/`daily-digest`), `onlyNewJobs`, `notifyOnChanges`, `profilePersonalizationEnabled` (opt-in), `candidateProfile{profession,educationLevel,departments,skills,experienceYears}`, `filters{keywords,titles,institutions,cities,employmentTypes,educationLevels,departments,kpssScoreTypes,kpssMinScore,minDaysUntilDeadline}` | `userId`                          |
| `notificationEvents`      | Bildirim olayları                      | `userId`, `jobId`, `kind` (`new-job`/`job-changed`), `jobVersion`, `idempotencyKey`, `status`, `matchedOn[]`                                                                                                                                                                                                                                                                                                        | `idempotencyKey`                  |
| `emailOutbox`             | Gönderim kuyruğu                       | `toEmail`, `subject`, `template`, `payload`, `status` (`pending/sending/accepted/failed/dead/suppressed`), `attempts`, `nextAttemptAt`, `claimedBy`, `leaseExpiresAt`, `acceptedAt`, `lastError`, `providerMessageId`                                                                                                                                                                                               | `idempotencyKey`                  |
| `scrapeRuns`              | Tarama geçmişi                         | `sourceKey`, `trigger`, `status`, `startedAt/finishedAt/durationMs`, `itemsFound/Accepted/Rejected/Review`, `jobsCreated/Updated`, `itemsMerged`, `errorCount`, `errors[]`, `coverageStatus` (`complete/partial/unknown`), `coverageNote`, `result`, `scheduleDelayMs`                                                                                                                                              | — (indeks: `sourceKey+startedAt`) |
| `reviewQueue`             | İnceleme kuyruğu                       | `kind` (`classification`/`dedupe`/`extraction`), `status`, `candidate`/`target` özetleri, sınırlı/redakte `payload.excerpt` (yönetici kabul akışında kullanılır), `reason`, `resolution`, `resolvedBy`                                                                                                                                                                                                                                                                                      | —                                 |
| `auditLogs`               | Denetim kaydı                          | `actorId`, `actorEmail`, `action`, `target`, `details`, `createdAt`                                                                                                                                                                                                                                                                                                                                                 | —                                 |
| `scheduledTasks`          | Zamanlama durumu                       | `name`, `sourceKey`, `intervalMinutes`, `nextRunAt`, `lastRunAt`, `lastStatus`, `enabled`                                                                                                                                                                                                                                                                                                                           | `name`                            |
| `queueJobs`               | Yerleşik kuyruk                        | `queue`, `name`, `payload`, `status`, `attempts`, `availableAt`, `lastError`                                                                                                                                                                                                                                                                                                                                        | `dedupeKey`                       |
| `locks`                   | Kaynak kilitleri                       | `resource`, `owner`, `expiresAt`, `heartbeatAt`                                                                                                                                                                                                                                                                                                                                                                     | `resource`                        |
| `workerHeartbeats`        | Worker durumu                          | `workerId`, `role`, `status`, `lastHeartbeatAt`, `processedJobs`                                                                                                                                                                                                                                                                                                                                                    | `workerId`                        |
| `clusters`                | Tekilleştirme kümeleri                 | `jobId`, `candidates[]`, `method`, `confidence`                                                                                                                                                                                                                                                                                                                                                                     | —                                 |
| `savedJobs`               | Kullanıcı kayıtları (arayüz)           | `userId`, `jobId`, `createdAt`                                                                                                                                                                                                                                                                                                                                                                                      | `(userId, jobId)`                 |
| `rateLimits`              | Hız sınırı sayaçları                   | `key`, `count`, `windowStart`, `expiresAt`                                                                                                                                                                                                                                                                                                                                                                          | `key`                             |

### İlan metni ve kaynak gövdesi saklama sınırı

`JobDoc.textExcerpt` en çok 2.500 karakterlik, `makeExcerpt` ile e-posta/telefon
kalıpları redakte edilmiş kopyadır. Kod tüketicileri `src/db/repos/jobs.ts`
(ilan araması için `textNormalized`), `src/notifications/matcher.ts`,
`src/lib/profile-match.ts`, `src/ingest/dedupe.ts`,
`src/server/serializers.ts` ve `src/pages/JobDetail.tsx` içindedir; ayrıca ilan
servisi değişiklik tespiti için kullanır. Bu nedenle sınırlı metin ilan kaydında kalır. `textNormalized` aynı güvenli alıntıdan üretilir.
`contentHash` artık tam kaynak gövdesinden değil bu saklanan alıntı, başlık, son
tarih ve kontenjandan türetilir; imza veya kaynak doğrulama kanıtı değildir.

Kaynak bağı (`JobSourceDoc`) gövde saklamaz. `capturedTextStatus` yeniden detay
çekme kararında (`src/ingest/pipeline.ts`), karakter sayısı ise kamu ilan
detayındaki yakalama metaverisinde (`src/server/serializers.ts`) kullanılır.
`rawExcerpt` ve `rawContentHash` için etkin tüketici bulunmadığından yeni
kaynak bağına yazılmaz. `reviewQueue.payload.excerpt`, yönetici kabul akışında
(`src/server/routes/admin.ts`) yeniden ilan oluşturma için kullanılan en çok
1.500 karakterlik redakte alıntıdır; `jobRevisions` snapshot'larındaki ilan
alıntıları da geçmiş ekranına hizmet eder. `npm run db:migrate` kaynak bağı,
ilan, arama kopyası, kanıt parçaları, inceleme alıntıları ve revision snapshot'ları
idempotent biçimde düzeltir; dışarı alınmış yedekleri kapsamaz.

## Alan kaynakları (per-field provenance)

`jobs.fieldSources`, hangi alanın hangi kanıttan geldiğini tutar:

```json
{
  "applicationEndDate": { "kind": "listing", "snippet": "Son başvuru: 30.10.2026" },
  "quota": { "kind": "detail", "snippet": "Kontenjan: 25 kişi" },
  "city": { "kind": "detail", "snippet": "Görev yeri Ankara" }
}
```

`kind` değerleri: `listing` (kaynağın yapılandırılmış alanı), `detail` (ilan
metni/PDF), `unstated` (metinde yok). Arayüz her alanın yanında bu bilgiyi
gösterir; çıkarılamayan alanlar `null` kalır ve "belirtilmemiş" yazılır.

## Postgres (Supabase) karşılığı

Her koleksiyon `kamuilan_<koleksiyon>` adlı tek bir tablodur
(`kamuilan_jobs`, `kamuilan_job_sources`, `kamuilan_notification_preferences`…):

```sql
CREATE TABLE kamuilan_jobs (
  id          text PRIMARY KEY,              -- job_...
  data        jsonb NOT NULL,                -- belgenin tamamı (zod şeması doğrular)
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kamuilan_jobs_data_gin ON kamuilan_jobs USING gin (data jsonb_path_ops);
-- Envanterdeki benzersiz/ifade indeksleri (npm run db:indexes):
CREATE UNIQUE INDEX ... ON kamuilan_jobs ((data -> 'dedupeKey'));
```

Kurallar: şema tek doğruluk kaynağıdır (zod), SQL ön filtre sonrasında nihai karar
`matchesQuery` ile verilir, benzersiz indeksler yalnızca hız için değil veri
bütünlüğü içindir (iki worker aynı kaydı yazamaz), tüm güncellemeler satır kilidi
(`SELECT … FOR UPDATE`) altındadır. Bir koleksiyona yeni alan eklemek migration
gerektirmez; alan indeksten geçiyorsa `npm run db:indexes` yeterlidir.

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
