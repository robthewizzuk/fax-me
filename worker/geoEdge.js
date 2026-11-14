/**
 * Edge-safe Country Calling Formats & Geolocation Helpers (zero node:crypto / geoip-lite).
 */

export const COUNTRY_FORMATS = {
  US: { name: 'United States', flag: '🇺🇸', code: '1', tone: 'na', gen: (r) => `+1 (${pick(r, ['212','310','415','312','617','206','512','305'])}) 555-${pad(r(100, 199), 4)}` },
  CA: { name: 'Canada', flag: '🇨🇦', code: '1', tone: 'na', gen: (r) => `+1 (${pick(r, ['416','604','514','403','613'])}) 555-${pad(r(100, 199), 4)}` },
  GB: { name: 'United Kingdom', flag: '🇬🇧', code: '44', tone: 'uk', gen: (r) => `+44 20 7946 ${pad(r(0, 999), 4)}` },
  IE: { name: 'Ireland', flag: '🇮🇪', code: '353', tone: 'uk', gen: (r) => `+353 1 655 ${pad(r(1000, 9999), 4)}` },
  DE: { name: 'Germany', flag: '🇩🇪', code: '49', tone: 'eu', gen: (r) => `+49 30 901820-${pad(r(100, 999), 3)}` },
  FR: { name: 'France', flag: '🇫🇷', code: '33', tone: 'eu', gen: (r) => `+33 1 42 68 55 ${pad(r(10, 99), 2)}` },
  ES: { name: 'Spain', flag: '🇪🇸', code: '34', tone: 'eu', gen: (r) => `+34 91 555 ${pad(r(10, 99), 2)} ${pad(r(10, 99), 2)}` },
  IT: { name: 'Italy', flag: '🇮🇹', code: '39', tone: 'eu', gen: (r) => `+39 06 5550 ${pad(r(1000, 9999), 4)}` },
  NL: { name: 'Netherlands', flag: '🇳🇱', code: '31', tone: 'eu', gen: (r) => `+31 20 555 ${pad(r(1000, 9999), 4)}` },
  BE: { name: 'Belgium', flag: '🇧🇪', code: '32', tone: 'eu', gen: (r) => `+32 2 555 ${pad(r(10, 99), 2)} ${pad(r(10, 99), 2)}` },
  CH: { name: 'Switzerland', flag: '🇨🇭', code: '41', tone: 'eu', gen: (r) => `+41 44 555 ${pad(r(10, 99), 2)} ${pad(r(10, 99), 2)}` },
  AT: { name: 'Austria', flag: '🇦🇹', code: '43', tone: 'eu', gen: (r) => `+43 1 555 ${pad(r(1000, 9999), 4)}` },
  SE: { name: 'Sweden', flag: '🇸🇪', code: '46', tone: 'eu', gen: (r) => `+46 8 555 ${pad(r(100, 999), 3)} ${pad(r(10, 99), 2)}` },
  NO: { name: 'Norway', flag: '🇳🇴', code: '47', tone: 'eu', gen: (r) => `+47 21 55 ${pad(r(10, 99), 2)} ${pad(r(10, 99), 2)}` },
  DK: { name: 'Denmark', flag: '🇩🇰', code: '45', tone: 'eu', gen: (r) => `+45 33 55 ${pad(r(10, 99), 2)} ${pad(r(10, 99), 2)}` },
  FI: { name: 'Finland', flag: '🇫🇮', code: '358', tone: 'eu', gen: (r) => `+358 9 555 ${pad(r(1000, 9999), 4)}` },
  PL: { name: 'Poland', flag: '🇵🇱', code: '48', tone: 'eu', gen: (r) => `+48 22 555 ${pad(r(10, 99), 2)} ${pad(r(10, 99), 2)}` },
  PT: { name: 'Portugal', flag: '🇵🇹', code: '351', tone: 'eu', gen: (r) => `+351 21 555 ${pad(r(1000, 9999), 4)}` },
  CZ: { name: 'Czechia', flag: '🇨🇿', code: '420', tone: 'eu', gen: (r) => `+420 225 550 ${pad(r(100, 999), 3)}` },
  GR: { name: 'Greece', flag: '🇬🇷', code: '30', tone: 'eu', gen: (r) => `+30 21 0555 ${pad(r(1000, 9999), 4)}` },
  JP: { name: 'Japan', flag: '🇯🇵', code: '81', tone: 'jp', gen: (r) => `+81 3-5555-${pad(r(1000, 9999), 4)}` },
  KR: { name: 'South Korea', flag: '🇰🇷', code: '82', tone: 'jp', gen: (r) => `+82 2-555-${pad(r(1000, 9999), 4)}` },
  AU: { name: 'Australia', flag: '🇦🇺', code: '61', tone: 'uk', gen: (r) => `+61 2 5550 ${pad(r(1000, 9999), 4)}` },
  NZ: { name: 'New Zealand', flag: '🇳🇿', code: '64', tone: 'uk', gen: (r) => `+64 4 555 ${pad(r(1000, 9999), 4)}` },
  BR: { name: 'Brazil', flag: '🇧🇷', code: '55', tone: 'na', gen: (r) => `+55 11 5555-${pad(r(1000, 9999), 4)}` },
  MX: { name: 'Mexico', flag: '🇲🇽', code: '52', tone: 'na', gen: (r) => `+52 55 5555 ${pad(r(1000, 9999), 4)}` },
  IN: { name: 'India', flag: '🇮🇳', code: '91', tone: 'uk', gen: (r) => `+91 11 5550 ${pad(r(1000, 9999), 4)}` },
  SG: { name: 'Singapore', flag: '🇸🇬', code: '65', tone: 'uk', gen: (r) => `+65 6555 ${pad(r(1000, 9999), 4)}` },
};

