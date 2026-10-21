# rea Tersine Mühendislik — Kadronerede.com Kullanım Kılavuzu (End-to-End)

**Araç:** https://github.com/morluto/rea (REA — Reverse Engineer Anything)  
**Sürüm:** rea 6.7.0 (kuruldu, `rea --help` / `rea doctor` çalışıyor)  
**Hedef:** https://kadronerede.com  
**Tarih:** 2026-10-21  
**Branch:** `arena/3432c91a-kamuradar` (commit sonrası pushlandı)

---

## 1. Bu ortamda ne yapıldı, ne yapılamadı

| Adım | Durum | Neden |
|---|---|---|
| `npm install -g rea-agents` | ✅ Başarılı | `registry.npmjs.org` erişilebilir; rea 6.7.0 kuruldu |
| `rea --help` / `rea doctor` | ✅ Çalıştı | Node 22.22.3 (rea gereksinimi >=22.19) sağlıklı; native motorlar (Hopper/Ghidra/IDA) web analizine gerekli değil |
| Chromium/Chrome edinme (`apt`) | ❌ Reddeddi | `root` değil → `dpkg` kilidi açılamadı |
| `npx playwright install chromium` | ❌ Reddeddi | İndirme CDN'si (`cdn.playwright.dev`) erişilemez (`ECONNRESET` / HTTP 000) |
| Diğer tarayıcı CDN'leri (`storage.googleapis.com`, `googlechromelabs.github.io`, `playwright.microsoft.com`) | ❌ Tümleri HTTP 000 | Sandbox güvenlik duvarı izin veren tek hostlar: `github.com`, `codeload.github.com`, `api.github.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` |
| `kadronerede.com` doğrudan ağ erişimi | ❌ HTTP 000 (http ve https) | Sitenin kendisi de sandbox'tan erişilebilir değil |
| `rea inspect-web-page` / `analyze-web-bundle` / `capture-web-screenshot` | ❌ Çalıştırılamadı | Bu komutlar **Çalışan bir Chrome-family tarayıcının CDP (Chrome DevTools Protocol) uca bağlı olmasını gerektirir**; tarayıcı yok ve hedef site erişilemiyor |

**Sonuç:** REA'nın web sitesi analizi (CDP tabanlı pasif gözlem) bu sandbox'ta **kadroonerede.com üzerinde canlı olarak çalıştırılamıyor**. Aşağıdaki komut dizisi, kendi makinenizde (Chrome ile) birebir çalıştırılabilir. Aynı dosyada, `fetch_page` aracılığıyla erişebildiğim kadronérée içeriğinden elde ettiğim substantive bulgular da yer alıyor.

---

## 2. REA'nın web analizi nasıl çalışır (döküman tabanlı)

REA, web siteleri için **Chrome DevTools Protocol (CDP)** üzerinden kullanıcının kendi Chrome ailesi tarayıcısına **pasif** bağlanır. Kaynak: `docs/browser-observation.md` (morluto/rea).

Kullanabileceğiniz komutlar:

| Komut | Ne işe yarar |
|---|---|
| `list-browser-targets` | CDP endpoint'teki bütün sayfa hedeflerini keşfeder |
| `inspect-web-page` | DOM, erişilebilirlik, scriptler, kaynaklar, ağ/konsol meta verileri, WebSocket, depolama |
| `analyze-web-bundle` | Komut dosyalarını çalıştırmadan ayrıştırır; yol/uç nokta adayları, satıcı parmak izleri, WebMCP bildirimleri, kaynak haritası |
| `observe-web-session` | Yeniden yükleme, SPA gezinmesi, yönlendirme, hata, yaşam döngüsü meta verileri |
| `capture-web-screenshot` | Görünlü görünüm ekran görüntüsü (PNG) |
| `discover-webmcp-tools` | Sayfada ilan edilen WebMCP araçlarını keşfeder |
| `export-web-scripts` | Yakalanan site scriptlerini statik JS analizi için dışa aktarır |
| `compare-web-captures` / `compare-web-screenshots` | İki yakalamanın/PNG'nin karşılaştırılması |

Önemli sınırlama: REA genel bir tarayıcı otomasyonu/uzaktan kontrol arayüzü değildir; **pasif gözlemsel** tersine mühendislik yapar.

---

## 3. Kadronérée.com için end-to-end REA komut dizisi (kendi makinenizde çalıştırın)

Önce Chrome'u uzaktan hata ayıklama (remote debugging) ile başlatın:

```bash
# Chrome'u CDP ile başlat (headless,局部)
google-chrome --headless=new --remote-debugging-port=9222 \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  https://kadronerede.com &
```

