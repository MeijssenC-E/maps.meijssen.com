#!/usr/bin/env python3
"""
Genereert data/extra_features.topo.json voor Topografie Trainer (maps.meijssen.com)
met 6 extra categorieën naast woonplaatsen:
  1. snelweg       (PDOK NWB Rijkswegen A1..A79 als MultiLineString)
  2. natuurgebied  (PDOK Nationale Parken & Natura 2000 als Polygon/MultiPolygon)
  3. meer          (PDOK Natura 2000 / BRT TOP10NL wateroppervlakken als Polygon/MultiPolygon)
  4. rivier        (BRT TOP10NL / RWS hoofd- en regionale rivieren)
  5. kanaal        (BRT TOP10NL / RWS hoofd- en regionale kanalen)
  6. gebouw        (PDOK BAG / BRT TOP10NL iconische gebouwen, monumenten, musea, stadions & waterwerken)
"""

import concurrent.futures
import json
import math
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GEOJSON_OUT = DATA_DIR / "extra_features.geojson"
TOPOJSON_OUT = DATA_DIR / "extra_features.topo.json"

PROVINCE_BBOXES = {
    "Groningen": (6.18, 52.84, 7.23, 53.56),
    "Fryslân": (4.85, 52.80, 6.43, 53.52),
    "Drenthe": (6.11, 52.61, 7.09, 53.20),
    "Overijssel": (5.78, 52.11, 7.07, 52.86),
    "Flevoland": (5.12, 52.25, 6.01, 52.85),
    "Gelderland": (4.99, 51.73, 6.84, 52.52),
    "Utrecht": (4.79, 51.93, 5.65, 52.31),
    "Noord-Holland": (4.49, 52.16, 5.33, 53.19),
    "Zuid-Holland": (3.83, 51.65, 5.19, 52.33),
    "Zeeland": (3.35, 51.20, 4.28, 51.76),
    "Noord-Brabant": (4.19, 51.22, 6.05, 51.84),
    "Limburg": (5.56, 50.75, 6.23, 51.78),
}


def fetch_json(url: str, timeout: int = 15, retries: int = 3):
    import time
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "TopografieTrainer/1.0 (https://maps.meijssen.com)"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            if attempt == retries - 1:
                raise e
            time.sleep(1.5 * (attempt + 1))


def parse_wkt_multilinestring(wkt: str):
    """Parse WKT LINESTRING or MULTILINESTRING into list of coordinate arrays [[lon, lat], ...]."""
    if not wkt:
        return []
    wkt = wkt.strip()
    lines = []
    if wkt.upper().startswith("MULTILINESTRING"):
        inner = wkt[wkt.find("(") + 1 : wkt.rfind(")")].strip()
        for part in re.findall(r"\(([^()]+)\)", inner):
            coords = []
            for pair in part.split(","):
                tokens = pair.strip().split()
                if len(tokens) >= 2:
                    coords.append([round(float(tokens[0]), 5), round(float(tokens[1]), 5)])
            if len(coords) >= 2:
                lines.append(coords)
    elif wkt.upper().startswith("LINESTRING"):
        inner = wkt[wkt.find("(") + 1 : wkt.rfind(")")].strip()
        coords = []
        for pair in inner.split(","):
            tokens = pair.strip().split()
            if len(tokens) >= 2:
                coords.append([round(float(tokens[0]), 5), round(float(tokens[1]), 5)])
        if len(coords) >= 2:
            lines.append(coords)
    return lines


def get_geometry_bbox(geom):
    """Return (min_lon, min_lat, max_lon, max_lat) for any GeoJSON geometry."""
    lons = []
    lats = []

    def visit(coords):
        if not coords:
            return
        if isinstance(coords[0], (int, float)):
            lons.append(coords[0])
            lats.append(coords[1])
        else:
            for c in coords:
                visit(c)

    visit(geom.get("coordinates", []))
    if not lons:
        return (5.0, 52.0, 5.0, 52.0)
    return (min(lons), min(lats), max(lons), max(lats))


def infer_provinces_from_geometry(geom):
    """Determine which provinces a geometry intersects using sample points & province polygons."""
    bbox = get_geometry_bbox(geom)
    cx = (bbox[0] + bbox[2]) / 2.0
    cy = (bbox[1] + bbox[3]) / 2.0
    matched = []
    for prov, (xmin, ymin, xmax, ymax) in PROVINCE_BBOXES.items():
        if not (bbox[2] < xmin or bbox[0] > xmax or bbox[3] < ymin or bbox[1] > ymax):
            if xmin <= cx <= xmax and ymin <= cy <= ymax:
                matched.append(prov)
    if not matched:
        # Fallback to closest province center
        best_prov = "Gelderland"
        best_dist = 999.0
        for prov, (xmin, ymin, xmax, ymax) in PROVINCE_BBOXES.items():
            px = (xmin + xmax) / 2.0
            py = (ymin + ymax) / 2.0
            d = math.hypot(cx - px, cy - py)
            if d < best_dist:
                best_dist = d
                best_prov = prov
        matched = [best_prov]
    return sorted(set(matched))


def make_box_polygon(lon: float, lat: float, radius_m: float = 120.0):
    """Create an octagonal polygon around (lon, lat) with given radius in meters."""
    d_lat = radius_m / 111320.0
    d_lon = radius_m / (111320.0 * math.cos(math.radians(lat)))
    ring = []
    for i in range(8):
        angle = math.radians(i * 45)
        ring.append([round(lon + d_lon * math.cos(angle), 5), round(lat + d_lat * math.sin(angle), 5)])
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


# ==============================================================================
# 1. SNELWEGEN (PDOK Locatieserver NWB)
# ==============================================================================
HIGHWAY_META = {
    "A1": (1, "Amsterdam – Hengelo – Duitse grens (ca. 157 km)"),
    "A2": (1, "Amsterdam – Utrecht – Eindhoven – Maastricht (ca. 217 km)"),
    "A4": (1, "Amsterdam – Den Haag – Rotterdam – Belgische grens (ca. 122 km)"),
    "A5": (3, "Hoofddorp – Raasdorp – Amsterdam Westpoort (ca. 17 km)"),
    "A6": (1, "Muiderberg – Almere – Lelystad – Joure (ca. 101 km)"),
    "A7": (1, "Zaandam – Afsluitdijk – Heerenveen – Groningen – Bad Nieuweschans (ca. 242 km)"),
    "A8": (3, "Amsterdam (Ring A10) – Zaandam / Assendelft (ca. 10 km)"),
    "A9": (1, "Diemen – Amstelveen – Haarlem – Alkmaar (ca. 96 km)"),
    "A10": (2, "Ringweg Amsterdam (ca. 32 km)"),
    "A12": (1, "Den Haag – Utrecht – Arnhem – Duitse grens (ca. 137 km)"),
    "A13": (3, "Den Haag – Delft – Rotterdam (ca. 17 km)"),
    "A15": (1, "Maasvlakte – Rotterdam – Gorinchem – Nijmegen (ca. 152 km)"),
    "A16": (1, "Rotterdam – Dordrecht – Breda – Belgische grens (ca. 63 km)"),
    "A17": (2, "Moerdijk – Roosendaal – Bergen op Zoom (ca. 27 km)"),
    "A18": (2, "Zevenaar – Doetinchem – Varsseveld (ca. 22 km)"),
    "A20": (2, "Westerlee – Vlaardingen – Rotterdam – Gouda (ca. 39 km)"),
    "A22": (3, "Velsen – Velsertunnel – Beverwijk (ca. 8 km)"),
    "A24": (3, "Blankenburgverbinding: Vlaardingen – Rozenburg (ca. 4 km)"),
    "A27": (1, "Breda – Gorinchem – Utrecht – Almere (ca. 109 km)"),
    "A28": (1, "Utrecht – Amersfoort – Zwolle – Assen – Groningen (ca. 187 km)"),
    "A29": (2, "Rotterdam – Heinenoordtunnel – Haringvlietbrug (ca. 26 km)"),
    "A30": (2, "Barneveld (A1) – Ede (A12) (ca. 18 km)"),
    "A31": (2, "Harlingen – Franeker – Leeuwarden (ca. 32 km)"),
    "A32": (2, "Meppel – Steenwijk – Heerenveen – Leeuwarden (ca. 67 km)"),
    "A35": (2, "Wierden – Almelo – Hengelo – Enschede (ca. 36 km)"),
    "A37": (2, "Hoogeveen – Emmen – Duitse grens (ca. 42 km)"),
    "A38": (3, "Knooppunt Ridderkerk – Ridderkerk (ca. 2 km)"),
    "A44": (2, "Wassenaar – Leiden – Burgerveen (ca. 28 km)"),
    "A50": (1, "Eindhoven – Oss – Apeldoorn – Zwolle (ca. 151 km)"),
    "A58": (1, "Eindhoven – Tilburg – Breda – Bergen op Zoom – Vlissingen (ca. 137 km)"),
    "A59": (1, "Willemstad – Waalwijk – 's-Hertogenbosch – Oss (ca. 121 km)"),
    "A65": (3, "Tilburg – Berkel-Enschot / Vught (ca. 6 km)"),
    "A67": (1, "Belgische grens – Eindhoven – Venlo – Duitse grens (ca. 75 km)"),
    "A73": (1, "Nijmegen – Venlo – Roermond – Maasbracht (ca. 106 km)"),
    "A74": (3, "Venlo (A73) – Duitse grens (BAB 61) (ca. 2 km)"),
    "A76": (2, "Belgische grens – Stein – Geleen – Heerlen – Duitse grens (ca. 27 km)"),
    "A77": (3, "Boxmeer (A73) – Gennep – Duitse grens (ca. 10 km)"),
    "A79": (2, "Maastricht – Valkenburg – Heerlen (ca. 17 km)"),
}


