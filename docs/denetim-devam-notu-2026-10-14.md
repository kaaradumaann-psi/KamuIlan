# Kamuİlan — denetim devam notu

**Tarih:** 14 Ekim 2026
**Durum:** Devam eden çalışma; nihai mühendislik raporu veya üretim doğrulaması değildir.
**Amaç:** Sonraki oturumda denetimi güvenli biçimde sürdürebilmek için yapılan işleri, kanıt seviyelerini, eksikleri ve durma noktasını kaydetmek.

> Bu not, kullanıcının “burada dur, yapılanları ve yapılacakları dosyaya yaz; devamını sonra yapacağız” talebi üzerine hazırlanmıştır. Aşağıdaki “yapıldı” ifadeleri yalnızca dosya değişikliklerini veya gerçekten çalıştırılmış kontrolleri belirtir. Canlı kaynak sağlığı, üretim veritabanı göçü, güvenlik garantisi veya tam ilan kapsamı anlamına gelmez.

## 1. Kısa durum özeti

- Değişiklikler sabit Arena dalında tutuluyor: `arena/ed025f1f-kamuradar`. Dal değiştirilmedi; commit, push, PR açma veya merge yapılmadı.
- Kaynak sayfalaması/tamlık durumları, tanı notlarının redaksiyonu ve metin saklama sınırı için kod, test ve dokümantasyon düzenlemeleri yapıldı.
- **Kontroller:** `npm run typecheck` geçti; `npm run lint` geçti; beş odaklı test dosyasında son çalıştırma **88/88 test geçti**. Son test düzenlemesinden sonra typecheck ve lint tekrar edilmedi; nihai kapı olarak yeniden çalıştırılmaları gerekiyor.
- **Henüz yapılmadı:** tam test paketi, build, bağımlılık güvenlik taraması, izole `npm run dev` başlangıç/health kontrolü, tarayıcı E2E, canlı kaynak taraması ve gerçek veritabanı üzerinde göç. Bunların hiçbirinin sonucu hakkında iddia yok.
- `docs/muhendislik-raporu-2026-10-14.md` adlı nihai kronolojik mühendislik raporu henüz hazırlanmadı. Bu dosya bir devam/iş devri notudur.
- `.env` oluşturulmadı, okunmadı veya değiştirilmedi; örnek kimlik bilgileri kullanılmadı. `npm run dev` henüz çalıştırılmadı.

## 2. Kronolojik işlem kaydı

### A. Önceki denetim notundan devralınan işler

1. Vite/API yapılandırması incelendi. `vite.config.ts` içinde Vite'ın `0.0.0.0` üzerinde dinlemesi, `.e2b.app` hostlarına izin vermesi ve `/api` için göreli istek proxy'si görülmüştü. Bu yalnızca yapılandırma incelemesidir; servis başlatma kanıtı değildir.
2. README ve kaynak dokümanlarındaki “verified”, dolaylı kurum kapsamı ve CSS eşitliği iddiaları daha sınırlı ifade edildi:
   - `verified`, geçmiş envanter/doğrulama kaydıdır; mevcut erişim veya canlı sağlık garantisi değildir.
   - Merkezî portallardan dolaylı kurum kapsamı eksiksiz değildir.
   - CSS karşılaştırması yalnızca belirtilen Git commit'lerine karşı, belirli katmanların noktasal hash kontrolüdür.
3. `ilan-gov-tr` için ilk liste sayfasından sonraki sayfa hatasında önceki kayıtları kaybetmeme ve kapsamı `partial` işaretleme düzenlemesi ile testi eklendi.
4. Resmî Gazete için son sayfa sinyali yoksa `partial` yerine `unknown`; bütün beklenen tarihli bölümler açıkça tamamlanmadıkça birleşik kapsamın `complete` olmaması düzenlendi. Buna göre test güncellendi ve iki günlük karışık `unknown`/`complete` kapsamını denetleyen regresyon testi eklendi.

### B. Bu devam oturumunda yapılanlar

1. Kaynak bütçesi/sayfalama tablosu `docs/sources.md` içine eklendi; liste sayfası üst sınırı, seçilen çıktı ve ayrıntı isteği bütçesi birbirinden ayrıldı.
2. Adaptörlerin arıza tanı notlarındaki sayfa özeti doğrudan `slice` yerine `makeExcerpt` ile redakte edilmeye başlandı (`anchor-list.ts`, `ilan-gov-tr.ts`). Böylece tanı amacıyla metin tutulduğu/sunulduğu durumlarda e-posta ve yaygın Türk telefon kalıpları da maskelenir.
3. Kaynak bağı için gerçek tüketiciler incelendi:
   - `capturedTextStatus`, `src/ingest/pipeline.ts` içindeki daha önce ayrıntısı yakalanmış kayıt seçimini etkiler.
   - `capturedTextCharacterCount` ve durum, `src/server/serializers.ts` üzerinden yakalama metaverisi olarak gösterilir.
   - `rawExcerpt` ve `rawContentHash` için etkin tüketici bulunmadı.
   - `JobDoc.textExcerpt` arama/eşleştirme/tekilleştirme ve ilan detayı akışlarında kullanılır; bu nedenle kaldırılmadı.
   - `textNormalized`, ilan arama sorgusunun tükettiği türetilmiş kopyadır.
   - `reviewQueue.payload.excerpt`, `src/server/routes/admin.ts` içindeki yönetici kabul akışında kullanılır.
   - Revision snapshot'larındaki metin, ilan geçmişinde gösterilebilir.
