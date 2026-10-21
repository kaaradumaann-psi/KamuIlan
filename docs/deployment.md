# Dağıtım (üretim)

## Özet kontrol listesi

- [ ] `NODE_ENV=production`, `APP_SECRET` en az 32 karakter rastgele değer (sır yöneticisi)
- [ ] `DATABASE_DRIVER=supabase` + `POSTGRES_URL` (Supabase bağlantı dizesi, `POSTGRES_SSL=true`; `POSTGRES_SSL_MODE` boş ya da `verify`)
- [ ] `APP_DOMAIN=kamuilan.halilkaraduman.com.tr` + `APP_BASE_URL` (e-posta bağlantıları buradan üretilir)
- [ ] E-posta: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, **doğrulanmış** `EMAIL_FROM`
- [ ] `REDIS_URL` (isteğe bağlı; çok örnekli worker için önerilir)
- [ ] `ALLOW_PUBLIC_REGISTRATION=0` (dışarıdan kayıt kapalı; hesaplar davetle)
- [ ] Tarama sıklığı: testte `SCAN_INTERVAL_MINUTES=1`, üretimde `0` veya 30–360
- [ ] Ters vekil (reverse proxy) + TLS; API ve worker ayrı süreçler
- [ ] Ters vekil arkasındaysa `TRUST_PROXY=1` (yoksa istemci IP'si vekilin IP'si
      görünür; giriş hız sınırı yanlış hesaplanır)
- [ ] Arayüz API'yi başka bir alan adından çağırıyorsa `CORS_ORIGINS` (tam
      kaynak listesi); aynı alan adından çağırıyorsa **boş** bırakılır
- [ ] `DOCS_ENABLED=0` (Swagger `/api/docs` üretimde kapalı)
- [ ] İndeksler oluşturuldu (`npm run db:indexes`)
- [ ] Kaynak envanteri + zamanlanmış görevler yazıldı (`npm run db:migrate`)
- [ ] Yedekleme/geri yükleme denendi ([operations.md](./operations.md))
- [ ] Sağlık kontrolü izleniyor (`GET /api/health`)

Başlangıç doğrulaması: uygulama `src/config/env.ts` ile ortam değişkenlerini
doğrular; üretimde `RESEND_API_KEY` **ve** `SMTP_HOST` yoksa ya da dosya deposu
seçilmişse **başlatılmaz** (e-postanın/kaydın sessizce kaybolmasını engellemek için).

## Önerilen üretim topolojisi: Cloudflare + Supabase + Resend

```text
Kullanıcı → Cloudflare (kamuilan.halilkaraduman.com.tr, TLS, WAF, önbellek)
              ├── statik arayüz (npm run build → dist/)
              └── /api/*  → API süreci  ──► Supabase Postgres (kamuilan_* tabloları)
                                              ▲
                          worker (tarama + e-posta) ──► Resend HTTPS API
```

1. **Supabase**
   ```bash
   # Supabase → Project Settings → Database → Connection string
   DATABASE_DRIVER=supabase POSTGRES_URL='postgresql://...' npm run db:indexes
   DATABASE_DRIVER=supabase POSTGRES_URL='postgresql://...' npm run db:migrate
   ```
   `db:indexes` tabloları (`kamuilan_jobs`, `kamuilan_sources`, …), GIN indeksini
   ve envanterdeki benzersiz/ifade indekslerini kurar; idempotenttir ve API
   açılışında da çalışır. Servis rolü anahtarı yalnızca sunucuda tutulur.
2. **Arayüz (Cloudflare Workers + statik varlıklar)**

   ```bash
   npm run build                 # dist/
   npx wrangler deploy           # wrangler.jsonc ayarlarını kullanır
   npx wrangler secret put API_ORIGIN   # örn. https://api.kamuilan.halilkaraduman.com.tr
   ```

   `wrangler.jsonc` depodadır ve **panodaki üretim durumunu korur**
   (`workers_dev: false`, `routes` → `kamuilan.halilkaraduman.com.tr`). Dosya
   olmadan `wrangler deploy` uzak yapılandırmayı ezer: workers.dev adresi açılır
   ve özel alan adı düşer. Başka bir hesaba/zone'a yayınlıyorsanız `routes`
   bloğunu kendi alan adınızla güncelleyin.

   **SPA yönlendirmesi:** `assets.not_found_handling = "single-page-application"`.
   `_redirects` içindeki `/*  /index.html  200` kuralı Workers API'sinde "sonsuz
   döngü" sayılıp reddedilir (hata kodu 100324); bu yüzden kullanılmaz.

   **`/api` proxy'si ZORUNLUDUR.** `dist/` içinde API yoktur. Proxy kurulmazsa
   tarayıcı `/api/health` için statik varlık sunucusundan SPA gövdesini (HTML)
   alır, JSON bekleyen arayüz boş kalır. Depodaki `functions/api/[[path]].ts`
   bunu çözer: tüm yöntemleri, gövdeyi, çerezleri ve CSRF başlığını API sürecine
   aktarır; yalnızca ana makineye bağlı başlıklar ayıklanır. API'ye
   ulaşılamazsa **502 + JSON** döner (sessiz HTML yanıtı değil).

