# PostgreSQL / Supabase TLS kurulumu ve `SELF_SIGNED_CERT_IN_CHAIN` çözümü

`SELF_SIGNED_CERT_IN_CHAIN`, sunucunun sunduğu zincirin uygulamanın güvendiği
bir kökle doğrulanamadığını gösteren **sonuçtur**; neden değildir. Neden
aşağıdakilerden biri olabilir ve her birinin çözümü farklıdır:

| Neden | Belirti | Çözüm |
| --- | --- | --- |
| CA dosyası hiç yok, uç nokta proje CA'sı kullanıyor | `db:migrate` hata verir | Panelden CA indir → `POSTGRES_SSL_CA_FILE` |
| CA dosyası **yanlış uç noktaya** ait (doğrudan ↔ pooler) | Dosya var, hata sürüyor | Doğru uca ait CA ya da `POSTGRES_SSL_CA_MERGE_SYSTEM=1` |
| CA dosyası bozuk (HTML/DER/özel anahtar/leaf) | Dosya var, hata sürüyor | Dosyayı yeniden indir; `env:check` artık nedenini söyler |
| Kurumsal proxy/antivirüs TLS denetimi | Kök adında Zscaler/Fortinet/Kaspersky vb. | Yöneticiden kök → `NODE_EXTRA_CA_CERTS` |
| Sunucu zinciri eksik (ara CA gönderilmiyor) | Kök tanınmıyor | Tam zincir dosyası ya da sistem kökleriyle birleştirme |
| Sistem saati yanlış / sertifika süresi dolmuş | `CERT_HAS_EXPIRED` | Saati eşitle (CA eklemek çözmez) |
| Adres sertifikayla uyuşmuyor | `ERR_TLS_CERT_ALTNAME_INVALID` | `POSTGRES_URL`'i düzelt (CA eklemek çözmez) |

## 0) Kök nedeni otomatik bul: `npm run db:tls-doctor`

Bu komut **parola göndermeden** Postgres SSLRequest müzakeresini yürütür,
sunucunun sunduğu sertifika zincirini okur, `.env` kararınızla ve CA
dosyanızla karşılaştırır; hangi halkanın hangi güven kümesinde olmadığını ve
uygulanacak adımı yazar.

```bat
npm run db:tls-doctor
npm run db:tls-doctor -- --no-probe      :: ağa çıkmadan yalnızca yapılandırma denetimi
npm run db:tls-doctor -- --save-chain certs\observed-chain.pem   :: zinciri inceleme için kaydet
```

`--save-chain` ile kaydedilen dosya sunucunun **kendi beyanıdır**; asla CA
olarak kullanmayın. Güvenilir kök yalnızca Supabase panosundan ya da kurum
yöneticinizden alınır.

`db:migrate` ve `db:indexes` bir TLS hatasında aynı tanıyı **otomatik** basar;
ayrıca komut çalıştırmanız gerekmez.

## 1) Windows'ta güvenli çözüm (adım adım)

1. Supabase panosunda **doğru projeyi** açın. **Database Settings → SSL
   Configuration** bölümündeki CA sertifikasını indirin (arayüzde bölüm adı
   değişebilir). Rastgele bir siteden veya başarısız bağlantıdan alınan sunucu
   sertifikasını güvenilir kök olarak kabul etmeyin.
2. Proje klasöründe `certs` klasörünü oluşturun ve indirdiğiniz PEM
   sertifikasını `certs/supabase-ca.crt` adıyla kaydedin. Dosya
   `-----BEGIN CERTIFICATE-----` ile başlayan bir sertifika içermeli; HTML
   indirme sayfası veya **özel anahtar** olmamalıdır. Dosya `certs/` altında
   olduğu sürece repoya girmez (`.gitignore`).
3. Proje kökündeki `.env` dosyasına şunları yazın (aynı anahtarlar varsa düzenleyin):

   ```dotenv
   POSTGRES_SSL=true
   POSTGRES_SSL_MODE=verify
   POSTGRES_SSL_CA_FILE=./certs/supabase-ca.crt
   ```

   Göreli yol hem çalışma dizinine hem `.env` dosyasının bulunduğu proje
   köküne göre çözülür; yine de bulunamazsa hata mesajı **denenen yolları
   listeler**. Mutlak yol da kullanılabilir (`.env` içinde `/` tercih edin):
   `POSTGRES_SSL_CA_FILE=C:/Users/Halil/Desktop/kamuradar-main/certs/supabase-ca.crt`.
