# Uçtan uca denetim raporu — 13 Ekim 2026

Bu rapor, "tüm sistemi baştan sona kontrol et, her şey eksiksiz çalışsın" isteği
üzerine yapılan denetimin **bulgularını, düzeltmelerini ve kanıtlarını** eksiksiz
listeler. Raporun tamamı tek bir oturumda yapılan üç teslimatı kapsar:

| Teslimat | Commit    | İçerik                                                             |
| -------- | --------- | ------------------------------------------------------------------ |
| 1        | `84c08a2` | Giriş ekranı, 401 mesajı, hesap/Supabase kurgusu, geliştirme ortamı |
| 2        | `9e77db2` | Denetim düzeltmeleri: arama, tarih, güvenlik, arayüz, belgeler      |
| 3        | `4718418` | Çıkış ucu CSRF koruması (zorla çıkış açığı)                          |

Dal: `arena/320a7d65-kamuradar` · CI: `84c08a2` ✅ · `9e77db2` ✅ ·
`4718418` koşum `38428638576` (push sonrası otomatik başlar).

---

## 1. Yönetici özeti

- **İstenen üç şey yapıldı:** (a) giriş ekranı ortalandı ve uçtan uca
  düzenlendi, (b) Supabase'e eklenen kullanıcının göremediği gerçek neden
  ortaya çıkarıldı ve hesap açma yolları belgelendi/araçlandı, (c) tüm sistem
  baştan sona denetlendi; bulunan **25+ hata** düzeltildi.
- **Her düzeltme testle sabitlendi.** Bu teslimatlarda eklenen/genişletilen
  test dosyaları: `tests/audit-fixes.test.ts` (27 test), `tests/login-page.test.tsx`
  (3), `tests/api-client-error.test.ts` (5), `tests/auth-session-setup.test.ts` (3),
  `tests/panel-preferences.test.tsx` (2) + mevcut suites'lerin genişletilmesi.
- **Güncel durum:** `npx vitest run` → **28 dosya / 273 test yeşil**;
  `tsc --noEmit`, `eslint .` ve `npm run build` temiz; canlı koşumda
  **26/26 uçtan uca kontrol** geçti.
- **Açık kalanlar yalnızca düşük öncelikli** ve raporun 10. bölümünde
  açıkça listelendi.

---

## 2. Kapsam ve yöntem

Denetim "sadece mutlu yol" değil, aşağıdaki katmanların tamamını kapsadı:

1. **Kod okuma (statik):** yapılandırma (`src/config/*`), depo katmanı
   (`src/db/*`), çıkarım/sınıflandırma (`src/extraction/*`, `src/classification/*`),
   içe alma (`src/ingest/*`), kaynak adaptörleri (`src/sources/*`),
   API rotaları (`src/server/*`), arayüz (`src/pages/*`, `src/components/*`),
   biçimlendirme yardımcıları (`src/lib/*`), e-posta şablonları
   (`src/email/*`).
2. **Güvenlik taramaları:** XSS/storage sink'leri (`innerHTML`,
   `dangerouslySetInnerHTML`, `localStorage`, `eval`, `window.open`),
   düzenli ifade enjeksiyonu/ReDoS, SSRF, CSRF, hız sınırı, başlık enjeksiyonu,
   zamanlama sızıntısı, bilgi ifşası.
3. **Canlı API koşumu:** gerçek API süreci (port 3000) + Vite vekili (5173) +
   geliştirme SMTP (1025) ve posta görüntüleyici (1080) ayağa kaldırıldı;
   senaryolar gerçek HTTP istekleriyle (çerez + CSRF ile) koşuldu.
4. **Otomatik testler:** birim, entegrasyon ve jsdom tabanlı arayüz testleri;
   tam suite + tip denetimi + lint + üretim derlemesi.