3. **API + worker**: ayrı süreçler olarak daimi bir ortamda (Cloudflare Container,
   VPS, Fly.io…) çalıştırılır: `npm run start` ve `npm run start:worker`.
4. **Resend**: alan adını doğrulayın (SPF/DKIM kayıtları DNS'te), `EMAIL_FROM`
   adresini o alan adından seçin. Test aşamasında Resend'in test modu gerçek
   alıcılara göndermez; üretim öncesi kendi adresinizle doğrulayın.

## Süreçler

| Süreç  | Komut                     | Not                                                 |
| ------ | ------------------------- | --------------------------------------------------- |
| API    | `npm run start`           | HTTP sunucusu; tarama YAPMAZ                        |
| Worker | `npm run start:worker`    | Zamanlayıcı + kuyruk tüketicisi + e-posta gönderimi |
| Arayüz | `npm run build` → `dist/` | Statik dosyalar (Nginx/CDN)                         |

Ayrı süreçler olması bilinçlidir: tarama/e-posta yükü API'yi yavaşlatmaz ve
worker yeniden başlatıldığında işler kaybolmaz (durum veritabanındadır).

## Alternatif: Docker Compose

```bash
cd infra/docker
docker compose up --build
```

Servisler: `mail` (mailpit: SMTP 1025, arayüz 1080), `api`, `worker`, `web`
(Vite dev sunucusu, 5173) ve isteğe bağlı `postgres` (`--profile postgres`).
MongoDB/Redis servisi YOKTUR: varsayılan sürücü dosya deposu ve yerleşik
veritabanı kuyruğudur. Tüm trafik göreli `/api` üzerinden proxy'lenir.

Üretim arayüz imajı:

```bash
docker build -f infra/docker/Dockerfile.web -t kamuilan-web .
docker run -p 8080:80 -e API_ORIGIN=http://api:3000 kamuilan-web
```

Nginx yapılandırması: `infra/docker/nginx.conf` (SPA yönlendirmesi, `/api`
proxy'si, güvenlik başlıkları, varlık önbelleği, gzip).

## Üretim kurulumu (örnek: systemd + Nginx)

1. **Kod ve bağımlılıklar**

   ```bash
   git clone <repo> /opt/kamuilan && cd /opt/kamuilan
   npm ci --omit=dev    # tarayıcı gerekiyorsa: npx playwright install --with-deps chromium
   npm run build        # dist/ (arayüz)
   ```

2. **Ortam dosyası** — sırlar sürüm kontrolüne girmez. `/etc/kamuilan/kamuilan.env`
   dosyasını yalnızca servis kullanıcısı okuyabilir (`chmod 600`). Secret manager
   kullanılıyorsa değerler çalışma anında enjekte edilir.

3. **Veritabanı hazırlığı**

   ```bash
   set -a; . /etc/kamuilan/kamuilan.env; set +a
   npm run db:indexes && npm run db:migrate
   ```

4. **Servisler** (`/etc/systemd/system/kamuilan-api.service`):

   ```ini
   [Unit]
   Description=Kamuİlan API
   After=network-online.target
   [Service]
   User=kamuilan
   WorkingDirectory=/opt/kamuilan
   EnvironmentFile=/etc/kamuilan/kamuilan.env
   ExecStart=/usr/bin/npm run start
   Restart=always
   RestartSec=5
   [Install]
   WantedBy=multi-user.target
   ```

   Worker için aynı dosyanın `ExecStart=/usr/bin/npm run start:worker` hâli.
   `systemctl enable --now kamuilan-api kamuilan-worker`

5. **Ters vekil** — `https://kamuilan.example.com` → arayüz `dist/`,
   `/api` → `http://127.0.0.1:3000`, `/api/docs` üretimde kapatılabilir.
   TLS için Let's Encrypt (certbot) yeterlidir.

6. **İlk yönetici**

   ```bash
   ADMIN_EMAIL=... ADMIN_PASSWORD='...' npm run seed:admin
   ```

   Sonraki hesaplar yönetim panelinden (Yönetim → Kullanıcılar → *Kullanıcı davet
   et*) ya da sunucuda:

   ```bash
   npm run user:create -- --email kisi@ornek.com --name "Ad Soyad"
   npm run user:create -- --email kisi@ornek.com --admin
   ```

   **Dikkat:** Kamuİlan Supabase Auth kullanmaz. Supabase panelindeki
   *Authentication → Users* kayıtları uygulamaya giriş yapamaz; hesaplar
   `kamuilan_users` tablosunda ve scrypt özetli parolayla tutulur. Elle SQL ile
   satır eklemek de giriş sağlamaz (özet biçimi uyuşmaz). Ayrıntı:
   [setup.md → Kullanıcılar hangi veritabanında?](./setup.md#kullanıcılar-hangi-veritabanında-supabase-notu)

## Ters vekil arkasında çalıştırma (`TRUST_PROXY`, `CORS_ORIGINS`, `DOCS_ENABLED`)

Bu üç değişken **güvenlik açısından** önemlidir ve varsayılanları en güvenli
seçenekleri seçer. Yanlış ayarlanırlarsa sistem açık verir; bu yüzden dağıtım
öncesi tek tek doğrulanmalıdır.

| Değişken       | Varsayılan | Ne zaman değiştirilir                                                                 |
| -------------- | ---------- | ------------------------------------------------------------------------------------- |
| `TRUST_PROXY`  | `0`        | API bir ters vekil arkasındaysa güvenilen vekil listesi (`cloudflare`, CIDR); `1` yalnızca köken vekil dışından erişilemiyorsa. |
| `CORS_ORIGINS` | boş        | Yalnızca arayüz API ile **farklı** bir kaynaktan konuşuyorsa (virgülle ayrılmış liste). |
| `DOCS_ENABLED` | `0`        | Hiçbir zaman. Yalnızca üretim dışı ortamda açın.                                       |

### `TRUST_PROXY` — istemci IP'si ve hız sınırları

`TRUST_PROXY=0` iken API `X-Forwarded-For` başlığına **güvenmez**; istemci
IP'si doğrudan soket adresinden alınır. Bu doğru varsayılandır, çünkü vekil
arkasında değilken başlığa güvenmek saldırganın hız sınırını sahte IP'lerle
atlamasına (ve denetim kayıtlarında yanlış IP görünmesine) yol açar.

- Vekil arkasında `TRUST_PROXY=1` verilmezse **tüm istekler vekilin IP'sinden**
  gelir: giriş/kayıt hız sınırı kovaları ortaklaşır, tek bir kullanıcı yanlış
  parola denemeleriyle herkesi kilitleyebilir.
- Vekil arkasında **değilken** `TRUST_PROXY=1` vermek ise başlık sahtelemesini
  açık hâle getirir. Vekilin `X-Forwarded-For` başlığını **kendisi yazdığından**
  emin olun (gelen değeri temizlemek vekilin işidir).
- Docker Compose ve depodaki Nginx yapılandırmaları bu nedenle yalnızca
  gerçek bir vekil varsa `TRUST_PROXY=1` ile çalıştırılır.

**Önerilen biçim — güvenilen vekil listesi.** `TRUST_PROXY` virgülle ayrılmış
IP/CIDR listesi ve şu adları kabul eder: `cloudflare` (Cloudflare'in yayımladığı
kenar aralıkları, `src/config/trust-proxy.ts`), `loopback`, `linklocal`,
`uniquelocal`. Başlık yalnızca bu adreslerden gelen isteklerde değerlendirilir ve
zincir sağdan okunur. Bu sayede API kökeni (`api.kamuilan…`) doğrudan internetten
erişilebilse bile vekili atlayan bir istemci sahte IP yazamaz (R-09).

| Dağıtım | Değer |
| --- | --- |
| Cloudflare (Pages vekili veya turuncu bulut) → API | `TRUST_PROXY=cloudflare` |
| Aynı makinede Nginx/Docker → API | `TRUST_PROXY=loopback,uniquelocal` |
| Vekil yok | `TRUST_PROXY=0` |

Geçersiz öğe (ör. `cloudflre`, `10.0.0.0/33`) açılışta hata verir; sessizce
"hiçbirine güvenme" ya da "hepsine güven" davranışına düşülmez.
Cloudflare aralıkları değişirse liste güncellenmeli ya da ek CIDR yazılmalıdır.

### `CORS_ORIGINS` — tarayıcı kaynak allowlist'i

Varsayılan boştur: API yalnızca **kendi alan adından** gelen tarayıcı
isteklerine CORS başlığı ekler (arayüz `dist/` aynı alan adından sunulduğunda
gerekli değildir). Ayrı bir alan adı/port gerekliyse tam kaynak yazılır:

```bash
CORS_ORIGINS=https://kamuilan.halilkaraduman.com.tr,https://panel.ornek.com
```

- Joker (`*`) **desteklenmez**; her kaynak tam olarak yazılır.
- Listede olmayan kaynaklar için CORS başlığı dönmez; tarayıcı isteği bloklar.
- `credentials` (çerez) desteği yalnızca listedeki kaynaklar için açılır.

### `DOCS_ENABLED` — Swagger/OpenAPI uçları

Üretimde (`NODE_ENV=production`) Swagger/OpenAPI uçları, `DOCS_ENABLED=1`
verilmedikçe **kapalıdır** ve `/api/docs` + `/api/openapi.json` adresleri 404
döner. Geliştirmede (`NODE_ENV=production` değilken) varsayılan olarak açıktır.
Üretimde kapalı tutun: şema, iç uçların tam listesini ve alan adlarını
dışarıya açar. Dağıtım sonrası hızlı kontrol:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<alan-adı>/api/docs   # beklenen: 404
```

## Ölçeklendirme

- **Çok örnekli API**: oturumlar imzalı çerezle taşınır; yatay ölçeklenebilir.
- **Çok örnekli worker**: kilitler ve kuyruk talepleri veritabanındadır; aynı kaynak
  iki kez taranmaz (`locks` + TTL). Redis kullanılıyorsa BullMQ kuyruğu paylaşılır.
- **Tarama hızı**: kaynak başına `minRequestIntervalMs` ve `maxConcurrency`
  ayarlarına saygı gösterilir; hız sınırlarını aşmamak için bilinçli olarak düşük
  tutulur.

## Önemli uyarı: saatlik tarama ve "uyuyan" sunucular

Bu sistem taramayı **worker süreci** yapar; kullanıcıların uygulamayı açık
tutmasına bağlı DEĞİLDİR (`setInterval` veya tarayıcı zamanlayıcısı yoktur;
kuyruk ve zamanlama veritabanındadır).

Ancak ücretsiz/uyku moduna giren platformlarda (ör. uyku modunda konteyner
durduran PaaS'lar, kapanan dizüstü) **saatlik tarama garantisi verilemez**:
süreç uyuduğunda hiçbir tarama yapılmaz. Bu nedenle:

- Üretimde worker 7/24 çalışan bir ortamda (VPS, konteyner platformu, kendi
  sunucunuz) çalıştırılmalıdır.
- Sağlık göstergeleri (worker kalp atışı, `scans.minutesSinceSuccess`,
  `scheduleLagWarning`) izlenmeli ve uzun süreli kesintilerde yönetici uyarısı
  kontrol edilmelidir.
- Alternatif: harici bir zamanlayıcıdan (cron/systemd timer) düzenli olarak
  `GET /api/admin/sources/:key/run` çağırmak. Bu, worker'ın yerini almaz; yalnızca
  tetikleme yapılır ve tüm işler kuyruğa yazılır.

## Yedekleme

- **Supabase/PostgreSQL**: Supabase günlük yedekleri + `pg_dump`
  (`kamuilan_*` tabloları; isim öneki `POSTGRES` şemasına göre değişebilir).
  Kritik koleksiyonlar: `jobs`, `jobSources`, `jobRevisions`, `sources`,
  `users`, `notificationPreferences`, `emailOutbox`, `scrapeRuns`, `auditLogs`.
- **Dosya deposu (yalnızca geliştirme)**: `data/kamuilan.json` dosyasını kopyalayın.
- Ayrıntılı prosedür: [operations.md](./operations.md).

## CI

`.github/workflows/ci.yml`: `npm ci` → `typecheck` → `lint` → `test` → `build`
→ `env:check` → `sources:report --json` → API+arayüz başlatma → Playwright E2E.
CI'da `SOURCE_LIVE_FETCH=0` olduğu için hiçbir gerçek kaynağa istek atılmaz.

Aynı adımları dağıtımdan önce yerelde çalıştırın:

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run env:check
```
