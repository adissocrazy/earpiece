// QR codes for pairing, drawn on the server so the Mac app needs no QR library.
// Byte mode, error correction L, versions 1–5. Enough for a short https URL.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, eccLen) {
  const gen = rsGenerator(eccLen);
  const out = new Uint8Array(data.length + eccLen);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (!coef) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  return out.slice(data.length);
}

// data codewords and ecc codewords for level L, one block. Alignment centers include 6.
const VERSIONS = [
  { v: 1, size: 21, data: 19, ecc: 7, align: [] },
  { v: 2, size: 25, data: 34, ecc: 10, align: [6, 18] },
  { v: 3, size: 29, data: 55, ecc: 15, align: [6, 22] },
  { v: 4, size: 33, data: 80, ecc: 20, align: [6, 26] },
  { v: 5, size: 37, data: 108, ecc: 26, align: [6, 30] },
];

function pickVersion(nbytes) {
  // 4 mode bits + 8 count bits + data + up to 4 terminator bits, packed into data codewords.
  const bits = 4 + 8 + nbytes * 8;
  for (const ver of VERSIONS) if (ver.data * 8 >= bits) return ver;
  return null;
}

function appendBits(buf, value, len) {
  for (let i = len - 1; i >= 0; i--) buf.push((value >>> i) & 1);
}

function dataCodewords(bytes, ver) {
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const b of bytes) appendBits(bits, b, 8);
  const cap = ver.data * 8;
  appendBits(bits, 0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const pads = [0xec, 0x11];
  let p = 0;
  while (bits.length < cap) appendBits(bits, pads[p++ % 2], 8);
  const out = new Uint8Array(ver.data);
  for (let i = 0; i < ver.data; i++) {
    let n = 0;
    for (let b = 0; b < 8; b++) n = (n << 1) | bits[i * 8 + b];
    out[i] = n;
  }
  return out;
}

function formatBits(mask) {
  // ECC level L is 01. 15 bits, then XOR the format mask.
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i;
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function blank(size) {
  const fun = [];
  const dark = [];
  for (let y = 0; y < size; y++) {
    fun.push(new Array(size).fill(false));
    dark.push(new Array(size).fill(false));
  }
  return { fun, dark, size };
}

function setF(m, x, y, on) {
  if (x < 0 || y < 0 || x >= m.size || y >= m.size || m.fun[y][x]) return;
  m.fun[y][x] = true;
  m.dark[y][x] = on;
}

function finder(m, x, y) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const on = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setF(m, x + dx, y + dy, on);
    }
  }
}

function alignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      setF(m, cx + dx, cy + dy, on);
    }
  }
}

function reserve(m) {
  finder(m, 0, 0);
  finder(m, m.size - 7, 0);
  finder(m, 0, m.size - 7);
  for (const c of m.align || []) {
    for (const r of m.align) {
      if ((r === 6 && c === 6) || (r === 6 && c === m.align.at(-1)) || (r === m.align.at(-1) && c === 6)) continue;
      alignment(m, c, r);
    }
  }
  for (let i = 0; i < m.size; i++) {
    setF(m, 6, i, i % 2 === 0);
    setF(m, i, 6, i % 2 === 0);
  }
  setF(m, 8, m.size - 8, true); // dark module
  // Format info areas, filled later (still function modules so data skips them).
  for (let i = 0; i < 9; i++) {
    setF(m, 8, i, false);
    setF(m, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setF(m, m.size - 1 - i, 8, false);
    setF(m, 8, m.size - 1 - i, false);
  }
}

function placeData(m, codewords) {
  const bits = [];
  for (const b of codewords) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
  let i = 0;
  for (let col = m.size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let vert = 0; vert < m.size; vert++) {
      for (const c of [col, col - 1]) {
        const upward = Math.floor((m.size - col) / 2) % 2 === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (m.fun[y][c]) continue;
        m.dark[y][c] = i < bits.length ? bits[i++] === 1 : false;
      }
    }
  }
}

function applyFormat(m, mask) {
  const bits = formatBits(mask);
  const coords = [];
  for (let i = 0; i <= 8; i++) if (i !== 6) coords.push([8, i]);
  for (let i = 7; i >= 0; i--) if (i !== 6) coords.push([i, 8]);
  // The 15 format bits are split; the standard order is specific. Use the well-known positions.
  const horiz = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  const vert = [];
  for (let i = 0; i < 7; i++) vert.push([m.size - 1 - i, 8]);
  vert.push([8, m.size - 8], [8, m.size - 7]);
  for (let i = 0; i < 6; i++) vert.push([8, m.size - 6 + i]);
  // Simpler, documented positions (bit 0 is LSB, placed at the finder-adjacent end):
  const around = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const other = [
    [m.size - 1, 8], [m.size - 2, 8], [m.size - 3, 8], [m.size - 4, 8], [m.size - 5, 8], [m.size - 6, 8], [m.size - 7, 8],
    [8, m.size - 8], [8, m.size - 7], [8, m.size - 6], [8, m.size - 5], [8, m.size - 4], [8, m.size - 3], [8, m.size - 2], [8, m.size - 1],
  ];
  for (let i = 0; i < 15; i++) {
    const on = ((bits >>> i) & 1) === 1;
    const [x, y] = around[i];
    m.dark[y][x] = on;
    const [x2, y2] = other[i];
    m.dark[y2][x2] = on;
  }
  void horiz;
  void vert;
  void coords;
}

function penalty(m) {
  let score = 0;
  const n = m.size;
  for (let y = 0; y < n; y++) {
    let run = 1;
    for (let x = 1; x < n; x++) {
      if (m.dark[y][x] === m.dark[y][x - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.dark[y][x]) dark++;
  score += Math.floor(Math.abs(dark / (n * n) * 100 - 50) / 5) * 10;
  return score;
}

/** Module matrix, true = dark. */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const ver = pickVersion(bytes.length);
  if (!ver) throw new Error("pairing url is too long for a QR code");
  const data = dataCodewords(bytes, ver);
  const ecc = rsRemainder(data, ver.ecc);
  const codewords = new Uint8Array(data.length + ecc.length);
  codewords.set(data);
  codewords.set(ecc, data.length);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = blank(ver.size);
    m.align = ver.align;
    reserve(m);
    placeData(m, codewords);
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size; x++) if (!m.fun[y][x] && MASKS[mask](y, x)) m.dark[y][x] = !m.dark[y][x];
    }
    applyFormat(m, mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m.dark.map((row) => row.slice());
    }
  }
  return best;
}

/** SVG plus a row-major 0/1 grid the CLI can print. */
export function qrSvg(text) {
  const matrix = qrMatrix(text);
  const n = matrix.length;
  const cell = 4;
  const quiet = 4;
  const dim = (n + quiet * 2) * cell;
  const rects = [];
  const rows = [];
  for (let y = 0; y < n; y++) {
    let row = "";
    for (let x = 0; x < n; x++) {
      const on = matrix[y][x];
      row += on ? "1" : "0";
      if (on) rects.push(`<rect x="${(x + quiet) * cell}" y="${(y + quiet) * cell}" width="${cell}" height="${cell}" fill="#000"/>`);
    }
    rows.push(row);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" data-modules="${rows.join("\\n")}"><rect width="100%" height="100%" fill="#fff"/>${rects.join("")}</svg>`;
  return { svg, modules: rows.join("\n") };
}
