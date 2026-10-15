# Kamuİlan — sistem mimari ve uygunluk raporu (yapay zekâ destekli 5 aşamalı yaklaşımın değerlendirmesi)

**Tarih:** 15 Ekim 2026 (Europe/Istanbul)
**Depo:** `kaaradumaann-psi/kamuradar`
**Dal:** `arena/834acf8c-kamuradar` (uzak HEAD `c011100`)
**Açık PR:** #13 (birleştirilmedi)
**Hedef okuyucu:** Bu raporu başka bir yapay zekâ veya mühendis okuyup sistemi, mevcut durumu ve önerilen değişiklikleri anlayacak.
**Kapsam:** Kod (`src/`, `scripts/`, `tests/`), dokümanlar (`docs/`, `README.md`), kaynak envanteri, bildirim ve yapay zekâ akışları. Canlı ağ erişimi bu ortamda yoktur; canlı davranışla ilgili iddialar ya kod/test ya da kullanıcının daha önce paylaştığı canlı koşum sonuçlarına dayanır ve bu ayrım metinde belirtilmiştir.

> Bu raporda hiçbir `.env` değeri, anahtar, token veya kişisel veri yoktur. Ortam değişkenleri yalnızca **ad** düzeyinde anılır.

---

## 0. Bu raporu nasıl okumalısınız

1. §1 sistemin ne olduğunu ve neyi yapmadığını söyler.
2. §2–§3 mimariyi ve veri akışını verir.
3. §4 yapay zekânın **tam olarak nerede** kullanıldığını envanter olarak verir. Bu, değerlendirmenin temelidir.
4. §5–§9 her aşamanın (bulma, çıkarım, tekilleştirme, doğrulama, bildirim) mevcut durumunu kanıtlarıyla anlatır.
5. §10 kullanıcının önerdiği beş aşamalı yaklaşımı mevcut sistemle karşılaştırır ve **hüküm** verir.
6. §11 bilinen hata ve boşlukları önceliklendirir. §12 önerilen yol haritasıdır. §13 açık işler ve sahiplerini listeler.

---

## 1. Sistemin tanımı

Kamuİlan, Türkiye'deki kamu personel alım ilanlarını **resmî kaynaklardan** toplayan, sınıflandıran, alanlarını yapılandırılmış biçimde çıkaran, tekilleştiren ve kullanıcı tercihlerine göre e-posta/Telegram ile bildiren tek bir Node.js/TypeScript paketidir (`package.json`, `name: kamuilan`).

**Yapmadıkları (kasıtlı):**
- Tüm kamu ilanlarını kapsadığını iddia etmez. Kaynak envanteri sınırlıdır (§8).
- Uydurma alan üretmez. Metinden çıkarılamayan alan `null` kalır ve arayüzde "belirtilmemiş" görünür (`docs/architecture.md`, "Uydurma yok").
- Yapay zekâyı tarama, sınıflandırma, tekilleştirme veya bildirim kararlarında kullanmaz (§4).
- Kişisel başvuru yapmaz; resmî ilan bağlantısına yönlendirir.
- CAPTCHA, oturum duvarı veya coğrafi kısıtı aşmaya çalışmaz (`docs/limitations.md`).

**Kullanıcılar:** Hesabı olan kişiler. Profil (unvan, eğitim, bölüm, beceri, deneyim), bildirim filtreleri (unvan, kurum, il, çalışma biçimi, öğrenim, bölüm, KPSS puan türü ve taban puanı, son başvuruya kalan gün) ve kanal (e-posta, Telegram) tanımlar.

**Yöneticiler:** Kaynak yönetimi, inceleme kuyruğu, yeniden sınıflandırma, bildirim kuyruğu (ölü mektup), denetim kaydı.

---

## 2. Mimari (katmanlar ve dosya haritası)

Tek paket, mikroservis yok. API, worker ve arayüz aynı kod tabanını paylaşır.

```
src/
  config/        ortam değişkenleri (zod ile doğrulanır), kaynak envanteri (src/config/sources.ts), uygulama sabitleri (app.ts)
  domain/        saf alan mantığı: metin normalizasyonu, Türkçe tarih ayrıştırma (dates.ts), iller, tipler, kimlik
  db/            depolama soyutlaması (dosya / Postgres(Supabase) / Mongo), şemalar (schemas.ts, zod), indeksler, repolar
  sources/       kaynak adaptörleri (8 aile), HTTP istemcisi (fetcher.ts: SSRF koruması, ETag, hız sınırı, yeniden deneme, boyut sınırı),
                 kayıt defteri (registry.ts), sayfalama (pagination.ts), tarayıcı oturumu (browser-session.ts)
  extraction/    PDF metin çıkarımı (pdf.ts, pdfjs-dist; OCR YOK) ve kural tabanlı alan çıkarımı (engine.ts, dictionaries.ts)
  classification/ deterministik kural motoru (engine.ts + rules.ts): accept / reject / review ve kind: job | process
  ingest/        kabul hattı: sanitize.ts, jobs-service.ts (applyRawAnnouncement), dedupe.ts (saf), pipeline.ts (tarama orkestrasyonu),
                 reclassify*.ts (yeniden sınıflandırma, yedekli)
  notifications/ tercih eşleştirme (matcher.ts, saf) + olay/outbox üretimi (service.ts)
  email/         taşıyıcılar (Resend HTTP, SMTP, dosya), TR şablonları (templates.ts), gönderim servisi
  telegram/      istemci (client.ts), bot komutları (bot.ts), biçimlendirme (format.ts), teslim (deliver.ts), yapılandırma (config.ts)
  ai/            profil bazlı öneri: candidates.ts (aday seçimi, ağsız), prompt.ts (istem), llm.ts (OpenAI uyumlu istemci), suggest.ts (orkestratör, doğrulama, önbellek, kota)
  worker/        kalıcı kuyruk (queue.ts: BullMQ ya da veritabanı kuyruğu), zamanlayıcı (scheduler.ts), çalışma zamanı (runtime.ts), giriş (main.ts)
  server/        Fastify API: routes/ (jobs, auth, admin, ai, telegram, notifications, sources…), serializers.ts (genel tipler)
  pages/, components/, lib/, styles/   React arayüzü (Vite)
scripts/         operasyon betikleri (migrate, reclassify-jobs, restore-jobs-backup, telegram-webhook, live-check, coverage-report…)
tests/           vitest (son koşumda 55 test dosyası, 660 test)
e2e/             Playwright (smoke + kaynak kapsamı)
docs/            mimari, veri modeli, kaynaklar, işletim, güvenlik/KVKK, denetim ve mühendislik raporları
```

