import * as L from './vendor/leaflet.js';

export function mapLinks(p, userAgent = navigator.userAgent) {
  const point = `${p.latitude},${p.longitude}`;
  const title = '分享的位置';
  const baiduQuery = new URLSearchParams({ location: point, title, content: '一次位置分享', coord_type: 'wgs84', output: 'html', src: 'webapp.locationShare.locationShare' });
  const baiduWeb = `https://api.map.baidu.com/marker?${baiduQuery}`;
  const mobile = /Android|iPhone|iPad|iPod/i.test(userAgent);
  if (mobile) baiduQuery.set('src', `${/Android/i.test(userAgent) ? 'andr' : 'ios'}.locationShare.locationShare`);
  return {
    amap: `https://uri.amap.com/marker?${new URLSearchParams({ position: `${p.longitude},${p.latitude}`, name: title, src: 'location-share', coordinate: 'wgs84', callnative: '1' })}`,
    baidu: mobile ? `baidumap://map/marker?${baiduQuery}` : baiduWeb,
    baiduWeb,
    google: `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: point })}`,
    apple: `https://maps.apple.com/?${new URLSearchParams({ ll: point, q: title })}`
  };
}

const STYLES = new Set(['positron', 'liberty', 'dark']);
const VECTOR_ATTRIBUTION = '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';
const RASTER_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

export function showMap(p) {
  const container = document.getElementById('position-map');
  const selector = document.getElementById('map-style');
  if (Math.abs(p.latitude) > 85.05112878) {
    container.textContent = '此位置超出网页地图的显示范围。请查看坐标或通过地图 APP 打开。';
    container.classList.add('map-unavailable'); selector.disabled = true;
    container.dataset.basemap = 'unsupported';
    return () => container.replaceChildren();
  }
  const latlng = [p.latitude, p.longitude];
  const map = L.map('position-map', { scrollWheelZoom: false, maxZoom: 19 }).setView(latlng, 16);
  map.attributionControl.setPrefix(false);
  const range = L.circle(latlng, { radius: p.accuracy, color: '#245b48', weight: 1, fillOpacity: 0.12 }).addTo(map);
  if (p.accuracy > 0) map.fitBounds(range.getBounds(), { padding: [24, 24], maxZoom: 16, animate: false });
  const marker = L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#245b48', fillOpacity: 1 }).addTo(map);
  const note = document.getElementById('map-note');
  let selected = 'positron', ended = false, vector = null, raster = null, timeout = null;
  try { const saved = localStorage.getItem('map-style'); if (STYLES.has(saved)) selected = saved; } catch { /* Style still switches in memory. */ }
  selector.value = selected;
  function status(message) { if (!ended) { note.textContent = message; note.hidden = !message; } }
  function colors() {
    const green = selected === 'dark' && !raster ? '#8cc8aa' : '#245b48';
    range.setStyle({ color: green }); marker.setStyle({ fillColor: green });
  }
  function fallback() {
    if (ended || raster) return;
    clearTimeout(timeout);
    if (vector) {
      try { map.removeLayer(vector); } catch {
        const incomplete = vector;
        incomplete.onRemove = () => incomplete._container?.remove();
        map.removeLayer(incomplete);
      }
      vector = null;
    }
    container.dataset.basemap = 'fallback'; selector.disabled = true;
    raster = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: RASTER_ATTRIBUTION });
    raster.on('tileerror', () => status('底图加载失败，可以通过下面的地图 APP 打开位置。'));
    raster.addTo(map); colors();
    status('清爽底图暂不可用，已切换到基础地图；仍可通过下面的地图 APP 打开位置。');
  }
  function loading() {
    clearTimeout(timeout); status('正在加载底图…');
    timeout = setTimeout(fallback, 12000);
  }
  function localNames(gl) {
    if (selected === 'positron') nordicColors(gl);
    // Prefer local names, so Chinese road names are not displayed as duplicate pinyin lines.
    for (const layer of gl.getStyle().layers) {
      const field = layer.layout?.['text-field'];
      if (!field || !/name(?::|_|["}])/.test(JSON.stringify(field))) continue;
      const original = typeof field === 'string' ? ['get', /\{([^}]+)\}/.exec(field)?.[1] || 'name'] : field;
      gl.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:zh'], ['get', 'name'], original]);
    }
  }
  function nordicColors(gl) {
    const palette = {
      background: ['background-color', '#f5f6ef'], park: ['fill-color', '#dfe9d5'],
      water: ['fill-color', '#c7dce1'], waterway: ['line-color', '#b7cfd6'],
      building: ['fill-color', '#e8e5d9'], landuse_residential: ['fill-color', '#eff0e5'],
      landcover_wood: ['fill-color', '#d4e2c8'], highway_minor: ['line-color', '#fffefa'],
      highway_major_inner: ['line-color', '#f2e6be'], highway_motorway_inner: ['line-color', '#eadca8']
    };
    for (const [id, [property, color]] of Object.entries(palette)) if (gl.getLayer(id)) gl.setPaintProperty(id, property, color);
    if (gl.getLayer('building')) gl.setPaintProperty('building', 'fill-outline-color', '#d8dacd');
    for (const layer of gl.getStyle().layers) {
      if (layer.type === 'symbol' && layer.layout?.['text-field']) {
        gl.setPaintProperty(layer.id, 'text-color', '#627768');
        gl.setPaintProperty(layer.id, 'text-halo-color', '#fffefa');
      }
      if (layer.type === 'line' && /casing/.test(layer.id)) gl.setPaintProperty(layer.id, 'line-color', '#d6dacd');
    }
  }
  loading();
  const probe = document.createElement('canvas');
  const gpu = probe.getContext('webgl2');
  if (!gpu) { fallback(); return () => { ended = true; clearTimeout(timeout); map.remove(); }; }
  gpu.getExtension('WEBGL_lose_context')?.loseContext();
  void Promise.all([import('./vendor/maplibre/maplibre-gl.mjs'), import('./vendor/maplibre-leaflet.js')]).then(([gl, adapter]) => {
    if (ended || raster) return;
    gl.setWorkerUrl(new URL('./vendor/maplibre/maplibre-gl-worker.mjs', import.meta.url).href);
    vector = adapter.maplibreGL({
      style: `https://tiles.openfreemap.org/styles/${selected}`,
      localIdeographFontFamily: 'sans-serif',
      attributionControl: { customAttribution: VECTOR_ATTRIBUTION },
      interactive: false, padding: 0
    });
    vector.addTo(map); colors();
    const renderer = vector.getMaplibreMap();
    renderer.on('style.load', () => { if (!ended && vector) localNames(renderer); });
    renderer.on('idle', () => {
      if (ended || raster) return;
      clearTimeout(timeout); container.dataset.basemap = selected; status('');
    });
    renderer.on('error', () => {
      if (!ended && !raster) status('底图加载不完整，可以更换风格，或通过下面的地图 APP 打开位置。');
    });
    selector.onchange = () => {
      if (!STYLES.has(selector.value) || !vector || ended) return;
      selected = selector.value;
      try { localStorage.setItem('map-style', selected); } catch { /* Current selection still works. */ }
      loading(); colors(); renderer.setStyle(`https://tiles.openfreemap.org/styles/${selected}`);
    };
  }).catch(fallback);
  map.whenReady(() => map.invalidateSize());
  return () => { ended = true; clearTimeout(timeout); selector.onchange = null; map.remove(); };
}
