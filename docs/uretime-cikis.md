# Üretime çıkış rehberi

**Tarih:** 22.10.2026 · Tek sayfalık, sırayla uygulanacak yol. Ayrıntılar: [deployment.md](./deployment.md)
(topoloji, Nginx/systemd örnekleri), [operations.md](./operations.md) (işletim), [setup.md](./setup.md).

## Neredeyiz? (kanıtla)

22.10.2026'da **üretim provası** yapıldı: `NODE_ENV=production`, gerçek `pg` sürücüsü + Postgres
protokolü, SMTP, API + worker + derlenmiş arayüz, onaylı kaynaktan (Resmî Gazete) gerçek tarama,
Playwright E2E üretim API'sine karşı, parola sıfırlama e-postası. Bulunan beş engel düzeltildi (#68):
API üretimde açılışta çöküyordu · hız sınırı statik dosyaları sayıyordu · RG bölüm isteği tarama
bütçesinin tamamını alıyordu · aynı makinedeki Postgres reddediliyordu · kaynak şartları kapısı
worker'da yoktu. Ek olarak `.env`'deki boş satırların canlı taramayı açması düzeltildi (#70).

| Doğrulandı | Doğrulanmadı (erişim yok) |
| --- | --- |
| Üretim açılışı, env denetimi, şema/indeks/göç | Gerçek Supabase (TLS, havuz sınırı, gecikme) |
| E2E 22/22 üretim API'sine karşı | Gerçek Resend gönderimi |
| E-posta hattı (outbox → worker → SMTP) | Cloudflare `/api` vekili canlıda |
| Çerezler `HttpOnly; Secure; SameSite=Lax`, CSP, HSTS (https'te) | Gerçek kullanıcı yükü / 50k ilanlı Postgres |
| Worker kurtarma (ölü worker, yarım tarama) | İnsan etiketli doğruluk (kesinlik/duyarlılık) |

## 0. Önce kararlar (senin)

| # | Karar | Seçenekler | Önerim |
| --- | --- | --- | --- |
| K1 | Kim görebilir? | Giriş kapılı (`ALLOW_PUBLIC_REGISTRATION=0`, davetle) · herkese açık liste (`PUBLIC_LISTINGS_ENABLED=1`) | İlk hafta giriş kapılı |
| K8 | Kaynak kullanım şartları | `SOURCE_TERMS_POLICY=warn` (incelenmemişler de taranır, notla) · `enforce` (yalnız incelenip `allowed` olanlar) | Hukuki emin olunana kadar `enforce` + `config/source-terms.json`'u doldurmak; kapsam o zaman 2 kaynakla (RG, İŞKUR) başlar |
| LLM | Belirsiz ilanlarda yapay zekâ kapısı | Kapalı · Groq (ücretsiz; verinin ürün geliştirmede kullanımı sağlayıcı şartlarına tabi — KVKK) | Önce kapalı; açılırsa `docs/llm-karari.md` §2.1 ayarlarıyla |
| OCR | Taranmış PDF okuma | `OCR_ENABLED=0/1` (CPU yükü; ilk çalıştırmada dil verisi iner ya da `OCR_LANG_PATH`) | Worker sunucusu ≥2 vCPU ise 1 |
| Sunucu | API + worker nerede? | VPS (systemd) · Docker · Cloudflare Container/Fly.io | Tek küçük VPS (2 vCPU, 2–4 GB), iki systemd servisi |

## 1. Hesaplar ve sırlar

1. **Supabase** (veritabanı): proje aç (bölge: `eu-central`), *Project Settings → Database →
   Connection string*. Sunucudan bağlanılacak; **Session pooler** (5432) ya da **Transaction pooler**
   (6543). Bağlantı dizesine `sslmode=` YAZMA (uygulama TLS'i kendisi doğrular). Sorun olursa:
   `npm run db:tls-doctor`.
   - **Bağlantı sınırı:** her süreç varsayılan 10 bağlantı açar (`POSTGRES_MAX_CONNECTIONS`).
     API + worker toplamı Supabase havuz sınırını aşmamalı; ücretsiz planda süreç başına `5` öner.
2. **Resend** (e-posta): alan adını doğrula (SPF/DKIM DNS kayıtları), API anahtarı al, gönderen
   adres o alan adından olsun (`EMAIL_FROM`). Test modunda gerçek alıcıya gitmez; kendi adresinle dene.
3. **Cloudflare**: alan adı zone'da olmalı. `npx wrangler login`. *SSL/TLS → Edge Certificates*:
   "Always Use HTTPS" açık, **HSTS** etkin (max-age 6 ay+, alt alan adlarını yalnız hepsi HTTPS ise ekle).
4. **Sunucu**: Node **≥ 22.15**, git, (OCR/tarayıcı yedeği için) `npx playwright install --with-deps chromium`.

## 2. Üretim `.env` (sunucuda; repoya girmez)

`.env.example`'ın üst kısmındaki "ÜRETİM İÇİN EN AZ BUNLAR" listesi esastır. Sihirbaz:
`npm run env:setup` (sırları kendisi üretir). Elle yazacaksan çekirdek:

```dotenv
NODE_ENV=production
APP_BASE_URL=https://kamuilan.halilkaraduman.com.tr
APP_DOMAIN=kamuilan.halilkaraduman.com.tr
APP_SECRET=                      # npm run env:setup üretir (≥32 karakter)
EMAIL_VERIFICATION_SECRET=       # ≥32 karakter, APP_SECRET'ten farklı
DATABASE_DRIVER=supabase
POSTGRES_URL=                    # Supabase bağlantı dizesi (sslmode YOK)
POSTGRES_MAX_CONNECTIONS=5
EMAIL_PROVIDER=resend
RESEND_API_KEY=
EMAIL_FROM=Kamuİlan <bildirim@kamuilan.halilkaraduman.com.tr>
TRUST_PROXY=cloudflare           # API Cloudflare arkasındaysa
DOCS_ENABLED=0
ALLOW_PUBLIC_REGISTRATION=0
SCHEDULER_ENABLED=1              # yalnız worker sürecinde gerekli
SOURCE_LIVE_FETCH=1              # yalnız worker sürecinde gerekli
SOURCE_TERMS_POLICY=enforce      # K8 kararına göre
SOURCE_BROWSER_FALLBACK=0        # 1 → RG yavaşladığında tarayıcıyla okur (chromium kurulu olmalı)
OCR_ENABLED=0
LLM_CLASSIFIER_ENABLED=0
```

Kontrol: `npm run env:check` → "✔ Ortam yapılandırması kullanılabilir." görmeden ilerleme.

## 3. Kurulum komutları (sırayla)

```bash
git clone https://github.com/kaaradumaann-psi/kamuradar.git && cd kamuradar
npm ci
npm run env:check
npm run db:indexes        # tablolar + indeksler (idempotent)
npm run db:migrate        # kaynak envanteri + zamanlanmış görevler
ADMIN_EMAIL=sen@ornek.tr ADMIN_PASSWORD='uzun-güçlü-parola' npm run seed:admin
npm run build             # dist/ (aynı süreçten sunulur ya da Cloudflare'e yüklenir)
npm run start             # API (systemd servisi 1)
npm run start:worker      # worker (systemd servisi 2)
npx wrangler deploy && npx wrangler secret put API_ORIGIN   # arayüz + /api vekili
```

## 4. Canlıya almadan önce doğrula (hepsi ✔ olmalı)

- [ ] `curl https://<alan>/api/health` → `"status":"ok"`, `"environment":"production"`, `"driver":"postgres"`
- [ ] `curl -I https://<alan>/` → `strict-transport-security`, `content-security-policy` başlıkları var
- [ ] Yönetici girişi → *Yönetim paneli* açılıyor; *Panelim → Test e-postası gönder* posta kutuna düşüyor
- [ ] *Yönetim → kaynaklar*: bir kaynağı elle tara → tarama kaydı "başarılı" ya da gerekçeli "kısmi"
- [ ] `/api/health/worker` → worker kalp atışı taze
- [ ] E2E üretime karşı: `E2E_BASE_URL=https://<alan> ADMIN_EMAIL=… ADMIN_PASSWORD=… npx playwright test --project=chromium`
      (giriş ucu dakikada 10 deneme sınırlıdır; art arda koşuda 1 dk ara ver)
- [ ] `npm run runs:retention` önizlemesine bak: 90 günden eski tarama kayıtları **silinecek**

## 5. İlk hafta (K7)

Günde bir: sağlık ucu, *Yönetim → kaynaklar* (sorunlu kaynak), inceleme kuyruğu (yanlış ret/kabul),
e-posta teslim hataları, Supabase kullanım/bağlantı grafiği. Resmî Gazete sunucusu sık istekte HTML
sayfalarını zaman zaman askıya alır: tek başarısız tarama normaldir (saatlik yeniden denenir);
art arda başarısızlıkta `SOURCE_BROWSER_FALLBACK=1` değerlendir.

## 6. Geri alma

- Kod: önceki etiket/commit'e dön → `npm ci && npm run build` → servisleri yeniden başlat. Şema
  değişiklikleri ileriye uyumludur (yalnız tablo/indeks ekler).
- Veri: Supabase *Database → Backups* (günlük) ya da `pg_dump` ([operations.md §5](./operations.md)).
- Acil kapatma: worker'ı durdur (tarama/e-posta durur), API açık kalır.

## 7. Bilinen sınırlar

- Gerçek dünya doğruluğu **ölçülmedi** (insan etiketli kayıt 0). İlk hafta inceleme kuyruğu bu yüzden önemli.
- Postgres başarımı yalnız PGlite ile ölçüldü (50k ilan: liste p50 158 ms); gerçek Supabase'te ölçülmeli (R-03).
- İŞKUR liste sayfası statik HTML'de liste vermiyor (resmî veri kanalı gerekli).
