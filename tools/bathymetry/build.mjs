// Offline bathymetry pipeline for Krill (engine-agnostic output).
//
//   node tools/bathymetry/build.mjs [--refetch]
//
// Fetches real Monterey Bay elevation from the NOAA NCEI "DEM Global Mosaic"
// ArcGIS ImageServer (which mosaics the best NCEI DEM available at each spot:
// CUDEM 1/9", the Monterey 1/3" tsunami DEM, the Southern California CRM 1"/3"
// and ETOPO 2022 15" offshore), resamples it onto a local equirectangular metre
// grid centred on the bay, and writes:
//
//   assets/bathymetry/manifest.json          grid levels, projection, attribution
//   assets/bathymetry/tiles/L0_<ix>_<iz>.i16.gz  30 m tiles, 257x257 samples
//   assets/bathymetry/bay_120m.i16.gz        whole-bay 120 m grid (always loaded)
//   assets/bathymetry/region_500m.i16.gz     256 km regional 500 m grid (always loaded)
//   assets/bathymetry/map_bay.png            512 px shaded relief of the bay
//   assets/bathymetry/map_region.png         512 px shaded relief of the region
//
// Sample format: gzip-compressed raw little-endian Int16, row-major, rows run
// north -> south (+z), columns west -> east (+x). height_m = value * heightScale.
// Only Node built-ins are used (fetch, zlib, fs). Raw downloads are cached in
// tools/bathymetry/.cache (git-ignored); pass --refetch to download again.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const outDir = path.join(root, 'assets', 'bathymetry');
const cacheDir = path.join(here, '.cache');
const refetch = process.argv.includes('--refetch');
fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

// ---- projection ----------------------------------------------------------
// Local equirectangular around the bay centre: x = east metres, z = south
// metres (three.js convention: north is -z), y = up (height, sea level 0).
const LAT0 = 36.75;
const LON0 = -122.165;
const R = 6371008.8; // mean Earth radius (m)
const M_PER_DEG_LAT = (R * Math.PI) / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const toLon = (x) => LON0 + x / M_PER_DEG_LON;
const toLat = (z) => LAT0 - z / M_PER_DEG_LAT;

const HEIGHT_SCALE = 0.25; // metres per Int16 unit (range +-8191 m)

// ---- levels ----------------------------------------------------------------
const TILE = 256; // cells per tile (257 samples: tiles share their edge row/column)
const L0 = { res: 30, tilesX: 9, tilesZ: 9 };
L0.size = TILE * L0.tilesX * L0.res; // 69,120 m
L0.xMin = -L0.size / 2;
L0.zMin = -L0.size / 2;
const BAY = { res: 120, cells: 576, xMin: L0.xMin, zMin: L0.zMin }; // same extent as L0
const REGION = { res: 500, cells: 512, xMin: -128000, zMin: -128000 }; // 256 km

const SERVICE = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage';

// Request an nx x ny grid of point samples whose first sample sits at
// (xMin, zMin) with spacing res. ArcGIS bboxes are pixel *edges*, so the bbox
// is padded by half a cell to put pixel centres exactly on our grid nodes.
//
// adjustAspectRatio=false is essential: our pixels are not square in degrees
// (a 30 m cell spans 3.37e-4 deg of longitude but only 2.70e-4 deg of latitude),
// and by default ArcGIS silently grows the bbox so pixels become square in
// degrees, stretching every request N-S about its own centre (~1/cos(lat0) =
// 1.25x). That produced seam cliffs between tile rows and disagreeing levels.
// The checks at the end of this script guard against any regression.
function gridUrl(xMin, zMin, res, nx, ny) {
  const w = toLon(xMin - res / 2);
  const e = toLon(xMin + (nx - 1) * res + res / 2);
  const n = toLat(zMin - res / 2);
  const s = toLat(zMin + (ny - 1) * res + res / 2);
  const q = new URLSearchParams({
    bbox: `${w},${s},${e},${n}`,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${nx},${ny}`,
    adjustAspectRatio: 'false',
    format: 'bsq',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  });
  return `${SERVICE}?${q}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchGrid(name, xMin, zMin, res, nx, ny) {
  const cache = path.join(cacheDir, `${name}.f32`);
  const url = gridUrl(xMin, zMin, res, nx, ny);
  let buf;
  if (!refetch && fs.existsSync(cache)) {
    buf = fs.readFileSync(cache);
  } else {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < nx * ny * 4) throw new Error(`short response ${buf.length} < ${nx * ny * 4}`);
        break;
      } catch (e) {
        if (attempt >= 4) throw new Error(`${name}: ${e.message}\n${url}`);
        console.warn(`  ${name}: ${e.message}, retrying`);
        await sleep(3000 * attempt);
      }
    }
    fs.writeFileSync(cache, buf);
  }
  // the service appends a few padding bytes; keep exactly nx*ny floats
  const f = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) f[i] = buf.readFloatLE(i * 4);
  fillHoles(f, nx, ny, name);
  console.log(`  ${name}: ${nx}x${ny} @ ${res} m`);
  return { data: f, nx, ny, url };
}