4. `POSTGRES_URL` adresini projenizin **Connect** ekranından kontrol edin.
   Doğrudan bağlantı (`db.<proje>.supabase.co:5432`) ve pooler
   (`aws-0-<bölge>.pooler.supabase.com:5432/6543`) **farklı sertifika
   zincirleri** sunabilir; CA seçimini kullandığınız uç noktaya göre yapın.
   URL'ye `sslmode` veya `sslrootcert` eklemeyin — bu parametreler başlangıçta
   reddedilir, çünkü `pg` URL'yi açık `ssl` nesnesinin üzerine yazar.
5. Açık geliştirme sürecini durdurun ve proje klasöründe çalıştırın:

   ```bat
   node -v
   npm run env:check
   npm run db:tls-doctor
   npm run db:migrate
   npm run dev
   ```

   Node en az **22.15.0** olmalıdır (`tls.getCACertificates('system')` bu
   sürümle geldi). `env:check` artık CA dosyasının **içeriğini** de denetler:
   eksik yol, HTML, DER, özel anahtar, CA olmayan leaf ve süresi dolmuş kök
   ayrı ayrı raporlanır.

## 2) CA dosyası + sistem kökleri: `POSTGRES_SSL_CA_MERGE_SYSTEM`

`POSTGRES_SSL_CA_FILE` tanımlıyken sunucu sertifikası **varsayılan olarak
yalnızca o dosyadaki köklerle** doğrulanır (pinning). Bu, "CA zaten tanımlı"
olduğu hâlde hata almanın en yaygın nedenidir: dosya doğru ama eksik ya da
başka bir uca aittir.

İki kök kümesine aynı anda güvenmeniz gerekiyorsa birleştirmeyi açın:

```dotenv
POSTGRES_SSL_CA_FILE=./certs/supabase-ca.crt
POSTGRES_SSL_CA_MERGE_SYSTEM=1
```

Birleşim şunları kapsar: CA dosyanız + Node'un gömülü Mozilla kökleri +
işletim sistemi kök deposu + `NODE_EXTRA_CA_CERTS`. **Doğrulama açık kalır**;
yalnızca güven kümesi genişler. Bu ayar `NODE_TLS_REJECT_UNAUTHORIZED=0`
değildir: zincir hiçbir çapaya bağlanmıyorsa bağlantı yine reddedilir.

Ne zaman gerekir:
- Doğrudan bağlantı ve pooler adreslerini aynı `.env` ile kullanıyorsanız.
- Hem Supabase proje CA'sı hem kurumsal TLS denetimi kökü gerekiyorsa.
- Sunucu zinciri eksik gönderiliyor ve ara CA sistem deposunda varsa.

## 3) Kurumsal proxy / antivirüs TLS denetimi

CA dosyası tanımlı **değilse** uygulama Node köklerini, işletim sistemi
deposunu ve `NODE_EXTRA_CA_CERTS` dosyasını birleştirir; Windows sistem
deposu okunamasa bile gömülü kökler ve ek CA korunur.

Ağınız TLS denetimi yapıyorsa kökü **yalnızca sistem yöneticinizden
doğrulayarak** alın ve tanıtın:

```dotenv
NODE_EXTRA_CA_CERTS=C:/certs/kurum-ca.pem
POSTGRES_SSL_CA_MERGE_SYSTEM=1   # POSTGRES_SSL_CA_FILE de tanımlıysa
```

`db:tls-doctor` kökün adında bilinen bir ara katman imzası (Zscaler,
Fortinet, Kaspersky, ESET, Sophos, Palo Alto, Blue Coat, Netskope …) görürse
bunu açıkça söyler. Kurum kökü doğrulanamıyorsa o ağdan veritabanına
bağlanmayın; doğrulamayı kapatmak kimlik bilgilerinizi ağa açık bırakır.

## 4) HTTP tarafı (kaynak taramaları) — `UNABLE_TO_VERIFY_LEAF_SIGNATURE`

Bazı resmî siteler (bddk.org.tr, tmsf.org.tr, ilan.gov.tr, dsi/kgm/tkgm gibi
kurum portalları) zinciri eksik sunar ya da Mozilla listesinde olmayan bir kök
kullanır. Tarayıcı bunu işletim sistemi deposundan çözer, Node çözemez.

Doğru karşılık `NODE_TLS_REJECT_UNAUTHORIZED=0` **değildir**. Uygulama üç
katmanı sırayla kullanır:

1. **Sistem kök deposu (otomatik).** Node ≥ 22.15 gerekir; uygulama Node'un
   gömülü Mozilla köklerini, işletim sistemi kök deposunu ve
   `NODE_EXTRA_CA_CERTS` dosyasını birleştirir. `npm run test:live` çıktısının
   ilk satırı hangi modun etkin olduğunu yazar.
2. **AIA ile zincir tamamlama (otomatik, `SOURCE_TLS_AIA_COMPLETION=1`).**
   Sunucu yalnızca yaprak sertifikayı gönderdiğinde istemci, yapraktaki
   **AIA** ("CA Issuers") adresinden eksik ara sertifikayı indirir ve
   DOĞRULAYARAK zincire ekler:
   - indirilen sertifika zincirin son halkasını gerçekten imzalamış olmalı
     (`çocuk.verify(eklenen.publicKey)`),
   - CA olmalı (`basicConstraints CA:TRUE`) ve süresi geçerli olmalı,
   - zincir **zaten güvenilen** bir köke bağlanmalı; bağlanmazsa hiçbir halka
     eklenmez ve istek reddedilir.
   İndirme SSRF korumalıdır (yalnızca http/https, kamuya açık IP, en çok 2
   yönlendirme, 1 MiB ve 4 indirme sınırı). Sonuçta bağlantı yine Node'un TLS
   yığınıyla, doğrulama AÇIKKEN ve host adı denetlenerek kurulur; tamamlama
   host başına bir kez denenir ve sonucu günlüğe yazılır. Bu, tarayıcıların ve
   Windows'un yaptığı işlemin kendisidir — farkı, indirdiği sertifikayı
   **güven kökü saymamasıdır**.
   Kod: `src/lib/tls-chain-completion.ts` (+ `tests/tls-chain-completion.test.ts`).
3. **Elle kök/ara sertifika.** Kök sistem deposunda da yoksa doğrulanmış kökü
   bir PEM dosyasına koyun ve `NODE_EXTRA_CA_CERTS=C:/certs/turkiye-kamu-ca.pem`
   ile tanıtın. Dosyaya yalnızca **doğrulayabildiğiniz** kökleri yazın;
   tarayıcıdan dışa aktarılan her sertifika güvenilir değildir. Sunucu ara CA'yı
   hiç göndermiyorsa ve AIA adresi de yoksa eksik halkayı kurumun resmî
   duyurusundan/sertifika deposundan alıp aynı dosyaya ekleyin.

Tamamlama başarısız olursa istemci **reddeder** (sessizce gevşetmez) ve günlüğe
nedeni yazar: `Eksik sertifika zinciri AIA ile tamamlanamadı; doğrulama açık
kaldı ve istek reddedildi.`

## 5) Yapılmayacaklar

`NODE_TLS_REJECT_UNAUTHORIZED=0`, `POSTGRES_SSL_MODE=no-verify`,
`POSTGRES_SSL=0` ve `?sslmode=disable` çözüm değildir:

- `no-verify`/`disable` üretimde `env:check` tarafından **engellenir**, geliştirmede uyarı üretir.
- Bağlantı dizesine yazılan TLS parametreleri (`sslmode`, `ssl`, `sslrootcert`,
  `sslcert`, `sslkey`, `sslnegotiation`, `uselibpqcompat`) başlangıçta reddedilir.
- Uygulama indirilen bir sertifikayı **güven kökü** saymaz: AIA ile indirilen
  halka yalnızca imzası, CA durumu, süresi ve güvenilen köke bağlanması
  doğrulandıktan sonra zincire eklenir (`SOURCE_TLS_AIA_COMPLETION=0` ile tümüyle
  kapatılabilir). Doğrulama hiçbir yolda kapatılmaz.
- Süre dolması veya sunucu adı uyuşmazlığı CA eklemekle çözülmez: sistem
  saatini, sertifika yenilemesini ve bağlantı adresini kontrol edin.

### `NODE_TLS_REJECT_UNAUTHORIZED=0` zaten tanımlıysa (kaldırma)

Bu anahtar açıkken `npm run test:live`, taramalar ve `env:check` "başarılı"
görünebilir; ama bu, sitelerin çalıştığını değil **hiçbir sertifikanın
denetlenmediğini** gösterir. Uygulama bunu gizlemez:

