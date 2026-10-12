# Kurulum (geliştirme)

## Gereksinimler

- **Node.js 22+** ve npm 10+ (`node -v`)
- İsteğe bağlı: MongoDB 7 ve Redis 7 (yoksa yerel **dosya deposu** ve **yerleşik kuyruk**
  kullanılır — kurulum gerekmez)
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

Geliştirme için çoğu değer boş kalabilir. En az:

- `APP_SECRET` — üretimde zorunlu (en az 32 karakter). Geliştirmede boşsa
  oturumlar çalışır ama başlangıçta uyarı loglanır.
- `DATA_DIR` — dosya deposu ve geliştirme posta kutusu dizini (öntanımlı `./data`).
- `SOURCE_LIVE_FETCH=1` — gerçek kaynaklara istek atılmasını sağlar. `0` iken
  adaptörler ağa çıkmaz (demo/test için).

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

| Bileşen | Adres | Not |
| --- | --- | --- |
| Arayüz (Vite) | http://localhost:5173 | `/api` isteklerini API'ye proxy'ler |
| API | http://localhost:3000 | Dokümanlar: http://localhost:3000/api/docs |
| Worker | — | Tarama + e-posta döngüsü, kalıcı kuyruk |
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

MongoDB + Redis + posta sunucusu dahil her şey tek komutla:

```bash
cd infra/docker && docker compose up --build
```

Ayrıntılar: [deployment.md](./deployment.md).

## Sık karşılaşılan sorunlar

| Belirti | Çözüm |
| --- | --- |
| `EADDRINUSE :5173` | Vite `strictPort` kullanır. Eski süreci kapatın veya `PORT` çakışmasını giderin. |
| Arayüz açılıyor, veri gelmiyor | API çalışmıyor olabilir: `curl http://localhost:3000/api/health`. |
| `/api/health` durumu `degraded` | Kaynak uyarıları normaldir (ör. coğrafi kısıtlı kaynak). `warnings` alanını okuyun. |
| E-posta gelmiyor | Geliştirmede gerçek gönderim yoktur: http://localhost:1080 posta kutusunu kontrol edin. |
| `PDF okunamadı` | PDF bozuk/şifreli olabilir. Kayıt silinmez, inceleme kuyruğuna düşer. |
| Kariyer Kapısı kaynağı hata veriyor | Tarayıcı gerekir: `npx playwright install chromium`. |
| MongoDB'ye bağlanılmıyor | `MONGODB_URI` boşsa dosya deposu kullanılır; istenmiyorsa `MONGODB_URI` ayarlayın. |
