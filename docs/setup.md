# Kurulum (geliştirme)

## Gereksinimler

- **Node.js 22.15+** ve npm 10+ (`node -v`). 22.15 öncesi sürümlerde sistem sertifika deposu okunamaz;
  ilan.gov.tr, BDDK ve TMSF gibi eksik sertifika zinciri olan siteler `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
  hatasıyla reddedilir. `npm run test:live` çıktısının ilk satırı TLS durumunu gösterir.
- Geliştirme: başka hiçbir şey gerekmez (yerel **dosya deposu** + **yerleşik kuyruk**).
- Üretim: **Supabase** projesi (Postgres), **Cloudflare** (alan adı/barındırma),
  **Resend** hesabı (e-posta). Ayrıntı: [deployment.md](./deployment.md).
- İsteğe bağlı: MongoDB 7 ve Redis 7 (eski kurulumlar / kuyruk için)
- Playwright Chromium: **Resmî Gazete** (HTTP engellendiğinde tarayıcı yedeği), Kariyer Kapısı ve E2E testleri için gerekir. Kurulum: `npx playwright install chromium`

## 1. Bağımlılıklar

```bash
npm install
# Playwright tarayıcılarını indirmek istemiyorsanız:
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

Resmî Gazete kaynağı HTTP ile engellendiğinde (ECONNRESET / zaman aşımı) gerçek bir Chromium
oturumuyla okunur. Bu yüzden yerel makinede Chromium kurulu olmalıdır:

```bash
npx playwright install chromium
```

Kimlik politikası: HTTP istemcisi projenin açık botu (`SCRAPE_USER_AGENT`) ile çalışır. Tarayıcı
yedeği Playwright'ın kendi kimliğini kullanır; tarayıcı kimliği taklit edilmez ve TLS doğrulaması
kapatılmaz. Yedeğin canlı kaynakta çalışıp çalışmadığını ayrı görmek için:

```bash
npm run probe:resmigazete   # HTTP ve Chromium sonuçlarını ayrı ayrı yazar (veritabanına yazmaz)
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
  worker ağa çıkmaz (demo/test için): deneme `skipped` kaydedilir; başarılı tarama
  zamanı/ilan bulundu sayısı üretilmez ve kaynak erişilmiş gibi gösterilmez.
- `SCAN_INTERVAL_MINUTES=0` (önerilen) — her kaynak kendi aralığıyla taranır.
  Pozitif bir değer tüm etkin kaynakların aralığını o değere eşitler; en küçük değer
  15 dakikadır (daha küçük değerler 15'e yükseltilir, çünkü resmî siteler dakikada bir
  istekle yıpranıp ulaşılamaz hâle gelir). Kaynak hız sınırları
  (`minRequestIntervalMs`) her durumda korunur.
- `TRUST_PROXY`, `CORS_ORIGINS`, `DOCS_ENABLED` — güvenlik anahtarları;
  varsayılanları güvenli seçeneklerdir. Yalnızca ters vekil/CORS gerçekten
  gerektiğinde değiştirin:
  [deployment.md → Ters vekil arkasında çalıştırma](./deployment.md#ters-vekil-arkasında-çalıştırma-trust_proxy-cors_origins-docs_enabled).

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

| Bileşen                 | Adres                 | Not                                                    |
| ----------------------- | --------------------- | ------------------------------------------------------ |
| Arayüz (Vite)           | http://localhost:5173 | `/api` isteklerini API'ye proxy'ler                    |
| API                     | http://localhost:3000 | Dokümanlar: http://localhost:3000/api/docs             |
| Worker                  | —                     | Tarama + e-posta döngüsü, kalıcı kuyruk                |
| Geliştirme posta kutusu | http://localhost:1080 | SMTP: `127.0.0.1:1025` (`.env`); gerçek e-posta GİTMEZ |

Supabase/PostgreSQL ile ilk açılışta uzak veritabanı hazırlığı zaman alabilir. `npm run dev`,
worker'ın hafif heartbeat ucunu (`/api/health/worker`) bekler; kaynak/görev eşitlemesi sürerken
durum `başlatılıyor` görünür. Worker heartbeat'i alınamazsa terminalde ilgili hata ve worker
sürecinin günlükleri yazılır; yalnızca arayüzün açılmış olması taramanın çalıştığını kanıtlamaz.

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

### Kullanıcılar hangi veritabanında? (Supabase notu)

Bu adım, en sık karışan noktadır: **Kamuİlan, Supabase Auth (GoTrue) kullanmaz.**
Kullanıcılar uygulamanın kendi tablosunda tutulur:

| Ne                                                        | Nerede                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| Kullanıcı kayıtları                                       | `kamuilan_users` tablosu (JSONB belge; `driver` neyse orada) |
| Parolalar                                                 | `scrypt` özeti + rastgele tuz (düz metin asla yazılmaz)      |
| Oturumlar / jetonlar                                      | `kamuilan_sessions`, `kamuilan_tokens`                       |
| Supabase panelindeki **Authentication → Users** kayıtları | Uygulama tarafından **kullanılmaz**                          |

Bu yüzden Supabase panosundan elle kullanıcı eklemek (ya da `auth.users` içine
kayıt açmak) giriş **yapmaz**: özet biçimi uyuşmadığı için giriş "E-posta veya
parola hatalı." (HTTP 401) döner. Kullanıcıyı her zaman etkin depoya yazan bir
yol kullanın:

```bash
# 1) Kolay yol: parolayı hemen belirle (var olan hesapta --force gerekir)
npm run user:create -- --email kisi@ornek.com --password "Güçlü-Parola1"
npm run user:create -- --email kisi@ornek.com --password "Yeni-Parola1" --force

