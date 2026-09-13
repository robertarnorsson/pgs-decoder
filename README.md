# pgs-decoder

PGS (Blu-ray `.sup`) subtitle decoder and canvas renderer for the web, with no runtime dependencies.

## About

Browsers can't play PGS subtitles, the image-based subtitles used on Blu-ray discs. The usual workaround is to burn them into the video on a server, which costs a full transcode. This project decodes them in the browser instead and draws them onto a canvas over the video.

I made it for my own hobby projects, where I tinker with video playback in the browser. It is a proof of concept shared in case it's useful to someone else, not a polished or maintained library.

It has been tested in Firefox and Chrome with subtitles from a range of official Blu-rays, from movies to anime, plus the generated test files in this repository.

## How it was made

I wrote the first parts myself like the project setup and the first byte reading. Most of what came after was written with AI assistance with Claude, including the decoder, the renderer, the demo, the optimizations and the tests. I used it to move faster on a hobby project, and because I was curious how far binary parsing and optimization could be pushed for something this small.

For the same reason it isn't published to npm. That would make it easy to install without ever seeing this note.

## Limitations

- Needs `requestVideoFrameCallback`: Chrome and Edge 83+, Safari 15.4+, Firefox 130+.
- Subtitle windows are not used to clip drawing. This only matters for unusual files where an image extends outside its window.
- Compositions larger than 4096 pixels on a side are skipped, and at most two objects are drawn per composition.
- The color matrix is picked from the composition height: BT.601 up to 576 lines, BT.709 above.

## Usage

Build with `pnpm build` and copy `dist/index.js` into your project, for example as `pgs-decoder.js`.

```js
import { PgsRenderer } from "./pgs-decoder.js";

const renderer = new PgsRenderer(document.querySelector("video"));
renderer.load(await fetch("movie.sup").then((response) => response.arrayBuffer()));
```

The renderer overlays a canvas on the video and follows its playback. Call `renderer.destroy()` when the video is removed.

Settings can be passed when creating the renderer and changed at any time:

```js
const renderer = new PgsRenderer(video, { forcedOnly: true, delay: 0.5 });

renderer.configure({ scale: 1.2, opacity: 0.8 });
renderer.settings.scale;
```

| Setting | Default | |
| --- | --- | --- |
| `visible` | `true` | Show or hide subtitles without unloading them |
| `forcedOnly` | `false` | Only show subtitles marked as forced |
| `delay` | `0` | Shift subtitles in seconds, positive is later |
| `scale` | `1` | Subtitle size, growing from the nearest top or bottom edge |
| `opacity` | `1` | Subtitle opacity |
| `colorSpace` | `"auto"` | `"bt709"` or `"bt601"` to override the choice made from the video height |
| `debug` | `false` | Pass decode and paint timings to `onDraw` |

To place the canvas yourself, pass it as `canvas` when creating the renderer.

Decoding works without the DOM too:

```js
import { DisplaySetDecoder, ImageDecoder, Reader } from "./pgs-decoder.js";

const reader = new Reader(bytes);
const displaySets = new DisplaySetDecoder(reader).decode(reader.readSegments());
const images = new ImageDecoder(displaySets[0]).decode();
```

## Development

```bash
pnpm install
pnpm dev
pnpm test
```

The demo has a sample video and subtitles, so it runs without any files of your own.

The debug panel shows timings as precisely as the browser allows. Firefox measures time in whole milliseconds and Chrome in tenths of a millisecond, so a draw shown as `< 1 ms` in Firefox is not slower than one shown as `0.4 ms` in Chrome.

The test files in `tests/fixtures` were made for this project: subtitle text rendered with ffmpeg (libass), packed into PGS and checked against ffmpeg's own PGS decoder. Each file covers one thing, like timing edge cases, two objects on screen, cropping, palette fades or an object split across segments. Every file in `tests/fixtures/malformed` breaks one rule, like a huge composition or a truncated segment, and has to decode safely.

## License

MIT
