"""Generate original, dependency-free PNG icons. Run: python3 scripts/icons.py."""
import math
import struct
import zlib
from pathlib import Path


def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))


def segment_distance(x, y, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((x-a[0])*dx + (y-a[1])*dy)/(dx*dx+dy*dy)))
    return math.hypot(x-a[0]-t*dx, y-a[1]-t*dy)


points = [(57, 45), (101, 45), (123, 50), (135, 65), (133, 80), (124, 99), (71, 147)]
segments = list(zip(points, points[1:])) + [((57, 90), (101, 45)), ((57, 140), (133, 74))]
for size in (192, 512):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            px, py = (x+.5)*192/size, (y+.5)*192/size
            d = min(segment_distance(px, py, a, b) for a, b in segments)
            mix = max(0, min(1, (8-d)*size/192))
            raw.extend(round(a*(1-mix)+b*mix) for a,b in zip((138,38,59),(252,250,247)))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size,size,8,2,0,0,0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    (Path(__file__).resolve().parent.parent/'public'/f'icon-{size}.png').write_bytes(png)
