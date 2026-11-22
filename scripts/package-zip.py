"""Zips release/ALON Studio with UTF-8 file names (Explorer shows Hebrew names correctly) and writes its SHA-256.
   python scripts/package-zip.py release     (run after npm run release and npm run release:docs)"""
import hashlib
import os
import sys
import zipfile

rel = sys.argv[1]  # ...\release
src = os.path.join(rel, "ALON Studio")
out = os.path.join(rel, "ALON-Studio-Windows.zip")
tmp = out + ".part"
with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(root, f)
            arc = os.path.relpath(full, rel).replace(os.sep, "/")
            z.write(full, arc)
os.replace(tmp, out)
h = hashlib.sha256()
with open(out, "rb") as fh:
    for chunk in iter(lambda: fh.read(1 << 22), b""):
        h.update(chunk)
with open(out + ".sha256", "w", encoding="ascii", newline="\r\n") as fh:
    fh.write("%s  ALON-Studio-Windows.zip\n" % h.hexdigest())
z = zipfile.ZipFile(out)
bad = [i.filename for i in z.infolist() if not i.filename.isascii() and not (i.flag_bits & 0x800)]
print("entries", len(z.infolist()), "| non-ASCII names without UTF-8 flag:", len(bad), "| MB", round(os.path.getsize(out) / 1e6))
print(h.hexdigest())
