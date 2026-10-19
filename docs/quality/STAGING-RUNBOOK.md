# Tek kaynaklı staging koşumu (operatör)

**Amaç:** Tek bir resmî kaynağın sınırlı bir kesitini, üretim veritabanına ve
bildirim hatlarına dokunmadan, ölçülebilir bir istek bütçesiyle okumak.

**Ne DEĞİLDİR:** Canlı taramanın doğruluk kanıtı değildir. HTTP 200, ilan
kartlarının bulunması veya 0 sonuç; alan doğruluğu ya da kapsam tamlığı anlamına
gelmez. Canlı doğrulama ile etiket doğruluğu ayrı kanıt katmanlarıdır.

## 1. Güvenlik değişmezleri

| Kural | Nasıl uygulanır |
|---|---|
| Üretim DB kullanılmaz | `DATABASE_DRIVER` (file dışı), `POSTGRES_URL`, `DATABASE_URL`, `MONGODB_URI`, `MONGO_URL`, `PRODUCTION_DATABASE_URL` doluysa komut **çıkmadan durur** (exit 4). |
| Dosya deposu izoledir | Veri yalnızca `.staging/<kaynak>-<zaman>/data` altına yazılır; `.gitignore` kapsamındadır. |
| Tek kaynak | `src/config/staging.ts` allowlist'i dışındaki anahtar reddedilir (exit 3). |
| İki aşamalı opt-in | `--live` + `config/source-terms.json` içinde insan tarafından `allowed` işaretli kayıt gerekir (exit 5). |
| Bütçe | Tek paylaşımlı `HttpClient`: `--max-requests` (yönlendirme + retry dahil), `--max-pages`, `--max-details`, `--min-delay-ms`. `--max-pages > --max-requests` reddedilir. |
| Scheduler/worker yok | `SCHEDULER_ENABLED=0`; komut worker başlatmaz. |
| E-posta/Telegram yok | `EMAIL_PROVIDER=file`, SMTP/Telegram anahtarları silinir; bildirim kuyruğu kapatılır. |
| AI yok | `AI_ASSISTANT_ENABLED=0`, `LLM_CLASSIFIER_ENABLED=0`. |
| Tarayıcı yok | `SOURCE_BROWSER_FALLBACK=0`; Chromium başlatılmaz. |
| TLS açık | `NODE_TLS_REJECT_UNAUTHORIZED=0` reddedilir (exit 3). |
| Kuru çalışma varsayılanı | `--dry-run` ağa çıkmaz; DB dosyası bile açılmaz. |
| Snapshot ayrı adım | HTML/PDF kaydı bu komutun işi değildir; `fixtures:capture` ayrı insan onayı ister. |

## 2. Ön koşullar (PowerShell)

```powershell
git status --short          # temiz olmalı; değilse kendi değişikliklerinizi inceleyin
npm ci
npm run verify:all          # çevrimdışı, ücretsiz; PASS beklenir
```

`.env` dosyanızda `POSTGRES_URL`, `DATABASE_URL` veya `MONGODB_URI` **dolu
olmamalıdır** (komut bunları ve `MONGO_URL`/`PRODUCTION_DATABASE_URL`
aliaslarını da reddeder). Değerleri bana göstermeyin/göndermeyin; yalnızca bu değişkenleri
oturumdan kaldırın:

```powershell
Remove-Item Env:POSTGRES_URL -ErrorAction SilentlyContinue
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:MONGODB_URI -ErrorAction SilentlyContinue
$env:DATABASE_DRIVER = 'file'
```

## 3. Adım 1 — Kuru çalışma (ağ yok)

```powershell
npm run staging:capture -- --source=resmigazete-cestili-ilanlar --dry-run
```

Beklenen çıktı: `KURU ÇALIŞMA`, `host`, erişim şartları durumu ve rapor yolu.
Rapor: `.staging\<kaynak>-<zaman>\report\staging-report.json`.

## 4. Adım 2 — Erişim şartlarını insan olarak kaydet

`config/source-terms.json` içindeki ilgili kaydı **yalnızca** robots.txt ve
kullanım şartlarını gerçekten okuduktan sonra doldurun. Örnek:

```json
{
  "sourceKey": "resmigazete-cestili-ilanlar",
  "decision": "allowed",
  "reviewedAt": "2026-10-17",
  "reviewedBy": "operatör-adı-veya-rolü",
  "robotsUrl": "https://www.resmigazete.gov.tr/robots.txt",
  "termsUrl": "https://www.resmigazete.gov.tr/kullanim-sartlari",
  "allowsStorage": true,
  "notes": "robots.txt ilan yollarını engellemiyor; saklama/atıf koşulu not edildi"
}
```

- `decision: "unknown"` / `"blocked"`, `allowsStorage != true` veya 365 günden
  eski inceleme canlı koşumu durdurur.
- CAPTCHA, WAF, oturum duvarı veya hız sınırı **aşılmaz**. Engel görürseniz
  `blocked` yazın ve durun.
- Ayrıntılı kural seti: [SOURCE-TERMS.md](./SOURCE-TERMS.md).

## 5. Adım 3 — Sınırlı canlı koşum

