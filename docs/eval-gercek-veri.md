# Gerçek veriyle değerlendirme kümesi (nasıl kurulur, neden hâlâ yetersiz)

**Amaç.** `npm run eval:classification` olmadan "sınıflandırma iyi" demek mümkün değildir.
Küme şu an **17 kayıttır ve hepsi `spec-title` (spesifikasyondaki başlık) kökenlidir; hiçbiri
gerçek ilan sayfası değildir.** Bu belge, 145 insan doğrulamalı gerçek kayda giden yolun
araçlarını ve kurallarını tanımlar.

## 1. Değiştirilemez dürüstlük kuralları

1. **Kaynak metni uydurulmaz.** Gerçek kayıt, resmî kaynakta okunan metindir.
2. **Makine tahmini altın etiket değildir.** Modelin/kuralın tahmini `machineSuggestion`
   alanında durur; `expectedContentType` boşsa kayıt içe aktarılmaz.
3. **Etiket insan doğrulaması ister.** `labeledBy` ve `labeledAt` yazılmadan hiçbir kayıt
   kümeye girmez (`src/classification/eval-set.ts` → `importLabeledWorksheet`).
4. **`origin: "real"` kanıt ister.** Yalnızca `provenance: "scraped"` VE kaynak envanterinde
   (`src/config/sources.ts`) bulunan bir kaynak gerçek sayılır. Demo/`seed:demo` kayıtları
   sentetiktir. İçe aktarmada `labelEvidence` (resmî URL + en az 20 karakter birebir alıntı),
   allowlist host ve duplicate-family kontrolü zorunludur.
5. **Sayılar ayrı raporlanır.** Rapor, gerçek ve sentetik kayıt sayılarını, origin kırılımını
   ve `VERİ YETERSİZ` kararını gösterir; sentetik %100 gerçek başarı diye sunulmaz.

## 2. Akış

```powershell
New-Item -ItemType Directory -Force data | Out-Null
# 0) Kaynak erişimi ayrı ve opt-in kanıttır; test:live üretim DB'sine yazmaz.
#    Gerçek kayıt oluşturmak/worker çalıştırmak için yalnızca ayrılmış staging/file DB kullanın.
$env:SOURCE_LIVE_FETCH = '1'
npm run test:live -- --live --source=osym-duyurular --max-requests=5 --max-pages=2 --max-details=1 --min-delay-ms=1000
Remove-Item Env:SOURCE_LIVE_FETCH
# Worker'ı production DB'ye yönlendirerek eval kümesi oluşturmayın.

# 1) Etiketleme sayfası üret (SALT OKUNUR; veritabanına yazmaz)
npm run eval:build-set -- --filter review --limit 60 --out data/eval-worksheet.json
npm run eval:build-set -- --filter accepted --limit 60 --out data/eval-worksheet-accept.json

# 2) Sayfayı doldur: her satırda resmî bağlantı (url) açılır,
#    expectedContentType + expectedFields + labeledBy/labeledAt elle yazılır.
#    Tarih rolüne dikkat: yayım / başvuru başlangıcı / son başvuru / sınav tarihi karışmaz.

# 3) Doğrula (yazmaz) → sonra birleştir
npm run eval:build-set -- --import data/eval-worksheet.json --set tests/fixtures/eval/labeled-set.json
npm run eval:build-set -- --import data/eval-worksheet.json --set tests/fixtures/eval/labeled-set.json --apply

# 4) Ölç (deterministik; insan etiketleri yoksa sonuç VERİ YETERSİZ)
npm run eval:classification -- --json data/eval-offline.json

# Ücretli/provider eval yalnızca veri paylaşımına izin verilmiş, incelenmiş veriyle:
# --reviewed-public-data ve tüm üç bütçe bayrağı zorunludur.
npm run eval:classification -- --file tests/fixtures/eval/labeled-set.json --llm --reviewed-public-data --max-calls 1 --max-output-tokens 128 --max-cost-usd 0.01 --json data/eval-live.json
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

Önceki tarihli sandbox koşumlarında gidiş ağı `github.com`, `npmjs.org`, `pypi.org`
ile sınırlıydı; `ilan.gov.tr` ve `resmigazete.gov.tr` okunamadı. Bu, **ENGELLENDİ**
kanıtıdır; canlı doğruluk/sağlık sonucu değildir. Bu çalışma turunda yeni canlı kaynak,
provider veya insan etiket koşumu yapılmadı. Güncel kontrolün sonucu yalnızca gerçek
komut çıkışlarından raporlanmalıdır; gerçek insan etiketli kayıt sayısı halen **0**.
Yeni izolasyon ve dar kapsamlı operatör adımları: [quality/OFFLINE-VERIFY.md](./quality/OFFLINE-VERIFY.md).

## 5. Ölçülen metrikler

`npm run eval:classification` çıktısında:

- sınıf bazında destek/tahmin/DOĞRU, precision, recall, F1,
- yanlış kabul oranı (ilan olmayan → ilan) + raporda hash'lenmiş kayıt kimlikleri,
- yanlış ret oranı (ilan → ilan değil) + raporda hash'lenmiş kayıt kimlikleri,
- belirsiz inceleme oranı (`uncertain`) + hash'lenmiş kimlikler,
- karışıklık matrisi (sıfır olmayan hücreler),
- origin kırılımı (`real` / `synthetic` / `spec-title`, her birinde insan etiket sayısı),
- kaynak bazlı hata ve belirsizlik oranları (`sourceKey` dolu kayıtlarda),
- alan çıkarımı doğruluğu ayrı komutla: `npm run eval:extraction` (insan etiketli,
  gövdesi tam kayıtlar; P/R/F1, kaçırılan, uydurma, kanıt doğrulama, tarih rol karışması).
  Eski özet `eval:classification` içinde de görünür. Kapsanan alanlar: kurum, şehir, kontenjan,
  başvuru başlangıcı/bitişi, başvuru bağlantısı, yayım tarihi),
- `--llm` modunda: LLM çağrı sayısı ve oranı, önbellek isabeti, bütçe/kota engeli,
  hata oranı, gecikme (ortalama/p50/p95/maks), token kullanımı ve **tahminî** maliyet
  (fiyatlandırma yapılandırılmadıysa maliyet rakamı üretilmez).

Yeterli veri yoksa ilgili satırlar `ölçülemedi` / `VERİ YETERSİZ` yazar.
