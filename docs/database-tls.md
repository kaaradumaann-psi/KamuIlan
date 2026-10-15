# PostgreSQL / Supabase TLS kurulumu

`SELF_SIGNED_CERT_IN_CHAIN`, sunucunun sunduğu zincirin uygulamanın güvendiği
bir kökle doğrulanamadığını gösterir. Tek başına antivirüs/proxy kanıtı değildir.
Supabase uç noktanız projeye özel bir CA da kullanabilir; bu CA'nın Windows veya
Node genel kök deposunda bulunması beklenmez. Sistem deposunu birleştirmek bu
CA'yı kendiliğinden eklemez.

## Windows'ta güvenli çözüm

1. Supabase panosunda **doğru projeyi** açın. **Database Settings → SSL
   Configuration** bölümündeki CA sertifikasını indirin (arayüzde bölüm adı
   değişebilir). Rastgele bir siteden veya başarısız bağlantıdan alınan sunucu
   sertifikasını güvenilir kök olarak kabul etmeyin.
2. Proje klasöründe `certs` klasörünü oluşturun ve indirdiğiniz PEM sertifikasını
   `certs/supabase-ca.crt` adıyla kaydedin. Dosya `-----BEGIN CERTIFICATE-----`
   ile başlayan bir sertifika içermeli; HTML indirme sayfası veya özel anahtar
   olmamalıdır. Dosyayı repoya göndermeniz gerekmez.
3. Proje kökündeki `.env` dosyasına şunları yazın (aynı anahtarlar varsa düzenleyin):

   ```dotenv
   POSTGRES_SSL=true
   POSTGRES_SSL_MODE=verify
   POSTGRES_SSL_CA_FILE=./certs/supabase-ca.crt
   ```

   Windows'ta mutlak yol da kullanılabilir; `.env` içinde `/` tercih edin:
   `POSTGRES_SSL_CA_FILE=C:/Users/Halil/Desktop/kamuradar-main/certs/supabase-ca.crt`.
   Göreli yol, komutun çalıştırıldığı proje klasörüne göredir.
4. `POSTGRES_URL` adresini projenizin **Connect** ekranından kontrol edin.
   Doğrudan bağlantı ve pooler farklı sertifika zincirleri sunabilir; CA seçimini
   kullandığınız uç noktaya göre yapın. URL'ye `sslmode` veya `sslrootcert`
   eklemeyin; bu uygulama TLS kararını yukarıdaki değişkenlerle verir.
5. Açık geliştirme sürecini durdurun ve proje klasöründe çalıştırın:

   ```bat
   node -v
   npm run env:check
   npm run db:migrate
   npm run dev
   ```

   Node en az **22.15.0** olmalıdır. `env:check` yalnızca yapılandırma kontrolüdür;
   gerçek bağlantı ve bakım `db:migrate` sırasında yapılır.

## Kurumsal proxy / antivirüs varsa

CA dosyası olmadan uygulama Node köklerini, işletim sistemi deposunu ve
`NODE_EXTRA_CA_CERTS` dosyasını birleştirir. Windows sistem deposu okunamasa bile
okunabilen varsayılan kökler ve ek CA dosyası korunur.

Ağınız TLS denetimi yapıyorsa kökü yalnızca sistem yöneticinizden doğrulayarak
alın. `.env` içinde `NODE_EXTRA_CA_CERTS=C:/certs/kurum-ca.pem` kullanılabilir;
uygulamanın HTTP ve Postgres güven deposu bunu okur. **`POSTGRES_SSL_CA_FILE`
tanımlıysa Postgres yalnızca o dosyadaki CA'lara güvenir**; ek sistem kökleriyle
birleşmez. Gerekirse doğrulanmış CA'ları içeren bir PEM paketi seçin.

Süre dolması veya sunucu adı uyuşmazlığı CA eklemekle çözülmez: sistem saatini,
sertifika yenilemesini ve bağlantı adresini kontrol edin.

`NODE_TLS_REJECT_UNAUTHORIZED=0`, `POSTGRES_SSL_MODE=no-verify` veya TLS'i kapatmak
çözüm değildir. Uygulama bilinmeyen sertifikayı otomatik indirip güvenilir saymaz.
