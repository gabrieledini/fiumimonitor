// GET /.netlify/functions/falda?luogo=viareggio        → ultimo dato di falda salvato
// GET /.netlify/functions/falda?luogo=viareggio&raw=1  → anche le prove fatte sull'archivio (debug)
// Se il dato manca o ha più di 6 ore avvia l'aggiornamento in background e risponde subito.
import { getStore } from '@netlify/blobs';
import { LUOGHI } from '../lib/lib-falda.mjs';

const VALIDITA = 6 * 3600e3;
const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const u = new URL(req.url);
  const luogo = u.searchParams.get('luogo') || 'viareggio';
  if (!LUOGHI[luogo]) return json({ falda: null, errore: `luogo non gestito: ${luogo}` });
  const store = getStore('falda');
  const salvato = await store.get(luogo, { type: 'json' });
  const avvio = await store.get(`${luogo}-avvio`, { type: 'json' });
  const eta = salvato ? Date.now() - Date.parse(salvato.aggiornato) : Infinity;
  const giaAvviato = avvio && Date.now() - Date.parse(avvio.quando) < 10 * 60e3;

  let stato = salvato?.dati ? 'pronto' : 'in preparazione';
  if (eta > VALIDITA && !giaAvviato) {
    await store.setJSON(`${luogo}-avvio`, { quando: new Date().toISOString() });
    await fetch(`${u.origin}/.netlify/functions/falda-background?luogo=${luogo}`).catch(() => null); // risponde 202 subito
    if (!salvato?.dati) stato = 'in preparazione';
  }
  const body = { falda: salvato?.dati || null, stato, aggiornato: salvato?.aggiornato || null };
  if (u.searchParams.get('raw')) Object.assign(body, { prove: salvato?.prove || null, vicini: salvato?.vicini || null, errore: salvato?.errore || null, avvio });
  return json(body);
};
