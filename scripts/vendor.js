import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const pairs = [
  ['leaflet/dist/leaflet-src.esm.js', 'leaflet.js'], ['leaflet/dist/leaflet.css', 'leaflet.css'], ['leaflet/LICENSE', 'leaflet-LICENSE'],
  ['qrcode-generator/dist/qrcode.mjs', 'qrcode.js'],
  ['maplibre-gl/dist/maplibre-gl.mjs', 'maplibre/maplibre-gl.mjs'], ['maplibre-gl/dist/maplibre-gl-worker.mjs', 'maplibre/maplibre-gl-worker.mjs'],
  ['maplibre-gl/dist/maplibre-gl.css', 'maplibre/maplibre-gl.css'], ['maplibre-gl/LICENSE.txt', 'maplibre/LICENSE.txt'],
  ['@maplibre/maplibre-gl-leaflet/dist/leaflet-maplibre-gl.mjs', 'maplibre-leaflet.js'], ['@maplibre/maplibre-gl-leaflet/LICENSE', 'maplibre-leaflet-LICENSE']
];
for (const [source, target] of pairs) {
  let expected = await readFile(new URL(`node_modules/${source}`, root), 'utf8');
  if (target === 'leaflet.js') expected = expected.replace('//# sourceMappingURL=leaflet-src.esm.js.map', '');
  if (target.startsWith('maplibre/') && target.endsWith('.mjs')) expected = expected.replace(/\/\/# sourceMappingURL=.*/g, '');
  if (target === 'maplibre-leaflet.js') expected = '// Adapted only package import paths for same-origin browser hosting.\n' + expected.replace('from "leaflet"', 'from "./leaflet.js"').replace('from "maplibre-gl"', 'from "./maplibre/maplibre-gl.mjs"');
  const file = new URL(`public/vendor/${target}`, root);
  if (process.argv.includes('--check')) {
    if ((await readFile(file, 'utf8')).replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) throw new Error(`Vendored ${target} differs from the locked npm dependency. Run npm run vendor:sync.`);
  } else { await writeFile(file, expected); }
}
