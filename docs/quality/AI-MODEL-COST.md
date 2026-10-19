# AI modeli, maliyet ve ölçüm planı

**Durum (2026-10-19):** Varsayılan testlerde **0 sağlayıcı çağrısı**; bu depoda
hiçbir canlı model çağrısı yapılmadı ve **fatura yoktur**. Aşağıdaki fiyatlar
2026-10-19'da resmî Google dokümanından okunmuştur; yine de operatör her canlı
koşumdan önce fiyatı yeniden teyit etmelidir. Fiyat bilinmiyorsa üretim çağrısı
**fail-closed** durur.

## 1. Aday modeller (karar değil, karşılaştırma)

| Aday | Durum | Resmî bilgi (2026-10-19) |
|---|---|---|
| `gemini-3.1-flash-lite` | **DOĞRULANDI (stable)** | 1.048.576 giriş / 65.536 çıkış token; **$0.25** giriş (metin/görsel/video), **$0.50** ses; **$1.50** çıkış — 1M token başına USD. Batch: $0.125 / $0.75. Context caching: $0.025. Kaynaklar: <https://ai.google.dev/gemini-api/docs/pricing> ve <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite> (2026-10-19 okundu; sayfa yaşı 2026-10-16). Model sayfası "Stable: gemini-3.1-flash-lite" der. |
| `gemini-3-flash-preview` | Doğrulandı (preview) | 1M/64k; $0.50 giriş / $3.00 çıkış. |
| `gemini-3.1-pro-preview` | Doğrulandı (preview) | 1M/64k; $2.00/$12.00 (≤200k token), $4.00/$18.00 (>200k). |
| Mevcut yapılandırılmış model | Kodda destekli | `LLM_MODEL`; varsayılan boş, AI/LLM kapalı. |
| Yerel model | **DEĞERLENDİRİLMEDİ** | Donanım, Türkçe kalite, işletim, lisans ve veri saklama koşulları ölçülmeden önerilmez. |

**Önemli:** Fiyat değişebilirliği, bölgesel kullanılabilirlik ve veri kullanım koşulları
nedeniyle bu model **varsayılan yapılmaz**. Ücretsiz katman "içerik ürünleri
iyileştirmek için kullanılır" olarak işaretlidir; ücretli katmanda bu kullanım
"No"dur. Kişisel/kullanıcı verisi ücretsiz katmandan geçirilmemelidir (§ resmî
fiyat sayfası "Used to improve our products" satırı, 2026-10-19). Modelin "ucuz" olması kalite kanıtı
değildir; 145 insan etiketli gerçek kayıt üzerinde ölçüm olmadan üretim kararı
verilmez. Kullanıcı girdisindeki "≈ $0.25/$1.50" bu kez resmî dokümanla
uyuşmaktadır; bu yine de **fatura** değildir.

Model değişikliği, 145 insan etiketli gerçek kayıt üzerinde ölçüm yapılmadan
**varsayılan yapılmaz**. Mevcut varsayılan: AI/LLM kapalı.

## 2. Zorunlu bütçe ve güvenlik kuralları

- Varsayılan test/build: **0** sağlayıcı çağrısı; `LLM_CLASSIFIER_ENABLED=0`,
  `AI_ASSISTANT_ENABLED=0`.
- Canlı komutlar açık `--live`/`--llm` ve `--max-calls`, çıktı sınırı, zaman aşımı
  ve tahmini azami maliyet ister. İlk smoke çağrısı `--max-calls=1`.
- Sessiz retry yok; `429`/`5xx`/timeout ayrı raporlanır.
- Fiyat bilinmiyorsa **fail-closed**: `pricing-unavailable`; çağrı yapılmaz.
- Atomik rezervasyon: çağrıdan **önce** günlük çağrı ve USD-mikro bütçesi
  ayrılır; eşzamanlı worker'lar aynı bakiyeyi iki kez harcayamaz.
- Sağlayıcı raporladığı token ile tahmini token ayrı alanlarda tutulur; tahmin
  "fatura" diye sunulmaz.
- Önbellek anahtarı: `provider/model + prompt/schema sürümü + içerik hash'i`.
  Model değişince eski yanıt kullanılmaz.
