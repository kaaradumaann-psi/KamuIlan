# Güvenlik ve KVKK

## Kimlik doğrulama

- **Parola saklama**: `scrypt` (Node `crypto.scrypt`, rastgele 16 baytlık tuz,
  64 baytlık anahtar). Düz metin parola hiçbir yerde tutulmaz/loglanmaz.
  Doğrulama `timingSafeEqual` ile yapılır.
- **Parola kuralı**: en az 10 karakter; e-posta/kullanıcı adı içeremez; yaygın
  parolalar reddedilir (`src/server/passwords.ts`).
- **Oturum**: rastgele 32 baytlık jeton, veritabanında yalnızca **SHA-256 özeti**
  saklanır. Çerez: `kamuilan_session` — `HttpOnly`, `SameSite=Lax`,
  üretimde `Secure`, `Path=/`, TTL `SESSION_TTL_HOURS` (öntanımlı 14 gün).
- **CSRF**: Çift gönderim deseni. `kamuilan_csrf` çerezi (JS okuyabilir) + her
  yazan istekte `x-csrf-token` başlığı. Oturuma bağlı ve `timingSafeEqual` ile
  karşılaştırılır. Yalnızca `GET/HEAD/OPTIONS` muaf tutulur.
- **Kayıt politikası**: Dışarıdan **kendi kendine kayıt kapalıdır**
  (`ALLOW_PUBLIC_REGISTRATION=0`). Hesaplar yalnızca yönetici tarafından açılır
  (`POST /api/admin/users`): hesap giriş yapılamaz durumda oluşturulur, davetliye
  tek kullanımlık (72 saat) şifre belirleme bağlantısı gider ve parolayı kullanıcı
  kendisi seçer. Düz metin parola hiçbir aşamada üretilmez/gönderilmez/loglanmaz.
  `ALLOW_PUBLIC_REGISTRATION=1` yalnızca geçici test içindir; `npm run env:check`
  bu durumda uyarı verir.
- **E-posta doğrulama**: Doğrulama jetonu (tek kullanımlık, 24 saat) e-posta ile
  gönderilir. **Doğrulanmamış adrese bildirim gönderilmez.**
- **Şifre sıfırlama**: Tek kullanımlık jeton (1 saat). Kullanıcı varlığını sızdırmamak
  için yanıt her zaman aynıdır; sıfırlama sonrası tüm oturumlar iptal edilir.
- **Hız sınırı**: Genel `RATE_LIMIT_MAX_REQUESTS`/pencere; kimlik uçlarında
  (`login`, `forgot-password`, `reset-password`, davet) daha sıkı
  `AUTH_RATE_LIMIT_MAX_REQUESTS`. Sınır aşılırsa `429` + `retry-after`.
