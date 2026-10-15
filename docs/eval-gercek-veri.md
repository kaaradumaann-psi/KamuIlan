# Gerçek veriyle değerlendirme kümesi (nasıl kurulur, neden hâlâ yetersiz)

**Amaç.** `npm run eval:classification` olmadan "sınıflandırma iyi" demek mümkün değildir.
Küme şu an **17 kayıttır ve hepsi `spec-title` (spesifikasyondaki başlık) kökenlidir; hiçbiri
gerçek ilan sayfası değildir.** Bu belge, 150–200 insan doğrulamalı gerçek kayda giden yolun
araçlarını ve kurallarını tanımlar.

## 1. Değiştirilemez dürüstlük kuralları

1. **Kaynak metni uydurulmaz.** Gerçek kayıt, resmî kaynakta okunan metindir.
2. **Makine tahmini altın etiket değildir.** Modelin/kuralın tahmini `machineSuggestion`
   alanında durur; `expectedContentType` boşsa kayıt içe aktarılmaz.
3. **Etiket insan doğrulaması ister.** `labeledBy` ve `labeledAt` yazılmadan hiçbir kayıt
   kümeye girmez (`src/classification/eval-set.ts` → `importLabeledWorksheet`).
4. **`origin: "real"` kanıt ister.** Yalnızca `provenance: "scraped"` VE kaynak envanterinde
   (`src/config/sources.ts`) bulunan bir kaynak gerçek sayılır. Demo/`seed:demo` kayıtları
   sentetiktir.
5. **Sayılar ayrı raporlanır.** Rapor, gerçek ve sentetik kayıt sayılarını, origin kırılımını
   ve `VERİ YETERSİZ` kararını gösterir; sentetik %100 gerçek başarı diye sunulmaz.

## 2. Akış

```bash
# 0) Gerçek kayıtların depoda olması gerekir: canlı tarama (ağ erişimi olan ortamda)
npm run start:worker           # ya da tek seferlik: npm run test:live (kurulu kaynaklar)

# 1) Etiketleme sayfası üret (SALT OKUNUR; veritabanına yazmaz)
npm run eval:build-set -- --filter review --limit 60 --out data/eval-worksheet.json
npm run eval:build-set -- --filter accepted --limit 60 --out data/eval-worksheet-accept.json

# 2) Sayfayı doldur: her satırda resmî bağlantı (url) açılır,
#    expectedContentType + expectedFields + labeledBy/labeledAt elle yazılır.
#    Tarih rolüne dikkat: yayım / başvuru başlangıcı / son başvuru / sınav tarihi karışmaz.

# 3) Doğrula (yazmaz) → sonra birleştir
npm run eval:build-set -- --import data/eval-worksheet.json --set tests/fixtures/eval/labeled-set.json
npm run eval:build-set -- --import data/eval-worksheet.json --set tests/fixtures/eval/labeled-set.json --apply

# 4) Ölç
npm run eval:classification                                  # yalnızca kurallar
npm run eval:classification -- --llm                         # kurallar + LLM kapısı
npm run eval:classification -- --llm --json data/eval.json   # makine okunur çıktı
```

**Not (veri küçültme):** depoda tam ilan gövdesi saklanmaz; yalnızca sınırlandırılmış,
iletişim bilgileri maskelenmiş `textExcerpt` tutulur (`jobSources.capturedTextStatus`
tam metnin durumunu söyler). Bu yüzden etiketleyen kişi metni `url` üzerinden resmî
kaynağından okur. Sayfa bunu `notes` alanında ihtar eder; alıntı 200 karakterin altındaysa
veya durum `captured` değilse **gövde olarak kümeye yazılmaz** (kırpık metinle ölçüm yapılmaz).

## 3. Kapsam hedefleri (`COVERAGE_TARGETS`)

| Kategori | İçerik türü | Hedef (insan doğrulamalı, gerçek) |
|---|---|---|
| Gerçek personel alımı | `personnel_recruitment` | 40 |
| Alım süreci duyurusu (sınav, kura, sonuç, liste) | `personnel_process_announcement` | 25 |
| Haber | `news` | 25 |
| Öğrenci alımı / YKS-tercih | `student_admission` | 15 |
| Eğitim programı / kurs / burs | `education_program` | 10 |
| Etkinlik (konferans, seminer…) | `event` | 10 |
| Rapor / yayın | `report_or_publication` | 10 |
| Diğer / belirsiz | `other` | 10 |
| **Toplam** | | **145** |

Tamamlayıcı zorunlu örnekler (hedefin içinde seçilir, ayrıca izlenir):

- süresi geçmiş ama geçmişte gerçek alım olmuş ilan (yanlış "geçersiz" üretimini ölçmek için),
- birden fazla şehir / şehir bazlı ayrı başvuru bağlantısı olan ilan,
- farklı tarih türlerini bir arada veren ilan (yayım + başvuru + sınav),
- liste kartından alınan eksik metin (kısa `rawExcerpt`) — belirsizlikte inceleme davranışı,
- komşu karttan veri sızmış olabilecek çok kartlı liste örnekleri (attribution hatası avı).

## 4. Bu ortamda neden hâlâ 0 gerçek kayıt var?

Sandbox'ın gidiş ağ izinleri yalnızca `github.com`, `npmjs.org`, `pypi.org` ile sınırlıdır.
`npm run test:live` bu ortamda her kurum kaynağında `ECONNRESET` (TLS el sıkışması kesiliyor)
verdi; `ilan.gov.tr` ve `resmigazete.gov.tr` okunamadı. Bu, **ENGELLENDİ** durumudur:
araçlar ve akış hazırdır, veri ağ erişimi olan bir ortamda toplanabilir. Bu durumda üretilen
tek şey kod ve testleridir; gerçek etiket sayısı 0 olarak rapor edilir.

## 5. Ölçülen metrikler

`npm run eval:classification` çıktısında:

- sınıf bazında destek/tahmin/DOĞRU, precision, recall, F1,
- yanlış kabul oranı (ilan olmayan → ilan) + kayıt kimlikleri,
- yanlış ret oranı (ilan → ilan değil) + kayıt kimlikleri,
- belirsiz inceleme oranı (`uncertain`) + kimlikler,
- karışıklık matrisi (sıfır olmayan hücreler),
- origin kırılımı (`real` / `synthetic` / `spec-title`, her birinde insan etiket sayısı),
- kaynak bazlı hata ve belirsizlik oranları (`sourceKey` dolu kayıtlarda),
- alan çıkarımı doğruluğu (`expectedFields` doldurulmuşsa: kurum, şehir, kontenjan,
  başvuru başlangıcı/bitişi, başvuru bağlantısı, yayım tarihi),
- `--llm` modunda: LLM çağrı sayısı ve oranı, önbellek isabeti, bütçe/kota engeli,
  hata oranı, gecikme (ortalama/p50/p95/maks), token kullanımı ve **tahminî** maliyet
  (fiyatlandırma yapılandırılmadıysa maliyet rakamı üretilmez).

Yeterli veri yoksa ilgili satırlar `ölçülemedi` / `VERİ YETERSİZ` yazar.