def fetch_single_highway(code: str):
    tier, desc = HIGHWAY_META[code]
    url = (
        "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?"
        + urllib.parse.urlencode(
            {
                "q": f'"{code}"',
                "fq": "bron:NWB AND type:weg",
                "rows": 100,
                "fl": "straatnaam,provincienaam,geometrie_ll",
            }
        )
    )
    try:
        data = fetch_json(url)
        docs = [d for d in data.get("response", {}).get("docs", []) if d.get("straatnaam") == code]
        all_lines = []
        provs = set()
        for d in docs:
            if d.get("provincienaam"):
                provs.add(d["provincienaam"])
            all_lines.extend(parse_wkt_multilinestring(d.get("geometrie_ll", "")))
        if not all_lines:
            return None
        prov_list = sorted(provs)
        return {
            "type": "Feature",
            "id": f"SW_{code}",
            "properties": {
                "id": f"SW_{code}",
                "code": f"SW_{code}",
                "naam": code,
                "categorie": "snelweg",
                "subcategorie": "snelweg",
                "tier": tier,
                "provincie": prov_list[0] if prov_list else "",
                "provincies": prov_list,
                "details": f"Rijksweg {code} · {desc}",
            },
            "geometry": {
                "type": "MultiLineString",
                "coordinates": all_lines,
            },
        }
    except Exception as e:
        print(f"  Waarschuwing snelweg {code}: {e}")
        return None


def fetch_highways():
    print("Stap 1: Ophalen van alle 38 Nederlandse snelwegen (A1..A79) via PDOK NWB...")
    features = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(fetch_single_highway, code): code for code in HIGHWAY_META}
        for fut in concurrent.futures.as_completed(futures):
            res = fut.result()
            if res:
                features.append(res)
    features.sort(key=lambda f: int(re.sub(r"\D", "", f["properties"]["naam"]) or 0))
    print(f"  {len(features)} snelwegen opgehaald.")
    return features


# ==============================================================================
# 2. NATUURGEBIEDEN & GROTE WATEREN UIT PDOK WFS (Nationale Parken & Natura 2000)
# ==============================================================================
WATER_N2K_MAPPING = {
    "IJsselmeer": ("IJsselmeer", 1, "meer", "Grootste meer van Nederland (ca. 1.100 km²)", ["Flevoland", "Fryslân", "Noord-Holland"]),
    "Markermeer & IJmeer": ("Markermeer", 1, "meer", "Groot meer tussen Noord-Holland en Flevoland (ca. 700 km²)", ["Flevoland", "Noord-Holland"]),
    "Waddenzee": ("Waddenzee", 1, "zeearm / binnenzee", "Intergetijdengebied tussen de Waddeneilanden en het vasteland (UNESCO Werelderfgoed)", ["Fryslân", "Groningen", "Noord-Holland"]),
    "Oosterschelde": ("Oosterschelde", 1, "zeearm", "Grootste Nationaal Park en zeearm in Zeeland, afgesloten met de Oosterscheldekering", ["Zeeland"]),
    "Westerschelde & Saeftinghe": ("Westerschelde", 1, "zeearm", "Estuarium en drukke scheepvaartroute naar de haven van Antwerpen", ["Zeeland"]),
    "Grevelingen": ("Grevelingenmeer", 1, "meer", "Grootste zoutwatermeer van West-Europa tussen Goeree-Overflakkee en Schouwen-Duiveland", ["Zeeland", "Zuid-Holland"]),
    "Haringvliet": ("Haringvliet", 1, "zeearm / meer", "Voormalige zeearm van de Rijn en Maas tussen Voorne-Putten, Hoeksche Waard en Goeree-Overflakkee", ["Zuid-Holland"]),
    "Hollands Diep": ("Hollandsch Diep", 1, "water", "Brede waterloop tussen Zuid-Holland en Noord-Brabant, verbonden met Biesbosch en Haringvliet", ["Noord-Brabant", "Zuid-Holland"]),
    "Krammer-Volkerak": ("Volkerak", 1, "meer", "Zoetwatermeer tussen Zuid-Holland, Zeeland en Noord-Brabant", ["Noord-Brabant", "Zeeland", "Zuid-Holland"]),
    "Veerse Meer": ("Veerse Meer", 1, "meer", "Brakwatermeer in Zeeland tussen Walcheren, Noord-Beveland en Zuid-Beveland", ["Zeeland"]),
    "Ketelmeer & Vossemeer": ("Ketelmeer", 1, "meer", "Randmeer tussen de Noordoostpolder en Oostelijk Flevoland bij de monding van de IJssel", ["Flevoland", "Overijssel"]),
    "Zwarte Meer": ("Zwarte Meer", 2, "meer", "Randmeer tussen Flevoland en Overijssel bij de monding van het Zwarte Water", ["Flevoland", "Overijssel"]),
    "Sneekermeergebied": ("Sneekermeer", 1, "meer", "Een van de bekendste Friese meren ten oosten van Sneek (Snitser Mar)", ["Fryslân"]),
    "Oudegaasterbrekken, Fluessen en omgeving": ("Fluessen & Heegermeer", 1, "meer", "Het grootste aaneengesloten meer van Fryslân (De Fluezen / Hegemer Mar)", ["Fryslân"]),
    "Witte en Zwarte Brekken": ("Witte en Zwarte Brekken", 3, "meer", "Merencomplex ten zuiden van Sneek in Fryslân", ["Fryslân"]),
    "Zoommeer": ("Zoommeer", 2, "meer", "Zoetwatermeer op de grens van Zeeland en Noord-Brabant bij Bergen op Zoom", ["Noord-Brabant", "Zeeland"]),
    "Zuidlaardermeergebied": ("Zuidlaardermeer", 2, "meer", "Groot meer op de grens van Groningen en Drenthe ten oosten van Zuidlaren", ["Drenthe", "Groningen"]),
    "Leekstermeergebied": ("Leekstermeer", 2, "meer", "Meer op de grens van Drenthe en Groningen bij Leek en Roden", ["Drenthe", "Groningen"]),
    "Naardermeer": ("Naardermeer", 2, "meer", "Natuurlijk meer en oudste natuurmonument van Nederland (1906) bij Naarden", ["Noord-Holland"]),
    "Nieuwkoopse Plassen & De Haeck": ("Nieuwkoopse Plassen", 2, "meer / plassen", "Uitgestrekt laagveenplassengebied in het Groene Hart (Zuid-Holland)", ["Zuid-Holland"]),
    "Oostelijke Vechtplassen": ("Loosdrechtse Plassen", 2, "meer / plassen", "Bekend watersport- en laagveenplassengebied tussen de Vecht en het Gooi", ["Noord-Holland", "Utrecht"]),
    "Lonnekermeer": ("Lonnekermeer", 3, "meer", "Natuur- en merengebied in Twente tussen Enschede en Hengelo", ["Overijssel"]),
}


def fetch_nature_and_n2k_waters():
    print("Stap 2: Ophalen van Nationale Parken en Natura 2000-gebieden via PDOK WFS...")
    np_url = (
        "https://service.pdok.nl/rvo/nationaleparken/wfs/v2_0?"
        "service=WFS&version=2.0.0&request=GetFeature&typeName=nationaleparken:nationaleparken"
        "&outputFormat=application/json&srsName=EPSG:4326"
    )
    n2k_url = (
        "https://service.pdok.nl/rvo/natura2000/wfs/v1_0?"
        "service=WFS&version=2.0.0&request=GetFeature&typeName=natura2000:natura2000"
        "&outputFormat=application/json&srsName=EPSG:4326"
    )

    np_data = fetch_json(np_url, timeout=20)
    n2k_data = fetch_json(n2k_url, timeout=25)

    nature_features = []
    water_features = []
    seen_nature_names = set()

    # 1. Process 21 Nationale Parken (Tier 1 nature)
    for f in np_data.get("features", []):
        props = f.get("properties", {})
        raw_name = (props.get("naam") or "").strip()
        if not raw_name or raw_name.lower() in seen_nature_names:
            continue
        seen_nature_names.add(raw_name.lower())

        ha = float(props.get("hectares") or 0)
        km2 = round(ha / 100.0, 1)
        geom = f.get("geometry")
        if not geom:
            continue
        provs = infer_provinces_from_geometry(geom)
        slug = re.sub(r"[^a-z0-9]+", "_", raw_name.lower()).strip("_")

        nature_features.append(
            {
                "type": "Feature",
                "id": f"NP_{slug}",
                "properties": {
                    "id": f"NP_{slug}",
                    "code": f"NP_{slug}",
                    "naam": raw_name,
                    "categorie": "natuurgebied",
                    "subcategorie": "nationaal park",
                    "tier": 1,
                    "provincie": provs[0] if provs else "",
                    "provincies": provs,
                    "details": f"Nationaal Park · Oppervlakte: ca. {km2} km²",
                },
                "geometry": geom,
            }
        )

    # 2. Group Natura 2000 polygons by naamN2K
    grouped_n2k = {}
    for f in n2k_data.get("features", []):
        props = f.get("properties", {})
        name = (props.get("naamN2K") or "").strip()
        geom = f.get("geometry")
        if not name or not geom:
            continue
        area_m2 = float(props.get("shapeArea") or 0)
        if name not in grouped_n2k:
            grouped_n2k[name] = {"area_m2": 0.0, "polys": []}
        grouped_n2k[name]["area_m2"] += area_m2
        if geom["type"] == "Polygon":
            grouped_n2k[name]["polys"].append(geom["coordinates"])
        elif geom["type"] == "MultiPolygon":
            grouped_n2k[name]["polys"].extend(geom["coordinates"])

    for n2k_name, info in grouped_n2k.items():
        if not info["polys"]:
            continue
        merged_geom = (
            {"type": "Polygon", "coordinates": info["polys"][0]}
            if len(info["polys"]) == 1
            else {"type": "MultiPolygon", "coordinates": info["polys"]}
        )
        km2 = round(info["area_m2"] / 1_000_000.0, 1)
        slug = re.sub(r"[^a-z0-9]+", "_", n2k_name.lower()).strip("_")

        # Check if this N2K area is mapped as a Lake / Water body
        if n2k_name in WATER_N2K_MAPPING:
            w_name, w_tier, w_sub, w_desc, w_provs = WATER_N2K_MAPPING[n2k_name]
            water_features.append(
                {
                    "type": "Feature",
                    "id": f"MR_{slug}",
                    "properties": {
                        "id": f"MR_{slug}",
                        "code": f"MR_{slug}",
                        "naam": w_name,
                        "categorie": "meer",
                        "subcategorie": w_sub,
                        "tier": w_tier,
                        "provincie": w_provs[0],
                        "provincies": w_provs,
                        "details": w_desc,
                    },
                    "geometry": merged_geom,
                }
            )
            continue

        # Skip if already added as a National Park
        norm_n2k = re.sub(r"^de\s+", "", n2k_name.lower())
        if any(norm_n2k in np_n or np_n in norm_n2k for np_n in seen_nature_names):
            continue

        provs = infer_provinces_from_geometry(merged_geom)
        tier = 2 if km2 >= 20.0 else 3
        nature_features.append(
            {
                "type": "Feature",
                "id": f"N2K_{slug}",
                "properties": {
                    "id": f"N2K_{slug}",
                    "code": f"N2K_{slug}",
                    "naam": n2k_name,
                    "categorie": "natuurgebied",
                    "subcategorie": "natuurgebied",
                    "tier": tier,
                    "provincie": provs[0] if provs else "",
                    "provincies": provs,
                    "details": f"Natura 2000-gebied · Oppervlakte: ca. {km2} km²",
                },
                "geometry": merged_geom,
            }
        )

    print(f"  {len(nature_features)} natuurgebieden en {len(water_features)} grote watervlakken uit PDOK WFS opgehaald.")
    return nature_features, water_features


