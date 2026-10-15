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
  `AUTH_RATE_LIMIT_MAX_REQUESTS`. Girişte ayrıca **hesap bazlı** sınır vardır:
  saldırgan IP değiştirse bile aynı e-posta adresine yapılan denemeler sayılır
  (`auth-login-account` kovası; e-posta hash'lenir). Sınır aşılırsa `429` +
  `retry-after`.
- **Zamanlama sızıntısı**: Var olmayan e-posta ile yapılan giriş denemesi de
  parola doğrulaması kadar sürer (sahte `scrypt` karşılaştırması); yanıt iki
  durumda da aynıdır. Böylece "bu adres kayıtlı mı?" bilgisi sızmaz.
- **Vekil güveni**: `X-Forwarded-For` başlığına yalnızca `TRUST_PROXY=1` iken
  güvenilir (öntanım 0). Başlık istemci tarafından yazılabildiği için aksi hâlde
  hız sınırı atlanır ve denetim kaydına uydurma IP yazılır. Uygulamanın önünde
  başlığı kendisi üreten bir vekil (Cloudflare/Nginx) varsa 1 yapın.
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
- **CORS**: Üretimde CORS **kapalıdır** — arayüz tüm istekleri göreli `/api`
  üzerinden yapar (geliştirmede Vite vekili). Yalnızca ayrı alan adından bir
  panel besleniyorsa `CORS_ORIGINS` ile açık liste verilir; "her kaynağa izin"
  verilmez (çerez tabanlı akışta `credentials: true`).
- **API dokümantasyonu**: `/api/docs` yalnızca geliştirme ortamında açıktır;
  üretimde `DOCS_ENABLED=1` denmedikçe kaydedilmez (API yüzeyi ve şema dışarıya
  gösterilmez). Arayüz varlıkları kendi sunucumuzdan gelir, CSP bozulmaz.
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
  geçen talimatlar asla yürütülmez. Panel yapay zekâ önerilerinde (`src/ai/`) aynı
  kural geçerlidir: sistem yönergesi ilan metnini veri sayar; model yalnızca
  aday kümesindeki kayıtlı ilan kimliklerini önerebilir, dışındaki kimlikler
  zod doğrulamasında atılır ve bozuk yanıt deterministik yedeğe düşer. Çıktı
  yalnızca öneri olarak gösterilir; hiçbir ilan veya kullanıcı verisi yazmaz.

## KVKK / veri minimizasyonu

- **Toplanan kişisel veri**: E-posta adresi, isteğe bağlı görünen ad, parola
  özeti, bildirim tercihleri, isteğe bağlı aday profili (meslek, eğitim, bölüm,
  beceri ve deneyim), oturum/jeton kayıtları ve bildirim geçmişi. İlan sahibi
  kişilere ait veri toplamamak hedeflenir; ancak kaynak metni kişilerden söz
  edebilir ve yalnızca kurumsal içerik olduğu varsayılamaz.
- **Metin minimizasyonu**: `makeExcerpt` yaygın e-posta adreslerini ve yaygın
  Türkiye telefon numarası kalıplarını `[e-posta gizlendi]` / `[telefon gizlendi]`
  ile değiştirir. `jobSources` artık tam yakalama gövdesini veya kullanılmayan
  kaynak alıntısını yazmaz; gövdeye ilişkin alanlar `capturedTextStatus` ve
  sınırlı yakalamanın karakter sayısıyla sınırlıdır (URL, başlık, kaynak kimliği
  ve ek bilgileri kaynak bağı kaydında kalır). Arama/eşleştirme için kullanılan
  ayrı `jobs.textExcerpt` alanı en çok 2.500 karakterdir ve aynı maskelemeden
  geçer; bu kopya arama, eşleştirme, ilan karşılaştırması ve detay ekranı
  tarafından gerçekten kullanıldığı için tutulur. `textNormalized`, yalnızca
  bu güvenli alıntının arama kopyasıdır. `contentHash` artık tam kaynak gövdesi
  yerine saklanan alıntı/başlık/tarih/kontenjan üzerinden hesaplanır ve kaynak
  doğrulama kanıtı değildir. İnceleme kuyruğundaki en çok 1.500 karakterlik
  alıntı yönetici kabul akışında tüketildiği için redakte edilerek tutulur.
  `npm run db:migrate` eski kaynak-bağı `capturedText`, `rawExcerpt` ve
  kullanılmayan `rawContentHash` değerlerini boşaltır; gövde varsa karakter
  sayısını ve durumu korur/tamamlar. Aynı komut mevcut `jobs.textExcerpt` ve
  `textNormalized` alanlarını yeniden sınırlar/redakte eder, alan kanıtlarını,
  review alıntılarını ve revision snapshot'larını temizler ve eski `contentHash`
  değerlerini yeniler. Bu göç her mevcut dağıtımın veritabanında ayrıca
  çalıştırılmalıdır; bu kod denetimi herhangi bir canlı veritabanının göç
  edildiğini kanıtlamaz. Kamu serializer'ı yalnızca kaynak yakalama durumu/sayısını
  ve koşula bağlı en çok 400 karakterlik, 500 karakter eşiğini geçen bir ilan
  alıntısını döndürür. Regex tabanlı maskeleme sezgiseldir: yazım varyantları,
  adlar ve diğer kişisel veriler için tam tespit garantisi değildir. Eski
  yedeklerde veya işlenmemiş dışa aktarımlarda bulunan içerik bu çevrimiçi göçle
  silinmez.
- **Profil kişiselleştirmesi**: Varsayılan olarak kapalıdır ve Panelim'de açıkça
  etkinleştirilir. İlan sayfasındaki profil karşılaştırması tarayıcıda yapılır ve
  hiçbir hizmete veri göndermez. Kullanıcı kişiselleştirmeyi istediği an kapatabilir
  (profil saklı kalır ama kullanılmaz) veya Panelim'deki profil silme işlemiyle
  alanları ayrıca boşaltabilir; hesap silme de profil alanlarını temizler.
- **Yapay zekâ önerileri (açık rıza)**: Panelim'deki "Bana uygun ilanlar" kartı
  yalnızca kullanıcı açık rıza verdikten sonra çalışır (`aiConsentAt`). Rıza olmadan
  hiçbir veri harici hizmete gönderilmez (403). Gönderilen alanlar: meslek, eğitim
  düzeyi, bölümler, beceriler, deneyim yılı ve en fazla 12 aday ilanın başlık, kurum,
  şehir, çalışma biçimi, son başvuru tarihi, kontenjan ve eğitim/bölüm/KPSS koşulları. Ad, e-posta, parola, TC kimlik ve diğer kimlik bilgileri
  **gönderilmez** (`buildMessages` testleri bunu doğrular). Rıza geri çekilince
  veya hesap silinince önbellek temizlenir ve rıza alanı sıfırlanır. Sağlayıcı
  `LLM_*` ortam değişkenleriyle yapılandırılır; sağlayıcı kendi saklama politikasını
  uygular. Kamuİlan sağlayıcıya gönderilen içeriği saklamaz; yalnızca sayısal
  denetim kaydı (`ai.suggestions`) tutulur. Günlük kota (`AI_DAILY_LIMIT_PER_USER`)
  kullanıcı başına model çağrısını sınırlar; önbellek isabetleri ve yedek sonuçlar
  kotadan düşmez.
- **Telegram bildirimleri**: Bağlantı, Telegram sohbet kimliği ve (varsa) kullanıcı
  adını tutar; hesap silme bağlantıyı siler. Bot komutları: `/dur`, `/basla`,
  `/cik`, `/durum`. Bildirim metinleri Telegram Bot API üzerinden iletilir.
- **Amaç sınırı**: Hesap verileri bildirim, oturum ve güvenlik için; isteğe bağlı
  aday profili ilan eşleştirmesi için kullanılır. Profil eşleşmesi bildirim
  aboneliğinden bağımsızdır. Veriler satılmaz; yapay zekâ hizmetine yalnızca açık
  rıza ile ve yukarıdaki sınırlı alanlarla aktarılır.
- **Telegram kanalı**: Yalnızca kullanıcı botla kendi isteğiyle bağlandığında etkinleşir; bot yalnızca
  özel sohbeti kabul eder. `/cik` veya hesap silme bağlantıyı kaldırır.
- **Bildirim izni**: Davetle açılan hesap bildirim aboneliği **başlatmaz**;
  kullanıcı tercihlerini açıkça kaydeder. Kullanıcı bildirimleri duraklatabilir
  veya tek tıkla abonelikten çıkabilir (jetonlu bağlantı).
- **Haklar**: Arayüzde "Hesabımı ve kişisel verilerimi sil" işlemi vardır
  (`confirm: 'SIL'` + parola doğrulaması). İşlem: kişisel alanlar (ad, e-posta,
  parola özeti) anonimleştirilir, aday profili boşaltılır, profil kişiselleştirmesi
  ve bildirimler kapatılır, tüm oturum ve jetonlar iptal edilir; ilan/istatistik
  kayıtları kişisel veri içermediği için kalır.
- **Saklama süreleri**: Oturumlar TTL ile, doğrulama/sıfırlama jetonları 1–24 saat,
  abonelik jetonları 1 yıl; süresi geçenler periyodik olarak temizlenir.
- **Günlük maskeleme**: E-posta adresleri ve jetonlar günlüklerde maskelenir.
  Kariyer Kapısı'nın satırsız HTTP listesi için yazılan sayfa başlığı da `makeExcerpt`
  üzerinden geçirilir; bu yardımcı yaygın e-posta ve Türkiye telefonu kalıplarını
  maskeler. Bu örnek, her kaynak metnindeki her kişisel verinin yakalandığı
  anlamına gelmez.
- **Bakım hataları**: `db:migrate` başarısızlığında ham hata nesnesi, mesajı ve
  stack'i yazılmaz; yalnızca biçimi/sınırı doğrulanmış hata türü ve kodu tutulur.
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

- Kaynağın kullanım koşulları, `robots.txt` ve hız sınırları onboarding sırasında
  elle incelenmelidir; CAPTCHA/oturum duvarı gibi korumalar aşılmaz ve erişim
  engelleri kapsam dışı bırakılır. Önemli sınırlama: bu sürüm her istekte
  `robots.txt` dosyasını otomatik indirip değerlendirmez; davranış çalışma
  zamanında bir politika kapısı değildir. Canlı yetki/izin ve uygunluk ayrıca
  doğrulanmalıdır.
- Her ilan kaydı kaynağına bağlantı verir. Kamu API'si tam yakalanmış gövdeyi
  yayımlamaz; gövde uzunsa sınırlı alıntı gösterilebilir (ayrıntı ve sınırlar
  için [limitations.md](./limitations.md)).
- Kapsamın eksik olduğu her yerde açıkça yazılır ("tüm ilanlar" iddiası yoktur).