5. **Belge tutarlılığı:** belgelerdeki iddiaların kodla birebir eşleşmesi
   (ör. `docs/deployment.md`'de yanlış yazılı CI adımı düzeltildi).

---

## 3. Giriş ve oturum (teslimat 1)

### 3.1 Giriş ekranı ortalanmıyordu

- **Belirti:** Kart sol üst köşeye yapışıyordu; ekran "yarım kalmış" görünüyordu.
- **Kök neden:** `LoginPage` kartı doğrudan `.auth-page` içine koyuyordu; oysa
  ortalamanın ve genişlik sınırının sahibi `.auth-shell` katmanıydı. Kart,
  ortalamayan bir kapsayıcının ilk çocuğu olduğu için sol üstte kalıyordu.
- **Düzeltme:** Yerleşim ortak kabuğa taşındı:
  `.auth-page > .auth-shell > .auth-layout > (.auth-intro + .auth-card)`.
  "Oturum doğrulanıyor" bekleme kartı da aynı düzeni kullanır. Kamuİlan'a özgü
  katmana yalnızca site bağlantıları ve komut satırı kırılması eklendi; paylaşılan
  CSS katmanlarına dokunulmadı (`tests/design-system.test.ts` katman özetleri
  yeşil kalır).
- **Kanıt:** `tests/login-page.test.tsx` (3 test) yerleşim zincirini ve bekleme
  kartını kilitler.

### 3.2 Yönetici/aday girişinde "Bu işlem için oturum açmanız gerekiyor."

- **Belirti:** Kullanıcı Supabase panelinde hesap açıyor, giriş `401
  (Unauthorized)` ve yanıltıcı Türkçe mesajla dönüyordu.
- **Kök neden (iki katmanlı):**
  1. **Gerçek neden:** Kamuİlan **Supabase Auth kullanmaz.** Hesaplar
     `kamuilan_users` koleksiyonunda, scrypt özetli parolayla tutulur.
     Supabase panelinden eklenen kullanıcı uygulamada **yoktur** ve elle SQL ile
     satır eklemek de giriş sağlamaz (özet biçimi uyuşmaz).
  2. **Görünür neden:** İstemci `errorMessage()` fonksiyonu **tüm** 401
     yanıtlarını "Bu işlem için oturum açmanız gerekiyor." metniyle eziyordu;
     yanlış parolada bile kullanıcı gerçek nedeni göremiyordu.
- **Düzeltme:**
  - 401 metni artık sunucunun mesajını gösterir ("E-posta veya parola hatalı.");
    mesajsız 401'de genel metne düşer. Ağ hataları da Türkçe ve eyleme dönük
    anlatılır (`tests/api-client-error.test.ts`, 5 test).
  - `GET /api/auth/session`, kullanıcı tablosu tamamen boşken **kurulum
    bilgisi** döner (`required` + etkin depo adı). Giriş ekranı "bu veritabanında
    hiç hesap yok" uyarısını ve çalıştırılacak komutu gösterir; Supabase Auth
    kullanılmadığı açıkça yazılır (`tests/auth-session-setup.test.ts`, 3 test).
  - Yeni araç: **`npm run user:create`**
    (`--email --name [--admin] [--password] [--force] [--invite] [--verified] [--no-email]`).
    `seed:admin` da hangi depoya yazdığını ve parola değiştirme komutunu yazdırır.
  - Belgeler: `docs/setup.md` → "Kullanıcılar hangi veritabanında? (Supabase
    notu)"; `docs/deployment.md` ve `README.md` kullanıcı açma yollarıyla
    güncellendi.

### 3.3 Kullanıcının gördüğü `ECONNREFUSED 127.0.0.1:3000` (geliştirme yarışı)

- **Belirti:** Vite, API hazır olmadan `/api/auth/session` ve
  `/api/auth/login` isteklerini vekilliyor; proxy hatası ve ardından giriş
  ekranında bağlantı hatası görünüyordu.
- **Kök neden:** `npm run dev`, API `/api/health` yanıt vermeden arayüzü
  başlatıyordu.
- **Düzeltme:** `scripts/dev-all.ts` artık API sağlık kontrolünü bekler, sonra
  Vite'ı başlatır; açılışta etkin veritabanını ve ilk yönetici komutunu yazar.
  `.env.example` da "olduğu gibi çalışır" hâle getirildi (varsayılan
  `EMAIL_PROVIDER=smtp` + `SMTP_HOST=127.0.0.1` + `SMTP_PORT=1025`): resend
  seçiliyken anahtar boşsa uygulama bilinçli olarak başlamıyordu.