Not: Linux'ta `--no-sandbox` genellikle gerekli olabilir; `google-chrome-stable` ya da `chromium-browser` komutu da çalışabilir.

### Adım 1 — REA'nın hazır olup olmadığını denetle
```bash
rea doctor
```
Node ve host sağlıklı olmalı. Web analyze için Hopper/Ghidra/IDA gerek **değil**.

### Adım 2 — Tarayıcı hedeflerini listele
```bash
rea list-browser-targets http://127.0.0.1:9222
```
Çıktıdan `kadronerede.com` sayfasının `targetId`'sini kopyalayın.

### Adım 3 — Sayfayı pasif olarak incele (DOM + ağ + konsol)
```bash
rea inspect-web-page http://127.0.0.1:9222 <targetId> \
  --include-script-sources \
  --include-console-text \
  --include-json-body-shapes \
  --include-websocket-shapes \
  --include-storage-keys \
  --format json --full-output > kadronerede-inspect.json
```
Bu, REA'nın yakalayabileceği delillerin tamamını verir: DOM yapısı, script kaynakları, ağ istekleri, WebSocket kareleri, depolama anahtarları.

### Adım 4 — Sayfa paketini statik olarak analiz et (yol/uç nokta adayları)
```bash
rea analyze-web-bundle http://127.0.0.1:9222 <targetId> \
  --fetch-source-maps \
  --format json --full-output > kadronerede-bundle.json
```
İstemci tarafı JS'te hangi `/api/` veya diğer uç noktalar çağrılıyor, hangi satıcılar kullanılıyor → burada görünür.

### Adım 5 — Ekran görüntüsü
```bash
rea capture-web-screenshot http://127.0.0.1:9222 <targetId> \
  --format json --full-output > kadronerede-shot.json
```

### Adım 6 — WebMCP araçlarını keşfet (sayfa ilan ediyorsa)
```bash
rea discover-webmcp-tools http://127.0.0.1:9222 <targetId> \
  --format json --full-output > kadronerede-webmcp.json
```

### Adım 7 — Tarayıcı senaryosu (Playwright tabanlı, tek bir eylem penceresi)
`scenario.json`:
```json
{
  "url": "https://kadronerede.com/ilanlar?sekme=acik&sirala=yeni",
  "actions": [{"type": "waitForLoadState", "state": "networkidle"}]
}
```
```bash
rea capture-browser-scenario scenario.json --format json --full-output > kadronerede-scenario.json
```

### Adım 8 — Yakalamaları karşılaştır (ör. iki farklı an)
```bash
rea compare-web-captures kadronerede-inspect.json kadronerede-inspect-2.json \
  --format json --full-output
```

---

## 4. Kadronerede.com — elde edilen substantive bulgular (manuel inceleme)

Sandbox'ta canlı REA çalıştırılamadığı için, `fetch_page` aracılığıyla erişebildiğim kadronérée sayfalarından şu gerçekleri çıkardım (tam rapor: `docs/kadronerede-incelenmesi.md`):

### Veri kaynağı ve çekim yöntemi
- **Kaynak 1:** ilan.gov.tr (Basın İlan Kurumu portalı)
- **Kaynak 2:** İŞKUR e-Şube (`esube.iskur.gov.tr`)
- **Sıklık:** Günde birkaç kez, otomatik; istekler kaynak sitelere yük bindirmemek için **yavaş ve seyrek**
- **Son başarılı çekim:** ilan.gov.tr: 21 Ekim 2026 12:30; İŞKUR: 12:31 (`/kaynaklar` sayfası)
- **Ayrıştırma:** Resmi ilan metninden yazılımla şartlar çıkarılır (kadro, öğrenim, bölüm, KPSS puan türü/puanı, yaş, il)
- **Özetleme:** Yapay zekâ yardımıyla yazılır, otomatik denetlenir
- **Erişim:** Kayıt yok, API anahtarı yok, OAuth yok; tüm herkese açık sayfalar anonim, düz HTTP GET (`/auth.md`)
- **Nezaket:** Saniyede en fazla 1 istek; iletişim: info@kadronerede.com
- Süresi dolan ilanlar silinmez, "başvuru sona erdi" etiketiyle kalır; kişi adı içeren belgeler yok

