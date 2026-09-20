KZM LIVE FIX + PROBUDI SE

Ovo je kumulativni patch preko postojeceg C:\Users\dinoj\kzm-novi.

Dodano:
- browser live-pulse fallback svakih 20 s dok je utakmica u vremenu igranja
- server ogranicava Football API na najvise jedan live poziv u 20 s
- stale FINISHED status vise ne blokira oporavak live rezultata
- ESPN utrka se pokrece u istom live ciklusu
- zadnji igrac u tekucem krugu dobiva pri svakom ulasku poruku:
  PROBUDI SE, RAZMISLI DOBRO!!!!
- kod izjednacenja na zadnjem mjestu poruku dobivaju svi izjednaceni
- dok jos nema obracunatih bodova u krugu, poruka se ne prikazuje

POSTAVLJANJE:
1. Raspakiraj sadrzaj preko C:\Users\dinoj\kzm-novi i odaberi Replace.
2. CMD:
   cd /d C:\Users\dinoj\kzm-novi
   npm run check
   npm test
   npm run deploy

NE pokretati setup i NE pokretati import.
