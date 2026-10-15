# LLM entegrasyonu kararı (ilan sınıflandırması ve alan çıkarımı)

Tarih: 15 Ekim 2026 · Dal: `arena/834acf8c-kamuradar`

## Karar

**İlan toplama hattına (ingest) LLM eklenmedi.** Sınıflandırma ve alan çıkarımı deterministik
kurallarla yapılmaya devam eder. Mevcut yapay zekâ özelliği (`src/ai`, yalnızca panelde
kullanıcı profili önerileri, açık rıza ve günlük kota ile) değişmedi.

## Gerekçe

Spesifikasyon, LLM'nin ancak **ölçülebilir fayda** gösterdiğinde eklenmesini ister. Bu ortamda:

1. **Etiketli gerçek ilan kümesi yok.** `tests/fixtures/eval/labeled-set.json` 17 kayıttır; bunların
   tamamı spesifikasyondaki başlıklardır ve gövdeler sentetiktir (`origin: spec-title`). Gerçek
   precision/recall için 150–200 gerçek ilan sayfası ve doğrulanmış etiket gerekir. Bu ortamdan
   Türkiye'deki kamu sitelerine erişilemiyor (izinli hostlar: github, npm, pypi).
2. **Belirsiz kayıtların oranı ölçülmedi.** LLM'nin kazanç alanı yalnızca kural tabanlı sistemin
   `review` ürettiği kayıtlardır. Bu oran gerçek veriyle ölçülmeden maliyet hesaplanamaz.
3. **Sağlayıcı canlı doğrulanmadı.** `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` ile model yanıtı bu
   ortamda test edilmedi.
4. **Kural tabanlı sistemin mevcut hatalarının büyük kısmı LLM gerektirmeyen türdendi:** gövde
   kanıtı olmadan kabul (düzeltildi), paylaşılan kart ve satırda komşu tarihi (düzeltildi), birden
   çok ilde yanlış il ataması (düzeltildi). Bunlar bir modelle değil, kanıt kuralıyla çözüldü.

## Koşullar (LLM ne zaman eklenebilir)

LLM ancak aşağıdakilerin hepsi sağlandığında ingest hattına eklenmelidir:

- En az bir kaynak için **gerçek** etiketli örnek (`origin: real`) ile sınıf bazında precision/recall
  raporu alınmış olmalı (`npm run eval:classification`).
- Kural tabanlı sistemin `review` oranı ve bu kayıtlarda doğru cevap oranı ölçülmüş olmalı.
- Sağlayıcının veri saklama ve aktarım koşulları belgelenmiş ve hukuki inceleme yapılmış olmalı
  (KVKK). Kişisel profil verisi ilan çıkarımına **gönderilmemelidir**.
- Önbellek anahtarı içerik özeti + istem sürümü + karar sürümüyle tanımlanmalı.
- Zaman aşımı, hız sınırı, kota ve sağlayıcı hatasında güvenli kurallara dönüş test edilmiş olmalı.

## Mevcut AI kapsamı (değişmedi)

- `src/ai/suggest.ts` ve `src/server/routes/ai.ts`: yalnızca panelde, kullanıcının açık rızasıyla
  (`aiConsentAt`), günlük kota ile (`AI_DAILY_LIMIT_PER_USER`, varsayılan 5) çalışır.
- Varsayılan kapalıdır (`AI_ASSISTANT_ENABLED=0`). Üretimde `LLM_BASE_URL` `https://` olmalıdır.
- Çıktı "ön eleme" olarak sunulur; kesin uygunluk kararı değildir.

## Ölçüm aracı

`npm run eval:classification` etiketli kümeyi çalıştırır ve şunları raporlar: sınıf bazında
precision/recall, yanlış ilan kabulü oranı, yanlış ret oranı. Gerçek örnek yoksa uyarı verir ve
oranları "ölçülemedi" olarak gösterir; tahmini yüzde üretmez.