// Replace NaN / nodata with the mean of valid neighbours (iterative dilation).
function fillHoles(f, nx, ny, name) {
  const bad = (v) => !Number.isFinite(v) || v < -11000 || v > 9000;
  let holes = 0;
  for (let i = 0; i < f.length; i++) if (bad(f[i])) { f[i] = NaN; holes++; }
  if (!holes) return;
  console.warn(`  ${name}: filling ${holes} nodata samples`);
  for (let pass = 0; pass < 64 && holes; pass++) {
    const src = f.slice();
    holes = 0;
    for (let z = 0; z < ny; z++) for (let x = 0; x < nx; x++) {
      const i = z * nx + x;
      if (!Number.isNaN(src[i])) continue;
      let s = 0, n = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= nx || zz >= ny) continue;
        const v = src[zz * nx + xx];
        if (!Number.isNaN(v)) { s += v; n++; }
      }
      if (n) f[i] = s / n; else holes++;
    }
  }
  for (let i = 0; i < f.length; i++) if (Number.isNaN(f[i])) f[i] = 0;
}

function writeI16(file, f) {
  const i16 = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) i16[i] = Math.max(-32767, Math.min(32767, Math.round(f[i] / HEIGHT_SCALE)));
  const raw = Buffer.from(i16.buffer); // little-endian on every platform Node ships on
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(file, gz);
  return gz.length;
}

// ---- PNG (RGB8) writer -------------------------------------------------------
function png(width, height, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 3 + 1)] = 0;
    rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shaded relief: depth-tinted water + hillshade, flat pale land (the pause map
// draws its own contour hairlines on top).
function reliefPng(grid, res, size) {
  const { data, nx, ny } = grid;
  const sample = (u, v) => {
    const x = Math.min(nx - 1.001, Math.max(0, u)), z = Math.min(ny - 1.001, Math.max(0, v));
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
    const a = data[z0 * nx + x0], b = data[z0 * nx + x0 + 1], c = data[(z0 + 1) * nx + x0], d = data[(z0 + 1) * nx + x0 + 1];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  };
  const rgb = Buffer.alloc(size * size * 3);
  const k = (nx - 1) / size; // grid cells per output pixel
  const cell = res * k;
  const ramp = [ // depth (m), colour
    [0, [168, 214, 222]], [100, [104, 170, 196]], [300, [58, 118, 160]],
    [1000, [34, 74, 122]], [2500, [20, 42, 84]], [4500, [10, 22, 52]],
  ];
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const u = (px + 0.5) * k, v = (py + 0.5) * k;
    const h = sample(u, v);
    const dzdx = (sample(u + 1, v) - sample(u - 1, v)) / (2 * res);
    const dzdy = (sample(u, v + 1) - sample(u, v - 1)) / (2 * res);
    // sun from the north-west, 45 deg up; exaggerate slopes a little
    const ex = 3;
    const nxv = -dzdx * ex, nzv = -dzdy * ex, ny_ = 1;
    const nl = Math.hypot(nxv, ny_, nzv);
    const lx = -0.5, ly = 0.7071, lz = -0.5;
    const shade = Math.max(0, (nxv * lx + ny_ * ly + nzv * lz) / nl);
    let col;
    if (h >= 0) {
      col = [236, 232, 222];
      const s = 0.9 + 0.1 * shade;
      col = col.map((c) => c * s);
    } else {
      const d = -h;
      let i = 0;
      while (i < ramp.length - 2 && d > ramp[i + 1][0]) i++;
      const t = Math.min(1, (d - ramp[i][0]) / (ramp[i + 1][0] - ramp[i][0]));
      col = ramp[i][1].map((c, j) => c + (ramp[i + 1][1][j] - c) * t);
      const s = 0.55 + 0.6 * shade;
      col = col.map((c) => c * s);
    }
    const o = (py * size + px) * 3;
    rgb[o] = Math.max(0, Math.min(255, col[0]));
    rgb[o + 1] = Math.max(0, Math.min(255, col[1]));
    rgb[o + 2] = Math.max(0, Math.min(255, col[2]));
  }
  void cell;
  return png(size, size, rgb);
}

