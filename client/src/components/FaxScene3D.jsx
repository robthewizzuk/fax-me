import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { drawFaxLcd } from '../utils/lcdRenderer.js';
import { faxAudio } from '../audio/faxAudio.js';

const CAMERA_PRESETS = {
  desk: { pos: new THREE.Vector3(0.24, 3.55, 5.05), target: new THREE.Vector3(0.02, 0.88, 0.14) },
  console: { pos: new THREE.Vector3(0.44, 2.55, 2.65), target: new THREE.Vector3(0.42, 0.98, 0.58) },
  output: { pos: new THREE.Vector3(0.1, 2.05, 3.6), target: new THREE.Vector3(0.15, 0.35, 1.45) },
};

function makeWoodTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8b6848';
  ctx.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 2) {
    const n = Math.sin(y * 0.08) * 8 + (Math.random() - 0.5) * 10;
    ctx.fillStyle = `rgb(${136 + n}, ${101 + n * 0.75}, ${70 + n * 0.55})`;
    ctx.fillRect(0, y, 512, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePlasticGrainBump() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 115 + Math.floor(Math.random() * 28);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

function makeButtonLabelTexture(label, bgColor, textColor = '#1e1c18', fontSize = 44, subLabel = '', anisotropy = 4) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 250, 122);
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (subLabel) {
    ctx.font = `700 ${Math.round(fontSize * 1.15)}px "IBM Plex Mono", monospace`;
    ctx.fillText(label, 128, 44);
    ctx.font = `700 ${Math.round(fontSize * 0.85)}px "IBM Plex Mono", monospace`;
    ctx.fillText(subLabel, 128, 92);
  } else {
    ctx.font = `700 ${Math.round(fontSize * 1.35)}px "IBM Plex Mono", monospace`;
    ctx.fillText(label, 128, 66);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

function drawStickyNote(canvas, myNumber, countryFlag) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f3df6d';
  ctx.fillRect(0, 0, 256, 256);
  // Subtle curled shadow edge
  ctx.fillStyle = 'rgba(180,155,30,0.22)';
  ctx.fillRect(0, 0, 256, 28);
  ctx.fillStyle = '#22316b';
  ctx.font = '700 28px "Caveat", cursive, sans-serif';
  ctx.fillText('MY FAX LINE:', 20, 62);
  ctx.font = '700 25px "IBM Plex Mono", monospace';
  const numStr = myNumber || '...';
  if (numStr.length > 14) {
    const mid = numStr.lastIndexOf(' ', 14);
    if (mid > 0) {
      ctx.fillText(numStr.slice(0, mid), 18, 108);
      ctx.fillText(numStr.slice(mid + 1), 18, 142);
    } else {
      ctx.fillText(numStr, 18, 115);
    }
  } else {
    ctx.fillText(numStr, 18, 115);
  }
  ctx.fillStyle = '#474f78';
  ctx.font = '600 24px "Caveat", cursive, sans-serif';
  ctx.fillText(`${countryFlag || ''} (click to copy)`, 20, 212);
}

function createPlaceholderPaperTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 680;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f8f6ee';
  ctx.fillRect(0, 0, 512, 680);
  ctx.strokeStyle = '#706a5c';
  ctx.setLineDash([12, 8]);
  ctx.lineWidth = 4;
  ctx.strokeRect(24, 24, 464, 632);
  ctx.setLineDash([]);
  ctx.fillStyle = '#1f1d18';
  ctx.textAlign = 'center';
  ctx.font = '700 32px "IBM Plex Mono", monospace';
  ctx.fillText('INPUT PAPER TRAY', 256, 200);
  ctx.fillRect(96, 224, 320, 4);
  ctx.font = '700 25px "IBM Plex Mono", monospace';
  ctx.fillText('CLICK HERE TO:', 256, 276);
  ctx.font = '600 23px "IBM Plex Mono", monospace';
  ctx.fillText('1. DRAW / TYPE MEMO', 256, 324);
  ctx.fillText('2. UPLOAD IMG OR DOC', 256, 364);
  ctx.fillStyle = '#5a554a';
  ctx.font = '500 20px "IBM Plex Mono", monospace';
  ctx.fillText('PDF / DOCX / XLSX / PPTX', 256, 428);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export default function FaxScene3D({
  state,
  cameraPreset,
  onTriggerUpload,
  onToggleHandset,
  onKeyPress,
  onInspectPrintedFax,
  onCopyNumber,
  onFocusConsole,
}) {
  const mountRef = useRef(null);
  const stateRef = useRef(state);
  const callbacksRef = useRef({
    onTriggerUpload,
    onToggleHandset,
    onKeyPress,
    onInspectPrintedFax,
    onCopyNumber,
    onFocusConsole,
  });
  const presetRef = useRef({ active: false, key: 'desk' });
  const [hoverLabel, setHoverLabel] = useState('');
  const [cursorStyle, setCursorStyle] = useState('grab');

  stateRef.current = state;
  callbacksRef.current = {
    onTriggerUpload,
    onToggleHandset,
    onKeyPress,
    onInspectPrintedFax,
    onCopyNumber,
    onFocusConsole,
  };

  useEffect(() => {
    presetRef.current = { active: true, key: cameraPreset || 'desk' };
  }, [cameraPreset]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#004f52');
    scene.fog = new THREE.Fog('#004f52', 11, 24);

    const camera = new THREE.PerspectiveCamera(
      40,
      container.clientWidth / container.clientHeight,
      0.1,
      50
    );
    camera.position.copy(CAMERA_PRESETS.desk.pos);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.copy(CAMERA_PRESETS.desk.target);
    controls.minDistance = 2.1;
    controls.maxDistance = 8.2;
    controls.maxPolarAngle = Math.PI / 2 - 0.06;
    controls.minPolarAngle = 0.28;
    controls.addEventListener('start', () => {
      presetRef.current.active = false;
    });

    // Lighting — warm 90s fluorescent + desk lamp aesthetic
    const hemi = new THREE.HemisphereLight('#fff4df', '#4d463c', 0.88);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight('#fff8eb', 1.65);
    keyLight.position.set(3.5, 6.2, 4.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 16;
    keyLight.shadow.camera.left = -4;
    keyLight.shadow.camera.right = 4;
    keyLight.shadow.camera.top = 4;
    keyLight.shadow.camera.bottom = -4;
    keyLight.shadow.bias = -0.0005;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight('#d8e6f5', 0.55);
    rimLight.position.set(-4.5, 3.2, -3.5);
    scene.add(rimLight);

    // Desk & back office cubicle wall
    const deskTex = makeWoodTexture();
    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(16, 0.3, 10),
      new THREE.MeshStandardMaterial({ map: deskTex, roughness: 0.72, metalness: 0.04 })
    );
    desk.position.set(0, -0.15, 0.5);
    desk.receiveShadow = true;
    scene.add(desk);

    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 12),
      new THREE.MeshStandardMaterial({ color: '#1b5e63', roughness: 0.92 })
    );
    wall.position.set(0, 4.5, -4.2);
    wall.receiveShadow = true;
    scene.add(wall);

    // Materials for chunky 1990s sun-yellowed off-white ABS plastic
    const plasticBump = makePlasticGrainBump();
    const beigeMat = new THREE.MeshStandardMaterial({
      color: '#e3dbc4',
      roughness: 0.62,
      metalness: 0.03,
      bumpMap: plasticBump,
      bumpScale: 0.006,
    });
    const yellowedMat = new THREE.MeshStandardMaterial({
      color: '#d4c9ab',
      roughness: 0.68,
      metalness: 0.03,
      bumpMap: plasticBump,
      bumpScale: 0.007,
    });
    const darkPlasticMat = new THREE.MeshStandardMaterial({
      color: '#343330',
      roughness: 0.55,
      metalness: 0.08,
    });
    const smokedAcrylicMat = new THREE.MeshPhysicalMaterial({
      color: '#5a554c',
      roughness: 0.25,
      transparent: true,
      opacity: 0.58,
    });

    const machine = new THREE.Group();
    scene.add(machine);

    // Main lower chassis block
    const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.78, 2.35), beigeMat);
    lowerBody.position.set(0, 0.39, 0);
    lowerBody.castShadow = true;
    lowerBody.receiveShadow = true;
    machine.add(lowerBody);

    // Upper rear printer/scanner housing
    const upperRear = new THREE.Mesh(new THREE.BoxGeometry(3.36, 0.56, 1.32), yellowedMat);
    upperRear.position.set(0, 0.96, -0.48);
    upperRear.castShadow = true;
    upperRear.receiveShadow = true;
    machine.add(upperRear);

    // Cooling vent slats on right side
    for (let i = 0; i < 6; i++) {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.035, 0.72), darkPlasticMat);
      vent.position.set(1.7, 0.3 + i * 0.07, -0.15);
      machine.add(vent);
    }

    // Slanted front console deck (right 2/3 of machine)
    const consoleDeck = new THREE.Mesh(new THREE.BoxGeometry(2.38, 0.22, 1.12), yellowedMat);
    consoleDeck.position.set(0.45, 0.85, 0.57);
    consoleDeck.rotation.x = 0.28;
    consoleDeck.castShadow = true;
    consoleDeck.receiveShadow = true;
    machine.add(consoleDeck);

    // Bezel frame on console deck
    const lcdBezel = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.06, 0.44), darkPlasticMat);
    lcdBezel.position.set(0.02, 0.99, 0.36);
    lcdBezel.rotation.x = 0.28;
    machine.add(lcdBezel);

    // Live Dot-Matrix LCD CanvasTexture
    const lcdCanvas = document.createElement('canvas');
    lcdCanvas.width = 512;
    lcdCanvas.height = 192;
    drawFaxLcd(lcdCanvas, stateRef.current);
    const lcdTexture = new THREE.CanvasTexture(lcdCanvas);
    lcdTexture.colorSpace = THREE.SRGBColorSpace;
    const lcdMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.02, 0.37),
      new THREE.MeshStandardMaterial({
        map: lcdTexture,
        emissiveMap: lcdTexture,
        emissive: new THREE.Color('#7ca33c'),
        emissiveIntensity: 0.42,
        roughness: 0.32,
      })
    );
    lcdMesh.position.set(0.02, 1.025, 0.37);
    lcdMesh.rotation.x = -Math.PI / 2 + 0.28;
    lcdMesh.userData = { interact: 'console', label: 'Dot-Matrix LCD (Click to Zoom)' };
    machine.add(lcdMesh);

    // Left Handset Cradle, Hookswitch Plunger & Interactive Retro Receiver
    const cradleBase = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.28, 2.0), yellowedMat);
    cradleBase.position.set(-1.26, 0.88, 0.06);
    cradleBase.castShadow = true;
    machine.add(cradleBase);

    const cradleSwitch = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.14), darkPlasticMat);
    cradleSwitch.position.set(-1.26, 1.03, -0.18);
    machine.add(cradleSwitch);

    const handsetMat = beigeMat.clone();
    const handsetGroup = new THREE.Group();
    handsetGroup.position.set(-1.26, 1.12, 0.04);
    const earCup = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.48), handsetMat);
    earCup.position.set(0, 0, -0.62);
    earCup.castShadow = true;
    const mouthCup = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.48), handsetMat);
    mouthCup.position.set(0, 0, 0.62);
    mouthCup.castShadow = true;
    const handleBar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 1.18), handsetMat);
    handleBar.position.set(0, 0.09, 0);
    handleBar.castShadow = true;
    const handsetHit = new THREE.Mesh(
      new THREE.BoxGeometry(0.58, 0.42, 1.85),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    handsetHit.position.set(0, 0.05, 0);
    [earCup, mouthCup, handleBar, handsetHit].forEach((m) => {
      m.userData = { interact: 'handset', label: 'Handset (Click for SIP Voice Call over G.711/G.722/G.729)' };
    });
    handsetGroup.add(earCup, mouthCup, handleBar, handsetHit);
    machine.add(handsetGroup);

    // Helical coiled phone cord on left side
    const coilPts = [];
    for (let i = 0; i <= 90; i++) {
      const t = i / 90;
      const angle = t * Math.PI * 2 * 13;
      const x = -1.62 + Math.cos(angle) * 0.065 - Math.sin(t * Math.PI) * 0.16;
      const y = 1.08 - Math.sin(t * Math.PI) * 0.72;
      const z = 0.65 - t * 1.15 + Math.sin(angle) * 0.065;
      coilPts.push(new THREE.Vector3(x, Math.max(0.08, y), z));
    }
    const coilGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coilPts), 120, 0.018, 8, false);
    const coilMesh = new THREE.Mesh(coilGeo, darkPlasticMat);
    coilMesh.castShadow = true;
    machine.add(coilMesh);

    // Rear RJ-11 line cord snaking off desk
    const wallCordCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.9, 0.22, -1.15),
      new THREE.Vector3(-1.3, 0.08, -1.8),
      new THREE.Vector3(-1.8, 0.04, -2.9),
      new THREE.Vector3(-2.1, 0.12, -4.1),
    ]);
    const wallCord = new THREE.Mesh(
      new THREE.TubeGeometry(wallCordCurve, 32, 0.022, 8, false),
      darkPlasticMat
    );
    scene.add(wallCord);

    // Status LEDs above LCD
    const leds = {};
    const ledSpecs = [
      { key: 'POWER', x: -0.44, offColor: '#1f4d28', onColor: '#37e65a' },
      { key: 'TX', x: -0.22, offColor: '#254528', onColor: '#48ff6b' },
      { key: 'RX', x: 0.0, offColor: '#4a3514', onColor: '#ffaa22' },
      { key: 'LINE', x: 0.22, offColor: '#4a1c1c', onColor: '#ff3b3b' },
      { key: 'PAPER', x: 0.44, offColor: '#4a1c1c', onColor: '#ff2b2b' },
    ];
    ledSpecs.forEach((spec) => {
      const mat = new THREE.MeshStandardMaterial({
        color: spec.offColor,
        emissive: new THREE.Color(spec.onColor),
        emissiveIntensity: 0.1,
        roughness: 0.2,
      });
      const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.03, 12), mat);
      bulb.position.set(spec.x, 1.075, 0.15);
      bulb.rotation.x = 0.28;
      machine.add(bulb);
      leds[spec.key] = { mat, spec };
    });

    // Interactive 3D Keypad Buttons mounted onto consoleDeck local space!
    const consoleGroup = new THREE.Group();
    consoleGroup.position.set(0.45, 0.96, 0.55);
    consoleGroup.rotation.x = 0.28;
    machine.add(consoleGroup);

    const interactiveMeshes = [lcdMesh, earCup, mouthCup, handleBar, handsetHit];
    const keyMeshes = [];

    const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 4);
    const addKey = (id, label, x, z, w, d, bg, fg = '#1e1c18', fontSize = 44, { subLabel = '', hoverText = '' } = {}) => {
      const topMat = new THREE.MeshStandardMaterial({
        map: makeButtonLabelTexture(label, bg, fg, fontSize, subLabel, maxAniso),
        roughness: 0.48,
      });
      const sideMat = new THREE.MeshStandardMaterial({ color: bg, roughness: 0.6 });
      const mats = [sideMat, sideMat, topMat, sideMat, sideMat, sideMat];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.055, d), mats);
      mesh.position.set(x, 0.022, z);
      mesh.castShadow = true;
      mesh.userData = {
        interact: 'key',
        keyId: id,
        baseY: 0.022,
        pressOffset: 0,
        label: hoverText || `Key [${label}]`,
      };
      consoleGroup.add(mesh);
      interactiveMeshes.push(mesh);
      keyMeshes.push(mesh);
      return mesh;
    };

    // Numeric Keypad (right of LCD)
    const numRows = [
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9'],
      ['*', '0', '#'],
    ];
    numRows.forEach((row, r) => {
      row.forEach((lbl, c) => {
        addKey(lbl, lbl, 0.34 + c * 0.185, -0.3 + r * 0.165, 0.15, 0.13, '#cfc7b0', '#201e1a', 52);
      });
    });

    // Directory / Nav / Utility keys (Row 1 below LCD)
    addKey('DIR', 'DIR', -0.84, 0.12, 0.16, 0.115, '#c8bfa6', '#1e1c18', 36, { hoverText: 'Key [DIR] — Browse Address Book on LCD' });
    addKey('UP', '▲', -0.67, 0.12, 0.14, 0.115, '#c8bfa6', '#1e1c18', 42, { hoverText: 'Key [▲] — Previous Directory Station' });
    addKey('DOWN', '▼', -0.51, 0.12, 0.14, 0.115, '#c8bfa6', '#1e1c18', 42, { hoverText: 'Key [▼] — Next Directory Station' });
    addKey('OK', 'OK', -0.34, 0.12, 0.16, 0.115, '#b9c698', '#16240a', 38, { hoverText: 'Key [OK] — Select Highlighted Number / Open Directory' });
    addKey('CLR', 'CLR', -0.16, 0.12, 0.16, 0.115, '#d5cab0', '#1e1c18', 34, { hoverText: 'Key [CLR] — Backspace / Clear Alert' });
    addKey('REDIAL', 'RDL', 0.02, 0.12, 0.16, 0.115, '#cfc7b0', '#1e1c18', 34, { hoverText: 'Key [RDL] — Redial Last Number' });

    // Hardware Toggle Row (Row 2): Fine, Cover Sheet, Line Static, Mute, Codec Switch, SIP Voice Call
    addKey('RES', 'FINE', -0.78, 0.35, 0.27, 0.15, '#c9c2ab', '#161a14', 38, {
      subLabel: '204x196',
      hoverText: 'Fine (204×196) — Toggle Print Resolution',
    });
    addKey('COVER', '90s COV', -0.48, 0.35, 0.27, 0.15, '#c9c2ab', '#161a14', 32, {
      subLabel: 'SHEET',
      hoverText: '90s Cover Sheet — Toggle Urgent Cover Page',
    });
    addKey('STATIC', 'LINE', -0.18, 0.35, 0.27, 0.15, '#c9c2ab', '#161a14', 36, {
      subLabel: 'STATIC',
      hoverText: 'Line Static — Toggle Stormy Phone Line Noise',
    });
    addKey('TONE', 'MUTE', 0.06, 0.35, 0.16, 0.15, '#cfc7b0', '#1e1c18', 32, {
      subLabel: 'AUDIO',
      hoverText: 'Audio Mute / Unmute Fax Speaker',
    });
    addKey('CODEC', 'CODEC', 0.33, 0.36, 0.29, 0.14, '#c2cbbe', '#12191c', 33, {
      subLabel: 'G711/22/29',
      hoverText: 'Cycle SIP Voice Codec: G.711u / G.711a / G.722 / G.729',
    });
    addKey('VOICE', 'VOICE', 0.64, 0.36, 0.24, 0.14, '#245896', '#f4f8ff', 33, {
      subLabel: 'SIP CALL',
      hoverText: 'Lift Handset / Open SIP Voice Call Dialog',
    });

    // Dedicated glowing LED pips right above FINE, COVER, STATIC, CODEC, VOICE keys
    const toggleLedSpecs = [
      { key: 'FINE', x: -0.78, z: 0.245, offColor: '#1f4425', onColor: '#37f563' },
      { key: 'COVER', x: -0.48, z: 0.245, offColor: '#4c3814', onColor: '#ffbe2e' },
      { key: 'STATIC', x: -0.18, z: 0.245, offColor: '#4d2018', onColor: '#ff4b2b' },
      { key: 'CODEC', x: 0.33, z: 0.27, offColor: '#1a3844', onColor: '#46e6ff' },
      { key: 'VOICE', x: 0.64, z: 0.27, offColor: '#1c2b4a', onColor: '#48a8ff' },
    ];
    toggleLedSpecs.forEach((spec) => {
      const mat = new THREE.MeshStandardMaterial({
        color: spec.offColor,
        emissive: new THREE.Color(spec.onColor),
        emissiveIntensity: 0.08,
        roughness: 0.22,
      });
      const pip = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.025, 0.026), mat);
      pip.position.set(spec.x, 0.022, spec.z);
      consoleGroup.add(pip);
      leds[spec.key] = { mat, spec };
    });

    // Big Green START & Red STOP buttons on far right
    addKey('START', 'START', 0.96, -0.02, 0.24, 0.32, '#2f8c4d', '#f5f8f2', 30, { hoverText: 'Key [START] — Transmit Fax via T.38 (or Place SIP Call when Handset Lifted)' });
    addKey('STOP', 'STOP', 0.96, 0.29, 0.24, 0.16, '#b83c35', '#fff5f4', 32, { hoverText: 'Key [STOP] — Hang Up Handset / Clear Alert' });

    // ---------- TOP DOCUMENT FEEDER (ADF) & CLICKABLE PAPER ----------
    const adfBackPlate = new THREE.Mesh(new THREE.BoxGeometry(1.74, 1.35, 0.05), yellowedMat);
    adfBackPlate.position.set(0.35, 1.56, -0.96);
    adfBackPlate.rotation.x = -0.34;
    adfBackPlate.castShadow = true;
    adfBackPlate.userData = { interact: 'upload', label: 'Top Input Tray (Click to Draw Memo or Upload Doc/Image)' };
    machine.add(adfBackPlate);
    interactiveMeshes.push(adfBackPlate);

    // Smoked acrylic dust lip over ADF
    const adfCover = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.36, 0.04), smokedAcrylicMat);
    adfCover.position.set(0.35, 1.28, -0.66);
    adfCover.rotation.x = -0.34;
    adfCover.userData = { interact: 'upload', label: 'Top Input Tray (Click to Draw Memo or Upload Doc/Image)' };
    machine.add(adfCover);
    interactiveMeshes.push(adfCover);

    // Left/Right paper edge guides
    [-0.45, 1.15].forEach((gx) => {
      const guide = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 0.09), darkPlasticMat);
      guide.position.set(gx, 1.44, -0.84);
      guide.rotation.x = -0.34;
      machine.add(guide);
    });

    // Clickable ADF slot + Paper Mesh (slides down into slot during TX!)
    const placeholderTex = createPlaceholderPaperTexture();
    const inputPaperMat = new THREE.MeshStandardMaterial({
      map: placeholderTex,
      roughness: 0.85,
      side: THREE.DoubleSide,
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 0.0,
    });
    const inputPaperGroup = new THREE.Group();
    inputPaperGroup.position.set(0.35, 1.15, -0.76);
    inputPaperGroup.rotation.x = -0.34;
    machine.add(inputPaperGroup);

    const inputPaperGeo = new THREE.PlaneGeometry(1.36, 1.75, 1, 8);
    // Shift geometry pivot to bottom edge so scaling Y shrinks smoothly into slot
    inputPaperGeo.translate(0, 0.875, 0);
    const inputPaperMesh = new THREE.Mesh(inputPaperGeo, inputPaperMat);
    inputPaperMesh.position.set(0, 0, 0.035);
    inputPaperMesh.castShadow = true;
    inputPaperMesh.userData = {
      interact: 'upload',
      label: 'Top Input Tray (Click to Draw Memo or Upload Doc/Image)',
    };
    inputPaperGroup.add(inputPaperMesh);
    interactiveMeshes.push(inputPaperMesh);

    // Invisible slightly generous hit target on ADF tray
    const adfHit = new THREE.Mesh(
      new THREE.BoxGeometry(1.75, 1.35, 0.35),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    adfHit.position.set(0.35, 1.65, -0.94);
    adfHit.rotation.x = -0.34;
    adfHit.userData = { interact: 'upload', label: 'Top Input Tray (Click to Draw Memo or Upload Doc/Image)' };
    machine.add(adfHit);
    interactiveMeshes.push(adfHit);

    // ---------- BOTTOM OUTPUT SLOT & CURLED THERMAL PAPER ----------
    const outputSlot = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.09, 0.14), darkPlasticMat);
    outputSlot.position.set(0.35, 0.24, 1.16);
    machine.add(outputSlot);

    // Wire catch tray extending forward
    const catchTray = new THREE.Mesh(
      new THREE.BoxGeometry(1.66, 0.03, 0.65),
      new THREE.MeshStandardMaterial({ color: '#9c9586', roughness: 0.45, metalness: 0.35 })
    );
    catchTray.position.set(0.35, 0.05, 1.48);
    catchTray.castShadow = true;
    catchTray.receiveShadow = true;
    machine.add(catchTray);

    // Dynamic deformable curled thermal paper mesh
    const SEG_Y = 36;
    const outputGeo = new THREE.PlaneGeometry(1.34, 1.72, 1, SEG_Y);
    const outputBasePos = outputGeo.attributes.position.array.slice();
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = 512;
    outputCanvas.height = 680;
    const outputTex = new THREE.CanvasTexture(outputCanvas);
    outputTex.colorSpace = THREE.SRGBColorSpace;
    const outputMat = new THREE.MeshStandardMaterial({
      map: outputTex,
      roughness: 0.78,
      side: THREE.DoubleSide,
      emissive: new THREE.Color('#fff7df'),
      emissiveIntensity: 0.0,
    });
    const outputPaperMesh = new THREE.Mesh(outputGeo, outputMat);
    outputPaperMesh.position.set(0.35, 0.25, 1.15);
    outputPaperMesh.castShadow = true;
    outputPaperMesh.visible = false;
    outputPaperMesh.userData = {
      interact: 'output',
      label: 'Printed Thermal Fax (Click to Read & Tear Off)',
    };
    machine.add(outputPaperMesh);
    interactiveMeshes.push(outputPaperMesh);

    // ---------- DESK PROPS: STICKY NOTE & COFFEE MUG ----------
    const stickyCanvas = document.createElement('canvas');
    stickyCanvas.width = 256;
    stickyCanvas.height = 256;
    drawStickyNote(stickyCanvas, stateRef.current.session?.displayNumber, stateRef.current.session?.flag);
    const stickyTex = new THREE.CanvasTexture(stickyCanvas);
    stickyTex.colorSpace = THREE.SRGBColorSpace;
    const stickyMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.95, 0.95),
      new THREE.MeshStandardMaterial({ map: stickyTex, roughness: 0.85, side: THREE.DoubleSide })
    );
    stickyMesh.position.set(-2.35, 0.012, 0.78);
    stickyMesh.rotation.x = -Math.PI / 2;
    stickyMesh.rotation.z = 0.14;
    stickyMesh.receiveShadow = true;
    stickyMesh.userData = { interact: 'sticky', label: 'My Fax Number Sticky Note (Click to Copy)' };
    scene.add(stickyMesh);
    interactiveMeshes.push(stickyMesh);

    // Classic office mug
    const mugGroup = new THREE.Group();
    mugGroup.position.set(2.38, 0, -0.35);
    const mugMat = new THREE.MeshStandardMaterial({ color: '#d85c38', roughness: 0.35 });
    const mugBody = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.22, 0.52, 24), mugMat);
    mugBody.position.y = 0.26;
    mugBody.castShadow = true;
    mugBody.receiveShadow = true;
    const coffeeTop = new THREE.Mesh(
      new THREE.CircleGeometry(0.21, 20),
      new THREE.MeshStandardMaterial({ color: '#2b190d', roughness: 0.18 })
    );
    coffeeTop.rotation.x = -Math.PI / 2;
    coffeeTop.position.y = 0.48;
    const mugHandle = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.032, 10, 20, Math.PI), mugMat);
    mugHandle.rotation.z = -Math.PI / 2;
    mugHandle.position.set(0.22, 0.27, 0);
    mugGroup.add(mugBody, coffeeTop, mugHandle);
    scene.add(mugGroup);

    // ---------- TEXTURE SYNC & ANIMATION STATE ----------
    let lastPreviewUrl = '';
    let lastPrintedUrl = '';
    let lastStickyNum = '';
    let txVisualProgress = 0;
    let rxVisualProgress = 0;
    let handsetLift = 0;
    let lastStepperTickAt = 0;
    let tearAnim = 0;
    let hoveredObj = null;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPt = { x: 0, y: 0 };

    const updateDeformedOutputPaper = (ext) => {
      if (ext <= 0.01) {
        outputPaperMesh.visible = false;
        return;
      }
      outputPaperMesh.visible = true;
      const posAttr = outputGeo.attributes.position;
      const uvAttr = outputGeo.attributes.uv;
      const fullH = 1.72;
      const visibleH = fullH * ext;

      // In PlaneGeometry, y spans +fullH/2 (top of paper, exits FIRST!) down to -fullH/2 (bottom, inside slot!)
      for (let i = 0; i < posAttr.count; i++) {
        const bx = outputBasePos[i * 3];
        const by = outputBasePos[i * 3 + 1];
        // Normalized s = 0 at bottom (inside slot), 1 at top (leading tip emerging first!)
        const s = (by + fullH / 2) / fullH;
        const distOut = s * visibleH;

        // Curve path: exits slightly downward onto catch tray, then curls gracefully upward like thermal roll paper!
        const z = distOut * 0.78;
        const y = -distOut * 0.18 + Math.pow(Math.max(0, distOut - 0.35), 2.1) * 0.34 + tearAnim * 0.65;
        const zLift = z - tearAnim * 0.35;

        posAttr.setXYZ(i, bx, y, zLift);
        // Map UVs so the TOP of the fax image (v=1) sits at s=0 (slot),
        // and as ext grows 0->1, the paper smoothly scrolls out upright toward s=1!
        const v = 1 - s * ext;
        uvAttr.setXY(i, (bx / 1.34) + 0.5, v);
      }
      posAttr.needsUpdate = true;
      uvAttr.needsUpdate = true;
      outputGeo.computeVertexNormals();
    };

    const onPointerMove = (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(interactiveMeshes, false);
      const hit = hits.find((h) => h.object.visible !== false);

      if (hit) {
        hoveredObj = hit.object;
        setHoverLabel(hit.object.userData.label || '');
        setCursorStyle('pointer');
      } else {
        hoveredObj = null;
        setHoverLabel('');
        setCursorStyle('grab');
      }
    };

    const onPointerDown = (e) => {
      downPt = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e) => {
      const dist = Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y);
      if (dist > 6) return; // User was orbiting, not clicking

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(interactiveMeshes, false);
      const hit = hits.find((h) => h.object.visible !== false);
      if (!hit) return;

      const ud = hit.object.userData;
      if (ud.interact === 'upload') {
        faxAudio.playButtonClick(540);
        callbacksRef.current.onTriggerUpload?.();
      } else if (ud.interact === 'handset') {
        callbacksRef.current.onToggleHandset?.();
      } else if (ud.interact === 'key') {
        ud.pressOffset = 1;
        callbacksRef.current.onKeyPress?.(ud.keyId);
      } else if (ud.interact === 'output') {
        faxAudio.playPaperTear();
        tearAnim = 1;
        setTimeout(() => {
          callbacksRef.current.onInspectPrintedFax?.();
        }, 160);
      } else if (ud.interact === 'sticky') {
        faxAudio.playButtonClick(880);
        callbacksRef.current.onCopyNumber?.();
      } else if (ud.interact === 'console') {
        callbacksRef.current.onFocusConsole?.();
      }
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    const onResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', onResize);

    // Animation loop
    let animId = 0;
    let lastLcdDraw = 0;
    const clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const dt = Math.min(0.05, clock.getDelta());
      const nowMs = Date.now();
      const s = stateRef.current;

      // Smooth camera preset interpolation
      if (presetRef.current.active) {
        const p = CAMERA_PRESETS[presetRef.current.key] || CAMERA_PRESETS.desk;
        camera.position.lerp(p.pos, 0.08);
        controls.target.lerp(p.target, 0.08);
        if (camera.position.distanceTo(p.pos) < 0.02) {
          presetRef.current.active = false;
        }
      }
      controls.update();

      // Sync uploaded staged preview texture onto top paper
      const curPreview = s.staged?.previewDataUrl || '';
      if (curPreview !== lastPreviewUrl) {
        lastPreviewUrl = curPreview;
        if (!curPreview) {
          inputPaperMat.map = placeholderTex;
          inputPaperMat.needsUpdate = true;
        } else {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = 512;
            c.height = 680;
            const cx = c.getContext('2d');
            cx.fillStyle = '#faf8f0';
            cx.fillRect(0, 0, 512, 680);
            cx.drawImage(img, 0, 0, 512, 680);
            const t = new THREE.CanvasTexture(c);
            t.colorSpace = THREE.SRGBColorSpace;
            inputPaperMat.map = t;
            inputPaperMat.needsUpdate = true;
          };
          img.src = curPreview;
        }
      }

      // Sync sticky note number
      const numKey = `${s.session?.displayNumber || ''}|${s.session?.flag || ''}`;
      if (numKey !== lastStickyNum) {
        lastStickyNum = numKey;
        drawStickyNote(stickyCanvas, s.session?.displayNumber, s.session?.flag);
        stickyTex.needsUpdate = true;
      }

      // Sync received thermal fax image onto output paper
      const curPrintedUrl = s.deskPrintedFax?.previewUrls?.[0] || '';
      if (curPrintedUrl !== lastPrintedUrl) {
        lastPrintedUrl = curPrintedUrl;
        if (curPrintedUrl) {
          const img = new Image();
          img.onload = () => {
            const ctx = outputCanvas.getContext('2d');
            ctx.fillStyle = '#faf7ee';
            ctx.fillRect(0, 0, 512, 680);
            ctx.drawImage(img, 0, 0, 512, 680);
            outputTex.needsUpdate = true;
          };
          img.src = curPrintedUrl;
        }
      }

      // Hover highlights on paper & handset
      const hoveringUpload = hoveredObj && hoveredObj.userData?.interact === 'upload';
      inputPaperMat.emissiveIntensity += ((hoveringUpload ? 0.16 : 0.0) - inputPaperMat.emissiveIntensity) * 0.2;

      const hoveringOutput = hoveredObj && hoveredObj.userData?.interact === 'output';
      outputMat.emissiveIntensity += ((hoveringOutput ? 0.14 : 0.0) - outputMat.emissiveIntensity) * 0.2;

      const hoveringHandset = hoveredObj && hoveredObj.userData?.interact === 'handset';
      handsetMat.emissive.set('#6aa4ff');
      const targetHandsetGlow = hoveringHandset ? 0.16 : s.handsetOffHook || s.callState?.active ? 0.08 : 0.0;
      handsetMat.emissiveIntensity += (targetHandsetGlow - handsetMat.emissiveIntensity) * 0.18;

      // Handset off-hook lift & gentle voice vibration animation
      const wantLifted = Boolean(s.handsetOffHook || s.callState?.active || s.rxCallState?.active);
      handsetLift += ((wantLifted ? 1 : 0) - handsetLift) * 0.14;
      const talkBob = s.callState?.active || s.rxCallState?.active ? Math.sin(nowMs * 0.008) * 0.035 : Math.sin(nowMs * 0.003) * 0.015;
      handsetGroup.position.set(
        -1.26 - 0.14 * handsetLift,
        1.12 + 0.44 * handsetLift + talkBob * handsetLift,
        0.04 + 0.26 * handsetLift
      );
      handsetGroup.rotation.set(0.14 * handsetLift, 0.12 * handsetLift, -0.22 * handsetLift);
      cradleSwitch.position.y = 1.01 + 0.045 * handsetLift;

      // Animate input paper feeding down into slot during TX
      if (s.txState?.active && s.txState.phase === 'TRANSMITTING') {
        const targetTx = Math.max(0.05, s.txState.progress || 0);
        txVisualProgress += (targetTx - txVisualProgress) * 0.14;
        if (nowMs - lastStepperTickAt > 170) {
          lastStepperTickAt = nowMs;
          faxAudio.playStepperTick();
        }
      } else if (!s.txState?.active) {
        txVisualProgress = 0;
      }
      const scaleY = s.staged ? Math.max(0.02, 1 - txVisualProgress * 0.96) : 0.78;
      inputPaperMesh.scale.set(1, scaleY, 1);

      // Animate output thermal paper extruding out of bottom slot during RX
      if (s.rxState?.active && s.rxState.progress > 0) {
        const targetRx = Math.max(0.05, s.rxState.progress);
        rxVisualProgress += (targetRx - rxVisualProgress) * 0.12;
        if (nowMs - lastStepperTickAt > 160) {
          lastStepperTickAt = nowMs;
          faxAudio.playStepperTick();
        }
      } else if (s.deskPrintedFax) {
        rxVisualProgress += (1 - rxVisualProgress) * 0.09;
      } else {
        rxVisualProgress += (0 - rxVisualProgress) * 0.2;
      }
      tearAnim *= 0.88;
      updateDeformedOutputPaper(rxVisualProgress);

      // Keypress spring animations
      for (const km of keyMeshes) {
        if (km.userData.pressOffset > 0.01) {
          km.userData.pressOffset *= Math.pow(0.02, dt);
          km.position.y = km.userData.baseY - km.userData.pressOffset * 0.028;
        } else {
          km.position.y = km.userData.baseY;
        }
      }

      // LED blinking & latched switch states
      const fastBlink = Math.floor(nowMs / 180) % 2 === 0;
      const slowBlink = Math.floor(nowMs / 450) % 2 === 0;
      const callBusy = s.callState?.phase === 'BUSY' || s.callState?.phase === 'NO_ANSWER';
      leds.POWER.mat.emissiveIntensity = s.wsConnected ? 1.4 : (slowBlink ? 1.0 : 0.2);
      leds.TX.mat.emissiveIntensity = s.txState?.active || s.callState?.active ? (fastBlink ? 2.2 : 0.3) : 0.05;
      leds.RX.mat.emissiveIntensity = s.rxState?.active || s.rxCallState?.active ? (fastBlink ? 2.4 : 0.4) : (s.deskPrintedFax ? 0.9 : 0.05);
      leds.LINE.mat.emissiveIntensity =
        s.txState?.phase === 'BUSY' || s.txState?.phase === 'NO_ANSWER' || callBusy ? (fastBlink ? 2.4 : 0.2) : 0.05;
      leds.PAPER.mat.emissiveIntensity = s.txState?.phase === 'ERROR' || s.callState?.phase === 'ERROR' || s.alertBanner ? (fastBlink ? 2.6 : 0.3) : 0.05;

      leds.FINE.mat.emissiveIntensity = s.fine ? 1.9 : 0.06;
      leds.COVER.mat.emissiveIntensity = s.coverEnabled ? 1.9 : 0.06;
      leds.STATIC.mat.emissiveIntensity = s.stormyLine ? (fastBlink ? 2.1 : 1.1) : 0.06;

      // Codec indicator color by bitrate/band: G722=cyan, G729=amber, G711=green
      if (s.sipCodec === 'G722') leds.CODEC.mat.emissive.set('#46e6ff');
      else if (s.sipCodec === 'G729') leds.CODEC.mat.emissive.set('#ffbe2e');
      else leds.CODEC.mat.emissive.set('#37f563');
      leds.CODEC.mat.emissiveIntensity = 1.85;
      leds.VOICE.mat.emissiveIntensity = wantLifted ? (fastBlink ? 2.2 : 1.0) : 0.1;

      for (const km of keyMeshes) {
        const kid = km.userData.keyId;
        const topM = km.material[2];
        if (!topM) continue;
        if (kid === 'RES') {
          topM.emissive.set('#287038');
          topM.emissiveIntensity = s.fine ? 0.28 : 0.0;
        } else if (kid === 'COVER') {
          topM.emissive.set('#805c10');
          topM.emissiveIntensity = s.coverEnabled ? 0.32 : 0.0;
        } else if (kid === 'STATIC') {
          topM.emissive.set('#8c2818');
          topM.emissiveIntensity = s.stormyLine ? 0.35 : 0.0;
        } else if (kid === 'CODEC') {
          topM.emissive.set(s.sipCodec === 'G722' ? '#1c6c78' : s.sipCodec === 'G729' ? '#7a5210' : '#1b5e32');
          topM.emissiveIntensity = 0.25;
        } else if (kid === 'VOICE') {
          topM.emissive.set('#2b6cd6');
          topM.emissiveIntensity = wantLifted ? 0.45 : 0.06;
        }
      }

      // Refresh dot-matrix LCD periodically for blinking cursor & live updates
      if (nowMs - lastLcdDraw > 90) {
        lastLcdDraw = nowMs;
        drawFaxLcd(lcdCanvas, s, nowMs);
        lcdTexture.needsUpdate = true;
      }

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      className="scene-canvas-wrap"
      style={{ cursor: cursorStyle }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file) callbacksRef.current.onTriggerUpload?.(file);
      }}
    >
      <div ref={mountRef} className="scene-canvas-mount" />
      {hoverLabel && (
        <div className="scene-hover-badge" aria-live="polite">
          {hoverLabel}
        </div>
      )}
    </div>
  );
}