# 2) Davet akışı: hesap açılır, tek kullanımlık bağlantı e-posta ile gider
npm run user:create -- --email kisi@ornek.com --name "Ad Soyad"
npm run user:create -- --email kisi@ornek.com --admin            # yönetici olarak
npm run user:create -- --email kisi@ornek.com --no-email         # bağlantıyı yaz, e-posta gönderme
```

Giriş ekranı, veritabanında **hiç hesap yoksa** hangi depoya bakıldığını ve
çalıştırılacak komutu açıkça yazar; API de aynı bilgiyi döner
(`GET /api/auth/session` → `setup.driver` / `setup.label`). Etkin depoyu kontrol
etmek için: `curl -s localhost:3000/api/health/config` (`database` alanı) ya da
`npm run env:check`.

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

Canlı doğrulama sonucunda her kaynağın durumu ya da hatası yazdırılır. Başarısız kaynaklar
`config/sources.ts` içinde "doğrulanmış" olarak kalmaz; nedeni `statusNote` alanına yazılır.

## Mevcut ilan kayıtlarını yeniden değerlendirme

Sınıflandırma kuralları değiştiğinde (ör. iş ilanı dışı duyuruların akıştan çıkarılması) eski
kayıtlar için:

```bash
npm run jobs:reclassify                              # kuru çalıştırma: özet (yazmaz)
npm run jobs:reclassify -- --report rapor.json       # kayıt bazlı JSON raporu (yazmaz)
npm run jobs:reclassify -- --apply                   # değişiklikleri yazar (önce yedek alır)
```

Her kayıt iki türden birine ayrılır:

- **İş ilanı (`job`)**: personel alım ilanı. Akışta kalır.
- **Süreç duyurusu (`process`)**: gerçek bir personel alımının kura, sınav yeri/tarihi, sınav metni,
  çağrılacak adaylar, mülakat veya sonuç duyurusu. Akışta ayrı tür olarak kalır. Tür yalnızca
  başlıktan belirlenir ve personel bağlamı (personel, alım, işçi, memur, sözleşmeli, kadro)
  ile süreç sinyalinin birlikte bulunmasını ister. Yer değiştirme, görevde yükselme, ünvan
  değişikliği, tercih, eğitim, basın, satış ve ihale ifadeleri süreç olarak kabul edilmez.

Ret sinyali olan kayıtlar "reddedildi" olur ve akıştan çıkar; kayıt silinmez. Süreç duyuruları akışta ve filtrelerde görünür; e-posta ve Telegram \"yeni ilan\" bildirimi üretmez,
AI önerilerine de girmez. Reddedilen veya süreç olan kayıtların bekleyen bildirimleri `--apply` ile
bastırılır (gönderilmiş bildirimler geri alınamaz; rapordaki `notifications` alanında görülür).
Yeniden
sınıflandırma kabul edilmiş kayıtların türünü de günceller.

Supabase üzerinde çalıştırmadan önce ilk satırdaki veritabanı adını ve kuru çalıştırma çıktısını
inceleyin. `--report` yalnızca okur; ret gerekçelerini ve gövde özetini inceleyebilmeniz için kullanın.

### Geri alma

`--apply` çalışmadan önce tüm ilan kayıtlarının yedeği `data/backups/jobs-before-reclassify-*.json`
dosyasına yazılır. Yedek yazılamazsa hiçbir kayıt değiştirilmez. Geri almak için:

```bash
npm run jobs:restore -- data/backups/jobs-before-reclassify-<tarih>.json          # kuru çalıştırma
npm run jobs:restore -- data/backups/jobs-before-reclassify-<tarih>.json --apply  # geri yükle
```

Geri yükleme yalnızca yedekteki kimlikleri birebir geri yazar; geri yüklemeden önce mevcut durumun
yedeği de alınır.

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

| Belirti                                                   | Çözüm                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE :5173`                                        | Vite `strictPort` kullanır. Eski süreci kapatın veya `PORT` çakışmasını giderin.                                                                                                                                                                                                                                                                                             |
| Arayüz açılıyor, veri gelmiyor                            | API çalışmıyor olabilir: `curl http://localhost:3000/api/health`.                                                                                                                                                                                                                                                                                                            |
| `/api/health` durumu `degraded`                           | Kaynak uyarıları normaldir (ör. coğrafi kısıtlı kaynak). `warnings` alanını okuyun.                                                                                                                                                                                                                                                                                          |
| E-posta gelmiyor                                          | Geliştirmede gerçek gönderim yoktur: http://localhost:1080 posta kutusunu kontrol edin.                                                                                                                                                                                                                                                                                      |
| `PDF okunamadı`                                           | PDF bozuk/şifreli olabilir. Kayıt silinmez, inceleme kuyruğuna düşer.                                                                                                                                                                                                                                                                                                        |
| Kariyer Kapısı kaynağı hata veriyor                       | Tarayıcı gerekir: `npx playwright install chromium`.                                                                                                                                                                                                                                                                                                                         |
| MongoDB'ye bağlanılmıyor                                  | `MONGODB_URI` boşsa dosya deposu kullanılır; istenmiyorsa `MONGODB_URI` ayarlayın.                                                                                                                                                                                                                                                                                           |
| Girişte sürekli 401 / "E-posta veya parola hatalı."       | Hesap **etkin depoda** yok ya da parola uyuşmuyor. Hangi deponun kullanıldığını giriş ekranındaki kurulum notundan, `curl -s localhost:3000/api/health/config` (`database`) veya `npm run env:check` çıktısından görün. Supabase panosuna elle eklenen kullanıcı GİRİŞ YAPMAZ (Supabase Auth kullanılmaz): `npm run user:create -- --email … --password … --force` kullanın. |
| Giriş ekranında "Bu işlem için oturum açmanız gerekiyor." | 401'in tek anlamı "oturum yok" değildir; giriş/parola uçlarında 401 kimlik bilgisinin yanlış olduğunu gösterir ve artık sunucunun kendi mesajı gösterilir. Bu metni görüyorsanız oturum gerektiren bir uca çıkışsız istek gidiyor demektir (`/giris`'e yönlendirilirsiniz).                                                                                                  |
| Davet e-postası 1080'de görünmüyor                        | `SMTP_HOST` boşsa e-postalar dosyaya yazılır ve yerel posta sunucusu devre dışı kalır. `.env` içinde `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025` bırakın (öntanımlı).                                                                                                                                                                                                            |
| `Veritabanına erişilemiyor` (Supabase)                    | `POSTGRES_URL` havuz (pooler) adresi mi, `POSTGRES_SSL=true` mı, Supabase'de IP kısıtı var mı kontrol edin.                                                                                                                                                                                                                                                                  |
| E-posta gönderilmiyor (üretim)                            | `RESEND_API_KEY` ve **doğrulanmış** `EMAIL_FROM` alan adı gerekir; `npm run env:check` seçilen yolu yazar.                                                                                                                                                                                                                                                                   |
| Davet e-postası gelmiyor                                  | Yönetim → E-posta kuyruğu ekranında kaydı bulun; `dead` ise nedeni `lastError` alanındadır.                                                                                                                                                                                                                                                                                  |

