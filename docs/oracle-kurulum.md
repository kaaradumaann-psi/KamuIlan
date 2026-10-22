# Oracle Cloud kurulumu (API + worker)

Mimari: arayüz Cloudflare Workers'ta (`wrangler.jsonc`); API ve worker Oracle Always Free
sunucusunda systemd ile çalışır. API dışarıya **Cloudflare Tunnel** ile çıkar
(`api.kamuilan.halilkaraduman.com.tr` → `http://127.0.0.1:3000`); sunucuda SSH dışında gelen
port açılmaz, TLS'i Cloudflare yapar. Sırlar repoya ve cloud-init'e girmez.

## 1. Hesap (kullanıcı)

- Cloud Account Name: `kamuilan` · Home Region: **Germany Central (Frankfurt)** (sonradan değişmez).
- Pay As You Go'ya **yükseltme** (ücretsiz kota aşımı faturalanır).

## 2. Sunucu (konsol → Compute → Instances → Create instance)

| Alan | Değer |
|---|---|
| Name | `kamuilan-1` |
| Image | Canonical **Ubuntu 24.04** (aarch64 sürümü kendiliğinden gelir) |
| Shape | Change shape → **Ampere** → `VM.Standard.A1.Flex`, **2 OCPU / 12 GB** ("Always Free-eligible" etiketi görünmeli) |
| Networking | Yeni VCN + **public subnet**, "Assign a public IPv4 address" açık |
| SSH keys | "Paste public keys" → `~/.ssh/kamuilan_oracle.pub` içeriği |
| Boot volume | Varsayılan (≈47 GB, ücretsiz 200 GB içinde) |
| Advanced → Management | "Paste cloud-init script" → `infra/oracle/cloud-init.yaml` içeriği |

"Out of host capacity" hatası: başka bir Availability Domain seç ya da birkaç saat sonra dene.
Oluşunca **Public IP**'yi not et. Kurulum ilk açılışta ~5–10 dk sürer;
bitti mi: `ssh -i ~/.ssh/kamuilan_oracle ubuntu@<IP> test -f /var/lib/cloud/instance/kamuilan-hazir && echo hazir`.

## 3. Cloudflare Tunnel (kullanıcı, ücretsiz)

Zero Trust → Networks → Tunnels → Create tunnel → Cloudflared → ad `kamuilan-api`.
Public hostname: `api.kamuilan.halilkaraduman.com.tr` → Service `HTTP` → `127.0.0.1:3000`.
Gösterilen jetonu **sohbete yazmadan** Windows'ta kullanıcı ortam değişkenine koy:
`[Environment]::SetEnvironmentVariable('CLOUDFLARE_TUNNEL_TOKEN', '<jeton>', 'User')`.

## 4. Ortam dosyası + tünel servisi

```powershell
powershell -File infra\oracle\ortam-gonder.ps1 -Sunucu <IP>
```

Kullanıcı ortam değişkenlerinden `/etc/kamuilan/kamuilan.env` (0640) üretir, Supabase CA'yı
koyar, `CLOUDFLARE_TUNNEL_TOKEN` varsa tünel servisini kurar. Hiçbir değeri ekrana yazmaz;
uygulama sırları sunucuda varsa korunur. API `HOST=127.0.0.1` dinler, `TRUST_PROXY=loopback`.

## 5. İlk çalıştırma (onaylı adımlar)

```bash
ssh -i ~/.ssh/kamuilan_oracle ubuntu@<IP>
cd /opt/kamuilan/app
sudo -u kamuilan sh -c 'set -a; . /etc/kamuilan/kamuilan.env; set +a; npm run env:check && npm run db:tls-doctor'
sudo systemctl start kamuilan-api kamuilan-worker
curl -s http://127.0.0.1:3000/api/health
# İlk yönetici (parola yalnız sunucuda girilir):
sudo -u kamuilan sh -c 'set -a; . /etc/kamuilan/kamuilan.env; set +a; read -r -p "E-posta: " ADMIN_EMAIL; stty -echo; read -r -p "Parola: " ADMIN_PASSWORD; stty echo; echo; export ADMIN_EMAIL ADMIN_PASSWORD; npm run seed:admin'
```

Veritabanı şeması Frankfurt'ta zaten kurulu (`db:indexes` + `db:migrate`, 22.10.2026).

## 6. Cloudflare arayüzü

`npx wrangler secret put API_ORIGIN` → `https://api.kamuilan.halilkaraduman.com.tr`
(ya da panelde Worker → Settings → Variables). Ardından `npm run telegram:webhook -- set`.

## Bakım

- Güncelleme: `sudo kamuilan-guncelle` (git pull + npm ci + yeniden başlatma).
- Loglar: `journalctl -u kamuilan-worker -f` · `/var/log/kamuilan/*.log`
- Durum: `sudo -u kamuilan sh -c 'cd /opt/kamuilan/app; set -a; . /etc/kamuilan/kamuilan.env; set +a; npm run durum -- --log /var/log/kamuilan/api.log --log /var/log/kamuilan/worker.log'`
- Güvenlik güncellemeleri `unattended-upgrades` ile kendiliğinden kurulur.
