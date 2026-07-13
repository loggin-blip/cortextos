#!/usr/bin/env python3
"""Massivlust dokument- + bilde-søk for agenter.
Søker BÅDE PDF-dokumenter (massivlust-docs) og byggefoto (massivlust-images) i
ChromaDB via bge-m3, cosine. Beriker med prosjekt/kategori/Drive-lenke fra metadata.
Aldri sensitivt (massivlust-sensitive røres ikke).

Bruk:
  python ml_doc_search.py "råte fukt avvik på vegg"
  python ml_doc_search.py "faktura KLH" --type avvik|ks|fremdrift|leveranse|pdf --project "Bortelid" --json -k 8
"""
import sys, json, os, argparse, urllib.request, pathlib

OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/embed")
HOME = pathlib.Path.home()
SOURCES = [
    (os.environ.get("KB_DOCS_PATH",   str(HOME/".mmrag"/"chromadb")),        "massivlust-docs"),
    (os.environ.get("KB_IMAGES_PATH", str(HOME/".mmrag"/"chromadb-images")), "massivlust-images"),
]

def embed(t):
    req = urllib.request.Request(OLLAMA,
        data=json.dumps({"model": "bge-m3", "input": t[:8000]}).encode(),
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["embeddings"][0]

def drive_link(meta, filename):
    if meta.get("link"): return meta["link"]
    did = meta.get("drive_file_id")
    if not did and filename:
        # docs: "<id>___navn.pdf", images: "<id>__navn.img"
        sep = "___" if "___" in filename else "__"
        did = filename.split(sep)[0]
    return f"https://drive.google.com/file/d/{did}/view" if did else None

def main():
    import chromadb
    p = argparse.ArgumentParser()
    p.add_argument("query")
    p.add_argument("-k", "--top-k", type=int, default=8)
    p.add_argument("--type", help="filter: avvik|ks|fremdrift|leveranse|pdf")
    p.add_argument("--project", help="filter på prosjektnavn (delstreng)")
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    emb = embed(a.query)
    hits = []
    for path, coll in SOURCES:
        try:
            col = chromadb.PersistentClient(path=path).get_collection(coll)
            if col.count() == 0: continue
            res = col.query(query_embeddings=[emb], n_results=15,
                            include=["documents", "metadatas", "distances"])
            for d, m, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0]):
                m = m or {}
                cat = m.get("document_type") or m.get("type") or ("pdf" if coll.endswith("docs") else "bilde")
                hits.append({
                    "similarity": round(1 - dist, 4),
                    "kategori": cat,
                    "prosjekt": m.get("project"),
                    "snippet": (d or "").replace("\n", " ").strip()[:240],
                    "lenke": drive_link(m, m.get("filename", "")),
                    "kilde": "foto" if coll.endswith("images") else "dokument",
                })
        except Exception as e:
            print(f"[ml_doc_search] hopper over {coll}: {e}", file=sys.stderr)
    if a.type:
        hits = [h for h in hits if (h["kategori"] or "").lower() == a.type.lower()]
    if a.project:
        hits = [h for h in hits if h["prosjekt"] and a.project.lower() in h["prosjekt"].lower()]
    hits.sort(key=lambda h: h["similarity"], reverse=True)
    hits = hits[:a.top_k]
    if a.json:
        print(json.dumps({"query": a.query, "results": hits}, ensure_ascii=False, indent=2))
        return
    if not hits:
        print("Ingen treff."); return
    print(f"Treff for «{a.query}»:\n")
    for i, h in enumerate(hits, 1):
        proj = f" · {h['prosjekt']}" if h["prosjekt"] else ""
        print(f"{i}. [{h['kilde']}/{h['kategori']}{proj}]  ({h['similarity']:.2f})")
        print(f"   {h['snippet']}")
        if h["lenke"]: print(f"   {h['lenke']}")
        print()

if __name__ == "__main__":
    main()
