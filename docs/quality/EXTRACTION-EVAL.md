# Alan çıkarımı değerlendirmesi (P3)

**Komut:** `npm run eval:extraction`
**Durum (2026-10-17):** **INSUFFICIENT DATA** — ölçülebilir insan etiketli gerçek
kayıt **0**. Bu belge bir başarı raporu değildir; yöntem + gerçek çıktı kaydıdır.

## 1. Ne ölçülür?

`src/evaluation/extraction.ts` saf (yan etkisiz) değerlendiricidir. Girdi:
etiket dosyasındaki `records`; çıktı: alan bazında sayaçlar ve koşullu oranlar.

- Yalnızca `origin: "real"` + `labelProvenance: "human"` + `expectedContentType`
  dolu kayıtlar gerçek-insan sayılır.
- Ölçüm için gövde **≥200 karakter** ve en az bir `expectedFields` anahtarı
  gerekir; aksi hâlde kayıt `unscorable` altında sayılır.
- Sentetik ve `spec-title` kayıtlar **hiçbir** orana katılmaz.
- Alan başına destek `< 5` ise P/R/F1 `null` (gizli) döner.
- Genel durum yalnızca `≥30` ölçülebilir kayıt **ve** en az bir alan destek
  eşiğini geçtiğinde `MEASURED` olur; değilse `INSUFFICIENT DATA`.
- Genel P/R/F1 yalnızca destek eşiğini geçen alanlardan hesaplanır; 1-2
  etiketli alan genel ortalamayı ele geçiremez.

## 2. Alanlar ve eşleştirme

Sözlük `src/evaluation/fields.ts` içinde **26 kanonik anahtar** ve Türkçe
takma adlardır (`il`→`city`, `kontenjan`→`quota`, `sonBasvuru`→`applicationEndAt` …).
Kapsananlar: kurum, birim, istihdam türü, il, ilçe, kadro/kontenjan, kadro
durumu, unvan(lar), öğrenim, bölüm, KPSS türü/taban puanı/yılı, yaş alt-üst,
sertifika, deneyim yılı, yabancı dil, özel koşul, yayım tarihi, başvuru
başlangıcı/bitişi, başvuru yöntemi/URL'si, ek/PDF, referans no.

| Tür | Eşleşme |
|---|---|
| metin | `normalizeTr` + boşluk sadeleştirme (Türkçe I/İ, aksan duyarsız) |
| sayı | sayısal eşitlik |
| liste | normalize edilmiş **token kümesi eşitliği**; alt-dize eşleşmesi yok (`lisans` ≠ `lisansüstü`) |
| tarih | gün eşitliği (Türkçe/ISO) |
| tarih+saat | beklenen saat varsa saat de karşılaştırılır |
| URL | şema + host + yol; query/fragment yok sayılır |
| ek/PDF | `true/false`, adet, URL listesi veya `pdf` işareti |

`null` = **insan doğrulamış yokluk**; anahtarın hiç yazılmaması = etiketsiz
(ölçüm dışı). `{status:"ambiguous"}` ölçüm dışıdır ve ayrı sayılır. Değer
uydurma/kaçırma/yanlış değer birbirinden ayrı sayılır:

- beklenen var + çıkarım var + eşleşiyor → **TP**
- beklenen var + çıkarım var + eşleşmiyor → `valueMismatch`, FP+FN
- beklenen var + çıkarım yok → `missed`, FN
- beklenen yok + çıkarım var → `hallucinated`, FP
- beklenen yok + çıkarım yok → doğru; TP/FP/FN'ye katılmaz

## 3. Kanıt ve tarih kontrolleri

- Çıkarımın ürettiği **her** olgu (etiketlenmemiş alanlar dahil) için
  `evidence[alan]` metni normalize edilmiş başlık+gövde içinde aranır.
- Kanıt yok → `missing`; metinde yok ve kaynak `listing` → `listingUnverified`
  (kart verisi gövdede görünmeyebilir); aksi hâlde `invalid` (**uydurma kanıt**).
- Tarih rol karışması: beklenen yayım tarihi çıkarımda başvuru başlangıcı/bitişi
  olarak görünüyorsa (ve tersi) ayrı sayılır.
- Tutarsızlık: bitiş < başlangıç veya yayım > başvuru bitişi.

## 4. Gerçek çıktı (2026-10-17)

```text
Alan çıkarımı değerlendirmesi — INSUFFICIENT DATA
  Kayıt: toplam 17 · gerçek 0 (insan 0, ölçülebilir 0) · sentetik 0 · şartname 17
  Ölçülemez: gövdesiz 0 · kısa gövde 0 · alan etiketi yok 0 · insan dışı 0
  Genel: TP 0 · FP 0 · FN 0 · P — · R — · F1 — · makro F1 —
Metadata: evaluator 2026.10.1 · extraction 2026.10.4 · commit ee45a23d5fde ·
dataset 2a70d6d517797046… · LLM çağrısı 0 · ağ çağrısı 0
```

**Yorum:** 17 kayıt yalnızca başlık şablonudur (`spec-title`), insan etiketi ve
gerçek gövde yoktur. Bu yüzden hiçbir yüzde üretilmemiştir. 145 gerçek kayıt
hedefi tamamlanmadan bu komut yeşil bir "başarı" olarak sunulmaz.

## 5. Rapor sözleşmesi

JSON çıktı `--json <dosya>` veya `--json=<dosya>` ile yazılır; konsola da
basılabilir. Rapor şunları taşır:

- `evaluatorVersion`, `extractionVersion`, `generatedAt`, `commit`, `datasetHash`
  (anahtar sırasından bağımsız SHA-256), `status`, `config`, `counts`,
  `unscorable`, `fields`, `fieldCoverage`, `overall`, `evidence`, `dateChecks`,
  `bySource`, `byContentType`, `limitations`.
- **PII yok:** ham başlık, gövde, URL veya kullanıcı kimliği yazılmaz; kayıt
  kimlikleri raporda yer almaz, veri kümesi hash ile temsil edilir.
- `llm: null`, `networkCalls: 0` — bu komut sağlayıcıya/ağa çıkmaz.

Çıkış kodları: `0` rapor üretildi (INSUFFICIENT DATA dahil), `2` dosya
okunamadı/geçersiz JSON, `1` JSON rapor yazılamadı.

## 6. Sınırlar

- 200 karakterden kısa gövdeler ölçüm dışıdır; gerçek ilan gövdesi eksikse
  sonuç yanıltıcı olmasın diye ölçülmez.
- Liste eşleşmesi katıdır; insan etiketi serbest metin yazarsa alan yanlış
  sayılabilir. Bu yüzden etiketleme runbook'u kanonik değerleri önerir.
- `bySource`/`byContentType` kırılımı vardır; adaptör kırılımı kayıt şemasında
  adaptör alanı olmadığı için **yoktur** (kaynak→adaptör eşlemesi
  `src/config/sources.ts` üzerinden ayrıca okunabilir).
- Sonuçlar yalnızca kural motoru içindir; LLM karşılaştırması ayrı ve açık
  opt-in bir adımdır (`eval:classification -- --llm`), varsayılan değildir.