- AI'ın ürettiği tarih/sayı/başlık, şema + metin kanıtı doğrulanmadan
  yayımlanmaz. Kanıtsız alan `review`'da kalır.
- Veri minimizasyonu: sağlayıcıya yalnızca gerekli alanlar; e-posta/telefon/TCKN
  scrub edilir; ham ilan gövdesi gönderilmez.

## 3. Ölçüm protokolü (gold label hazır olunca)

1. `tests/fixtures/eval/labeled-set.json` içinde en az 145 insan etiketli gerçek
   kayıt; `expectedFields` + `labelEvidence` dolu.
2. Aynı veri kümesi hash'i, prompt sürümü, şema sürümü, model kimliği ve tarih
   raporda saklanır (`datasetHash`, `LLM_PROMPT_VERSION`, `EXTRACTION_VERSION`).
3. Her model için **önce 1 çağrılık smoke**, sonra sınırlı ölçüm; `--max-calls`
   ve `--max-cost-usd` zorunlu.
4. Rapor: P/R/F1, yanlış kabul/ret, alan doğruluğu, desteksiz olgu, kanıt
   geçerliliği, JSON geçme oranı, çağrı/token, p50/p95 gecikme, 100 ilan başına
   maliyet, veri kullanım koşulları.
5. Örnek maliyet (varsayım; fatura değil): ilan başına 4.000 giriş + 500 çıkış
   token → `(4000/1e6×0.25) + (500/1e6×1.50) = $0.00175` → **100 ilan ≈ $0.175**.
   Girdi 12.000 karaktere çıkarsa (~3.000 token) ve çıkış 900 token olursa
   yaklaşık **100 ilan ≈ $0.21**. Gerçek maliyet sağlayıcı token sayımıyla
   hesaplanır; bu sayılar yalnızca bütçe planlama örneğidir.
6. Maliyet formülü (yalnızca doğrulanmış fiyatlarla):

   `maliyet = (giriş_token/1e6 × giriş_fiyatı) + (çıkış_token/1e6 × çıkış_fiyatı)`

   Sağlayıcı faturası ile tahmin arasındaki fark ayrıca raporlanır.

## 4. Bilinen sınırlar

- Multimodal/PDF maliyeti ayrı hesaplanır; PDF başına sayfa sınırı vardır.
- Sağlayıcı fiyat sayfası bu depo tarafından **çalışma zamanında** okunmaz;
  operatör doğrular.
- `llm:doctor` çevrimdışı modu sağlayıcı yokken yapılandırma hatası verir; bu
  "model çalışıyor" kanıtı değildir. Canlı doctor bu depoda **NOT RUN**.
- Model sayfası `gemini-3.1-flash-lite` için **structured outputs, caching,
  PDF/görsel/video/ses girdisi ve function calling** destekli olduğunu bildirir.
  Depodaki istemci `generateContent`/OpenAI-uyumlu yolu kullanır; gerçek endpoint
  uyumluluğu canlı smoke testiyle doğrulanmadan "entegre" denmez (bu depoda canlı
  çağrı **NOT RUN**).
- Fiyat sayfası çalışma zamanında kazınmaz; sağlayıcı fiyatı değiştirirse
  operatör güncellemeden canlı çağrı yapılmamalıdır.
- Canlı AI kalitesi, canlı kaynak erişimi ve etiket doğruluğu **ayrı** kanıt
  katmanlarıdır; biri diğerini kanıtlamaz.

## 5. Komutlar

```powershell
# Varsayılan/çevrimdışı: 0 çağrı
npm run llm:doctor -- --offline

# Fiyat/model resmî dokümandan doğrulandıktan SONRA, tek çağrılık smoke
# (bayraklar script'in kendi sözleşmesine göre verilir; önce --help/README okuyun)
npm run llm:doctor -- --live --max-calls=1
```

Bu depoda yukarıdaki canlı komut **çalıştırılmadı**. Sonuç: `NOT RUN`. Fiyat
sayfası 2026-10-19'da yeniden okundu; yine de **fatura yoktur** ve sağlayıcı
kota/fatura verisi doğrulanmamıştır.