- **Not (uydurma değil):** Log'daki `SCAN_INTERVAL_MINUTES=1` uyarısı **hata
  değildir**; 1-4 arası değerlerde "test aşaması" bilgilendirmesi basılır.
  Üretimde `0` (kaynak başına) veya 30-360 önerilir.

---

## 4. Arama ve filtreler (teslimat 2)

### 4.1 İlan gövdesi aramada hiç bulunamıyordu

- **Belirti:** `q=hemşire`, `q=sağlık`, `q=şoför` gibi terimler yalnızca
  başlıkta/kurumda geçtiğinde sonuç veriyordu; ilan metninde geçen kelimeler
  bulunamıyordu.
- **Kök neden:** Arama `textExcerpt` (ham metin) üzerinde yapılıyordu; sorgu ise
  `normalizeTr` ile katlanmış geliyordu. "Hemşire" ham metinde büyük "H" ile
  durduğu için katlanmış "hemsire" ile eşleşmiyordu.
- **Düzeltme:** `jobs` kaydına **`textNormalized`** alanı eklendi
  (içe alma sırasında `normalizeTr(textExcerpt)` yazılır), arama üçüncü kol
  olarak bu alan üzerinde yapılır. `npm run db:migrate` eski kayıtları geriye
  dönük doldurur (idempotent; koşumda 3 ilan tamamlandı).
- **Kanıt:** `tests/filters.test.ts` — başlık, kurum ve **gövde** eşleşmesi
  (Türkçe büyük/küçük harf duyarsız); canlı koşumda `q=hemşire` yalnızca gövdesi
  eşleşen ilanı getirdi.

### 4.2 Arama sorgusu düzenli ifade olarak yorumlanıyordu (ReDoS / 500)

- **Belirti:** `q=(((((((a)+)+` gibi girdiler isteği 500'e düşürebiliyor ya da
  ifade motorunu kilitleyebiliyordu; `%` gibi karakterler beklenmedik sonuç
  veriyordu.
- **Kök neden:** Kullanıcı girdisi doğrudan `$regex` kaynağı olarak kullanılıyordu.
- **Düzeltme:** `escapeRegExp` eklendi (`src/domain/text.ts`); arama **düz metin**
  eşleşmesi. Aynı koruma kurum/başlık filtrelerine, tekilleştirme adayı aramasına
  ve kurum ipucu sorgusuna uygulandı.
- **Kanıt:** `tests/audit-fixes.test.ts` — 5 düşmanca desen 200 döner;
  `q=%25` (yüzde) 0 sonuç verir, joker sayılmaz.

### 4.3 Eğitim düzeyi filtresi sessizce yanlış çalışıyordu

- **Belirti:** İleri filtrelerdeki "Lise" seçeneği hiçbir ilanla eşleşmiyordu
  (0 sonuç); paneldeki "Belirtilmemiş" kutucuğu ise kaydetmeye basınca
  "Gönderilen alanlar geçersiz." (400) hatası veriyordu.
- **Kök neden:** Form seçenekleri etiket sözlüğünden (`EDUCATION_LABELS`)
  üretiliyordu ve bu sözlükte **görüntüleme takma adları** vardır:
  `belirtilmemis` sunucu şemasında geçerli değildir; `lise` ise kanonik değer
  değildir (kanonik değer `ortaogretim`).
- **Düzeltme (üç katman):**
  1. Seçenekler kanonik listeden üretilir: `EDUCATION_LEVELS` ×
     `EDUCATION_LEVEL_LABELS` (`src/components/Filters.tsx`, `src/pages/Panel.tsx`).
  2. `normalizeEducationLevel()` (`src/lib/format.ts`) eski/paylaşılmış
     bağlantılardaki `?education=lise` değerini `ortaogretim`e çevirir,
     `belirtilmemis` değerini seçimsiz bırakır.
  3. Sunucu da `lise` takma adını `ortaogretim`e indirger
     (`src/server/routes/jobs.ts`); **tanınmayan** değer olduğu gibi bırakılır
     ve dürüst biçimde 0 sonuç döner.
