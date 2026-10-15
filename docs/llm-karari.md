# LLM entegrasyonu kararı (ilan sınıflandırması — ingest hattı)

Tarih: 15 Ekim 2026 · Dal: `arena/bca0c7f9-kamuradar` · Durum: **UYGULANDI**

> Önceki sürüm (14 Ekim, PR #13) "ingest'e LLM eklenmedi" kararını belgeliyordu. Bu sürüm o
> kararın yerine geçer: kullanıcı talebi ve ölçülebilir fayda alanı (belirsiz `review` kayıtları)
> netleştiği için LLM kapısı ingest hattına **kanıt doğrulamalı ve fail-safe** biçimde bağlandı.

## 1. Karar

**Deterministik kural motoru tek karar verici olarak kalır.** LLM, yalnızca motorun `review`
(belirsiz) dediği kayıtlarda çalışan bir **ikinci aşama denetim kapısıdır** (`src/ai/classifier.ts`).

- Kesin `accept` / `reject` kararları LLM'e hiç sorulmaz (maliyet ve regresyon riski yok).
- LLM kararı ancak şu üç doğrulamayı birlikte geçerse uygulanır:
  1. **Şema doğrulaması** (zod; tutarlı karar/içerik türü/zorunlu kanıt alanları).
  2. **Birebir kanıt**: modelin gösterdiği alıntı, gönderilen metinde normalize edilmiş alt dizi
     olarak gerçekten geçmeli.
  3. **Deterministik destek kalıbı**: "ilan" için `RECRUITMENT_EVIDENCE_PATTERN`, "süreç" için
     `PROCESS_TITLE_SIGNAL_PATTERN`, "ilan değil" için içerik türüne özgü olumsuz ipucu kalıbı.
     Başlıkta alım kanıtı varken LLM reddi uygulanmaz (insan incelemesi).
- Sağlayıcı hatası, zaman aşımı, geçersiz JSON, doğrulanamayan kanıt → kayıt **incelemede kalır**.
  LLM çalışmazken belirsiz kayıt ASLA otomatik onaylanmaz (yanlış ilan gösterme riski > maliyet).
- Geçerli JSON tek başına doğruluk kanıtı sayılmaz; modelin güven puanı karar garantisi değildir
  (kabul güveni 0.85 ile sınırlanır; deterministik başlık-kanıtlı kabul 0.9+).

### Neden yalnızca `review` yolu?

Kural motorunun kesin kararları PR #13'te kanıt kapılarıyla sertleştirildi ve regressionsuz ölçülüyor
(yanlış kabul oranı etiketli sette %0). LLM'in marjinal faydası belirsiz bölgededir: YÖK tarzı
haberlerin gövdesinde "kadro/istihdam" geçenleri, zayıf başlıklı gerçek alımlardan ayırmak. Bu bölge
aynı zamanda en riskli bölgedir; bu yüzden kanıt doğrulaması + deterministik destek + inceleme
kuyruğu görünürlüğü (panelde "yapay zekâ ön görüşü") birlikte çalışır.

## 2. Sağlayıcı ve model kararı

Mevcut altyapı iki taşıyıcılı bir sohbet istemcisidir (`src/ai/llm.ts`): Google kökü için
birincil `generateContent` API'si, diğer sağlayıcılar için OpenAI uyumlu `/chat/completions`
(panel önerileriyle
ortak). Yeni bağımlılık EKLENMEDİ; sağlayıcı ortam değişkeniyle seçilir.

**Önerilen varsayılan: Groq üzerinde `llama-3.3-70b-versatile`** (`LLM_BASE_URL=https://api.groq.com/openai/v1`).

| Ölçüt | Groq / Llama 3.3 70B | OpenAI mini sınıfı (gpt-4.1-mini vb.) | Yerel model (Ollama) |
|---|---|---|---|
| Türkçe resmî metin | İyi (çok dilli 70B) | İyi–çok iyi | Modele bağlı; 70B sınıfı yerel donanım ister |
| Yapılandırılmış çıktı | JSON mode desteği (OpenAI uyumlu) | Güçlü (structured outputs) | Değişken |
| Fiyat (1M token, girdi/çıktı) | ~$0.59 / $0.79 (üçüncü taraf fiyat izleyicileri, Eki 2026) | ~$0.40 / $1.60 (üçüncü taraf izleyiciler; gpt-4.1-mini için 23 Eki 2026 kapatma iddiası var — doğrulanmadı) | API maliyeti yok; donanım/elektrik/bakım maliyeti var |
| Hız | Çok yüksek (LPU, 500+ tok/s iddiası) | Yüksek | Donanıma bağlı |
| Entegrasyon | Mevcut istemciyle sıfır kod | Mevcut istemciyle sıfır kod | Mevcut istemciyle (`http://localhost:11434/v1`) |
| Veri koşulları | Sağlayıcı DPA'sına tabi | Sağlayıcı DPA'sına tabi (zero-retention seçenekleri) | Veri makineden çıkmaz (KVKK açısından en güçlü) |

**Doğrulama durumu (dürüstlük notu):** Fiyat/hız verileri 15 Ekim 2026'da üçüncü taraf fiyat
izleyicilerinden (aipricing.guru, costbench, pricepertoken) derlenmiştir; bu geliştirme ortamından
sağlayıcı API'lerine canlı erişim YOKTUR (izinli hostlar: github, npm, pypi). Karar öncesi
`npm run test:live` benzeri bir canlı doğrulama ve resmî fiyat sayfası kontrolü kullanıcı ortamında
yapılmalıdır. Model kalitesi etiketli kümeyle ölçülmelidir: `npm run eval:classification -- --llm`.

Neden Groq önerisi: mevcut dokümantasyonda zaten örnek gösterilen sağlayıcı (`AI_PROVIDER_LABEL`
örneği "Groq"), OpenAI uyumlu uç, düşük birim maliyet, yüksek hız (tarama bütçesi içinde kalır).
Karar `LLM_BASE_URL/LLM_CLASSIFIER_MODEL` ile tek satırda değiştirilebilir — sağlayıcı kilidi yok.

### Reddedilen alternatifler

- **Çift model / oylama:** Kanıt doğrulaması zaten bağımsız ikinci görüş görevi görür; ikinci model
  maliyeti ikiye katlar, ölçülmüş faydası yok. Gerekirse `LLM_CLASSIFIER_MODEL` ayrı tutulduğundan
  sonradan denenebilir.
- **Vektör veritabanı / RAG:** Sınıflandırma görevi için benzerlik arama gerekmiyor; mevcut
  tekilleştirme (parmak izi + benzerlik) yeter. Yeni servis = yeni bakım yükü.
- **Yeni kuyruk/mikroservis:** Kapı mevcut tarama hattının içinde, mevcut kilit/bütçe/kota
  düzenekleriyle çalışıyor; ayrı worker gereksiz.
- **Yerel model (varsayılan olarak):** Hedef üretim makinesi Windows; 70B sınıfı model gerçekçi
  değil, küçük modeller Türkçe resmî metinde zayıf. Veri ikametgâhı zorunluluğu doğarsa aynı
  istemciyle Ollama'ya geçilebilir (mimari hazır).

## 3. Maliyet modeli (tahmini)

Tipik çağrı: ~700 token sistem istemi + 1.500–4.000 token duyuru metni + ~200 token çıktı.
Groq fiyatlarıyla çağrı başına ≈ $0.0015–0.003 (kabaca 0,05–0,10 TL). Üst sınır:
`LLM_DAILY_CALL_LIMIT=400` → günde ≈ $0.6–1.2; `LLM_MAX_CALLS_PER_RUN=12` kaynak başına fren.
Önbellek (içerik özeti + model + istem sürümü) tekrar eden içeriği ücretsiz hale getirir; 304
(Not Modified) taramaları zaten kapıya hiç ulaşmaz. Gerçek maliyet kullanıcı panelinde ölçülür:
Yönetici → Genel bakış → LLM kartı (24s çağrı, token, gecikme, hata).

## 4. Güvenlik ve KVKK

- API anahtarı yalnızca sunucu tarafında (worker); log/hata metinlerinde maskelenir (`redactSecret`).
- Duyuru metni **güvenilmez girdi**: `<duyuru>` işaretleri + sistem isteminde açık "iç talimatları
  yok say" kuralı + kanıtta talimat benzeri ifade reddi (`INJECTION_CUE_PATTERN`).
- Gönderim öncesi maskeleme: e-posta, telefon (mevcut `redactContactDetails`) + T.C. kimlik no
  (yeni); metin `LLM_MAX_INPUT_CHARS` (12.000) ile kırpılır.
- Kalıcı telemetriye ham metin YAZILMAZ (yalnızca içerik özeti + kısa kanıt alıntısı + model özeti).
- Üretimde `LLM_BASE_URL` https zorunlu (env doğrulaması). SSRF riski yok: kapı dış URL getirmez,
  yalnızca yapılandırılmış sağlayıcı ucunu çağırır.
- Aday isim listeleri gibi kişisel veriler resmî duyuruda zaten alenidir; yine de sağlayıcı seçimi
  KVKK açısından kullanıcı kararına bırakılmıştır (kapı varsayılan KAPALI, opt-in).

## 5. Ölçüm ve değerlendirme

- `npm run eval:classification` → yalnız kurallar (deterministik, ağ yok).
- `npm run eval:classification -- --llm` → kurallar + kapı (gerçek sağlayıcı çağrısı; etiketli
  kümede `review` kalan kayıtların kaçının çözüldüğünü ve sınıf metriklerini raporlar).
- `npm run llm:review-assist [-- --report r.json]` → mevcut inceleme kuyruğu için KURU ÇALIŞTIRMA
  öneri raporu (ana veritabanına yazmaz).
- Panel telemetrisi: çağrı/önbellek/isabetsiz/hata/gecikme/token (24s + toplam).
- **Eksik:** gerçek etiketli küme (17 kayıt, tamamı sentetik/başlık kaynaklı). Gerçek
  precision/recall iddiası YOKTUR; küme `tests/fixtures/eval/labeled-set.json` içine
  `origin: "real"` kayıtlar eklendikçe rapor gerçekçi hale gelir (ağ erişimli ortamda
  `npm run fixtures:capture` ile ham sayfa yakalanıp elle etiketlenebilir).

## 6. Operasyon

- Açma: `.env` → `LLM_CLASSIFIER_ENABLED=1`, `LLM_BASE_URL`, `LLM_API_KEY`,
  `LLM_CLASSIFIER_MODEL` (ayrıntı: `docs/setup.md` §10).
- Acil kapatma: `LLM_CLASSIFIER_ENABLED=0` + worker yeniden başlat → sistem anında yalnız
  kurallara döner; yayımlanmış ilanlar etkilenmez (kapı kararı sınıflandırma denetim izini
  `classification.llm` içinde saklar, geriye dönük görülebilir).
- İstem/model değişikliği: `LLM_PROMPT_VERSION` (kod sabiti) artırılır → önbellek anahtarları
  değişir → aynı içerik yeni sürümle kontrollü biçimde yeniden değerlendirilir.

## 7. Sağlayıcı hatalarını tanılama (`npm run llm:doctor`)

Belirti: panelde "Yapay zekâ ön görüşü — model denetimine ulaşılamadı / Sağlayıcı
HTTP 404 döndü", LLM ölçümlerinde **%100 hata oranı · 0 token · 0 geçerli kayıt**.
Bu, modelin "kötü" olması değil **yapılandırma** sorunudur: istek hiç bir modele
ulaşmaz, dolayısıyla token da üretilmez. Kararlar kurallarda kalır ve inceleme
kuyruğu insana yığılır.

Tanı komutu (tek gerçek çağrı yapar, veritabanına yazmaz, anahtarı yazdırmaz):

```bash
npm run llm:doctor              # yapılandırma + canlı çağrı
npm run llm:doctor -- --offline # yalnızca yapılandırma (ağ yok)
npm run llm:doctor -- --json    # makine okunur
```

En sık üç kök neden ve karşılığı:

| Belirti | Kök neden | Karşılık |
| --- | --- | --- |
| HTTP 404, ~300 ms, 0 token | İstek, sağlayıcının **sunmadığı** bir sohbet ucuna gidiyor ya da model adı o sağlayıcıda yok | `npm run llm:doctor` taşıyıcıyı ve tam istek adresini yazar; başarısızlıkta sağlayıcının kendi mesajını ve **model listesi denetimini** gösterir. Google için kök `https://generativelanguage.googleapis.com/v1beta` yazılır — istemci birincil API'yi (`POST {kök}/models/{model}:generateContent`) kullanır. OpenAI için `https://api.openai.com/v1`, karma katalog için `https://openrouter.ai/api/v1` |
| HTTP 401/403 | Anahtar geçersiz/süresi dolmuş ya da modele yetkisiz | `LLM_API_KEY`'yi yenileyin; `npm run env:setup` ile tek tek doldurun |
| HTTP 429 / `Zaman aşımı` | Kota ya da ağ | `LLM_DAILY_CALL_LIMIT`, `LLM_MAX_CALLS_PER_RUN`, `LLM_TIMEOUT_MS` ayarları; ağ çıkışı |

Uç/model uyuşmazlığı (ör. OpenAI ucuna `gemini-2.5-flash`) `npm run env:check`
çıktısında da **uyarı** olarak görünür; başlatmayı engellemez çünkü yanlış
pozitif olasılığı vardır — kesin kararı `llm:doctor`'ın canlı çağrısı verir.

### 7.1 Google Gemini taşıyıcısı (2026-10-16 kök neden düzeltmesi)

**Canlı kanıt (kullanıcı makinesi, aynı API anahtarı):**

| İstek | Sonuç |
| --- | --- |
| `GET /v1beta/models` | 200 |
| `GET /v1beta/openai/models` | 200 — `gemini-2.5-flash` listede VAR |
| `POST /v1beta/openai/chat/completions` | **404** |
| `npm run llm:doctor` (eski sürüm) | **404**, 0 token |

Yani anahtar ve model geçerli; sorun **sohbet ucunun kendisinde**. Google'ın
`…/v1beta/openai/…` katmanı birincil API değil, kısmî bir uyumluluk kabuğudur ve
her anahtar/bölge/model kombinasyonu için `chat/completions` sunmaz. Modelin
listede görünmesi sohbet ucunun çalıştığını kanıtlamaz — bu iki uç farklı
yönlendiricilerdir.

**Kalıcı düzeltme:** Google kökü (`generativelanguage.googleapis.com`) artık
birincil API'ye yönlendirilir; kabuğa bağımlılık kalmaz.

| Konu | OpenAI uyumlu (diğer sağlayıcılar) | Gemini yerel |
| --- | --- | --- |
| Uç | `POST {kök}/chat/completions` | `POST {kök}/models/{model}:generateContent` |
| Anahtar | `Authorization: Bearer <anahtar>` | `x-goog-api-key: <anahtar>` (URL sorgusunda ASLA) |
| Sistem mesajı | `messages[0].role = "system"` | `systemInstruction.parts[].text` |
| Roller | `user` / `assistant` | `user` / `model` (ardışık aynı rol tek içerikte birleştirilir) |
| Parametreler | `temperature`, `max_tokens`, `response_format` | `generationConfig.temperature`, `maxOutputTokens`, `responseMimeType: application/json` |
| Model kimliği | olduğu gibi | `models/` ve `google/` önekleri atılır |
| Yanıt metni | `choices[0].message.content` | `candidates[0].content.parts[].text` (parçalar birleştirilir) |
| Token | `usage.prompt_tokens` / `completion_tokens` | `usageMetadata.promptTokenCount` / `candidatesTokenCount` (yoksa `totalTokenCount`) |
| Boş yanıt | "içerik yok" | `finishReason` / `finishMessage` / `promptFeedback.blockReason` gerekçesiyle |

Ortak kalan davranış: aynı `LlmResult` sözleşmesi, aynı zaman aşımı
(`AbortController` + `LLM_TIMEOUT_MS`), aynı yeniden deneme politikası
(429/5xx/zaman aşımı geçici; 400/401/403/404 kalıcı → kota tüketmez), aynı
önbellek/telemetri/kota katmanı, aynı sır politikası (anahtar loglanmaz, hata
metinlerinden ayıklanır). `LlmResult` ve üst katmanlar (`classifier.ts`,
`suggest.ts`, panel) DEĞİŞMEDİ.

Karşılaştırma yapmak gerekirse: `npm run llm:doctor -- --compat` (kabuğu dener)
ve `npm run llm:doctor -- --native` (birincil API'yi zorlar). Doktor başarısız
çağrıda ayrıca **model listesi denetimi** yapar ve "model listede VAR ⇒ sorun
uçta" ya da "model listede YOK ⇒ benzer modeller: …" sonucunu yazar.

Doğrulama sonrası: maliyet satırının panelde görünmesi için
`LLM_COST_USD_PER_MTOK_INPUT` / `LLM_COST_USD_PER_MTOK_OUTPUT` değerlerini
sağlayıcının resmî fiyat sayfasından yazın (boşsa "maliyet raporlanmadı" yazar,
rakam uydurulmaz). Kapı açıldıktan sonra inceleme kuyruğundaki eski kayıtlar
kendiliğinden model denetiminden geçmez; `npm run llm:review-assist` (kuru
çalıştırma) ya da sonraki taramalarda kapının aynı içeriği görmesi beklenir.