**Önemli değişmezler (kodda ve dokümanda tutarlı):**
- Karar yolu deterministiktir: sınıflandırma, çıkarım, tekilleştirme ve bildirim eşleştirmesi ağ çağrısı yapmaz.
- Veritabanı ve kuyruk: dosya deposu (geliştirme), Supabase Postgres (üretim, JSONB tablo başına koleksiyon), MongoDB (alternatif). BullMQ yalnız `REDIS_URL` varsa.
- Zamanlama veritabanında tutulur (`scheduledTasks`). Worker yeniden başlasa da kaldığı yerden devam eder; kaynak başına kilit (`locks`) çift taramayı engeller.
- Kaynak envanteri veridedir (`sources` koleksiyonu), kod değildir; başlangıç envanteri `src/config/sources.ts`'tir.
- Süreç duyuruları (kura, sınav, sonuç) `kind: 'process'` ile ayrılır; akışta görünür, bildirim üretmez.

---

## 3. Uçtan uca veri akışı (mevcut)

1. **Zamanlama.** Worker `scheduledTasks` tablosunu okur; vadesi gelen kaynak için kuyruğa iş yazar. Sistem görevleri: `deadline-refresh` (30 dk), `maintenance` (60 dk), `coverage-audit`. Kaynak aralıkları `SCHEDULER_DEFAULTS` içinde: hızlı kaynaklar 60 dk, kurumsal sayfalar 180 dk, keşif günlük. Kaçırılan çalışma (`maxCatchUpMinutes`) `misses` olarak sayılır.
2. **Tarama (`runSourceScrape`, `src/ingest/pipeline.ts`).**
   - Kilit alınır (`scrape:<key>`, TTL = zaman aşımı + 90 sn). Alınamazsa `locked`.
   - Adaptör çalışır (`resolveAdapterSource` → `requireAdapter`). Daha önce görülmüş kimlikler (`loadKnownItemIds`, 5000 kayıt sınırı) ve ayrıntısı alınmış kimlikler (`loadKnownItemIdsWithDetail`) yüklenir.
   - Liste öğeleri için ayrıntı indirme bütçesi: `html-list` 8, `pdf-index` 25, `browser` 5 (`detailFetchBudget`). Fazlası ertelenir ve sonraki koşumlarda tamamlanır.
   - HTTP istemcisi ETag/Last-Modified ile değişmemiş içeriği atlar (`skipped`).
3. **Ön işleme.** `sanitizeRawAnnouncement` ham kaydı temizler.
4. **Sınıflandırma (`classify`).** Başlık ve gövde kuralları. Sonuç: `accept` / `reject` / `review` ve `kind` (`job` | `process`). Belirsiz kayıt silinmez; `review` olur.
5. **Çıkarım (`extract`).** Kurum, birim, çalışma biçimi, il/ilçe, kontenjan, başvuru penceresi, yayım tarihi, başvuru bağlantısı ve yöntemi, referans no, unvan, öğrenim, bölüm, KPSS türü ve taban puanı, yaş, deneyim, sertifika, yabancı dil, özel şartlar. Her alan `fieldSources` (`listing` / `detail` / `document` / `link` / `unstated`) ve kanıt parçasıyla saklanır. Liste kaynaklı alan detay metninden önceliklidir; çelişki `uncertainties`'e yazılır.
6. **Tekilleştirme (`decideDedupe`, `src/ingest/dedupe.ts`).** Sıra: kaynak içi kimlik → resmî ilan no → normalize URL → kurum+unvan+dönem+benzerlik. Eşikler: birleştirme başlık benzerliği 0.86; inceleme 0.70–0.86; metin benzerliği birleştirme 0.72; "aynı ilan" metin eşiği 0.45. Benzer başlıklı farklı ilanlar **otomatik birleşmez**, `review` olur.
7. **Kayıt ve sürüm (`applyRawAnnouncement`, `jobs-service.ts`).** `jobs`, `jobSources`, `jobRevisions`. İçerik özeti değişirse yeni sürüm; `detectChanges` değişiklik sınıfını belirler. `computeStatus` durum üretir (bkz. §6.3).
8. **Bildirim olayı (`queueNotificationsForJob`).** Süreç kayıtları burada çıkar. Diğerleri her tercih için `matchPreferenceToJob` ile eşleşir; eşleşen için `notificationEvents` (idempotent anahtar) ve `emailOutbox` kaydı oluşur.
9. **Gönderim (worker).** Outbox lease ile talep edilir; taşıyıcı çağrılır; sağlayıcı kabulü kaydedilir (teslim garantisi iddia edilmez); üstel geri çekilme; sınır dolunca `dead`. Telegram teslimi ayrı modülde (`src/telegram/deliver.ts`); bu raporda ayrıntısı incelenmedi, yalnızca varlığı doğrulandı.
10. **Tarama kaydı.** `scrapeRuns` (sayılar, `coverageStatus` = `complete` / `partial` / `unknown`, hatalar), kaynak sağlığı (`health`).

---

## 4. Yapay zekânın tam envanteri (en kritik bölüm)

Kod taramasıyla doğrulandı (`grep` ile `callChatCompletion` ve `src/ai` içe aktarımları):

| Kullanım | Dosya | Tetikleyici | Model çağrısı? | Not |
|---|---|---|---|---|
| Profil bazlı ilan önerisi | `src/ai/suggest.ts`, `src/server/routes/ai.ts` | Kullanıcı panelde "öneri" ister (`POST /api/ai/suggestions`) | **Evet** (en fazla 1 çağrı/istek) | Açık rıza (`aiConsentAt`) zorunlu; yoksa 403 |
| İstem ve veri minimizasyonu | `src/ai/prompt.ts`, `src/ai/candidates.ts` | Yukarıdakinin parçası | — | Ad, e-posta, TC, parola, bildirim kanalı gönderilmez |
| Tarama, çıkarım, sınıflandırma | `src/extraction`, `src/classification` | Her tarama | **Hayır** | Tamamen kural tabanlı |
| Tekilleştirme | `src/ingest/dedupe.ts` | Her kayıt | **Hayır** | Saf fonksiyonlar, eşikler |
| Doğrulama (tarih guard, çelişki) | `src/domain/dates.ts`, `jobs-service.ts` | Her kayıt | **Hayır** | Kurallar |
| Bildirim eşleştirme | `src/notifications/matcher.ts` | Her yeni/değişmiş ilan × her tercih | **Hayır** | Saf fonksiyon |
| Telegram/e-posta biçimleme | `src/telegram/format.ts`, `src/email/templates.ts` | Gönderim | **Hayır** | Şablon |

