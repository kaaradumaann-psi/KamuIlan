# Yeni kaynak ekleme (onboarding)

Hedef: yeni bir kurumu **kanıtlı** biçimde kapsama almak. Kod değişikliği küçük
tutulur; asıl iş kaynağın gerçekten okunabilir olduğunu göstermektir.

> Kural: Doğrulama yapılmadan kaynak `verified` durumuna ALINMAZ. Kaynağa
> erişilemiyorsa (CAPTCHA, oturum duvarı, WAF/coğrafi kısıt, robots yasağı) bu
> durum `statusNote` + `verificationEvidence` alanlarına yazılır ve kaynak
> `access-restricted` / `needs-manual-method` olarak kalır. Engel aşılmaya
> çalışılmaz.

## 0. Ön kontrol

1. Kaynağın ilanları **gerçekten** nerede yayımlanıyor? (Aynı ilan hem Resmî
   Gazete'de hem kurum sayfasında olabilir.)
2. Toplama yöntemi en ucuzdan pahalıya seçilir:
   `json-api` → `html-list` → `pdf-index` → `browser` → `manual-entry`.
3. Sayfada ilan metni PDF'te mi? PDF'in **metin katmanı** var mı? (Taranmışsa OCR
   zorlanmaz; ek olarak saklanır ve "metin yok" işaretlenir.)
4. Sayfa `robots.txt` ve kullanım koşulları açısından otomatik okumaya izin veriyor mu?

> Bu kontrol onboarding sırasında operatör tarafından yapılır. Mevcut HTTP
> istemcisi her istek öncesi `robots.txt` indirip kural uygulamaz; allowlist,
> hız sınırı ve erişim engeli kontrolleri bunun yerine geçmez. Bu nedenle bir
> kaynak ancak güncel manuel uygunluk incelemesiyle etkinleştirilmeli; otomatik
> robots uyumluluğu henüz çözülmemiş üretim kontrolüdür.

## 1. Kaynak kaydını envantere ekle

`src/config/sources.ts` içindeki `SOURCE_DEFINITIONS` listesine kayıt ekleyin:

```ts
{
  key: 'ornek-kurum-ilanlar',              // kalıcı anahtar
  name: 'Örnek Kurum — personel alım ilanları',
  group: 'kurum',                          // ulusal | kurum | universite | belediye | sinav
  sourceType: 'institution-page',
  institution: 'T.C. Örnek Kurum Başkanlığı',
  listingUrl: 'https://ornek.gov.tr/ilanlar',
  homepageUrl: 'https://ornek.gov.tr/',
  adapterKey: 'ornek-html-liste',          // registry.ts'teki adaptör anahtarı
  method: 'html-list',
  status: 'method-defined',                // doğrulanana kadar bu durumda kalır
  statusNote: 'Liste sayfası HTML olarak okunur; ayrıntı sayfasında ilan metni var.',
  lastVerifiedAt: null,
  verificationEvidence: '',                 // doğrulama sonrası doldurulur
  coverageNote: 'Kurumun merkezî personel alım ilanları; taşra birimleri kapsam dışı.',
  enabled: true,
  intervalMinutes: 120,                     // hızlı kaynak 30-60, kurumsal 120-360
  minRequestIntervalMs: 1500,
  maxConcurrency: 1,
  allowedHosts: ['ornek.gov.tr', 'www.ornek.gov.tr'],  // SSRF allowlist!
  tags: ['kurum', 'html'],
}
```

`allowedHosts` **zorunludur**: HTTP istemcisi yalnızca bu alan adlarına istek atar.

## 2. Adaptörü yaz

- Tek bir listeyi okuyan genel bir adaptör varsa (`anchor-list.ts`) yalnızca
  yapılandırma yazın.
- Özel bir yapı varsa `src/sources/adapters/` altına yeni dosya ekleyin ve
  `src/sources/registry.ts` içine kaydedin. Adaptör:

  - yalnızca `AdapterContext` üzerinden çalışır (HTTP, logger, limits),
  - **ağa doğrudan çıkmaz** (testler sahte fetcher kullanır),
  - `RawAnnouncement` döner; alanlar `?: T` biçimindedir (null atanmaz),
  - HTML değiştiğinde sessizce boş liste döndürmez:
    `AdapterStructureError` fırlatır → tarama kaydı "yapı değişmiş olabilir" notuyla
    başarısız olur (test senaryosu 22).

### 2.1 Metin çıkarma tuzakları (Türkçe + HTML)

Bu üç hata daha önce gerçekten yaşandı; yeni adaptör yazarken aynı yere
düşmeyin.

1. **Satır sınırları korunmalı.** `elementText()`, tüm boşluğu tek boşluğa
   indirger; bu yüzden `Ankara 12.10.2026 Örnek Kurum` tek satıra yapışır ve
   il/ilçe ayrımı yapılamaz. Kart/öğe metnini okurken `blockElementText()`
   kullanın: `<br>`, `</p>`, `</li>` gibi blok sınırlarını `\n` olarak korur,
   yalnızca satır içi boşluğu sıkıştırır. `elementText()` başlık/bağlantı gibi
   tek satırlık alanlar için doğrudur.
2. **`\b` JavaScript'te her zaman ASCII'dir.** `u` bayrağı bunu değiştirmez:
   `/\bİlan/giu` dizisi **hiçbir şeyle eşleşmez**. Türkçe kelime sınırı için
   deseni doğrudan yazın, `\b` kullanmayın.
3. **`i` bayrağı `İ` (U+0130) ile `i`'yi eşleştirmez.**
   `/i/iu.test('İ') === false`. `ilan` / `İlan` gibi iki yazım da olabilecek
   yerde karakter sınıfı kullanın: `(?:İ|I)lan`.

Örnek (çalışan hâli, `src/sources/listing-utils.ts`):

```ts
/(?:İ|I)lan\s*(?:No|Numarası)\s*[:.]?\s*([A-Z0-9-]{4,20})/gi;
```

4. **Kurum adı aranırken başlık satırı hariç tutulmalı.** ilan.gov.tr'de
   başlığın kendisi kurum adını içerir; `line !== title` koşulu olmadan
   `institution` alanı başlıkla dolar.

## 3. Test yaz (ağ olmadan)

1. `tests/fixtures/` altına gerçek sayfanın **yapısına uygun** bir fixture koyun.
   Fixture'ın kaynağını ve tarihini dosyanın başına yazın; uydurma içerik
   "gerçek veri" gibi sunulmaz.
2. `tests/sources.test.ts` içinde adaptörü sahte fetcher ile çalıştırın:
   - beklenen sayıda kayıt,
   - kurum/unvan/tarih alanları,
   - HTML bozulunca hata,
   - reddedilmesi gereken kayıtların sınıflandırma kararı.
3. `npx vitest run` ve `npx tsc --noEmit` temiz olmalı.

## 4. Canlı doğrulama (yalnızca gerçek ağ olan ortamda)

```powershell
$env:SOURCE_LIVE_FETCH = '1'
npm run test:live -- --live --source=ornek-kurum-ilanlar --max-requests=5 --max-pages=2 --max-details=1 --min-delay-ms=1000
Remove-Item Env:SOURCE_LIVE_FETCH
```

Komut salt okunur ve üretim DB'sinden bağımsızdır. HTTP status, kapsam durumu,
istek sayısı ve başlıklardan türetilen hash örneklerini verir; ham URL/gövde/başlık
rapora yazılmaz. `verificationEvidence` içine yalnız bu koşumun gerçekten
kanıtladığı tarih, HTTP status, item count ve coverage değerlerini girin. Başlık,
detay/PDF veya son başvuru tarihi raporda yoksa bunları doğrulanmış gibi yazmayın;
bunları ayrıca yetkili ortamda elle gözlemleyip kaynağını belgelemek gerekir.

Kanıt yeterli olduğunda `status` alanını `verified` yapın ve `lastVerifiedAt`
tarihini girin; yalnız erişim/HTML yapısı gözlendiyse `accessible` veya
`scraper-built` kullanın.

- Yalnızca HTML yapısı doğrulandıysa: `status: 'accessible'` veya `'scraper-built'`.
- Erişim engelliyse: `status: 'access-restricted'`, kanıta HTTP kodunu yazın.
- Kurulum gerekiyorsa (ör. tarayıcı): `statusNote` içinde komutu belirtin.

## 5. İzlemeye al

- Yönetim paneli → Kaynaklar: ilk taramayı elle tetikleyin.
- `scrapeRuns` kaydını kontrol edin: bulunan/kabul edilen/reddedilen sayıları,
  istek sayısı, süre, hata.
- İlk birkaç günde yanlış kabul/ret oranını inceleme kuyruğundan izleyin; gerekirse
  sınıflandırma kurallarını ve adaptörü güncelleyin.

## Kontrol listesi

- [ ] `allowedHosts` dar ve doğru
- [ ] `adapterKey` registry ile birebir eşleşiyor
- [ ] Adaptör ağa doğrudan çıkmıyor, `AdapterStructureError` kullanıyor
- [ ] Fixture + testler yeşil, `tsc` temiz
- [ ] Canlı doğrulama kanıtı `verificationEvidence` alanına yazıldı
- [ ] `status` yalnızca kanıt varsa `verified`
- [ ] Kapsam notu (`coverageNote`) hangi ilanların kapsandığını/kapsanmadığını yazıyor
