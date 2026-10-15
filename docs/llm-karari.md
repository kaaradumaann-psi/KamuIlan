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

Mevcut altyapı OpenAI uyumlu `/chat/completions` istemcisidir (`src/ai/llm.ts`; panel önerileriyle
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
