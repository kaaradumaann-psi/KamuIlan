# Kamuİlan — mühendislik ve denetim raporu

**Tarih:** 14 Ekim 2026
**Depo:** `kaaradumaann-psi/kamuradar`
**Dal:** `arena/ed025f1f-kamuradar`
**Başlangıç HEAD'i:** yerel ve uzak `arena/ed025f1f-kamuradar` dalı `5b6f8d0455cce24a82d8ab0017d09716fe5c32e4` ile eşleşiyordu.
**Merge politikası:** Aşağıdaki yerel kanıtlar PR'daki GitHub checks'in yerine geçmez; gerekli checks yeşil olmadan merge edilmemelidir. PR durumu için GitHub kaydı esas alınır.

> Bu rapor kod/test/build denetiminin bu oturumda elde edilen kanıtlarını kaydeder; üretim onayı değildir. Canlı ilan toplama, kaynakların güncel sağlığı veya tarihsel/tüm-kurum kapsamı doğrulanmamıştır. `.env` dosyası açılmadı, okunmadı veya değiştirilmedi; örnek credential kullanılmadı.

## 1. Yönetici özeti

Önceki denetimden devralınan bulgular ve bu oturumdaki son değişiklikler, sabit Arena dalında gözden geçirildi. Kapsam; veri minimizasyonu ve migration'lar, PostgreSQL sayfalama yolu, kaynak adaptörlerinin boş liste davranışı, teşhis metinlerinin redaksiyonu, kaynak kapsamı semantiği ve dokümantasyon doğruluğudur.

| Kontrol | Gerçek sonuç | Ne kanıtlamaz |
| --- | --- | --- |
| Tip denetimi | `NODE_ENV=test npm run typecheck` — geçti | Üretim ortamı veya çalışma zamanı doğruluğunu tek başına kanıtlamaz. |
| Lint | `NODE_ENV=test npm run lint` — geçti | Güvenlik/işlevsel kusur olmadığını kanıtlamaz. |
| Tam Vitest paketi | `NODE_ENV=test npm test` — **40 dosya, 390 test geçti** | Gerçek resmi kaynak HTML'ini, dış ağı veya tarayıcı E2E'sini test etmez. PDF.js fixture testlerinde bilinen font/PDF indeksleme uyarıları çıktı; testler geçti. |
| Üretim Vite derlemesi | `NODE_ENV=test npx vite build --config vite.config.audit-temp.ts` — **113 modül, başarılı**; TypeScript denetimi ayrıca geçti. Tek kullanımlık config Vite `envDir`'ini boş `/tmp/kamuilan-audit-empty-env` dizinine sabitledi ve komut bitince silindi. | Root `.env` dosyasını okumadan derleme içindir; standart `npm run build` komutu özellikle çalıştırılmadı. |
| Bağımlılık taraması | `npm audit` — **0 bildirilen advisory** | Kodun güvenli olduğunu veya veritabanı/dış hizmetleri kapsadığını kanıtlamaz; bağımlılık advisory taramasıdır. |
| Ortam doğrulaması | `npm run env:check` — geçti, `NODE_ENV=test`, random test secret, FileStore, canlı fetch/scheduler kapalı | `.env` yüklenmedi; uygulama/prod secrets doğrulaması değildir. |
| İzole servis smoke kontrolü | API `/api/health`: HTTP 200, `file` deposu sağlıklı; Vite kökü HTTP 200; API health hem doğrudan hem Vite `/api` proxy'sinden 200; worker readiness: 9 kayıttan 1 çalışan, 0 bayat. | Tam sağlık değildi: API durumu `degraded`, 0 tarama kaydı ve son başarılı tarama yok. Worker hazır oluşu kaynak erişimi/tarama başarısı değildir. |
| Playwright E2E | `npm run test:e2e` — **12/12 geçti** (9 smoke + 3 kaynak kapsamı testi), izole geçici API/FileStore ve Vite proxy'siyle; geçici random admin kimlik bilgileri kullanıldı. | Yerel tarayıcı Chromium 153, Playwright 1.64'ün bildirdiği Chromium 156'dan eskiydi; yerel koşum geçti ancak GitHub Actions'taki Chromium E2E check'i ayrıca geçmelidir. Gerçek kaynak fetch'i yok. |
| Kaynak kapsamı envanteri | Yeni, geçici FileStore'da `sources:report --json`: 27 tanım, 23 etkin ve tarihsel `verified` etiketli, 4 planlı; 0 tarama kaydı, 23 bayat, adapter-registry açığı yok. | Bu bir canlı kaynak denemesi değildir; `verified` bugünkü erişim/tamlık garantisi değildir. |
| Canlı kaynak / üretim DB | Canlı kaynak fetch'i ve gerçek üretim veritabanında migration **çalıştırılmadı**. | Mevcut kaynak erişimi, ilan doğruluğu, üretim göçü veya kapsam sonucu çıkarılamaz. |