4. Yeni kaynak bağı belgeleri artık gövde metni, `rawExcerpt` veya `rawContentHash` alanı yazmıyor. Şema ve kaynak bağı güncelleme tipi de buna göre daraltıldı.
5. Kaynak bağı göçü genişletildi: eski `capturedText`/`rawExcerpt` içerikleri boşaltılır; yakalama durumu/sayısı backfill edilir; eski ve kullanılmayan `rawContentHash` değeri boşaltılır. Göç içerik veya hash yazdırmaz.
6. `JobDoc` metin göçü eklendi: geçmiş `textExcerpt` en çok 2.500 karaktere ve mevcut iletişim redaksiyonuna tabi tutulur; `textNormalized` güvenli alıntıdan yeniden üretilir; kanıt/alan snippet'leri, inceleme kuyruğu alıntıları ve revision snapshot'ları sanitize edilir; body-derived eski `contentHash` retained-excerpt fingerprint'iyle değiştirilir.
7. `scripts/migrate.ts` iki göçü de çalıştırıp yalnız sayısal sonuçları yazacak şekilde güncellendi. `scripts/dev-all.ts` içindeki başlangıç yardım satırında örnek parola yerine ortam değişkeni adları bırakıldı.
8. Kaynak kapsamı agregasyonu için pipeline testi eklendi: `unknown` kapsam, sırf worker işi başarılı diye `complete`'e dönüşmez; bilinen atlama `partial` olarak kaydedilir.
9. Bir ara odaklı test çalıştırmasında yeni agregasyon testi, sabit saatli test deposunda aynı `startedAt` zamanına sahip iki çalışmadan `lastRun` seçtiği için başarısız oldu. Ürün hatası değildi; test, kayıtların her iki kapsam durumunu da koleksiyondan bulacak biçimde düzeltildi.

## 3. Çalıştırılan kontroller ve sonuçları

| Kontrol | Sonuç | Kapsam ve sınırlama |
| --- | --- | --- |
| `npm run typecheck` | Geçti | Çalıştırıldı. Sonrasında yalnızca kapsam testindeki assertion düzenlendi; nihai doğrulamada tekrar çalıştırılmalı. |
| `npm run lint` | Geçti | Çalıştırıldı; sonrasında test ve başlangıç yardım satırı değişiklikleri yapıldı. Nihai doğrulamada tekrar çalıştırılmalı. |
| Odaklı Vitest: `tests/captured-text-migration.test.ts`, `tests/sources.test.ts`, `tests/ingest.test.ts`, `tests/source-coverage.test.ts`, `tests/pagination.test.ts` | **5 dosya, 88 test geçti** | Son çalıştırma; bu dosyalar ve bu fixture'lar ile sınırlıdır. İlk ara çalıştırmadaki tek assertion hatası düzeltildi. |
| Tam `npm test` | Çalıştırılmadı | Tam test takımının durumu bilinmiyor. |
| `npm run build` | Çalıştırılmadı | Vite production bundle/build sonucu bilinmiyor. |
| `npm audit` / başka bağımlılık güvenlik taraması | Çalıştırılmadı | Güvenlik açısından “açık yok” iddiası kurulamaz. |
| `npm run dev` / API-health / worker-heartbeat / Vite preview | Çalıştırılmadı | Başlangıç hazır oluşu kanıtlanmış değil. |
| Browser E2E | Çalıştırılmadı | Playwright uçtan uca sonucu bilinmiyor. |
| Canlı resmi kaynaklara fetch | Çalıştırılmadı | Bu oturumda hiçbir kaynağın mevcut erişimi/tamlığı doğrulanmadı. |
| Gerçek Postgres/Mongo/üretim veritabanında `db:migrate` | Çalıştırılmadı | Göç kodunun üretim verisini temizlediği iddia edilemez. |

Odaklı testlerde PDF.js test fixture'ları için `Indexing all PDF objects` uyarıları çıktı; testler başarılı tamamlandı.

## 4. Kod incelemesinden elde edilen bulgular

### 4.1 Kapsam ve sayfalama

Durumlar şu an için **çalışma bazlı gözlem** olarak ele alınmalı:

- `complete`: adaptörün gördüğü açık terminal sinyaliyle bu koşumun gezilen sayfaları tamamlandı; bu, kaynak tarihçesinin veya bütün kurumların tüm ilanlarının kapsandığını ispatlamaz.
- `partial`: bilinen sayfa/PDF/detay/çıktı bütçesi atlaması ya da erişim hatası vardır.
- `unknown`: sayfa sonu, boş sonuç veya arşiv aralığı bu koşumda kanıtlanamamıştır.
- HTTP 304, kaynağın değişmediğini söyleyebilir; o çalışmada sayfaların yeniden gezildiğini veya tamlığın doğrulandığını söylemez.

Kodda görülen başlıca sınırlar (`docs/sources.md` tablosuna da yazıldı):

| Kaynak/adaptör | Liste sınırı | Ayrıntı/çıktı sınırı | Bilinen kapsam sınırı |
| --- | --- | --- | --- |
| Resmî Gazete — Çeşitli İlânlar | Bugün ve bir önceki gün; bölüm başına en çok 10 sayfa | `pdf-index` bütçesi koşum başına 25 PDF; PDF boyut/sayfa/metin sınırları mevcut | Yargı/ihale ve Merkez Bankası ilan bölümleri dışarıda; OCR yok; işaret yoksa `unknown`, atlama varsa `partial`. |
| ilan.gov.tr Personel | En çok 20 liste sayfası | En çok 40 sonuç; HTML ayrıntı bütçesi en çok 8 | Chromium yedeği ilk HTTP liste boşsa devreye girer; sonraki sayfa HTTP hatasında önceki satırlar korunup `partial` bildirilir. |
| ÖSYM duyuruları | En çok 10 liste sayfası | Aday üst sınırı 25; `html-list` ayrıntı bütçesiyle efektif en çok 8 | Ek PDF/Word bağlantıları tutulur, dosya içeriği bu adaptörde indirilmez; AIS kapsam dışı. |
| Kariyer Kapısı | En çok 10 liste sayfası | En çok 40 çıktı; en çok 8 iç detay | Dış başvuru adresi satırı ile iç detay farklı işlenir; bütün dış başvuru siteleri takip edilmez. |
| SBB Kamu İlanı | En çok 10 sayfa / 300 liste satırı | İlan detay isteği yok | Terminal işareti yoksa `unknown`; 403/WAF aşılmaz; 304 yeniden sayfalama kanıtı değildir. |
| İŞKUR + ortak kurum duyuru listeleri | HTML'de varsayılan en çok 10 sayfa; yapılandırılan `maxItems` 25 veya 30 | Detay alma açıkken kaynak başına koşum başına en çok 8 yeni/eksik detay | Ortak başlık seçicileri sayfanın yalnız personel ilanlarından oluştuğunu kanıtlamaz; sınıflandırma hatları ilgisiz duyuruları eleyebilir. |
| MEB Personel RSS | Tek RSS uç noktası; `maxItems=30` yapılandırması | Koşum başına en çok 8 yeni/eksik detay işleme | RSS uç noktasının tam arşiv olduğu doğrulanmıyor; kapsam `unknown`. |
| Elle takip/kapalı kaynaklar | Otomatik liste yok | Otomatik detay yok | GİB, TÜİK, RTÜK ve İŞKUR e-Şube otomatik etkin kaynak gibi sayılmamalı. |

Bunlar kaynakların gerçekte var olan tüm sayfalarını veya canlıdaki davranışlarını değil, mevcut kod sınırlarını gösterir. Başlık/yol sınıflandırması da ilgili duyurunun gerçek personel alım ilanı olduğunu tek başına doğrulamaz.

### 4.2 Veri minimizasyonu ve gerçek tüketiciler

- Kaynak bağı gövde kopyası yerine `capturedTextStatus` ve karakter sayısını tutacak şekilde tasarlandı.
- `JobDoc.textExcerpt` kaldırılmadı; arama, eşleştirme, dedupe ve ilan detayı tarafından tüketilen, sınırlı ve iletişim kalıpları redakte edilmiş kopyadır.
- `textNormalized` aramada gerçekten kullanıldığı için korunur; göçte güvenli `textExcerpt` üzerinden tekrar üretilir.
- `contentHash` artık yalnız retained excerpt + başlık/tarih/kontenjan fingerprint'i olacak. Bu değer kaynak imzası, doğruluğu veya güncel kaynak sağlığı değildir.
- Review excerpt'i admin kabul akışı kullandığı için en çok 1.500 karakter ve redakte biçimde korunur. Revision snapshot'ları da geçmiş sunumu için sanitize edilir.
- **Göç kodu yerel FileStore üzerinde test edildi; üretim veritabanında çalıştırılmadı.** Çevrim içi göç, dış yedekleri, dışa aktarımları, logları veya başka sistem kopyalarını temizlemez.
- Telefon/e-posta regex redaksiyonu sezgiseldir; ad, kimlik numarası, başka hassas bilgi ya da tüm yazım varyantları için tam tespit garantisi yoktur.

### 4.3 Güvenlik/işletim kontrolleri ve açıklar

Kodda bulunan veya önceki incelemede görülen kontrollerin tamamı için nihai test kapısı henüz geçilmedi:

