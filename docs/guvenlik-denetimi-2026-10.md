# Güvenlik ve hata denetimi — 2026-10-15

Kapsam: tüm sistem (API, worker, adaptörler, sınıflandırma, depo, e-posta, arayüz,
ortam sihirbazı, betikler). Yöntem: statik kod incelemesi + **çalışan uygulama üzerinde
dinamik prob** (`app.inject`) + bağımlılık denetimi + git geçmişi taraması + regresyon
testleri. Hiçbir bulgu "muhtemel" bırakılmadı: her biri ya ölçüldü ya da testle sabitlendi.

## 1) Bulgular ve düzeltmeler

| # | Önem | Bulgu | Kanıt | Çözüm | Test |
| --- | --- | --- | --- | --- | --- |
| B1 | **KRİTİK** | Yönetici RBAC atlatması: `GET /%61pi/admin/overview` **oturumsuz 200** döndü ve yönetici panosunu (sürümler, kaynak kapsamları, inceleme kuyruğu, kuyruk/worker sayıları) sızdırdı | Prob çıktısı: `SIZDI 200 /%61pi/admin/overview {"appVersion":...}` | Ön ek kararları artık **eşleşen rotadan** verilir (`requestPathname`, `matchesPathPrefix`: `request.routeOptions.url` + kod çözülü ham yol). Ek savunma: 10 yönetici GET işleyicisinin her biri kendi `requireAdmin(request)` çağrısını yapıyor | `tests/guvenlik-yetki-regresyon.test.ts` (10) |
| B2 | ORTA | Sıkı kimlik hız sınırı atlatması: `POST /%61pi/auth/login` genel kovaya (120/60s) düşüyordu, sıkı kovaya (AUTH_RATE_LIMIT_MAX_REQUESTS) değil | Prob: düz yol `401,401,429`, kodlanmış yol sınırsız | Aynı rota tabanlı yol çözümlemesi | aynı dosya: `401,401,429,429` |
| B3 | ORTA | SMTP TLS doğrulaması geliştirmede **kapalıydı**: `tls: { rejectUnauthorized: NODE_ENV === 'production' }` → STARTTLS'te sunucu sertifikası denetlenmiyor, `SMTP_USER/SMTP_PASS` ortadaki adama açıktı | `src/email/transport.ts` (eski satır) | `smtpTlsOptions()`: doğrulama **varsayılan açık**, ortama bağlı değil. Yalnızca açık `SMTP_TLS_INSECURE=1` kapatır; üretimde engelleyici sorun, diğer ortamlarda yüksek sesli uyarı. Anahtar şemaya, sihirbaz kataloğuna ve `.env.example`'a eklendi | `tests/smtp-tls.test.ts` (8) |
| B4 | ORTA | `/api/health/config` **anonim** erişime açıktı: baseUrl, veritabanı sürücüsü, TLS modu, veri dizini, sağlayıcı açık/kapalı bilgisi, maskeli yönetici e-postası | Rota kaydında yetki denetimi yoktu | `requireAdmin(request)`; belgeler ağ gerektirmeyen `npm run env:check`'e yönlendirildi (`docs/setup.md`, `docs/operations.md`) | `tests/guvenlik-yetki-regresyon.test.ts` |
| B5 | DÜŞÜK/ORTA | `/api/health` veritabanı **hata ayrıntısını** herkese veriyordu (`connect ETIMEDOUT 10.0.0.5:5432`, CA dosya yolu gibi) | `postgres-store.health()` başarısızken `error.message` döner | Sağlıklıyken herkese, başarısızken **yalnızca yöneticiye**; anonim → `null` | aynı dosya (sızıntı testi) |
| B6 | ORTA | Tıklanabilir bağ sınırı: `z.string().url()` `javascript:alert(1)` adresini **geçerli** sayar; depoya sızan böyle bir adres panelde `href` olarak çizilip betik çalıştırabilirdi (stored XSS) | `new URL('javascript:alert(1)')` geçerli; `normalizeUrl` protokol denetlemez | Serializer'da tek nokta: `safeHref()` → `detailUrl` güvenliyse aynen, değilse `#`; `applicationUrl` değilse `null`; http(s) olmayan **ekler ve kaynak bağları listeden düşer**; inceleme kuyruğu adresi `''`. Yönetici kaynak uçlarında `listingUrl/homepageUrl` için `isHttpUrl` refine (400) | `tests/guvenlik-url-siniri.test.ts` (7) |
| B7 | DÜŞÜK (Windows üretim hatası) | Statik kök `new URL('../../dist', import.meta.url).pathname` ile çözülüyordu → Windows'ta `/C:/Users/...` üretir, `@fastify/static` kökü bulamaz ve **arayüz 404** verir | Kod incelemesi | `staticDistRoot()` → `fileURLToPath(...)` | mutlak yol + `/C:` biçimi reddi testi |
| B8 | DÜŞÜK (hijyen) | İstek kimliği `Math.random()` ile üretiliyordu (log/denetim korelasyonu tahmin edilebilir) | `src/server/app.ts` | `crypto.randomUUID()` (CSPRNG), `req_<20 hex>` | biçim + benzersizlik testi |