# ==============================================================================
# 3. EXTRA MEREN & PLASSEN (PDOK TOP10NL waterdeel_vlak / polygoon)
# ==============================================================================
EXTRA_LAKES = [
    ("Veluwemeer", 1, "randmeer", ["Flevoland", "Gelderland"], "Randmeer tussen Oostelijk Flevoland en de Noord-Veluwe", [(5.62, 52.38), (5.72, 52.42), (5.79, 52.45), (5.68, 52.40), (5.58, 52.36)]),
    ("Gooimeer", 1, "randmeer", ["Flevoland", "Noord-Holland"], "Randmeer tussen Zuidelijk Flevoland (Almere) en het Gooi (Huizen/Naarden)", [(5.15, 52.32), (5.21, 52.31), (5.26, 52.29), (5.19, 52.30)]),
    ("Eemmeer", 2, "randmeer", ["Flevoland", "Noord-Holland", "Utrecht"], "Randmeer tussen Zuidelijk Flevoland, het Gooi en de provincie Utrecht", [(5.28, 52.28), (5.33, 52.27), (5.38, 52.26), (5.32, 52.28)]),
    ("Wolderwijd", 2, "randmeer", ["Flevoland", "Gelderland"], "Randmeer tussen Zeewolde en Harderwijk", [(5.53, 52.34), (5.58, 52.35), (5.56, 52.32), (5.51, 52.33)]),
    ("Drontermeer", 2, "randmeer", ["Flevoland", "Gelderland", "Overijssel"], "Randmeer tussen Oostelijk Flevoland, Gelderland (Elburg) en Overijssel (Kampen)", [(5.83, 52.47), (5.85, 52.50), (5.84, 52.52)]),
    ("Tjeukemeer", 1, "meer", ["Fryslân"], "Het grootste binnenmeer van Fryslân (Tsjûkemar) in De Fryske Marren", [(5.77, 52.89), (5.82, 52.90), (5.83, 52.87), (5.78, 52.87)]),
    ("Slotermeer", 1, "meer", ["Fryslân"], "Bekend Fries meer (Sleattemer Mar) tussen Sloten, Balk en Woudsend", [(5.61, 52.91), (5.64, 52.92), (5.63, 52.90), (5.60, 52.90)]),
    ("Bergumermeer", 2, "meer", ["Fryslân"], "Groot meer in het noordoosten van Fryslân bij Burgum (Burgumer Mar)", [(6.02, 53.19), (6.05, 53.20), (6.04, 53.18), (6.01, 53.18)]),
    ("Kagerplassen", 2, "plassen", ["Zuid-Holland"], "Watersport- en plassengebied ten noordoosten van Leiden bij Warmond en Kaag", [(4.53, 52.20), (4.56, 52.21), (4.55, 52.19), (4.52, 52.19)]),
    ("Westeinderplassen", 2, "plassen", ["Noord-Holland"], "Groot plassengebied in Noord-Holland tussen Aalsmeer, Leimuiden en Kudelstaart", [(4.72, 52.25), (4.76, 52.26), (4.75, 52.23), (4.71, 52.24)]),
    ("Brasemermeer", 2, "meer", ["Zuid-Holland"], "Rond meer in het noorden van Zuid-Holland bij Roelofarendsveen en Woubrugge", [(4.66, 52.16), (4.68, 52.17), (4.68, 52.15), (4.66, 52.15)]),
    ("Reeuwijkse Plassen", 2, "plassen", ["Zuid-Holland"], "Laagveenplassengebied ten oosten van Gouda bij Reeuwijk", [(4.74, 52.04), (4.78, 52.05), (4.77, 52.02), (4.73, 52.03)]),
    ("Vinkeveense Plassen", 2, "plassen", ["Utrecht"], "Plassengebied met legakkers en zandeilanden bij Vinkeveen in Noordwest-Utrecht", [(4.94, 52.23), (4.97, 52.24), (4.96, 52.21), (4.93, 52.21)]),
    ("Kralingse Plas", 2, "meer / plas", ["Zuid-Holland"], "Bekende recreatieplas grenzend aan het Kralingse Bos in Rotterdam", [(4.51, 51.935), (4.525, 51.94), (4.525, 51.928), (4.51, 51.928)]),
    ("Paterswoldsemeer", 2, "meer", ["Drenthe", "Groningen"], "Recreatiemeer ten zuidwesten van de stad Groningen op de grens met Drenthe", [(6.54, 53.17), (6.56, 53.175), (6.555, 53.155), (6.535, 53.16)]),
    ("Schildmeer", 2, "meer", ["Groningen"], "Meer in Midden-Groningen bij Steendam en Overschild", [(6.81, 53.27), (6.84, 53.28), (6.83, 53.26), (6.80, 53.26)]),
    ("Oldambtmeer", 3, "meer", ["Groningen"], "Groot aangelegd meer (Blauwestad) in Oost-Groningen bij Winschoten", [(7.00, 53.19), (7.04, 53.21), (7.03, 53.17), (6.99, 53.17)]),
    ("Alkmaardermeer", 3, "meer", ["Noord-Holland"], "Meer tussen Alkmaar, Uitgeest en Akersloot (inclusief Uitgeestermeer)", [(4.73, 52.55), (4.76, 52.56), (4.75, 52.53), (4.72, 52.53)]),
    ("Amstelmeer", 3, "meer", ["Noord-Holland"], "Voormalige zeearm in de kop van Noord-Holland bij Wieringen", [(4.88, 52.87), (4.93, 52.88), (4.92, 52.85), (4.87, 52.86)]),
    ("Brielse Meer", 3, "meer", ["Zuid-Holland"], "Afgedamde arm van de Maas tussen Voorne-Putten en Rozenburg bij Brielle", [(4.14, 51.91), (4.22, 51.90), (4.24, 51.89), (4.16, 51.90)]),
    ("Maasplassen", 2, "meren / plassen", ["Limburg"], "Uitgestrekt aaneengesloten watersportgebied langs de Maas bij Roermond", [(5.89, 51.17), (5.96, 51.20), (5.94, 51.15), (5.87, 51.14)]),
    ("Belterwijde & Beulakerwijde", 3, "meer", ["Overijssel"], "De twee grootste meren in Nationaal Park Weerribben-Wieden bij Giethoorn", [(6.05, 52.70), (6.10, 52.71), (6.09, 52.67), (6.04, 52.68)]),
    ("Dollard", 2, "zeearm", ["Groningen"], "Inham van de Waddenzee en de Eemsmonding in het uiterste noordoosten van Groningen", [(7.08, 53.29), (7.19, 53.31), (7.18, 53.24), (7.07, 53.25)]),
]


def fetch_top10_water_polygon(name: str, pts):
    """Fetch official TOP10NL waterdeel_vlak polygon at center of lake, with fallback to bounding polygon."""
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    bbox = f"{cx - 0.025:.4f},{cy - 0.02:.4f},{cx + 0.025:.4f},{cy + 0.02:.4f}"
    url = f"https://api.pdok.nl/brt/top10nl/ogc/v1/collections/waterdeel_vlak/items?f=json&limit=25&bbox={bbox}"
    try:
        data = fetch_json(url, timeout=10)
        polys = []
        target_key = name.split()[0].lower()
        for f in data.get("features", []):
            p = f.get("properties", {})
            wname = (p.get("naamnl") or p.get("naamofficieel") or p.get("naamfries") or "").lower()
            geom = f.get("geometry")
            if geom and (target_key in wname or p.get("typewater") == "meer, plas"):
                if geom["type"] == "Polygon":
                    polys.append(geom["coordinates"])
                elif geom["type"] == "MultiPolygon":
                    polys.extend(geom["coordinates"])
        if polys:
            return {"type": "MultiPolygon", "coordinates": polys[:8]}
    except Exception:
        pass
    ring = [[round(p[0], 5), round(p[1], 5)] for p in pts]
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def build_extra_lakes():
    print("Stap 3: Ophalen van aanvullende meren en randmeren via PDOK BRT TOP10NL...")
    features = []
    for name, tier, sub, provs, desc, pts in EXTRA_LAKES:
        slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        geom = fetch_top10_water_polygon(name, pts)
        features.append(
            {
                "type": "Feature",
                "id": f"MR_{slug}",
                "properties": {
                    "id": f"MR_{slug}",
                    "code": f"MR_{slug}",
                    "naam": name,
                    "categorie": "meer",
                    "subcategorie": sub,
                    "tier": tier,
                    "provincie": provs[0],
                    "provincies": provs,
                    "details": desc,
                },
                "geometry": geom,
            }
        )
    print(f"  {len(features)} extra meren/plassen samengesteld.")
    return features


