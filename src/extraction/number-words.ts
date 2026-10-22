/** Türkçe sayı sözcükleri (yazıyla), birleşik ya da ayrı: "onbir", "yirmi beş", "yüz". */
const NUMBER_WORDS: readonly [string, number][] = [
  ['altmış', 60], ['yetmiş', 70], ['seksen', 80], ['doksan', 90], ['yirmi', 20], ['otuz', 30],
  ['kırk', 40], ['elli', 50], ['sekiz', 8], ['dokuz', 9], ['dört', 4], ['altı', 6], ['yedi', 7],
  ['bir', 1], ['iki', 2], ['üç', 3], ['beş', 5], ['bin', 1_000], ['yüz', 100], ['on', 10],
];

/** "Onbir" → 11, "yirmi beş" → 25; tanınmayan sözcükte null. */
export function parseTurkishNumberWords(raw: string): number | null {
  let rest = raw.toLocaleLowerCase('tr').replace(/\s+/g, '');
  if (!rest) return null;
  let total = 0;
  let current = 0;
  while (rest) {
    const token = NUMBER_WORDS.find(([word]) => rest.startsWith(word));
    if (!token) return null;
    const [word, value] = token;
    rest = rest.slice(word.length);
    if (value === 100) current = (current || 1) * 100;
    else if (value === 1_000) {
      total += (current || 1) * 1_000;
      current = 0;
    } else current += value;
  }
  return total + current;
}