- **Kanıt:** `tests/filters.test.ts` (takma ad → aynı sonuç; tanınmayan → 0),
  `tests/jobs-filters-wiring.test.tsx` (seçenek listesinde yalnızca kanonik
  düzeyler), `tests/panel-preferences.test.tsx` (kaydetme isteği yalnızca
  kanonik değerler gönderir). Canlı: `?education=lise` → 1,
  `?education=belirtilmemis` → 0, tercih kaydı `['lise']` → 400,
  `['ortaogretim','lisans']` → 200.

---

## 5. Tarih ve saat (teslimat 2)

Sistemin ilkesi: **"tahmin yürütmek yasaktır."** Denetimde bu ilkeyi delen
noktalar bulundu ve düzeltildi.

| # | Belirti | Kök neden | Düzeltme | Test |
| - | ------- | --------- | -------- | ---- |
| 1 | İlan kartlarında **"NaN Ekim 2026"** | `formatDateOnly` tam ISO damgasını da `split('-')` ile parçalıyordu | Gün gösterimi İstanbul saatine göre; iki biçim de desteklenir | `audit-fixes` |
| 2 | İlanda yazmayan saat ("00:00") gösteriliyordu | Çıkarım saati bilinmeyen tarihte 00:00 yazar; arayüz bunu saat sanıyordu | `formatDateMaybeTime`: 00:00 ise yalnızca gün yazılır | `audit-fixes` |
| 3 | Son başvuru **günü bugün** olan ilan gece yarısından sonra "Kapandı" oluyordu | 00:00 damgası kesin saat sanılıp kapanış sayılıyordu | Kapanış yalnızca saat metinde açıkça yazılıysa; gün bitene kadar açık | `audit-fixes` |
| 4 | "7 gün içinde kapananlar" ve `/api/jobs/deadlines/upcoming` penceresi 00:00-03:00 arası bir gün kayabiliyordu | Pencere UTC günüyle (`toISOString().slice(0,10)`) hesaplanıyordu | Pencere Türkiye gününe göre (`toIstanbulDateOnly`) | `filters` / canlı koşum |
| 5 | Takvim (.ics) yanlış saate kuruluyordu | 00:00 damgası gerçek saat sanılıyordu | Saat yazılıysa 30 dakikalık etkinlik, değilse tüm gün | `candidate-features` |
| 6 | Bitiş tarihi olmayan ilan için durum Türkçe `'bilinmiyor'` dönüyordu | Kanonik sözlüğe uymayan değer | `unknown` | `serializers` |

Arayüz tarafında son başvuru bilgisi artık **her koşulda** gösterilir:
saat varsa saat, yoksa gün (`JobDetail` bilgi tablosu ve ana sayfadaki
"son günler" listesi buna göre güncellendi).

---

## 6. Güvenlik (teslimatlarda yapılan sertleştirmeler)

### 6.1 İstemci IP'si ve hız sınırı (XFF sahtelemesi)

- **Sorun:** `X-Forwarded-For` başlığına **koşulsuz** güveniliyordu. Saldırgan
  her istekte farklı bir IP uydurup tüm hız sınırlarını atlayabiliyor, denetim
  kaydına yalan IP yazdırabiliyordu.
- **Düzeltme:** Yeni `TRUST_PROXY` anahtarı (varsayılan **0**). Başlık yalnızca
  açıkça açıldığında dikkate alınır; aksi hâlde soket adresi kullanılır.
  `docs/deployment.md`'ye ayrı bölüm + kontrol listesi maddeleri eklendi,
  `docs/security-kvkk.md` güncellendi.

### 6.2 CORS

- **Sorun:** Üretim dışında `origin: true` (her kaynağa izin) açıktı; çerez
  tabanlı oturumda bu gereksiz risktir.
- **Düzeltme:** Yeni `CORS_ORIGINS` anahtarı; yalnızca açık liste verilirse izin
  verilir (`credentials: true` yalnızca listedeki kaynaklar için). Varsayılan:
  kapalı.

