// GET /.netlify/functions/falda?lat=43.87&lon=10.25          → dati del freatimetro più vicino (dalla cache)
// GET /.netlify/functions/falda?lat=…&lon=…&raw=1            → anche diagnostica
// GET /.netlify/functions/falda?lat=…&lon=…&forza=1          → riavvia subito la lettura in background
// Il dato viene letto da falda-background e conservato 6 ore; senza dati validi si riprova dopo 10 minuti.
import { getStore } from '@netlify/blobs';
import { elencoFreatimetri, km } from '../lib/lib-falda.mjs';

const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const u = new URL(req.url);
  const punto = { lat: parseFloat(u.searchParams.get('lat')), lon: parseFloat(u.searchParams.get('lon')) };
  if (!Number.isFinite(punto.lat) || !Number.isFinite(punto.lon)) return json({ falda: null, errore: 'lat e lon obbligatori' });
  const store = getStore('falda');

  // elenco freatimetri in cache per 7 giorni
  let elenco = await store.get('elenco', { type: 'json' });
  if (!elenco || Date.now() - Date.parse(elenco.aggiornato) > 7 * 86400e3) {
    try {
      elenco = { stazioni: await elencoFreatimetri(), aggiornato: new Date().toISOString() };
      await store.setJSON('elenco', elenco);
    } catch (e) {
      if (!elenco) return json({ falda: null, errore: `elenco freatimetri non disponibile: ${e.message}` });
    }
  }
  const st = elenco.stazioni.map((s) => ({ ...s, km: km(punto, s) })).sort((a, b) => a.km - b.km)[0];
  if (!st) return json({ falda: null, errore: 'nessun freatimetro' });

  const salvato = await store.get(st.id, { type: 'json' });
  const avvio = await store.get(`${st.id}-avvio`, { type: 'json' });
  const eta = salvato ? Date.now() - Date.parse(salvato.aggiornato) : Infinity;
  const validita = salvato?.dati ? 6 * 3600e3 : 10 * 60e3;
  const giaAvviato = avvio && Date.now() - Date.parse(avvio.quando) < 10 * 60e3;
  if (u.searchParams.get('forza') || (eta > validita && !giaAvviato)) {
    await store.setJSON(`${st.id}-avvio`, { quando: new Date().toISOString() });
    await fetch(`${u.origin}/.netlify/functions/falda-background?id=${st.id}`).catch(() => null);
  }

  const falda = salvato?.dati ? { ...salvato.dati, km: st.km, quota: st.quota } : null;
  const body = { falda, stazione: { id: st.id, nome: st.nome, comune: st.comune, quota: st.quota, km: st.km }, stato: falda ? 'pronto' : 'in preparazione', aggiornato: salvato?.aggiornato || null };
  if (u.searchParams.get('raw')) Object.assign(body, { prova: salvato?.prova || null, errore: salvato?.errore || null, avvio });
  return json(body);
};