`.env` yalnızca Git durumunda değişiklik olmadığını kontrol etmek için dosya adı düzeyinde denetlendi; içeriği okunmadı. Derleme, test ve rapor komutları `.env` yüklenmesini önleyecek `NODE_ENV=test`/boş `envDir` ile çalıştırıldı.

## 2. Yapılan iş ve kod gözden geçirmesi

### 2.1 Bu oturumdaki çalışma ağacı değişiklikleri

- **PostgreSQL tam tablo sayfalaması:** `src/db/postgres-store.ts` içinde SQL-side sayfalama yalnızca filtresiz, tek alanı `id` olan sıralama ve negatif olmayan güvenli tam sayı `skip`/`limit` sayfasında uygulanır. `COLLATE "C"` ile locale-bağımsız sıra ve `skip`/`limit` SQL'de tutulur; normal filtre/sıralama ve geçersiz pagination fallback yolu değişmez. Gerekçe, 20.000 satırlık tarama korumasının göçlerin ikinci sayfasına ulaşmasını engellemesiydi. PGlite regresyonu 20.050 kayıt oluşturup 20.000 sonrası sayfayı karşılaştırır; geçti.
- **AnchorList boş yanıtları:** Açık, tanınan boş-sonuç ifadesi olan HTML listesi artık sıfır öğe döndürür ve kapsamı `unknown` işaretler. Yapısal olarak geçerli (`rss > channel`) ama öğesiz RSS de aynı şekilde `unknown` verir. Tanınmayan/bozuk liste veya RSS yapısı hâlâ hata verir; boş yanıt “tam arşiv” sayılmaz. Üç regresyon testi geçti (görünür boş sonuç, boş RSS ve script metninin boş sinyal sayılmaması).
- **Kariyer Kapısı teşhisi:** HTTP listesinden çıkarılan `<title>` değeri artık `makeExcerpt` üzerinden geçer. E-posta ve yaygın Türkiye telefonu örüntülerinin tanı notuna sızmadığını doğrulayan test geçti. Maskeleme regex tabanlıdır ve her kişisel bilgi/biçim için garanti değildir.
- **Migration hata günlükleri:** `scripts/migrate.ts` ham hata nesnesi, mesajı veya stack'ini yazmaz. Yeni `src/lib/safe-error.ts`, yalnızca biçimi kısıtlanmış hata sınıfı etiketi ve en çok 40 karakterlik güvenli karakter kümesindeki hata kodunu üretir. Üç regresyon testi, mesaj/stack içindeki test e-postasının dışarı çıkmamasını, uygunsuz/uzun kodların elenmesini ve hata sınıfı türünü denetler. Migration betiği üretim verisinde çalıştırılmadı.
- **Dokümanlar:** `docs/sources.md` tanınmış boş HTML/RSS sonuçlarının `unknown` kapsamını ve biçim hatalarının korunmasını açıklar. `docs/security-kvkk.md` Kariyer Kapısı başlığı redaksiyonunun sınırlı kapsamını ve migration hata loglarının davranışını açıklar.
- **E2E güvenli test ayarları:** Playwright helper'daki sabit test hesabı fallback'i kaldırıldı; gerekli env değerleri yoksa açık hata verir (`tests/e2e-auth.test.ts` bu davranışı sınar). CI'da APP_SECRET ve E2E admin parolası her workflow işi için kriptografik rastgele üretilip parola log maskelemesine eklenir; hesap yalnız geçici CI veri dizinindedir. E2E tek IP'den çok sayıda proxy isteği ürettiği için CI job'ında test-only API/auth rate limit'leri 1.000'e ayarlandı; E2E API adımında scheduler kapalı ve e-posta taşıyıcısı file olarak ayarlandı. Üretim konfigürasyonu değişmedi.
- **Önceki migration regresyonları:** `tests/captured-text-migration.test.ts` PGlite/Postgres JSONB üzerinde eski kaynak gövdesi ve ilan metni temizliği, iletişim redaksiyonu, sayım/metaveri, güvenli fingerprint ve idempotence senaryolarını test eder. Bu oturumda suite de geçti.