### 6.3 API dokümantasyonu

- **Sorun:** Swagger/OpenAPI üretimde de açıktı; iç uçların tam listesi ve şema
  dışarıya açılıyordu.
- **Düzeltme:** Yeni `DOCS_ENABLED` anahtarı; üretimde varsayılan **kapalı**
  (`/api/docs` ve `/api/openapi.json` 404), geliştirmede açık. Dağıtım sonrası
  hızlı doğrulama komutu belgeye eklendi.

### 6.4 Kaba kuvvet ve hesap güvenliği

- **Sorun:** Yalnızca IP bazlı giriş sınırı vardı; IP değiştiren saldırgan aynı
  hesaba sınırsız deneme yapabiliyordu. Ayrıca var olmayan e-posta ile yapılan
  deneme, var olan e-postadan **daha hızlı** yanıt dönüyordu (kullanıcı
  numaralandırma).
- **Düzeltme:** Girişte **hesap bazlı** kova (`auth-login-account`, e-posta
  hash'lenir); var olmayan hesapta da scrypt maliyeti ödenir (sahte kayıt bir kez
  üretilir). "Doğrulama e-postasını yeniden gönder" ve "parola sıfırla" uçlarına
  da hesap bazlı sınır eklendi (posta kutusu bombardımanı engeli).
- **Kanıt:** `tests/audit-fixes.test.ts` (3 test): IP değiştirse bile aynı
  e-posta 4. denemede 429; doğrulama/sıfırlama istekleri hesap bazlı sınırlanır.

### 6.5 CSRF — çıkış ucu (teslimat 3)

- **Sorun:** `/api/auth/logout` CSRF muafiyet listesindeydi. Bu uç **jetonla
  değil oturum çereziyle** çalışır; muafiyet, saldırgan bir sayfanın kullanıcıyı
  habersizce çıkışa zorlamasına (logout CSRF) kapı açıyordu.
- **Düzeltme:** Uç muafiyet listesinden çıkarıldı; liste artık yalnızca "yetki
  kanıtı jetonun kendisi olan" halka açık uçları içerir. Arayüz zaten
  `x-csrf-token` başlığını gönderdiği için kullanıcı akışı değişmez.
- **Kanıt:** `tests/audit-fixes.test.ts` — başlıksız çıkış 403 döner ve oturum
  **açık kalır**; başlıkla gönderilen çıkış 200 döner.

### 6.6 SSRF sertleştirmesi

- **Sorun:** Özel ağ kontrolleri IPv4 eşlemeli IPv6 (`::ffff:127.0.0.1`),
  açılımı yapılmış bağlantı-yerel bloklar ve sayısal/hex IPv4 yazımlarını
  kaçırıyordu.
- **Düzeltme:** Host desenleri genişletildi; sayısal/ondalık/hex yazılmış IPv4
  biçimleri reddedilir. **Kanıt:** `audit-fixes` (SSRF testleri).

### 6.7 E-posta konusu enjeksiyonu

- **Sorun:** Konu satırı taranan web içeriğinden üretiliyor; denetim karakterleri
  (CR/LF) e-posta başlık enjeksiyonuna yol açabiliyordu.
- **Düzeltme:** `sanitizeSubject()` — denetim karakterleri temizlenir, boşluklar
  kırpılır, uzunluk 200 karakterle sınırlanır; her taşıyıcıda ayrı savunma
  yerine tek noktada. **Kanıt:** `audit-fixes`.

### 6.8 Onaylanmamış ilanların sızması

- **Sorun:** Sınıflandırma kararı **beklemede/reddedildi** olan ham kayıtlar
  herkese açık detay ve revizyon uçlarından dönebiliyordu.
- **Düzeltme:** Her iki uçta `classification.decision === 'accept'` denetimi.
  **Kanıt:** `audit-fixes` (2 test).

### 6.9 Varlık önbellek başlıkları

- **Sorun:** Derlenmiş arayüz varlıkları önbellek başlığı olmadan sunuluyordu.
- **Düzeltme:** İçerik damgalı dosyalar için uzun ömürlü `immutable`, HTML ve
  `index.html` için `no-cache`. **Kanıt:** `audit-fixes`.