## 2) Kontrol edildi ve TEMİZ bulundu

- **Bağımlılıklar**: `npm audit` (üretim) ve `npm audit` (dev dahil) → **0 açık**.
- **SQL enjeksiyonu**: tablo adları sabit koleksiyon kümesinden (`this.table(collection)`),
  değerler `$n` yer tutucularıyla bağlanır; `quoteLiteral` yalnızca statik indeks yollarında;
  yer tutucu/parametre sayısı sorgu anında ikinci kez doğrulanır.
- **NoSQL enjeksiyonu**: dosya/Mongo deposu sorgu ön filtresi çevrilemeyen koşullarda
  ön filtrenin tamamını düşürür (değer birleştirmez).
- **Oturum/jeton**: `randomToken(32)` = CSPRNG 256 bit; depoda yalnızca SHA-256 özeti;
  TTL, iptal, tek kullanımlık tüketim; IP/UA özetlenerek saklanır.
- **Parola**: scrypt (64 bayt anahtar) + 16 bayt tuz + NFKC + `timingSafeEqual`;
  kayıtsız hesapta da scrypt maliyeti ödenir (zamanlama eşitlemesi); hesap bazlı deneme sınırı.
- **CSRF**: double-submit (çerez + `x-csrf-token`) **ve** oturumdaki `csrfToken` eşleşmesi;
  tüm mutasyon yöntemleri kapsanır; muafiyet listesi ham yolla eşleştiği için kodlamayla
  **genişlemez** (test edildi: `/%61pi/auth/logout` jetonsuz → 403).
- **SSRF**: `assertSafeUrl` protokol (yalnız http/https), standart dışı port, URL içi kimlik
  bilgisi, IP literali ve özel/ayrılmış host desenlerini reddeder; ağ istemcisi DNS düzeyinde
  `createPublicOnlyLookup` kullanır; AIA zincir tamamlama ayrıca SSRF korumalı
  (http/https, yalnızca açık IP, ≤2 yönlendirme, 1 MiB, ≤4 istek, ≤3 derinlik).
- **E-posta**: şablondaki her alan `escapeHtml`; taranan içerikten gelen konuda denetim
  karakteri temizliği (2026-10-13 denetiminin 7. maddesi); Resend/SMTP sağlayıcıları.
