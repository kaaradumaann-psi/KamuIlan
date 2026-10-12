/**
 * 81 Turkish provinces (il) with plate codes and search aliases.
 * Used for city extraction from announcement text and for filter option lists.
 */

export interface Province {
  name: string;
  plateCode: number;
  /** Additional spellings that appear in official texts (no diacritics, old names). */
  aliases: string[];
}

export const PROVINCES: readonly Province[] = [
  { name: "Adana", plateCode: 1, aliases: ["Adana"] },
  { name: "Adıyaman", plateCode: 2, aliases: ["Adiyaman"] },
  { name: "Afyonkarahisar", plateCode: 3, aliases: ["Afyonkarahisar"] },
  { name: "Ağrı", plateCode: 4, aliases: ["Agri"] },
  { name: "Aksaray", plateCode: 5, aliases: ["Aksaray"] },
  { name: "Amasya", plateCode: 6, aliases: ["Amasya"] },
  { name: "Ankara", plateCode: 7, aliases: ["Ankara"] },
  { name: "Antalya", plateCode: 8, aliases: ["Antalya"] },
  { name: "Ardahan", plateCode: 9, aliases: ["Ardahan"] },
  { name: "Artvin", plateCode: 10, aliases: ["Artvin"] },
  { name: "Aydın", plateCode: 11, aliases: ["Aydin"] },
  { name: "Balıkesir", plateCode: 12, aliases: ["Balikesir"] },
  { name: "Bartın", plateCode: 13, aliases: ["Bartin"] },
  { name: "Batman", plateCode: 14, aliases: ["Batman"] },
  { name: "Bayburt", plateCode: 15, aliases: ["Bayburt"] },
  { name: "Bilecik", plateCode: 16, aliases: ["Bilecik"] },
  { name: "Bingöl", plateCode: 17, aliases: ["Bingol"] },
  { name: "Bitlis", plateCode: 18, aliases: ["Bitlis"] },
  { name: "Bolu", plateCode: 19, aliases: ["Bolu"] },
  { name: "Burdur", plateCode: 20, aliases: ["Burdur"] },
  { name: "Bursa", plateCode: 21, aliases: ["Bursa"] },
  { name: "Çanakkale", plateCode: 22, aliases: ["Canakkale"] },
  { name: "Çankırı", plateCode: 23, aliases: ["Cankiri"] },
  { name: "Çorum", plateCode: 24, aliases: ["Corum"] },
  { name: "Denizli", plateCode: 25, aliases: ["Denizli"] },
  { name: "Diyarbakır", plateCode: 26, aliases: ["Diyarbakir"] },
  { name: "Düzce", plateCode: 27, aliases: ["Duzce"] },
  { name: "Edirne", plateCode: 28, aliases: ["Edirne"] },
  { name: "Elazığ", plateCode: 29, aliases: ["Elazig"] },
  { name: "Erzincan", plateCode: 30, aliases: ["Erzincan"] },
  { name: "Erzurum", plateCode: 31, aliases: ["Erzurum"] },
  { name: "Eskişehir", plateCode: 32, aliases: ["Eskisehir"] },
  { name: "Gaziantep", plateCode: 33, aliases: ["Gaziantep"] },
  { name: "Giresun", plateCode: 34, aliases: ["Giresun"] },
  { name: "Gümüşhane", plateCode: 35, aliases: ["Gumushane"] },
  { name: "Hakkâri", plateCode: 36, aliases: ["Hakkari"] },
  { name: "Hatay", plateCode: 37, aliases: ["Hatay"] },
  { name: "Iğdır", plateCode: 38, aliases: ["Igdir"] },
  { name: "Isparta", plateCode: 39, aliases: ["Isparta"] },
  { name: "İstanbul", plateCode: 40, aliases: ["Istanbul"] },
  { name: "İzmir", plateCode: 41, aliases: ["Izmir"] },
  { name: "Kahramanmaraş", plateCode: 42, aliases: ["Kahramanmaras"] },
  { name: "Karabük", plateCode: 43, aliases: ["Karabuk"] },
  { name: "Karaman", plateCode: 44, aliases: ["Karaman"] },
  { name: "Kars", plateCode: 45, aliases: ["Kars"] },
  { name: "Kastamonu", plateCode: 46, aliases: ["Kastamonu"] },
  { name: "Kayseri", plateCode: 47, aliases: ["Kayseri"] },
  { name: "Kırıkkale", plateCode: 48, aliases: ["Kirikkale"] },
  { name: "Kırklareli", plateCode: 49, aliases: ["Kirklareli"] },
  { name: "Kırşehir", plateCode: 50, aliases: ["Kirsehir"] },
  { name: "Kilis", plateCode: 51, aliases: ["Kilis"] },
  { name: "Kocaeli", plateCode: 52, aliases: ["Kocaeli"] },
  { name: "Konya", plateCode: 53, aliases: ["Konya"] },
  { name: "Kütahya", plateCode: 54, aliases: ["Kutahya"] },
  { name: "Malatya", plateCode: 55, aliases: ["Malatya"] },
  { name: "Manisa", plateCode: 56, aliases: ["Manisa"] },
  { name: "Mardin", plateCode: 57, aliases: ["Mardin"] },
  { name: "Mersin", plateCode: 58, aliases: ["Mersin"] },
  { name: "Muğla", plateCode: 59, aliases: ["Mugla"] },
  { name: "Muş", plateCode: 60, aliases: ["Mus"] },
  { name: "Nevşehir", plateCode: 61, aliases: ["Nevsehir"] },
  { name: "Niğde", plateCode: 62, aliases: ["Nigde"] },
  { name: "Ordu", plateCode: 63, aliases: ["Ordu"] },
  { name: "Osmaniye", plateCode: 64, aliases: ["Osmaniye"] },
  { name: "Rize", plateCode: 65, aliases: ["Rize"] },
  { name: "Sakarya", plateCode: 66, aliases: ["Sakarya"] },
  { name: "Samsun", plateCode: 67, aliases: ["Samsun"] },
  { name: "Siirt", plateCode: 68, aliases: ["Siirt"] },
  { name: "Sinop", plateCode: 69, aliases: ["Sinop"] },
  { name: "Sivas", plateCode: 70, aliases: ["Sivas"] },
  { name: "Şanlıurfa", plateCode: 71, aliases: ["Sanliurfa"] },
  { name: "Şırnak", plateCode: 72, aliases: ["Sirnak"] },
  { name: "Tekirdağ", plateCode: 73, aliases: ["Tekirdag"] },
  { name: "Tokat", plateCode: 74, aliases: ["Tokat"] },
  { name: "Trabzon", plateCode: 75, aliases: ["Trabzon"] },
  { name: "Tunceli", plateCode: 76, aliases: ["Tunceli"] },
  { name: "Uşak", plateCode: 77, aliases: ["Usak"] },
  { name: "Van", plateCode: 78, aliases: ["Van"] },
  { name: "Yalova", plateCode: 79, aliases: ["Yalova"] },
  { name: "Yozgat", plateCode: 80, aliases: ["Yozgat"] },
  { name: "Zonguldak", plateCode: 81, aliases: ["Zonguldak"] },
];

export const PROVINCE_NAMES: readonly string[] = PROVINCES.map((p) => p.name);

export function findProvince(value: string): Province | undefined {
  const needle = value.trim().toLocaleLowerCase('tr');
  if (!needle) return undefined;
  return PROVINCES.find(
    (p) => p.name.toLocaleLowerCase('tr') === needle || p.aliases.some((a) => a.toLocaleLowerCase('tr') === needle),
  );
}