const TZ_TO_COUNTRY = {
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Berlin': 'DE', 'Europe/Paris': 'FR',
  'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE',
  'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL', 'Europe/Lisbon': 'PT',
  'Europe/Prague': 'CZ', 'Europe/Athens': 'GR', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
  'Asia/Singapore': 'SG', 'Asia/Kolkata': 'IN', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU',
  'Pacific/Auckland': 'NZ', 'America/Toronto': 'CA', 'America/Vancouver': 'CA',
  'America/Sao_Paulo': 'BR', 'America/Mexico_City': 'MX',
};

export const EDGE_BOTS = [
  {
    id: 'bot-echo',
    display_number: '+1 (555) 010-0000',
    dial_digits: '15550100000',
    shortDial: '5550100000',
    country: 'US',
    country_name: 'Loopback Test Lab',
    flag: '🔁',
    display_name: 'ECHO-BOT (Self Test)',
    isBot: true,
    online: true,
  },
  {
    id: 'bot-megacorp',
    display_number: '+1 (555) 010-1994',
    dial_digits: '15550101994',
    shortDial: '5550101994',
    country: 'US',
    country_name: 'MegaCorp Tower (1994)',
    flag: '🏢',
    display_name: 'MEGACORP-HR (1994)',
    isBot: true,
    online: true,
  },
  {
    id: 'bot-mystic',
    display_number: '+1 (555) 010-0777',
    dial_digits: '15550100777',
    shortDial: '5550100777',
    country: 'US',
    country_name: 'Oracle Exchange',
    flag: '🔮',
    display_name: 'MYSTIC-FAX (Fortune)',
    isBot: true,
    online: true,
  },
];

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function randInt(min, max) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return min + (arr[0] % (max - min + 1));
}

function pick(r, list) {
  return list[r(0, list.length - 1)];
}

export function normalizeDigits(str) {
  return String(str || '').replace(/[^\d]/g, '');
}

export function findBotByDigits(digits) {
  if (!digits) return null;
  return (
    EDGE_BOTS.find(
      (b) =>
        b.dial_digits === digits ||
        b.shortDial === digits ||
        (digits.length >= 7 && b.dial_digits.endsWith(digits))
    ) || null
  );
}

export function getCountryMeta(countryCode) {
  const cc = (countryCode || 'US').toUpperCase();
  const entry = COUNTRY_FORMATS[cc];
  if (entry) {
    return { countryName: entry.name, flag: entry.flag, dialCode: entry.code, toneProfile: entry.tone };
  }
  return { countryName: cc, flag: '🌐', dialCode: '888', toneProfile: 'eu' };
}

export function generateFaxNumberForCountry(countryCode) {
  const cc = (countryCode || 'US').toUpperCase();
  const entry = COUNTRY_FORMATS[cc];
  const displayNumber = entry
    ? entry.gen(randInt)
    : `+888 ${pad(randInt(100, 999), 3)}-${pad(randInt(1000, 9999), 4)}`;
  return {
    displayNumber,
    dialDigits: normalizeDigits(displayNumber),
    country: cc,
    ...getCountryMeta(cc),
  };
}

export function geolocateEdgeRequest(request, tzHint = '') {
  const cfCountry = request.headers.get('x-edge-country') || request.headers.get('cf-ipcountry') || '';
  const cfCity = request.headers.get('x-edge-city') || '';
  const cfIp = request.headers.get('x-edge-ip') || request.headers.get('cf-connecting-ip') || '127.0.0.1';

  if (/^[A-Z]{2}$/i.test(cfCountry) && cfCountry.toUpperCase() !== 'XX' && cfCountry.toUpperCase() !== 'T1') {
    const cc = cfCountry.toUpperCase();
    return {
      ip: cfIp,
      country: cc,
      city: cfCity,
      source: 'cloudflare-edge-geo',
      ...getCountryMeta(cc),
    };
  }

  let fallbackCountry = 'US';
  if (tzHint && TZ_TO_COUNTRY[tzHint]) {
    fallbackCountry = TZ_TO_COUNTRY[tzHint];
  } else {
    const al = request.headers.get('accept-language') || '';
    const match = al.match(/[a-z]{2}-([A-Z]{2})/);
    if (match && COUNTRY_FORMATS[match[1]]) fallbackCountry = match[1];
  }

  return {
    ip: cfIp,
    country: fallbackCountry,
    city: cfCity || 'Cloudflare Edge',
    source: 'timezone-fallback',
    ...getCountryMeta(fallbackCountry),
  };
}