function stats(f) {
  let min = Infinity, max = -Infinity;
  for (const v of f) { if (v < min) min = v; if (v > max) max = v; }
  return { min: +min.toFixed(1), max: +max.toFixed(1) };
}

// ---- main ------------------------------------------------------------------
console.log('Fetching NOAA NCEI DEM Global Mosaic...');
const region = await fetchGrid('region_500m', REGION.xMin, REGION.zMin, REGION.res, REGION.cells + 1, REGION.cells + 1);
const bay = await fetchGrid('bay_120m', BAY.xMin, BAY.zMin, BAY.res, BAY.cells + 1, BAY.cells + 1);

// L0: fetch one 257-row strip per tile row, then slice into tiles (tiles share edges)
const nxAll = L0.tilesX * TILE + 1;
const nzAll = L0.tilesZ * TILE + 1;
const strips = [];
for (let iz = 0; iz < L0.tilesZ; iz++) {
  strips.push(await fetchGrid(`L0_row${iz}`, L0.xMin, L0.zMin + iz * TILE * L0.res, L0.res, nxAll, TILE + 1));
}

// ---- automated checks (abort before writing anything if they fail) ----------
const failures = [];
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };
console.log('Checks:');

// 1. seam continuity: the last row of strip iz and the first row of strip iz+1
//    sample the same latitude, so they must agree (E-W seams share one strip)
{
  let worst = 0, sum = 0, n = 0;
  for (let iz = 0; iz + 1 < strips.length; iz++) {
    const a = strips[iz].data, b = strips[iz + 1].data;
    for (let x = 0; x < nxAll; x++) {
      const d = Math.abs(a[TILE * nxAll + x] - b[x]);
      worst = Math.max(worst, d); sum += d; n++;
    }
  }
  check(worst <= 5 && sum / n <= 0.5, `L0 N-S tile seams: max |dh| ${worst.toFixed(2)} m, mean ${(sum / n).toFixed(3)} m (limit 5 / 0.5)`);
}

// assemble the full L0 mosaic
const l0 = new Float32Array(nxAll * nzAll);
for (let iz = 0; iz < strips.length; iz++) l0.set(strips[iz].data, iz * TILE * nxAll);
const l0Grid = { data: l0, nx: nxAll, ny: nzAll, res: L0.res, xMin: L0.xMin, zMin: L0.zMin };
const bayGrid = { ...bay, res: BAY.res, xMin: BAY.xMin, zMin: BAY.zMin };
const regionGrid = { ...region, res: REGION.res, xMin: REGION.xMin, zMin: REGION.zMin };
// bilinear height at projected (x, z), or local mean over a box of +-r metres
const hAt = (g, x, z) => {
  const u = (x - g.xMin) / g.res, v = (z - g.zMin) / g.res;
  const i = Math.max(0, Math.min(g.nx - 2, Math.floor(u))), j = Math.max(0, Math.min(g.ny - 2, Math.floor(v)));
  const fx = u - i, fz = v - j, d = g.data, n = g.nx;
  return (d[j * n + i] * (1 - fx) + d[j * n + i + 1] * fx) * (1 - fz) + (d[(j + 1) * n + i] * (1 - fx) + d[(j + 1) * n + i + 1] * fx) * fz;
};
const hMean = (g, x, z, r) => {
  let s = 0, n = 0;
  for (let dz = -r; dz <= r; dz += r / 4) for (let dx = -r; dx <= r; dx += r / 4) { s += hAt(g, x + dx, z + dz); n++; }
  return s / n;
};

