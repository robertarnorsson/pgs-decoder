import { CompositionState, PgsRenderer, PTS_PER_SECOND, SegmentType } from "../dist/index.js";

const SEEK_STEP = 5;
const IDLE_DELAY = 2500;
const SUBTITLE_SEEK_OFFSET = 0.05;
const TIMER_SAMPLES = 3;

const segmentNames = {
  [SegmentType.PaletteDefinition]: "PDS",
  [SegmentType.ObjectDefinition]: "ODS",
  [SegmentType.PresentationComposition]: "PCS",
  [SegmentType.WindowDefinition]: "WDS",
  [SegmentType.End]: "END",
};

const stateNames = {
  [CompositionState.Normal]: "Normal",
  [CompositionState.AcquisitionPoint]: "Acquisition point",
  [CompositionState.EpochStart]: "Epoch start",
};

const $ = (selector) => document.querySelector(selector);

const picker = $(".picker");
const player = $(".player");
const video = $("video");
const timeline = $(".timeline");
const hoverTime = $(".timeline-time");
const clock = $(".time");
const volume = $(".volume");
const debug = $(".debug");
const settings = $(".settings");
const fields = {
  time: $("#time"),
  displaySet: $("#display-set"),
  pts: $("#pts"),
  composition: $("#composition"),
  palette: $("#palette"),
  drawTime: $("#draw-time"),
  decodeTime: $("#decode-time"),
  paintTime: $("#paint-time"),
  pixels: $("#pixels"),
  segments: $("#segments"),
  objects: $("#objects"),
};

const timerResolution = measureTimerResolution();
const timerDecimals = String(timerResolution).split(".")[1]?.length ?? 0;

const renderer = new PgsRenderer(video);
let pendingSeek;
let idleTimer = 0;
let timeRequest = 0;

$("#video-file").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  video.src = URL.createObjectURL(file);
  $("#video-name").textContent = file.name;
  showPlayer();
});

$("#subtitle-file").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  try {
    renderer.load(new Uint8Array(await file.arrayBuffer()));
    $("#subtitle-name").textContent = file.name;
    showPlayer();
  } catch (error) {
    $("#subtitle-name").textContent = error.message;
  }
});

$(".sample").addEventListener("click", async () => {
  video.src = "./sample.mp4";
  $("#video-name").textContent = "sample.mp4";
  renderer.load(await fetch("./sample.sup").then((response) => response.arrayBuffer()));
  $("#subtitle-name").textContent = "sample.sup";
  showPlayer();
});

video.addEventListener("click", togglePlay);
video.addEventListener("dblclick", toggleFullscreen);
video.addEventListener("play", updatePlayState);
video.addEventListener("pause", updatePlayState);
video.addEventListener("volumechange", updateVolume);
video.addEventListener("durationchange", () => showTime(video.currentTime));
video.addEventListener("timeupdate", () => {
  if (!player.classList.contains("scrubbing") && !controlsHidden()) {
    showTime(video.currentTime);
  }
});
video.addEventListener("seeked", () => {
  if (pendingSeek !== undefined) {
    video.currentTime = pendingSeek;
    pendingSeek = undefined;
  }
});

$(".play").addEventListener("click", togglePlay);
$(".previous-subtitle").addEventListener("click", () => jumpToSubtitle(-1));
$(".next-subtitle").addEventListener("click", () => jumpToSubtitle(1));
$(".debug-toggle").addEventListener("click", toggleDebug);
$(".settings-toggle").addEventListener("click", () => (settings.hidden = !settings.hidden));
settings.addEventListener("input", ({ target }) => renderer.configure({ [target.name]: settingValue(target) }));
$(".mute").addEventListener("click", toggleMute);
$(".fullscreen").addEventListener("click", toggleFullscreen);

volume.addEventListener("pointerdown", (event) => {
  volume.setPointerCapture(event.pointerId);
  player.classList.add("volume-scrubbing");
  setVolume(levelAt(event));
});

