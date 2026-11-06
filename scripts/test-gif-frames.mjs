#!/usr/bin/env node
// GIF 拆帧的**真值回归**：手写的 gif-lite.js 必须与 Pillow 解出来的像素逐点一致。
//
// 为什么需要这个测试：`src/gif-lite.js` 里的 LZW 解码、调色板合成、隔行扫描重排、
// disposal 处理都是手写的（仓库没有 sharp/jimp/omggif，机器上也没有 ffmpeg）。
// 「跑起来没报错」完全不能说明解对了 —— 帧数对、尺寸对，颜色全错也是常见失败模式
// （局部调色板、透明索引、disposal=2 恢复背景，任何一处写错都只体现在像素上）。
//
// 真值来自 Pillow（`D:\anaconda3\python.exe`），一次性生成后以指纹形式固化在这里：
// 每帧的 (宽, 高, 不透明像素数, 不透明像素的坐标+RGBA 的 CRC32)。
// 全透明像素的 RGB 是无定义的（各解码器各填各的），所以只对不透明像素取指纹 ——
// 这条规则是实测踩出来的：不排除它时 anim_trans.gif 会报 80% 差异，其实 alpha 完全一致。
//
// 夹具 `scripts/fixtures/gif/*.gif` 是 Pillow 生成的真 GIF，覆盖：
//   anim_rgb      普通多帧
//   anim_trans    带透明索引 + disposal=2
//   anim_interlace 隔行扫描
//   anim_opt      optimize=True（局部调色板 + 帧间最小差量）
//   anim_many     12 帧（超过单次默认上限）
//   single        单帧（必须不被判成动图）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeGif, extractGifFrames, isGifBuffer, isAnimatedBuffer } from '../src/gif-lite.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE_DIR = path.join(root, 'scripts', 'fixtures', 'gif');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass += 1; console.log(`  OK   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `（${detail}）` : ''}`); }
};
const section = (t) => console.log(`\n## ${t}`);

// 用 Pillow 预先算好的真值（见文件头说明）。
const EXPECT = {
  'anim_rgb.gif': [
    [120, 90, 10800, 2034525600],
    [120, 90, 10800, 3304055901],
    [120, 90, 10800, 259293882],
    [120, 90, 10800, 4123376811]
  ],
  'anim_trans.gif': [
    [120, 90, 2166, 555086791],
    [120, 90, 2145, 1393831986],
    [120, 90, 2161, 3204423343]
  ],
  'anim_interlace.gif': [
    [120, 90, 10800, 2034525600],
    [120, 90, 10800, 3304055901],
    [120, 90, 10800, 259293882]
  ],
  'anim_opt.gif': [
    [120, 90, 10800, 2034525600],
    [120, 90, 10800, 3304055901],
    [120, 90, 10800, 259293882],
    [120, 90, 10800, 4123376811],
    [120, 90, 10800, 1923548772]
  ],
  'anim_many.gif': null, // 只查帧数，不查指纹（12 帧太长）
  'single.gif': [[120, 90, 10800, 2034525600]]
};

/** 对一帧 RGBA 取指纹：只统计不透明像素（全透明像素的 RGB 无定义）。 */
function fingerprint(rgba, width, height) {
  let opaque = 0;
  let crc = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const a = rgba[o + 3];
      if (a === 0) continue;
      opaque += 1;
      crc = zlib.crc32(Buffer.from([x & 255, (x >> 8) & 255, y & 255, (y >> 8) & 255, rgba[o], rgba[o + 1], rgba[o + 2], a]), crc);
    }
  }
  return [width, height, opaque, crc >>> 0];
}

section('夹具存在性');
for (const name of Object.keys(EXPECT)) {
  ok(fs.existsSync(path.join(FIXTURE_DIR, name)), `夹具 ${name} 在仓库里（否则这条回归在别人机器上会静默跳过）`);
}