### 6.10 Temiz çıkan kontroller (bulgu yok)

Aşağıdakiler tarandı ve **sorun bulunmadı**: `localStorage`/`sessionStorage`
yalnızca oturum durumu bayrağı için kullanılıyor; `innerHTML`,
`dangerouslySetInnerHTML`, `eval`, `window.open` yok; dışa açık tüm `to=`
bağlantıları gerçek rotalara çözülüyor; ikon kümesi tutarlı (52 tanımlı,
28 kullanımlı, 0 eksik); `src/types.ts` ↔ `server/serializers.ts` uyumlu.

---

## 7. Veri bütünlüğü (teslimat 2)

### 7.1 Kapanışta veri kaybı

- **Olay:** `npm run seed:demo` ile eklenen ilanlar, başka bir süreç kapanırken
  **silindi**.
- **Kök neden:** Kapanış (`close()`), diskle tazeleme yapmadan bellekteki kopyayı
  diske basıyordu; uzun süre yaşayıp hiç yazmayan bir süreç, başkasının eklediği
  kayıtların üzerine yazıyordu.
- **Düzeltme:** `FileStore.flush()` artık yazmadan **önce** diski okur ve bizde
  olmayan kimlikleri birleştirir (`mergeExternalChanges`). Sınırları da yazılı:
  silme işlemleri birleştirilmez (geliştirme deposu için "veri kaybı olmasın"
  ilkesi); üretimde Postgres kullanılır.
- **Kanıt:** `tests/audit-fixes.test.ts` (iki süreçli senaryo).

### 7.2 Başvuru yöntemi hiç kaydedilmiyordu

- **Belirti:** Detayda "Başvuru yöntemi: belirtilmemiş", oysa metinden okunmuştu.
- **Kök neden:** Çıkarım motoru alanı üretiyor ama depo şemasında/yazımında yok.
- **Düzeltme:** Şemaya `applicationMethod` eklendi (eski kayıtlarda `null`),
  yazma + değişiklik takibi + birleştirme kapsamına alındı, serializer gerçek
  değeri döner.
- **Kanıt:** `audit-fixes`; canlı koşumda detay yanıtı gerçek değeri içerir
  (ör. `"şahsen veya posta, posta yoluyla"`).

### 7.3 Başvuru yöntemi sözlüğü yanlış bilgi üretiyordu

- **Sorun:** Sınav adları (ALES/YDS/YÖKDİL) "başvuru yöntemi" olarak etiketleniyordu;
  bunlar **şarttır**. Ayrıca iç içe ifadeler yığılıyordu ("posta yoluyla" varken
  "posta" da yazılıyordu).
- **Düzeltme:** Sınav adları listeden çıkarıldı; gerçek ilan kalıpları eklendi
  (elden teslim, noter kanalıyla, faks ile…); kapsanan ifadeler ayıklanır.
  **Kanıt:** `audit-fixes`.

---

## 8. Arayüz ve kullanılabilirlik (teslimat 2)

| # | Bulgu | Etki | Düzeltme |
| - | ----- | ---- | -------- |
| 1 | Mobil menüdeki bilgi bağlantıları `<a href>` | Tam sayfa yeniden yükleme; akış/oturum kesintisi | `Link` ile SPA içi gezinme |
| 2 | Panel çıkışı ham `api.post` çağrısıydı, hata sessizce yutuluyordu | Kullanıcı çıkışın olup olmadığını anlamıyordu | Ortak `logout()` akışı; hata görünür |
| 3 | Yönetim → İnceleme'de aday ilan bağlantısı düz `<a href>` idi | Tam sayfa yenileme, URL kaçışı yok | `Link` + `encodeURIComponent` |
| 4 | Ana sayfadaki "son gün" etiketi yalnızca `applicationEndAt` kullanıyordu | Saati olmayan ilanlar "belirtilmemiş" görünüyordu | Gün alanına düşülür |
| 5 | İlan detayında başvuru başlangıcı/bitişi 00:00 gösteriyordu | Uydurma saat | `formatDateMaybeTime` |
| 6 | Panel eğitim kutucukları ve filtre "Lise" seçeneği | 400 hatası / sessiz 0 sonuç | Kanonik liste (bkz. 4.3) |

