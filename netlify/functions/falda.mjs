// Falda: freatimetro più vicino (WFS SIR) e soggiacenza giornaliera dall'archivio SIR.
// L'archivio è lento, per questo viene letto da una background function e salvato su Netlify Blobs.

export const LUOGHI = { viareggio: { nome: 'Viareggio', lat: 43.874, lon: 10.252 } };

const WFS_FREAT = 'https://geo.sir.toscana.it/geoserver/geo/ows?service=WFS&version=1.0.0&request=GetFeature'
  + '&typeName=geo%3Acf_freatimetri&maxFeatures=300000&outputFormat=application%2Fjson&srsName=EPSG%3A4326';
const ARCHIVIO = (tipo, id) => `http://www.sir.toscana.it/archivio/dati.php?IDST=${tipo}&D=json&IDS=${id}`;
const TIPI = ['freatimetro', 'freatimetri', 'freat', 'freatim'];

async function scarica(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 IdrometriToscana' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const num = (s) => { const m = String(s ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

export async function freatimetriVicini(punto, quanti = 3) {
  const feats = JSON.parse(await scarica(WFS_FREAT, 15000)).features || [];
  return feats.map((f) => {
    const p = f.properties || {};
    let g = f.geometry?.coordinates;
    while (Array.isArray(g) && Array.isArray(g[0])) g = g[0];
    if (!p.id_stazione || !Array.isArray(g)) return null;
    const pos = { lon: +g[0], lat: +g[1] };
    return { id: String(p.id_stazione).toUpperCase(), nome: p.nome || p.id_stazione, comune: p.comune || '', ...pos, km: Math.round(km(punto, pos) * 10) / 10 };
  }).filter(Boolean).sort((a, b) => a.km - b.km).slice(0, quanti);
}

function dataISO(v) {
  const t = String(v ?? '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Coppie (data, valore) da JSON di forma sconosciuta o da testo "data;valore"
export function estraiSerie(testo) {
  const out = [];
  let obj = null;
  try { obj = JSON.parse(testo); } catch (_) { /* testo */ }
  if (obj === null) {
    for (const l of String(testo).split(/\r?\n|<br\s*\/?>/i)) {
      const c = l.split(/[;\t]/);
      const d = dataISO(c[0]);
      if (d && c.length > 1) { const v = num(c[1]); if (v !== null) out.push({ d, v }); }
    }
    return out;
  }
  const visita = (x) => {
    if (Array.isArray(x)) {
      if (x.length >= 2 && dataISO(x[0]) && typeof x[1] !== 'object' && num(x[1]) !== null) { out.push({ d: dataISO(x[0]), v: num(x[1]) }); return; }
      x.forEach(visita);
    } else if (x && typeof x === 'object') {
      const ks = Object.keys(x);
      const kd = ks.find((k) => typeof x[k] !== 'object' && dataISO(x[k]));
      const sc = ks.filter((k) => k !== kd && typeof x[k] !== 'object' && num(x[k]) !== null);
      const kv = sc.find((k) => /sogg|liv|val|media|dato|freat/i.test(k)) || sc[0];
      if (kd && kv) { out.push({ d: dataISO(x[kd]), v: num(x[kv]) }); return; }
      for (const k of ks) {
        if (dataISO(k) && typeof x[k] !== 'object' && num(x[k]) !== null) out.push({ d: dataISO(k), v: num(x[k]) });
        else visita(x[k]);
      }
    }
  };
  visita(obj);
  return out;
}

// Lettura completa, senza fretta: pensata per la background function
export async function calcolaFalda(luogo) {
  const punto = LUOGHI[luogo];
  const vicini = await freatimetriVicini(punto);
  const prove = [];
  for (const v of vicini) {
    for (const tipo of TIPI) {
      const url = ARCHIVIO(tipo, v.id);
      const inizio = Date.now();
      try {
        const testo = await scarica(url, 120000);
        const punti = estraiSerie(testo);
        prove.push({ url, ms: Date.now() - inizio, caratteri: testo.length, punti: punti.length, inizio: testo.slice(0, 300) });
        if (punti.length) {
          const serie = punti.sort((a, b) => a.d.localeCompare(b.d))
            .filter((p, i, a) => i === 0 || p.d !== a[i - 1].d)
            .slice(-30)
            .map((p) => ({ t: `${p.d}T12:00:00+01:00`, v1: p.v }));
          return {
            dati: { id: v.id, nome: `${v.nome}${v.comune ? ' – ' + v.comune : ''}`, km: v.km, giornaliero: true, tipo: 'soggiacenza', colonna: 'soggiacenza (m da p.c.)', serie },
            prove, vicini,
          };
        }
      } catch (e) {
        prove.push({ url, ms: Date.now() - inizio, errore: e.message });
      }
    }
  }
  return { dati: null, prove, vicini };
}