# ==============================================================================
# 4. RIVIEREN (Hoofdrivieren, regionale rivieren en stromen)
# ==============================================================================
RIVERS_DATA = [
    # Tier 1: Hoofdrivieren
    ("Waal", 1, ["Gelderland", "Zuid-Holland"], "Belangrijkste en drukst bevaren Rijntak in Nederland van Pannerden tot Gorinchem (ca. 82 km)", [[6.036, 51.874], [5.945, 51.882], [5.853, 51.852], [5.712, 51.886], [5.595, 51.889], [5.442, 51.884], [5.331, 51.815], [5.249, 51.816], [5.148, 51.825], [5.019, 51.822]]),
    ("Nederrijn", 1, ["Gelderland", "Utrecht"], "Noordelijke Rijntak tussen Angeren (Pannerdens Kanaal) en Wijk bij Duurstede (ca. 50 km)", [[5.965, 51.942], [5.899, 51.975], [5.815, 51.969], [5.666, 51.958], [5.565, 51.954], [5.442, 51.975], [5.344, 51.969]]),
    ("Lek", 1, ["Gelderland", "Utrecht", "Zuid-Holland"], "Voortzetting van de Nederrijn vanaf Wijk bij Duurstede tot Kinderdijk (ca. 62 km)", [[5.344, 51.969], [5.222, 51.966], [5.132, 51.992], [5.092, 51.997], [4.975, 51.961], [4.865, 51.936], [4.775, 51.912], [4.636, 51.891]]),
    ("Maas", 1, ["Gelderland", "Limburg", "Noord-Brabant"], "Grote regenrivier van Eijsden via Maastricht, Roermond, Venlo en Cuijk naar Heusden (ca. 250 km in NL)", [[5.706, 50.778], [5.695, 50.851], [5.764, 50.996], [5.845, 51.119], [5.978, 51.198], [6.068, 51.275], [6.171, 51.371], [6.152, 51.498], [6.035, 51.608], [5.955, 51.698], [5.875, 51.734], [5.735, 51.792], [5.605, 51.815], [5.495, 51.811], [5.335, 51.751], [5.145, 51.737]]),
    ("Gelderse IJssel", 1, ["Gelderland", "Overijssel"], "Aftakking van de Rijn bij Westervoort via Zutphen, Deventer en Zwolle naar het Ketelmeer (ca. 127 km)", [[5.965, 51.945], [6.048, 51.995], [6.128, 52.049], [6.195, 52.142], [6.155, 52.254], [6.136, 52.356], [6.085, 52.448], [6.055, 52.509], [5.925, 52.556], [5.845, 52.581]]),
    ("Bergsche Maas", 1, ["Noord-Brabant"], "Gegraven benedenloop van de Maas van Heusden naar het Amergebied bij Geertruidenberg (ca. 25 km)", [[5.145, 51.737], [5.045, 51.721], [4.945, 51.716], [4.862, 51.714]]),
    ("Boven- en Beneden-Merwede", 1, ["Gelderland", "Noord-Brabant", "Zuid-Holland"], "Drukbevaren riviertraject vanaf de samenvloeiing van Waal en Afgedamde Maas bij Woudrichem tot Dordrecht", [[5.019, 51.822], [4.965, 51.827], [4.885, 51.823], [4.765, 51.822], [4.675, 51.816]]),
    ("Nieuwe Merwede", 1, ["Noord-Brabant", "Zuid-Holland"], "Vergraven Rijntak langs de Biesbosch van Werkendam naar het Hollandsch Diep (ca. 20 km)", [[4.885, 51.823], [4.805, 51.791], [4.735, 51.748], [4.665, 51.712]]),
    ("Nieuwe Maas", 1, ["Zuid-Holland"], "Rivier door Rotterdam vanaf de samenvloeiing van Noord en Lek tot Vlaardingen (ca. 24 km)", [[4.636, 51.891], [4.545, 51.905], [4.482, 51.908], [4.415, 51.898], [4.335, 51.898]]),
    ("Nieuwe Waterweg", 1, ["Zuid-Holland"], "Geen sluizen bevattende uitmonding van Rijn en Maas van Vlaardingen/Maassluis naar Hoek van Holland", [[4.335, 51.898], [4.245, 51.912], [4.165, 51.954], [4.095, 51.981]]),
    ("Oude Maas", 1, ["Zuid-Holland"], "Getijdenrivier tussen Dordrecht, Zwijndrecht, Barendrecht en Spijkenisse (ca. 30 km)", [[4.655, 51.812], [4.595, 51.825], [4.525, 51.832], [4.435, 51.831], [4.345, 51.868], [4.315, 51.895]]),
    ("Rivier de Noord", 1, ["Zuid-Holland"], "Korte maar zeer drukke getijdenrivier tussen Dordrecht/Papendrecht en Krimpen aan de Lek (ca. 9 km)", [[4.665, 51.818], [4.655, 51.855], [4.636, 51.891]]),
    ("Hollandse IJssel", 1, ["Utrecht", "Zuid-Holland"], "Rivier van Nieuwegein via IJsselstein, Montfoort, Oudewater en Gouda naar Krimpen aan den IJssel (ca. 46 km)", [[5.085, 52.025], [5.045, 52.018], [4.951, 52.045], [4.872, 52.024], [4.795, 52.008], [4.712, 52.008], [4.625, 51.961], [4.562, 51.912]]),
    ("Amstel", 1, ["Noord-Holland", "Utrecht"], "Bekende veenrivier van Nieuwveen en Uithoorn via Ouderkerk aan de Amstel naar het centrum van Amsterdam (ca. 31 km)", [[4.828, 52.222], [4.878, 52.242], [4.904, 52.296], [4.915, 52.338], [4.899, 52.368]]),
    ("Utrechtse Vecht", 1, ["Noord-Holland", "Utrecht"], "Schilderachtige rivier met buitenplaatsen van Utrecht via Maarssen, Breukelen en Weesp naar Muiden (ca. 42 km)", [[5.109, 52.105], [5.042, 52.142], [5.005, 52.174], [5.019, 52.212], [5.025, 52.261], [5.042, 52.308], [5.071, 52.334]]),
    ("Overijsselse Vecht", 1, ["Overijssel"], "Regenrivier van de Duitse grens bij Gramsbergen via Hardenberg, Ommen en Dalfsen naar Zwolle (ca. 60 km in NL)", [[6.695, 52.612], [6.618, 52.576], [6.425, 52.518], [6.256, 52.502], [6.125, 52.548]]),

    # Tier 2: Regionale rivieren
    ("Linge", 2, ["Gelderland", "Zuid-Holland"], "Langste geheel Nederlandse rivier door de Betuwe van Doornenburg via Geldermalsen en Leerdam naar Gorinchem (ca. 108 km)", [[6.002, 51.895], [5.845, 51.918], [5.652, 51.925], [5.442, 51.898], [5.285, 51.882], [5.095, 51.891], [4.975, 51.829]]),
    ("Dommel", 2, ["Noord-Brabant"], "Brabantse beek/rivier van de Belgische grens via Valkenswaard, Eindhoven, Son en Boxtel naar 's-Hertogenbosch (ca. 85 km in NL)", [[5.445, 51.285], [5.478, 51.355], [5.482, 51.438], [5.492, 51.512], [5.328, 51.592], [5.298, 51.688]]),
    ("Dinkel", 2, ["Overijssel"], "Meanderende Twentse rivier langs Losser, De Lutte, Denekamp en Lattrop (ca. 46 km in NL)", [[6.995, 52.225], [7.015, 52.265], [7.022, 52.318], [7.005, 52.378], [6.968, 52.435]]),
    ("Regge", 2, ["Overijssel"], "Rivier op de grens van Twente en Salland langs Goor, Enter, Rijssen, Nijverdal en Hellendoorn naar Ommen (ca. 52 km)", [[6.585, 52.225], [6.565, 52.295], [6.515, 52.362], [6.462, 52.425], [6.438, 52.512]]),
    ("Berkel", 2, ["Gelderland"], "Achterhoekse rivier van de Duitse grens bij Rekken via Eibergen, Borculo en Lochem naar Zutphen (ca. 45 km in NL)", [[6.725, 52.095], [6.645, 52.105], [6.525, 52.118], [6.415, 52.162], [6.295, 52.155], [6.202, 52.142]]),
    ("Oude IJssel", 2, ["Gelderland"], "Rivier in de Achterhoek langs Gendringen, Ulft, Terborg en Doetinchem tot Doesburg (ca. 50 km in NL)", [[6.415, 51.872], [6.365, 51.915], [6.288, 51.962], [6.195, 51.992], [6.132, 52.015]]),
    ("Zaan", 2, ["Noord-Holland"], "Noord-Hollandse veenrivier door de Zaanstreek van Knollendam via Wormerveer en Koog aan de Zaan naar Zaandam (ca. 13 km)", [[4.782, 52.522], [4.795, 52.495], [4.812, 52.465], [4.828, 52.432]]),
    ("Spaarne", 2, ["Noord-Holland"], "Rivier van de Ringvaart bij Cruquius en Heemstede door het centrum van Haarlem naar Spaarndam (ca. 11 km)", [[4.625, 52.332], [4.638, 52.362], [4.642, 52.382], [4.668, 52.415]]),
    ("Oude Rijn", 2, ["Utrecht", "Zuid-Holland"], "Voormalige hoofdloop van de Rijn van Harmelen en Woerden via Alphen aan den Rijn en Leiden naar Katwijk aan Zee (ca. 52 km)", [[4.992, 52.092], [4.882, 52.086], [4.765, 52.098], [4.658, 52.129], [4.545, 52.145], [4.485, 52.160], [4.395, 52.205]]),
    ("Kromme Rijn", 2, ["Utrecht"], "Kronkelende rivier van Wijk bij Duurstede via Cothen, Werkhoven, Odijk en Bunnik naar de stad Utrecht (ca. 28 km)", [[5.342, 51.972], [5.285, 52.002], [5.228, 52.038], [5.175, 52.065], [5.128, 52.082]]),
    ("Eem", 2, ["Utrecht"], "Rivier van Amersfoort via Soest, Baarn en Eemnes naar het Eemmeer (ca. 18 km)", [[5.378, 52.162], [5.332, 52.192], [5.298, 52.218], [5.318, 52.265]]),
    ("Gouwe", 2, ["Zuid-Holland"], " Gekanaliseerde rivier in Zuid-Holland tussen de Oude Rijn bij Alphen aan den Rijn, Boskoop, Waddinxveen en de Hollandse IJssel bij Gouda (ca. 14 km)", [[4.665, 52.118], [4.662, 52.075], [4.652, 52.042], [4.685, 52.008]]),
    ("Rotte", 2, ["Zuid-Holland"], "Veenrivier waaraan Rotterdam zijn naam dankt, van Moerkapelle en Bleiswijk naar het centrum van Rotterdam (ca. 22 km)", [[4.552, 52.035], [4.535, 51.995], [4.512, 51.958], [4.488, 51.928]]),
    ("Zwarte Water", 2, ["Overijssel"], "Korte maar brede rivier in Overijssel van Zwolle via Hasselt en Zwartsluis naar het Zwarte Meer (ca. 19 km)", [[6.078, 52.525], [6.092, 52.592], [6.068, 52.642], [6.005, 52.638]]),
    ("Geul", 2, ["Limburg"], "Snelstromende Zuid-Limburgse heuvellandrivier van Epen en Mechelen via Gulpen en Valkenburg naar de Maas bij Meerssen (ca. 38 km in NL)", [[5.918, 50.762], [5.892, 50.812], [5.832, 50.865], [5.762, 50.875], [5.722, 50.895]]),
    ("Roer", 2, ["Limburg"], "Zijrivier van de Maas in Midden-Limburg langs Vlodrop, Sint Odiliënberg en Roermond (ca. 22 km in NL)", [[6.115, 51.125], [6.055, 51.145], [6.002, 51.168], [5.982, 51.192]]),
    ("Drentsche Aa", 2, ["Drenthe", "Groningen"], "Natuurlijk meanderend beek- en esdorpenlandschap in Noord-Drenthe richting Haren en Groningen", [[6.625, 52.975], [6.645, 53.035], [6.632, 53.095], [6.605, 53.148]]),
    ("Hunze", 2, ["Drenthe", "Groningen"], "Rivier van de Hondsrug in Oost-Drenthe langs Gasselternijveen en Spijkerboor naar het Zuidlaardermeer", [[6.835, 52.935], [6.815, 53.005], [6.765, 53.075], [6.695, 53.135]]),

    # Tier 3: Overige rivieren
    ("Dordtsche Kil", 3, ["Zuid-Holland"], "Korte maar diepe getijdenrivier tussen de Oude Maas bij Dordrecht en het Hollandsch Diep bij Moerdijk (ca. 9 km)", [[4.635, 51.798], [4.628, 51.758], [4.622, 51.718]]),
    ("Spui", 3, ["Zuid-Holland"], "Getijdenrivier tussen de Oude Maas bij Oud-Beijerland en het Haringvliet (ca. 16 km)", [[4.415, 51.832], [4.355, 51.805], [4.285, 51.785]]),
    ("Amer", 3, ["Noord-Brabant"], "Rivier ten zuiden van de Biesbosch tussen de Bergsche Maas bij Geertruidenberg en het Hollandsch Diep (ca. 12 km)", [[4.862, 51.714], [4.775, 51.715], [4.685, 51.708]]),
    ("Afgedamde Maas", 3, ["Gelderland", "Noord-Brabant"], "Voormalige tak van de Maas tussen Heusden/Well en de Waal bij Woudrichem (ca. 19 km)", [[5.145, 51.745], [5.085, 51.782], [5.019, 51.815]]),
    ("Mark en Dintel", 3, ["Noord-Brabant"], "Rivier van de Belgische grens door Breda, waarna hij via Zevenbergen als Dintel in het Volkerak uitmondt", [[4.785, 51.495], [4.768, 51.588], [4.655, 51.628], [4.525, 51.635], [4.415, 51.648]]),
    ("Niers", 3, ["Limburg"], "Zijrivier van de Maas in Noord-Limburg bij Ottersum en Gennep (ca. 8 km in NL)", [[6.045, 51.705], [5.995, 51.702], [5.962, 51.698]]),
    ("Linde", 3, ["Fryslân", "Overijssel"], "Rivier in het zuiden van Fryslân (Weststellingwerf) via Wolvega naar Kuinre", [[6.125, 52.915], [6.005, 52.862], [5.895, 52.815], [5.835, 52.792]]),
    ("Tjonger (Kuinder)", 3, ["Fryslân"], "Rivier in Zuidoost-Fryslân (De Tsjonger) van Oosterwolde langs Heerenveen naar het Tjeukemeer en Kuinre", [[6.225, 52.982], [6.055, 52.935], [5.915, 52.885], [5.835, 52.852]]),
    ("Reitdiep", 3, ["Groningen"], "Oud kronkelend zeearm- en rivierlandschap van de stad Groningen via Garnwerd en Zoutkamp naar het Lauwersmeer", [[6.545, 53.235], [6.485, 53.305], [6.375, 53.332], [6.295, 53.338]]),
]