section('逐帧像素与 Pillow 完全一致（真值回归）');
for (const [name, expect] of Object.entries(EXPECT)) {
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) continue;
  const buf = fs.readFileSync(file);
  ok(isGifBuffer(buf), `${name}：签名识别为 GIF`);
  const gif = decodeGif(buf);
  ok(gif.ok === true, `${name}：decodeGif 成功（${gif.note}）`);
  if (!gif.ok) continue;
  if (!expect) {
    ok(gif.frames.length === 12, `${name}：解出 12 帧（实测 ${gif.frames.length}）`);
    continue;
  }
  ok(gif.frames.length === expect.length, `${name}：帧数与 Pillow 一致（实测 ${gif.frames.length} / 期望 ${expect.length}）`);
  let mismatch = -1;
  for (let i = 0; i < Math.min(gif.frames.length, expect.length); i += 1) {
    const f = gif.frames[i];
    const got = fingerprint(f.pixels, gif.width, gif.height);
    const want = expect[i];
    if (got.some((v, k) => v !== want[k])) { mismatch = i; break; }
  }
  if (mismatch === -1) {
    ok(true, `${name}：${expect.length} 帧逐像素与 Pillow 一致（含透明/隔行/局部调色板）`);
  } else {
    const f = gif.frames[mismatch];
    const got = fingerprint(f.pixels, gif.width, gif.height);
    ok(false, `${name}：第 ${mismatch} 帧与 Pillow 不一致`, `实测 ${JSON.stringify(got)} 期望 ${JSON.stringify(expect[mismatch])}`);
  }
}

section('单帧 / 多帧的判定');
{
  const single = fs.readFileSync(path.join(FIXTURE_DIR, 'single.gif'));
  ok(isAnimatedBuffer(single) === false, '单帧 GIF 不算动图（否则每张静图都白拆一遍）');
  const many = fs.readFileSync(path.join(FIXTURE_DIR, 'anim_many.gif'));
  ok(isAnimatedBuffer(many) === true, '12 帧 GIF 判定为动图');
  ok(isAnimatedBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64')) === false,
    '静态 PNG 不算动图');
}

section('抽帧上限与缩放');
{
  const many = fs.readFileSync(path.join(FIXTURE_DIR, 'anim_many.gif'));
  const r = extractGifFrames(many, { count: 3, maxSide: 512 });
  ok(r.ok === true, 'extractGifFrames 成功');
  ok(r.frames.length === 3, `只抽 3 帧（实测 ${r.frames.length}，上限生效）`);
  ok(r.totalFrames === 12, `但仍如实报告总帧数 12（实测 ${r.totalFrames}）`);
  ok(r.frames.every((f) => f.png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'), '抽出的帧都是合法 PNG');

  // 缩放：maxSide 必须真的生效，否则 300px 的 QQ 表情会顶满视觉预算。
  // 注意 maxSide 有 64 的下限（更小的图对视觉模型没有意义），所以这里测下限本身。
  const small = extractGifFrames(many, { count: 1, maxSide: 64 });
  ok(small.ok === true, 'maxSide=64 时仍成功');
  const dims = readPngSize(small.frames[0].png);
  ok(Math.max(dims.width, dims.height) <= 64, `缩放到 64 以内（实测 ${dims.width}×${dims.height}）`);
  ok(dims.width === 64 && dims.height === 48, `长边贴到 64、短边按比例（实测 ${dims.width}×${dims.height}）`);
  const tiny = extractGifFrames(many, { count: 1, maxSide: 1 });
  const tinyDims = readPngSize(tiny.frames[0].png);
  ok(Math.max(tinyDims.width, tinyDims.height) >= 64, `maxSide 有 64 的下限，传 1 也不会缩成糊（实测 ${tinyDims.width}×${tinyDims.height}）`);
  const noScale = extractGifFrames(many, { count: 1, maxSide: 512 });
  const noDims = readPngSize(noScale.frames[0].png);
  ok(noDims.width === 120 && noDims.height === 90, `原图小于上限时不做任何缩放（实测 ${noDims.width}×${noDims.height}）`);

  // 取样策略：动图首帧常常是空白/黑场，count=1 时给中间帧而不是第 0 帧
  const mid = extractGifFrames(many, { count: 1, maxSide: 512 });
  ok(mid.frames[0].index === 5, `count=1 时取中间帧而不是首帧（实测 index=${mid.frames[0].index}，共 12 帧）`);
  const ends = extractGifFrames(many, { count: 4, maxSide: 512 });
  ok(ends.frames[0].index === 0 && ends.frames.at(-1).index === 11, `多帧取样首尾都包含（实测 ${ends.frames.map((f) => f.index).join(',')}）`);
}

function readPngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
