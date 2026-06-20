import ifcopenshell
import ifcopenshell.util.element
import json
import sys
import argparse


def to_float(val):
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    return float(str(val).replace(",", "."))


def parse(ifc_path, project_id):
    f = ifcopenshell.open(ifc_path)
    elementer = []

    for el in f.by_type("IfcBuildingElementPart"):
        psets = ifcopenshell.util.element.get_psets(el)
        klh = psets.get("KLH Elementliste", {})

        if not klh.get("Positionnumber"):
            continue

        pos = klh["Positionnumber"]
        label_prefix = pos[:2].upper() if len(pos) >= 2 else ""
        type_map = {"R-": "tak", "W-": "vegg", "F-": "dekke", "S-": "soyle"}

        elementer.append({
            "project_id": project_id,
            "element_kode": pos,
            "type": type_map.get(label_prefix, "annet"),
            "status": "planlagt",
            "vekt_kg": to_float(klh.get("weight_net")),
            "areal_m2": to_float(klh.get("Netarea")),
            "leverandor": "Massivtre AS",
            "notes": json.dumps({
                "klh": klh,
                "global_id": el.GlobalId,
                "thickness": klh.get("Thickness"),
                "panel_buildup": klh.get("PanelBuildUp"),
            }, ensure_ascii=False),
        })

    for el in f.by_type("IfcBeam"):
        psets = ifcopenshell.util.element.get_psets(el)
        elementer.append({
            "project_id": project_id,
            "element_kode": f"BEAM-{el.GlobalId}",
            "type": "bjelke",
            "status": "planlagt",
            "leverandor": "Massivtre AS",
            "notes": json.dumps({
                "global_id": el.GlobalId,
                "object_type": el.ObjectType,
                "psets": {k: v for k, v in psets.items() if k != "Pset_EnvironmentalImpactIndicators"},
            }, ensure_ascii=False),
        })

    print(json.dumps({"elementer": elementer, "total": len(elementer)}, ensure_ascii=False))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("ifc_path")
    ap.add_argument("--project-id", required=True)
    args = ap.parse_args()
    parse(args.ifc_path, args.project_id)
