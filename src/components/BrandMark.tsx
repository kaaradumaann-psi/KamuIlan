/**
 * Kamuİlan işareti — favicon (`public/favicon.svg`) ile BİREBİR aynı çizim.
 *
 * Koyu kare + halka + dört kısa çizgi + mavi merkez noktası. Giriş ekranı,
 * yan menü, üst çubuk, bilgi sayfaları ve alt bilgi bu tek bileşeni kullanır;
 * böylece tarayıcı sekmesindeki simge ile sayfadaki logo hiç ayrışmaz.
 * Renkler sabittir (favicon da sabit renklidir); kapsayıcı yalnızca boyut verir.
 */
export const BRAND_INK = '#111213';
export const BRAND_LINE = '#f2f2f3';
export const BRAND_DOT = '#0a84ff';

export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill={BRAND_INK} />
      <circle cx="32" cy="32" r="15" fill="none" stroke={BRAND_LINE} strokeWidth="4" />
      <path
        d="M32 11v9M32 44v9M11 32h9M44 32h9"
        stroke={BRAND_LINE}
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="32" cy="32" r="5.5" fill={BRAND_DOT} />
    </svg>
  );
}
