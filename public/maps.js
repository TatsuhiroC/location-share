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

export function showMap(p) {
  const latlng = [p.latitude, p.longitude];
  const map = L.map('position-map', { scrollWheelZoom: false, maxZoom: 19 }).setView(latlng, 16);
  map.attributionControl.setPrefix(false);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
  });
  // No background downloads or proxy: browsers honour the tile server's cache headers.
  tiles.on('tileerror', () => {
    const note = document.getElementById('map-note');
    if (note) { note.textContent = '底图加载失败，可以通过下面的地图 APP 打开位置。'; note.hidden = false; }
  });
  tiles.addTo(map);
  L.circle(latlng, { radius: p.accuracy, color: '#245b48', weight: 1, fillOpacity: 0.12 }).addTo(map);
  L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#245b48', fillOpacity: 1 }).addTo(map);
  map.whenReady(() => map.invalidateSize());
  return () => map.remove();
}
