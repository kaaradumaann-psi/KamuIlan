# 145 insan doğrulamalı gerçek kayıt — etiketleme ve ölçüm runbook'u

**Hedef:** 145 gerçek ilan; her kayıt resmî URL'den **insan tarafından** doğrulanır.
Bu sayı doldurulmadan sınıflandırma veya alan çıkarımı için başarı yüzdesi
yayımlanmaz. Sentetik/şartname kayıtları hedefe sayılmaz ve hiçbir orana katılmaz.

| Kategori | Hedef |
|---|---:|
| Personel alımı | 40 |
| Personel alım süreci duyurusu | 25 |
| Haber | 25 |
| Öğrenci alımı | 15 |
| Eğitim programı | 10 |
| Etkinlik | 10 |
| Rapor/yayın | 10 |
| Diğer/belirsiz | 10 |
| **Toplam** | **145** |

## 1. Akış (PowerShell)

```powershell
# 0) Çevrimdışı taban çizgisi
npm ci
npm run verify:all

# 1) Tek kaynaklı staging koşumu (ayrıntı: STAGING-RUNBOOK.md)
npm run staging:capture -- --source=<kaynak> --dry-run
#    erişim şartlarını config/source-terms.json içine insan olarak yazın
npm run staging:capture -- --source=<kaynak> --live --max-requests=5 --max-pages=3 --max-details=1 --min-delay-ms=1500

# 2) Etiketleme sayfası (salt okunur; üretim DB'ye dokunmaz)
npm run eval:build-set -- --data-dir=.staging\<kosum>\data --out=.staging\<kosum>\worksheet.json --filter all --limit 60

# 3) İnsan etiketlemesi: aşağıdaki alanları resmî URL'yi açarak doldurun
#    (worksheet.json'u düzenleyin; makine önerisine DOKUNMAYIN)

# 4) Önce kuru içe aktarma, sonra --apply
npm run eval:build-set -- --import .staging\<kosum>\worksheet.json --set tests/fixtures/eval/labeled-set.json
npm run eval:build-set -- --import .staging\<kosum>\worksheet.json --set tests/fixtures/eval/labeled-set.json --apply

# 5) Ayrı, çevrimdışı değerlendirmeler
npm run eval:classification
npm run eval:extraction
```

JSON raporlar (opsiyonel):

```powershell
npm run eval:classification -- --json artifacts\eval-classification.json
npm run eval:extraction -- --json artifacts\eval-extraction.json
```

`artifacts/` git'e girmez. Raporlarda ham başlık/gövde/URL yoktur; kayıt
kimlikleri hash'lenir.

## 2. Sayfa şeması

Her kayıt şu alanlarla gelir:

| Alan | Kural |
|---|---|
| `origin` | Yalnızca `real` (envanterdeki kaynak + `provenance: scraped`) gerçek sayılır. |
| `url` | Resmî ilan sayfası; host, kaynağın allowlist'inde olmalı. |
| `labelEvidence` | **Zorunlu:** `sourceUrl` (aynı belge), `quote` (en az 20 karakter birebir alıntı), `locator`. |
| `expectedContentType` | İnsan kararı; boşsa kayıt içe alınmaz. |
| `expectedFields` | Alan bazlı insan etiketi; aşağıdaki anahtarlar. |
| `caseTags` | Tuzak senaryosu işaretleri (bölüm 4). |
| `labeledBy` / `labeledAt` | Kim / ne zaman. ISO tarih. |

### `expectedFields` değer biçimleri

```json
{
  "city": "Ankara",
  "quota": 5,
  "applicationEndAt": "2026-10-30T17:00",
  "educationLevels": ["Lisans"],
  "district": null,
  "titles": { "value": ["Bilişim Personeli"], "status": "ambiguous",
              "evidenceQuote": "…", "sourceUrl": "https://…", "locator": "tablo 2" }
}
```

- `null` = **doğrulandı, ilanda yok**. Alanı hiç yazmamak = **etiketlenmedi**
  (ölçüm dışı). Bu ikisi aynı şey değildir.
- `{value, status}`: `present` / `absent` / `ambiguous`; `ambiguous` ölçüme
  katılmaz, ayrı sayılır.
- `evidenceQuote`/`sourceUrl`/`locator` opsiyoneldir ama önerilir; üst düzey
  `labelEvidence` zaten zorunludur.

### Kanonik alanlar

`institution`, `unit`, `employmentType`, `city`, `district`, `quota`,
`cadreStatus`, `titles`, `educationLevels`, `departments`, `kpssScoreTypes`,
`kpssMinScore`, `kpssYear`, `minAge`, `maxAge`, `certificates`,
`minExperienceYears`, `foreignLanguages`, `specialConditions`, `publishedAt`,
`applicationStartAt`, `applicationEndAt`, `applicationMethod`, `applicationUrl`,
`attachments`, `referenceNo`.

