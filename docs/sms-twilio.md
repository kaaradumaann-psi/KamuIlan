# SMS bildirimleri (Twilio) — kurulum ve Türkiye notları

Durum: kod hazır, **varsayılan KAPALI** (`SMS_ENABLED=0`). Gerçek gönderim yapılmadı/test edilmedi; testler sahte `fetch` kullanır.

## Ne gönderilir
- Yalnızca iki düşük hacimli tür: **takip edilen ilanda değişiklik/iptal** ve **son başvuru hatırlatması** (3 ve 1 gün kala, İstanbul günü).
- Yeni ilan eşleşmeleri SMS ile gönderilmez (maliyet ve istenmeyen ileti riski).
- Koşul: `SMS_ENABLED=1` + Twilio ayarları + kullanıcı tercihinde `sms.enabled=true`, E.164 numara ve **açık rıza zamanı** (`sms.consentAt`). Rıza geri alınırsa bekleyen SMS gönderim anında bastırılır.
- Numara outbox'a yazılmaz (gönderimde tercih kaydından okunur); loglarda maskelenir. Auth Token hiçbir loga/hata metnine yazılmaz.

## Ortam değişkenleri
| Anahtar | Açıklama |
|---|---|
| `SMS_ENABLED` | `1` olmadıkça hiçbir SMS kuyruğa alınmaz/gönderilmez |
| `TWILIO_ACCOUNT_SID` | `AC…` |
| `TWILIO_AUTH_TOKEN` | gizli |
| `TWILIO_FROM` | E.164 numara veya kayıtlı alfanümerik gönderen |
| `TWILIO_MESSAGING_SERVICE_SID` | `MG…`; tanımlıysa `TWILIO_FROM` yerine kullanılır |
| `TWILIO_API_BASE_URL` | yalnız test/vekil için |

## Türkiye gönderim koşulları — DOĞRULANMASI GEREKİR
Aşağıdakiler genel bilgidir, **kesin değildir** ve Twilio kuralları değişebilir. Canlıya almadan önce Twilio'nun **Turkey SMS Guidelines** sayfası (twilio.com/en-us/guidelines/tr/sms) ve hesap konsolu ile doğrulanmalıdır:

- **Deneme (trial) hesabı** yalnızca konsolda *doğrulanmış* (Verified Caller IDs) numaralara gönderebilir; diğer numaralar `21608` hatası verir (kod bunu kalıcı hata sayar, yeniden denemez).
- Deneme hesabı mesajlarının başına Twilio bir **"Sent from your Twilio trial account"** öneki ekler.
- Türkiye'de **alfanümerik gönderen adı** (ör. `KAMUILAN`) için ön kayıt/onay gerektiği, kayıtsız gönderenin operatörce değiştirilebileceği veya engellenebileceği bilinmektedir; sayısal uluslararası gönderenle teslimin garanti olmadığı belirtilir. Kesin gereksinim ve süreler Twilio sayfasından teyit edilmelidir.
- Türkiye'de ticari elektronik ileti mevzuatı (İYS kaydı vb.) bilgilendirme/ticari ayrımına göre uygulanabilir; bildirimlerin "bilgilendirme" sayılıp sayılmadığı hukuken değerlendirilmelidir.
- Konsolda **Geo Permissions → Türkiye** açık olmalıdır (kapalıysa `21408`).
- Türkçe karakter UCS-2 kodlamasına geçirir (segment başına ~70 karakter). Mesaj 320 karakterle sınırlandı; yine de 3-5 segment olabilir → ücret.

## Kullanıcı eylemi gerekenler
1. Twilio hesabı açmak, (gerekirse) ücretli hesaba geçmek, Türkiye geo-permission'ı açmak.
2. Gönderen numara/alfanümerik ad ya da Messaging Service oluşturmak; Türkiye kaydı.
3. Panelde telefon + açık rıza alan arayüz/API (henüz YOK — tercih kaydındaki `sms` alanı repo düzeyinde hazır; `normalizePhoneE164` ile doğrulanmalı).
4. Deneme hesabında kendi numarasını doğrulayıp tek bir test SMS'i ile uçtan uca denemek.
