# 11 — Yapay Zekâ Maliyeti/Sağlamlığı + Güvenlik ve KVKK

İki bölüm: **(A)** LLM'in gerçekten nasıl sınırlandığı, **(B)** güvenlik ve KVKK durumu.
Kanıt dosyaları her satırda. Gizli değer **yazılmadı**; yalnızca değişken adları var.

---

## A. LLM: maliyet, sağlamlık, güvenlik

### A1. Varsayılan: KAPALI

| Kapı | Varsayılan | Kanıt |
| --- | --- | --- |
| Kullanıcıya açık asistan | `AI_ASSISTANT_ENABLED=0` | `.env.example` |
| Sınıflandırma kapısı | `LLM_CLASSIFIER_ENABLED=0` | `.env.example` |
| Yapılandırma | `LLM_BASE_URL` + `LLM_API_KEY` + model yoksa **kapı oluşmaz** | `src/ai/classifier.ts` |

**Ölçüm:** `verify:all` → **LLM doctor çağrısı: 0**. Bu denetimde hiçbir ücretli çağrı yapılmadı.

### A2. Gerçek sınırlar (env ile ayarlanır)

| Sınır | Varsayılan | Ne yapıyor |
| --- | --- | --- |
| `LLM_TIMEOUT_MS` | **30.000** | İstek iptali (`AbortController`) |
| `LLM_MAX_CALLS_PER_RUN` | **12** | Bir tarama koşumunda en fazla çağrı; 0 → kapı hiç kurulmaz |
| `LLM_DAILY_CALL_LIMIT` | **400** | Günlük atomik sayaç |
| `LLM_MAX_CONCURRENCY` | **2** | Eşzamanlı istek semaforu |
| `LLM_RETRY_MAX` | **1** | En fazla 1 yeniden deneme (kodda üst sınır 3) |
| `LLM_MAX_INPUT_CHARS` | **12.000** | Girdi kırpma |
| `LLM_COST_USD_PER_MTOK_INPUT/OUTPUT` | **boş** | **Fiyat tanımlı değilse çağrı yapılmaz** (`pricing-unavailable`) |
| `LLM_RUN_COST_LIMIT_USD` / `LLM_DAILY_COST_LIMIT_USD` | boş | Maliyet tavanı; mikro-USD tamsayı ile atomik rezervasyon |

> **Fiyat uydurulmadı.** Dokümanda tek bir model fiyatı yok; fiyat yalnızca ortam
> değişkeninden gelir. Fiyat yoksa sistem **daha güvenli** davranıp çağrı yapmıyor.

### A3. LLM asla tek başına yayımlayamaz

1. **Yalnızca `review` kayıtlarında** çalışır. Deterministik kabul/ret **değişmez**
   (`jobs-service.ts`: `classification.decision === 'review'`).
2. **Kabul** için: kanıt metni **kaynakta birebir** geçmeli **ve** deterministik alım
   kalıbıyla eşleşmeli. Aksi hâlde karar uygulanmaz, kayıt `review`'da kalır.
3. **Ret** için: ayırt edici olumsuz kalıp gerekir; `other` türünde otomatik ret **yoktur**;
   başlıkta alım ifadesi varsa LLM reddi **uygulanmaz** (insan kararı).
4. **Güven tavanı:** LLM kabulü `0.85` ile sınırlandırılır — deterministik kabullerden bilinçli
   olarak düşük.