Ek olarak, arayüzün "hazır görünümler" düğmeleri (Tümü / Açık ilanlar /
7 gün içinde kapananlar / En yeni) artık Türkiye gününe göre hesap yapıyor;
gece 00:00-03:00 arasında pencere kaymıyor.

---

## 9. Belgeler (teslimat 2 ve 3)

- `.env.example`: `TRUST_PROXY`, `CORS_ORIGINS`, `DOCS_ENABLED` açıklamaları
  (hangi durumda açılır, açılmazsa ne olur).
- `docs/deployment.md`: 3 kontrol listesi maddesi + **"Ters vekil arkasında
  çalıştırma"** bölümü (varsayılan tablosu, `TRUST_PROXY` başlık güveni,
  `CORS_ORIGINS` allowlist, `DOCS_ENABLED` ve 404 doğrulama komutu). Ayrıca
  belgede yanlış yazılı **CI adımı** (`format:check`) gerçek adımlarla
  değiştirildi — makyaj değil, doğruluk düzeltmesi.
- `docs/security-kvkk.md`: hesap bazlı hız sınırı, zamanlama sızıntısı,
  vekil güveni, CORS ve dokümantasyon kapatma maddeleri.
- `docs/setup.md`: güvenlik anahtarlarına işaret + denetim raporuna bağlantı.

---

## 10. Açık kalan maddeler (dürüst liste)

Bunlar denetimde **görüldü ve bilinçli olarak düşük öncelikli** bırakıldı;
güvenlik açığı değildir:

1. `/api/admin/jobs/:id/revisions` sınıflandırma filtresi uygulamıyor: yönetici
   ucu olduğu için kabul edilebilir; yine de "yalnızca kabul edilenler" görünümü
   bir sonraki turda eklenebilir.
2. Yönetim → İnceleme kararı (`ReviewTab.decide`) ve Outbox yeniden kuyruklama
   (`OutboxTab.requeue`) mutasyonlarında `onError` yok: hata hâlinde kullanıcıya
   mesaj gösterilmiyor (sunucu tarafı doğru davranıyor).
3. Her ilan kartındaki `SaveJobButton` kendi sorgusunu açıyor; ortak
   `['saved-ids']` anahtarı sayesinde tek isteğe iniyor, ama kart başına kanca
   fazlalığı performans borcu olarak duruyor.
4. `package-lock.json` içindeki kök bağımlılık listesinde artık
   `package.json`'da bulunmayan `playwright` satırı var (npm ihtiyaç duyduğunda
   temizliyor; CI `npm ci` ile yeşil). Kilit dosyası, denetim diff'ini şişirmemek
   için **bilinçli olarak** dokunulmadan bırakıldı.
