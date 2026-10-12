/**
 * Kamuİlan işareti.
 *
 * Aile dili korunur: psikolog ve MMPI işaretlerindeki köşe çerçevesi (parantez
 * motifi) burada bir "ilan tespiti"ni simgeleyen radar halkası ve hedef noktasıyla
 * birleşir. Renk `currentColor`dur; böylece marka işareti bulunduğu metnin
 * rengini alır (açık/koyu zemin sorunsuz).
 */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <path d="M9 3H3v6M17 3h6v6M23 17v6h-6M9 23H3v-6" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="13" cy="13" r="5.2" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      <path d="M13 13 17.4 8.6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="13" cy="13" r="1.9" fill="currentColor" />
    </svg>
  );
}