volume.addEventListener("pointermove", (event) => {
  if (player.classList.contains("volume-scrubbing")) {
    setVolume(levelAt(event));
  }
});

volume.addEventListener("lostpointercapture", () => player.classList.remove("volume-scrubbing"));

timeline.addEventListener("pointerdown", (event) => {
  timeline.setPointerCapture(event.pointerId);
  player.classList.add("scrubbing");
  seek(positionAt(event) * video.duration);
});

timeline.addEventListener("pointermove", (event) => {
  const position = positionAt(event);
  timeline.style.setProperty("--hover", position);
  hoverTime.textContent = formatClock(position * (video.duration || 0));

  if (player.classList.contains("scrubbing")) {
    seek(position * video.duration);
  }
});

timeline.addEventListener("lostpointercapture", () => player.classList.remove("scrubbing"));

player.addEventListener("pointermove", wake);
player.addEventListener("pointerleave", () => player.classList.add("idle"));
document.addEventListener("keydown", handleKey);

renderer.onDraw = (displaySet, stats) => {
  if (stats) {
    showDisplaySet(displaySet);
    showStats(stats);
  }
};

syncDebug();

function showPlayer() {
  if (video.src && renderer.displaySets.length) {
    picker.hidden = true;
    player.hidden = false;
  }
}

function togglePlay() {
  if (video.paused) {
    video.play();
  } else {
    video.pause();
  }
}

function toggleMute() {
  video.muted = !video.muted;

  if (!video.muted && video.volume === 0) {
    video.volume = 1;
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    player.requestFullscreen();
  }
}

function seek(seconds) {
  if (!video.duration) {
    return;
  }

  const target = Math.min(Math.max(seconds, 0), video.duration);
  showTime(target);

  if (video.seeking) {
    pendingSeek = target;
  } else {
    video.currentTime = target;
  }
}

function jumpToSubtitle(direction) {
  const { displaySets } = renderer;
  const current = displaySets.indexOf(renderer.displaySetAt(video.currentTime));
  const target =
    direction > 0
      ? displaySets.find((displaySet, index) => index > current && displaySet.objects.length > 0)
      : displaySets.findLast((displaySet, index) => index < current && displaySet.objects.length > 0);

  if (target) {
    seek(target.pts / PTS_PER_SECOND + renderer.settings.delay + SUBTITLE_SEEK_OFFSET);
  }
}

function showTime(seconds) {
  const duration = video.duration || 0;
  timeline.style.setProperty("--progress", duration ? seconds / duration : 0);
  clock.textContent = `${formatClock(seconds)} / ${formatClock(duration)}`;
}

function showDisplaySet(displaySet) {
  const { displaySets } = renderer;
  const composition = displaySet?.composition;

  fields.displaySet.textContent = `${displaySet ? displaySets.indexOf(displaySet) + 1 : "-"} / ${displaySets.length}`;
  fields.pts.textContent = displaySet ? `${formatTime(displaySet.pts / PTS_PER_SECOND)}  ${displaySet.pts}` : "-";
  fields.composition.textContent = composition
    ? `#${composition.compositionNumber} ${stateNames[composition.compositionState]}`
    : "-";
  fields.palette.textContent = composition ? `#${composition.paletteId}${composition.paletteUpdate ? " update" : ""}` : "-";

  fields.segments.replaceChildren(
    ...(displaySet?.segments ?? []).map((segment) =>
      row(segmentNames[segment.segmentType], `0x${segment.startOffset.toString(16).padStart(8, "0")}`, `${segment.segmentLength} B`),
    ),
  );

  fields.objects.replaceChildren(
    ...(displaySet?.objects ?? []).map((object) =>
      row(`#${object.objectId}`, `${object.x}, ${object.y}`, `${object.forced ? "forced " : ""}${object.width}x${object.height}`),
    ),
  );
}