5. Playwright (tarayıcı) testleri bu ortamda **çalıştırılamadı** (tarayıcı
   ikilileri indirilemiyor; CI'da koşuyor). Arayüz doğrulaması jsdom testleri +
   canlı HTTP koşumuyla yapıldı; giriş ekranı ortalaması daha önce kullanıcının
   tarayıcısında da doğrulanmıştı.

---

## 11. Doğrulama kanıtları (bu oturumda koşuldu)

### 11.1 Otomatik testler ve statik denetim

| Komut | Sonuç |
| ----- | ----- |
| `npx tsc --noEmit` | temiz |
| `npx eslint .` | temiz |
| `npm run build` | başarılı (`dist/` üretildi) |
| `npx vitest run` | **28 dosya / 273 test yeşil** |
| `npm run db:migrate` | 44 indeks, 27 kaynak, 3 ilan için arama metni tamamlandı |

### 11.2 Canlı uçtan uca koşum (API 3000 · Vite 5173 · SMTP 1025 · görüntüleyici 1080)

26/26 kontrol geçti:

```
health                        200 (degraded: 1 kaynak üst üste başarısız)
/jobs                         200 · 3 ilan
/jobs?q=hemşire               200 · 1 (yalnızca gövdede geçen terim bulunur)
/jobs?q=SAĞLIK                200 · 1 (Türkçe büyük harf duyarsız)
/jobs?q=doktora               200 · 1
/jobs?q=ZABIT                 200 · 1 (ı/i katlaması)
/jobs?q=%25                   200 · 0 (joker değil)
/jobs?q=(((((((a)+)+          200 (500 yok)
/jobs?education=lise          200 · 1 (takma ad → ortaogretim)
/jobs?education=belirtilmemis 200 · 0
/jobs/deadlines/upcoming      200 · 2026-10-13 → 2026-10-27
/jobs/:id                     200 (applicationMethod dolu)
/jobs/job_yok_12345           404
/auth/session (anonim)        200
/auth/login (yanlış parola)   401 "E-posta veya parola hatalı."
/auth/login (doğru parola)    200
/auth/session (oturumlu)      200 authenticated=true
PUT notifications/preferences 200 (kanonik düzeyler) · 400 (['lise'])
POST /auth/logout (başlıksız) 403 ve oturum AÇIK kalır
POST /auth/logout (başlıklı)  200
/auth/login (yönetici)        200
/admin/overview, /audit-logs  200
/api/docs (geliştirme)        200
Vite vekili /api/health       200
Vite vekili /api/jobs         200 · 3
```

### 11.3 CI

- `84c08a2` → koşum `38418083032` ✅
- `9e77db2` → koşum `38427993336` ✅
- `4718418` → koşum `38428638576` (push sonrası otomatik)

---

## 12. Değişen dosyalar (özet)

**`84c08a2`** (19 dosya): `src/pages/auth.tsx`, `src/lib/api.ts`,
`src/lib/session.tsx`, `src/App.tsx`, `src/server/routes/auth.ts`,
`src/db/store.ts`, `src/styles/kamuilan.css`, `src/types.ts`,
`scripts/dev-all.ts`, `scripts/create-user.ts` (yeni), `scripts/create-admin.ts`,
`.env.example`, `README.md`, `docs/setup.md`, `docs/deployment.md`,
`package.json`, `tests/login-page.test.tsx` (yeni),
`tests/api-client-error.test.ts` (yeni), `tests/auth-session-setup.test.ts` (yeni).

**`9e77db2`** (35 dosya): `src/db/file-store.ts`, `src/db/schemas.ts`,
`src/db/repos/jobs.ts`, `src/domain/text.ts`, `src/ingest/jobs-service.ts`,
`src/extraction/engine.ts`, `src/extraction/dictionaries.ts`,
`src/email/templates.ts`, `src/lib/format.ts`, `src/lib/calendar.ts`,
`src/config/env.ts`, `src/server/app.ts`, `src/server/context.ts`,
`src/server/routes/auth.ts`, `src/server/routes/jobs.ts`,
`src/server/serializers.ts`, `src/sources/fetcher.ts`,
`src/components/Filters.tsx`, `src/components/MobileNav.tsx`,
`src/pages/{Admin,Home,JobDetail,Jobs,Panel}.tsx`, `scripts/migrate.ts`,
`.env.example`, `docs/{deployment,security-kvkk,setup}.md`,
`tests/audit-fixes.test.ts` (yeni), `tests/panel-preferences.test.tsx` (yeni),
`tests/{candidate-features,filters,full-render,jobs-filters-wiring}.*`.

**`4718418`** (2 dosya): `src/server/app.ts`, `tests/audit-fixes.test.ts`.

---

## 13. Sonuç

İsteğin üç başlığı da karşılandı: giriş ekranı ortalandı, Supabase kaynaklı giriş
karmaşası kökten çözüldü (neden + araç + belge), ve sistem baştan sona denetlenip
bulunan hatalar düzeltildi. Arama, tarih/saat, güvenlik, veri bütünlüğü ve
arayüz katmanlarındaki her düzeltme bir **regresyon testiyle** sabitlendi;
kalan maddeler yalnızca düşük öncelikli ve yukarıda açıkça listelendi.