Eski adlar (`il`, `kontenjan`, `unvan`, `applicationEndDate`, …) kanonik anahtara
çevrilir ve raporda `aliasNormalizedFields` olarak görünür. **Bilinmeyen anahtar
kaydı reddettirir**; sessizce ölçüm dışı bırakılmaz.

## 3. İçe aktarma reddi

Kayıt şu durumlarda içe alınmaz:

1. `expectedContentType` boş.
2. `origin: real` ama `labelProvenance != human`.
3. `labeledBy` / `labeledAt` yok veya tarih geçersiz.
4. `expectedFields` içinde bilinmeyen anahtar veya `status: "present"` + boş değer.
5. Gerçek kayıt: `sourceKey` envanterde yok; URL host'u allowlist dışında.
6. Gerçek kayıt: `labelEvidence` yok; kanıt URL'si farklı belge; alıntı < 20 karakter.
7. Aynı kaynak + başlık + kurum ya da aynı belge URL'si (duplicate leakage).

Reddedilen kayıtlar raporda nedeniyle listelenir; hiçbiri sessizce atılmaz.

## 4. Tuzaklar ve `caseTags`

| Tuzak | Ne yapılır | `caseTags` |
|---|---|---|
| Yayım ≠ başvuru tarihi | Dört tarihi ayrı yaz: yayım, başvuru başlangıcı, bitiş (saat varsa), sınav. | `date-role-confusion` |
| Süresi geçmiş ama gerçek | Kayıt gerçektir; `expectedContentType` yine ilan; tarihleri olduğu gibi yazın. | `expired-but-real` |
| Düzeltme/iptal duyurusu | İlanla karıştırmayın; metnin ne dediğini etiketleyin. | `correction-or-cancellation` |
| Birden fazla il | İl alanına yalnızca birincil ili; diğerlerini `notes`/`caseTags` ile işaretleyin. | `multi-province` |
| Liste metni eksik | Yalnızca karttan okuyup uydurmayın; resmî detay sayfasına gidin. | `missing-list-text` |
| Komşu kart sızması | Alıntıyı seçerken yalnızca bu ilana ait cümleyi alın. | `neighbour-card-leakage` |
| Aynı ilanın kopyası | Aynı belge/ilan ailesini ikinci kez etiketlemeyin. | `duplicate-family` |

## 5. Dürüstlük kuralları

- Makine/LLM tahmini **asla** `expected*` alanlarına kopyalanmaz.
- Sentetik kayıtla hedef doldurulmaz; `origin` değiştirilmez.
- Sayı hedefin altındaysa rapor **INSUFFICIENT DATA** der; yüzde üretilmez.
- Aynı ilan iki kaynakta görünüyorsa yalnızca birincil kaynağı etiketleyin.
- Kayıt silinmez; hatalıysa yeni etiketle güncellenir (aynı `id` üzerine yazılır).
- Kişisel veri (telefon/e-posta/TCKN) raporda ve alıntıda maskelenir; ham
  kopya commit edilmez.

## 6. Ölçüm komutları ve çıktılar

| Komut | Çıktı | İnternet/AI |
|---|---|---|
| `npm run eval:classification` | Sınıf P/R/F1, yanlış kabul/ret, origin kırılımı, alan özeti | Yok |
| `npm run eval:extraction` | Alan bazında destek/P/R/F1, kaçırılan, uydurma, kanıt doğrulama, tarih rol karışması, kaynak/tür kırılımı | Yok |
| `npm run eval:classification -- --llm …` | Ayrı, açık opt-in sağlayıcı ölçümü | **Var**; varsayılan değil |

Çıkış kodu 0, "başarı" değil "rapor üretildi" demektir. Durum satırı
`INSUFFICIENT DATA` ise hiçbir oran yayımlanmaz.

## 7. Bitiş kontrolü

```powershell
node -e "const s=require('./tests/fixtures/eval/labeled-set.json');const r=s.records.filter(x=>x.origin==='real'&&x.labelProvenance==='human');console.log('gerçek insan:',r.length,'/',145)"
npm run eval:classification -- --json artifacts\eval-classification.json
npm run eval:extraction -- --json artifacts\eval-extraction.json
npm run verify:all
```

`gerçek insan` sayısı 145'in altındaysa sonuç **INSUFFICIENT DATA**'dır; bu bir
başarısızlık değil, ölçüm yapılmadığının kanıtıdır.
