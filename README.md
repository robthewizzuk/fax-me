# RetroFax T.38 — 1990s 3D Fax Machine over Real ITU-T T.38

A humorous, tactile 1990s yellowed-plastic 3D fax machine built with Three.js, React, Node.js, and a genuine **ITU-T T.38 Fax-over-IP** protocol engine on the backend.

## Highlights

- **IP-Geolocated Cookie Fax Number**: Automatically assigns a country-formatted fictional fax line on first visit using offline MaxMind GeoLite2 IP lookup (`geoip-lite`) and persists it in cookies + SQLite.
- **Interactive 3D Hardware (Three.js)**:
  - Clickable top document feeder tray (or drag & drop documents directly onto the machine)
  - Tactile 3D keypad with Web Audio API DTMF tones, regional ringback, V.21/V.17 modem handshake screeches, mechanical stepper motor ticks, and thermal paper tear audio
  - Green backlit dot-matrix LCD with built-in scrollable **Live Address Book** (`DIR`, `▲`, `▼`, `OK`)
  - Vertex-animated paper feed (sending) and curled thermal printout extrusion (receiving)
- **Real ITU-T T.38 Protocol Stack (`server/t38/` & `worker/edgeT38.js`)**:
  - `SIP INVITE / 180 Ringing / 200 OK / BYE` with `SDP m=image <port> udptl t38`
  - **Ring No Answer** (`SIP 480`) for offline recipients and **Busy** (`SIP 486`) for busy/blocked lines
  - ASN.1 Aligned PER **UDPTL** & **IFP** packets with redundancy error recovery
  - Real **T.30 HDLC** frames (`CSI`, `DIS`, `TSI`, `DCS`, `TCF`, `CFR`, `MPS`, `EOP`, `MCF`, `DCN`)
  - Real **T.4 Modified Huffman (1D MH)** scanline encoding & decoding (`1728px` A4)
  - Downloadable **Group 3 CCITT `.tif`** and **Wireshark `.pcap`** captures for every call
- **Live Peer-to-Peer SIP Voice Calls (`shared/sipCodecs.js` & `client/src/audio/liveCallEngine.js`)**:
  - Real-time bidirectional voice calls between any two online visitors using live microphone + WebAudio playback
  - Real ITU-T **G.711 PCMU (`PT=0`)**, **G.711 PCMA (`PT=8`)**, **G.722 SB-ADPCM (`PT=9`, 16 kHz)**, and **G.729A CS-ACELP (`PT=18`, 8 kbps)** encoded into RFC 3550 RTP packets
  - Incoming ring alerts, Answer/Decline controls, live TX/RX VU meters, Mute Mic, live 90s voice phrases & DTMF, and post-call `.WAV` + `.PCAP` export
- **Multi-Format Document Support**:
  - Images (`PNG`, `JPG`, `WebP`, `GIF`, `BMP`, `TIFF`, `SVG`), plain text/CSV, and **Draw & Type Quick Memo Pad** + **1990s Urgent Cover Sheet Generator**
  - On the full Node.js backend: also converts `PDF` (`poppler-utils`) and Microsoft Office (`.docx`, `.xlsx`, `.pptx`)
- **Joke & Comedy Features**:
  - Always-online Joke Bots (`ECHO-BOT`, `MEGACORP-HR`, `MYSTIC-FAX`) that execute real return T.38 faxes and SIP/RTP voice replies back to your machine
  - `STANDARD (204x98 dpi)` vs `FINE (204x196 dpi)` scanline mode & **90s Stormy Phone Line** noise toggle

## Running Locally (Node.js Backend)

```bash
npm install
npm --prefix client install
npm run build
npm start
```

### Run T.38 & SIP Protocol Tests

```bash
npm run test:t38
npm run test:sip
```

## Deploying to Cloudflare Workers via GitHub Actions

This repo includes [wrangler.toml](wrangler.toml), the Cloudflare Worker + SQLite Durable Object backend (`worker/`), and [.github/workflows/deploy-cloudflare.yml](.github/workflows/deploy-cloudflare.yml).

Add these two secrets under **Settings → Secrets and variables → Actions** in your GitHub repository:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with *Edit Cloudflare Workers* permissions
- `CLOUDFLARE_ACCOUNT_ID` — Your Cloudflare Account ID

Every push to `main` automatically runs the T.38 & SIP codec test suites, builds the Vite bundle, and deploys to Cloudflare Workers.