## 8. Telegram bildirimleri (isteğe bağlı)

Telegram kanalı, e-posta bildirimlerine ek olarak çalışır; tanımsızken tamamen kapalıdır.

1. Telegram'da **@BotFather** ile `/newbot` komutunu verin; bot **kullanıcı adını** (`…bot` ile biter) ve **token**'ı alın.
2. `.env` dosyasına yazın (token ve sır asla istemciye gitmez):
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (`@` olmadan)
   - `TELEGRAM_WEBHOOK_SECRET` — `openssl rand -hex 32` ile üretin. Token tanımlıyken üretimde zorunludur.
3. `APP_BASE_URL` herkese açık bir **https** adres olmalıdır. Ardından:
   ```bash
   npm run telegram:webhook -- info    # bot kimliği ve webhook durumu
   npm run telegram:webhook -- set     # APP_BASE_URL/api/telegram/webhook adresini kurar
   ```
4. Kullanıcı Panelim'deki **Telegram bildirimleri** kartında "Telegram'a bağla" düğmesine basar. Açılan bağlantıdan botu başlatabilir ya da gösterilen kodu botta `/start <kod>` olarak gönderebilir; kart bağlantı kurulana kadar durumu kendiliğinden kontrol eder. Bot komutları: `/durum`, `/dur`, `/basla`, `/cik`, `/yardim`.

