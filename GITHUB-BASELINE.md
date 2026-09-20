# KZM baseline prije live API popravka

Ovaj repozitorij je napravljen iz korisnikove datoteke `.wrangler.zip` i predstavlja zadnju lokalnu verziju koju je korisnik imao prije pokušaja `1.1.0-livefix` deploya.

## Važno

- Runtime datoteke nisu mijenjane pri izradi ovog GitHub baselinea.
- `wrangler.json` je zadržan kako bi privatni repo sadržavao stvarnu produkcijsku Cloudflare konfiguraciju projekta.
- API ključevi i drugi secret-i nisu u repozitoriju. Oni ostaju kao Cloudflare Worker secrets.
- `private/`, `.wrangler/`, `node_modules/`, D1 backupi i lokalni logovi nisu verzionirani.
- Poznati problem ove verzije: live nogometni refresh nije bio dovoljno pouzdan/brz. To se popravlja u kasnijem commitu ili branchu, dok ovaj baseline ostaje rollback točka.

## Provjera baselinea

Prije pakiranja pokrenuto je:

```text
npm run check
npm test
```

Rezultat: 62/62 testova prolazi.

## Git tag

`baseline-working-2026-09-20`