**Sonuç:** Mevcut sistemde yapay zekâ yalnızca **kullanıcı talebiyle, kullanıcının profiliyle, kural tabanlı bir aday kümesi üzerinde** çalışır. Tarama döngüsünde, veri hattında ve bildirimde hiçbir model çağrısı yoktur. Bu, kullanıcının "sürekli tarama yüzünden token tüketilmez" hedefini zaten sağlar.

**Yapay zekâ öneri akışının güvenlik ve maliyet kontrolleri** (`suggest.ts`, `candidates.ts`, `env.ts`, `llm.ts`):
- Aday havuzu 150 açık ilan; modele en çok 12 aday gider; en çok 6 öneri döner (`MAX_CANDIDATES`, `CANDIDATE_POOL_SIZE`).
- Model çıktısı zod ile doğrulanır; yalnızca aday kümesindeki `jobId` kabul edilir; uydurma kimlik atılır; biçim bozuksa **deterministik profil eşleştirmesi** gösterilir (boş ekran yok).
- Günlük kota kişi başına (`AI_DAILY_LIMIT_PER_USER`, varsayılan **5**); kalıcı sayaç `rateLimits` deposunda. Kota dolunca model çağrılmaz.
- Önbellek süreç belleğinde 20 dakika; kalıcı değildir; birden fazla süreçte paylaşılmaz (dokümanlanmış sınır).
- Zaman aşımı `LLM_TIMEOUT_MS` (varsayılan 30 sn, 5–120 sn aralığında); `temperature` 0.2; `max_tokens` 1200; yanıt en çok 64 000 karakter.
- Ham istem ve yanıt loglanmaz; API anahtarı hata metinlerinden ayıklanır.
- Üretimde `LLM_BASE_URL` `https://` ile başlamalıdır (`env.ts` doğrulaması).
- Özellik varsayılan **kapalıdır** (`AI_ASSISTANT_ENABLED=0`).

