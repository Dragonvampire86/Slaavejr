# Slåvejr

Hvornår er græsset tørt nok til at slå, hvor ofte skal det slås, og skal det vandes? Siden henter vejrudsigten for dit sted og regner time for time på vandet på græsstråene, vandet i jorden og hvor meget græsset vokser.

Åbn siden: https://dragonvampire86.github.io/Slaavejr/

## Sådan virker den

- Vejrdata fra DMI's HARMONIE-model (2 km, de første 2½ døgn) og ECMWF via [Open-Meteo](https://open-meteo.com/) (CC BY 4.0): de seneste 30 døgn og 7 døgn frem. Uden for DMI's område bruges Open-Meteos standardmodeller.
- Dug og fordampning beregnes med Penman–Monteith-ligningen for en våd overflade (FAO-56).
- En time regnes som tør, når der er under 0,02 mm vand på stråene, ingen regn, ingen frost og dagslys.
- Viser sidste og næste regn.
- Klippeplan: vækst ud fra temperatur, lys, jordvand, græstype og gødning. Efter 1/3-reglen foreslås næste klipning i et tørt vindue, når du har trykket "Jeg har slået græs i dag".
- Vandingsråd ud fra jordbund (sand, muld, ler), regn og fordampning.
- Anbefalet klippehøjde efter årstid, temperatur, tørke og skygge.
- Kan installeres som app og viser den seneste prognose uden net.
- Forsiden er et hjul i fire felter (Slå nu, Klippeplan, Regn & vand, Din plæne); et tryk åbner feltet med en animation, der passer til indholdet.
- Tegningerne er lavet i stil med de håndkolorerede kobberstik i Flora Danica: løvefod med dug, din græsart, hvidkløver og tusindfryd. De skifter med årstiden og vejret.

## Privatliv og sikkerhed

- Ingen konto, ingen cookies, ingen sporing og ingen nøgler i koden.
- Dit valgte sted, dine indstillinger og dine klippedatoer gemmes kun i din egen browser.
- Positionen afrundes til ca. 1 km, før den sendes til Open-Meteo.
- Skrifttyperne ligger i repositoriet, så siden kontakter ikke Google.
- En Content Security Policy tillader kun sidens egne filer og Open-Meteos to adresser.

Skrifttyperne IM Fell English, IM Fell English SC og Source Serif 4 er under SIL Open Font License 1.1 (se mappen `fonts`).