function updatePlayState() {
  player.classList.toggle("paused", video.paused);
  wake();
}

function updateVolume() {
  const muted = video.muted || video.volume === 0;
  player.classList.toggle("muted", muted);
  volume.style.setProperty("--level", muted ? 0 : Math.cbrt(video.volume));
}

function setVolume(level) {
  video.volume = level ** 3;
  video.muted = level === 0;
}

function toggleDebug() {
  debug.hidden = !debug.hidden;
  syncDebug();
}

function syncDebug() {
  video.cancelVideoFrameCallback(timeRequest);
  renderer.configure({ debug: !debug.hidden });

  if (!debug.hidden) {
    showMediaTime(video.currentTime);
    watchTime();
  }
}

function watchTime() {
  timeRequest = video.requestVideoFrameCallback((_, { mediaTime }) => {
    showMediaTime(mediaTime);
    watchTime();
  });
}

function showMediaTime(seconds) {
  fields.time.textContent = `${formatTime(seconds)}  ${Math.round(seconds * PTS_PER_SECOND)}`;
}

function showStats(stats) {
  fields.drawTime.textContent = formatDuration(stats.totalTime);
  fields.decodeTime.textContent = formatDuration(stats.decodeTime);
  fields.paintTime.textContent = formatDuration(stats.paintTime);
  fields.pixels.textContent = stats.pixels.toLocaleString();
}

function settingValue(input) {
  if (input.type === "checkbox") {
    return input.checked;
  }

  if (input instanceof HTMLSelectElement) {
    return input.value;
  }

  return input.valueAsNumber || 0;
}

function positionAt(event) {
  const { left, width } = timeline.getBoundingClientRect();
  return Math.min(Math.max((event.clientX - left) / width, 0), 1);
}

function levelAt(event) {
  const { left, width } = volume.getBoundingClientRect();
  return Math.min(Math.max((event.clientX - left) / width, 0), 1);
}

function wake() {
  if (player.classList.contains("idle")) {
    player.classList.remove("idle");
    showTime(video.currentTime);
  }

  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => player.classList.add("idle"), IDLE_DELAY);
}

function controlsHidden() {
  return player.classList.contains("idle") && !video.paused;
}

function handleKey(event) {
  const { target } = event;
  if (
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLButtonElement && event.code === "Space")
  ) {
    return;
  }

  switch (event.code) {
    case "Space":
    case "KeyK":
      togglePlay();
      break;
    case "ArrowLeft":
      event.shiftKey ? jumpToSubtitle(-1) : seek(video.currentTime - SEEK_STEP);
      break;
    case "ArrowRight":
      event.shiftKey ? jumpToSubtitle(1) : seek(video.currentTime + SEEK_STEP);
      break;
    case "KeyF":
      toggleFullscreen();
      break;
    case "KeyM":
      toggleMute();
      break;
    default:
      return;
  }

  event.preventDefault();
  wake();
}

function row(...cells) {
  const item = document.createElement("li");
  for (const cell of cells) {
    item.append(Object.assign(document.createElement("span"), { textContent: cell }));
  }
  return item;
}

function measureTimerResolution() {
  let resolution = 1;
  let previous = performance.now();

  for (let ticks = 0; ticks < TIMER_SAMPLES; ) {
    const now = performance.now();
    if (now !== previous) {
      resolution = Math.min(resolution, now - previous);
      previous = now;
      ticks++;
    }
  }

  return Math.max(Number(resolution.toFixed(3)), 0.001);
}

function formatDuration(ms) {
  return ms === 0 ? `< ${timerResolution} ms` : `${ms.toFixed(timerDecimals)} ms`;
}

function formatClock(seconds) {
  const time = new Date(seconds * 1000).toISOString();
  return seconds >= 3600 ? time.slice(11, 19) : time.slice(14, 19);
}

function formatTime(seconds) {
  return new Date(seconds * 1000).toISOString().slice(11, 23);
}