Ortam değişkeni adları (değerler bu raporda yok): `AI_ASSISTANT_ENABLED`, `AI_PROVIDER_LABEL`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_TIMEOUT_MS`, `AI_DAILY_LIMIT_PER_USER`.

---

## 5. Aşama 1 — İlanları bulma (kod)

**Mevcut durum: Kod tabanlıdır ve kullanıcının önerisiyle uyumludur.**

- Kaynak sayısı: `src/config/sources.ts` içinde **28 tanım**; **24 etkin**, **4 devre dışı/manuel** (`iskur-esube-acik-is`, `gib-duyurular`, `tuik-duyurular`, `rtuk-duyurular`). Statüler: `verified` 15, `scraper-built` 9, `needs-manual-method` 4.
  - **Doküman sapması:** `docs/sources.md` "27 kayıt, 23 etkin ve verified" diyor. Kod bunu karşılamıyor. Dokümanın güncellenmesi gerekir; bu raporda kod esas alınmıştır.
- Adaptör dosyaları (`src/sources/adapters/`) ve kayıtlı anahtarlar (`src/sources/registry.ts`, kaynak tanımındaki `adapterKey`): `anchor-list.ts` → `iskur-ilan-listesi`, `kurum-duyuru-listesi`, `meb-duyuru-listesi`; `resmigazete.ts` → `resmigazete-cestili`; `ilan-gov-tr.ts` → `ilan-gov-tr`; `ilan-gov-tr-api.ts` → `ilan-gov-tr-api`; `osym.ts` → `osym-duyuru`; `sbb-kamuilan.ts` → `sbb-kamuilan`; `kariyerkapisi.ts` → `kariyer-kapisi-isealim`; `manual-entry.ts` → `manual-entry`. Sayfalama kontrolü `src/sources/pagination.ts` içindeki `detectNextPage` ile yapılır; `anchor-list` (İŞKUR, MEB, kurum sayfaları), `osym` ve `resmigazete` bunu kullanır. `ilan-gov-tr` sayfalama kullanmaz.
- Sayfalama: ilan.gov.tr 20 sayfa; diğer listeler 10 sayfa; Resmî Gazete gün başına 10 sayfa. Sınır aşılırsa kapsam `partial` (sessiz kırpma yok).
- Boş yanıt politikası: yalnızca açık, tanınan "sonuç yok" ifadesi veya geçerli ama öğesiz RSS, `unknown` kapsamla **boş başarı** sayılır; tanınmayan yapı hata verir.
- HTTP güvenliği: SSRF koruması (`network-safety.ts`), `allowHosts`, ETag/Last-Modified, boyut sınırı.
- Eksikler (kanıtlı):
  - Kaynakların bir kısmında canlı selector hatası (§8).
  - Kariyer Kapısı "verified" işaretli ama kullanıcının canlı koşumunda 0 öğe döndü.
  - Resmî Gazete ve ilan.gov.tr için TLS zinciri sorunları (Windows; §8).

**Yapay zekâ ile iyileştirme potansiyeli:** Adaptörlerin bozulduğu selector hatalarında bir LLM **yardımcı** olabilir (HTML'den yapı önerisi), ama tarama döngüsüne alınmamalıdır (bkz. §10.2 ve §12).

---

## 6. Aşama 2 — İlanı anlama (çıkarım ve sınıflandırma)

### 6.1 Mevcut yöntem
- **Sınıflandırma:** `src/classification/rules.ts` ve `engine.ts`. Başlık ret kuralları (`ret-baslik.*`), gövde ret kuralları (`ret-govde.*`: ihale, mal/hizmet alımı, yargı, öğrenci vb.), pozitif kanıtlar (`pozitif.*`), süreç kuralları (`süreç.*`). Karar `accept` / `reject` / `review`; tür `job` / `process`. Her karar gerekçe, kural kimliği ve sürüm taşır.
- **Çıkarım:** `src/extraction/engine.ts` (1256 satır) ve `dictionaries.ts` (illeri, unvanları, bölümleri, KPSS türlerini, sertifikaları ve başvuru sitelerini içerir). Her alan için kaynak ve kanıt; belirsizlik listesi.
- **PDF:** `pdfjs-dist` ile metin katmanı çıkarılır. **OCR yoktur.** Taranmış PDF'de metin yoktur; kayıt "metin katmanı yok" notuyla incelemeye düşer (`docs/limitations.md`).

### 6.2 Bilinen sınırlar (kanıtlı)
- **Menü/şablon metni kirliliği:** TMSF "TMSF Personel Alım İlanı 2026", KGM "50 İşçi Personel Alımı Hk." ve "Erzurum … 1 Engelli İşçi" kayıtlarının gövdesi site gezinme metniyle başlıyor. Geniş bir temizleme kuralı, örnek metin olmadan eklenmedi (kullanıcı kuralı). **Bu, kural tabanlı çıkarımın bilinen bir sınırıdır ve LLM'in en doğal kullanım alanlarından biridir**, fakat yalnızca §12'de önerilen ölçüm sonrasında.
- **Ortak başlık kuralı çekim sorunu:** `titleHasRecruitmentCue` içindeki `\b` sınırı "Alımı" gibi çekimli biçimleri yakalamıyor. Yeni D dalında ayrı bir kontrol kullanıldı; ortak kural değiştirilmedi. Bu, hangi diğer kayıtları etkilediği belirlenmemiş bir teknik borçtur.
- **Anlamsal ayrım:** "Sonuç" kelimesi süreç (sonuç ilanı) ile iş ilanını (sonuç değil başvuru) ayırmada zorlanır. D kararı bu yüzden **dar** bir gövde kuralıyla çözüldü; genel "sonuç" kuralı bilinçli olarak yoktur (deneyle yanlış pozitif görüldü: "Yer Değiştirme Sonuçları").
- **Gerçek gövde ile doğrulanmamış iki karar:** C (Muhasebe yeterlik) ve D (Adalet "Başvuru Sonuçları") kararları sentetik gövdelerle test edildi; gerçek gövdeler bu ortamda yok.

### 6.3 Durum hesabı (`computeStatus`)
- Bitiş tarihi (saat dahil) geçmişse `closed`.
- Bitiş tarihi yoksa ve yayım tarihi çok eskiyse (`isStalePublication`) `closed`.
- Bitiş tarihi yoksa `unknown` (eskiden başlangıcı geçmiş kayıtlar `active` alıyordu; düzeltildi).
- Aksi halde `active` / `upcoming`. Bu, "tarihi bilinmeyen kayıt başvuru açık sayılmaz" kuralıdır.

### 6.4 Yapay zekâ ile iyileştirme: değerlendirme
Kural tabanlı sistem **ölçülebilir ve tekrar üretilebilir**dir, ama kapsamı dar kalır (menü metni, anlamsal süreç ayrımı, PDF yapıları). LLM tabanlı çıkarım bu boşlukları kapatabilir; ancak aşağıdaki koşullar olmadan kullanılmamalıdır (§10.2 ayrıntılı):
1. **Kanıt zorunluluğu:** Modelin döndürdüğü her değer kaynak metinde **birebir** geçen bir alt dizgiye bağlanmalı; kod bunu doğrulamalı, doğrulanmayan değer `null` olmalı.
2. **Yalnız belirsizlikte:** Kural alanı dolduruyorsa veya kayıt kesin ise model çağrılmamalı.
3. **Ölçüm:** Etiketli bir altın küme (en az ~200 ilan) üzerinde kural ile modelin kesinlik/duyarlılık değerleri karşılaştırılmadan üretime alınmamalı.
4. **Sürümleme:** Sonuçlar `(kaynak, sourceItemId, contentHash, EXTRACTION_VERSION)` anahtarıyla kalıcı önbelleğe alınmalı; aynı içerik bir daha modele gitmemeli.
5. **Güvenlik:** İlan metni güvenilmez girdidir (istem enjeksiyonu). Mevcut `prompt.ts` yaklaşımı (talimatları yok say, JSON şeması zorunlu) burada da uygulanmalı; modelin çıktısı yalnızca veri olarak işlenmelidir.

---

## 7. Aşama 3 — Tekilleştirme

**Mevcut durum: Kod tabanlı ve kullanıcının önerisine büyük ölçüde uygun.**

- Kaynak içi kimlik (`sourceKey + sourceItemId`) → `dedupeKey` benzersiz indeksi (`sha256(sourceKey|sourceItemId)`).
- Resmî ilan no ve normalize URL → otomatik birleşme (skor 0.99 ve benzeri).
- Kurum+unvan+dönem+benzerlik → eşik aralığında **inceleme kuyruğu** (`reviewQueue`, `kind: 'dedupe'`), otomatik birleşme yok.
- Birleşmede `jobSources` ve sürüm geçmişi korunur; değişiklik sınıfı `merged`.
- Yönetici kararı birleştirme için son adımdır.

**Önerilen yapay zekâ kullanımı (kullanıcının önerisi, değerlendirme):** "Emin olunamayan durumlarda yapay zekâ karar vermeye yardımcı olur" ifadesi **yalnızca danışmanlık** olarak kabul edilmelidir: model, inceleme kuyruğundaki iki ilanın benzer olup olmadığını **öneri** olarak yazar; **otomatik birleştirme yapmaz**. Mevcut mimari bunu zaten ilke olarak koyar ("benzer başlıklı farklı ilanlar otomatik birleştirilmez"). Bu nedenle model yalnız `review` bandındaki (0.70–0.86) çiftler için çağrılmalıdır; ret/kabul kesin olan çiftlerde çağrı yapılmamalıdır.

---

## 8. Aşama 4 — Doğrulama

### 8.1 Mevcut doğrulama
- **Tarih guard'ı:** `src/domain/dates.ts` ve `extraction/engine.ts` yayım tarihinden önce olan veya makul aralık dışında (ör. 1991) bitiş tarihlerini reddeder (gerçek kayıtlarda Adalet 2025-12-20, MEB 2026-09-14 ve Savunma/Özelleştirme 1991 hataları görüldü; reclassify bunları temizler).
- **Sağlık ve kapsam:** `scrapeRuns` kapsam durumu, kaynak `health` (`consecutiveFailures`, `lastSuccessAt`), `coverage-audit` görevi.
- **Kaynak doğrulaması:** `verification.verified` yalnızca tarihli canlı kanıtla `true`. **Ancak bu bir tarihsel kanıttır, bugünkü erişim garantisi değildir** (`docs/sources.md`).
- **Değişiklik takibi:** `detectChanges` ile son tarih, şart, kontenjan, kapanış, başvuru bağlantısı, geri çekilme gibi değişiklikler.

### 8.2 Boşluk: kanıtlanan "verified" sapması
Kullanıcının daha önce paylaştığı canlı koşum (`test:live`, 14 Ekim 2026, Windows) 24 hedeften 10'una erişti. Başarısız hedeflerden bazıları envanterde `verified` işaretlidir:

| Kaynak | Envanter statüsü | Canlı koşum sonucu |
|---|---|---|
| İŞKUR kamu memur alımı | `verified` | Selector hatası |
| İŞKUR kurum dışı kamu işçi | `verified` | Selector hatası |
| İçişleri duyurular | `verified` | Selector hatası |
| Göç İdaresi duyurular | `verified` | Selector hatası |
| AFAD duyurular | `verified` | Selector hatası |
| Kariyer Kapısı | `verified` | Erişildi, 0 öğe |

Bu, **`verified` etiketinin canlı sağlığı göstermediğini** kanıtlar. Arayüzde ve raporlarda bu etiket "çalışıyor" anlamında yorumlanmamalıdır. Öneri: etiketi tarihli kanıt ayrıca olmak üzere `lastLiveCheck` ve `lastLiveResult` alanlarıyla ayırmak.

### 8.3 Yapay zekâ ile doğrulama: değerlendirme
"Kritik bilgiler resmî kaynakla doğrulanır" hedefi **yapay zekâyla değil, ikinci kaynak karşılaştırmasıyla** yapılmalıdır: aynı ilanın ilan.gov.tr ve kurum sayfasındaki tarihleri/kontenjanı kod ile karşılaştırmak. Model yalnızca çelişkiyi **açıklamak** için kullanılabilir. Bu, mevcut mimarinin "uydurma yok" ilkesiyle uyumludur.

---

## 9. Aşama 5 — Kişiselleştirilmiş bildirim

### 9.1 Mevcut durum
- **Tercih modeli** (`notificationPreferences`): `enabled`, `paused`, `mode` (`instant` / `daily-digest`), `onlyNewJobs`, `notifyOnChanges`, `includeWorkerJobs`, `includeAcademicJobs`, `profilePersonalizationEnabled`, `candidateProfile`, `filters{...}`. Kullanıcının mezuniyet, KPSS puan türü, şehir ve unvan tercihleri **deterministik filtre olarak zaten vardır**.
- **Eşleştirme** (`matchPreferenceToJob`, saf fonksiyon): sırayla process engeli, kanal/duraklatma, kind (new-job/job-changed), kamu işçisi/akademik hariç tutma, unvan, kurum, il, çalışma biçimi, öğrenim, bölüm, KPSS türü, KPSS taban puanı (ilan puanı yoksa **gönderilmez**), son başvuruya kalan gün (tarih yoksa **gönderilmez**), anahtar kelime. Eşleşmeyen her durum bir `suppressedReason` taşır.
- **Olay ve kuyruk:** `notificationEvents` idempotent (`idempotencyKey`), `emailOutbox` ile lease ve ölü mektup. Doğrulanmamış e-posta adresine gönderilmez. Telegram ayrı kanal olarak bağlıdır.
- **Süreç bastırma:** `queueNotificationsForJob` süreç kaydında hiçbir kullanıcı için olay üretmez; eşleştirici de ikinci savunma hattıdır. Test kanıtı: `tests/process-notice-notifications.test.ts`, `tests/report-2026-10-14-decisions.test.ts`.

### 9.2 Kanıtlanan boşluklar
1. **Günlük özet (digest) tercihi ölüdür.** `mode: 'daily-digest'` API'de kabul edilip kaydediliyor, ama bildirim seçimi ya da gönderimi bu alanı **okumuyor**; digest toplayan bir zamanlanmış görev yok. `email/templates.ts` içinde `daily-digest` şablonu vardır, fakat hiçbir yol onu üretmez. Kullanıcı digest seçse bile anlık bildirim alır. Bu, dokümandaki "altyapı hazır" ifadesinden daha zayıftır ve düzeltilmelidir.
2. **Sayaç adı yanıltıcı:** `queueNotificationsForJob` içinde eşleşmeyen her durum `skippedPaused` sayacını artırır; bu sayaç duraklatmayı değil her türlü eşleşmemeyi sayar.
3. **Ölçek:** Her yeni/değişmiş ilan için `listNotifiable()` ile tüm tercihler sırayla değerlendirilir (ilan × kullanıcı). Kullanıcı sayısı büyüdüğünde bu döngü ve her biri için kullanıcı çekimi pahalılaşır; toplu ön-filtre (indeksli sorgu) gerekir.
4. **Değişiklik bildirimi:** `job-changed` kapsamı testlerle korunuyor, fakat "gerçekten uygun" değişikliklerin ayrımı yalnızca `notifyOnChanges` ile yapılıyor; değişiklik türüne (son tarih uzatıldı, kontenjan) göre filtre yok.

### 9.3 Yapay zekâ ile bildirim: değerlendirme
**Bildirim kararını yapay zekâya bırakmak önerilmez.** Gerekçeler:
- **Tekrar üretilebilirlik:** Aynı ilan için iki farklı gönderim kararı kabul edilemez (bildirim yorgunluğu ve güven kaybı).
- **Gecikme ve maliyet:** Bildirimler kuyrukta bekler; her ilan × her kullanıcı için model çağrısı ölçeklenmez.
- **Rıza:** Profil bilgisinin üçüncü tarafa gitmesi açık rıza gerektirir. Mevcut rıza yalnızca panel önerileri içindir (`aiConsentAt`). Bildirim için AI kullanılacaksa **ayrı ve açık bir rıza** gerekir.
- **Kullanıcının beklentisi:** "Uygun" kararı kullanıcının verdiği filtrelere dayanmalıdır; model bunu gizlice genişletebilir.

**Kabul edilebilir kullanım:** Gönderilmiş bildirimin **açıklaması** veya kullanıcının isteğiyle panelde "neden uygun?" sorusuna yanıt. Karar değil, açıklama.

---

## 10. Kullanıcının beş aşamalı yaklaşımının değerlendirmesi

### 10.1 Genel hüküm
**Yaklaşım, sistemin mevcut mimarisiyle büyük ölçüde uyumludur ve yönü doğrudur**: kodla bulma, yapay zekâyı yalnızca belirsiz ve pahalı adımlara koyma, yeni/değişmeyen içeriği yeniden işlememe, bildirimi yalnızca gerçekten uygun ilanlara sınırlama. Mevcut sistem bunların çoğunu zaten uygular (§4, §5, §7, §9.1).

**Ancak üç koşul olmadan uygulanmamalıdır:**
1. Yapay zekâ çıktısı **kanıtla** bağlanmadan kayda yazılmamalı (uydurmayı önlemek için).
2. Bildirim kararı **deterministik** kalmalı; AI yalnızca açıklama yapmalı.
3. Yapay zekâ kullanımı **ölçülmeden** (altın küme) üretime alınmamalı.

### 10.2 Aşama bazlı karar tablosu

| Aşama | Öneri | Mevcut durum | Hüküm |
|---|---|---|---|
| 1. Bulma (kod) | Siteleri, RSS'i, API'yi kodla tara | Var: 8 adaptör ailesi, 28 tanım, ETag, hız sınırı, zamanlayıcı | **Uygun, zaten var.** Sorun kapsam ve canlı sağlıktır, yapay zekâ değil (§8.2). |
| 2. Anlama (AI) | Kurum, unvan, KPSS, mezuniyet, kontenjan, tarih, şartları AI çıkarsın; PDF'i yorumlasın | Kural tabanlı çıkarım; PDF metin katmanı; OCR yok | **Kısmen uygun.** AI'yı **tüm ilanlara değil**, yalnızca kural boş/belirsiz bıraktığında ve kanıt zorunluluğuyla kullan. Taranmış PDF için OCR olmadan AI işe yaramaz. |
| 3. Tekilleştirme | Bağlantı/numara/özet/benzerlik kodla; belirsizde AI | Kod tabanlı; belirsizlik kuyruğa gider | **Uygun.** AI yalnızca `review` bandında **öneri** üretsin; otomatik birleştirme yapmasın. |
| 4. Doğrulama | Tarih, eksik alan, çelişki, güncelleme/iptal kontrolü; resmî kaynakla doğrulama | Tarih guard'ı, değişiklik takibi var; çapraz kaynak karşılaştırması yok | **Uygun, eksik.** Çapraz kaynak karşılaştırmasını **kodla** yap; AI yalnız çelişkiyi açıklasın. |
| 5. Bildirim | Mezuniyet, KPSS, şehir, unvana göre seç; e-posta/Telegram; isteğe bağlı AI | Deterministik eşleştirme ve filtreler var | **Uygun.** Karar AI'ya bırakılmamalı. AI yalnız açıklama için ve ayrı rızayla. Digest eksik (§9.2). |
| Optimizasyon: değişmeyen içeriği tekrar işleme | Yok | ETag, `contentHash`, bilinen kimlikler, detay bütçesi var | **Zaten var.** Kalıcı LLM önbelleği eklenmeli (§6.4). |
| Optimizasyon: basit ilan ucuz model/kural | — | Kural motoru ücretsiz | **Gereksiz ilk adım.** Basit ilan zaten kuralla çözülüyor; ucuz model yalnız belirsiz ilanlar için. |
| Optimizasyon: karmaşık PDF / belirsiz / çelişkili → güçlü model | — | Yok | **Uygun ama ölçüm şart.** Güçlü model yalnız belirsiz kayıtlarda; bu yönlendirme için belirsizlik skoru gerekir (`uncertainties` sayısı bunun ilk adayı). |
| Optimizasyon: farklı sitelerde aynı ilan → önce kod | Var | Ref no, URL ve benzerlik var | **Zaten var.** |
| Optimizasyon: bildirim yalnız yeni/değişmiş/uygun | Var | Olay anahtarı, eşleştirme | **Zaten var.** |

### 10.3 Maliyet modeli (ölçülebilir biçimde)
AI çağrısı sayısı tarama hacmiyle değil, **belirsiz yeni kayıt sayısıyla** orantılı olmalıdır:

```
günlük_LLM_çağrısı ≈ (yeni_veya_değişmiş_kayıt_sayısı)
                     × (belirsizlik_oranı)            ← kural boş/çelişkili alan bırakan kayıtların oranı
                     × (1 + yeniden_deneme_oranı)