// 2. level agreement on a 40x40 lattice: each coarse level against the L0
//    mosaic averaged over the coarse cell (so resolution alone doesn't count)
{
  const stat = (arr) => { arr.sort((a, b) => a - b); return { med: arr[arr.length >> 1], p90: arr[Math.floor(arr.length * 0.9)] }; };
  const dBay = [], dReg = [];
  for (let j = 1; j < 40; j++) for (let i = 1; i < 40; i++) {
    const x = L0.xMin + (i / 40) * L0.size, z = L0.zMin + (j / 40) * L0.size;
    dBay.push(Math.abs(hAt(bayGrid, x, z) - hMean(l0Grid, x, z, 60)));
    dReg.push(Math.abs(hAt(regionGrid, x, z) - hMean(l0Grid, x, z, 250)));
  }
  const sb = stat(dBay), sr = stat(dReg);
  check(sb.med <= 5 && sb.p90 <= 30, `120 m vs 30 m: median |dh| ${sb.med.toFixed(1)} m, p90 ${sb.p90.toFixed(1)} m (limit 5 / 30)`);
  check(sr.med <= 15 && sr.p90 <= 120, `500 m vs 30 m: median |dh| ${sr.med.toFixed(1)} m, p90 ${sr.p90.toFixed(1)} m (limit 15 / 120)`);
}

// 3. coastline control points: known land / shallow-water spots must come out
//    on the right side of the waterline at 30 m (and 120 m where it's coarse enough)
{
  const P = [
    // name, lat, lon, [min, max] metres at 30 m, check the 120 m level too
    ['Santa Cruz wharf, end (water)', 36.9563, -122.0171, [-25, 0], false],
    ['Santa Cruz Boardwalk (land)', 36.9640, -122.0180, [0, 60], false],
    ['Moss Landing harbour mouth (water)', 36.8043, -121.7894, [-60, 0], false],
    ['Moss Landing power plant (land)', 36.8050, -121.7810, [0, 40], false],
    ['Monterey Municipal Wharf 2, end (water)', 36.6053, -121.8898, [-25, 0], false],
    ['Point Pinos lighthouse (land)', 36.6335, -121.9335, [0, 60], true],
    ['Monterey Canyon head, 1.5 km off Moss Landing (deep)', 36.8025, -121.8080, [-250, -80], true],
    ['Santa Cruz shelf 36.90N 122.05W (shelf)', 36.9000, -122.0500, [-70, -20], true],
  ];
  for (const [name, lat, lon, [lo, hi], coarse] of P) {
    const x = (lon - LON0) * M_PER_DEG_LON, z = -(lat - LAT0) * M_PER_DEG_LAT;
    const h = hAt(l0Grid, x, z);
    let ok = h >= lo && h <= hi;
    let msg = `${name}: ${h.toFixed(1)} m at 30 m`;
    if (coarse) {
      const hb = hAt(bayGrid, x, z);
      ok = ok && Math.sign(hb) === Math.sign(h);
      msg += `, ${hb.toFixed(1)} m at 120 m`;
    }
    check(ok, `${msg} (expect ${lo}..${hi})`);
  }
}
if (failures.length && !process.argv.includes('--force')) {
  console.error(`\n${failures.length} check(s) failed; nothing written (pass --force to write anyway).`);
  process.exit(1);
}

// ---- write -------------------------------------------------------------------
const tileBytes = [];
let l0Min = Infinity, l0Max = -Infinity;
for (let iz = 0; iz < L0.tilesZ; iz++) {
  for (let ix = 0; ix < L0.tilesX; ix++) {
    const t = new Float32Array((TILE + 1) * (TILE + 1));
    for (let z = 0; z <= TILE; z++) {
      for (let x = 0; x <= TILE; x++) {
        const v = l0[(iz * TILE + z) * nxAll + ix * TILE + x];
        t[z * (TILE + 1) + x] = v;
        if (v < l0Min) l0Min = v;
        if (v > l0Max) l0Max = v;
      }
    }
    tileBytes.push(writeI16(path.join(outDir, 'tiles', `L0_${ix}_${iz}.i16.gz`), t));
  }
}
const bayBytes = writeI16(path.join(outDir, 'bay_120m.i16.gz'), bay.data);
const regionBytes = writeI16(path.join(outDir, 'region_500m.i16.gz'), region.data);
fs.writeFileSync(path.join(outDir, 'map_bay.png'), reliefPng(bay, BAY.res, 512));
fs.writeFileSync(path.join(outDir, 'map_region.png'), reliefPng(region, REGION.res, 512));

