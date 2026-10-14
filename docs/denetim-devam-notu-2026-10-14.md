# Kamuİlan — denetim devam notu

**Tarih:** 14 Ekim 2026
**Dal:** `arena/ed025f1f-kamuradar`
**Yerel doğrulama:** Typecheck, lint, tam Vitest, Vite production build, dependency audit ve Playwright E2E geçti. Vitest: 40 dosya / 390 test; E2E: 12/12.
**Amaç:** Kanıtları, sınırlamaları ve güvenli PR/merge koşulunu kaydetmek; bu belge üretim onayı değildir.

> Bu not, denetime devam edilmesi üzerine güncellendi. “Geçti” ifadeleri yalnızca aşağıda çalıştırıldığı yazılı testleri belirtir. Canlı kaynakların güncel sağlığı, tüm ilanların kapsanması, üretim verisi üzerinde migration veya kodda sıfır hata/güvenlik açığı anlamına gelmez.

## 1. Güncel doğrulama özeti

- Yalnızca sabit dal kullanıldı: `arena/ed025f1f-kamuradar`. Başlangıçta yerel ve uzak dal HEAD'i `5b6f8d0455cce24a82d8ab0017d09716fe5c32e4` idi.
- `NODE_ENV=test npm run typecheck`, `NODE_ENV=test npm run lint` ve `NODE_ENV=test npm test` geçti. Tam Vitest sonucu: **40 test dosyası, 390 test geçti**. PDF.js fixture testlerinde font/PDF indeksleme uyarıları vardı; başarısız test yok.
- `npm run test:e2e`: **12/12 Playwright testi geçti**. Smoke testleri ve kaynak kapsamı testleri, ayrı ve geçici FileStore kullanan API'ye ve Vite proxy'sine karşı çalıştı. Tarayıcı oturumlarının kimlik bilgileri geçici/random idi; repodaki E2E varsayılan kullanıcı/parolası kaldırıldı.
- Playwright 1.64 ile yerel geçici Chromium 153 kullanıldı; Playwright'ın bildirdiği Chromium sürümü 156'dan eski olsa da tam yerel E2E geçti. Bu uyumluluk farkı saklanmamalı; GitHub Actions workflow'u kendi Playwright sürümüne uygun Chromium kurar ve PR check'i merge öncesinde ayrıca yeşil olmalıdır.
- Vite production build **113 modülle** geçti. TypeScript denetimi ayrıca geçti. Vite'a yalnızca boş `/tmp` `envDir` verildi; varsayılan `npm run build` yerine `npx vite build --config vite.config.audit-temp.ts` kullanıldı.
- `npm audit`: **0 bildirilen advisory**. Bu yalnızca denetlenen kilitli bağımlılıklara ilişkin bir taramadır.
- `npm run env:check` geçti; `SOURCE_LIVE_FETCH=0`, scheduler kapalı, FileStore ve tek kullanımlık test değerleri kullanıldı. Offline `sources:report --json`: 27 tanım, 23 etkin/tarihsel `verified`, 4 planlı, 27 kayıtlı adapter; boş geçici DB'de 0 tarama ve 23 bayat. Bu canlı kaynak kontrolü değildir.
- Önceki izole servis smoke'unda API direct/proxy ve Vite kökü HTTP 200 verdi; worker heartbeat mevcuttu. Health `degraded` idi çünkü tarama kaydı ve son başarı yoktu. Bu, worker hazır oluşudur; scraping/kaynak doğruluğu değildir.
- E2E için kullanılan geçici API/Vite süreçleri durduruldu; geçici credential'lar, test veritabanı, browser/lib dosyaları, rapor/artifact klasörleri ve geçici Vite config'i temizlendi. `.env` açılmadı, okunmadı, değiştirilmedi; Git durumunda değişiklik yok.

## 2. Denetim sırasında yapılan düzeltmeler

- PostgreSQL deposuna, filtresiz ve yalnızca `id` sıralı güvenli tam sayı sayfalarında SQL-side `LIMIT/OFFSET` eklendi. Bu, 20.000 satırlık scan guard yüzünden migration'ların sonraki sayfaya ulaşamaması sorununu önler. PGlite testi 20.050 kayıtla 20.000 sonrası sayfayı; geçersiz pagination testleri eski fallback semantiğini doğrular.
- AnchorList adaptörü tanınan açık boş HTML sonucunu ve geçerli ama öğesiz RSS'i hata/başarı olarak değil, `unknown` kapsamla bildirir. Tanınmayan/bozuk yapı hata olarak kalır. Boş yanıt tüm arşivin boş olduğunu kanıtlamaz.
- Kariyer Kapısı tanı notuna alınan `<title>` `makeExcerpt` ile redakte edilir; test e-posta ve Türkiye telefonu örneğini denetler.
- Migration başarısızlığında ham hata nesnesi/mesajı/stack yazılmaz. `safeErrorFields` sınırlı hata sınıfı ve biçim/uzunluk denetimli kod döndürür; veri sızıntısı testleri eklendi.
- Playwright helper artık kaynak koddaki sabit kullanıcı/parola fallback'ine sahip değildir; kimlik bilgisi yoksa açık hata verir. CI, APP_SECRET ve E2E yönetici kimlik bilgilerini her iş için rastgele üretir ve parola değerini log maskelemesine ekler.
- Kaynakların boş yanıtı, redaksiyon, migration davranışı ve kapsam sınırları ilgili docs/testlerle belgelendi.

