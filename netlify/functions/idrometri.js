// Proxy CFR/SIR Toscana → JSON
// GET /.netlify/functions/idrometri?ids=TOS..,TOS.. → dati attuali + serie delle stazioni richieste (solo quelle con dati)
// GET /.netlify/functions/idrometri?raw=1           → righe grezze della tabella CFR (debug)
// GET /.netlify/functions/idrometri?raw=1&id=TOS…   → riga e soglie di una stazione (debug)
// GET /.netlify/functions/idrometri?rischio=viareggio        → canale, mare, pioggia e falda per il rischio allagamento
// GET /.netlify/functions/idrometri?rischio=viareggio&raw=1  → righe grezze usate per scegliere le stazioni (debug)
// GET /.netlify/functions/idrometri?falda=viareggio          → freatimetro più vicino, dati giornalieri 30 gg
// GET /.netlify/functions/idrometri?falda=viareggio&raw=1    → freatimetri vicini e righe CSV (debug)

const HOSTS = ['https://www.cfr.toscana.it', 'https://www.sir.toscana.it'];
const UA = 'Mozilla/5.0 (compatible; IdrometriToscana/1.0)';
const DATA_RE = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})[.:](\d{2})/;
const DATA_TAB_RE = /^\d{2}\/\d{2}(\/\d{4})?\s+\d{2}[.:]\d{2}$/;

