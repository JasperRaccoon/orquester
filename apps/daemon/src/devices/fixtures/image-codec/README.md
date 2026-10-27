# PNG color bars for the public image codec

These five authored fixtures were encoded independently with **libpng 1.6.43**. They contain
the same 64×32, 8-bit, non-interlaced RGBA image: four equal vertical bars with RGB values
`[220,30,20]`, `[20,200,40]`, `[30,40,210]`, `[160,160,160]`; every alpha byte is 255.
They contain no captures, external artwork, paths, credentials or provider data.

`filter-N.png` fixes every scanline to PNG filter N (0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth).
Generation used libpng's `png_set_IHDR`, `png_set_filter` with the corresponding single filter
mask, `png_write_image`, and `png_write_end`. Source rows were filled directly from the four
literal colors (`colors[x / 16]`). Compression level is 0 for filter 0, and 9 for the others;
the uncompressed file forces screenshot fitting through JPEG fallback. No application encoder,
decoder or filter reconstruction logic participated in fixture creation. The temporary C
generator and headers are not runtime or test dependencies.

The test reads these bytes through `thumbnailJpeg` and `fitScreenshot`, then decodes the JPEG
artifact with test-only `jpeg-js` 0.4.4. It checks the authored colors at each bar's center, with
8 levels of channel tolerance for JPEG loss. It does not calculate expected colors from another
application codec. Narrower and capped outputs must keep their aspect ratio and reported size.

Sources: [libpng manual, writing PNG files](https://github.com/pnggroup/libpng/blob/v1.6.43/libpng-manual.txt),
[PNG filter specification](https://www.w3.org/TR/PNG-Filters.html),
[jpeg-js 0.4.4 decoding API and bundled types](https://github.com/jpeg-js/jpeg-js/tree/v0.4.4).
`jpeg-js` has no dependencies; it is used only for independent test decoding.

| File | Bytes | SHA-256 |
|---|---:|---|
| filter-0.png | 8304 | `49287ffdf3b317269d837ce6eb17d0cd5446d5651266039d498cd29cc9224fb9` |
| filter-1.png | 148 | `5ff2738a565c8d2d8d4ef6c1b2b734cbd69bb8931739d1ecf5b2aeb9edd282ee` |
| filter-2.png | 140 | `e921bc18f4aaafc80b0fbabf216e5a729bab9ae9e4e002fdab89d8ea52ee22e3` |
| filter-3.png | 191 | `7e0e67aa033d8d41794957a8a34be213ce95e7d74e9ef22c6d911c02ff22e39a` |
| filter-4.png | 147 | `7df92097f72d3afed7c1d6d9aae91b3e5374af9b032d84fcce1acda1c92bce2d` |

The generated files' IDAT streams were inspected once: all 32 scanlines in each file carry
the named filter byte. The suite needs no fixture generator or native library.
