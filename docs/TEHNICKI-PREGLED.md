# Tehnicki pregled i granice isporuke

## Arhitektura
Worker Static Assets posluzuje public/. /api/* izvrsava Worker. D1 DB binding je jedina aplikacijska pohrana. Nema Google script, GAS RPC ili starog kzm-push-bridge poziva u runtimeu. Jedan origin i HttpOnly session cookie; nema CORS javnog API-ja.

SQL shema: players, sessions, rate_limits, teams, rounds, fixtures, picks, payments, audit, meta, import_history i pick_scores pogled. 38 kola / cetiri kruga 1-10, 11-19, 20-28, 29-38. Pravila preuzeta iz dostavljenih core/WebApp izvora: domaca pobjeda osnovni bodovi; gostujuca osnovni+1; gostujuci remi 1; ostalo 0; DOUBLE x2. Bodovi prije roka nisu ukljuceni u javnu tablicu.

UNIQUE(player,round), UNIQUE(player,cycle,team) i parcijalni UNIQUE za DOUBLE provode ogranicenja u samoj bazi. Trigger provjerava rok prema vremenu baze, aktivnost i zastavicu omogucenih odabira. Batch upis i audit zajedno se potvrde ili poniste.

## Sigurnost
Lozinke: HMAC-SHA256 sa zasebnim Worker pepperom, potom PBKDF2-SHA256 100000 iteracija, nasumicni salt. Nije tvrdnja da je implementacija prosla neovisni sigurnosni audit. Produkcijske lozinke generiraju se tek pri setupu/uvozu; testne su jasno izdvojene u tests/.
Sesija: nasumican token, njegov hash u bazi, HttpOnly, SameSite=Strict, Secure na HTTPS-u, istek 72h. Provjera aktivnog racuna i uloge na serveru. Reset lozinke/deaktivacija opozivaju sesije. Admin nije samo oznaka u pregledniku. CSRF provjera Origin + custom header; isti origin za browser. Login limit 10 po normaliziranom imenu i 30 po IP-u u 15min. Limiti nisu potpuna DDoS zastita; po potrebi dodati Cloudflare WAF/Turnstile nakon stvarnog testiranja.
Pripremljeni SQL upiti i parametri, HTML escaping, CSP, JSON velicina ogranicena. API odgovori no-store; private nije staticki asset. Audit ne sadrzi lozinke niti tudje skrivene izbore. Ukljucivanje detaljnih produkcijskih logova zahtijeva procjenu privatnosti.
Setup BOOTSTRAP_KEY je jednokratan po initialized flagu; nakon postavljanja isti endpoint ne moze postati javna registracija. Owner zastita od deaktivacije. Ne postoje javni password recovery ili role-promotion endpointi.

## Podaci i uvoz
Izvoz baziran na strukturi poslanih skripti: Postavke B ime / G PIN (NAMJERNO IZOSTAVLJEN), N Q R S placanja, T aktivnost, D E F klubovi/bodovi/boje. Rokovi K L. Kolo n schedule I4:K13; odabiri citaju A:G i prepoznaju igraca po imenu, uz dodatni red za povijesni offset. Broj slotova webBrojIgraca_ ili25; nema automatskog otkrivanja igraca izvan tog izvornog raspona.
Uvoz mora imati20klubova i38kola. Neispravni ili konfliktni zapisi prekidaju uvoz, ne odbacuju se tiho. Manjkava kola i rokovi dobiju upozorenja. Ukupni povijesni bodovi usporedjuju se s listom Rezultati kada je prisutan. Razlike su upozorenja, ne automatska korekcija. Uvoz samo u praznu bazu s ownerom; atomicni D1 batch. JSON-each upisi smanjuju broj bound parametara i ne stvaraju upit s tisucama parametara.
Import SHA-256 fingerprint omogucava potvrdu izgubljenog odgovora bez ponavljanja. Prepared payload ne sadrzi izvorne PIN-ove, vec hash/salt novih lozinki. Lokalni private kodovi moraju se zastititi.
Postojeci nenulti povijesni points prenose se kao frozen imported_points; njih ne mijenja API. Novi picks koriste score view. Admin moze izricito odabrati recalc pojedinog kola; potrebna kopija prije radnje. Ne provodi se automatsko slaganje starih nelogicnosti.

## Nogometni API
football-data.org PL season2026; kljuc u Worker secretu FOOTBALL_DATA_API_KEY. Cron15min i manualsync s razmakom barem2min. Obrada429 uvodi1h backoff, lease stiti od paralelnog synca. Explicit API-ID/poznati aliasi, ne fuzzy pogadjanje. Rucni rezultati, rucni rokovi i vec zatvorena kola zasticeni su od automatskog prepisivanja/otvaranja. Provjeriti API entitlement/kvalitetu stvarnih podataka. Premier League tablica iz spremljenih FINISHED/AWARDED rezultata; bez disciplinskih bodova/sluzbenih dodatnih kriterija.

## Sto nije ukljuceno
Neovisni sigurnosni audit, Cloudflare load test, stvarni benchmark, slanje e-maila, push reminders, stare Google automatizacije, offline upisi, placanje karticom/bankom, vlastita domena bez korisnikova odabira, potpuna multi-season/multi-league administracija, automatsko uskladjivanje povratka nakon cutovera. Mobile manifest nije potpuni offline/PWA push sustav. UI je nov, iste osnovne ljubicaste/zelene teme, nije identicna kopija svih originalnih detalja i slika.

## Oporavak i rad
Backup naredba cilja samo generirani novi projekt. Potrebna je privatna kopija D1 SQL-a + AUTH_PEPPER i konfiguracije; SQL sam ne omogucuje provjeru starih lozinki bez istog peppera. Automatski restore nije isporucen da se izbjegne slucajno prepisivanje. Za ozbiljan povratak treba plan vlasnika baze i backup.
--new arhivira lokalne postavke/tajne trenutne probe, stvara novi setresursa; stare cloudresurse NE gasi. Racunaj na njihovu eventualnu potrosnju; gasenje samo uz provjeru tocnih imena. CMDskripte stite od objave u staru mapu kroz marker/naziv/projektID/DBID. Sigurnosne provjere su pomoc, ne zamjena za citanje odredista pri potvrdi.

## Ovisnosti i okruzenje
Node>=22.16; Wrangler4 iz package.json instalira se kod korisnika. Nema package-lock iz ove isporuke jer npmregistry nije bio dostupan u okruzenju izrade. Nakon uspjesnog npm install sacuvati nastali package-lock za ponovljive objave. Node/SQLiteadapter za testove nije pravi D1 runtime; testni SQLdrivernema sve D1granice. Pri prvoj cloudobjavi provjeriti migracije, runtime, HTTPS/cookie/CSP, quota/CPU i izvoz/uvoz.

## Primarni izvori dokumentacije (provjereno 2026-09-12)
- https://developers.cloudflare.com/workers/static-assets/binding/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/d1/wrangler-commands/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/best-practices/import-export-data/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://docs.football-data.org/general/v4/competition.html

Poslovna pravila i izvorni raspored stupaca izvedeni su iz korisnikovih poslanih core i WebApp skripti, ne iz sluzbenih nogometnih pravila.
