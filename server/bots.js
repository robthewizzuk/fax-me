import { renderMemoToPngBuffer } from './converter/docToPages.js';

export const FAX_BOTS = [
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

export function findBotByDigits(digits) {
  if (!digits) return null;
  return (
    FAX_BOTS.find(
      (b) =>
        b.dial_digits === digits ||
        b.shortDial === digits ||
        (digits.length >= 7 && b.dial_digits.endsWith(digits))
    ) || null
  );
}

const HR_MEMOS = [
  {
    subject: 'URGENT: TPS REPORT COVER SHEET NON-COMPLIANCE',
    body: [
      'THANK YOU FOR YOUR FACSIMILE TRANSMISSION.',
      '',
      'OUR MICROFICHE AUDIT TEAM REVIEWED YOUR DOCUMENT AND NOTED:',
      '  [X] MISSING NEW COVER SHEET FORMAT (FORM 94-B)',
      '  [X] INSUFFICIENT BEIGE TONER DENSITY',
      '  [ ] APPROVED BY MIDDLE MANAGEMENT',
      '',
      'PLEASE RE-FAX IN TRIPLICATE BEFORE FRIDAY 5:00 PM OR',
      'REPORT TO SUB-BASEMENT STORAGE FOR STAPLE COUNTING.',
      '',
      '       +----------------------------+',
      '       |  STAMPED: FILED IN DRAWER  |',
      '       |     NOVEMBER 13, 1994      |',
      '       +----------------------------+',
    ].join('\n'),
  },
  {
    subject: 'MANDATORY SYNERGY & COFFEE POT MEMO',
    body: [
      'ATTENTION VALUED RESOURCE:',
      '',
      'YOUR RECENT FAX HAS BEEN FORWARDED TO ALL 47 REGIONAL',
      'FAX MACHINES SIMULTANEOUSLY AT 9,600 BAUD.',
      '',
      'REMINDER: WHOEVER TAKES THE LAST CUP OF DECAF MUST',
      'BREW A FRESH POT OR LOSE FLOPPY DISK PRIVILEGES.',
      '',
      'Q4 SYNERGY PROJECTION:',
      '  BEIGE  | ████████████████████  92%',
      '  FAXING | █████████████████     78%',
      '  NAP    | ████                  18%',
    ].join('\n'),
  },
];

const FORTUNES = [
  'YOUR NEXT IMPORTANT EMAIL WILL BE PRINTED OUT AND LEFT ON A DESK.',
  'A MYSTERIOUS CURLY THERMAL SCROLL BRINGS UNEXPECTED CLARITY.',
  'AVOID PAPER JAMS ON TUESDAY. TRUST ONLY NUMBERS WITH AREA CODES.',
  'THE MODEM SCREECHES FAVOR YOUR BOLDEST MEMO THIS WEEK.',
  'SOMEONE FAR AWAY IS ABOUT TO SEND YOU A VERY DITHERED CAT.',
];

export async function generateBotReplyPages(bot, { senderNumber, senderName, receivedPngBuffers }) {
  if (bot.id === 'bot-echo') {
    if (receivedPngBuffers && receivedPngBuffers.length > 0) {
      return receivedPngBuffers;
    }
  }

  if (bot.id === 'bot-megacorp') {
    const memo = HR_MEMOS[Math.floor(Math.random() * HR_MEMOS.length)];
    const png = await renderMemoToPngBuffer({
      template: 'MEGACORP INTEROFFICE MEMO',
      from: 'HUMAN RESOURCES (EXT. 1994)',
      to: `${senderName || 'VALUED EMPLOYEE'} (${senderNumber})`,
      subject: memo.subject,
      body: memo.body,
    });
    return [png];
  }

  // Mystic Fax
  const fortune = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
  const lucky = `${Math.floor(100 + Math.random() * 899)}-01${Math.floor(10 + Math.random() * 89)}`;
  const body = [
    '        . * .  *   .    *    .',
    '           .  _______  .',
    '         *  /         \\   *',
    '           |  T . 3 8  |',
    '           |   O R B   |',
    '            \\ _______ /',
    '           ___||___||___',
    '',
    'THE THERMAL ORACLE READS YOUR TRANSMISSION:',
    '',
    `  "${fortune}"`,
    '',
    `LUCKY AREA CODE: ${lucky}`,
    'BAUD ALIGNMENT : 14,400 BPS ASCENDING',
    'PAPER AURA     : SLIGHTLY CURLED',
  ].join('\n');

  const png = await renderMemoToPngBuffer({
    template: 'MYSTIC FAX ORACLE',
    from: 'THE THERMAL ORACLE (555-010-0777)',
    to: `${senderName || 'SEEKER'} (${senderNumber})`,
    subject: 'YOUR FACSIMILE FORTUNE',
    body,
  });
  return [png];
}
