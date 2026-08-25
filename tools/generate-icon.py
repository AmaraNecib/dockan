"""Generate the Dokan app-icon master PNG (1024x1024).

Drawn programmatically so the repo never depends on binary assets: a
rounded-square, deep-teal-to-night gradient tile with a bold white
geometric "D" monogram (closed outline + square counter). `bunx tauri icon`
derives the full icon set (ico/icns/png) from this master.
"""
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
OUT = "apps/desktop/src-tauri/icons/dokan-master.png"


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    top = (13, 110, 138)
    bottom = (4, 24, 46)
    gradient = Image.new("RGBA", (SIZE, SIZE))
    gd = ImageDraw.Draw(gradient)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        gd.line([(0, y), (SIZE, y)], fill=lerp(top, bottom, t) + (255,))

    radius = int(SIZE * 0.22)
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
    img.paste(gradient, (0, 0), mask)

    # soft highlight across the upper half
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [int(SIZE * 0.16), int(SIZE * 0.08), int(SIZE * 0.84), int(SIZE * 0.60)],
        fill=(255, 255, 255, 24),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    img.alpha_composite(glow)

    d = ImageDraw.Draw(img)
    c = (250, 253, 255, 255)
    m = int(SIZE * 0.30)
    top_y = int(SIZE * 0.26)
    base_y = int(SIZE * 0.74)
    bar = int(SIZE * 0.13)

    # D outline: left bar + top bar + bottom bar + right bar
    d.rounded_rectangle([m, top_y, m + bar, base_y], radius=int(bar / 2), fill=c)
    d.rounded_rectangle([m, top_y, SIZE - m, top_y + bar], radius=int(bar / 2), fill=c)
    d.rounded_rectangle([m, base_y - bar, SIZE - m, base_y], radius=int(bar / 2), fill=c)
    d.rounded_rectangle([SIZE - m - bar, top_y, SIZE - m, base_y], radius=int(bar / 2), fill=c)

    # square counter punched in the middle (keeps the D legible at 16px)
    cut = int(SIZE * 0.055) + bar
    inner_m = m + int(SIZE * 0.10)
    d.rounded_rectangle(
        [inner_m, top_y + int(SIZE * 0.10), SIZE - inner_m, base_y - int(SIZE * 0.10)],
        radius=int(SIZE * 0.04),
        fill=(0, 0, 0, 0),
    )

    img.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()