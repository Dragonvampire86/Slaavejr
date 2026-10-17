# Slåvejr

Hvornår er græsset tørt nok til at slå? Siden henter timeprognosen for dit sted og beregner time for time, hvor meget vand der sidder på græsstråene fra regn og dug, hvornår det fordamper, og om der er frost eller blød jord.

Åbn siden: https://dragonvampire86.github.io/Slaavejr/

## Sådan virker den

- Vejrdata fra [Open-Meteo](https://open-meteo.com/) (CC BY 4.0), de seneste to døgn og fire døgn frem.
- Dug og fordampning beregnes med Penman–Monteith-ligningen for en våd overflade (FAO-56).
- En time regnes som tør, når der er under 0,02 mm vand på stråene, ingen regn, ingen frost og dagslys.

## Privatliv og sikkerhed

- Ingen konto, ingen cookies, ingen sporing og ingen nøgler i koden.
- Dit valgte sted gemmes kun i din egen browser.
- Positionen afrundes til ca. 1 km, før den sendes til Open-Meteo.
- Skrifttyperne ligger i repositoriet, så siden kontakter ikke Google.
- En Content Security Policy tillader kun sidens egne filer og Open-Meteos to adresser.

Skrifttyperne Familjen Grotesk og IBM Plex Mono er under SIL Open Font License 1.1 (se mappen `fonts`).
