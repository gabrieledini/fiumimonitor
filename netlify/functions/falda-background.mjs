// Background function (fino a 15 minuti): legge il CSV di un freatimetro e lo salva su Blobs.
// Avviata da functions/falda.mjs con ?id=TOS… quando il dato in cache è vecchio o assente.
import { getStore } from '@netlify/blobs';
import { datiFreatimetro } from '../lib/lib-falda.mjs';

export default async (req) => {
  const id = (new URL(req.url).searchParams.get('id') || '').toUpperCase();
  if (!/^TOS\d+$/.test(id)) return;
  const store = getStore('falda');
  const elenco = (await store.get('elenco', { type: 'json' }))?.stazioni || [];
  const st = elenco.find((x) => x.id === id) || { id, nome: id, comune: '', quota: null };
  try {
    const { dati, prova } = await datiFreatimetro(st);
    await store.setJSON(id, { dati, prova, aggiornato: new Date().toISOString() });
    console.log(`falda ${id}: ${dati ? dati.serie.length + ' giorni' : 'nessun dato'} (${prova.ms} ms)`);
  } catch (e) {
    await store.setJSON(id, { dati: null, errore: e.message, aggiornato: new Date().toISOString() });
    console.error(`falda ${id}: ${e.message}`);
  }
};
