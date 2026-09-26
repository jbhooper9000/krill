# Monterey Bay bathymetry pipeline

`node tools/bathymetry/build.mjs` (Node 22+, built-ins only) regenerates everything
in `assets/bathymetry/`. The output is committed; the script only needs to run again
to change the extent or resolution. Raw downloads are cached in
`tools/bathymetry/.cache/` (git-ignored); `--refetch` downloads again.

## Source

**NOAA NCEI DEM Global Mosaic**, fetched from the ArcGIS ImageServer `exportImage`
endpoint as raw little-endian Float32 (`format=bsq`, `pixelType=F32`, bilinear):

```
https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage
  ?bbox=<west>,<south>,<east>,<north>&bboxSR=4326&imageSR=4326&size=<nx>,<ny>
  &format=bsq&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image
```

The service mosaics the best NCEI DEM at each point. Over Monterey Bay it
contains (queried from the service's raster catalogue):

| DEM | Cell size |
| --- | --- |
| CUDEM `ncei19_n36x75/n37x00_w122x00/w122x25_2023v1` (nearshore) | 1/9 arc-second (~3 m) |
| `monterey_ca` / `monterey_ca_mhw` / `monterey_navd88` coastal DEM (includes MBARI multibeam) | 1/3 arc-second (~10 m) |
| Southern California Coastal Relief Model `socal_1as` / `socal_3as` | 1" / 3" (~30 / 90 m) |
| ETOPO 2022 v1 15 arc-second (fallback offshore) | ~450 m |

We resample it to **30 m** for the streamed tiles (the canyon's multibeam is finer,
but 30 m fits the size budget and is well below whale-scale detail, which the
runtime adds procedurally).

**Attribution / licence:** Bathymetry: NOAA National Centers for Environmental
Information (NCEI), DEM Global Mosaic. U.S. Government work, public domain; please
credit NOAA NCEI.

GMRT GridServer (`https://www.gmrt.org/services/GridServer`) was tried first; on
2026-09-27 every request returned `504 Gateway Time-out`. NOAA CoastWatch ERDDAP
(`etopo180`, `ETOPO_2022_v1_15s`) worked but is only 1'/15" resolution, so the NCEI
mosaic was used.

## Projection

Local equirectangular around the bay centre, `lat0 = 36.75`, `lon0 = -122.165`,
Earth radius 6,371,008.8 m:

```
x = (lon - lon0) * 111195.08 * cos(lat0)   // metres east   (89,103.6 m/deg)
z = -(lat - lat0) * 111195.08              // metres south  (north is -z)
y = height in metres, sea level 0, negative underwater
```

Because the projection is linear in lat/lon, a regular lat/lon request maps to a
regular metre grid exactly. Scale error vs. true distances is < 0.5 % across the bay.

## Output (`assets/bathymetry/`)

| File | Contents |
| --- | --- |
| `manifest.json` | projection, sample format, level extents, min/max heights, map mapping, attribution |
| `tiles/L0_<ix>_<iz>.i16.gz` | 9 x 9 tiles, 30 m, 257 x 257 samples (neighbours share their edge row/column); 69.12 km square centred on the bay: 36.439–37.061 N, 122.554–121.776 W |
| `bay_120m.i16.gz` | same extent at 120 m (577 x 577), always loaded |
| `region_500m.i16.gz` | 256 km square at 500 m (513 x 513), always loaded; covers Davidson Seamount and Año Nuevo |
| `map_bay.png`, `map_region.png` | 512 px shaded relief (depth-tinted water, pale land) for the pause map |
| `regions.json` | hand-authored regions / POIs (lat/lon circles, canyon-axis corridors, polygons) and the default start point |

Samples are gzip-compressed raw **little-endian Int16**, row-major, rows north→south
(+z), columns west→east (+x), first sample at `(xMin, zMin)`;
`height_m = value * 0.25`. Total size ~7.7 MB.

Map pixel ↔ world: `px = (x - xMin) / size * 512`, `py = (z - zMin) / size * 512`
(values in `manifest.maps`).

Heights range from −3,087 m (lower Monterey Canyon, west edge) to +977 m (Santa
Cruz Mountains) in L0.
