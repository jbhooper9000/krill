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
const tileBytes = [];
let l0Min = Infinity, l0Max = -Infinity;
for (let iz = 0; iz < L0.tilesZ; iz++) {
  const strip = await fetchGrid(`L0_row${iz}`, L0.xMin, L0.zMin + iz * TILE * L0.res, L0.res, nxAll, TILE + 1);
  for (let ix = 0; ix < L0.tilesX; ix++) {
    const t = new Float32Array((TILE + 1) * (TILE + 1));
    for (let z = 0; z <= TILE; z++) {
      for (let x = 0; x <= TILE; x++) {
        const v = strip.data[z * nxAll + ix * TILE + x];
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
