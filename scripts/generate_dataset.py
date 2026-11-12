#!/usr/bin/env python3
"""
Data generatie script voor Topografie Trainer (maps.meijssen.com)
Voegt PDOK BAG Woonplaatsen (polygonen in EPSG:4326) samen met CBS/AlleCijfers inwonersstatistieken
en genereert een geoptimaliseerd TopoJSON bestand via mapshaper.
"""

import gzip
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GEOJSON_OUT = DATA_DIR / "woonplaatsen.geojson"
TOPOJSON_OUT = DATA_DIR / "woonplaatsen.topo.json"
SUMMARY_OUT = DATA_DIR / "dataset_summary.json"


def normalize_text(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"\(l\)", "limburg", s)
    s = re.sub(r"\(nh\)", "noordholland", s)
    s = re.sub(r"\(zh\)", "zuidholland", s)
    s = re.sub(r"\(o\)", "overijssel", s)
    s = re.sub(r"\b(gld|nb|ut|dr|ov|gn|fl|fr|zh|nh|l|z)\b", "", s)
    s = re.sub(r"[^a-z0-9]", "", s)
    return s


def fetch_population_stats():
    print("Stap 1: Ophalen inwonersaantallen uit CBS/AlleCijfers open data...")
    url = "https://allecijfers.nl/woonplaatsen/"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (TopografieTrainer/1.0)"})
    with urllib.request.urlopen(req) as resp:
        html = resp.read().decode("utf-8", errors="ignore")

    pattern = re.compile(
        r"<h5[^>]*class=['\"]mt-1 zoek['\"][^>]*><a[^>]*>(?:Woonplaats\s+)?([^<]+)</a></h5>\s*"
        r"<p[^>]*class=['\"]card-text['\"][^>]*>.*?gemeente\s+([^<]+)</a>.*?"
        r"provincie\s+([^<]+)</a>.*?telt\s+([\d\.]+)\s+adressen\s+en\s+([\d\.]+)\s+inwoners",
        re.DOTALL,
    )
    items = pattern.findall(html)
    print(f"  Gevonden in brontabel: {len(items)} woonplaatsen.")

    stats_lookup = {}
    for raw_name, raw_gem, raw_prov, adr, inw in items:
        m = re.match(r"^(.*?)\s*\((.*?)\)$", raw_name.strip())
        base_name = m.group(1).strip() if m else raw_name.strip()

        entry = {
            "raw_name": raw_name.strip(),
            "base_name": base_name,
            "gemeente": raw_gem.strip(),
            "provincie": raw_prov.strip(),
            "adressen": int(adr.replace(".", "")),
            "inwoners": int(inw.replace(".", "")),
        }

        # Index op meerdere normalisatiesleutels voor maximale dekking
        stats_lookup[(normalize_text(base_name), normalize_text(raw_gem))] = entry
        stats_lookup[(normalize_text(raw_name), normalize_text(raw_gem))] = entry
        stats_lookup[(normalize_text(base_name), normalize_text(raw_prov))] = entry

    # Specifieke bekende synoniemen
    stats_lookup[("sgravenhage", "sgravenhage")] = stats_lookup.get(("denhaag", "denhaag"))
    stats_lookup[("shertogenbosch", "shertogenbosch")] = stats_lookup.get(("denbosch", "denbosch"))
    stats_lookup[("alteveergemhoogeveen", "hoogeveen")] = stats_lookup.get(("alteveer", "hoogeveen"))
    stats_lookup[("spaarndamgemhaarlem", "haarlem")] = stats_lookup.get(("spaarndam", "haarlem"))

    return stats_lookup


def fetch_pdok_features():
    print("Stap 2: Ophalen actuele BAG Woonplaatspolygonen via PDOK OGC API Features...")
    url = "https://api.pdok.nl/kadaster/bag/ogc/v2/collections/woonplaats/items?limit=1000"
    features = []
    page = 0

    while url:
        page += 1
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (TopografieTrainer/1.0)"})
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            page_features = data.get("features", [])
            for f in page_features:
                if f.get("properties", {}).get("status") == "Woonplaats aangewezen":
                    features.append(f)
            print(f"  Pagina {page}: {len(page_features)} features opgehaald (totaal actieve woonplaatsen: {len(features)})")

            next_link = None
            for link in data.get("links", []):
                if link.get("rel") == "next":
                    next_link = link.get("href")
                    break
            url = next_link

    return features