```

- Yeni kayıt sayısı: `scrapeRuns.itemsAccepted + itemsReview` toplamıyla **ölçülebilir** (mevcut veri).
- Belirsizlik oranı: `uncertainties` dolu kayıtların oranı (mevcut veri). **Henüz ölçülmedi**; önce ölçülmeli.
- Sürekli tarama (değişmeyen içerik) için maliyet **sıfırdır**, çünkü ETag/`contentHash` ve bilinen kimlikler modeli atlatır.

Bu nedenle, belirsizlik oranı ölçülmeden tahmini bir token bütçesi vermek **uydurma** olur. Bu raporun önerisi: önce `scrapeRuns` ve `jobs.uncertainties` üzerinden gerçek oranı çıkarın (yeni bir betik ya da mevcut `sources:report` genişletmesi).

### 10.4 Riskler (yapay zekâ eklenirse)
- **Uydurma:** Modelin olmayan tarih, kontenjan veya şart üretmesi. Önlem: kanıt zorunluluğu (§6.4-1).
- **İstem enjeksiyonu:** İlan metninde talimat. Önlem: veri olarak işleme, şema doğrulama, dış eylem yetkisi yok.
- **KVKK:** İlan metni kamusal olsa da kullanıcı profili kişisel veridir. Profil yalnızca açık rızayla gönderilmeli, sağlayıcı ve amaç açıkça belirtilmeli (mevcut `AI_PROVIDER_LABEL` bunu destekler).
- **Bağımlılık:** Sağlayıcı kesintisi, kota, fiyat değişikliği. Önlem: deterministik yedek (mevcut yaklaşım).
- **Tutarsızlık:** Aynı ilan için iki farklı çıkarım. Önlem: içerik hash'iyle sürümlü, kalıcı önbellek.
- **Kanıtsız kayıt:** AI'nın kaynağa bağlanmamış değer üretmesi. Önlem: zod şeması + birebir alt dizgi doğrulaması.

---

## 11. Bilinen hata ve boşluklar (önceliğe göre)

| Öncelik | Konu | Kanıt | Etki | Önerilen düzeltme |
|---|---|---|---|---|
| Yüksek | Digest tercihi ölü | `mode` hiçbir gönderim kodunda okunmuyor | Kullanıcı yanlış beklenti; "altyapı hazır" yanıltıcı | Digest toplayıcı görevi + gönderim; ya da arayüzden kaldırıp dokümanı düzeltme |
| Yüksek | `verified` etiketi canlı sağlığı yansıtmıyor | §8.2: 5 `verified` kaynak canlı başarısız | Yöneticiyi yanıltır | Canlı kontrol alanlarını ayırma; her koşumda sağlık |
| Yüksek | Gerçek gövde ile doğrulanmamış C/D kararları | §6.2 | Yanlış sınıflandırma riski | Dry-run gerçek veride (kullanıcı) |
| Orta | Doküman sapması: kaynak sayısı | sources.md 27/23 vs kod 28/24 | Yanıltıcı kapsam beyanı | Dokümanı koda göre güncelleme |
| Orta | Ortak başlık kuralı `\b` çekim sorunu | §6.2 | Bilinmeyen sayıda yanlış karar | Etki analizi, ardından düzeltme ve test |
| Orta | Menü metni kirliliği | TMSF ve KGM örnekleri | Gövde metni ve ilk alanlar bozuk | Örnek ile hedefli kural (geniş kural yok) |
| Orta | Bildirim ölçeği (ilan × kullanıcı döngüsü) | §9.2-3 | Kullanıcı arttıkça gecikme | İndeksli ön-filtre |
| Orta | `skippedPaused` sayacı adı | §9.2-2 | Yanlış metrik okunması | Yeniden adlandırma |
| Orta | PDF'de OCR yok | §6.1 | Taranmış ilanlar kayıp/incelemede | Ayrı karar: OCR maliyet/doğruluk |
| Orta | TLS zinciri (Windows) | Önceki kanıt: root+intermediate ile doğrulandı | ilan.gov.tr, BDDK, TMSF erişilemez | Kullanıcı PEM'i veya manuel güven kurulumu |
| Düşük | Yapay zekâ önbelleği süreç belleğinde | `suggest.ts` | Çok süreçli dağıtımda tekrar çağrı | Kalıcı önbellek (ayrıca §6.4) |
| Düşük | Sayaç ve belge tutarlılığı | Çeşitli | Bakım yükü | Otomatik doküman-kod kontrolü |
| Güvenlik | Sohbette paylaşılmış sırlar | Önceki oturum | Anahtar sızıntısı riski | **Döndürme** (kullanıcı) |

---

## 12. Önerilen yol haritası (sırayla)

**Adım 0 — Ölçüm (yapay zekâdan önce):**
1. Altın küme oluşturma: 150–200 gerçek ilan, etiketli (kurum, unvan, son başvuru, KPSS türü, mezuniyet, kontenjan, süreç/iş ayrımı). Kullanıcı ve ajan birlikte.
2. Mevcut kuralın bu küme üzerindeki kesinlik/duyarlılık değerlerini ölçme (betik, ağsız).
3. Belirsizlik oranını `jobs.uncertainties` ile ölçme (§10.3).

**Adım 1 — Hızlı, düşük riskli düzeltmeler (AI gerektirmez):**
4. Digest: ya gerçekten uygulayın (zamanlanmış toplayıcı + gönderim + test) ya da arayüzü ve dokümanı dürüst hale getirin.
5. `verified` etiketini canlı sağlıktan ayırın; `sources.md`'yi koda göre düzeltin.
6. `skippedPaused` sayacını yeniden adlandırın.
7. Ortak başlık kuralı `\b` sorununun etki analizi ve düzeltmesi.

**Adım 2 — Yapay zekâ çıkarımı (yalnızca ölçümden sonra ve sınırlı):**
8. Kural boş/belirsiz bırakan alanlar için LLM çıkarımı; her değer için birebir alt dizgi kanıtı; zod şeması; kalıcı önbellek `(kaynak, sourceItemId, contentHash, EXTRACTION_VERSION)`.
9. Altın küme üzerinde kural ve LLM karşılaştırması; ancak LLM kesinlik/duyarlılık kuralı aşarsa devreye alınır (aksi halde yalnızca belirsiz alanlar).
10. Taranmış PDF için OCR kararı (ayrı, maliyet ve doğruluk ölçümüyle).

**Adım 3 — Tekilleştirme ve doğrulama:**
11. `review` bandında LLM **öneri** (otomatik birleşme yok).
12. Çapraz kaynak karşılaştırması (kod): aynı ilanın iki kaynaktaki tarih ve kontenjanı; çelişki uyarısı.

**Adım 4 — Bildirim ve açıklama:**
13. Bildirim ölçeği için indeksli ön-filtre.
14. "Neden uygun?" açıklaması (AI, kullanıcı isteğiyle, ayrı rızayla), karar değil.

**Adım 5 — Operasyon:**
15. Gerçek maliyet ölçümü (çağrı sayısı, token, gecikme) ve bütçe alarmı.
16. Kaynak sağlığı panelinde canlı kontrol sonucu (son başarılı/başarısız koşum).

---

## 13. Açık işler ve sahipleri

| # | İş | Sahip | Durum |
|---|---|---|---|
| 1 | Gerçek veride Windows dry-run (56 kayıt) ve C/D doğrulaması | Kullanıcı | Bekliyor |
| 2 | Menü metni: TMSF ve KGM örnekleri (ilk ~200 karakter, kişisel değerler silinmiş) | Kullanıcı | Bekliyor |
| 3 | PR #13 incelemesi ve birleştirme kararı | Kullanıcı | Açık, birleştirilmedi |
| 4 | Paylaşılmış sırların döndürülmesi (Telegram, veritabanı, APP_SECRET, AI anahtarları) | Kullanıcı | Öneri (zorunlu) |
| 5 | Altın küme oluşturma (§12 Adım 0) | Kullanıcı (etiket) + ajan (betik) | Önerilen |
| 6 | Digest uygulaması ya da dürüst kaldırma (§9.2-1) | Ajan | Bekliyor |
| 7 | `verified` ayrımı ve `sources.md` düzeltmesi (§8.2, §11) | Ajan | Bekliyor |
| 8 | TLS zinciri (ilan.gov.tr, BDDK, TMSF) | Kullanıcı (PEM) + ajan | Bekliyor |
| 9 | Selector hataları (İŞKUR ×2, İçişleri, Göç, AFAD, Sağlık, DSİ, KGM, TKGM, EPDK) için HTML örnekleri | Kullanıcı + ajan | Bekliyor |
| 10 | Resmî Gazete `probe:resmigazete` çıktısı (yalnız mevcut kimlik politikası içinde) | Kullanıcı (yerel) | Bekliyor |
| 11 | Telegram ve AI canlı doğrulama (webhook, HTTPS tünel, model yanıtı) | Kullanıcı + ajan | Bekliyor |
| 12 | Ortak başlık kuralı `\b` etki analizi | Ajan | Bekliyor |

---

## 14. Doğrulama kanıtları (bu raporun dayandığı)

| Kontrol | Sonuç | Not |
|---|---|---|
| Uzak dal ve çalışma ağacı | `c011100` ile birebir aynı: 269 dosya, içerik karşılaştırması ile doğrulandı | Yerel HEAD `90c663e` idi; `git reset --mixed origin/arena/834acf8c-kamuradar` ile hizalandı (çalışma ağacı değişmedi) |
| Tam test paketi (son koşum) | 55 dosya, 660 test, hepsi geçti | `npx vitest run` (bu turda 36 yeni regresyon testi eklendi) |
| `tsc --noEmit` | Çıkış 0 | |
| ESLint (değişen dosyalar) | Çıkış 0 | |
| Yapay zekâ çağrı noktaları | `callChatCompletion` yalnız `src/ai/llm.ts` (tanım) ve `src/ai/suggest.ts` (kullanım) içinde; `suggest.ts` yalnız `routes/ai.ts` tarafından çağrılır | `grep` ile doğrulandı |
| Digest kullanımı | `mode` alanı hiçbir gönderim kodunda okunmuyor | `grep` ile doğrulandı |
| Kaynak sayısı | Kod: 28 (24 etkin); doküman: 27 (23 etkin) | `src/config/sources.ts` ayrıştırıldı |
| Canlı koşum (kullanıcı, 14 Ekim 2026) | 24 hedeften 10'una erişildi | Kullanıcının paylaştığı özet; bu ortamdan yeniden doğrulanamadı |
| Yerel dry-run (8 kayıt test deposu) | 2 kabul, 4 süreç, 2 ret | `/home/user/tlsdemo/reclassify-report-2026-10-14.json` (repo dışı). Bu turda dosya artık yok (oturum yenilemesinde kayboldu); yeniden üretilemedi |

**Doğrulanamayanlar (bu ortam):** Canlı kaynak erişimi, Telegram API, AI sağlayıcı yanıtları, Supabase üzerinde dry-run, gerçek C/D gövdeleri, TLS zinciri. Bunlar yukarıda "bekliyor" olarak işaretlenmiştir ve iddia edilmemiştir.

---

## 14a. Bu turda yapılan düzeltmeler

1. **Kök neden (kabul kararı):** Kabul, başlıkta alım kanıtı olmadan yalnızca gövde puanıyla verilebiliyordu (gövde ağırlığı 0,7). Gövdesinde "başvurular … alınacaktır", "kontenjan", "sözleşmeli personel alımı" geçen bir haber veya kurum duyurusu `accept/job` çıkıyordu. Ölçüm: ilan dilli gövdeyle spesifikasyondaki negatif başlıklardan 5'i (Suriye eğitim, Koç–Bitlis, eğitim anlayışı, TTO üretim tesisi, Özvar sınav uyarısı) kabul edildi. Bu, "personel ilanı dışında her ilanı alıyor" şikâyetinin olası ana nedenidir.
   - **Düzeltme:** `src/classification/engine.ts`. Başlıkta ve kaynak kategorisinde alım kanıtı yoksa karar `review` (inceleme). Normal ilan listesine girmez.
   - **Test:** `tests/yanlis-ilan-regresyon.test.ts`, 36 test. Düzeltme geçici olarak kapatıldığında 9 test başarısız oldu; açıkken 36/36 geçer.
   - **Kapsam:** Spesifikasyondaki 15 negatif başlık iki gövdeyle test edildi (haber gövdesi ve ilan dilli gövde). Rektör adaylığı (karar B) reddedilmeye devam eder. Başlıkta alım ifadesi olan gerçek ilan (MEB Sözleşmeli Bilişim Personeli Alımı) kabul edilir. Sözlü sınav çağrısı süreç olarak kalır.
2. **Günlük özet:** Gönderici yok, `mode` yalnızca kaydediliyor. Panelde yeni seçim artık sunulmuyor. Bu moddaki mevcut tercihler için devre dışı bir seçenek gösteriliyor ("henüz kullanılamıyor; bildirimler anında gönderilir"). Gerçek özet gönderimi bu turda uygulanmadı; ayrı iş olarak kalır.
3. **Etki (önemli):** Kabul kuralı değiştiği için onaylı Windows kuru çalıştırması (56 kayıt: 26 kabul, 5 süreç, 30 ret) güncel olmayabilir. Gövde kanıtına dayanan kabuller artık `review` olur. Bu ortamda 56 kayıt bulunmadığı için etki ölçülemedi. Kullanıcı `npm run jobs:reclassify -- --report <dosya>` ile yeniden kuru çalıştırma almalı. Onaydan önce `--apply` çalıştırılmamalı.
4. **Doğrulama:** `npx vitest run` 55 dosya / 660 test, hepsi geçti. `npx tsc --noEmit` çıkış 0. ESLint (değişen dosyalar) çıkış 0. Değişen `engine.ts` Prettier ile biçimlendirildi. `Panel.tsx` içindeki Prettier uyarıları bu değişiklikten önce de vardı; kapsam dışında bırakıldı.
5. **Canlı doğrulama yok:** YÖK ve diğer kurum sitelerine bu ortamdan erişilemez (izinli hostlar: github, npm, pypi). Hiçbir kaynak "canlı doğrulandı" olarak işaretlenmedi. YÖK kaynağı (`https://www.yok.gov.tr/announcements`, `kurum-duyuru-listesi`) tüm duyuruları toplar. Haber ve ilan ayrımı yalnızca sınıflandırıcıdadır; YÖK'e özel filtre eklenmedi, düzeltme genel olarak uygulandı.

---

## 15. Yeniden üretme

```bash
cd /home/user/kamuradar
git status                                   # temiz olmalı
npx vitest run                               # 660 test (55 dosya)
npx tsc --noEmit                             # çıkış 0
grep -rln "callChatCompletion" src --include=*.ts   # yalnız src/ai/llm.ts (tanım) ve src/ai/suggest.ts (kullanım)
grep -rn "\.mode\b" src/notifications src/worker   # digest alanı okunmuyor (boş dönmeli)
grep -c "^    key: '" src/config/sources.ts     # 28 (son kontrolde)
```

---

## 16. Bu raporun sınırları

- Bu rapor kod ve dokümanların **bugünkü** durumunu anlatır; canlı kaynakların bugünkü durumunu değil.
- Yapay zekâ önerileri için "işe yarar" ya da "yaramaz" hükmü verilmemiştir: bu, §12 Adım 0 ölçümü olmadan **bilinemez**.
- Maliyet tahmini verilmemiştir: belirsizlik oranı henüz ölçülmemiştir.
- Kullanıcının beş aşamalı önerisi, mevcut sistemle karşılaştırılarak **değerlendirilmiştir**; uygulanmış değildir.
