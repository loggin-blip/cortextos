import sys, json, os, urllib.request, pathlib, chromadb, argparse

def embed(t):
    req=urllib.request.Request("http://localhost:11434/api/embed",
        data=json.dumps({"model":"bge-m3","input":t[:8000]}).encode(),
        headers={"content-type":"application/json"})
    with urllib.request.urlopen(req,timeout=120) as r: return json.loads(r.read())["embeddings"][0]

p = argparse.ArgumentParser()
p.add_argument('question')
p.add_argument('--db-path', default=str(pathlib.Path.home()/".mmrag"/"chromadb"))
p.add_argument('--collection', default='massivlust-docs')
p.add_argument('--n-results', type=int, default=15)
p.add_argument('--where-project', default=None)   # filtrer bilde-spor på prosjekt (exact)
p.add_argument('--where-type', default=None)      # avvik|ks|fremdrift|leveranse|pdf
args = p.parse_args()

emb=embed(args.question)
PHOTO_CATS={"avvik","ks","fremdrift","leveranse"}

def query(db_path, collection, n, where=None):
    out=[]
    try:
        col=chromadb.PersistentClient(path=db_path).get_collection(collection)
        if col.count()==0: return out
        kw=dict(query_embeddings=[emb], n_results=n, include=["documents","metadatas","distances"])
        if where: kw["where"]=where
        res=col.query(**kw)
        for d,m,dist in zip(res["documents"][0],res["metadatas"][0],res["distances"][0]):
            m=m or {}
            out.append({"filename":m.get("filename",""),"content":d or "",
                        "similarity":round(1-dist,4),"type":m.get("type","text"),
                        "project":m.get("project"),"document_type":m.get("document_type"),
                        "collection":collection})
    except Exception as e:
        print(f"[local_query] skip {collection}@{db_path}: {e}", file=sys.stderr)
    return out

# ── Dokument-spor (docs/sensitive). Docs-metadata har ikke project/document_type
#    → kan ikke chroma-filtreres. 'pdf'-intensjon = bare dokumenter (hopp bilder).
out = query(args.db_path, args.collection, args.n_results)

# ── Bilde-spor (SEPARAT path, single-writer). Filtrer på planleggerens project/type.
img_path = os.environ.get("KB_IMAGES_PATH", str(pathlib.Path.home()/".mmrag"/"chromadb-images"))
img_coll = os.environ.get("KB_IMAGES_COLLECTION", "massivlust-images")
skip_images = (args.where_type == "pdf")   # rent dokument-søk → ingen bilder
if not skip_images:
    conds=[]
    if args.where_type and args.where_type in PHOTO_CATS: conds.append({"document_type": args.where_type})
    if args.where_project: conds.append({"project": args.where_project})
    where = conds[0] if len(conds)==1 else ({"$and":conds} if conds else None)
    out += query(img_path, img_coll, args.n_results, where=where)

# Ikke global topp-n-kutt: returner BEGGE spor (≤2n) så filtrerte bilde-treff med
# moderat similarity ikke drukner i dokument-floden. search.js rangerer + slicer.
out.sort(key=lambda r: r["similarity"], reverse=True)
print(json.dumps({"results": out[:args.n_results * 2]}))
