import { DisplaySetDecoder, type DisplaySet } from "./decoder.ts";
import { ImageDecoder, type ColorSpace, type SubtitleImage } from "./image.ts";
import { PTS_PER_SECOND, Reader, type PresentationComposition } from "./reader.ts";

export interface DrawStats {
  decodeTime: number;
  paintTime: number;
  totalTime: number;
  pixels: number;
}

export interface RendererSettings {
  visible: boolean;
  forcedOnly: boolean;
  delay: number;
  scale: number;
  opacity: number;
  colorSpace: ColorSpace;
  debug: boolean;
}

export interface RendererOptions extends Partial<RendererSettings> {
  canvas?: HTMLCanvasElement;
}

const DEFAULT_SETTINGS: RendererSettings = {
  visible: true,
  forcedOnly: false,
  delay: 0,
  scale: 1,
  opacity: 1,
  colorSpace: "auto",
  debug: false,
};

export class PgsRenderer {
  displaySets: DisplaySet[] = [];
  onDraw?: (displaySet: DisplaySet | undefined, stats?: DrawStats) => void;
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private scratch?: CanvasRenderingContext2D;
  private ownsCanvas: boolean;
  private config: RendererSettings = { ...DEFAULT_SETTINGS };
  private resizeObserver?: ResizeObserver;
  private current?: DisplaySet;
  private frameRequest = 0;

  constructor(video: HTMLVideoElement, { canvas, ...settings }: RendererOptions = {}) {
    this.video = video;
    this.ownsCanvas = !canvas;
    this.canvas = canvas ?? this.createOverlay();
    this.context = this.canvas.getContext("2d")!;
    this.configure(settings);
    this.requestFrame();
  }

  get settings(): Readonly<RendererSettings> {
    return this.config;
  }

  configure(settings: Partial<RendererSettings>) {
    Object.assign(this.config, settings);
    this.canvas.style.opacity = this.config.opacity === 1 ? "" : String(this.config.opacity);
    this.draw(this.displaySetAt(this.video.currentTime));
  }

  load(data: ArrayBuffer | Uint8Array) {
    const reader = new Reader(data);
    if (!reader.isValidPGS()) {
      throw new Error("Not a PGS subtitle file");
    }

    this.displaySets = new DisplaySetDecoder(reader).decode(reader.readSegments()).sort((a, b) => a.pts - b.pts);
    this.draw(this.displaySetAt(this.video.currentTime));
  }

  displaySetAt(time: number): DisplaySet | undefined {
    const { displaySets } = this;
    const pts = Math.round((time - this.config.delay) * PTS_PER_SECOND);
    let low = 0;
    let high = displaySets.length;

    while (low < high) {
      const middle = (low + high) >>> 1;

      if (displaySets[middle]!.pts <= pts) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    return displaySets[low - 1];
  }

  destroy() {
    this.video.cancelVideoFrameCallback(this.frameRequest);
    this.resizeObserver?.disconnect();

    if (this.ownsCanvas) {
      this.canvas.remove();
    } else {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.canvas.style.opacity = "";
    }
  }

  private createOverlay(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");

    Object.assign(canvas.style, {
      position: "absolute",
      pointerEvents: "none",
      objectFit: "contain",
    });
    this.video.after(canvas);

    this.resizeObserver = new ResizeObserver(() => this.fitToVideo());
    this.resizeObserver.observe(this.video);

    return canvas;
  }

  private requestFrame() {
    this.frameRequest = this.video.requestVideoFrameCallback((_, { mediaTime }) => {
      this.requestFrame();

      const displaySet = this.displaySetAt(mediaTime);
      if (displaySet !== this.current) {
        this.draw(displaySet);
      }
    });
  }

  private draw(displaySet: DisplaySet | undefined) {
    this.current = displaySet;

    if (this.config.debug) {
      this.drawWithStats(displaySet);
    } else {
      this.paint(displaySet, this.decode(displaySet));
      this.onDraw?.(displaySet);
    }
  }

  private drawWithStats(displaySet: DisplaySet | undefined) {
    const started = performance.now();
    const images = this.decode(displaySet);
    const decoded = performance.now();
    this.paint(displaySet, images);
    const painted = performance.now();

    this.onDraw?.(displaySet, {
      decodeTime: decoded - started,
      paintTime: painted - decoded,
      totalTime: painted - started,
      pixels: images.reduce((total, image) => total + image.width * image.height, 0),
    });
  }

  private decode(displaySet: DisplaySet | undefined): SubtitleImage[] {
    const { visible, forcedOnly, colorSpace } = this.config;
    if (!displaySet || !visible) {
      return [];
    }

    const objects = forcedOnly ? displaySet.objects.filter(({ forced }) => forced) : displaySet.objects;
    return new ImageDecoder({ ...displaySet, objects }, colorSpace).decode();
  }

  private paint(displaySet: DisplaySet | undefined, images: SubtitleImage[]) {
    if (displaySet) {
      this.resizeCanvas(displaySet.composition);
    }

    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const image of images) {
      const imageData = new ImageData(image.pixels, image.width, image.height);

      if (this.config.scale === 1) {
        this.context.putImageData(imageData, image.x, image.y);
      } else {
        this.paintScaled(image, imageData);
      }
    }
  }

  private paintScaled(image: SubtitleImage, imageData: ImageData) {
    const { scale } = this.config;
    const scratch = (this.scratch ??= document.createElement("canvas").getContext("2d")!);
    scratch.canvas.width = image.width;
    scratch.canvas.height = image.height;
    scratch.putImageData(imageData, 0, 0);

    const width = image.width * scale;
    const height = image.height * scale;
    const nearTop = image.y + image.height / 2 < this.canvas.height / 2;

    this.context.drawImage(
      scratch.canvas,
      image.x + (image.width - width) / 2,
      nearTop ? image.y : image.y + image.height - height,
      width,
      height,
    );
  }

  private resizeCanvas(composition: PresentationComposition) {
    if (this.canvas.width === composition.width && this.canvas.height === composition.height) {
      return;
    }

    this.canvas.width = composition.width;
    this.canvas.height = composition.height;
  }

  private fitToVideo() {
    const { offsetLeft, offsetTop, offsetWidth, offsetHeight } = this.video;

    Object.assign(this.canvas.style, {
      left: `${offsetLeft}px`,
      top: `${offsetTop}px`,
      width: `${offsetWidth}px`,
      height: `${offsetHeight}px`,
    });
  }
}