def build_rivers():
    print("Stap 4: Samenstellen van Nederlandse hoofd- en regionale rivieren...")
    features = []
    for name, tier, provs, desc, coords in RIVERS_DATA:
        slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        features.append(
            {
                "type": "Feature",
                "id": f"RV_{slug}",
                "properties": {
                    "id": f"RV_{slug}",
                    "code": f"RV_{slug}",
                    "naam": name,
                    "categorie": "rivier",
                    "subcategorie": "rivier",
                    "tier": tier,
                    "provincie": provs[0],
                    "provincies": provs,
                    "details": desc,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coords,
                },
            }
        )
    print(f"  {len(features)} rivieren samengesteld.")
    return features


# ==============================================================================
# 5. KANALEN (Hoofdkanalen, vaarwegen en regionale kanalen)
# ==============================================================================
CANALS_DATA = [
    # Tier 1: Hoofdkanalen
    ("Amsterdam-Rijnkanaal", 1, ["Gelderland", "Noord-Holland", "Utrecht"], "Drukst bevaren kanaal ter wereld tussen het IJ in Amsterdam, Utrecht en de Waal bij Tiel (ca. 72 km)", [[4.955, 52.372], [5.008, 52.318], [5.035, 52.212], [5.068, 52.105], [5.105, 52.042], [5.168, 51.992], [5.335, 51.965], [5.438, 51.888]]),
    ("Noordzeekanaal", 1, ["Noord-Holland"], "Groot zeescheepvaartkanaal van de sluizen bij IJmuiden langs Beverwijk en Zaandam naar de haven van Amsterdam (ca. 21 km)", [[4.565, 52.462], [4.655, 52.458], [4.755, 52.438], [4.845, 52.418], [4.895, 52.392]]),
    ("Noordhollandsch Kanaal", 1, ["Noord-Holland"], "Historisch groot kanaal (1824) van Amsterdam-Noord via Purmerend en Alkmaar naar Den Helder (ca. 80 km)", [[4.915, 52.392], [4.952, 52.505], [4.825, 52.562], [4.745, 52.635], [4.752, 52.775], [4.765, 52.952]]),
    ("Prinses Margrietkanaal", 1, ["Fryslân"], "Belangrijke Friese hoofdvaarweg van het IJsselmeer bij Lemmer via Sneek en Grou naar Burgum en Stroobos (ca. 65 km)", [[5.702, 52.842], [5.685, 52.935], [5.755, 53.025], [5.838, 53.095], [5.995, 53.192], [6.152, 53.225]]),
    ("Van Starkenborghkanaal", 1, ["Groningen"], "Groningse hoofdvaarweg vanaf Stroobos (grens Fryslân) langs Zuidhorn naar de stad Groningen (ca. 27 km)", [[6.152, 53.225], [6.345, 53.245], [6.578, 53.235]]),
    ("Eemskanaal", 1, ["Groningen"], "Zeescheepvaart- en binnenvaartkanaal van de stad Groningen naar de Eemsmonding bij Delfzijl (ca. 26 km)", [[6.588, 53.225], [6.725, 53.275], [6.915, 53.325]]),
    ("Van Harinxmakanaal", 1, ["Fryslân"], "Hoofdvaarweg in Fryslân van Harlingen via Franeker en Leeuwarden naar het Prinses Margrietkanaal (ca. 38 km)", [[5.418, 53.175], [5.542, 53.185], [5.785, 53.188], [5.915, 53.165]]),
    ("Twentekanaal", 1, ["Gelderland", "Overijssel"], "Kanaal van de Gelderse IJssel bij Zutphen via Lochem, Goor, Delden en Hengelo naar Enschede (en zijtak Almelo, ca. 65 km)", [[6.185, 52.155], [6.415, 52.168], [6.585, 52.232], [6.785, 52.255], [6.865, 52.218]]),
    ("Wilhelminakanaal", 1, ["Noord-Brabant"], "Brabants kanaal van de Amer bij Geertruidenberg via Oosterhout, Tilburg en Son naar de Zuid-Willemsvaart bij Beek en Donk (ca. 68 km)", [[4.868, 51.695], [4.945, 51.635], [5.085, 51.575], [5.285, 51.498], [5.495, 51.508], [5.625, 51.535]]),
    ("Zuid-Willemsvaart", 1, ["Limburg", "Noord-Brabant"], "Kanaal van 's-Hertogenbosch via Veghel, Helmond en Weert naar Maastricht (ca. 90 km in NL)", [[5.312, 51.688], [5.535, 51.612], [5.662, 51.478], [5.735, 51.318], [5.695, 51.242]]),
    ("Julianakanaal", 1, ["Limburg"], "Zuid-Limburgs scheepvaartkanaal parallel aan de onbevaarbare Grensmaas van Maastricht via Stein en Born naar Maasbracht (ca. 36 km)", [[5.702, 50.868], [5.758, 50.985], [5.808, 51.045], [5.885, 51.145]]),
    ("Maas-Waalkanaal", 1, ["Gelderland", "Limburg", "Noord-Brabant"], "Drukbevaren verbindingskanaal tussen de Maas bij Heumen en de Waal bij Weurt ten westen van Nijmegen (ca. 13,5 km)", [[5.855, 51.768], [5.835, 51.812], [5.815, 51.852]]),
    ("Schelde-Rijnkanaal", 1, ["Noord-Brabant", "Zeeland"], "Grote binnenvaartverbinding tussen de haven van Antwerpen, het Zoommeer en het Volkerak langs Tholen (ca. 38 km)", [[4.245, 51.385], [4.235, 51.485], [4.225, 51.585], [4.245, 51.655]]),
    ("Kanaal door Zuid-Beveland", 1, ["Zeeland"], "Drukbevaren kanaal dwars door Zuid-Beveland tussen de Westerschelde (Hansweert) en de Oosterschelde (Wemeldinge, ca. 9 km)", [[4.005, 51.448], [4.002, 51.485], [4.002, 51.522]]),
    ("Kanaal Gent-Terneuzen", 1, ["Zeeland"], "Zeescheepvaartkanaal door Zeeuws-Vlaanderen van de Westerschelde bij Terneuzen via Sas van Gent naar België (ca. 15 km in NL)", [[3.825, 51.335], [3.835, 51.275], [3.805, 51.202]]),
    ("Kanaal door Walcheren", 1, ["Zeeland"], "Scheepvaartkanaal van de Westerschelde bij Vlissingen via Middelburg naar het Veerse Meer bij Veere (ca. 13 km)", [[3.595, 51.445], [3.622, 51.498], [3.668, 51.545]]),
    ("Hartelkanaal & Calandkanaal", 1, ["Zuid-Holland"], "Grote scheepvaartkanalen in het Rotterdamse havengebied (Europoort en Botlek) van de Oude Maas naar de Maasvlakte (ca. 24 km)", [[4.085, 51.945], [4.185, 51.895], [4.265, 51.868], [4.325, 51.855]]),

    # Tier 2: Regionale kanalen & vaarten
    ("Lekkanaal", 2, ["Utrecht"], "Kort maar essentieel verbindingskanaal met de Prinses Beatrixsluizen bij Nieuwegein tussen het Amsterdam-Rijnkanaal en de Lek (ca. 4 km)", [[5.105, 52.042], [5.108, 52.005]]),
    ("Merwedekanaal", 2, ["Utrecht", "Zuid-Holland"], "Kanaal uit 1892 van Utrecht via Vianen en Meerkerk naar de Boven-Merwede bij Gorinchem (ca. 35 km)", [[5.095, 52.065], [5.088, 51.992], [5.002, 51.915], [4.975, 51.835]]),
    ("Valleikanaal", 2, ["Gelderland", "Utrecht"], "Afwateringskanaal door de Gelderse Vallei van de Nederrijn bij Rhenen via Veenendaal, Scherpenzeel en Leusden naar de Eem in Amersfoort (ca. 40 km)", [[5.565, 51.962], [5.535, 52.035], [5.475, 52.085], [5.425, 52.125], [5.385, 52.158]]),
    ("Apeldoorns Kanaal", 2, ["Gelderland"], "Historisch kanaal langs de oostflank van de Veluwe van Dieren via Eerbeek en Apeldoorn naar Heerde en Hattem (ca. 52 km)", [[6.105, 52.045], [6.042, 52.135], [5.975, 52.215], [6.035, 52.355], [6.065, 52.475]]),
    ("Rijn-Schiekanaal (De Vliet)", 2, ["Zuid-Holland"], "Oud scheepvaartkanaal van de Oude Rijn bij Leiden via Voorschoten, Leidschendam, Voorburg en Rijswijk naar Delft (ca. 25 km)", [[4.498, 52.148], [4.425, 52.095], [4.355, 52.048], [4.358, 52.005]]),
    ("Ringvaart van de Haarlemmermeerpolder", 2, ["Noord-Holland", "Zuid-Holland"], "Cirkelvormig kanaal (60 km) gegraven in 1840–1845 rondom de drooggemaakte Haarlemmermeerpolder langs Lijnden, Aalsmeer, Kaag en Cruquius", [[4.765, 52.345], [4.735, 52.265], [4.605, 52.195], [4.565, 52.275], [4.645, 52.365], [4.735, 52.385], [4.765, 52.345]]),
    ("Drentsche Hoofdvaart", 2, ["Drenthe"], "Hoofdkanaal door West-Drenthe van Assen via Smilde, Dieverbrug en Havelte naar Meppel (ca. 42 km)", [[6.548, 52.995], [6.435, 52.925], [6.315, 52.835], [6.195, 52.705]]),
    ("Hoogeveense Vaart", 2, ["Drenthe"], "Kanaal door Zuid-Drenthe van Meppel via De Wijk, Zuidwolde en Hoogeveen naar Nieuw-Amsterdam (ca. 55 km)", [[6.195, 52.695], [6.475, 52.722], [6.725, 52.718], [6.915, 52.712]]),
    ("Oranjekanaal", 2, ["Drenthe"], "Drents veenkanaal van de Drentsche Hoofdvaart bij Hoogersmilde via Beilen, Westerbork en Orvelte naar Emmen (ca. 48 km)", [[6.405, 52.902], [6.525, 52.862], [6.695, 52.838], [6.855, 52.785]]),
    ("Winschoterdiep", 2, ["Groningen"], "Groningse scheepvaartweg van de stad Groningen via Hoogezand-Sappemeer, Zuidbroek en Scheemda naar Winschoten (ca. 35 km)", [[6.592, 53.212], [6.755, 53.165], [6.885, 53.172], [7.035, 53.148]]),
    ("Stadskanaal", 2, ["Drenthe", "Groningen"], "Langgerekt veenkoloniaal kanaal langs de grens van Groningen en Drenthe van Bareveld via Stadskanaal en Musselkanaal naar Ter Apel (ca. 32 km)", [[6.865, 53.045], [6.955, 52.988], [7.025, 52.925], [7.065, 52.875]]),
    ("Kanaal Wessem-Nederweert", 2, ["Limburg"], "Scheepvaartkanaal in Midden-Limburg tussen de Maas bij Wessem/Panheel en de Zuid-Willemsvaart bij Nederweert (ca. 17 km)", [[5.865, 51.165], [5.805, 51.225], [5.745, 51.278]]),
    ("Lateraalkanaal Linne-Buggenum", 2, ["Limburg"], "Scheepvaartkanaal in Midden-Limburg dat een bocht en stuwen in de Maas en de Maasplassen bij Roermond afsnijdt (ca. 9 km)", [[5.925, 51.165], [5.952, 51.205], [5.975, 51.235]]),

    # Tier 3: Overige kanalen
    ("Overijssels Kanaal", 3, ["Overijssel"], "Kanaal door Salland van Zwolle via Raalte naar Lemelerveld en van Deventer naar Raalte en Almelo", [[6.095, 52.502], [6.275, 52.388], [6.395, 52.445], [6.555, 52.392]]),
    ("Kanaal Almelo-De Haandrik", 3, ["Overijssel"], "Kanaal in Noordoost-Overijssel van Almelo via Vriezenveen, Vroomshoop en Bergentheim naar de Vecht bij De Haandrik (ca. 33 km)", [[6.635, 52.368], [6.588, 52.455], [6.615, 52.525], [6.665, 52.592]]),
    ("Damsterdiep", 3, ["Groningen"], "Historische trekvaart en kanaal van de stad Groningen via Ten Boer en Loppersum naar Appingedam en Delfzijl (ca. 27 km)", [[6.588, 53.228], [6.715, 53.285], [6.858, 53.322], [6.915, 53.332]]),
    ("Eindhovens Kanaal", 3, ["Noord-Brabant"], "Kanaal van het centrum van Eindhoven via Geldrop en Mierlo naar de Zuid-Willemsvaart bij Helmond (ca. 14 km)", [[5.488, 51.435], [5.565, 51.438], [5.635, 51.448]]),
    ("Beatrixkanaal", 3, ["Noord-Brabant"], "Zijkanaal van het Wilhelminakanaal langs Eindhoven Airport en het westen van Eindhoven (ca. 8 km)", [[5.405, 51.498], [5.402, 51.458], [5.425, 51.432]]),
    ("Markkanaal", 3, ["Noord-Brabant"], "Verbindingskanaal tussen het Wilhelminakanaal bij Oosterhout en de rivier de Mark ten noorden van Breda (ca. 6 km)", [[4.845, 51.648], [4.795, 51.628], [4.765, 51.615]]),
]


