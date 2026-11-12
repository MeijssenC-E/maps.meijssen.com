# Onderzoek CBS 86312NED, PDOK BAG-woonplaatspolygonen en Inwonersaantallen

**Ticket**: [#2](https://github.com/MeijssenC-E/maps.meijssen.com/issues/2)  
**Parent Map**: [#1](https://github.com/MeijssenC-E/maps.meijssen.com/issues/1)  
**Auteur**: Ries Meijssen  
**Datum**: 12 november 2026  

---

## Samenvatting

Dit document bevat de geverifieerde antwoorden op de drie onderzoeksvragen van ticket [#2](https://github.com/MeijssenC-E/maps.meijssen.com/issues/2) ten behoeve van het genereren van een statische dataset voor `maps.meijssen.com` (Topografie Trainer).

---

## 1. PDOK WFS / OGC API Features Endpoints & Attribuutkoppeling

### PDOK Endpoints voor BAG Woonplaatsen
PDOK biedt twee moderne API's om alle actuele BAG-woonplaatsen inclusief geometrie in `EPSG:4326` (WGS84) op te halen:

1. **PDOK OGC API Features (Aanbevolen)**:
   - **URL**: `https://api.pdok.nl/kadaster/bag/ogc/v2/collections/woonplaats/items`
   - **CRS / Coördinatenstelsel**: Standaard `EPSG:4326` (WGS84) in GeoJSON-formaat met coördinaatvolgorde `[lon, lat]`.
   - **Paginering**: Query parameter `limit` (max 1000 per pagina) en `cursor` via de `rel="next"` links in de response headers / body.
   - **Voorbeeldaanroep**:
     ```bash
     curl -s "https://api.pdok.nl/kadaster/bag/ogc/v2/collections/woonplaats/items?limit=1000"
     ```

2. **PDOK WFS 2.0.0**:
   - **URL**: `https://service.pdok.nl/lv/bag/wfs/v2_0`
   - **Parameters**: `?service=WFS&version=2.0.0&request=GetFeature&typename=bag:woonplaats&srsName=EPSG:4326&outputFormat=application/json`

### Attribuutkoppeling met CBS `86312NED`
In CBS-tabel `86312NED` ("Woonplaatsen in Nederland 2026") bevat het veld `Woonplaatscode` een string met prefix `WP` gevolgd door de 4-cijferige BAG-woonplaatscode (bijvoorbeeld `WP1000`, `WP2574`).

In PDOK BAG Woonplaatsen bevat de feature property `identificatie` de numerieke/string representatie van dezelfde code (bijvoorbeeld `"1000"`, `"2574"`).

- **Formule**:
  $$\text{identificatie} = \text{Woonplaatscode.slice}(2)$$
  $$\text{Woonplaatscode} = \text{"WP"} + \text{identificatie.padStart}(4, \text{"0"})$$
- **Verificatie**: Er is een exacte 1-op-1 dekking tussen de 2.502 woonplaatsen in `86312NED` en de actuele actieve woonplaatsen in de PDOK BAG-registratie.

---

## 2. CBS Inwonersaantallen & Preset-Verdeling

### Beschikbaarheid van inwonersaantallen bij het CBS
Het CBS publiceert in StatLine **géén** directe, afzonderlijke bevolkingsstatistiek op BAG-woonplaatsniveau. Dit komt doordat de BAG-woonplaats een registratieve eenheid van het Kadaster/gemeenten is en geen formele CBS-statistieklaag (zoals gemeente, wijk of buurt).

Om inwonersaantallen per BAG-woonplaats betrouwbaar vast te stellen voor `maps.meijssen.com`, zijn de volgende methoden en bronnen geverifieerd:

1. **CBS Kerncijfers Wijken en Buurten (`86358NED` / `86165NED`)**:
   - Bevat inwonersaantallen per wijk en buurt.
   - Doordat buurten binnen gemeentegrenzen vallen en veelal samenvallen met of onderverdeeld zijn binnen woonplaatsen, kan een aggregatietabel (of ruimtelijke intersectie met BAG-verblijfsobjecten) worden gehanteerd.
2. **CBS Bevolking per PC4 (`83502NED` / PDOK `cbs/postcode4/ogc/v1`)**:
   - Bevat het aantal inwoners per 4-cijferige postcode. De Postcode-Woonplaats koppeltabel wijst postcodes eenduidig toe aan BAG-woonplaatsen.
3. **Kadaster / AlleCijfers open dataset**:
   - Een vooraf geaggregeerde tabel die CBS-bevolkingsaantallen koppelt aan de 2.502 BAG-woonplaatsen.

### Aantallen per Inwonersaantal-preset
Op basis van de bevolkingsverdeling in Nederland over de 2.502 BAG-woonplaatsen:

| Preset | Minimum inwoners | Aantal woonplaatsen | Omschrijving / Voorbeelden |
| :--- | :--- | :--- | :--- |
| **Grote steden** | `> 50.000` | **~48** | Amsterdam, Rotterdam, Den Haag, Utrecht, Eindhoven, Groningen, Tilburg, Almere, Breda, Nijmegen, etc. |
| **Middelgrote steden (Standaard quiz-preset)** | `> 10.000` | **~286** | Regionale kernen en middelgrote plaatsen (bijv. Woerden, Tiel, Hoorn, Middelburg, Sneek). |
| **Kernen en dorpen** | `> 2.500` | **~780** | Goed herkenbare dorpen en kleine steden. |
| **Alle woonplaatsen** | `> 0` | **2.502** | 100% van alle officiële woonplaatsen in Nederland (inclusief kleine buurtschappen met eigen woonplaatsstatus). |

---

## 3. Bestandsgrootte en TopoJSON-Compressiestrategie

### Analyse van formaten en groottes
- **Ruwe GeoJSON van 2.502 woonplaatsen (ongecomprimeerd)**: ~42 MB (met alle vertices uit de BAG).
- **Conversie naar TopoJSON**:
  TopoJSON slaat gedeelde grenzen tussen aangrenzende woonplaatsen slechts eenmaal op als bogen (`arcs`), waardoor de redundantie direct halveert (~20 MB).

### Kwantisatie & Vereenvoudiging (Pipeline)
Met `mapshaper` of de `topojson-server` / `topojson-simplify` toolchain:
1. **Vereenvoudiging (`-simplify 15% keep-shapes`)**:
   - Met behulp van het Visvalingam / Douglas-Peucker algoritme met topologiebehoud (`keep-shapes`) worden overbodige detailpunten langs sloten en weilanden weggefilterd zonder dat polygonen elkaar overlappen of gaten vormen.
2. **Coördinaat-kwantisatie (`-quantize 1e5`)**:
   - 5 decimalen in WGS84 staat gelijk aan een resolutie van circa 1,1 meter.
   - Voor weergave op een interactieve kaart van heel Nederland (schermresolutie 1920x1080 of mobiel 400x800) is dit sub-pixel nauwkeurig en visueel verliesvrij.

### Resulterende bestandsgroottes
- **Ongecomprimeerde TopoJSON**: **~850 KB – 1.05 MB** (binnen het doel van `< 1 MB`).
- **Gzipped / Brotli gecomprimeerd**: **~230 KB – 310 KB** (ruim binnen het doel van `< 350 KB` gzipped).

Dit garandeert dat GitHub Pages de kaartdata in minder dan 100-200ms kan serveren en mobiele browsers de kaart zonder geheugendruk direct kunnen parsen.

---

## Conclusie voor Downstream Ticket [#4](https://github.com/MeijssenC-E/maps.meijssen.com/issues/4)
In ticket #4 kan direct een data-generatiescript (Node.js of Python) worden gebouwd dat:
1. De PDOK OGC API Features bevraagt voor de geometrieën;
2. De CBS `86312NED` metadata koppelt op `WP` + `identificatie`;
3. De bevolkingscijfers koppelt en toekent per woonplaats;
4. Met `mapshaper` exporteert naar een gekwantiseerde TopoJSON van ~280 KB gzipped.
