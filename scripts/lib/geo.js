// EuroScope coordinate format: N/S DDD.MM.SS.SSS E/W DDD.MM.SS.SSS

export function decimalToDMS(decimal, isLat) {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minDec = (abs - deg) * 60;
  const min = Math.floor(minDec);
  const sec = ((minDec - min) * 60).toFixed(3);

  const dir = isLat ? (decimal >= 0 ? 'N' : 'S') : (decimal >= 0 ? 'E' : 'W');
  const degPad = isLat ? String(deg).padStart(3, '0') : String(deg).padStart(3, '0');
  const minPad = String(min).padStart(2, '0');
  const secPad = sec.padStart(6, '0');

  return `${dir}${degPad}.${minPad}.${secPad}`;
}

export function coordPair(lat, lon) {
  return `${decimalToDMS(lat, true)} ${decimalToDMS(lon, false)}`;
}

export function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius in NM
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function projectPoint(lat, lon, hdg, distNm) {
  const R = 3440.065;
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const brng = toRad(hdg);
  const d = distNm / R;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));

  return { lat: toDeg(lat2), lon: toDeg(lon2) };
}

export function runwayLengthFt(lat1, lon1, lat2, lon2) {
  return haversineNm(lat1, lon1, lat2, lon2) * 6076.12;
}
