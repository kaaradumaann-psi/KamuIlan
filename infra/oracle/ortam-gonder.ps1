<#
  Kamuİlan üretim ortam dosyasını bu bilgisayardaki KULLANICI ortam değişkenlerinden
  üretir ve SSH ile sunucuya /etc/kamuilan/kamuilan.env olarak koyar (root:kamuilan 0640).
  Hiçbir değer ekrana yazılmaz. Geçici dosya iş bitince silinir.

  Kullanım:  powershell -File infra\oracle\ortam-gonder.ps1 -Sunucu <genel-IP>
  Gerekenler (Kullanıcı ortam değişkenleri): POSTGRES_URL, RESEND_API_KEY, EMAIL_FROM,
  TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME; isteğe bağlı CLOUDFLARE_TUNNEL_TOKEN.
  Uygulama sırları (APP_SECRET vb.) sunucuda zaten varsa korunur, yoksa yeni üretilir.
#>
param(
  [Parameter(Mandatory = $true)][string]$Sunucu,
  [string]$Anahtar = "$HOME\.ssh\kamuilan_oracle",
  [string]$Kullanici = 'ubuntu'
)
$ErrorActionPreference = 'Stop'
$u = [Environment]::GetEnvironmentVariables('User')
foreach ($ad in 'POSTGRES_URL', 'RESEND_API_KEY', 'EMAIL_FROM', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME') {
  if (-not $u[$ad]) { throw "Kullanıcı ortam değişkeni eksik: $ad" }
}
$ca = Join-Path $PSScriptRoot '..\..\certs\supabase-ca.crt'
if (-not (Test-Path $ca)) { throw "Supabase CA dosyası yok: $ca" }

function Yeni-Sir {
  $b = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$ssh = @('-i', $Anahtar, '-o', 'StrictHostKeyChecking=accept-new', "$Kullanici@$Sunucu")
# Var olan sırları koru (oturumlar ve doğrulama bağlantıları geçersizleşmesin).
$mevcut = @{}
$eski = & ssh @ssh "sudo grep -E '^(APP_SECRET|EMAIL_VERIFICATION_SECRET|TELEGRAM_WEBHOOK_SECRET)=' /etc/kamuilan/kamuilan.env 2>/dev/null || true"
foreach ($satir in @($eski)) { if ($satir -match "^([A-Z_]+)='?([^']+)'?$") { $mevcut[$Matches[1]] = $Matches[2] } }
foreach ($ad in 'APP_SECRET', 'EMAIL_VERIFICATION_SECRET', 'TELEGRAM_WEBHOOK_SECRET') {
  if (-not $mevcut[$ad]) { $mevcut[$ad] = Yeni-Sir }
}

$ayar = [ordered]@{
  NODE_ENV                  = 'production'
  APP_BASE_URL              = 'https://kamuilan.halilkaraduman.com.tr'
  APP_DOMAIN                = 'kamuilan.halilkaraduman.com.tr'
  PORT                      = '3000'
  APP_SECRET                = $mevcut['APP_SECRET']
  EMAIL_VERIFICATION_SECRET = $mevcut['EMAIL_VERIFICATION_SECRET']
  DATABASE_DRIVER           = 'supabase'
  POSTGRES_URL              = $u['POSTGRES_URL']
  POSTGRES_MAX_CONNECTIONS  = '5'
  POSTGRES_SSL_CA_FILE      = '/opt/kamuilan/app/certs/supabase-ca.crt'
  EMAIL_PROVIDER            = 'resend'
  RESEND_API_KEY            = $u['RESEND_API_KEY']
  EMAIL_FROM                = $u['EMAIL_FROM']
  TELEGRAM_BOT_TOKEN        = $u['TELEGRAM_BOT_TOKEN']
  TELEGRAM_BOT_USERNAME     = $u['TELEGRAM_BOT_USERNAME']
  TELEGRAM_WEBHOOK_SECRET   = $mevcut['TELEGRAM_WEBHOOK_SECRET']
  TRUST_PROXY               = 'loopback'
  DOCS_ENABLED              = '0'
  ALLOW_PUBLIC_REGISTRATION = '0'
  PUBLIC_LISTINGS_ENABLED   = '0'
  SCHEDULER_ENABLED         = '1'
  SOURCE_LIVE_FETCH         = '1'
  SOURCE_TERMS_POLICY       = 'enforce'
  SOURCE_BROWSER_FALLBACK   = '0'
  OCR_ENABLED               = '0'
  LLM_CLASSIFIER_ENABLED    = '0'
}
# Değerler tek tırnakta: hem systemd EnvironmentFile hem `set -a; . dosya` aynı şekilde okur
# (EMAIL_FROM'daki "<...>" kabukta yönlendirme sanılmasın).
$satirlar = foreach ($k in $ayar.Keys) {
  $v = [string]$ayar[$k]
  if ($v.Contains("'") -or $v.Contains("`n")) { throw "$k değeri tek tırnak/satır sonu içeriyor" }
  "$k='$v'"
}
$icerik = $satirlar -join "`n"

$gecici = Join-Path ([IO.Path]::GetTempPath()) ("kamuilan-" + [guid]::NewGuid() + '.env')
try {
  [IO.File]::WriteAllText($gecici, ($icerik -replace "`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))
  & scp -q -i $Anahtar -o StrictHostKeyChecking=accept-new $gecici $ca "${Kullanici}@${Sunucu}:/tmp/"
  if ($LASTEXITCODE -ne 0) { throw 'scp başarısız' }
  $adEnv = Split-Path $gecici -Leaf
  & ssh @ssh "sudo install -o root -g kamuilan -m 0640 /tmp/$adEnv /etc/kamuilan/kamuilan.env && sudo install -o kamuilan -g kamuilan -m 0644 /tmp/supabase-ca.crt /opt/kamuilan/app/certs/supabase-ca.crt && rm -f /tmp/$adEnv /tmp/supabase-ca.crt && echo 'ortam dosyası yerinde'"
  if ($LASTEXITCODE -ne 0) { throw 'sunucuya yerleştirme başarısız' }
  if ($u['CLOUDFLARE_TUNNEL_TOKEN']) {
    # Jeton komut satırında görünmesin diye stdin'den okunur.
    $u['CLOUDFLARE_TUNNEL_TOKEN'] | & ssh @ssh "read -r T && (sudo cloudflared service uninstall >/dev/null 2>&1 || true) && sudo cloudflared service install `"`$T`" >/dev/null 2>&1 && echo 'tünel servisi kuruldu'"
  }
} finally {
  if (Test-Path $gecici) { Remove-Item $gecici -Force }
}
