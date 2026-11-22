"""Packs PNG files (one per size) into a Windows .ico (PNG-compressed entries, Vista and later).
   python -I scripts/installer/make-icon.py out.ico 16.png 32.png 48.png 256.png"""
import struct
import sys

out, pngs = sys.argv[1], sys.argv[2:]
blobs = [open(p, "rb").read() for p in pngs]
head = struct.pack("<HHH", 0, 1, len(blobs))
offset = 6 + 16 * len(blobs)
entries = b""
for b in blobs:
    w, h = struct.unpack(">II", b[16:24])  # PNG IHDR width/height
    entries += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(b), offset)
    offset += len(b)
with open(out, "wb") as f:
    f.write(head + entries + b"".join(blobs))
print(out, [struct.unpack(">II", b[16:24]) for b in blobs])