def merge_and_build_geojson(pdok_features, stats_lookup):
    print("Stap 3: Koppelen van polygonen, metadata en inwonersaantallen...")
    merged_features = []
    matched_count = 0
    unmatched_count = 0

    for f in pdok_features:
        props = f.get("properties", {})
        identificatie = str(props.get("identificatie", "")).strip()
        woonplaats_naam = props.get("woonplaats", "").strip()
        gemeente_naam = props.get("bronhouder_naam", "").strip()
        provincie_naam = props.get("provincie_naam", "").strip()
        provincie_afk = props.get("provincie_afkorting", "").strip()

        k1 = (normalize_text(woonplaats_naam), normalize_text(gemeente_naam))
        k2 = (normalize_text(woonplaats_naam), normalize_text(provincie_naam))

        stat_entry = stats_lookup.get(k1) or stats_lookup.get(k2)

        if stat_entry:
            inwoners = stat_entry["inwoners"]
            adressen = stat_entry["adressen"]
            matched_count += 1
        else:
            inwoners = 0
            adressen = 0
            unmatched_count += 1
            print(f"  Waarschuwing: geen directe statistiekmatch voor {woonplaats_naam} ({gemeente_naam}, {provincie_naam}, id={identificatie})")

        cbs_code = f"WP{identificatie.zfill(4)}"

        new_feature = {
            "type": "Feature",
            "id": identificatie,
            "properties": {
                "id": identificatie,
                "code": cbs_code,
                "naam": woonplaats_naam,
                "gemeente": gemeente_naam,
                "provincie": provincie_naam,
                "provincie_code": provincie_afk,
                "inwoners": inwoners,
                "adressen": adressen,
            },
            "geometry": f.get("geometry"),
        }
        merged_features.append(new_feature)

    print(f"  Gekoppeld: {matched_count} woonplaatsen met inwonersdata, {unmatched_count} met default 0.")

    # Sorteer alfabetisch op naam
    merged_features.sort(key=lambda x: x["properties"]["naam"])

    geojson_doc = {
        "type": "FeatureCollection",
        "name": "woonplaatsen_nederland",
        "features": merged_features,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(GEOJSON_OUT, "w", encoding="utf-8") as f:
        json.dump(geojson_doc, f, ensure_ascii=False)

    raw_size_mb = GEOJSON_OUT.stat().st_size / (1024 * 1024)
    print(f"  GeoJSON opgeslagen in {GEOJSON_OUT} ({raw_size_mb:.2f} MB)")
    return geojson_doc


def optimize_topojson():
    print("Stap 4: Genereren van gekwantiseerde en vereenvoudigde TopoJSON via mapshaper...")
    # -simplify 15% keep-shapes: topologie-behoudend vereenvoudigen
    # -quantize 1e5: coördinaten afronden op ~1.1 meter resolutie
    cmd = [
        "npx",
        "mapshaper",
        str(GEOJSON_OUT),
        "-clean",
        "-simplify",
        "2.5%",
        "keep-shapes",
        "-o",
        "format=topojson",
        "quantization=100000",
        "id-field=id",
        str(TOPOJSON_OUT),
    ]
    print(f"  Uitvoeren: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Fout bij mapshaper:\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}", file=sys.stderr)
        sys.exit(result.returncode)

    topo_size_kb = TOPOJSON_OUT.stat().st_size / 1024

    # Maak ook een gzip-versie om compressiegrootte vast te leggen
    topo_gz = DATA_DIR / "woonplaatsen.topo.json.gz"
    with open(TOPOJSON_OUT, "rb") as f_in, gzip.open(topo_gz, "wb", compresslevel=9) as f_out:
        f_out.writelines(f_in)
    topo_gz_size_kb = topo_gz.stat().st_size / 1024

    print(f"  TopoJSON gereed: {topo_size_kb:.1f} KB ongecomprimeerd ({topo_gz_size_kb:.1f} KB gzipped)")
    return topo_size_kb, topo_gz_size_kb


def calculate_and_save_summary(geojson_doc, topo_size_kb, topo_gz_size_kb):
    print("Stap 5: Berekenen van filter-presets en statistieken per provincie...")
    features = geojson_doc["features"]
    total = len(features)

    presets = {
        "p_gt_50000": sum(1 for f in features if f["properties"]["inwoners"] > 50000),
        "p_gt_10000": sum(1 for f in features if f["properties"]["inwoners"] > 10000),
        "p_gt_2500": sum(1 for f in features if f["properties"]["inwoners"] > 2500),
        "p_all": total,
    }

    by_province = {}
    for f in features:
        prov = f["properties"]["provincie"]
        by_province[prov] = by_province.get(prov, 0) + 1

    summary = {
        "total_woonplaatsen": total,
        "presets": {
            "> 50.000 (Grote steden)": presets["p_gt_50000"],
            "> 10.000 (Middelgrote steden - standaard)": presets["p_gt_10000"],
            "> 2.500 (Kernen en dorpen)": presets["p_gt_2500"],
            "> 0 (Alle woonplaatsen)": presets["p_all"],
        },
        "per_provincie": dict(sorted(by_province.items(), key=lambda x: x[0])),
        "bestandsgroottes": {
            "geojson_ongecomprimeerd_mb": round(GEOJSON_OUT.stat().st_size / (1024 * 1024), 2),
            "topojson_ongecomprimeerd_kb": round(topo_size_kb, 1),
            "topojson_gzipped_kb": round(topo_gz_size_kb, 1),
        },
    }

    with open(SUMMARY_OUT, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    print("\n=== DATASET SAMENVATTING ===")
    print(f"Totaal aantal woonplaatsen: {total}")
    print(f"Preset > 50.000 inwoners:   {presets['p_gt_50000']}")
    print(f"Preset > 10.000 inwoners:   {presets['p_gt_10000']} (standaard)")
    print(f"Preset > 2.500 inwoners:    {presets['p_gt_2500']}")
    print(f"Preset > 0 inwoners (alles): {presets['p_all']}")
    print(f"TopoJSON bestandsgrootte:   {topo_size_kb:.1f} KB (gzipped: {topo_gz_size_kb:.1f} KB)")
    print(f"Samenvatting opgeslagen in: {SUMMARY_OUT}")


def main():
    stats_lookup = fetch_population_stats()
    pdok_features = fetch_pdok_features()
    geojson_doc = merge_and_build_geojson(pdok_features, stats_lookup)
    topo_size_kb, topo_gz_size_kb = optimize_topojson()
    calculate_and_save_summary(geojson_doc, topo_size_kb, topo_gz_size_kb)


if __name__ == "__main__":
    main()