### Makine-erişimi dokümanları (AI / arama motoru odaklı)
| Dosya | İçerik |
|---|---|
| `/openapi.json` | OpenAPI 3.1.0; tüm açık sayfa adresleri + `/ilanlar` süzgeç parametreleri (yanıtlar **HTML**, ayrı JSON veri API'si yok) |
| `/llms.txt` | AI asistanları için tanıtım, kaynaklar, adres kalıpları |
| `/robots.txt` | Tüm botlar serbest; `/admin`, `/api/`, `/bana-uygun`, `/favoriler`, `/abonelik/`, `/*/belge`, `/*/takvim` kapalı |
| `/auth.md` | Anonim erişim; `Authorization` başlığı gönderilmemeli |
| `/.well-known/api-catalog` | RFC 9727 API kataloğu (`openapi.json` + `llms.txt` işaret eder) |
| `/sitemap.xml`, `/taban-puanlar/sitemap.xml` | Site haritaları |

### URL yapısı
- `/ilan/{slug}-{id}` — tek ilan (kadro, şartlar, tarihler, kaynak bağlantısı, son kontrol zamanı)
- `/ilanlar?q=&il=&kurum=&tur=&ogrenim=&sekme=&sirala=&sayfa=` — süzülebilir ilan listesi
- `/il/{il}`, `/kurum/{kurum}`, `/bolum/{bolum}`, `/unvan/{unvan}`, `/ogrenim/{duzey}`, `/nitelik-kodu/{kod}`, `/kpsssiz`, `/takvim(.ics)`, `/haberler`, `/rehber/*`, `/hesaplama/*`, `/istatistik`, `/harita`

### Örnek ilan (ID 43)
`https://kadronerede.com/ilan/elmakaya-belediye-baskanligi-ilk-defa-atanmak-uzere-memur-alim-ilani-43`  
Kurum: Elmakaya Belediye Başkanlığı, Kadro: 1 (Muş), Memur, Lisans, KPSS P3; Başvuru 16–21 Ekim 2026, Sınav 6 Kasım 2026; Kaynak: ilan.gov.tr (ilan no 2226098), Son kontrol: 21 Ekim 2026 12:30.

---

## 5. Kamuradar (bu repo) ile karşılaştırma

| Özellik | kadronerede.com | kamuradar (bu repo) |
|---|---|---|
| Kaynak | ilan.gov.tr, İŞKUR | ilan.gov.tr, kariyerkapisi, osym, resmigazete, sbb-kamuilan (`src/sources/adapters/`) |
| Çekim | HTML liste + detay, yazılımla ayrıştırma | HTML liste + detay; tarayıcıya düşme seçeneği (`src/sources/browser-session.ts`) |
| İstek nezaketi | Yavaş/seyrek, sn başına ≤1 | `src/sources/fetcher.ts` (undici): rate limit, 429/503 geri çekilme, SSRF koruması, CAPTCHA aşılmaz |
| Detay bütçesi | Belirtilmemiş | `ilan-gov-tr` adaptöründe detay istekleri bütçeyle sınırlı |
| Veri işleme | AI özet + otomatik denetim | `src/ingest` (dedupe, sanitize, reclassify), `src/classification` |
| Çalışma döngüsü | Günde birkaç kez otomatik | `src/worker` (scheduler, trigger, queue) |
| Açık dokümantasyon | `openapi.json`, `llms.txt`, `auth.md`, `robots.txt`, `/kaynaklar` | `docs/` raporları, `source-onboarding.md`, `sources.md` |

Kamuradar'ın altyapısı zaten kadronérée'nin kullandığı yöntemle neredeyse aynı. Fark, kadronérée'nin tarafına açık **AI-ödüllü dokümantasyon katmanı** (`llms.txt`, `openapi.json`, `auth.md`) ve kaynak/saydamlık sayfası (`/kaynaklar` + son çekim zamanları) olması.

---

## 6. Öneri

1. Yukarıdaki **3. bölümdeki komut dizisini kendi makinenizde (Chrome + CDP)** çalıştırarak kadronérée.com üzerinde REA'nın canlı web analizini elde edin.
2. `analyze-web-bundle` çıktısından istemci tarafı JS'teki uç nokta adaylarını (`/api/` dahil) çıkarın; `inspect-web-page` çıktısından DOM ve ağ meta verilerini inceleyin.
3. Kadronérée'nin açık dokümantasyon modelini (`llms.txt`, `openapi.json`, `auth.md`, `/kaynaklar`) kamuradar'ın `docs/sources.md` ve API dokümantasyonuna entegre etmeyi değerlendirin.

---

## Kaynaklar

- https://github.com/morluto/rea (REA deposu)
- https://github.com/morluto/rea/blob/main/docs/browser-observation.md (web gözlemi)
- https://github.com/morluto/rea/blob/main/README.md (rea genel)
- https://kadronerede.com/ , /robots.txt, /sitemap.xml, /llms.txt, /openapi.json, /.well-known/api-catalog, /auth.md, /kaynaklar, /ilanlar, /kaynaklar
- Tam rapor: `docs/kadronerede-incelenmesi.md`