Sorun giderme: webhook isteği 401 dönüyorsa `TELEGRAM_WEBHOOK_SECRET` değeri ile webhook'a kurulan sır aynı değildir; 404 dönüyorsa sır hiç tanımlı değildir. Bot engellenmişse (403) bağlantı otomatik `blocked` durumuna geçer ve kullanıcı panelde bilgilendirilir.

## 9. Yapay zekâ önerileri (isteğe bağlı, açık rızayla)

Varsayılan **kapalıdır** (`AI_ASSISTANT_ENABLED=0`). Açmak için:

- `AI_ASSISTANT_ENABLED=1`, `LLM_BASE_URL` (OpenAI uyumlu, `https://`), `LLM_API_KEY`, `LLM_MODEL` tanımlanmalıdır. Eksikse uygulama başlamaz (`npm run env:check` nedenini söyler).
- `AI_PROVIDER_LABEL` kullanıcının rıza ekranında gördüğü sağlayıcı adıdır; gerçek sağlayıcıyı doğru yazın.
- `AI_DAILY_LIMIT_PER_USER` (öntanımlı 5) kullanıcı başına günlük model çağrısını sınırlar; sınır dolunca profil eşleştirmesi gösterilir ve hata oluşmaz.
- Açmadan önce gizlilik sayfasındaki (`/gizlilik`) KVKK metnini ve sağlayıcının veri işleme koşullarını gözden geçirin. Gönderilen alanlar `docs/security-kvkk.md` içinde listelidir.

Akış: kullanıcı profilini doldurur → Panelim'de rızasını verir → kart, kural tabanlı aday ilanları (en çok 12) ve sağlayıcı yanıtını gösterir. Rıza geri çekildiğinde veya hesap silindiğinde önbellek temizlenir.
