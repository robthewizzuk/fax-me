import crypto from 'node:crypto';
import geoip from 'geoip-lite';

/**
 * Country calling formats using safe fictional/drama/reserved local subscriber prefixes
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
  HU: { name: 'Hungary', flag: '🇭🇺', code: '36', tone: 'eu', gen: (r) => `+36 1 555 ${pad(r(1000, 9999), 4)}` },
  RO: { name: 'Romania', flag: '🇷🇴', code: '40', tone: 'eu', gen: (r) => `+40 21 555 ${pad(r(1000, 9999), 4)}` },
  UA: { name: 'Ukraine', flag: '🇺🇦', code: '380', tone: 'eu', gen: (r) => `+380 44 555 ${pad(r(10, 99), 2)} ${pad(r(10, 99), 2)}` },
  TR: { name: 'Turkey', flag: '🇹🇷', code: '90', tone: 'eu', gen: (r) => `+90 212 555 ${pad(r(1000, 9999), 4)}` },
  JP: { name: 'Japan', flag: '🇯🇵', code: '81', tone: 'jp', gen: (r) => `+81 3-5555-${pad(r(1000, 9999), 4)}` },
  KR: { name: 'South Korea', flag: '🇰🇷', code: '82', tone: 'jp', gen: (r) => `+82 2-555-${pad(r(1000, 9999), 4)}` },
  CN: { name: 'China', flag: '🇨🇳', code: '86', tone: 'eu', gen: (r) => `+86 10 5555 ${pad(r(1000, 9999), 4)}` },
  TW: { name: 'Taiwan', flag: '🇹🇼', code: '886', tone: 'jp', gen: (r) => `+886 2 5550 ${pad(r(1000, 9999), 4)}` },
  HK: { name: 'Hong Kong', flag: '🇭🇰', code: '852', tone: 'uk', gen: (r) => `+852 2555 ${pad(r(1000, 9999), 4)}` },
  SG: { name: 'Singapore', flag: '🇸🇬', code: '65', tone: 'uk', gen: (r) => `+65 6555 ${pad(r(1000, 9999), 4)}` },
  IN: { name: 'India', flag: '🇮🇳', code: '91', tone: 'uk', gen: (r) => `+91 11 5550 ${pad(r(1000, 9999), 4)}` },
  AU: { name: 'Australia', flag: '🇦🇺', code: '61', tone: 'uk', gen: (r) => `+61 2 5550 ${pad(r(1000, 9999), 4)}` },
  NZ: { name: 'New Zealand', flag: '🇳🇿', code: '64', tone: 'uk', gen: (r) => `+64 4 555 ${pad(r(1000, 9999), 4)}` },
  BR: { name: 'Brazil', flag: '🇧🇷', code: '55', tone: 'na', gen: (r) => `+55 11 5555-${pad(r(1000, 9999), 4)}` },
  MX: { name: 'Mexico', flag: '🇲🇽', code: '52', tone: 'na', gen: (r) => `+52 55 5555 ${pad(r(1000, 9999), 4)}` },
  AR: { name: 'Argentina', flag: '🇦🇷', code: '54', tone: 'na', gen: (r) => `+54 11 5555-${pad(r(1000, 9999), 4)}` },
  CL: { name: 'Chile', flag: '🇨🇱', code: '56', tone: 'na', gen: (r) => `+56 2 2555 ${pad(r(1000, 9999), 4)}` },
  CO: { name: 'Colombia', flag: '🇨🇴', code: '57', tone: 'na', gen: (r) => `+57 601 555 ${pad(r(1000, 9999), 4)}` },
  ZA: { name: 'South Africa', flag: '🇿🇦', code: '27', tone: 'uk', gen: (r) => `+27 11 555 ${pad(r(1000, 9999), 4)}` },
  AE: { name: 'UAE', flag: '🇦🇪', code: '971', tone: 'eu', gen: (r) => `+971 4 555 ${pad(r(1000, 9999), 4)}` },
  SA: { name: 'Saudi Arabia', flag: '🇸🇦', code: '966', tone: 'eu', gen: (r) => `+966 11 555 ${pad(r(1000, 9999), 4)}` },
  IL: { name: 'Israel', flag: '🇮🇱', code: '972', tone: 'eu', gen: (r) => `+972 3-555-${pad(r(1000, 9999), 4)}` },
  PH: { name: 'Philippines', flag: '🇵🇭', code: '63', tone: 'na', gen: (r) => `+63 2 8555 ${pad(r(1000, 9999), 4)}` },
  TH: { name: 'Thailand', flag: '🇹🇭', code: '66', tone: 'jp', gen: (r) => `+66 2 555 ${pad(r(1000, 9999), 4)}` },
  MY: { name: 'Malaysia', flag: '🇲🇾', code: '60', tone: 'uk', gen: (r) => `+60 3-5555 ${pad(r(1000, 9999), 4)}` },
  ID: { name: 'Indonesia', flag: '🇮🇩', code: '62', tone: 'eu', gen: (r) => `+62 21 555 ${pad(r(1000, 9999), 4)}` },
  VN: { name: 'Vietnam', flag: '🇻🇳', code: '84', tone: 'eu', gen: (r) => `+84 24 3555 ${pad(r(1000, 9999), 4)}` },
};

const TZ_TO_COUNTRY = {
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Berlin': 'DE', 'Europe/Paris': 'FR',
  'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE',
  'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL', 'Europe/Lisbon': 'PT',
  'Europe/Prague': 'CZ', 'Europe/Athens': 'GR', 'Europe/Budapest': 'HU', 'Europe/Bucharest': 'RO',
  'Europe/Kyiv': 'UA', 'Europe/Istanbul': 'TR', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN', 'Asia/Taipei': 'TW', 'Asia/Hong_Kong': 'HK', 'Asia/Singapore': 'SG',
  'Asia/Kolkata': 'IN', 'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Jerusalem': 'IL',
  'Asia/Manila': 'PH', 'Asia/Bangkok': 'TH', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Jakarta': 'ID',
  'Asia/Ho_Chi_Minh': 'VN', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU',
  'Pacific/Auckland': 'NZ', 'America/Toronto': 'CA', 'America/Vancouver': 'CA',
  'America/Sao_Paulo': 'BR', 'America/Mexico_City': 'MX', 'America/Argentina/Buenos_Aires': 'AR',
  'America/Santiago': 'CL', 'America/Bogota': 'CO', 'Africa/Johannesburg': 'ZA',
};

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function pick(randInt, list) {
  return list[randInt(0, list.length - 1)];
}

export function normalizeDigits(str) {
  return String(str || '').replace(/[^\d]/g, '');
}

export function isPrivateIp(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^::ffff:/i, '');
  if (clean === '::1' || clean === '127.0.0.1' || clean === 'localhost') return true;
  if (clean.startsWith('10.') || clean.startsWith('192.168.')) return true;
  const m = clean.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

export function extractClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  const realIp = req.headers['x-real-ip'] || req.headers['cf-connecting-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

export function geolocateRequest(req, tzHint = '') {
  const ip = extractClientIp(req);
  const cleanIp = ip.replace(/^::ffff:/i, '');

  // 1. Trust CDN country header if present
  const cdnCountry =
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['cloudfront-viewer-country'] ||
    req.headers['x-country-code'];
  if (typeof cdnCountry === 'string' && /^[A-Z]{2}$/i.test(cdnCountry) && cdnCountry.toUpperCase() !== 'XX') {
    const cc = cdnCountry.toUpperCase();
    return {
      ip: cleanIp,
      country: cc,
      city: '',
      source: 'geo-header',
      ...getCountryMeta(cc),
    };
  }

  // 2. Offline MaxMind GeoLite2 IP lookup
  if (!isPrivateIp(cleanIp)) {
    const geo = geoip.lookup(cleanIp);
    if (geo && geo.country) {
      return {
        ip: cleanIp,
        country: geo.country,
        city: geo.city || '',
        source: 'geoip-lite',
        ...getCountryMeta(geo.country),
      };
    }
  }

  // 3. Localhost/private IP fallback using timezone / Accept-Language -> US
  let fallbackCountry = 'US';
  if (tzHint && TZ_TO_COUNTRY[tzHint]) {
    fallbackCountry = TZ_TO_COUNTRY[tzHint];
  } else if (tzHint && tzHint.startsWith('America/')) {
    fallbackCountry = 'US';
  } else if (typeof req.headers['accept-language'] === 'string') {
    const match = req.headers['accept-language'].match(/[a-z]{2}-([A-Z]{2})/);
    if (match && COUNTRY_FORMATS[match[1]]) {
      fallbackCountry = match[1];
    }
  }

  return {
    ip: cleanIp,
    country: fallbackCountry,
    city: isPrivateIp(cleanIp) ? 'Local Exchange' : '',
    source: isPrivateIp(cleanIp) ? 'local-fallback' : 'default',
    ...getCountryMeta(fallbackCountry),
  };
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
  const randInt = (min, max) => crypto.randomInt(min, max + 1);
  const entry = COUNTRY_FORMATS[cc];
  let displayNumber;
  if (entry) {
    displayNumber = entry.gen(randInt);
  } else {
    // Fallback ITU regional format for unlisted countries
    displayNumber = `+888 ${pad(randInt(100, 999), 3)}-${pad(randInt(1000, 9999), 4)}`;
  }
  return {
    displayNumber,
    dialDigits: normalizeDigits(displayNumber),
    country: cc,
    ...getCountryMeta(cc),
  };
}
