// Genera localita.json dall'elenco stazioni idrometriche CFR Toscana, con coordinate per la mappa.
// Uso: node scripts/genera-localita.js
const fs = require('fs');
const path = require('path');
const { getText, parseTabella, localitaDi } = require('../netlify/functions/idrometri.js');

// UTM (WGS84/ETRS89) → lat/lon
function utmToLatLon(E, N, zona) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000, y = N;
  const mu = (y / k0) / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const T1 = Math.tan(phi1) ** 2, C1 = ep2 * Math.cos(phi1) ** 2;
  const R1 = a * (1 - e2) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = x / (N1 * k0);
  const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(phi1);
  return { lat: lat * 180 / Math.PI, lon: (zona - 1) * 6 - 180 + 3 + lon * 180 / Math.PI };
}

const inToscana = (c) => c && c.lat > 41 && c.lat < 45 && c.lon > 9 && c.lon < 13;
const n = (v) => parseFloat(String(v ?? '').replace(',', '.'));

function coordDa(f) {
  const p = { ...f, ...(f.properties || {}) };
  let x, y;
  let g = f.geometry?.coordinates;
  while (Array.isArray(g) && Array.isArray(g[0])) g = g[0]; // MultiPoint
  if (Array.isArray(g) && g.length >= 2) [x, y] = g.map(Number);
  else {
    const chiave = (re) => Object.keys(p).find((k) => re.test(k));
    const kx = chiave(/^(lon|lng|long|longitudine|x|est|east)$/i), ky = chiave(/^(lat|latitudine|y|nord|north)$/i);
    if (kx && ky) { x = n(p[kx]); y = n(p[ky]); }
  }
  if (!isFinite(x) || !isFinite(y)) return null;
  let c;
  if (Math.abs(x) <= 180 && Math.abs(y) <= 180) c = x > 30 ? { lat: x, lon: y } : { lat: y, lon: x }; // gradi, anche invertiti
  else if (x > 2e6) c = utmToLatLon(x - 2020000, y, 33); // Gauss-Boaga fuso Est (Roma 40), approssimato
  else if (x > 1e6) c = utmToLatLon(x - 1e6, y, 32);      // Gauss-Boaga fuso Ovest, approssimato
  else c = utmToLatLon(x, y, 32);                          // UTM 32N
  return inToscana(c) ? { lat: +c.lat.toFixed(5), lon: +c.lon.toFixed(5) } : null;
}

// Coordinate dal WFS ufficiale "Idrometri" (dati.toscana.it, dataset SIR009), riproiettate in WGS84
const WFS = 'https://geo.sir.toscana.it/geoserver/geo/ows?service=WFS&version=1.0.0&request=GetFeature'
  + '&typeName=geo%3Acf_idrometri&maxFeatures=300000&outputFormat=application%2Fjson&srsName=EPSG%3A4326';

const norm = (t) => String(t ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const cifre = (t) => String(t).replace(/\D/g, '').replace(/^0+/, '');

// Chiavi con cui un record può essere abbinato a una stazione: codice TOS, codice numerico, nome
function chiaviDi(f) {
  const p = { ...(f.properties || {}), ...f };
  const k = new Set();
  for (const [campo, v] of Object.entries(p)) {
    if (v === null || typeof v === 'object') continue;
    const t = String(v).trim();
    if (/^TOS\d+$/i.test(t)) { k.add('id:' + t.toUpperCase()); k.add('n:' + cifre(t)); }
    else if (/^\d{6,9}$/.test(t)) k.add('n:' + cifre(t));
    else if (/nome|stazione|name|denom/i.test(campo) && norm(t)) k.add('s:' + norm(t));
  }
  return k;
}

async function caricaFeature(url, etichetta) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'IdrometriToscana/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feats = JSON.parse(await res.text()).features || [];
    console.log(`${etichetta}: ${feats.length} record`);
    if (feats[0]) console.log(`Esempio ${etichetta}:`, JSON.stringify(feats[0]).slice(0, 400));
    return feats;
  } catch (e) {
    console.warn(`${etichetta} non disponibile: ${e.message}`);
    return [];
  }
}

async function anagrafica() {
  const indice = new Map(); // chiave → coordinate
  const fonti = [
    [WFS, 'WFS idrometri'],
    ['https://www.sir.toscana.it/monitoraggio/actions.php?action=list&type_gauge=idro', 'elenco SIR'],
  ];
  for (const [url, etichetta] of fonti) {
    let conCoord = 0;
    for (const f of await caricaFeature(url, etichetta)) {
      const c = coordDa(f);
      if (!c) continue;
      conCoord++;
      for (const k of chiaviDi(f)) if (!indice.has(k)) indice.set(k, c);
    }
    console.log(`${etichetta}: ${conCoord} record con coordinate valide`);
  }
  return (s) => indice.get('id:' + s.id) || indice.get('n:' + cifre(s.id))
    || indice.get('s:' + norm(s.stazione)) || indice.get('s:' + norm(s.localita));
}

(async () => {
  const { host, text } = await getText('/monitoraggio/stazioni.php?type=idro');
  const ana = await anagrafica();
  const stazioni = parseTabella(text)
    .map((s) => {
      const c = ana({ ...s, localita: localitaDi(s.stazione) }) || {};
      return { id: s.id, fiume: s.fiume, stazione: s.stazione, prov: s.prov, localita: localitaDi(s.stazione), lat: c.lat, lon: c.lon };
    })
    .sort((a, b) => a.prov.localeCompare(b.prov) || a.localita.localeCompare(b.localita, 'it') || a.id.localeCompare(b.id));

  // Non sovrascrivere il file buono con una lettura fallita o parziale
  if (stazioni.length < 50) {
    console.error(`Solo ${stazioni.length} stazioni lette da ${host}: file non aggiornato.`);
    process.exit(1);
  }

  const out = { generato: new Date().toISOString(), fonte: host, stazioni };
  fs.writeFileSync(path.join(__dirname, '..', 'localita.json'), JSON.stringify(out, null, 1) + '\n');
  const conCoord = stazioni.filter((s) => s.lat !== undefined).length;
  console.log(`localita.json: ${stazioni.length} stazioni (${conCoord} con coordinate), ${new Set(stazioni.map((s) => s.prov + s.localita)).size} località`);
})().catch((e) => { console.error(e); process.exit(1); });
