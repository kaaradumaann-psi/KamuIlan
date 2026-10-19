# Kaynak erişim şartları (robots.txt / ToS) kapısı

Kamuİlan **hiçbir kaynakta** CAPTCHA, WAF, oturum duvarı, ödeme duvarı veya hız
sınırı aşmaz. Erişim şartları bir "engel" değil, ürünün güvenlik sınırıdır.

## 1. Kapı nerede?

- `config/source-terms.json`: kaynak başına **insan** kararı.
- `src/sources/terms.ts`: şema + karar mantığı.
- `scripts/staging-capture.ts`: canlı koşumdan **önce** kapıyı uygular.
- `src/config/staging.ts`: yalnızca incelenebilir kaynakların allowlist'i.

**Kapsam sınırı:** Bu kapı şu an yalnızca operatör staging komutunu bağlar.
`start:worker`/zamanlanmış tarama varsayılan olarak kapalıdır
(`SCHEDULER_ENABLED=0`, `SOURCE_LIVE_FETCH=0`); açıldığında runtime'da ayrıca
robots.txt sorgusu yapılmaz. Üretimde kaynak onboarding'i
(`docs/source-onboarding.md`) ve bu dosyadaki inceleme birlikte yürütülmelidir.

## 2. Karar değerleri

| `decision` | Anlam | Canlı koşum |
|---|---|---|
| `allowed` | İnceleme tamam; saklama izni doğrulandı. | Açık (diğer alanlar doluysa) |
| `blocked` | Şartlar izin vermiyor / erişim kısıtlı. | Kapalı |
| `unknown` | İncelenmedi (varsayılan). | Kapalı |

`allowed` olsa bile şu alanlar zorunludur:

- `reviewedBy` (boş olamaz),
- `reviewedAt` (geçerli tarih; 365 günden eski olamaz),
- `robotsUrl` ve `termsUrl` (**https**),
- `allowsStorage: true` (veriyi saklama/etiketleme izni).

Eksik/geçersiz alan → canlı koşum **exit 5** ile durur; hiçbir HTTP isteği
yapılmaz. Kuru çalışma (`--dry-run`) her zaman yapılabilir.

## 3. İnceleme adımları

1. Kaynağın `listingUrl` ve `homepageUrl` alanlarını `src/config/sources.ts`
   içinden alın (kodda kayıtlı).
2. `https://<host>/robots.txt` adresini tarayıcıda açın. İlgili yollar
   `Disallow` ise **durum `blocked`**; kuralı aşmayın.
3. Kullanım şartları / telif / veri çekme politikasını okuyun. Otomatik
   toplamaya, çözümlemeye veya saklamaya izin yoksa `blocked`.
4. Saklama izni ayrı bir sorudur: "okuma" izni "saklama ve etiketleme" izni
   demek değildir. Emin değilseniz `allowsStorage: false` bırakın.
5. Kararı ve kanıt URL'lerini `config/source-terms.json` içine yazın. Notlara
   tarih ve okunan bölümü ekleyin; kişisel veri/hesap bilgisi yazmayın.
6. `npm run staging:capture -- --source=<kaynak> --dry-run` ile şablonun
   okunduğunu doğrulayın.

## 4. Örnek kayıt

```json
{
  "sourceKey": "osym-duyurular",
  "decision": "unknown",
  "reviewedAt": null,
  "reviewedBy": null,
  "robotsUrl": null,
  "termsUrl": null,
  "allowsStorage": null,
  "notes": "Bu depo tarafından incelenmedi; canlı koşum öncesi operatör doldurmalıdır."
}
```

Depoda gönderilen şablon **bilinçli olarak** `unknown`'dur. Depo kendi başına
"izin var" iddiası üretmez.

## 5. İhlal ve kötüye kullanım

- Yasak: CAPTCHA çözme, WAF atlatma, giriş/oturum taklidi, hız sınırını aşma,
  `Retry-After` yok sayma, IP döndürme.
- `429`/`503` görüldüğünde staging raporu `blocked` yazar; komut tekrar
  çalıştırılmaz. Operatör kaynağı `blocked` işaretler.
- Şüpheli davranışta `docs/limitations.md` ve `docs/security-kvkk.md` esas alınır.

## 6. Snapshot saklama

`fixtures:capture` ayrı bir insan onayı ister:

- yalnızca `--reviewed-public-data`,
- tek istek, `--max-bytes` sınırı,
- e-posta/telefon/TCKN benzeri veriler maskelenir,
- `fixtures/html/<kaynak>-<tarih>.{html,json}` + `manifest.json` (sha256,
  provenance, redactionNotes).

Saklama izni (`allowsStorage`) yoksa snapshot **alınmaz**. Alınan snapshot
`git status` ile kontrol edilir; ham kişisel veri commit edilmez.
