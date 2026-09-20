# Security

Ne commitati ni objavljivati:

- `private/secrets.json`
- `private/setup.json`
- `private/PRISTUP*.txt`
- `private/backups/*`
- `.dev.vars*` / `.env*`
- Cloudflare API tokene
- `FOOTBALL_DATA_API_KEY`
- `ONESIGNAL_API_KEY`
- `AUTH_PEPPER`
- `BOOTSTRAP_KEY`
- PIN-ove ili administratorske lozinke

Production `wrangler.json` ne sadrži autentikacijske tajne; secret vrijednosti se čuvaju u Cloudflare Workers Secrets.