- **Sır yönetimi**: `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `POSTGRES_URL`
  ve `APP_SECRET` yalnızca sunucu ortamında tutulur; repoda yalnızca
  `.env.example` (boş/örnek değerler) bulunur. Üretimde sır yöneticisi kullanın.
- **RBAC**: `/api/admin/*` yalnızca `role: 'admin'`. Kullanıcı kendi verisine
  erişir; başka kullanıcının kaynağına erişim `404/403` ile engellenir
  (test: "kullanıcı yalnızca kendi bildirim geçmişini görür").

## Uygulama güvenliği

- **Girdi doğrulama**: Tüm uçlar zod şemalarıyla doğrulanır; hatalar standart
  gövdeyle döner: `{ "error": { "code": "validation_error", "message": "...", "details": [...] } }`.
- **XSS**: Toplanan içerik (ilan metni) arayüzde **metin** olarak render edilir
  (`whitespace-pre-wrap`), HTML olarak yorumlanmaz. Ayrıca katı CSP uygulanır
  (`default-src 'self'`; `img-src 'self' data:`).
- **NoSQL enjeksiyonu**: Sorgu anahtarları ve operatörler kullanıcı girdisinden
  gelmez; repository katmanı sabit alanlarla sorgular. `$` ile başlayan anahtarlar
  doğrulama şemasında reddedilir.
- **Güvenlik başlıkları**: `x-content-type-options`, `x-frame-options: DENY`,
  `referrer-policy`, `permissions-policy`, `cross-origin-opener-policy`,
  `content-security-policy`.
- **CORS**: Yalnızca `APP_BASE_URL` kaynağına izin verilir; çerez tabanlı akışta
  `credentials: true`. Arayüz tüm istekleri göreli `/api` üzerinden yapar.
- **Yönetici denetimi**: Kaynak CRUD, inceleme kararları, kuyruk müdahaleleri ve
  yapılandırma değişiklikleri `auditLogs` koleksiyonuna yazılır.

## Scraping güvenliği (SSRF ve içerik)

- **Alan adı beyaz listesi**: `SOURCE_ALLOWED_HOSTS`. Liste dışına çıkan istek ve
  yönlendirme reddedilir (`assertSafeUrl`).
- **Özel ağ engeli**: `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
  `169.254/16` (bulut metadata `169.254.169.254` dahil), `.internal`, `.local`
  desenleri engellenir.
- **Belge sınırları**: `MAX_DOCUMENT_BYTES` (öntanımlı 15 MB), `MAX_REDIRECTS`
  (3), `DOCUMENT_TIMEOUT_MS` (20 sn), akış sırasında boyut kesme.
- **İçerik türü**: Yalnızca `text/html`, `application/xhtml+xml`, `application/json`,
  `text/plain`, `application/pdf` işlenir; diğerleri kaydedilmez.
- **PDF**: Metin katmanı okunur; şifreli/bozuk PDF hata döner ve **çökertmez**,
  çalıştırılabilir içerik işlenmez, OCR zorlanmaz.
- **Hız sınırı ve nezaket**: Kaynak başına `minRequestIntervalMs`, `maxConcurrency`,
  ETag/Last-Modified ile koşullu istek, `429/503` durumunda üstel geri çekilme,
  açık `User-Agent` (`SCRAPE_USER_AGENT`).
- **Talimat enjeksiyonu**: Toplanan metin **veri** olarak kabul edilir; içinde
  geçen talimatlar asla yürütülmez. AI/LLM kullanılırsa aynı kural geçerlidir ve
  çıktı yalnızca öneri olarak inceleme kuyruğuna yazılır (otomatik karar vermez).

## KVKK / veri minimizasyonu

- **Toplanan kişisel veri**: Yalnızca e-posta adresi, isteğe bağlı görünen ad,
  parola özeti, bildirim tercihleri, oturum/jeton kayıtları ve bildirim geçmişi.
  İlan sahibi kişilere ait veriler **toplanmaz**; yalnızca kurumsal ilan metni işlenir.
- **Amaç sınırı**: Veriler yalnızca bildirim göndermek, oturum yönetmek ve
  güvenliği sağlamak için kullanılır; üçüncü taraflara satılmaz/aktarılmaz.
- **Bildirim izni**: Davetle açılan hesap bildirim aboneliği **başlatmaz**;
  kullanıcı tercihlerini açıkça kaydeder. Kullanıcı bildirimleri duraklatabilir
  veya tek tıkla abonelikten çıkabilir (jetonlu bağlantı).
- **Haklar**: Arayüzde "Hesabımı ve kişisel verilerimi sil" işlemi vardır
  (`confirm: 'SIL'` + parola doğrulaması). İşlem: kişisel alanlar (ad, e-posta,
  parola özeti) anonimleştirilir, tüm oturum ve jetonlar iptal edilir, tercihler
  silinir; ilan/istatistik kayıtları kişisel veri içermediği için kalır.
- **Saklama süreleri**: Oturumlar TTL ile, doğrulama/sıfırlama jetonları 1–24 saat,
  abonelik jetonları 1 yıl; süresi geçenler periyodik olarak temizlenir.
- **Günlük maskeleme**: E-posta adresleri ve jetonlar günlüklerde maskelenir.
- **Yedek/gizlilik**: Yedekler kişisel veri içerir; erişim kısıtlı tutulmalı ve
  saklama süresi belirlenmelidir.

## Sır yönetimi

- `.env` sürüm kontrolüne **girmez** (`.gitignore`), yalnızca `.env.example` vardır.
- Üretimde sır yöneticisi (Vault/AWS Secrets Manager/1Password vb.) veya en az
  `chmod 600` ile kök olmayan servis kullanıcısına ait ortam dosyası kullanın.
- `APP_SECRET` ve `EMAIL_VERIFICATION_SECRET` rotasyonu: Sır değişirse mevcut
  oturumlar ve doğrulama bağlantıları geçersiz olur; planlı bir pencerede yapın.
- Sırlar loglara, hata mesajlarına ve API yanıtlarına yazılmaz; `describeEnv()`
  yalnızca maskeli özet döner.

## Yasal/etik notlar

- Kaynakların kullanım koşullarına, `robots.txt` kurallarına ve hız sınırlarına
  uyulur. CAPTCHA/oturum duvarı gibi korumalar AŞILMAZ; kaynak
  `access-restricted`/`needs-manual-method` olarak işaretlenir.
- Her ilan kaydı kaynağına bağlantı verir; içerik yeniden yayımlanmaz, yalnızca
  yönlendirme ve özet bilgi gösterilir.
- Kapsamın eksik olduğu her yerde açıkça yazılır ("tüm ilanlar" iddiası yoktur).