- Kaynak host allowlistesi, URL/same-site pagination kontrolleri ve HTTP/PDF byte limitleri kodda bulunuyor; SSRF/regresyon test dosyaları var ancak tam test paketi bu turda çalıştırılmadı.
- WAF/403, CAPTCHA veya oturum duvarını aşmaya yönelik davranış eklenmedi; SBB 403 bilinçli olarak atlanıyor.
- Tanı özeti artık redakte ediliyor; kaynak hata mesajları URL veya HTML özeti içerebilir. Tam log/DB geçmişi ve yedek saklama politikası ayrıca denetlenmeli.
- RFC 9309 robots.txt kurallarının crawler tarafından talep edildiğini/uygulanması gerektiğini açıklar; robots.txt erişim izni veya yetkilendirme değildir. Bu repoda runtime robots.txt enforcement olduğu doğrulanmadı.
- Üretim gizli anahtarlarının varlığı/yeterliliği incelenmedi. Bu çalışma sırasında aktif credential bulunmadı; değerler okunmadı veya rapora yazılmadı.

## 5. Dokümantasyon ve README iddiaları

İncelenen/düzenlenen iddialar:

1. Kaynak kaydındaki `verified`/`scraper-built`/benzeri etiketler geçmiş doğrulama veya adaptör hazırlığını ifade eder; **şimdiki canlı erişim, sağlıklı worker, doğru çıkarım veya tam ilan kapsamı değildir**.
2. Merkezî kaynaklardan kuruma dolaylı erişim, kurumun tüm duyurularının yakalanacağı anlamına gelmez. Kaynakların kendileri de kapsam belirsizliği taşıyabilir.
3. Eski CSS-parite testi remote GitHub projelerine bağlanmıyor; yerel hash baseline kontrolüdür. Önceden yapılan noktasal GitHub API/blob karşılaştırmasında `psikolog` commit'i `9ec1d9f393f3470ff8ea0d42372a62d0e3e0c135` ile ortak dokuz CSS katmanının **9/9**'u; MMPI-566 `Repo123` commit'i `4b28579f93d3e76bb54be963f4427fef66782dd1` ile **3/9**'u eşleşmişti. Bu commit zamanına bağlı hash karşılaştırmasıdır; tam depo/uygulama denetimi veya gelecekte eşitlik garantisi değildir.
4. 13 Ekim tarihli rapor ve yol haritasında geçmiş canlı koşumlar/423 ham kayıt/23 kaynağın çalıştığı gibi ifadeler vardır. Bunlar o belgelerdeki tarihsel, kullanıcı tarafından kaydedilmiş iddialardır; 14 Ekim oturumunda yeniden üretilmedi ve bugünkü sağlık sonucu olarak kullanılamaz.
5. Üretime hazır olma, doğru sınıflandırma, sıfır hata/güvenlik açığı ya da “tüm ilanlar” iddiası doğrulanmadı; raporda bunlar hedef veya açık iş olarak kalmalıdır.

## 6. Araştırma ve dış kaynaklar

Aşağıdaki kaynaklar, kaynak keşfi/tamlık araştırması için not edildi. İlk iki yöntem makalesinin bulguları Türkiye mevzuatı hakkında hukuki görüş değildir; hukuk/robots/şartlar değerlendirmesi yetkin yerel danışmanlık ve her kaynağın kullanım koşullarıyla yapılmalıdır.

