// Proxy CFR/SIR Toscana → JSON per le stazioni di Viareggio, Massarosa, Vecchiano, Carrara.
// GET /.netlify/functions/idrometri         → dati normalizzati + serie storiche
// GET /.netlify/functions/idrometri?raw=1   → array grezzi letti dalle pagine (debug)

const HOSTS = ['https://www.cfr.toscana.it', 'https://www.sir.toscana.it'];
const UA = 'Mozilla/5.0 (compatible; IdrometriVersilia/1.0)';
const LUOGHI = /carrara|avenza|carrione|viareggio|torre del lago|massarosa|massaciuccoli|quiesa|stiava|bozzano|vecchiano|migliarino|nodica|filettole|ripafratta|burlamacca/i;
const DATA_RE = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})[.:](\d{2})/;

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

// Estrae tutti i "new Array(...)" con argomenti stringa
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

function comuniDi(fiume, stazione) {
  const t = `${fiume} ${stazione}`;
  if (/carrara|avenza|carrione/i.test(t)) return ['Carrara'];
  if (/massaciuccoli/i.test(t)) return ['Viareggio', 'Massarosa', 'Vecchiano'];
  if (/serchio|vecchiano|migliarino|nodica|filettole|ripafratta/i.test(t)) return ['Vecchiano'];
  if (/massarosa|quiesa|stiava|bozzano/i.test(t)) return ['Massarosa'];
  return ['Viareggio'];
}

function parseTabella(html) {
  return parseArrays(html)
    .filter((a) => /^TOS\d+$/i.test(a[0]) && a.length >= 6)
    .map((a) => {
      const [id, fiume, stazione, prov, zona] = a;
      const dateIdx = a.findLastIndex((v, i) => i > 4 && DATA_RE.test(v) || (i > 4 && /^\d{2}\/\d{2}\s+\d{2}[.:]\d{2}$/.test(v)));
      const vals = a.slice(5, dateIdx > 0 ? dateIdx : undefined);
      // Ordine colonne tabella CFR: liv.2, liv.1, livello, portata, Δh1, Δh3, Δh6
      const pos = vals.length === 7;
      return {
        id: id.toUpperCase(),
        fiume,
        stazione,
        prov: prov.toUpperCase(),
        zona,
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

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    const { host, text } = await getText('/monitoraggio/stazioni.php?type=idro');
    const locali = parseTabella(text).filter((s) => {
      if (!['LU', 'PI', 'MS'].includes(s.prov)) return false;
      const t = `${s.fiume} ${s.stazione}`;
      return LUOGHI.test(t) || (/serchio/i.test(s.fiume) && /foce/i.test(s.stazione));
    });

    if (event.queryStringParameters?.raw) {
      const primo = locali[0];
      const det = primo ? await getText(`/monitoraggio/dettaglio.php?id=${primo.id}&type=idro`) : null;
      return json(200, {
        host,
        righeTabella: locali.map((s) => s._raw),
        dettaglioEsempio: det ? parseArrays(det.text).slice(-5) : [],
      });
    }

    const stazioni = await Promise.all(
      locali.map(async (s) => {
        let serie = [];
        try {
          const det = await getText(`/monitoraggio/dettaglio.php?id=${s.id}&type=idro&${Date.now()}`);
          serie = parseSerie(det.text);
        } catch (_) { /* serie non disponibile: resta il dato di tabella */ }
        const ultimo = serie.at(-1);
        const { _raw, ...rest } = s;
        return {
          ...rest,
          livello: ultimo ? ultimo.l : s.livello,
          portata: ultimo && ultimo.q !== null ? ultimo.q : s.portata,
          data: ultimo ? ultimo.t : null,
          comuni: comuniDi(s.fiume, s.stazione),
          serie,
        };
      })
    );

    return json(200, { aggiornato: new Date().toISOString(), fonte: host, stazioni });
  } catch (e) {
    return json(502, { errore: `Impossibile leggere i dati CFR: ${e.message}` });
  }
};