```powershell
npm run staging:capture -- `
  --source=resmigazete-cestili-ilanlar `
  --live `
  --max-requests=5 `
  --max-pages=3 `
  --max-details=1 `
  --min-delay-ms=1500
```

`--max-requests` yönlendirme ve yeniden denemeleri kapsayan **toplam** HTTP
denemesidir. Daha büyük bir kesit isteniyorsa önce raporu okuyun; tek seferde
artırmayın. Aynı komutu ağ hatası nedeniyle tekrar tekrar çalıştırmayın.

## 6. Adım 4 — Raporu yorumlama

`staging-report.json` alanları:

| Alan | Anlamı |
|---|---|
| `mode` | `dry-run` / `live` |
| `http.requestsMade`, `redirectsMade`, `textFetchesMade`, `binaryFetchesMade` | Gerçekleşen HTTP denemeleri. Sayfa/detay ayrımı şu an **tek sayaçta** birleşiktir; PDF/ikili ayrıdır. |
| `run.itemsFound`, `itemsAccepted/Rejected/Review`, `jobsCreated/Updated` | Kayıt düzeyi sonuçlar. |
| `run.completion` | `complete` / `partial` / `unknown` (adaptörün kapsam beyanı). |
| `run.errorType` | `unavailable` / `structure` / `fetch` / `item` / `other`. |
| `zeroResultReason` | Aşağıdaki tablo. |
| `terms` | İnsan incelemesinin özeti; `reviewedBy/At`, `allowsStorage`. |
| `runErrorHash` | Ham hata metni yerine kısa hash; günlükte ayrıntı aranır. |

### 0 sonuç nedenleri

| Neden | Anlamı | Başarı sayılır mı? |
|---|---|---|
| `dry-run` | Ağa çıkılmadı. | Hayır |
| `not-observed` | Erişim/parse hatası yok ama 0 kart; kapsam doğrulanmadı veya boşluk beyan edilmedi. | **Hayır** |
| `confirmed-empty` | Kapsam `complete` **ve** operatör `--confirmed-empty` verdi. | Yalnızca "bu kesitte 0" |
| `blocked` | 401/403/429/5xx görüldü; kısıt aşılmadı. | Hayır |
| `parse-failure` | Adaptör yapı hatası: HTML/JSON değişmiş olabilir. | Hayır |
| `unknown` | Koşum çöktü/kilitli/atlandı; neden belirlenemedi. | Hayır |

HTTP 200 ve 0 kart **tek başına** başarı değildir. Doğrulanmamış 0 sonuç
`exit 6` ile biter; böylece CI/otomasyon boş sonucu yeşil saymaz. `confirmed-empty` bile
"kaynakta hiç ilan yok" demek değildir; yalnızca taranan kesitte 0 kart
görüldüğünü söyler.

## 7. Adım 5 — Etiketleme ve snapshot (ayrı adımlar)

Etiketleme sayfası üretimi (salt okunur):

```powershell
npm run eval:build-set -- --data-dir=.staging\<kosum>\data --out=.staging\<kosum>\worksheet.json --filter all --limit 60
```

HTML/PDF snapshot kaydı **ayrı** ve insan onaylıdır:

```powershell
npm run fixtures:capture -- --live --reviewed-public-data --source=resmigazete-cestili-ilanlar --max-bytes=5000000
```

Bu komut tek istek atar, PII maskeler ve `fixtures/html/` altına manifest +
sha256 yazar. Erişim şartlarında saklama izni yoksa çalıştırmayın.

## 8. Hata kodları

| Kod | Anlam |
|---:|---|
| 0 | Kuru çalışma; **veya** canlı koşumda en az bir ilan bulundu; **veya** kapsam `complete` + operatör `--confirmed-empty` verdi. |
| 1 | Canlı koşum çöktü / kaynak başarısız / kilitli / rapor yazılamadı. |
| 2 | Argüman veya dosya hatası. |
| 3 | Allowlist dışı kaynak, TLS kapatma girişimi veya NODE_ENV=test. |
| 4 | Üretim DB değişkeni dolu veya erişim şartları dosyası geçersiz. |
| 5 | İnsan incelemesi olmadan canlı koşum denemesi (`staging:capture` **ve** `test:live`). |
| 6 | Canlı koşum 0 ilan döndürdü ve neden `confirmed-empty` değil (`not-observed`, `blocked`, `parse-failure`, `unknown`). **Başarı değildir**; otomasyon yeşil saymamalıdır. |

`npm run test:live` de aynı erişim şartları kapısını uygular: onaysız kaynakta
hiçbir HTTP isteği yapılmadan exit 5 döner. CLI'nin kendi `--live`,
`--max-requests`, `--max-pages`, `--max-details` ve `--min-delay-ms` zorunlulukları
ayrıca geçerlidir.

## 9. Yapılmaması gerekenler

- `--live` ile `POSTGRES_URL`/`MONGODB_URI` aynı oturumda bırakmak.
- `start:worker` veya `SCHEDULER_ENABLED=1` ile staging verisini taramak.
- Gerçek kullanıcı e-postası/Telegram göndermek.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` yazmak.
- 0 sonucu "kaynak boş" diye raporlamak.
- Aynı canlı koşumu defalarca tekrarlamak.