- Brown, Gruen ve diğerleri, “Web scraping for research: Legal, ethical, institutional, and scientific considerations” (2025), *Big Data & Society*: zayıf örneklem çerçevesi, olasılıklı olmayan eksik veri, temsiliyet belirsizliği, pipeline testlerini ve yöntem dokümantasyonunu vurgular. [Makale](https://journals.sagepub.com/doi/10.1177/20539517251381686)
- Foerderer, “Should we trust web scraped data?” (2023): değişkenlik, kişiselleştirme ve eksik indekslemenin örnekleme yanlılığı doğurabileceğine; kaynak varsayımlarının ve kapsam şeffaflığının yazılması gerektiğine dikkat çeker. [Çalışma](https://arxiv.org/html/2308.02231v1)
- IETF RFC 9309, *Robots Exclusion Protocol*: robots.txt kurallarının crawler davranışıyla ilgisini açıklar; robots.txt bir erişim yetkilendirme protokolü değildir. Bu kaynak, repoda otomatik enforcement bulunduğunun kanıtı değildir. [RFC 9309](https://www.rfc-editor.org/info/rfc9309/)
- ilan.gov.tr'nin resmî Kamu-Akademik Personel / Kamu Personel Alım ve Sınavları kategorisi, kaynak keşfi için anlamlı bir merkezî başlangıç noktasıdır; tüm kurumlar veya tüm duyuru evreni için eksiksizlik kanıtı değildir. [Resmî kategori](https://www.ilan.gov.tr/ilan/kategori/44/kamu-personel-alim-ve-sinavlari)
- Kariyer Kapısı resmî işe alım sayfası, aktif ilan/başvuru için ikinci bir merkezî kanal olduğunu gösterir; bunun tek başına tüm kurum ilanlarını kapsadığı sonucu çıkarılamaz. [Kariyer Kapısı — İşe Alım](https://kariyerkapisi.gov.tr/isealim)
- Resmî Gazete'de yayımlanan 24 Temmuz 2026 örneği başvuruyu Kariyer Kapısı'na yönlendirir; resmî yayın, başvuru işlemi ve kurumun takip duyuruları farklı kanallara dağılabilir. [Resmî Gazete PDF](https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/07/20260724-4-24.pdf)
- Devlet Arşivleri Başkanlığı'nın 14 Eylül 2026 tarihli ilanı, başvuruların Kariyer Kapısı'ndan alınacağını ve sonraki bilgilendirmelerin kurum sitesinde yer alacağını bildirir; bu, başlangıç ilanı ile sonraki yaşam döngüsü duyurularının çapraz izlenmesi ihtiyacını gösterir. [Kurum duyurusu](https://www.devletarsivleri.gov.tr/Sayfalar/Haberler/Duyuru.aspx?ID=6346)
- Aile ve Sosyal Hizmetler Bakanlığı duyuru listesinde işe alım ilanlarının yanında sonuç/izleyen duyurular da görülebilir; bir ilk ilan yakalamasının sürecin sonraki olaylarını kapsadığı varsayılmamalıdır. [Kurum duyuruları](https://www.aile.gov.tr/duyurular)

**Araştırmadan çıkan tasarım ilkesi:** kaynak envanteri yalnız “portal sayısı” değil; merkezî portal, kurumun ilan/metin sayfası, başvuru kanalı ve sonuç/düzeltme/iptal duyurusu olarak birbiriyle çapraz bağlanmalı. Her kaynak için izin/kullanım şartı, liste aralığı, zaman filtresi, pagination terminal kanıtı, arşiv derinliği, sınırlar, son doğrulama zamanı ve gözlenen atlama oranı kaydedilmeli. Bu yöntem sistematik bir kaynak stratejisi önerisidir; uygulanmış/eksiksiz keşif çalışması değildir.

## 7. Değişiklik envanteri

Aşağıdaki liste `git status --short` ile bu not yazılmadan hemen önce görülen çalışma ağacını kapsar. 93 takip edilen dosya değiştirilmiş; 15 yeni dosya takip edilmiyordu. Bu sayı ve liste Git indeksi/commit karşılaştırması değildir; `git diff --stat` o anda takip edilen dosyalar için 93 dosya, 8.128 ekleme ve 2.525 silme gösteriyordu. Yeni bu not dosyası bu sayıya dahil değildir. Dosyaların her satırdaki ayrıntılı diff'i henüz son kez gözden geçirilmedi.

### 7.1 Takip edilen dosyalardaki değişiklikler

```text
.env.example
README.md
docs/data-model.md
docs/denetim-raporu-2026-10-13.md
docs/dogrulama-2026-10-13.md
docs/durum-ve-yol-haritasi.md
docs/limitations.md
docs/muhendislik-raporu.md
docs/operations.md
docs/security-kvkk.md
docs/setup.md
docs/source-onboarding.md
docs/sources.md
docs/testing.md
e2e/smoke.spec.ts
e2e/sources.spec.ts
scripts/coverage-report.ts
scripts/create-indexes.ts
scripts/dev-all.ts
scripts/migrate.ts
scripts/seed-demo.ts
src/App.tsx
src/classification/engine.ts
src/classification/rules.ts
src/components/SaveJobButton.tsx
src/components/StatusBanner.tsx
src/config/load-env.ts
src/config/sources.ts
src/db/postgres-store.ts
src/db/repos/jobs.ts
src/db/repos/notifications.ts
src/db/repos/runs.ts
src/db/repos/sources.ts
src/db/repos/system.ts
src/db/repos/users.ts
src/db/schemas.ts
src/db/store.ts
src/domain/text.ts
src/domain/types.ts
src/domain/urls.ts
src/extraction/engine.ts
src/ingest/jobs-service.ts
src/ingest/pipeline.ts
src/lib/api.ts
src/lib/html.ts
src/lib/session.tsx
src/main.tsx
src/pages/Admin.tsx
src/pages/Home.tsx
src/pages/JobDetail.tsx
src/pages/Jobs.tsx
src/pages/Panel.tsx
src/pages/Saved.tsx
src/pages/Sources.tsx
src/server/main.ts
src/server/routes/admin.ts
src/server/routes/health.ts
src/server/routes/notifications.ts
src/server/routes/sources.ts
src/server/serializers.ts
src/sources/adapters/anchor-list.ts
src/sources/adapters/ilan-gov-tr.ts
src/sources/adapters/kariyerkapisi.ts
src/sources/adapters/osym.ts
src/sources/adapters/resmigazete.ts
src/sources/adapters/sbb-kamuilan.ts
src/sources/browser-session.ts
src/sources/fetcher.ts
src/sources/types.ts
src/styles/kamuilan.css
src/types.ts
src/worker/main.ts
src/worker/runtime.ts
src/worker/scheduler.ts
tests/api-client-error.test.ts
tests/app-gate.test.tsx
tests/audit-fixes.test.ts
tests/classification.test.ts
tests/design-system.test.ts
tests/email-delivery.test.ts
tests/email.test.ts
tests/env-loader.test.ts
tests/extraction.test.ts
tests/fetcher.test.ts
tests/fixtures/design-parity.json
tests/full-render.test.tsx
tests/ingest.test.ts
tests/panel-preferences.test.tsx
tests/postgres-store.test.ts
tests/server.test.ts
tests/sources.test.ts
tests/ui.test.tsx
tests/worker.test.ts
```

### 7.2 Yeni/takip edilmeyen dosyalar

```text
src/db/migrations/captured-text-metadata.ts
src/db/migrations/job-text-minimization.ts
src/domain/job-content-fingerprint.ts
src/lib/profile-match.ts
src/lib/query-keys.ts
src/sources/network-safety.ts
src/sources/pagination.ts
tests/browser-session.test.ts
tests/captured-text-migration.test.ts
tests/html.test.ts
tests/pagination.test.ts
tests/profile-match.test.ts
tests/source-coverage.test.ts
tests/text.test.ts
tests/urls.test.ts
tests/worker-entrypoint.test.ts
```

Bu envanterin içindeki `.env.example` değişikliği örnek yapılandırma dosyasına aittir; `.env` dosyasına dokunulmadı. Sonraki turda bu büyük diff'in sahipliği/baseline'i ve her dosyanın task kapsamındaki gerekçesi `git diff` ile tekrar doğrulanmalıdır.

## 8. Açık eksikler ve sonraki oturumda yapılacaklar

### 8.1 Önce son değişiklikleri doğrula

1. Bu not dışında başka kod değişikliği yapmadan `npm run typecheck` ve `npm run lint` yeniden çalıştır.
2. Tam `npm test` çalıştır; başarısızlıkları gruplandırıp, test başına gerçek nedenini incele.
3. `npm run build` çalıştır.
4. E2E için Playwright/Chromium kurulu/erişilebilir mi doğrula; `npm run test:e2e:local` ve uygun smoke testlerini ayrı raporla. E2E'yi çalıştırmadan “UI uçtan uca geçti” yazma.
5. `npm audit` ve varsa kilit dosyası/bağımlılık taramasını çalıştır. Çıktı, erişilen advisory veritabanı ve taranan production/dev kapsamıyla raporlansın; “güvenlik açığı yok” şeklinde garanti verilmesin.

### 8.2 `npm run dev` başlangıç hazır oluşunu izole biçimde kanıtla

- `.env` okumayı engellemek için `NODE_ENV=test` ile başlat; hiçbir `.env` dosyasını açma/oluşturma/değiştirme.
- Ayrı `DATA_DIR` (ör. geçici `.arena` alt dizini) ve boşta olduğu kontrol edilmiş ayrı API/SMTP/viewer portları kullan.
- `DATABASE_DRIVER=file`, `SOURCE_LIVE_FETCH=0`, `SCHEDULER_ENABLED=0` ayarla; böylece bu hazır oluş denemesi dış kaynak toplamayı başlatmasın.
- Uygulamanın gerçekten `db:migrate` tamamladığını, API portunun dinlediğini, `/api/health` ve worker heartbeat'inin durumunu, Vite portunun dinlediğini doğrula. Tarayıcıdan `/api` isteğinin göreli proxy ile çalıştığını da dene.
- **Worker hazır oluşu ile canlı ilan çekimi sağlığını ayır.** Bu smoke-test canlı kaynakların yanıt verdiğini, verinin doğru olduğunu veya sayfa kapsamının tam olduğunu göstermez.
- Başlangıçta başarısız olursa loglardaki sırayı/alt süreçleri ve kullandığın yalnızca gizli olmayan çevre yapılandırmasını not et; kullanıcı credential'larını çıktı/loga kopyalama.

### 8.3 Kaynak/pagination doğrulamasını tamamla

- Tüm adaptör kodunu, terminal sinyallerini, döngü/tekrar senaryolarını, limitte `partial` davranışını, 304/boş listeyi ve detail-budget ertelenmesini testlerle karşılaştır.
- Özellikle `ilan-gov-tr` renderer'sız testlerin hermetikliğini; browser fallback testlerinin gerçek ağ/Chromium'a sızıp sızmadığını doğrula.
- `AnchorList` ortak seçicilerinin her kaynakta gerçek sayfa kapsamı sağladığı iddiasını kurma; kaynak bazlı fixtures ve canlı kanıt ayrı tutulmalı.
- RSS arşivinin sonu belirsiz, MEB kapsamı `unknown` olarak kalmalı.
- Doğrudan canlı kaynak fetch'i bu sandbox ağ kısıtları ve kullanıcı talimatı nedeniyle kendiliğinden çalıştırma; yalnızca kullanıcı açıkça izin verir ve güvenli/test verisi koşulları netleşirse ayrıca planla.

### 8.4 Göç ve veri saklama doğrulaması

- Göç testini yalnız FileStore ile değil, varsa PGlite/Postgres adaptörü için izole bir fixture ortamında çalıştır; Mongo destekleniyorsa dotted patch davranışını da sınama.
- Sayfalama/skip mantığının kayıt güncellemesi sırasında aynı öğeyi tekrar etmediğini, 500 kayıt sınırında doğru devam ettiğini doğrula.
- Eski job-source belgelerinde sayım backfill'inin `capturedText` veya `rawExcerpt` boşaltılmadan önce yapılmasını; status korunmasını; boş eski hash yazılmasını doğrula.
- `jobs.textExcerpt`, `textNormalized`, `evidence`, `fieldSources`, `jobRevisions.previous/current`, `reviewQueue.payload.excerpt` ve `contentHash` göç sonuçlarını güvenli fixture ile test et. Göç loglarının hiçbir metin/hash içeriğini göstermediğini kontrol et.
- Üretim veritabanına uygulamadan önce yedekleme, geri alma/tekrar çalıştırma (idempotence), çalışma süresi ve maintenance window planı belirle. Göçü bu oturumda canlı DB'de koşmuş gibi bildirme.
- Dış yedekler, loglar, exports ve çevrimdışı kopyalar için ayrı retention/deletion süreci gerekip gerekmediğini iş sahibiyle kararlaştır.

### 8.5 Dokümantasyon, rapor ve PR kapısı

1. README, kaynak listesi, KVKK, test/runbook ve 13 Ekim tarihli raporlardaki iddiaları güncel kod ve gerçekten alınmış kanıtla satır satır uzlaştır.
2. `docs/muhendislik-raporu-2026-10-14.md` oluştur: kronolojik iş günlüğü; dosyalar; incelenen Git projeleri ve README iddiaları; test/build/security/startup sonuçları; araştırma kaynakları; düzeltmeler; açık riskler; durma noktası ve ayrıntılı sonraki gün planı.
3. CSS karşılaştırmasını yalnız belirtilen commit/hash ölçümüne atıfla yaz; remote repo güncel/parite garantisi gibi sunma.
4. Report'ta `verified` statüsünü geçmiş kanıt etiketi olarak açıkla; güncel canlı erişim veya kapsama eşitleme.
5. “Bug yok”, “güvenlik açığı yok”, “üretime hazır”, “tam kapsama” ifadelerini kanıtsız kullanma.
6. Son diff/status incelemesi yap; `.env` ve gizli değerlerin staged/değişmiş olmadığını değer okumadan teyit et. Kullanıcıdan credential isteme; aktif credential bulunursa değerini tekrarlamadan rotasyon öner.
7. Bütün kapılar tamamlandıktan sonra (ve ancak o zaman) kullanıcı talimatına göre PR aç. Bu not hazırlanırken PR açılmadı/merge edilmedi.

## 9. Sonraki oturum için kesin gereksinimler ve sıra

Aşağıdakiler yalnızca kalite tavsiyesi değil, bu işin kabul ölçütleridir:

- Kullanıcı yalnızca öneri değil, depoda gerçek inceleme ve gerekli kod/dokümantasyon değişiklikleri bekliyor.
- Worker/API/web başlangıç hazır oluşunu, başarılı canlı kaynak taramasından ayrı raporla. `npm run dev` geçse bile canlı resmi kaynakların erişilebilirliği veya ilan kapsamı sonucu çıkarma.
- Her adaptör için sayfalama, boş liste, terminal işareti, tarih/arşiv aralığı ve bütçe nedeniyle olası atlamaları ayrı incele. `complete` statüsünü küresel/tarihsel tamlık diye sunma.
- Hazine ve Maliye Muhasebe Uzmanlığı Yeterlik Sınavı örneği kurum içi mevcut personel yeterlik sınavıdır. Bu örnekten, yeni kamu personeli alımını veya kamuya giriş sınavını genel olarak reddeden sınıflandırma kuralı çıkarma.
- Profil eşleşmesinde rastgele `substring` eşleşmesi kullanma. Token sınırlarını uygula; `Java` terimini `JavaScript` içindeki alt dize diye eşleşme sayma. Kısa terimler de daha uzun sözcüklerin içinden eşleşmemeli.
- Çıkarım/sınıflandırma ve kaynak kapsamı iddialarını fixture, test, görülen HTML/PDF veya açık kaynak kanıtıyla temellendir. Yalnızca repo README'si ya da historical `verification` metni canlı kanıt değildir.
- “Hata yok”, “açık yok”, “güvenlidir”, “üretime hazır” veya “bütün ilanları toplar” diye mutlak güvence verme. Hangi kontrollerin, hangi fixture/ortamda çalıştığını ve neyin çalıştırılmadığını yaz.
- `.env` dosyasını açma, değiştirme, içeriğini tekrarlama veya örnek gizli değerleri kullanma. Aktif credential gerçekten bulunursa değerini göstermeden rotasyon öner. Kullanıcıdan parola, token veya 2FA isteme.
- Dış araştırmayı tek bir Markdown raporunda birleştir ve kaynakların neyi kanıtlamadığını da belirt. Şu anki bağlantı listesi temel oluşturur; **source discovery dışında parsing ve completeness yöntemi için araştırma/alıntılar hâlâ genişletilmelidir**. Makaleleri Türkiye hukukuna ilişkin tavsiye gibi sunma.
- CSS karşılaştırmasını yalnızca belirtilen commit/hash kontrolünün sonucu olarak anlat. `psikolog` ve `Repo123` projeleri klonlanmış/tam uygulama denetimi yapılmış gibi yazma.

### Ertesi oturumun önerilen iş akışı

1. **Durumu devral:** bu notu, `git status --short` ve `git diff --stat` çıktısını oku; sabit `arena/ed025f1f-kamuradar` dalında kaldığını teyit et. Büyük mevcut diff'te yeni sürpriz değişiklik/credential varmış gibi varsayma; `.env` içeriğini okumadan ad/değişiklik durumu kontrolü yap.
2. **Son diff'i incele:** özellikle yeni migration'lar, pagination agregasyonu, kaynak listesi tablosu, env/load/dev orchestration ve geçmiş iddialarını satır satır kontrol et. Amaç “93 dosya değişmiş” sayısını raporlamak değil, her değişikliğin gerekçesini ve artık kullanılmayan/çelişkili iddiaları doğrulamak.
3. **Gates:** `npm run typecheck`, `npm run lint`, tam `npm test`, `npm run build`; sonra `npm audit`/seçilmiş security checks. Her komutun exit code'unu ve kapsamını kaydet. E2E/Playwright ayrı kapıdır.
4. **İzole geliştirme hazır oluşu:** `.env` yüklenmesini engelleyen `NODE_ENV=test`; geçici ayrı `DATA_DIR`; boş/ayrı portlar; file store; `SOURCE_LIVE_FETCH=0` ve `SCHEDULER_ENABLED=0`. `npm run dev` ardından API health, worker heartbeat, Vite ve göreli `/api` proxy'yi gözle doğrula. Bu canlı scraping testi değildir. Başlatma/temizlik adımlarını kaydet.
5. **Göç testleri:** FileStore regresyonları, PGlite/Postgres'in mümkün olan yerel/test adaptörü, Mongo gerekiyorsa onun patch davranışı; idempotence, 500 kayıt sayfaları, redaksiyon/backfill, hash yenileme ve göç loglarında veri sızıntısı. Üretim DB'ye kullanıcı onayı/yedek/geri alma planı olmadan yazma.
6. **Kapsam ve araştırma:** adaptör matrisi ile gerçek kod limitlerini testlerden çapraz doğrula. Resmî kaynak keşfi; kurumların ilan, başvuru, düzeltme, iptal ve sonuç kanallarını karşılaştır. HTML/PDF/RSS ayrıştırmada bozuk HTML, PDF metin katmanı, güvenli alan çıkarımı, geçersiz/tekrarlanan sayfa, 304, WAF ve zaman aralığı davranışlarına yönelik kaynaklı yöntem ekle. Gözlenmeyen hiçbir konuyu doğrulanmış diye işaretleme.
7. **Nihai belge:** `docs/muhendislik-raporu-2026-10-14.md` oluştur/güncelle. Tarihli kronoloji, değişen dosya listesi/alanları, README ve incelenen Git projeleri, test ve kontrol sonuçları, bulgular, risk/limitler, araştırma ve bağlantıları, bu durma noktası ve ayrıntılı sonraki gün planı içerir. Tarihsel iddia ve bu turda gözlenen kanıt ayrı başlıklarda olmalı.
8. **PR/merge kapısı:** Kullanıcı PR açma ve merge isteğini, her şey tamamlandıktan sonra bildirdi. O isteği yerine getir ancak audit/test/build/security/startup kapıları tamamlanmadan PR açma/merge etme. Yalnızca sabit `arena/ed025f1f-kamuradar` dalından PR aç; CI/check sonuçlarını incele. Merge istenecekse gerçek PR numarasını al ve açık numarayla uygun `gh pr merge <numara> --merge` komutunu kullan; kimlik bilgisi isteme. Gate başarısızsa merge etme, engeli raporla.

## 10. Durdurma noktası

Çalışma, son odaklı test komutunun **88/88 başarıyla tamamlandığı** noktada durduruldu. Typecheck ve lint daha önce başarıyla çalıştı; ancak son test-only assertion değişikliğinin ardından ikisi de tekrar edilmedi. Build, tam test, security, `npm run dev`, API/worker/web health, E2E, live-source fetch, production DB migration ve PR henüz yok. Kullanıcının “yarın devam edeceğim” isteği doğrultusunda bunlar sonraki oturuma bırakılmıştır.
