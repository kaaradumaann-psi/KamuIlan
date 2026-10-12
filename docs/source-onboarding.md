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

```bash
SOURCE_LIVE_FETCH=1 npm run test:live -- --source=ornek-kurum-ilanlar
# veya kuru çalıştırma (DB'ye yazmaz):
SOURCE_LIVE_FETCH=1 npx tsx scripts/live-check.ts --source=ornek-kurum-ilanlar --dry-run
```

Çıktıdan doğrulananları `verificationEvidence` alanına yazın:

```
2026-10-12 canlı doğrulama: <URL> açıldı; <N> ilan kaydı görüldü
(ör. "<Kurum> — Hemşire Alım İlanı", son başvuru 30.10.2026); ayrıntı sayfası ve
PDF metin katmanı okundu.
```

Sonra `status` alanını `verified` yapın ve `lastVerifiedAt` tarihini girin.

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
