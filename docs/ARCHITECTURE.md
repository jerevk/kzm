# KZM modularni framework

Cilj je zadržati postojeći Cloudflare Worker + D1 sustav i postupno razdvojiti velike datoteke bez rewritea aplikacije.

## Pravila arhitekture

- `src/worker.js` je HTTP/cron ulaz i orkestracija, ne mjesto za integracijsku logiku.
- `src/services/` sadrži vanjske integracije i domenske servise.
- `src/db.js` je zajednički pristup D1 helperima.
- `public/js/` sadrži frontend module; `public/app.js` ostaje orkestrator UI-ja dok se ostatak postupno izdvaja.
- Svaki novi modul mora biti uključen u `npm run check`.
- Svaka ispravka regresije dobiva test prije produkcijskog deploya.

## Trenutno izdvojeno

- `src/services/onesignal.js`: slanje push poruka i OneSignal dijagnostika.
- `src/db.js`: D1 `stmt/all/first` helperi.
- `public/js/push.js`: OneSignal inicijalizacija, login/logout i uključivanje/isključivanje push pretplate.

## Sljedeći sigurni koraci

1. izdvojiti admin API rute iz `worker.js`;
2. izdvojiti frontend admin ekran iz `app.js`;
3. izdvojiti round/results UI;
4. tek nakon stabilizacije postupno uvoditi TypeScript po modulima.

Ne radimo veliki rewrite odjednom. Produkcija se mijenja tek kada CI prođe.