const bboxOf = (xMin, zMin, size) => ({
  west: +toLon(xMin).toFixed(6), east: +toLon(xMin + size).toFixed(6),
  north: +toLat(zMin).toFixed(6), south: +toLat(zMin + size).toFixed(6),
});
const manifest = {
  name: 'Monterey Bay',
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  generator: 'tools/bathymetry/build.mjs',
  source: {
    name: 'NOAA NCEI DEM Global Mosaic (ArcGIS ImageServer exportImage)',
    service: SERVICE,
    components: 'Best-available NCEI DEMs mosaicked by NCEI: CUDEM 1/9 arc-second (nearshore), Monterey CA 1/3 arc-second coastal DEM, Southern California Coastal Relief Model 1 and 3 arc-second, ETOPO 2022 15 arc-second (offshore).',
    attribution: 'Bathymetry: NOAA National Centers for Environmental Information (NCEI), DEM Global Mosaic. Public domain (US Government work).',
    license: 'Public domain (U.S. Government work); please credit NOAA NCEI.',
  },
  projection: {
    type: 'equirectangular',
    lat0: LAT0, lon0: LON0, earthRadius: R,
    metresPerDegLat: +M_PER_DEG_LAT.toFixed(4),
    metresPerDegLon: +M_PER_DEG_LON.toFixed(4),
    axes: 'x = east metres, z = south metres (north is -z), y = up metres (0 = sea level)',
    formula: 'x = (lon - lon0) * metresPerDegLon; z = -(lat - lat0) * metresPerDegLat',
  },
  sample: {
    format: 'int16le', compression: 'gzip', heightScale: HEIGHT_SCALE,
    layout: 'row-major; rows north->south (+z), columns west->east (+x); first sample at (xMin, zMin)',
  },
  levels: {
    L0: {
      res: L0.res, tileCells: TILE, tileSamples: TILE + 1, tilesX: L0.tilesX, tilesZ: L0.tilesZ,
      xMin: L0.xMin, zMin: L0.zMin, size: L0.size,
      path: 'tiles/L0_{ix}_{iz}.i16.gz', bbox: bboxOf(L0.xMin, L0.zMin, L0.size),
      minHeight: +l0Min.toFixed(1), maxHeight: +l0Max.toFixed(1),
    },
    bay: {
      res: BAY.res, samples: BAY.cells + 1, xMin: BAY.xMin, zMin: BAY.zMin, size: BAY.cells * BAY.res,
      path: 'bay_120m.i16.gz', bbox: bboxOf(BAY.xMin, BAY.zMin, BAY.cells * BAY.res), ...stats(bay.data),
    },
    region: {
      res: REGION.res, samples: REGION.cells + 1, xMin: REGION.xMin, zMin: REGION.zMin, size: REGION.cells * REGION.res,
      path: 'region_500m.i16.gz', bbox: bboxOf(REGION.xMin, REGION.zMin, REGION.cells * REGION.res), ...stats(region.data),
    },
  },
  maps: {
    bay: {
      image: 'map_bay.png', width: 512, height: 512,
      xMin: BAY.xMin, zMin: BAY.zMin, size: BAY.cells * BAY.res,
      toPixel: 'px = (x - xMin) / size * width; py = (z - zMin) / size * height',
      bbox: bboxOf(BAY.xMin, BAY.zMin, BAY.cells * BAY.res),
    },
    region: {
      image: 'map_region.png', width: 512, height: 512,
      xMin: REGION.xMin, zMin: REGION.zMin, size: REGION.cells * REGION.res,
      toPixel: 'px = (x - xMin) / size * width; py = (z - zMin) / size * height',
      bbox: bboxOf(REGION.xMin, REGION.zMin, REGION.cells * REGION.res),
    },
  },
  regions: 'regions.json',
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const total = tileBytes.reduce((a, b) => a + b, 0) + bayBytes + regionBytes;
console.log(`L0 tiles: ${tileBytes.length}, ${(tileBytes.reduce((a, b) => a + b, 0) / 1e6).toFixed(2)} MB; heights ${l0Min.toFixed(0)}..${l0Max.toFixed(0)} m`);
console.log(`bay: ${(bayBytes / 1e6).toFixed(2)} MB, region: ${(regionBytes / 1e6).toFixed(2)} MB; total grids ${(total / 1e6).toFixed(2)} MB`);
console.log('example request:', bay.url);