5. **Hata/yedeğe düşme:** zaman aşımı, 429, bozuk JSON, şema dışı yanıt → deterministik
   sonuç korunur (`tests/senaryo-panel-oneri.test.ts`: "model zaman aşımına uğrarsa yedek
   sonuç döner ve deneme kotadan düşülür").

### A4. Prompt injection savunması

| Savunma | Kanıt |
| --- | --- |
| İlan metni **veri** olarak JSON içinde gönderilir; talimatlar sistem mesajında | `src/ai/prompt.ts` |
| Kanıt alanları "talimat benzeri" ifade içeriyorsa **reddedilir** | `evidenceLooksLikeInjection` |
| Kanıt, kaynakta birebir bulunmazsa kabul yok | `evidenceAppearsIn` |
| Kişisel veri maskelenir (e-posta/telefon/TC) | `prepareTextForLlm`, `redactContactDetails` |
| Modelin araç/komut çağırma yetkisi yok (salt JSON çıktısı) | `src/ai/llm.ts` |
| Çıktı şeması doğrulanır; kod çiti/JSON gömme ayıklanır | `extractJsonPayload` + şema |

### A5. Ölçülmeyenler (dürüst)

- **Gerçek model kalitesi ölçülmedi** (anahtar yok → 0 çağrı). "LLM şu kadar isabetli" iddiası **yok**.
- **Gerçek maliyet ölçülmedi**; model fiyatı env'e girilmeden çağrı yapılmıyor.
- Sağlayıcı kesintisi/kuyruk davranışı yalnızca taklit testlerle doğrulandı.

---

## B. Güvenlik

### B1. Uygulama katmanı — kanıtlı durum

| Konu | Durum | Kanıt |
| --- | --- | --- |
| Parola | **scrypt**; olmayan hesapta da maliyet ödenir (kullanıcı numaralandırma yok) | `src/server/passwords.ts`, `routes/auth.ts` |
| Oturum | `HttpOnly` + `SameSite=Lax`; jeton **yalnızca SHA-256 özeti** olarak saklanır | aynı |
| CSRF | Double-submit + sabit zamanlı karşılaştırma; muafiyet yalnızca oturumsuz uçlar | `src/server/app.ts` |
| Yetki | Tüm `/api/admin/*` uçları `requireAdmin`; yüzde kodlu yol kaçışı test edilmiş | `tests/guvenlik-yetki-regresyon.test.ts` |
| Hız sınırı | Kimlik POST'ları ayrı (sıkı) kova, diğerleri genel kova | `src/server/app.ts` |
| SSRF | Host allowlist + **tüm DNS cevapları** genel-yönlendirilebilirlik denetimi + elle yönlendirme | `src/sources/network-safety.ts`, `fetcher.ts` |
| XSS | `dangerouslySetInnerHTML` **yok**; dış URL'ler `isHttpUrl` ile süzülür | kod aramasında 0 sonuç |
| CSP/başlıklar | `default-src 'self'`, `frame-ancestors 'none'` vb. | ölçüldü (`curl -I`) |
| Sırlar | Depoda gerçek anahtar yok; `.env` gitignore'da; loglarda maskeleme | kod + `.gitignore` |
| Vekil IP | İstemci `x-forwarded-for` taşıyamaz; yalnızca `cf-connecting-ip` | **bu denetimde düzeltildi** |
| Bağımlılık | `npm audit` → 0 bilinen açık (402 paket) | 21.10.2026 |

### B2. Açık kalan güvenlik riskleri (kapatılmadı)

| Risk | Neden açık | Kapatma |
| --- | --- | --- |
| **RLS yok**, tek DB kimliği (R-02) | Üretim DB'sine dokunmak izin gerektirir | Ayrı DB rolü + RLS + yetkisiz `SELECT` testi |
| `TRUST_PROXY` yanlış yapılandırılırsa IP sahteciliği geri gelir (R-09) | Yapılandırma doğrulaması üretimde yapılmadı | Dağıtım denetim listesi + üretim testi |
| Hız sınırı sayacı DB'de (R-11) | Mimari tercih; atomiklik ölçülmedi [4] | Redis/bellek içi kova |
| Otomasyon yok | `npm audit` CI'da değil (R-15) | Haftalık CI adımı |
| Üretim sağlığı doğrulanmadı (R-08) | Erişim yok | Sahada doğrulama |

### B3. KVKK / veri koruma

| Yükümlülük alanı | Sistemde ne var | Durum |
| --- | --- | --- |
| **Veri minimizasyonu** | LLM'e ad/e-posta/TC/telefon **gönderilmez**; ilan metni maskelenir | ✅ kanıtlı |
| **Açık rıza** | AI asistanı için `consent` kaydı; rıza yoksa çalışmaz | ✅ |
| **Silme hakkı** | `/api/auth/delete-account`; oturum/veri temizliği | ✅ (uçtan uca prova yapılmadı) |
| **Saklama süresi** | Oturumlar/rate-limit 7 gün, LLM telemetrisi **90 gün**, sonra otomatik silme | ✅ |
| **Şeffaflık** | Gizlilik/KVKK metinleri, çerez politikası, "kaynak + son kontrol" gösterimi | ✅ |
| **Erişim kaydı** | `auditLogs` (yönetici işlemleri) | ✅ |
| **Yatay yetki** | Uygulama katmanında var; **DB katmanında yok** | ⚠️ R-02 |
| **Silme provası** | Yapılmadı (gerçek veri gerekir) | ⚠️ izin gerekir |
| **DPIA / veri envanteri belgesi** | `docs/security-kvkk.md` var; resmî DPIA yok | ⚠️ hukuk/ürün işi |

### B4. Bu denetimde güvenlikte değişenler

1. `/api/auth/unsubscribe` CSRF muafiyeti kaldırıldı → zorla çıkış yüzeyi kapandı.
2. Vekilde istemci IP sahteciliği kapatıldı → hız sınırı ve denetim kaydı güvenilir.
3. Hiçbir güvenlik seviyesi **düşürülmedi**; hiçbir gizli değer okunmadı/yazdırılmadı.
