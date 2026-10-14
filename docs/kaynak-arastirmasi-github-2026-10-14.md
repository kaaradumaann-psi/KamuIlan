# GitHub kamu-ilan ekosistemi araştırması

- **Tarih:** 14.10.2026
- **Kapsam:** GitHub'da kamu ilan / personel alımı takibi yapan açık depoların yöntem,
  kaynak ve mimari karşılaştırması; kamuradar'a uyarlanan eksikler ve gerekçeleri.
- **İlişkili değişiklik:** Bu araştırmanın bulguları aynı tarihli PR'da sisteme işlenmiştir
  (ilan.gov.tr JSON API adaptörü, ÖSYM nitelik kodu çıkarımı, hayalet ilan kuralı, POST
  destekli HttpClient).

## 1. Taranan depolar

| Depo                                                                                          | Kaynaklar                                                                                                      | Yöntem                                                                                                                                                                               | Öne çıkan güçlü yön                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Ruchanbas/rg-ilan-botu](https://github.com/Ruchanbas/rg-ilan-botu)                           | ilan.gov.tr **JSON API**, Resmî Gazete PDF                                                                     | POST `Ad/AdsByFilter` + `GetAdDetail`, PDF metin eşleştirme                                                                                                                          | Resmî Gazete bulut IP'lerini engellediği için **API'ye geçiş**; canlı doğrulanmış API sözleşmesi; segment eşleştirme (1 RG PDF = çok ilan); İ/ı-duyarlı normalizasyon; KESİN/SÜPHELİ kademeleri; ölü adam anahtarı alarmı; kaldığı yerden devam eden backfill |
| [emrekorkusuz/kamu-ilan-takip](https://github.com/emrekorkusuz/kamu-ilan-takip)               | osym.gov.tr, kariyerkapisi.gov.tr/isealim, resmigazete.gov.tr/cesitli-ilanlar, ilan.gov.tr `/ilan/kategori/20` | HTML listeleri + regex alan çıkarımı                                                                                                                                                 | **ÖSYM nitelik kodu** filtreleme (4001/6225 genel, 45xx bilişim ailesi); KPSS P3 taban puan; MATCH/REVIEW/NONE kademesi; Telegram HTML + "İlana Git" butonu                                                                                                   |
| [alkanneyup/Kamu-lan-Takip](https://github.com/alkanneyup/Kamu-lan-Takip)                     | **İŞKUR kamu ilan RSS**                                                                                        | `esube.iskur.gov.tr/Rss/Ilanlar.aspx?tur=kamu` + `iskur.gov.tr/rss/kamu-ilanlari` (XML channel/item)                                                                                 | RSS ile en ucuz, stabil tarama yolu; kurum sayfası taramadan kamu ilanı akışı                                                                                                                                                                                 |
| [Hesso04/kamupersonelrehberi](https://github.com/Hesso04/kamupersonelrehberi)                 | SBB kamuilan + Resmî Gazete                                                                                    | HTML/PDF + **Groq LLM** ile yapılandırılmış çıkarım (kadro, mezuniyet, KPSS); Streamlit insan-onayı; DRAFT→AI_PROCESSED durum makinesi                                               | LLM destekli alan çıkarımı + insan onaylı yayımlama akışı; Telegram 1080x1080 görsel kartlar                                                                                                                                                                  |
| [StepneSP/diyetisyen_kamu_takip](https://github.com/StepneSP/diyetisyen_kamu_takip)           | Kurum sayfaları (**Google News RSS** üzerinden keşif)                                                          | Haber RSS'iyle yeni kurum sayfası bulma, KPSS P3 puan eşleştirme                                                                                                                     | Sayfa envanterini elle kurmadan **keşif** (discovery) katmanı                                                                                                                                                                                                 |
| [berketez/is-basvuru-botu](https://github.com/berketez/is-basvuru-botu)                       | Kurum/kariyer sayfaları                                                                                        | Yaş (>1 yıl), "talent pool / expression of interest / genel başvuru", "ileride açılacak pozisyonlar", şişirilmiş lokasyon tespiti                                                    | **Hayalet ilan (ghost posting)** eleme desenleri                                                                                                                                                                                                              |
| [masalburadaydi-blip/kamu-ilan-takip](https://github.com/masalburadaydi-blip/kamu-ilan-takip) | Kurum duyuru sayfaları                                                                                         | `config.json` tabanlı terim filtreleri (no_kpss/education/permanent/contract), Kadrolu/Sözleşmeli sınıflandırma, 81 il tespiti, `seen.json` (5000 kayıt sınırı), GitHub Actions cron | Yapılandırma-odaklı filtre katmanı; basit ve işletilebilir cron mimarisi                                                                                                                                                                                      |
| [uclergnlts/kamu-ilan](https://github.com/uclergnlts/kamu-ilan)                               | ilan.gov.tr (planlı sitemap adaptörü)                                                                          | FastAPI MVP iskeleti                                                                                                                                                                 | Sitemap tabanlı keşif fikri (henüz iskelet)                                                                                                                                                                                                                   |

## 2. Öne çıkan yöntemler (kamuradar için dersler)

### 2.1 ilan.gov.tr JSON API sözleşmesi (en değerli bulgu)

Resmî Gazete bulut sağlayıcı IP'lerini (AWS/GitHub/Azure) engellediği için RG PDF'i
doğrudan çekmek sunucu ortamlarında kırılgandır. `rg-ilan-botu` bunu ilan.gov.tr'nin
JSON API'sine geçerek çözmüş ve sözleşme GitHub Actions runner'larından **canlı
doğrulanmıştır**:

```
Taban:  https://www.ilan.gov.tr/api/api/services/app     (çift "api" gerçek)
Arama:  POST Ad/AdsByFilter
        {"keys": {"q": ["<terim>"]}, "skipCount": 0, "maxResultCount": 100}
        DİKKAT: q DİZİ olmalıdır — düz metin 400 döner.
Cevap:  {"result": {"numFound": N, "ads": [...]}}
Alanlar: id, adNo, title, advertiserName, addressCityName, publishStartDate,
        urlStr, isArchived, adTypeFilters[{key, value}] ("Son Başvuru" = son gün).
Detay:  GET AdDetail/GetAdDetail?id=<adNo>&isKiwiAd=false
        (şema belgelenmemiş → tüm JSON metin değerleri özyinelemeli toplanır).
TLS:    ilan.gov.tr ara sertifikayı atlar; sistem CA paketini kullanın.
```

Ayrıca: 1 RG PDF'i birden çok ilan içerebilir (kodlu segmentler halinde bölme
gerekir, örn. "3795/1-1"); tarihler için dd/mm/yyyy kalıbı + fallback (yayım+15 gün);
filtre dosyasında "dışla" terimleri; SUPHELI kademesi detay okunamazsa.

### 2.2 ÖSYM nitelik kodları

Başvuru şartlarının en yapılandırılmış hâli ÖSYM nitelik kodlarıdır (ilan tablosunda
"Nitelik Kodu" sütunu). Ekosistemdeki istikrarlı kalıp: **4001** (lisans herhangi bir),
**6225** (önlisans herhangi bir), **3001** (ortaöğretim), **45xx** (bilişim personeli
ailesi: 4539/4531/4532/4533/4535/4537). `emrekorkusuz` bunları `4\d{3}|6225` kalıbıyla
çıkarıp aday profiliyle MATCH/REVIEW/NONE diye eşleştiriyor.

### 2.3 İŞKUR kamu ilan RSS

`https://esube.iskur.gov.tr/Rss/Ilanlar.aspx?tur=kamu` ve
`https://www.iskur.gov.tr/rss/kamu-ilanlari` XML kanalı, kurum sayfalarını taramadan
kamu ilanı akışı verir — HTML listeye göre çok daha düşük işletme maliyeti.

### 2.4 Hayalet ilan (ghost posting) tespiti

`berketez/is-basvuru-botu` desenleri: ilan yaşı > 1 yıl; "talent pool / expression of
interest / genel başvuru"; "ileride açılacak pozisyonlar"; lokasyon şişirme. Bunlar
belirli bir kadro açığı değil, havuz toplamadır — "yeni ilan" sayılmamalıdır.

### 2.5 Diğer

- **LLM destekli çıkarım + insan onayı** (`Hesso04`): PDF/HTML'den kadro/mezuniyet/KPSS
  alanlarını LLM ile çıkarıp insan onayıyla yayımlama (DRAFT→AI_PROCESSED).
- **Google News RSS keşfi** (`StepneSP`): yeni kurum ilan sayfalarını haber RSS'inden
  bulma.
- **Telegram dağıtımı**: sendMessage + HTML + inline buton; kamuradar'da zaten e-posta
  kanalı var, Telegram taşıyıcı gelecek iş olarak not edilmiştir.
- **Kaldığı yerden devam backfill + ölü adam anahtarı** (`rg-ilan-botu`): büyük
  arşiv taramalarında kırılan işi sürdürme ve sessizlikte alarm.

## 3. Karşılaştırma: kamuradar vs ekosistem

| Yetenek                   | Ekosistem                    | kamuradar (önce)                           | kamuradar (bu değişiklikle)                                                         |
| ------------------------- | ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| ilan.gov.tr toplama       | JSON API (rg-ilan-botu)      | HTML liste (kategori 5+20)                 | HTML liste + **JSON API adaptörü** (tamamlayıcı havuz)                              |
| Offset sayfalama          | skipCount (API)              | currentPage (HTML)                         | **skipCount kanıtlı sayfalama** eklendi                                             |
| Son başvuru tarihi        | adTypeFilters "Son Başvuru"  | HTML detay regex                           | API'de **yapılandırılmış filtreden** okuma eklendi                                  |
| ÖSYM nitelik kodu         | 4001/6225/45xx eşleştirme    | yok                                        | **çıkartılıyor** (requirements.qualificationCodes, kanıt izli)                      |
| Hayalet ilan eleme        | desen listesi                | yok                                        | **genel başvuru/özgeçmiş havuzu kuralları** (başlıkta ret, gövdede yumuşak negatif) |
| İŞKUR                     | RSS                          | HTML liste adaptörü                        | HTML (korundu); RSS alternatifi gelecek iş                                          |
| RG PDF segment eşleştirme | kodlu bölme (1 PDF = n ilan) | PDF = 1 ilan                               | bilinen sınır; gelecek iş                                                           |
| LLM çıkarım + insan onayı | Groq + Streamlit             | deterministik çıkarım + belirsizlik izleri | korunan tasarım (deterministik); LLM hibrit gelecek iş                              |
| Bildirim                  | Telegram                     | E-posta (Resend) + sitede canlı            | korundu; Telegram taşıyıcı gelecek iş                                               |
| Ret/inceleme bütçesi      | — (çoğu projede yok)         | **kaynak bazlı bütçe** (12.10 düzeltmesi)  | korundu; API havuzundan gelen ihale/sonuç kayıtları bu bütçeyle elenir              |

## 4. Bu PR'da sisteme işlenenler

1. **HttpClient POST + JSON gövde desteği** (`src/sources/fetcher.ts`): `method:
'POST'`, `jsonBody`; yönlendirmelerde 301/302/303 → GET (gövde düşer),
   307/308 → POST korunur. SSRF allowlist her yönlendirme adımında yeniden doğrulanır.
2. **`ilan-gov-tr-api` adaptörü** (`src/sources/adapters/ilan-gov-tr-api.ts`):
   AdsByFilter (q dizi + skipCount), GetAdDetail (şemadan bağımsız metin toplama),
   adTypeFilters → son başvuru, adNo → resmî ilan numarası, arşivli ilan atlama,
   yapı hatasında **gürültülü** AdapterStructureError, 401/403 → SourceAccessError.
   Envanter kaydı `ilan-gov-tr-api-personel`: **dürüst statü `scraper-built`**
   (canlı doğrulama henüz yapılmadı; kanıt alanı rg-ilan-botu sözleşmesini gösterir).
3. **ÖSYM nitelik kodu çıkarımı** (`src/extraction/engine.ts`, `dictionaries.ts`):
   "nitelik kodu" bağlam penceresi + bilinen kod listesi; `requirements.qualificationCodes`;
   detay sayfasında "ÖSYM nitelik kodu" satırı.
4. **Hayalet ilan kuralları** (`src/classification/rules.ts`):
   `ret-baslik.genel-basvuru` (kesin ret), `ret-yumusak.genel-basvuru` (puan kırar).
5. **Testler**: `tests/ilan-gov-tr-api.test.ts` (14), fetcher POST/yönlendirme (3),
   nitelik kodu çıkarımı (3), hayalet ilan (2) — toplam 419 test yeşil.

## 5. Gelecek iş (bilinçli ertelenenler)

- **İşKUR RSS alternatifi**: `esube.iskur.gov.tr/Rss/Ilanlar.aspx?tur=kamu` adaptörü
  (mevcut HTML adaptörünün yanında düşük maliyetli kanal).
- **RG PDF segment eşleştirme**: 1 PDF içindeki çoklu ilanları kod kalıplarıyla bölme
  (`3795/1-1` tipi segment başlıkları); mevcut resmigazete adaptörü PDF başına 1 ilan
  üretir — bilinen kapsama sınırı.
- **Google News RSS keşfi**: yeni kurum sayfalarını otomatik bulma katmanı.
- **Telegram dağıtımı**: mevcut bildirim hattına ikinci taşıyıcı.
- **LLM hibrit çıkarım**: deterministik motorun yanına, düşük güvenli alanlarda LLM
  önerisi + insan onayı (kamuradar'ın belirsizlik izleri bunun için zemin).
- **Ölü adam anahtarı**: kaynak başına X koşu boyunca sıfır kayıt sessizliği alarmı
  (şimdilik `warnOnRepeatedFailures` tekrar eden başarısızlık uyarısı yeterli).

## 6. Kaynaklar

- https://github.com/Ruchanbas/rg-ilan-botu — README + `src/rgbot/ilanapi.py`, `toplayici.py`
  (14.10.2026 okundu; API sözleşmesi canlı doğrulamalı).
- https://github.com/emrekorkusuz/kamu-ilan-takip — `main.py` (nitelik kodları, kaynak listesi).
- https://github.com/alkanneyup/Kamu-lan-Takip — `iskur.py` (İŞKUR RSS uçları).
- https://github.com/Hesso04/kamupersonelrehberi — README (LLM çıkarım + Streamlit onay akışı).
- https://github.com/StepneSP/diyetisyen_kamu_takip — README (Google News RSS keşfi).
- https://github.com/berketez/is-basvuru-botu — README (hayalet ilan desenleri).
- https://github.com/masalburadaydi-blip/kamu-ilan-takip — `main.py` (config.json filtreleri).
- https://github.com/uclergnlts/kamu-ilan — README (sitemap adaptörü planı).
