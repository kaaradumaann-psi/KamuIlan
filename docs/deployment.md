# Dağıtım (üretim)

## Özet kontrol listesi

- [ ] `NODE_ENV=production`, `APP_SECRET` en az 32 karakter rastgele değer (sır yöneticisi)
- [ ] `MONGODB_URI` kalıcı MongoDB (yedekleme açık)
- [ ] `REDIS_URL` (kuyruk; çok örnekli çalışma için önerilir)
- [ ] Gerçek SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`
- [ ] `APP_BASE_URL` üretim adresi (e-posta bağlantıları buradan üretilir)
- [ ] Ters vekil (reverse proxy) + TLS; API ve worker ayrı süreçler
- [ ] İndeksler oluşturuldu (`npm run db:indexes`)
- [ ] Kaynak envanteri + zamanlanmış görevler yazıldı (`npm run db:migrate`)
- [ ] Yedekleme/geri yükleme denendi ([operations.md](./operations.md))
- [ ] Sağlık kontrolü izleniyor (`GET /api/health`)

Başlangıç doğrulaması: uygulama `src/config/env.ts` ile ortam değişkenlerini
doğrular; üretimde `SMTP_HOST` yoksa **başlatılmaz** (e-postaların sessizce
kaybolmasını engellemek için).

## Süreçler

| Süreç | Komut | Not |
| --- | --- | --- |
| API | `npm run start` | HTTP sunucusu; tarama YAPMAZ |
| Worker | `npm run start:worker` | Zamanlayıcı + kuyruk tüketicisi + e-posta gönderimi |
| Arayüz | `npm run build` → `dist/` | Statik dosyalar (Nginx/CDN) |

Ayrı süreçler olması bilinçlidir: tarama/e-posta yükü API'yi yavaşlatmaz ve
worker yeniden başlatıldığında işler kaybolmaz (durum veritabanındadır).

## Docker ile geliştirme

```bash
cd infra/docker
docker compose up --build
```

Servisler: `mongo`, `redis`, `mail` (mailpit: SMTP 1025, arayüz 1080), `api`,
`worker`, `web` (Vite dev sunucusu, 5173). Tüm trafik göreli `/api` üzerinden
proxy'lenir.

Üretim arayüz imajı:

```bash
docker build -f infra/docker/Dockerfile.web -t kamuradar-web .
docker run -p 8080:80 -e API_ORIGIN=http://api:3000 kamuradar-web
```

Nginx yapılandırması: `infra/docker/nginx.conf` (SPA yönlendirmesi, `/api`
proxy'si, güvenlik başlıkları, varlık önbelleği, gzip).

## Üretim kurulumu (örnek: systemd + Nginx)

1. **Kod ve bağımlılıklar**

   ```bash
   git clone <repo> /opt/kamuradar && cd /opt/kamuradar
   npm ci --omit=dev    # tarayıcı gerekiyorsa: npx playwright install --with-deps chromium
   npm run build        # dist/ (arayüz)
   ```

2. **Ortam dosyası** — sırlar sürüm kontrolüne girmez. `/etc/kamuradar/kamuradar.env`
   dosyasını yalnızca servis kullanıcısı okuyabilir (`chmod 600`). Secret manager
   kullanılıyorsa değerler çalışma anında enjekte edilir.

3. **Veritabanı hazırlığı**

   ```bash
   set -a; . /etc/kamuradar/kamuradar.env; set +a
   npm run db:indexes && npm run db:migrate
   ```

4. **Servisler** (`/etc/systemd/system/kamuradar-api.service`):

   ```ini
   [Unit]
   Description=KamuRadar API
   After=network-online.target mongod.service
   [Service]
   User=kamuradar
   WorkingDirectory=/opt/kamuradar
   EnvironmentFile=/etc/kamuradar/kamuradar.env
   ExecStart=/usr/bin/npm run start
   Restart=always
   RestartSec=5
   [Install]
   WantedBy=multi-user.target
   ```

   Worker için aynı dosyanın `ExecStart=/usr/bin/npm run start:worker` hâli.
   `systemctl enable --now kamuradar-api kamuradar-worker`

5. **Ters vekil** — `https://kamuradar.example.com` → arayüz `dist/`,
   `/api` → `http://127.0.0.1:3000`, `/api/docs` üretimde kapatılabilir.
   TLS için Let's Encrypt (certbot) yeterlidir.

6. **İlk yönetici**

   ```bash
   ADMIN_EMAIL=... ADMIN_PASSWORD='...' npm run seed:admin
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

- **MongoDB**: `mongodump`/`mongorestore`; `jobs`, `jobSources`, `jobRevisions`,
  `sources`, `users`, `notificationPreferences`, `emailOutbox`, `scrapeRuns`,
  `auditLogs` koleksiyonları kritiktir.
- **Dosya deposu (yalnızca geliştirme)**: `data/kamuradar.json` dosyasını kopyalayın.
- Ayrıntılı prosedür: [operations.md](./operations.md).

## CI

`.github/workflows/ci.yml`: `npm ci` → `typecheck` → `lint` → `test` → `build` →
`env:check` → `sources:report --json` → API+arayüz başlatma → Playwright E2E.
CI'da `SOURCE_LIVE_FETCH=0` olduğu için hiçbir gerçek kaynağa istek atılmaz.