## 3. E2E deneme geçmişi

- İlk `test:e2e:local` koşusu **7/9** geçti; API rate limit'i aynı IP üzerinden art arda gelen UI isteğini 429 ile sınırladı. API, yeni geçici FileStore ve yalnız E2E için yüksek rate limit ile yeniden başlatıldı; `test:e2e:local` ardından **9/9** geçti.
- İlk tam E2E koşusunda **11/12** test geçti. Kalan test, kaynak için henüz hiçbir deneme yokken UI'nin doğru biçimde gösterdiği “Henüz tarama yapılmadı” yerine yalnızca başarısız deneme durumuna ait “Henüz başarılı tarama yok” metnini bekliyordu. E2E assertion'ı API'deki `lastRun` durumuna göre bu iki doğru etiketi ayrı sınayacak biçimde düzeltildi.
- E2E credential fallback'leri kaldırıldı; CI sırları iş başına rastgele üretilir, yalnız E2E job'ında rate limit'ler 1.000 isteğe yükseltilir, scheduler kapatılır ve e-posta file transport kullanır. Bu ayarlarla tam `npm run test:e2e` yeniden çalıştırıldı: **12/12 geçti**. Canlı kaynak isteği yapılmadı.

## 4. Kaynak kapsamı, güvenlik ve işlevsel sınırlar

- `complete`, yalnızca ilgili adapter'ın o koşumda açık terminal sinyali gözlediğini belirtir; tarihsel arşiv veya bütün kurumların ilanları anlamına gelmez. `partial`/`unknown` gerekli yerlerde korunmalıdır.
- Profil eşleşmesinde token sınırları korunur: `Java`, `JavaScript` içinden eşleşme sayılmaz.
- Hazine ve Maliye Muhasebe Uzmanlığı Yeterlik Sınavı mevcut personel için kurum içi yeterlik sınavıdır; bundan kamuya yeni giriş/personel alım sınavlarını genel olarak dışlayan kural çıkarılmaz.
- CSS karşılaştırması yalnızca belirtilen commit'lerdeki dokuz ortak katman hash'ine ilişkindir: psikolog `9/9`, Repo123 `3/9`. Tam repo karşılaştırması veya devamlı parity iddiası değildir.
- Canlı resmi kaynak fetch'i yapılmadı. Kullanım şartı, robots davranışı ve izinler incelenmeden kaynağa istek başlatılmadı. `verified` yalnızca envanterdeki tarihsel doğrulama etiketidir.
- Üretim veritabanında migration çalıştırılmadı. PGlite/FileStore testleri üretim verisi, yedek, rollback veya bakım penceresi doğrulaması değildir.
- `npm audit` 0 advisory verdi; bu statik kod incelemesi, pentest veya “açık yok” garantisi değildir. E-posta/telefon redaksiyonu regex tabanlıdır; tüm kişisel bilgi türleri/yazımları için garanti vermez. Geçmiş loglar, yedekler ve diğer hata yolları ayrıca ele alınmalıdır.
- RFC 9309 robots.txt kurallarının crawler davranışıyla ilgilidir; erişim yetkilendirmesi değildir. Bu repo için runtime robots enforcement doğrulanmış değildir. Kaynak içeriği talimat değil veridir; WAF/403/CAPTCHA/oturum duvarı aşma davranışı eklenmedi.

## 5. PR/merge kapısı

- PR, yalnızca `arena/ed025f1f-kamuradar` dalından açılmalı; gerekli GitHub checks yeşil olmadan merge edilmemelidir. Bu notta yer alan yerel E2E, GitHub Actions koşusunun yerine geçmez.
- Commit/push/PR/merge için kullanıcının açık onayı vardır; yetki yalnızca yerel doğrulamalar ve PR checks başarılı olduktan sonra kullanılmalıdır. Branch değiştirme/force-push yapılmamalıdır.
- Merge sonucu ne olursa olsun, kapsamlı ve doğrudan denenmemiş alanları (canlı kaynaklar, üretim migration'ı, tarihsel/tüm-kurum kapsama) ayrıca “doğrulanmadı” olarak raporla.

### İlgili kayıtlar

- [Mühendislik ve denetim raporu](./muhendislik-raporu-2026-10-14.md)
- [Kaynak kapsamı](./sources.md)
- [Güvenlik/KVKK](./security-kvkk.md)
- [13 Ekim tarihsel uçtan uca denetim raporu](./denetim-raporu-2026-10-13.md) — tarihsel koşumlar bu denetimin güncel canlı doğrulaması değildir.