def build_canals():
    print("Stap 5: Samenstellen van Nederlandse hoofd- en regionale kanalen...")
    features = []
    for name, tier, provs, desc, coords in CANALS_DATA:
        slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        features.append(
            {
                "type": "Feature",
                "id": f"KN_{slug}",
                "properties": {
                    "id": f"KN_{slug}",
                    "code": f"KN_{slug}",
                    "naam": name,
                    "categorie": "kanaal",
                    "subcategorie": "kanaal",
                    "tier": tier,
                    "provincie": provs[0],
                    "provincies": provs,
                    "details": desc,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coords,
                },
            }
        )
    print(f"  {len(features)} kanalen samengesteld.")
    return features


# ==============================================================================
# 6. BELANGRIJKE GEBOUWEN, MONUMENTEN, MUSEA, STADIONS & WATERWERKEN (PDOK BAG)
# ==============================================================================
BUILDINGS_DATA = [
    # --- TIER 1: Top-iconen (meest bekende gebouwen, monumenten, attracties, stadions & waterwerken) ---
    ("Het Binnenhof", 1, "monument / politiek", "Den Haag", "Zuid-Holland", 4.3133, 52.0796, 110, "Eeuwenoud politiek centrum van Nederland aan de Hofvijver (met de Ridderzaal)"),
    ("Paleis op de Dam", 1, "paleis / monument", "Amsterdam", "Noord-Holland", 4.8914, 52.3732, 95, "Voormalig stadhuis uit de Gouden Eeuw (1655) en Koninklijk Paleis in Amsterdam"),
    ("Rijksmuseum", 1, "museum", "Amsterdam", "Noord-Holland", 4.8852, 52.3600, 120, "Nationaal museum voor kunst en geschiedenis aan het Museumplein, ontworpen door Pierre Cuypers"),
    ("Anne Frank Huis", 1, "museum / monument", "Amsterdam", "Noord-Holland", 4.8840, 52.3752, 70, "Monument en museum aan de Prinsengracht met het Achterhuis waar Anne Frank onderdook"),
    ("Van Gogh Museum", 1, "museum", "Amsterdam", "Noord-Holland", 4.8811, 52.3584, 90, "Wereldberoemd kunstmuseum aan het Museumplein gewijd aan Vincent van Gogh"),
    ("Domtoren", 1, "monument / toren", "Utrecht", "Utrecht", 5.1213, 52.0906, 80, "Hoogste kerktoren van Nederland (112,32 meter, gebouwd 1321–1382) in het hart van Utrecht"),
    ("Paleis Het Loo", 1, "paleis / museum", "Apeldoorn", "Gelderland", 5.9469, 52.2342, 220, "Voormalig koninklijk paleis uit 1686 met symmetrische baroktuinen aan de rand van Apeldoorn"),
    ("Muiderslot", 1, "kasteel", "Muiden", "Noord-Holland", 5.0714, 52.3342, 95, "Middeleeuwse waterburcht (ca. 1285) van Floris V aan de monding van de Vecht"),
    ("Vredespaleis", 1, "monument / gerechtshof", "Den Haag", "Zuid-Holland", 4.2956, 52.0866, 110, "Zetel van het Internationaal Gerechtshof en het Permanent Hof van Arbitrage (geopend 1913)"),
    ("De Efteling", 1, "attractiepark", "Kaatsheuvel", "Noord-Brabant", 5.0497, 51.6500, 450, "Grootste attractiepark van de Benelux, geopend in 1952 met het Sprookjesbos van Anton Pieck"),
    ("Keukenhof", 1, "cultuur / attractie", "Lisse", "Zuid-Holland", 4.5469, 52.2697, 300, "Wereldberoemd bloemenpark in de Duin- en Bollenstreek bij Lisse"),
    ("Euromast", 1, "toren / icoon", "Rotterdam", "Zuid-Holland", 4.4666, 51.9054, 80, "Uitkijktoren van 185 meter hoog in Rotterdam, ontworpen door Huig Maaskant voor de Floriade van 1960"),
    ("Erasmusbrug", 1, "brug / icoon", "Rotterdam", "Zuid-Holland", 4.4867, 51.9090, 180, "Tuibrug ('De Zwaan') over de Nieuwe Maas in Rotterdam, ontworpen door Ben van Berkel (1996)"),
    ("Johan Cruijff ArenA", 1, "stadion", "Amsterdam", "Noord-Holland", 4.9419, 52.3144, 160, "Grootste voetbalstadion van Nederland (thuisbasis van Ajax) in Amsterdam-Zuidoost"),
    ("Stadion Feijenoord (De Kuip)", 1, "stadion", "Rotterdam", "Zuid-Holland", 4.5233, 51.8939, 150, "Historisch voetbalstadion (1937) van Feyenoord in Rotterdam-Zuid"),
    ("Philips Stadion", 1, "stadion", "Eindhoven", "Noord-Brabant", 5.4675, 51.4417, 130, "Voetbalstadion van PSV midden in Eindhoven, opgericht op de plek van het Philipsdorp"),
    ("Evoluon", 1, "modern icoon", "Eindhoven", "Noord-Brabant", 5.4439, 51.4436, 110, "Futuristisch schotelvormig gebouw in Eindhoven, gebouwd in 1966 bij het 75-jarig bestaan van Philips"),
    ("Luchthaven Schiphol", 1, "luchthaven / infra", "Haarlemmermeer", "Noord-Holland", 4.7642, 52.3086, 600, "De grootste internationale luchthaven van Nederland, gelegen in de Haarlemmermeerpolder"),
    ("Oosterscheldekering", 1, "waterwerk", "Vrouwenpolder / Burgh-Haamstede", "Zeeland", 3.6947, 51.6225, 400, "Het grootste en bekendste onderdeel van de Deltawerken (9 km lang, geopend in 1986)"),
    ("Afsluitdijk (Monument)", 1, "waterwerk", "Den Oever / Kornwerderzand", "Noord-Holland", 5.1667, 52.9711, 350, "32 km lange waterkering uit 1932 van Cornelis Lely tussen Noord-Holland en Fryslân"),
    ("Maeslantkering", 1, "waterwerk", "Hoek van Holland", "Zuid-Holland", 4.1653, 51.9553, 250, "Beweegbare stormvloedkering met twee enorme zwaaideuren in de Nieuwe Waterweg (1997)"),
    ("Sint-Janskathedraal", 1, "monument / kerk", "'s-Hertogenbosch", "Noord-Brabant", 5.3081, 51.6881, 95, "Hoogtepunt van de Brabantse gotiek in het centrum van 's-Hertogenbosch"),
    ("Martinitoren", 1, "monument / toren", "Groningen", "Groningen", 6.5681, 53.2194, 75, "'d'Olle Grieze', de 97 meter hoge toren van de Martinikerk aan de Grote Markt in Groningen"),
    ("Kröller-Müller Museum", 1, "museum", "Otterlo", "Gelderland", 5.8169, 52.0956, 150, "Kunstmuseum en beeldentuin midden in het Nationaal Park De Hoge Veluwe"),
    ("Kasteel De Haar", 1, "kasteel", "Haarzuilens (Utrecht)", "Utrecht", 4.9864, 52.1214, 160, "Het grootste kasteel van Nederland, eind 19e eeuw herbouwd door Pierre Cuypers"),

    # --- TIER 2: Bekende monumenten, musea, stadions & grote infrastructuur ---
    ("Slot Loevestein", 2, "kasteel", "Poederoijen", "Gelderland", 5.0175, 51.8178, 120, "Middeleeuws kasteel bij de samenvloeiing van Maas en Waal, bekend van de ontsnapping van Hugo de Groot in een boekenkist (1621)"),
    ("Paleis Noordeinde", 2, "paleis", "Den Haag", "Zuid-Holland", 4.3061, 52.0808, 95, "Het werkpaleis van de Koning in het centrum van Den Haag"),
    ("Paleis Huis ten Bosch", 2, "paleis", "Den Haag", "Zuid-Holland", 4.3450, 52.0933, 130, "Woonpaleis van het koninklijk gezin in het Haagse Bos"),
    ("Paleis Soestdijk", 2, "paleis", "Baarn", "Utrecht", 5.2564, 52.1931, 180, "Voormalig koninklijk paleis van koningin Juliana en prins Bernhard in Baarn"),
    ("Mauritshuis", 2, "museum", "Den Haag", "Zuid-Holland", 4.3144, 52.0804, 75, "Museum naast het Binnenhof met het 'Meisje met de parel' van Johannes Vermeer"),
    ("Onze Lieve Vrouwetoren", 2, "monument / toren", "Amersfoort", "Utrecht", 5.3872, 52.1552, 75, "'Lange Jan' (98 meter), laatgotische toren en kadastraal nulpunt van Nederland in Amersfoort"),
    ("Nieuwe Kerk (Delft)", 2, "monument / kerk", "Delft", "Zuid-Holland", 4.3603, 52.0122, 90, "Gotische kerk aan de Markt in Delft met het praalgraf van Willem van Oranje en de koninklijke grafkelder"),
    ("Sint-Servaasbasiliek", 2, "monument / kerk", "Maastricht", "Limburg", 5.6875, 50.8489, 95, "Romaanse kruisbasiliek aan het Vrijthof in Maastricht, beschouwd als de oudste nog bestaande kerk van Nederland"),
    ("Grote of Sint-Bavokerk", 2, "monument / kerk", "Haarlem", "Noord-Holland", 4.6367, 52.3811, 95, "Laatgotische kruisbasiliek aan de Grote Markt in Haarlem met het beroemde Müller-orgel"),
    ("Koppelpoort", 2, "monument / stadspoort", "Amersfoort", "Utrecht", 5.3842, 52.1594, 75, "Middeleeuwse gecombineerde land- en waterpoort over de Eem in Amersfoort"),
    ("Markthal", 2, "modern icoon", "Rotterdam", "Zuid-Holland", 4.4869, 51.9200, 110, "Boogvormig woon- en winkelgebouw aan de Binnenrotte in Rotterdam (MVRDV, 2014)"),
    ("Kubuswoningen", 2, "modern icoon", "Rotterdam", "Zuid-Holland", 4.4903, 51.9203, 85, "Iconische gekantelde paalwoningen van architect Piet Blom bij Blaak in Rotterdam"),
    ("Van Nellefabriek", 2, "modern icoon / UNESCO", "Rotterdam", "Zuid-Holland", 4.4333, 51.9233, 160, "Meesterwerk van het Nieuwe Bouwen in Rotterdam en UNESCO Werelderfgoed"),
    ("De Zalmhaven", 2, "toren / wolkenkrabber", "Rotterdam", "Zuid-Holland", 4.4792, 51.9086, 85, "Hoogste woontoren van de Benelux (215 meter) in het Scheepvaartkwartier van Rotterdam"),
    ("NEMO Science Museum", 2, "museum / icoon", "Amsterdam", "Noord-Holland", 4.9122, 52.3742, 110, "Kopergroen wetenschapsmuseum bovenop de IJ-tunnel in Amsterdam, ontworpen door Renzo Piano"),
    ("EYE Filmmuseum", 2, "museum / icoon", "Amsterdam", "Noord-Holland", 4.9008, 52.3842, 95, "Opvallend wit filmmuseum aan de noordoever van het IJ in Amsterdam"),
    ("Koninklijk Concertgebouw", 2, "cultuur / monument", "Amsterdam", "Noord-Holland", 4.8792, 52.3564, 95, "Wereldberoemde concertzaal uit 1888 aan het Museumplein in Amsterdam"),
    ("Forum Groningen", 2, "modern icoon / cultuur", "Groningen", "Groningen", 6.5703, 53.2189, 90, "Modern cultuur- en ontmoetingsgebouw achter de Grote Markt in Groningen"),
    ("Groninger Museum", 2, "museum", "Groningen", "Groningen", 6.5658, 53.2125, 95, "Kleurrijk postmodern museumgebouw op drie eilanden in het Verbindingskanaal tegenover Station Groningen"),
    ("Nederlands Openluchtmuseum", 2, "museum", "Arnhem", "Gelderland", 5.9108, 52.0111, 280, "Cultuurhistorisch museumpark in Arnhem met authentieke historische gebouwen uit heel Nederland"),
    ("Koninklijke Burgers' Zoo", 2, "dierenpark / attractie", "Arnhem", "Gelderland", 5.8992, 52.0158, 300, "Dierenpark in Arnhem bekend om zijn grote ecodisplays zoals Bush, Desert en Ocean"),
    ("Diergaarde Blijdorp", 2, "dierenpark / monument", "Rotterdam", "Zuid-Holland", 4.4489, 51.9278, 280, "Rotterdamse dierentuin met rijksmonumenten van architect Sybold van Ravesteyn en het Oceanium"),
    ("ARTIS", 2, "dierenpark / monument", "Amsterdam", "Noord-Holland", 4.9161, 52.3661, 220, "De oudste dierentuin van Nederland (opgericht in 1838) in de Plantagebuurt in Amsterdam"),
    ("Madurodam", 2, "attractie", "Den Haag", "Zuid-Holland", 4.3006, 52.0994, 150, "Miniatuurstad in Den Haag, geopend in 1952 als oorlogsmonument voor George Maduro"),
    ("Walibi Holland", 2, "attractiepark", "Biddinghuizen", "Flevoland", 5.7667, 52.4400, 350, "Attractiepark in Oostelijk Flevoland bij Biddinghuizen, bekend om zijn achtbanen"),
    ("Attractiepark Toverland", 2, "attractiepark", "Sevenum", "Limburg", 5.9856, 51.3969, 300, "Groot themapark in Noord-Limburg bij Sevenum (Horst aan de Maas)"),
    ("Beeld & Geluid", 2, "museum / media", "Hilversum", "Noord-Holland", 5.1731, 52.2356, 95, "Mediamuseum en archief met gekleurde glazen gevel op het Media Park in Hilversum"),
    ("Het Spoorwegmuseum", 2, "museum", "Utrecht", "Utrecht", 5.1311, 52.0878, 120, "Nationaal spoorwegmuseum gevestigd in het historische Maliebaanstation in Utrecht"),
    ("Ir. D.F. Woudagemaal", 2, "waterwerk / UNESCO", "Lemmer", "Fryslân", 5.6789, 52.8458, 95, "Het grootste nog werkende stoomgemaal ter wereld (1920) bij Lemmer, UNESCO Werelderfgoed"),
    ("Zeelandbrug", 2, "brug / infra", "Zierikzee / Colijnsplaat", "Zeeland", 3.8894, 51.6119, 300, "5 km lange verkeersbrug over de Oosterschelde tussen Schouwen-Duiveland en Noord-Beveland"),
    ("Waalbrug", 2, "brug / monument", "Nijmegen", "Gelderland", 5.8706, 51.8519, 160, "Kenmerkende groene boogbrug (1936) over de Waal bij Nijmegen"),
    ("John Frostbrug", 2, "brug / monument", "Arnhem", "Gelderland", 5.9089, 51.9742, 160, "De bekende 'Brug te ver' over de Nederrijn in Arnhem uit de Slag om Arnhem (1944)"),
    ("Gerbrandytoren", 2, "toren / infra", "IJsselstein", "Utrecht", 5.0536, 52.0097, 90, "Hoogste bouwwerk van Nederland (366,8 meter, bekend als de grootste kerstboom ter wereld) bij Lopik/IJsselstein"),
    ("TT Circuit Assen", 2, "stadion / circuit", "Assen", "Drenthe", 6.5242, 52.9583, 400, "'The Cathedral of Speed', internationaal motorsportcircuit ten zuidwesten van Assen"),
    ("Circuit Zandvoort", 2, "stadion / circuit", "Zandvoort", "Noord-Holland", 4.5408, 52.3889, 380, "Formule 1-racecircuit in de duinen ten noorden van Zandvoort"),

    # --- TIER 3: Uitgebreide selectie (kastelen, vestingen, stadions, regionale monumenten & vliegvelden) ---
    ("Kasteel Hoensbroek", 3, "kasteel", "Hoensbroek (Heerlen)", "Limburg", 5.9056, 50.9278, 120, "Een van de grootste en best bewaarde waterburchten van Nederland in Zuid-Limburg"),
    ("Kasteel Doorwerth", 3, "kasteel", "Doorwerth", "Gelderland", 5.7986, 51.9589, 100, "Middeleeuws kasteel in de uiterwaarden van de Nederrijn aan de voet van de Stuwwal"),
    ("Kasteel Radboud", 3, "kasteel", "Medemblik", "Noord-Holland", 5.1131, 52.7736, 85, "Dwangburcht van Floris V aan het IJsselmeer in Medemblik"),
    ("Fraeylemaborg", 3, "kasteel / borg", "Slochteren", "Groningen", 6.7983, 53.2144, 110, "Beroemde Groninger borg op een omgracht landgoed in Slochteren"),
    ("Vesting Bourtange", 3, "vesting / monument", "Bourtange", "Groningen", 7.1917, 53.0067, 250, "Volledig gereconstrueerd stervormig vestingstadje uit 1593 in Westerwolde bij de Duitse grens"),
    ("Pyramide van Austerlitz", 3, "monument", "Woudenberg", "Utrecht", 5.3428, 52.0906, 95, "Met gras beklede piramide uit 1804 op het hoogste punt van de Utrechtse Heuvelrug, gebouwd door Franse soldaten"),
    ("Radio Kootwijk", 3, "monument / icoon", "Radio Kootwijk (Apeldoorn)", "Gelderland", 5.8189, 52.1739, 110, "'De Kathedraal', monumentaal art-deco zendstation uit 1923 van Julius Luthmann midden op de Veluwe"),
    ("Rietveld Schröderhuis", 3, "monument / UNESCO", "Utrecht", "Utrecht", 5.1475, 52.0853, 65, "Architectonisch hoogtepunt van kunstbeweging De Stijl (1924) in Utrecht, UNESCO Werelderfgoed"),
    ("Herinneringscentrum Kamp Westerbork", 3, "monument / museum", "Hooghalen", "Drenthe", 6.6067, 52.9175, 220, "Nationaal herinneringscentrum en monument op het voormalige doorgangskamp in Midden-Drenthe"),
    ("Nationaal Monument Kamp Vught", 3, "monument / museum", "Vught", "Noord-Brabant", 5.2575, 51.6656, 160, "Herinneringscentrum op de locatie van het voormalige concentratiekamp bij Vught"),
    ("Nationaal Militair Museum", 3, "museum", "Soesterberg", "Utrecht", 5.2789, 52.1319, 250, "Groot militair museum op de voormalige Vliegbasis Soesterberg"),
    ("Wildlands Adventure Zoo Emmen", 3, "dierenpark / attractie", "Emmen", "Drenthe", 6.8906, 52.7808, 300, "Thema- en dierenpark in Emmen met de werelden Jungola, Serenga en Nortica"),
    ("De Grolsch Veste", 3, "stadion", "Enschede", "Overijssel", 6.8375, 52.2367, 130, "Voetbalstadion van FC Twente bij station Enschede Kennispark"),
    ("GelreDome", 3, "stadion", "Arnhem", "Gelderland", 5.8931, 51.9631, 140, "Multifunctioneel stadion met schuifdak en uitschuifbaar veld in Arnhem-Zuid"),
    ("Thialf", 3, "stadion / ijsbaan", "Heerenveen", "Fryslân", 5.9431, 52.9389, 140, "Het bekendste overdekte schaatsstadion van Nederland in het zuiden van Heerenveen"),
    ("Euroborg", 3, "stadion", "Groningen", "Groningen", 6.5917, 53.2061, 130, "Voetbalstadion van FC Groningen aan het zuidoosten van de stad Groningen"),
    ("Abe Lenstra Stadion", 3, "stadion", "Heerenveen", "Fryslân", 5.9367, 52.9589, 130, "Voetbalstadion van sc Heerenveen in Fryslân"),
    ("Eindhoven Airport", 3, "luchthaven / infra", "Eindhoven", "Noord-Brabant", 5.3831, 51.4500, 400, "De op één na grootste luchthaven van Nederland, gelegen ten noordwesten van Eindhoven"),
    ("Rotterdam The Hague Airport", 3, "luchthaven / infra", "Rotterdam", "Zuid-Holland", 4.4372, 51.9556, 380, "Regionale luchthaven (voorheen Zestienhoven) ten noorden van Rotterdam"),
    ("Zeesluis IJmuiden", 3, "waterwerk", "IJmuiden", "Noord-Holland", 4.5819, 52.4675, 220, "De grootste zeesluis ter wereld (geopend in 2022) bij de ingang van het Noordzeekanaal"),
]


