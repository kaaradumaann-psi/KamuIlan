# 09 — REA Değerlendirmesi (Phase 2)

**Soru:** `https://github.com/morluto/rea` gerçekten çalışıyor mu, Kamuİlan için ne yapabilir,
ne yapamaz? **Tarih:** 21.10.2026 · **Kanıt düzeyleri:** [1] çalıştırma · [2] test · [3] olasılık · [4] doğrulanamadı

## 1. Gerçekten kuruldu ve çalıştırıldı [1]

| Adım | Komut | Sonuç |
| --- | --- | --- |
| Depoyu incele | `git clone https://github.com/morluto/rea /tmp/rea-check` | Başarılı; lisans **MIT**; README + `AGENTS.md` + `CHANGELOG.md` okundu |
| Node uyumu | `node -v` | **v22.22.3** (Depo Debian 12) |
| Kurulum | `npm i rea-agents` (`/tmp/rea-install`) | **6.7.0** kuruldu |
| Sağlık | `npx rea-agents doctor` | **`healthy: false`** — aşağıdaki eksikler |
| Yetenekler | `npx rea-agents capabilities` | 4 sağlayıcı; çoğu bu ortamda **kullanılamıyor** |
| Analiz | `npx rea-agents analyze-javascript-application dist --format json` | **çıkış 0**, kanıt paketi üretildi: `evidence_id: ev_e43dfb59…` |

> Not: REA depoya **kurulmadı**; `/tmp` altında çalıştırıldı. `package.json` ve kilit dosyası değişmedi.

## 2. `doctor` çıktısı: ne eksik, neden [1]

| Kontrol | Durum | Neden |
| --- | --- | --- |
| node | ✅ 22.22.3 | — |
| host | ✅ Debian 12 | — |
| hopper | ❌ `missing_analysis_engine` | Ticari Hopper yok |
| ghidra | ❌ | `GHIDRA_INSTALL_DIR` tanımsız |
| ida-registration | ❌ | IDA MCP kaydı yok |
| jadx | ❌ | Harici JAR gerekli (REA indirmiyor) |
| kuna-installation | ❌ | Harici ikili gerekli |
| **sqlite sağlayıcısı** | ❌ (capabilities) | Node **24.15+** istiyor; bizde 22 |
| skill:identity | ❌ `config_drift` | REA skill kurulu değil |
| tarayıcı / CDP | ❌ | Chromium yok → canlı web analizi yapılamaz |

**Sonuç:** REA'nın "native", "disassembly" ve "canlı tarayıcı" yetenekleri bu ortamda
**kullanılamıyor**. Yalnızca **saf statik JavaScript analizi** ve **artifact grafiği** çalıştı.

## 3. Gerçekten ürettiği bulgu [1]

`dist/` (bizim derlenmiş arayüzümüz) üzerinde:

- **96 düğüm (node)**, bunların **75'i uç (endpoint) gözlemi**
- `confidence: exact` olanlar: koda **birebir yazılmış** yollar
  (ör. `/api/telegram/link-code`, `/api/auth/login`, `/api/ai/suggestions`) — her biri
  dosya/satır/kolon aralığıyla kanıtlandı
- `confidence: low` olanlar: değişken/sorgu dizesiyle birleşen yollar (`/api/jobs`, `/api/admin/overview` …)
- REA'nın **kendi yazdığı sınırlar** (kaydedildi):
  - `assets/vendor-C1bh8yQ9.js`: **"Owned JavaScript worker exhausted its heap"** → analiz eksik kaldı
  - "Graph coverage is incomplete; unavailable facts remain explicit and must not be read as absence."
  - "JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed."
  - "Static paths … may remain unresolved when expressions are dynamic or obfuscated."

Yani: REA **var olanı listeler**, çalıştığını kanıtlamaz. Ürettiği 75 uç, sunucudaki 56 rotanın
tamamı değil — yalnızca **arayüzün çağırdığı** uçlar (beklenen davranış).

## 4. Ne YAPABİLİR / ne YAPAMAZ

| Yapabilir | Yapamaz |
| --- | --- |
| Kendi JS paketimizde uç/depolama/olay **envanteri** çıkarır | Üçüncü taraf bir sitenin **sunucu kodunu** göstermez |
| Her bulguya dosya/satır + SHA-256 kanıtı ekler | Çalışma zamanı davranışını kanıtlamaz (kendi de yazıyor) |
| Statik bağımlılık/grafik analizi | Giriş gerektiren sayfaları gezmez, oturum açmaz |
| Kendi kodumuzda **ölü uç/sır sızıntısı** taraması | KadroNerede'nin algoritmasını/kaynaklarını ortaya çıkarmaz |
| Raporu makine-okunur JSON + `evidence_id` olarak verir | LLM/API anahtarı, veritabanı şeması gibi sunucu tarafı sırları uzaktan çıkarmaz |

**Kritik uyarı:** REA bu denetimde **KadroNerede hakkında hiçbir kanıt üretmedi**. 05 numaralı
benchmark belgesi yalnızca herkese açık sayfa gözlemine dayanır. REA'nın "tersine mühendislik"
adı, uzak bir sitenin arkasını görme yetkisi anlamına gelmez; bizim istemcimizi analiz etti.

## 5. Karar

- **Kurulu kalsın mı?** Evet, ama yalnızca **kendi artifact'larımızı denetlemek** için
  (`npm run build` sonrası `dist/` üzerinde). Depoya bağımlılık olarak **eklenmedi**.
- **Canlı web için:** Chromium + CDP gerekir; bu ortamda yok (E2E de bu yüzden BLOCKED).
- **Disassembly (Hopper/Ghidra/IDA):** bu proje için **gerekmiyor**; bizim kodumuz açık kaynak
  ve TypeScript. Yalnızca derlenmiş üçüncü taraf bir istemciyi incelemek gerekirse anlamlı olur.
- **KadroNerede karşılaştırması:** REA ile **yapılmadı**, yapılamaz; hukuki/etik sınır da budur.

## 6. Tekrarlanabilir komutlar

```bash
cd /tmp && git clone https://github.com/morluto/rea rea-check && cd rea-check && less README.md
cd /tmp && mkdir rea-install && cd rea-install && npm init -y && npm i rea-agents
npx rea-agents doctor
npx rea-agents capabilities
cd /home/user/kamuradar && npm run build
npx --yes rea-agents analyze-javascript-application dist --format json | tail -1 > /tmp/rea-out.json
```
