# Kurulum (geliştirme)

## Gereksinimler

- **Node.js 22+** ve npm 10+ (`node -v`)
- Geliştirme: başka hiçbir şey gerekmez (yerel **dosya deposu** + **yerleşik kuyruk**).
- Üretim: **Supabase** projesi (Postgres), **Cloudflare** (alan adı/barındırma),
  **Resend** hesabı (e-posta). Ayrıntı: [deployment.md](./deployment.md).
- İsteğe bağlı: MongoDB 7 ve Redis 7 (eski kurulumlar / kuyruk için)
- İsteğe bağlı: Playwright tarayıcıları (yalnızca Kariyer Kapısı kaynağı ve E2E testleri için)

## 1. Bağımlılıklar

```bash
npm install
# Playwright tarayıcılarını indirmek istemiyorsanız:
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

E2E testleri için tarayıcı gerekir:

```bash
npx playwright install chromium
```

## 2. Ortam değişkenleri

```bash
cp .env.example .env
```

Dosya **otomatik olarak okunur**: `src/config/env.ts` yüklenirken
`src/config/load-env.ts` çalışma dizinindeki `.env` dosyasını okur (bağımlılık
yoktur; Node'un `--env-file` bayrağına gerek kalmaz). Kurallar:

- **Gerçek ortam değişkeni her zaman önceliklidir**; `.env` var olan bir değeri
  ezmez (CI/Docker/systemd/Cloudflare güvenle kullanılabilir).
- `.env.<NODE_ENV>` (ör. `.env.production`) varsa `.env` üzerine yazar.
- Dosya yoksa sessizce devam edilir; `.env` isteğe bağlıdır.
- Testte (`NODE_ENV=test`) yüklenmez — testler ortamı kendileri kurar.
- Sırlar hiçbir zaman günlüğe yazılmaz; `npm run env:check` yalnızca maskeli
  özet gösterir.

Doğrulama: `npm run env:check` çıktısındaki `envFile` satırı hangi dosyanın
okunduğunu gösterir (yol görünür, içerik görünmez).

Geliştirme için çoğu değer boş kalabilir. En az:

- `APP_SECRET` — üretimde zorunlu (en az 32 karakter). Geliştirmede boşsa
  oturumlar çalışır ama başlangıçta uyarı loglanır.
- `DATA_DIR` — dosya deposu ve geliştirme posta kutusu dizini (öntanımlı `./data`).
- `SOURCE_LIVE_FETCH=1` — gerçek kaynaklara istek atılmasını sağlar. `0` iken
  adaptörler ağa çıkmaz (demo/test için).
- `SCAN_INTERVAL_MINUTES=1` — **test aşaması** ayarı: her kaynak dakikada bir
  taranır. Üretimde `0` (kaynak başına `intervalMinutes`) veya 30–360 önerilir.

### Üretim anahtarları (Supabase + Cloudflare + Resend)

| Değişken                             | Nereden                                                    | Not                                                              |
| ------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `DATABASE_DRIVER=supabase`           | bu dosya                                                   | `postgres` de aynı sürücüdür; `supabase` okunurluk için takma ad |
| `POSTGRES_URL`                       | Supabase → Project Settings → Database → Connection string | Sunucu tarafı; havuz bağlantısı önerilir (port 6543)             |
| `DATABASE_URL`                       | alternatif ad                                              | Bazı sağlayıcılar bu adı verir; ikisinden biri yeterlidir        |
| `POSTGRES_SSL=true`                  | —                                                          | Supabase TLS ister; `false` yalnızca yerel test için             |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Supabase → API                                             | Kayıtlıdır; uygulama şu an yalnızca `POSTGRES_URL` kullanır      |
| `SUPABASE_SERVICE_ROLE_KEY`          | Supabase → API                                             | **Yalnızca sunucu**; tarayıcıya asla verilmez, repoya yazılmaz   |
| `APP_DOMAIN`                         | —                                                          | `kamuilan.halilkaraduman.com.tr` (Cloudflare özel alan adı)      |
| `APP_BASE_URL`                       | —                                                          | E-posta bağlantılarının üretildiği herkese açık adres            |
| `EMAIL_PROVIDER=resend`              | bu dosya                                                   | `smtp` ve `file` alternatifleri vardır                           |
| `RESEND_API_KEY`                     | Resend → API Keys                                          | Sunucu tarafı; tarayıcıya verilmez                               |
| `EMAIL_FROM`                         | Resend → Domains                                           | **Doğrulanmış** alan adından bir adres olmalıdır                 |
| `ALLOW_PUBLIC_REGISTRATION=0`        | bu dosya                                                   | Dışarıdan kayıt kapalı; hesaplar yönetici davetiyle açılır       |

Üretim doğrulaması: `NODE_ENV=production npm run env:check`. Eksik sağlayıcı
anahtarıyla uygulama **başlamaz** (e-postanın sessizce kaybolmasını engellemek için).

Doğrulama:

```bash
npm run env:check
```

Betik, eksik/hatalı değişkenleri ve güvenlik uyarılarını listeler.

## 3. Veritabanı hazırlığı

```bash
npm run db:indexes   # indeksleri oluşturur (dosya deposunda no-op'a yakın)
npm run db:migrate   # kaynak envanterini ve zamanlanmış görevleri yazar
```

`npm run dev` bu bakımı kendisi de çalıştırır.

## 4. Geliştirme ortamını başlat

```bash
npm run dev
```

Tek komutla dört süreç ayağa kalkar:

| Bileşen                 | Adres                 | Not                                           |
| ----------------------- | --------------------- | --------------------------------------------- |
| Arayüz (Vite)           | http://localhost:5173 | `/api` isteklerini API'ye proxy'ler           |
| API                     | http://localhost:3000 | Dokümanlar: http://localhost:3000/api/docs    |
| Worker                  | —                     | Tarama + e-posta döngüsü, kalıcı kuyruk       |
| Geliştirme posta kutusu | http://localhost:1080 | SMTP: `localhost:1025`; gerçek e-posta GİTMEZ |

Tek tek çalıştırmak isterseniz: `npm run dev:api`, `npm run dev:worker`,
`npm run dev:web`, `npm run dev:smtp`.

Kapatmak için `Ctrl+C`.

## 5. İlk yönetici

Yönetim paneli RBAC ile korunur ve ilk yönetici arayüzden oluşturulamaz:

```bash
ADMIN_EMAIL=yonetici@example.com ADMIN_PASSWORD="uzun-rastgele-bir-parola" npm run seed:admin
```

Betik şifreyi ekrana yazmaz/loglamaz. Var olan kullanıcıyı yöneticiye yükseltir,
şifresini değiştirmez.

### Sonraki kullanıcılar (davet akışı)

Kamuİlan'da **dışarıdan kendi kendine kayıt yoktur**. Yönetici, Yönetim →
Kullanıcılar → _Kullanıcı davet et_ formunu kullanır (`POST /api/admin/users`):

1. Hesap, giriş yapılamaz durumda açılır (rastgele bir sır hash'lenir; düz metin
   parola hiçbir zaman üretilmez, gönderilmez, loglanmaz).
2. Davetliye **tek kullanımlık** şifre belirleme bağlantısı gider (72 saat).
3. Kullanıcı kendi parolasını belirler; parola gücü doğrulanır ve oturumlar
   kapatılır. Davet e-postası, bildirim aboneliği oluşturmaz — tercihlerini
   kullanıcı kendisi açar.

## 6. Örnek veri (isteğe bağlı)

```bash
npm run seed:demo
```

Eklenen kayıtlar `provenance: 'sample'` olarak işaretlenir ve arayüzde "örnek veri"
etiketiyle görünür. Örnek veriler gerçek ilan gibi SUNULMAZ.

## 7. Doğrulama

```bash
npm run typecheck
npm run lint
npm test            # birim + entegrasyon (ağ erişimi yok)
npm run build       # arayüz derlemesi
npm run test:e2e    # Playwright (tarayıcı kurulu olmalı)
```

Gerçek kaynaklara karşı canlı doğrulama (yalnızca gerçek ağ olan ortamda):

```bash
SOURCE_LIVE_FETCH=1 npm run test:live
```

## Kapsam raporu

```bash
npm run sources:report            # insan okunur tablo
npm run sources:report -- --json  # makine okunur (CI)
```

## Docker ile geliştirme

Geliştirme posta sunucusu (mailpit) + API + worker + Vite arayüzü tek komutla
ayaklanır; veritabanı sürücüsü öntanımlı olarak dosyadır (dış servis gerekmez):

```bash
cd infra/docker && docker compose up --build
```

Gerçek PostgreSQL ile: `DATABASE_DRIVER=postgres docker compose --profile postgres up --build`

Ayrıntılar: [deployment.md](./deployment.md).

## Sık karşılaşılan sorunlar

| Belirti                                | Çözüm                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE :5173`                     | Vite `strictPort` kullanır. Eski süreci kapatın veya `PORT` çakışmasını giderin.                            |
| Arayüz açılıyor, veri gelmiyor         | API çalışmıyor olabilir: `curl http://localhost:3000/api/health`.                                           |
| `/api/health` durumu `degraded`        | Kaynak uyarıları normaldir (ör. coğrafi kısıtlı kaynak). `warnings` alanını okuyun.                         |
| E-posta gelmiyor                       | Geliştirmede gerçek gönderim yoktur: http://localhost:1080 posta kutusunu kontrol edin.                     |
| `PDF okunamadı`                        | PDF bozuk/şifreli olabilir. Kayıt silinmez, inceleme kuyruğuna düşer.                                       |
| Kariyer Kapısı kaynağı hata veriyor    | Tarayıcı gerekir: `npx playwright install chromium`.                                                        |
| MongoDB'ye bağlanılmıyor               | `MONGODB_URI` boşsa dosya deposu kullanılır; istenmiyorsa `MONGODB_URI` ayarlayın.                          |
| `Veritabanına erişilemiyor` (Supabase) | `POSTGRES_URL` havuz (pooler) adresi mi, `POSTGRES_SSL=true` mı, Supabase'de IP kısıtı var mı kontrol edin. |
| E-posta gönderilmiyor (üretim)         | `RESEND_API_KEY` ve **doğrulanmış** `EMAIL_FROM` alan adı gerekir; `npm run env:check` seçilen yolu yazar.  |
| Davet e-postası gelmiyor               | Yönetim → E-posta kuyruğu ekranında kaydı bulun; `dead` ise nedeni `lastError` alanındadır.                 |