def fetch_building_feature(entry):
    name, tier, sub, plaats, prov, lon, lat, radius_m, desc = entry
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")

    # Query official PDOK BAG pand polygon around exact coordinates for real building footprints
    geom = None
    if radius_m <= 160:
        d = 0.0007
        bbox = f"{lon - d:.5f},{lat - d:.5f},{lon + d:.5f},{lat + d:.5f}"
        url = f"https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items?f=json&limit=10&bbox={bbox}"
        try:
            bag_data = fetch_json(url, timeout=8)
            feats = bag_data.get("features", [])
            best_g = None
            best_dist = 999.0
            for f in feats:
                g = f.get("geometry")
                if g and g.get("type") in ("Polygon", "MultiPolygon"):
                    gb = get_geometry_bbox(g)
                    cx = (gb[0] + gb[2]) / 2.0
                    cy = (gb[1] + gb[3]) / 2.0
                    dist = math.hypot(cx - lon, cy - lat)
                    if dist < best_dist:
                        best_dist = dist
                        best_g = g
            if best_g:
                geom = best_g
        except Exception:
            pass

    if not geom:
        geom = make_box_polygon(lon, lat, radius_m)

    return {
        "type": "Feature",
        "id": f"GB_{slug}",
        "properties": {
            "id": f"GB_{slug}",
            "code": f"GB_{slug}",
            "naam": name,
            "categorie": "gebouw",
            "subcategorie": sub,
            "tier": tier,
            "plaats": plaats,
            "provincie": prov,
            "provincies": [prov],
            "details": desc,
        },
        "geometry": geom,
    }


