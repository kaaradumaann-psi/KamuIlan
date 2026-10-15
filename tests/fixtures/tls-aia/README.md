# Sabit TLS test sertifikaları (AIA zincir tamamlama)

`tests/tls-chain-completion.test.ts` bu zinciri kullanır:

```
leaf.crt (site.example.gov.tr, AIA → http://aia.example.gov.tr/ara-sertifika.der)
  └── intermediate.crt (Test Ara CA)
        └── root.crt (Test Kok CA, kendinden imzalı)
```

- `unrelated.crt` — zincirle ilgisi olmayan CA: AIA cevabı ele geçirilse bile
  zincire EKLENMEMELİ.
- `nonca.crt` — kök tarafından imzalanmış ama `CA:FALSE`: ara halka olamaz.
- Geçerlilik: 2026-10-15 → 2036-10-12 (10 yıl). Süresi dolarsa aynı adlarla
  yeniden üretilmelidir (aşağıdaki komutlar).

**Bu anahtarlar yalnızca test içindir.** Kendinden imzalı bir test köküne
bağlıdır; hiçbir gerçek alan adı için geçerli değildir, hiçbir güven deposuna
kurulmamıştır ve bir sır taşımaz.

## Yeniden üretme

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout root.key -out root.crt -days 3650 \
  -subj '/CN=Test Kok CA' -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -newkey rsa:2048 -nodes -keyout intermediate.key -out intermediate.csr -subj '/CN=Test Ara CA'
printf 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n' > int.ext
openssl x509 -req -in intermediate.csr -CA root.crt -CAkey root.key -CAcreateserial \
  -out intermediate.crt -days 3650 -extfile int.ext
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:site.example.gov.tr\nauthorityInfoAccess=CA Issuers;URI:http://aia.example.gov.tr/ara-sertifika.der\n' > leaf.ext
openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj '/CN=site.example.gov.tr'
openssl x509 -req -in leaf.csr -CA intermediate.crt -CAkey intermediate.key -CAcreateserial \
  -out leaf.crt -days 3650 -extfile leaf.ext
openssl req -x509 -newkey rsa:2048 -nodes -out unrelated.crt -days 3650 -subj '/CN=Alakasiz CA' \
  -addext 'basicConstraints=critical,CA:TRUE'
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n' > nonca.ext
openssl req -newkey rsa:2048 -nodes -keyout nonca.key -out nonca.csr -subj '/CN=Test Ara CA'
openssl x509 -req -in nonca.csr -CA root.crt -CAkey root.key -CAcreateserial \
  -out nonca.crt -days 3650 -extfile nonca.ext
rm -f *.csr *.srl int.ext leaf.ext nonca.ext unrelated.key nonca.key
```