async function getText(path) {
  let lastErr;
  for (const host of HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(host + path, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`${host}${path}: HTTP ${res.status}`);
      return { host, text: await res.text() };
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const clean = (s) =>
  String(s ?? '')
    .replace(/\\"/g, '"')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();

function num(s) {
  const m = String(s ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function parseArrays(html) {
  const out = [];
  const re = /new\s+Array\s*\(([\s\S]*?)\)\s*;/g;
  let m;
  while ((m = re.exec(html))) {
    const args = [...m[1].matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g)].map((a) => clean(a[1] ?? a[2]));
    if (args.length) out.push(args);
  }
  return out;
}

// "10/11/2026 03.10" (ora solare) → ISO con offset +01:00
function toISO(s) {
  const m = String(s).match(DATA_RE);
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+01:00` : null;
}

// "Viareggio 1 (GPRS)" → "Viareggio"
const localitaDi = (stazione) =>
  stazione.replace(/\([^)]*\)/g, ' ').replace(/\s+\d+\s*$/, '').replace(/\s+/g, ' ').trim();

function parseTabella(html) {
  return parseArrays(html)
    .filter((a) => /^TOS\d+$/i.test(a[0]) && a.length >= 6)
    .map((a) => {
      const [id, fiume, stazione, prov, zona] = a;
      // Le 7 colonne numeriche stanno subito prima della data:
      // liv.2, liv.1, livello, portata, Δh1, Δh3, Δh6, data (dopo la data ci sono altri campi)
      const dateIdx = a.findIndex((v, i) => i > 4 && DATA_TAB_RE.test(v));
      const vals = dateIdx >= 12 ? a.slice(dateIdx - 7, dateIdx) : [];
      const pos = vals.length === 7;
      return {
        id: id.toUpperCase(), fiume, stazione, prov: prov.toUpperCase(), zona,
        liv2: pos ? num(vals[0]) : null,
        liv1: pos ? num(vals[1]) : null,
        livello: pos ? num(vals[2]) : null,
        portata: pos ? num(vals[3]) : null,
        dh1: pos ? num(vals[4]) : null,
        dh3: pos ? num(vals[5]) : null,
        dh6: pos ? num(vals[6]) : null,
        _raw: a,
      };
    });
}

function parseSerie(html) {
  return parseArrays(html)
    .filter((a) => a.length >= 3 && DATA_RE.test(a[1]))
    .map((a) => ({ t: toISO(a[1]), l: num(a[2]), q: a.length > 3 ? num(a[3]) : null }))
    .filter((p) => p.t && p.l !== null)
    .sort((x, y) => x.t.localeCompare(y.t));
}

const json = (status, body, cache = 'no-store') => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

// ---------- Rischio allagamento ----------
const RISCHIO = {
  viareggio: {
    nome: 'Viareggio',
    area: /viareggio|torre del lago/i,
    vicini: /massarosa|camaiore|pietrasanta|vecchiano|lido di camaiore/i,
    canale: /burlamacca/i,
    mare: /mare|tirren|mareogr|porto/i,
    lat: 43.874, lon: 10.252,
  },
};

// ---------- Falda: freatimetro più vicino + dati giornalieri SIR ----------
const WFS_FREAT = 'https://geo.sir.toscana.it/geoserver/geo/ows?service=WFS&version=1.0.0&request=GetFeature'
  + '&typeName=geo%3Acf_freatimetri&maxFeatures=300000&outputFormat=application%2Fjson&srsName=EPSG%3A4326';

async function scaricaUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const distKm = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

let cacheFreat = null;
async function freatimetriVicini(punto, quanti = 5) {
  // Tutti i freatimetri (poche centinaia), in cache finché la function resta calda.
  // Niente bbox: in WFS 1.0.0 verrebbe interpretato nel sistema di coordinate nativo del layer.
  cacheFreat ||= JSON.parse(await scaricaUrl(WFS_FREAT)).features || [];
  const feats = cacheFreat;
  return feats.map((f) => {
    const p = f.properties || {};
    const kId = Object.keys(p).find((k) => /^(id_?stazione|cod(ice)?_?stazione|codice|cod|id)$/i.test(k));
    const id = Object.values(p).map((v) => String(v ?? '').trim().toUpperCase()).find((v) => /^TOS\d+$/.test(v))
      || (kId ? String(p[kId]).trim().toUpperCase() : null);
    let g = f.geometry?.coordinates;
    while (Array.isArray(g) && Array.isArray(g[0])) g = g[0];
    if (!id || !Array.isArray(g)) return null;
    const pos = { lon: +g[0], lat: +g[1] };
    const campo = (re) => { const k = Object.keys(p).find((x) => re.test(x)); return k ? String(p[k] ?? '').trim() : ''; };
    return { id, nome: campo(/^(nome|stazione|name|denominaz)/i) || id, comune: campo(/comune/i), ...pos, km: Math.round(distKm(punto, pos) * 10) / 10, proprieta: p };
  }).filter((x) => x && Number.isFinite(x.lat)).sort((a, b) => a.km - b.km).slice(0, quanti);
}

// Archivio SIR: http://www.sir.toscana.it/archivio/dati.php?IDST=<tipo>&D=json&IDS=<codice>
// (formato documentato per i pluviometri con IDST=pluvio; per i freatimetri il valore di IDST va provato)
const ARCHIVIO = (tipo, id) => `http://www.sir.toscana.it/archivio/dati.php?IDST=${tipo}&D=json&IDS=${id}`;
const TIPI_FREAT = ['freat', 'freatimetro', 'freatim', 'freatimetri'];

function dataISO(v) {
  const t = String(v ?? '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Estrae coppie (data, valore) da JSON di forma sconosciuta, o da testo "data;valore"
function estraiSerie(testo) {
  const out = [];
  let obj = null;
  try { obj = JSON.parse(testo); } catch (_) { /* non JSON */ }
  if (obj === null) {
    for (const l of String(testo).split(/\r?\n|<br\s*\/?>/i)) {
      const c = l.split(/[;,\t]/);
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
      const scalari = ks.filter((k) => k !== kd && typeof x[k] !== 'object' && num(x[k]) !== null);
      const kv = scalari.find((k) => /sogg|liv|val|media|dato|freat/i.test(k)) || scalari[0];
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

async function datiGiornalieri(id, raw) {
  const prove = await Promise.all(TIPI_FREAT.map(async (tipo) => {
    const url = ARCHIVIO(tipo, id);
    try {
      const testo = await scaricaUrl(url);
      return { tipo, url, testo, punti: estraiSerie(testo) };
    } catch (e) {
      return { tipo, url, errore: e.message, punti: [] };
    }
  }));
  const ok = prove.find((p) => p.punti.length);
  const serie = ok ? ok.punti
    .sort((x, y) => x.d.localeCompare(y.d))
    .filter((p, i, a) => i === 0 || p.d !== a[i - 1].d)
    .slice(-30)
    .map((p) => ({ t: `${p.d}T12:00:00+01:00`, v1: p.v })) : [];
  const esito = { colonna: 'soggiacenza (m da p.c.)', tipo: 'soggiacenza', fonte: ok?.url || null, serie };
  if (raw) esito.prove = prove.map((p) => ({ url: p.url, errore: p.errore || null, punti: p.punti.length, inizio: p.testo ? p.testo.slice(0, 300) : null }));
  return esito;
}

async function falda(cfg, raw) {
  const vicini = await freatimetriVicini(cfg);
  if (raw) {
    const primo = vicini[0] ? await datiGiornalieri(vicini[0].id, true).catch((e) => ({ errore: e.message })) : null;
    return {
      totaleWfs: cacheFreat?.length ?? 0,
      esempioWfs: cacheFreat?.[0] ? JSON.stringify(cacheFreat[0]).slice(0, 600) : null,
      vicini,
      datiPrimo: primo && { ...primo, serie: primo.serie?.slice(-5) },
    };
  }
  const prove = await Promise.all(vicini.slice(0, 2).map((v) => datiGiornalieri(v.id).catch(() => null)));
  const i = prove.findIndex((d) => d?.serie?.length);
  if (i < 0) return null;
  const v = vicini[i], d = prove[i];
  return { id: v.id, nome: `${v.nome}${v.comune ? ' – ' + v.comune : ''}`, km: v.km, giornaliero: true, colonna: d.colonna, tipo: d.tipo, serie: d.serie };
}

async function righeTabella(type) {
  const { text } = await getText(`/monitoraggio/stazioni.php?type=${type}`);
  const righe = parseArrays(text)
    .filter((a) => /^TOS\d+$/i.test(a[0]))
    .map((a) => ({ id: a[0].toUpperCase(), a, testo: a.slice(1, 5).join(' ') }));
  return { text, righe };
}

async function serieGrezza(id, type) {
  const { text } = await getText(`/monitoraggio/dettaglio.php?id=${id}&type=${type}&${Date.now()}`);
  return parseArrays(text)
    .filter((a) => a.length >= 3 && DATA_RE.test(a[1]))
    .map((a) => ({ t: toISO(a[1]), v1: num(a[2]), v2: a.length > 3 ? num(a[3]) : null }))
    .filter((p) => p.t)
    .sort((x, y) => x.t.localeCompare(y.t));
}

async function rischio(luogo, raw) {
  const cfg = RISCHIO[String(luogo).toLowerCase()];
  if (!cfg) throw new Error(`luogo non gestito: ${luogo}`);
  const tipi = ['idro', 'pluvio'];
  const tab = await Promise.all(tipi.map((t) => righeTabella(t).catch((e) => ({ errore: e.message, righe: [] }))));
  const [idro, pluvio] = tab;
  const qui = (r) => cfg.area.test(r.testo);
  const vicino = (r) => cfg.vicini.test(r.testo);

  const canale = idro.righe.find((r) => cfg.canale.test(r.testo) && qui(r));
  const mare = idro.righe.find((r) => cfg.mare.test(r.testo) && qui(r) && !cfg.canale.test(r.testo));
  const pioggia = pluvio.righe.find(qui) || pluvio.righe.find(vicino);

  if (raw) {
    return {
      errori: Object.fromEntries(tipi.map((t, i) => [t, tab[i].errore || null])),
      idro: idro.righe.filter((r) => qui(r) || vicino(r)).map((r) => r.a),
      pluvio: pluvio.righe.filter((r) => qui(r) || vicino(r)).map((r) => r.a),
      scelte: { canale: canale?.id, mare: mare?.id, pioggia: pioggia?.id },
    };
  }

  const soglie = canale ? parseTabella(idro.text).find((s) => s.id === canale.id) : null;
  const carica = async (r, type, extra = {}) => {
    if (!r) return null;
    let serie = [];
    try { serie = await serieGrezza(r.id, type); } catch (_) { /* nessuna serie */ }
    if (!serie.length) return null;
    return { id: r.id, nome: r.a.slice(1, 3).filter(Boolean).join(' – '), type, serie, ...extra };
  };

  const [c, m, p] = await Promise.all([
    carica(canale, 'idro', { liv1: soglie?.liv1 ?? null, liv2: soglie?.liv2 ?? null }),
    carica(mare, 'idro'),
    carica(pioggia, 'pluvio'),
  ]);
  return { luogo: cfg.nome, aggiornato: new Date().toISOString(), canale: c, mare: m, pioggia: p };
}

// Riutilizzati da scripts/genera-localita.js
exports.getText = getText;
exports.parseTabella = parseTabella;
exports.localitaDi = localitaDi;

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    if (q.falda) {
      const cfg = RISCHIO[String(q.falda).toLowerCase()];
      if (!cfg) return json(400, { errore: `luogo non gestito: ${q.falda}` });
      try {
        return json(200, { falda: await falda(cfg, q.raw) });
      } catch (e) {
        return json(200, { falda: null, errore: e.message });
      }
    }
    if (q.rischio) return json(200, await rischio(q.rischio, q.raw));

    const { host, text } = await getText('/monitoraggio/stazioni.php?type=idro');
    const tabella = parseTabella(text);

    if (q.raw && q.id) {
      // Debug di una stazione: riga grezza della tabella e tracce di soglie nella pagina di dettaglio
      const id = q.id.trim().toUpperCase();
      const riga = tabella.find((s) => s.id === id);
      const det = await getText(`/monitoraggio/dettaglio.php?id=${id}&type=idro`).catch((e) => ({ text: `ERRORE ${e.message}` }));
      const soglie = [...det.text.matchAll(/[^<>\n]{0,120}(soglia|liv\.?\s*[12]|guardia)[^<>\n]{0,120}/gi)].map((m) => clean(m[0])).slice(0, 15);
      return json(200, {
        host,
        rigaTabella: riga ? riga._raw : null,
        campiLetti: riga ? { liv1: riga.liv1, liv2: riga.liv2, livello: riga.livello, dh1: riga.dh1 } : null,
        tracceSoglieDettaglio: soglie,
        ultimiArrayDettaglio: parseArrays(det.text).slice(-3),
      });
    }
    if (q.raw) return json(200, { host, righe: tabella.slice(0, 20).map((s) => s._raw) });

    if (!q.ids) return json(400, { errore: 'Parametro ids mancante' });

    // Dati delle stazioni richieste
    const ids = [...new Set(q.ids.split(',').map((x) => x.trim().toUpperCase()))].filter((x) => /^TOS\d+$/.test(x)).slice(0, 20);
    const righe = ids.map((id) => tabella.find((s) => s.id === id)).filter(Boolean);

    const stazioni = (await Promise.all(
      righe.map(async (s) => {
        let serie = [];
        try {
          const det = await getText(`/monitoraggio/dettaglio.php?id=${s.id}&type=idro&${Date.now()}`);
          serie = parseSerie(det.text);
        } catch (_) { /* serie non disponibile */ }
        const ultimo = serie.at(-1);
        const { _raw, ...rest } = s;
        return {
          ...rest,
          localita: localitaDi(s.stazione),
          livello: ultimo ? ultimo.l : s.livello,
          portata: ultimo && ultimo.q !== null ? ultimo.q : s.portata,
          data: ultimo ? ultimo.t : null,
          serie,
        };
      })
    )).filter((s) => s.livello !== null);

    return json(200, { aggiornato: new Date().toISOString(), fonte: host, stazioni });
  } catch (e) {
    return json(502, { errore: `Impossibile leggere i dati CFR: ${e.message}` });
  }
};
