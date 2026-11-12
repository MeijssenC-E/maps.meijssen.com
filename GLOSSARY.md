# Topografie Trainer (maps.meijssen.com)

Een interactieve kaartapplicatie om Nederlandse woonplaatsen en andere geografische objecten (zoals snelwegen, wateren en gebouwen) te leren lokaliseren op een blinde kaart.

## Language

**GeoFeature**:
Een geografisch object op de kaart waarnaar in een opdracht gevraagd kan worden, voorzien van een naam, categorie, geometrie (polygoon of lijn) en metadata.
_Avoid_: Object, item, marker, pin

**Woonplaats**:
Een formeel vastgestelde BAG-woonplaats in Nederland (volgens CBS-tabel `86312NED`), gerepresenteerd als een polygoon met bijbehorende gemeente, provincie en inwonersaantal.
_Avoid_: Stad, dorp, gemeente, punt

**Vraagpool**:
De actieve deelverzameling van GeoFeatures die voldoet aan de huidige filterinstellingen (zoals minimum inwonersaantal en provincie) en in de huidige sessie nog niet in één keer goed is geraden.
_Avoid_: Lijst, wachtrij, dataset

**Gok**:
Het punt op de kaart dat de speler aanklikt en bevestigt met OK als antwoord op de gevraagde GeoFeature.
_Avoid_: Klik, antwoord, poging

**Foutafstand**:
De kortste afstand in kilometers van de Gok tot de rand van de polygoon (of lijn) van de gevraagde GeoFeature; bedraagt 0 km wanneer de Gok binnen de polygoon valt.
_Avoid_: Score, afwijking, centroïde-afstand

**Beheerst**:
De status van een GeoFeature waarvan de Gok binnen de polygoon valt of een Foutafstand van maximaal 3 km heeft; een beheerste GeoFeature wordt in `localStorage` opgeslagen en komt niet meer terug in de Vraagpool totdat de voortgang wordt gereset.
_Avoid_: Geleerd, afgerond, voltooid

