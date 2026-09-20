# KZM NOVI 1.0

Samostalna probna web-aplikacija za jednu KZM ligu u sezoni 2026/27.

**Pocni s PRVO-PROCITAJ.html.** Citljive upute su i u UPUTE-ZA-SUTRA.txt.

- Nova mapa, novi Worker, nova D1 baza, novi URL; nema upisa u original.
- Prijava i role, odabiri s ogranicenjima u bazi, uplate, statistika, administracija.
- Citajuci jednokratni izvoz iz KOPIJE Sheeta; nema runtime Apps Script zavisnosti.
- Povijesni bodovi ostaju sacuvani; novo racunanje zahtijeva eksplicitnu radnju.
- Nove jake lozinke; stari PIN-ovi se ne uvoze.
- Posluziteljski rokovi; kolo bez roka zatvoreno za upise.

## Komande

```cmd
cd /d C:\Users\dinoj\kzm-novi
npm install
npm run setup
```

`npm test` = 36 lokalnih Node/SQLite testova. Node >=22.16.
`npm run demo` = lokalni demo na 127.0.0.1:8788, izmisljeni podaci, nestaju nakon prekida.
`npm run import -- "PUTANJA_DO_IZVOZA.json"` = prvo provjera, zatim potvrda UVEZI.
`npm run backup` = privatna SQL kopija samo nove baze.
`npm run deploy` = naknadna objava samo provjerenog novog projekta.
`npm run football-key` = spremanje vlastitog nogometnog API kljuca u Worker secret.

## Datoteke

- public/: nova stranica, ne ukljucuje originalne tajne ili pristupne kodove.
- src/: Worker logika, autentikacija, pravila, uvoz i API sinkronizacija.
- migrations/: SQL shema, indeksi, ogranicenja, triggeri i pogled bodovanja.
- scripts/: priprema, postavljanje, uvoz, backup i lokalni demo.
- migration/: read-only Apps Script izvoz za KOPIJU izvora.
- tests/: provjere i lokalni SQLite adapter; nisu produkcijski seed.
- private/: samo lokalni privatni podaci nastali pri postavljanju.
- docs/: tehnicke napomene, testni izvjestaj i demonstracijske slike.

Nije objavljeno na Cloudflareu, nije mjereno produkcijsko ubrzanje, nema migracije stvarnih podataka bez korisnikove instalacije i izvoza. Detalji ogranicenja u docs/TEHNICKI-PREGLED.md.
