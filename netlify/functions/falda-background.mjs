// Background function (fino a 15 minuti): legge l'archivio SIR e salva il risultato su Blobs.
// Viene avviata da functions/falda.mjs quando il dato in cache è vecchio o assente.
import { getStore } from '@netlify/blobs';
import { calcolaFalda, LUOGHI } from '../lib/lib-falda.mjs';

export default async (req) => {
  const luogo = new URL(req.url).searchParams.get('luogo') || 'viareggio';
  if (!LUOGHI[luogo]) return;
  const store = getStore('falda');
  try {
    const r = await calcolaFalda(luogo);
    await store.setJSON(luogo, { ...r, aggiornato: new Date().toISOString() });
    console.log(`falda ${luogo}: ${r.dati ? r.dati.serie.length + ' giorni da ' + r.dati.id : 'nessun dato'}`);
  } catch (e) {
    await store.setJSON(luogo, { dati: null, errore: e.message, aggiornato: new Date().toISOString() });
    console.error(`falda ${luogo}: ${e.message}`);
  }
};