### 2.2 Dalda önceden bulunan ve bu tam test turunda yeniden doğrulanan önemli düzeltmeler

- Kaynak koşumu `complete` durumu ancak adaptörün gözlediği açık terminal sinyaliyle verilir; `unknown` kapsam sırf worker işi başarılı diye `complete` olmaz. Bu, tüm tarihsel ilanların veya tüm kurumların kapsandığı anlamına gelmez.
- Profil terimleri token sınırlarında eşleşir; `Java`, daha uzun `JavaScript` sözcüğünün içinden eşleşme sayılmaz.
- Hazine ve Maliye Muhasebe Uzmanlığı Yeterlik Sınavı, mevcut personel için kurum içi yeterlik sınavıdır; bu örnekten kamuya yeni giriş/personel alım sınavlarını genelde dışlayan kural çıkarılmamıştır.
- CSS parity iddiası noktasal blob-hash karşılaştırmasıyla sınırlıdır (ayrıntı §5); klonlanmış depolar veya sürekli eşitlik iddiası yoktur.

## 3. Kaynak kapsamı ve araştırma

### 3.1 Kapsam semantiği

- `complete`: yalnızca bu adaptör koşumunda açık son sayfa/terminal sinyalinin görüldüğünü anlatır.
- `partial`: bilinen sayfa, PDF, çıktı veya detay atlaması ya da erişim hatası vardır.
- `unknown`: son, boş-arşiv anlamı veya tarihsel aralık kanıtlanmamıştır. Tanınan boş liste ve boş ama geçerli RSS bu sınıftadır.
- `304`, o çalışmada sayfanın yeniden okunmuş veya ilan evreninin tam olduğu anlamına gelmez.

`docs/sources.md` mevcut sınırları kaynak ailesi bazında listeler: örneğin Resmî Gazete için bugünün ve önceki günün bölümleri; ilan.gov.tr/Kariyer Kapısı için sınırlı sayfalama ve detay bütçesi; MEB RSS için tek uç ve belirsiz arşiv; ortak AnchorList kaynaklarında kurum sayfası seçicilerinin ilan kapsamını kanıtlamaması. Kod üst sınırları gerçek sayfa/ilan sayısı veya canlı erişim kanıtı değildir.

Geçici kaynak raporu ayrı, boş FileStore kullanır. Oradaki **23 bayat** sonucu, bu rapor ortamında henüz tarama kaydı olmadığını gösterir; canlı kaynak sağlık sonucu değildir. `verified` etiketi de envanterde geçmiş doğrulama kaydıdır.

### 3.2 Dış araştırma ve sınırları

