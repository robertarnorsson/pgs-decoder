import { execFileSync } from "node:child_process";
import { basename, dirname, extname, join } from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/make-demo-media.js <input>");
  process.exit(1);
}

const dir = dirname(input);
const name = basename(input, extname(input));
const videoOut = join(dir, `${name}.demo.mp4`);
const subtitleOut = join(dir, `${name}.sup`);

const probe = JSON.parse(
  execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", input], { encoding: "utf8" }),
);

const subtitles = probe.streams.filter((stream) => stream.codec_name === "hdmv_pgs_subtitle");
const subtitle = subtitles.find((stream) => stream.disposition?.default) ?? subtitles[0];

if (!subtitle) {
  throw new Error(`no PGS subtitle stream in ${input}`);
}

execFileSync("ffmpeg", ["-y", "-i", input, "-map", `0:${subtitle.index}`, "-c", "copy", subtitleOut], {
  stdio: "inherit",
});

execFileSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    "scale=-2:480",
    "-c:v",
    "libx264",
    "-crf",
    "30",
    "-preset",
    "veryfast",
    "-g",
    "12",
    "-bf",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    videoOut,
  ],
  { stdio: "inherit" },
);

console.log(videoOut);
console.log(subtitleOut);
