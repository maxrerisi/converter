// Burns a bouncing "Sora-style" watermark into images and videos.
const fs = require('fs');
const path = require('path');
const { exec } = require('./converters');

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif'];
const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'gif', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts'];

// Corner order the mark cycles through: top-left, top-right, bottom-right, bottom-left.
const CORNERS = ['tl', 'tr', 'br', 'bl'];
const GRAVITY = { tl: 'NorthWest', tr: 'NorthEast', br: 'SouthEast', bl: 'SouthWest' };

const clamp = (n, lo, hi, dflt) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, +n)) : dflt);

function options(raw = {}) {
  return {
    bounce: raw.bounce !== 'false' && raw.bounce !== false,
    corner: CORNERS.includes(raw.corner) ? raw.corner : 'br',
    interval: clamp(raw.interval, 0.2, 30, 1.5),
    scale: clamp(raw.scale, 0.01, 0.5, 0.1),
    opacity: clamp(raw.opacity, 0.05, 1, 0.85),
    margin: clamp(raw.margin, 0, 0.3, 0.04),
  };
}

// The bundled SVG mark, rasterized once per run.
async function defaultLogo(cacheDir) {
  const png = path.join(cacheDir, 'sora-mark.png');
  if (!fs.existsSync(png)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    await exec('magick', ['-background', 'none', path.join(__dirname, 'public', 'sora-mark.svg'), '-resize', '1024x1024', png]);
  }
  return png;
}

async function imageWatermark(input, out, logo, o) {
  const [w, h] = (await exec('magick', ['identify', '-format', '%w %h', `${input}[0]`])).trim().split(' ').map(Number);
  const side = Math.min(w, h);
  const logoW = Math.max(16, Math.round(w * o.scale));
  const margin = Math.round(side * o.margin);
  await exec('magick', [
    `${input}[0]`, '-auto-orient',
    '(', logo, '-resize', `${logoW}x`, '-alpha', 'set', '-channel', 'A', '-evaluate', 'multiply', String(o.opacity), '+channel', ')',
    '-gravity', GRAVITY[o.corner], '-geometry', `+${margin}+${margin}`, '-composite',
    out,
  ]);
  return out;
}

// Overlay x/y expressions. In bounce mode the corner index changes every `interval` seconds.
function placement(o) {
  const m = `W*${o.margin}`;
  const left = m;
  const right = `W-w-${m}`;
  const top = m;
  const bottom = `H-h-${m}`;
  if (!o.bounce) {
    const corner = o.corner;
    return { x: corner[1] === 'l' ? left : right, y: corner[0] === 't' ? top : bottom };
  }
  const k = `mod(floor(t/${o.interval}),4)`;
  // 0: top-left, 1: top-right, 2: bottom-right, 3: bottom-left
  return {
    x: `if(lt(${k},1),${left},if(lt(${k},3),${right},${left}))`,
    y: `if(lt(${k},2),${top},${bottom})`,
  };
}

function videoCodecs(ext) {
  if (ext === 'webm') return ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-c:a', 'libopus'];
  const args = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'];
  if (['mp4', 'mov', 'm4v'].includes(ext)) args.push('-movflags', '+faststart');
  return args;
}

async function videoWatermark(input, out, logo, o, ext) {
  const { x, y } = placement(o);
  const chain = [
    `[1:v][0:v]scale2ref=w='main_w*${o.scale}':h='main_w*${o.scale}*ih/iw'[lg][vid]`,
    `[lg]format=rgba,colorchannelmixer=aa=${o.opacity}[mark]`,
    `[vid][mark]overlay=x='${x}':y='${y}':shortest=0${ext === 'gif' ? '[ov];[ov]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer' : ''}`,
  ].join(';');
  const codecs = ext === 'gif' ? ['-loop', '0'] : videoCodecs(ext);
  await exec('ffmpeg', ['-y', '-v', 'error', '-i', input, '-i', logo, '-filter_complex', chain, ...codecs, out]);
  return out;
}

async function applyWatermark(input, outDir, ext, raw, logo) {
  const o = options(raw);
  const out = path.join(outDir, `out.${ext}`);
  if (IMAGE_EXTS.includes(ext)) return imageWatermark(input, out, logo, o);
  if (VIDEO_EXTS.includes(ext)) return videoWatermark(input, out, logo, o, ext);
  throw new Error(`Can't watermark .${ext} — images and videos only`);
}

module.exports = { applyWatermark, defaultLogo, IMAGE_EXTS, VIDEO_EXTS };