- [RFC 9309](https://www.rfc-editor.org/info/rfc9309/) robots.txt kurallarının crawler davranışıyla ilişkisini anlatır; robots.txt erişim yetkilendirmesi değildir. Bu repo için runtime robots enforcement kanıtı sayılmaz.
- Brown ve diğerleri, [“Web scraping for research: Legal, ethical, institutional, and scientific considerations”](https://journals.sagepub.com/doi/10.1177/20539517251381686), örneklem çerçevesi, rastgele olmayan eksik veri, temsiliyet ve yöntem/pipeline dokümantasyonu risklerini vurgular. Hukuki tartışması Türkiye için hukuk görüşü değildir.
- Foerderer, [“Should we trust web scraped data?”](https://arxiv.org/html/2308.02231v1), değişkenlik, kişiselleştirme ve eksik indekslemenin örnekleme yanlılığı yaratabileceğine dikkat çeker.
- [ilan.gov.tr](https://www.ilan.gov.tr/) Kamu-Akademik/Kamu Personel kategorisi anlamlı bir keşif başlangıcıdır; tam kaynak evreni olduğunu göstermez.
- 24 Temmuz 2026 tarihli [Resmî Gazete örneği](https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/07/20260724-4-24.pdf) Kariyer Kapısı'na başvuru yönlendirmesini; [Devlet Arşivleri 14 Eylül 2026 duyurusu](https://www.devletarsivleri.gov.tr/Sayfalar/Haberler/Duyuru.aspx?ID=6346) ise sonraki bilgilendirmenin kurum sitesinde de olabileceğini gösterir. Bunlar çapraz kanal gereksinimi örnekleridir, tüm süreçleri takip ettiğimizin kanıtı değildir.
- [Aile ve Sosyal Hizmetler Bakanlığı duyuruları](https://www.aile.gov.tr/duyurular) ilan ve sonraki duyuru/sonuç olaylarının ayrı yayınlanabileceğine örnektir.

Canlı kaynak HTTP isteği bu oturumda başlatılmadı: kullanıcı izni, kaynağa özgü yetki ve test koşulları olmadan buna girişilmedi; dış kaynak sağlık iddiası üretilmedi. Kaynakların kullanım koşulları, robots kuralları, izin ve hız sınırları canlı kullanımdan önce ayrıca incelenmelidir.

## 4. Güvenlik, veri ve işleyiş sınırları

- `.env` açılmadı ve değerleri raporlanmadı. `.env` durum kontrolünde değişmemiş görünüyordu. Örnek credential kullanılmadı.
- `npm audit` kilit dosyası kapsamındaki bağımlılıklarda bu tarama anında 0 advisory bildirdi. Bu, statik kod güvenlik incelemesi veya “açık yok” garantisi değildir.
- Migration başarısızlık günlüğü mesaj/nesne/stack içermez. Bu durum logdan hata ayıklama ayrıntısını azaltır; daha fazla teşhis gerekirse kayıt verisini ifşa etmeyen güvenli hata kodu/run ID stratejisi eklenmelidir.
- `makeExcerpt` yaygın e-posta ve Türkiye telefonu kalıplarını redakte eder; regex tam kişisel veri keşfi değildir. Başka kişisel alanlar, farklı yazımlar veya dış yedekler/loglar bu değişikliklerle bütünüyle temizlenmiş sayılmaz.
- Taranan içerik veri olarak ele alınmalı, talimat enjeksiyonu uygulanmamalıdır. WAF/403/CAPTCHA/oturum duvarını aşmak için değişiklik yapılmadı. Kodda robots.txt için runtime zorunlu uygulama olduğu doğrulanmadı.
- Migration testleri PGlite gibi geçici/test deposundadır. Üretim veritabanı, yedekleme/geri alma planı veya maintenance window üzerinde migration çalıştırılmadı.

## 5. Tasarım hash karşılaştırmasının sınırı

Önceden yapılan GitHub API/blob karşılaştırmasında yalnızca ortak dokuz CSS katmanının hash'leri ölçülmüştür:

- `kaaradumaann-psi/psikolog` `main` commit'i `9ec1d9f393f3470ff8ea0d42372a62d0e3e0c135`: **9/9** ortak katman aynı.
- `kaaradumaann-psi/Repo123` `main` commit'i `4b28579f93d3e76bb54be963f4427fef66782dd1`: **3/9** ortak katman aynı.

Bu, belirtilen iki commit'e karşı tarihli, sınırlı hash karşılaştırmasıdır; projeler klonlanmadı, tam uygulama/özellik denetimi yapılmadı, remote güncelliği veya kalıcı parity iddia edilmiyor. MMPI bağlamı README'de tanımlanan MMPI-566 OMR projesidir.

## 6. Açık kapılar ve sonraki adımlar

1. **GitHub PR checks:** yerel typecheck/lint/test/build/audit/E2E geçti; GitHub Actions'ın kendi Chromium sürümünde yeşil sonuç ayrıca zorunludur. Yalnız `arena/ed025f1f-kamuradar` dalından PR açılmalı ve gerekli checks geçmeden merge edilmemelidir.
2. **Canlı kaynaklar:** canlı HTTP fetch'i bu doğrulamada yapılmadı. Ancak kullanıcı açıkça yetki verir, kaynak kullanım kuralları gözden geçirilir ve hacim sınırı belirlenirse kaynağa özgü doğrulama ayrıca planlanabilir. Bir run'ın `complete` etiketi tarihsel/tüm-kurum kapsamı değildir.
3. **Üretim DB migration:** bu raporda üretim veritabanında göç çalıştırılmadı. Uygulamadan önce yedek, idempotence/rollback, süre ve bakım penceresi belirlenmelidir.
4. **Güvenli son kontrol:** commit öncesi `git diff --check`, değişiklik listesi ve `.env` dosyasının yalnızca Git durumunu içerik açmadan doğrula; geçici E2E/build config, credentials, DB ve browser artifacts temizlenmiş olmalıdır.

## 7. Sonuç

Typecheck, lint, **40 dosya / 390 Vitest testi**, 113 modüllük Vite production build, `npm audit` (0 advisory), `npm run env:check` ve **12/12 yerel Playwright E2E** geçti. E2E isolated FileStore/API/Vite proxy üzerinde ve rastgele tek kullanımlık credential'larla koştu; browser sürüm farkı nedeniyle GitHub Actions E2E check'i de gereklidir. Önceki izolasyon smoke'unda worker heartbeat varken scan yoktu ve health `degraded` kaldı. Canlı kaynak fetch'i ve üretim veritabanı migration'ı yapılmadı.

Sonuç **bu oturumda ölçülen yerel kapılar başarılı** demektir; üretim onayı, tam ilan/kaynak kapsamı, sıfır hata veya güvenlik açığı bulunmadığı anlamına gelmez. Merge kararı için PR checks'in sonucu GitHub'da ayrıca görülmelidir.

Son belge/diff kontrolünde `git diff --check` ve göreli Markdown bağlantıları doğrulanmalı; geçici Vite config'leri, secrets/DB/browser artifacts depoya alınmamalıdır. `.env` içeriği okunmadı ve Git durumunda değişiklik yok.

### İlgili kayıtlar

- [Denetim devam notu](./denetim-devam-notu-2026-10-14.md) — kronoloji, eski kapsam ayrıntıları ve iş devri.
- [Kaynak kapsamı notu](./sources.md)
- [Güvenlik/KVKK notu](./security-kvkk.md)
- [13 Ekim tarihsel uçtan uca denetim raporu](./denetim-raporu-2026-10-13.md) — 13 Ekim test ve canlı koşumları 14 Ekim doğrulaması sayılmaz.
