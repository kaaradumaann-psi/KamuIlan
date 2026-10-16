/*
 * Kamuİlan — tek komutluk güvenli durum kontrolü (Windows/PowerShell uyumlu).
 *
 * Amaç: kullanıcının bilgisayarında denetim için gereken gerçekleri toplamak.
 * API anahtarı, veritabanı parolası, APP_SECRET gibi SIRLAR YAZDIRILMAZ; yalnızca
 * "tanımlı / boş" durumu gösterilir.
 *
 * Çalıştırma (proje kökünde):
 *   node durum-kontrol.js
 *
 * Node dışında hiçbir bağımlılık kullanmaz; `npm install` gerektirmez.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

function sh(command) {
  try {
    return cp.execSync(command, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).toString().trim();
  } catch {
    return null;
  }
}

function readEnvFile() {
  const file = path.join(process.cwd(), '.env');
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    values[key] = value;
  }
  return values;
}

const packagePath = path.join(process.cwd(), 'package.json');
const pkg = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, 'utf8')) : null;
const fileEnv = readEnvFile();

// Sır İÇERMEYEN ortam değişkenleri (durum bilgisi verir).
const STATE_KEYS = [
  'DATABASE_DRIVER',
  'SOURCE_LIVE_FETCH',
  'SCHEDULER_ENABLED',
  'AI_ASSISTANT_ENABLED',
  'LLM_CLASSIFIER_ENABLED',
  'LLM_RETRY_MAX',
  'LLM_TIMEOUT_MS',
  'LLM_MAX_CALLS_PER_RUN',
  'LLM_DAILY_CALL_LIMIT',
  'SCAN_INTERVAL_MINUTES',
];
// Sır SAYILAN değişkenler: yalnızca "var/yok" olarak raporlanır, değeri asla yazdırılmaz.
const SECRET_KEYS = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_CLASSIFIER_MODEL',
  'RESEND_API_KEY',
  'SMTP_HOST',
  'TELEGRAM_BOT_TOKEN',
  'APP_SECRET',
];
const COST_KEYS = ['LLM_COST_USD_PER_MTOK_INPUT', 'LLM_COST_USD_PER_MTOK_OUTPUT'];

function valueOf(key) {
  const fromProcess = process.env[key];
  if (typeof fromProcess === 'string' && fromProcess.trim() !== '') return fromProcess.trim();
  const fromFile = fileEnv[key];
  return typeof fromFile === 'string' && fromFile !== '' ? fromFile : '';
}

function state(key) {
  const value = valueOf(key);
  return { deger: value || '(boş)', kaynak: process.env[key] ? 'ortam' : fileEnv[key] ? '.env' : 'yok' };
}

function presence(keys) {
  const filled = [];
  const empty = [];
  for (const key of keys) (valueOf(key) ? filled : empty).push(key);
  return { dolu: filled, bos: empty };
}

const git = {
  dal: sh('git branch --show-current'),
  commit: sh('git rev-parse --short HEAD'),
  commitTarihi: sh('git log -1 --date=short --pretty=%ad'),
  degisenDosyaSayisi: (() => {
    const status = sh('git status --porcelain');
    return status === null ? null : status.split(/\r?\n/).filter(Boolean).length;
  })(),
};

const fingerprints = {};
for (const relative of [
  'src/classification/engine.ts',
  'src/ai/classifier.ts',
  'src/ai/suggest.ts',
  'src/ai/candidates.ts',
  'src/ingest/sanitize.ts',
  'src/db/repos/jobs.ts',
]) {
  const file = path.join(process.cwd(), relative);
  fingerprints[relative] = fs.existsSync(file)
    ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
    : 'DOSYA YOK';
}

const dataDir = path.join(process.cwd(), 'data');
const mailDir = path.join(dataDir, 'mail');

const report = {
  tarih: new Date().toISOString(),
  makine: { platform: process.platform, node: process.version, npm: sh('npm -v'), cwd: process.cwd() },
  proje: pkg ? { ad: pkg.name, surum: pkg.version, nodeGereksinimi: pkg.engines && pkg.engines.node } : 'package.json okunamadı',
  git,
  envDosyasiVar: fs.existsSync(path.join(process.cwd(), '.env')),
  durumDegiskenleri: Object.fromEntries(STATE_KEYS.map((key) => [key, state(key)])),
  sirDurumu: presence(SECRET_KEYS),
  maliyetDurumu: presence(COST_KEYS),
  veri: {
    dataKlasoruVar: fs.existsSync(dataDir),
    gelistirmePostaKutusu: fs.existsSync(mailDir) ? path.join('data', 'mail') : 'yok',
  },
  dosyaParmakIzi: fingerprints,
  notlar: [
    'Bu çıktıda hiçbir API anahtarı, parola veya bağlantı dizesi değeri YOKTUR.',
    'Dosya parmak izleri, bu bilgisayardaki kod ile uzak depodaki kodun aynı olup olmadığını karşılaştırmak içindir.',
    'GEÇICI KOMUT DEĞİL: bu dosya depoya eklenmek üzere hazırlandı, silmek zorunda değilsiniz.',
  ],
};

process.stdout.write(JSON.stringify(report, null, 1) + os.EOL);