- **Başlıklar**: CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`),
  `X-Frame-Options: DENY`, `nosniff`, COOP, `permissions-policy`, `referrer-policy`;
  gövde sınırı 256 KB; CORS kapalı (yalnızca açık listeyle ve `credentials` ile açılır, `*` yok).
- **Arayüz**: `dangerouslySetInnerHTML`/`innerHTML`/`document.write` **yok**; toplanan içerik
  yalnızca düz metin/JSON olarak çizilir; `target="_blank"` bağları `rel="noopener noreferrer"`.
- **Yapılandırma**: `NODE_TLS_REJECT_UNAUTHORIZED=0` üretimde başlangıcı durdurur, diğer
  ortamlarda uyarı + kaldırma adımları; `POSTGRES_SSL_MODE=verify` varsayılan;
  `TRUST_PROXY` kapalıyken `X-Forwarded-For`'a güvenilmez; Swagger üretimde kapalı
  (`DOCS_ENABLED`); `SOURCE_LIVE_FETCH=0` doğrulama modunda hiçbir adaptör ağa çıkmaz.
- **Sır hijyeni**: git geçmişinde `.env`/sertifika/anahtar dosyası **yok** (yalnızca
  `.env.example`); kodda gömülü API anahtarı/jeton deseni yok; sihirbaz ve `--check`
  çıktısı maskeli; `.env` yedekleri `.env.yedek-<ISO>` adıyla aynı dizinde ve `.gitignore` kapsamında.
- **Dosya yolu**: kullanıcı girdisiyle birleştirilen sunucu tarafı dosya okuma ucu yok
  (yedek/geri yükleme yolları yalnızca yerel CLI operatöründen gelir).

## 3) Bilinen ve bilinçli kabul edilen sınırlar

1. `/api/health` ve `/api/health/worker` anonimdir (arayüzün ana sayfası ve dev başlatıcısı
   kullanır): sayaçlar ve sürümler görünür, hata ayrıntısı artık yöneticiye özeldir.
2. `toPublicSource` kaynak `statusNote`/`verification.evidence` alanlarını halka açar —
   kaynak şeffaflığı tasarım kararıdır; sır içermez.
3. AI/LLM uçları her **oturumlu** kullanıcıya açıktır; kayıt varsayılan olarak kapalıdır
   (`PUBLIC_REGISTRATION=false`) ve LLM anahtarı yoksa uç çalışmaz. Maliyet sınırı
   `LLM_*` anahtarlarıyla operatördedir.
4. scrypt maliyet parametreleri Node varsayılanıdır (N=16384, r=8, p=1). OWASP N=2^17
   önerir; artırmak mevcut özetleri geçersiz kılar, bu yüzden parola geçişi (yeniden hash)
   planıyla birlikte yapılmalıdır — tek başına değiştirilmedi.
5. Sınıflandırma/tekilleştirme **eşikleri değiştirilmedi**: insan etiketli ölçüm kümesi
   (`npm run eval:build-set`) olmadan eşik oynatmak gerçek ilan kaybettirir.

## 4) Doğrulama

```bash
npm test          # 959 test / 83 dosya yeşil (denetim öncesi 934/81)
npm run lint      # eslint temiz
npm run typecheck # tsc (strict) temiz
npm run build     # tsc + vite build temiz
npm audit         # 0 açık
```

Yeni regresyon dosyaları: `tests/guvenlik-yetki-regresyon.test.ts` (10),
`tests/guvenlik-url-siniri.test.ts` (7), `tests/smtp-tls.test.ts` (8).

## 5) Dağıtımdan sonra 2 dakikalık operatör kontrolü

```bash
# 1) Yönetici atlatması kapandı mı? (ikisi de 401/403 beklenir, 200 OLAMAZ)
curl -s -o /dev/null -w "%{http_code}\n" https://SIZIN-ALAN-ADINIZ/api/admin/overview
curl -s -o /dev/null -w "%{http_code}\n" https://SIZIN-ALAN-ADINIZ/%61pi/admin/overview

# 2) Ortam özeti artık yönetici istiyor mu? (401 beklenir)
curl -s -o /dev/null -w "%{http_code}\n" https://SIZIN-ALAN-ADINIZ/api/health/config

# 3) Yeni kod yüklü mü? (classification/extraction 2026.10.2)
curl -s https://SIZIN-ALAN-ADINIZ/api/health

# 4) SMTP doğrulaması kapanmış mı? (uyarı görmelisiniz, yoksa temizdir)
npm run env:check
```