def build_buildings():
    print("Stap 6: Ophalen en samenstellen van belangrijke gebouwen, monumenten, musea, stadions & waterwerken...")
    features = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(fetch_building_feature, b) for b in BUILDINGS_DATA]
        for fut in concurrent.futures.as_completed(futures):
            features.append(fut.result())
    features.sort(key=lambda f: (f["properties"]["tier"], f["properties"]["naam"]))
    print(f"  {len(features)} gebouwen/bouwwerken samengesteld.")
    return features


def main():
    highways = fetch_highways()
    nature_areas, n2k_waters = fetch_nature_and_n2k_waters()
    extra_lakes = build_extra_lakes()
    rivers = build_rivers()
    canals = build_canals()
    buildings = build_buildings()

    # Combine all extra features
    all_extra = highways + rivers + canals + n2k_waters + extra_lakes + nature_areas + buildings

    geojson_doc = {
        "type": "FeatureCollection",
        "name": "extra_features_nederland",
        "features": all_extra,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(GEOJSON_OUT, "w", encoding="utf-8") as f:
        json.dump(geojson_doc, f, ensure_ascii=False)

    print("Stap 7: Converteren en optimaliseren naar TopoJSON via mapshaper...")
    cmd = [
        "npx",
        "mapshaper",
        str(GEOJSON_OUT),
        "-simplify",
        "3%",
        "keep-shapes",
        "-o",
        "format=topojson",
        "quantization=100000",
        "id-field=id",
        str(TOPOJSON_OUT),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"Fout bij mapshaper:\n{res.stderr}", file=sys.stderr)
        sys.exit(res.returncode)

    # Remove intermediate unsimplified GeoJSON to keep repository clean
    if GEOJSON_OUT.exists():
        GEOJSON_OUT.unlink()

    topo_kb = TOPOJSON_OUT.stat().st_size / 1024.0
    print(f"\nKlaar! {len(all_extra)} extra GeoFeatures opgeslagen in {TOPOJSON_OUT} ({topo_kb:.1f} KB):")
    by_cat = {}
    for feat in all_extra:
        c = feat["properties"]["categorie"]
        by_cat[c] = by_cat.get(c, 0) + 1
    for c, cnt in by_cat.items():
        print(f"  - {c:15s}: {cnt}")


if __name__ == "__main__":
    main()