- `describeEnv()` özeti `tlsVerification: KAPALI (NODE_TLS_REJECT_UNAUTHORIZED=0)` satırını taşır
  (`npm run env:check`, `npm run env:setup`, worker başlangıcı, `/health`).
- `npm run test:live` ve `npm run db:tls-doctor` çıktısının İLK satırı uyarı + kaldırma adımlarıdır.
- Üretimde (`NODE_ENV=production`) uygulama **başlamaz**; geliştirmede yüksek sesli uyarıdır.
- Sihirbaz bu alanı riskli karar sayar: `npm run env:setup -- --only NODE_TLS_REJECT_UNAUTHORIZED`
  ile `:clear` deyince `.env`'den silinir (yazmak için `!0` gerekir).

Kaldırma (Windows — genellikle kalıcı kullanıcı değişkenidir):

```bat
:: 1) Geçici (yalnızca açık pencere)
set NODE_TLS_REJECT_UNAUTHORIZED=
:: PowerShell: $env:NODE_TLS_REJECT_UNAUTHORIZED=$null

:: 2) Kalıcı kullanıcı değişkeni: boş değere ayarlayın, YENİ bir kabuk açın
setx NODE_TLS_REJECT_UNAUTHORIZED ""
::    Kalıcı silme: Sistem Özellikleri → Gelişmiş → Ortam Değişkenleri → sil

:: 3) Kontrol: undefined yazmalı
node -e "console.log(process.env.NODE_TLS_REJECT_UNAUTHORIZED)"
```

Kaldırma (Linux/macOS):

```bash
unset NODE_TLS_REJECT_UNAUTHORIZED
# kalıcı tanımları ~/.bashrc, ~/.zshrc, ~/.profile, systemd unit ya da
# Cloudflare/panel ortam değişkenlerinden silin
node -e "console.log(process.env.NODE_TLS_REJECT_UNAUTHORIZED)"   # undefined
```

Anahtar kaldırıldıktan sonra aynı hatayı alırsanız kök nedeni
`npm run db:tls-doctor` (veritabanı) ve `npm run test:live` çıktısının ilk
satırı (HTTP) söyler; eksik halka için yukarıdaki 1–3 adımları uygulayın.

## 6) Kararın uygulandığı yerler (kod haritası)

| Dosya | Sorumluluk |
| --- | --- |
| `src/config/env.ts` | `POSTGRES_SSL*` anahtarları, `postgresTlsMode()`, `postgresCaMergeSystem()`, `env:check` denetimleri |
| `src/lib/ca-file.ts` | CA yolu çözümleme, DER→PEM, içerik/anlam denetimi, güven listesi üretimi |
| `src/lib/tls-trust.ts` | Node + sistem + `NODE_EXTRA_CA_CERTS` kök birleşimi, `NODE_TLS_REJECT_UNAUTHORIZED` bekçisi, genel TLS yardım metni |
| `src/lib/tls-chain-completion.ts` | Eksik ara sertifikayı AIA'dan indirip DOĞRULAYARAK zincire ekleme (HTTP tarafı) |
| `src/sources/fetcher.ts` | Birleşik güven deposuyla undici ajanı, host başına tamamlanmış zincir ajanı, `shouldAttemptChainCompletion()` |
| `src/sources/browser-session.ts` | Chromium yedeği ve `SOURCE_BROWSER_FALLBACK` anahtarı (testlerde kapalı) |
| `src/config/env-spec.ts`, `src/config/env-prompt.ts`, `src/config/env-file.ts`, `scripts/env-setup.ts` | `npm run env:setup` sihirbazı: katalog, karar mantığı, güvenli `.env` yazımı |
| `tests/tls-verification-guard.test.ts`, `tests/env-setup.test.ts`, `tests/tls-chain-completion.test.ts` | Bekçi, sihirbaz ve zincir tamamlama kanıtları |
| `src/db/postgres-store.ts` | `sslConfigFor()` karar tablosu (tek yetkili) |
| `src/db/store.ts` | CA dosyasını okur/doğrular; doğrulamasıza **sessiz düşmez** |
| `src/lib/pg-tls-probe.ts` | Parolasız SSLRequest sondajı, zincir okuma, güven değerlendirmesi |
| `src/lib/tls-diagnosis.ts` | Tanı karar tablosu ve eylem listesi |
| `scripts/db-tls-doctor.ts` | `npm run db:tls-doctor` |
| `tests/postgres-tls-config.test.ts`, `tests/db-tls-doctor.test.ts` | Gerçek TLS el sıkışmasıyla kanıt |
