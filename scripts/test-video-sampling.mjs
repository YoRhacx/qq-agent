// 「看视频」的采样与联系表回归。
//
// 为什么需要这个脚本（主人 2026-10-12 问「能不能从头看到尾」）：
// 旧实现是 `duration * (i+1) / (n+1)` —— 4 帧只看到 20%/40%/60%/80%，
// **片头和片尾永远采不到**，而「开头讲了什么」「结尾什么结果」恰恰是最该看的。
// 同时旧实现逐张返回图片，每张都算一份图像成本，所以帧数被压到 4~6，
// 想多看几眼就得烧额度。现在改成「端点包含 + 拼一张联系表」，
// 于是 15~24 个时间点只占**一份**图像成本。
//
// 漏了会怎样：采样点悄悄退回旧公式（片头片尾看不到）不会报任何错，
// 只会让鲸鱼娘说「这个视频讲了…」时缺头少尾；联系表拼接参数写错
// （tile= 的列行数、concat 清单）也只会让画面变成一片乱格或黑图。
// 这两类都是「跑起来不报错、结果悄悄变差」，必须靠断言钉住。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FRAMES,
  MAX_FRAMES,
  findFfmpeg,
  formatClock,
  formatDuration,
  parseVideoId,
  sampleTimes,
  sheetGrid,
} from '../src/video-watch.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✔ ${name}`); }
  else { fail += 1; console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── 1. 采样时间点：端点必须包含 ────────────────────────────────────────────
section('1. sampleTimes：首尾都要采到（这是「从头看到尾」的核心）');
{
  const t = sampleTimes(600, 4);
  ok(t[0] === 0, '4 帧的第 1 个时间点是 0（片头）', `got ${t[0]}`);
  ok(t[t.length - 1] === 600, '4 帧的最后一个时间点是全长（片尾）', `got ${t[t.length - 1]}`);
  ok(t.length === 4, '4 帧就是 4 个时间点', `got ${t.length}`);
  ok(t.every((v, i) => i === 0 || v > t[i - 1]), '时间点严格升序', JSON.stringify(t));

  // 旧公式的反例：第 i 个点是 duration*(i+1)/(n+1)，永远不碰 0 和 duration
  const oldFormula = (dur, n, i) => Math.max(1, Math.floor((dur * (i + 1)) / (n + 1)));
  ok(oldFormula(600, 4, 0) === 120 && oldFormula(600, 4, 3) === 480,
    '（反证）旧公式 4 帧只覆盖 120s~480s，片头 120s 与片尾 120s 全丢');

  ok(sampleTimes(600, 2)[0] === 0 && sampleTimes(600, 2)[1] === 600, '2 帧 = 首 + 尾');
  ok(sampleTimes(600, 1)[0] === 300, '1 帧取正中间（不是第 0 秒：开场常是黑屏/logo）');
  // 时长 0 是异常输入（正常视频不会出现）：只要求不崩、不给负数、不去重后丢光。
  // 注意 total 会被 Math.max(1, …) 抬到 1，所以采样点落在 0~1 秒之间是预期行为。
  const t0 = sampleTimes(0, 4);
  ok(Array.isArray(t0) && t0.length >= 2 && t0.every((v) => v >= 0 && v <= 1),
    '时长 0 不崩，采样点被夹在 0~1 秒内', JSON.stringify(t0));
  ok(sampleTimes(600, 0).length === 1, '帧数传 0 也至少给 1 个点');
  ok(new Set(sampleTimes(3, 8)).size === sampleTimes(3, 8).length,
    '极短视频采样点去重（3 秒要 8 帧不能出现重复时间点）', JSON.stringify(sampleTimes(3, 8)));
  ok(sampleTimes(600, 24).length === 24, '24 帧给 24 个点');
}

// ── 2. 联系表网格 ─────────────────────────────────────────────────────────
section('2. sheetGrid：拼成接近正方形的网格');
{
  ok(JSON.stringify(sheetGrid(4)) === JSON.stringify({ cols: 2, rows: 2 }), '4 帧 → 2×2');
  ok(JSON.stringify(sheetGrid(9)) === JSON.stringify({ cols: 3, rows: 3 }), '9 帧 → 3×3');
  ok(JSON.stringify(sheetGrid(16)) === JSON.stringify({ cols: 4, rows: 4 }), '16 帧 → 4×4');
  const g5 = sheetGrid(5);
  ok(g5.cols * g5.rows >= 5, '5 帧的网格装得下 5 格', JSON.stringify(g5));
  const g1 = sheetGrid(1);
  ok(g1.cols === 1 && g1.rows === 1, '1 帧 → 1×1');
}

// ── 3. 时间文案 ───────────────────────────────────────────────────────────
section('3. formatDuration / formatClock：报告里要能读出「这是第几分钟」');
{
  ok(formatDuration(53) === '0:53', '53 秒 → 0:53', formatDuration(53));
  ok(formatDuration(3725) === '1:02:05', '3725 秒 → 1:02:05', formatDuration(3725));
  ok(formatDuration(600) === '10:00', '600 秒 → 10:00', formatDuration(600));
  ok(formatClock([0, 200, 400]) === '0:00 / 3:20 / 6:40', '时间点串成可读文案', formatClock([0, 200, 400]));
  ok(formatClock([]) === '未知', '空数组不崩');
  ok(formatClock([1, 2, 3], 2) === '0:01 / 0:02', '超过上限就截断');
}

// ── 4. 上限与默认值 ───────────────────────────────────────────────────────
section('4. 上限：24 帧 / 默认 8 帧');
{
  ok(MAX_FRAMES === 24, 'MAX_FRAMES = 24', String(MAX_FRAMES));
  ok(DEFAULT_FRAMES === 8, 'DEFAULT_FRAMES = 8（旧版是 4，看不到片头片尾）', String(DEFAULT_FRAMES));
  ok(DEFAULT_FRAMES <= MAX_FRAMES, '默认值不超过上限');
}

// ── 5. parseVideoId 不受影响 ──────────────────────────────────────────────
section('5. parseVideoId：改造不能碰坏 id 解析');
{
  ok(parseVideoId('BV1JSp46PENx')?.id === 'BV1JSp46PENx', 'BV 号');
  ok(parseVideoId('https://www.bilibili.com/video/BV1JSp46PENx/')?.kind === 'bvid', '完整链接里的 BV 号');
  ok(parseVideoId('av12345')?.kind === 'aid', 'av 号');
  ok(parseVideoId('12345')?.kind === 'aid', '纯数字当 aid');
  ok(parseVideoId('https://b23.tv/AbCdEfG') === null, 'b23.tv 短链本身抠不出（要跟重定向）');
}

// ── 6. 联系表真的拼得出来（真跑 ffmpeg） ──────────────────────────────────
section('6. buildContactSheet：用真 ffmpeg 拼一张图（拼错只会看到乱格/黑图，必须真跑）');
{
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.log('  ⚠ 本机没找到 ffmpeg，跳过联系表实拼（其余断言仍然有效）');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sheet-'));
    try {
      // 造 4 张纯色帧：红 / 绿 / 蓝 / 白，这样拼错颜色或拼错顺序都看得出来
      const colors = ['red', 'green', 'blue', 'white'];
      const made = [];
      const { spawnSync } = await import('node:child_process');
      for (let i = 0; i < colors.length; i += 1) {
        const f = path.join(dir, `frame${i + 1}.jpg`);
        const r = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${colors[i]}:s=64x64`, '-frames:v', '1', f], { windowsHide: true });
        if (r.status === 0 && fs.existsSync(f)) made.push(f);
      }
      ok(made.length === 4, `造出 4 张测试帧（实际 ${made.length}）`);
      if (made.length === 4) {
        const { buildContactSheet } = await import('../src/video-watch.js');
        const sheet = await buildContactSheet(ffmpeg, made, dir, 64);
        ok(sheet.ok === true, '联系表生成成功', sheet.note ?? '');
        if (sheet.ok) {
          ok(JSON.stringify({ cols: sheet.cols, rows: sheet.rows }) === JSON.stringify({ cols: 2, rows: 2 }),
            '4 帧拼成 2×2', JSON.stringify(sheet));
          ok(fs.existsSync(sheet.file), '联系表文件真的落盘了');
          const size = fs.statSync(sheet.file).size;
          ok(size > 1024, `联系表不是空文件（${size}B）`);
          // 尺寸校验：2×2 格 × 64px + padding/margin ≈ 138px 上下
          const { getImageDimensions } = await import('../src/send-image-lib.js').catch(() => ({ getImageDimensions: null }));
          if (typeof getImageDimensions === 'function') {
            const dim = getImageDimensions(fs.readFileSync(sheet.file));
            if (dim?.width) {
              ok(dim.width >= 130 && dim.width <= 150, `联系表宽度符合 2×64+边距（${dim.width}px）`);
              ok(dim.height >= 130 && dim.height <= 150, `联系表高度符合 2×64+边距（${dim.height}px）`);
            }
          }
        }
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ── 7. 接线守卫：纯函数不能变成死代码 ─────────────────────────────────────
section('7. 接线守卫：watchVideo / MCP 工具真的用了新参数');
{
  const src = fs.readFileSync(path.join(root, 'src', 'video-watch.js'), 'utf8');
  ok(/export function sampleTimes\(/.test(src), 'sampleTimes 已导出');
  ok(/export function sheetGrid\(/.test(src), 'sheetGrid 已导出');
  ok(/export async function framesFromVideo\(/.test(src), 'framesFromVideo 已导出（自检要用真 ffmpeg 验证）');
  ok(/export async function buildContactSheet\(/.test(src), 'buildContactSheet 已导出');
  ok(/export function formatDuration\(/.test(src), 'formatDuration 已导出');

  // watchVideo 必须真的用 sampleTimes（抽帧）与 buildContactSheet（拼图）
  ok(/const r = await framesFromVideo\(ffmpeg, videoFile, dir, durationSec, n, frameWidth\);/.test(src),
    '抽帧调用点传了新参数（含 frameWidth）');
  ok(/sheetInfo = await buildContactSheet\(ffmpeg, framePaths, dir, DEFAULT_TILE_WIDTH\);/.test(src),
    '拿到帧后会去拼联系表');
  ok(/const outputFrames = useSheet && sheetInfo\?\.ok \? \[sheetInfo\.file\] : framePaths;/.test(src),
    'sheet 模式下只把那一张拼图交给模型（不是逐张）');
  ok(/frames: outputFrames,/.test(src), '返回值 frames 用的是 outputFrames（模型看到的图）');
  ok(/tiles: framePaths,/.test(src), '返回值额外给了 tiles（单帧，诊断用）');
  // 旧公式必须已经不存在
  ok(!/Math\.max\(1, Math\.floor\(\(durationSec \* \(i \+ 1\)\) \/ \(n \+ 1\)\)\)/.test(src),
    '旧的「永远不碰首尾」采样公式已从源码里消失');
  // 上限放宽到 24
  ok(/const n = Math\.max\(1, Math\.min\(MAX_FRAMES, Number\(frames\) \|\| DEFAULT_FRAMES\)\);/.test(src),
    'watchVideo 内部按 MAX_FRAMES 夹取帧数');

  // MCP 工具层：schema 与调用点都要放开
  const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  ok(/frames: Math\.max\(1, Math\.min\(24, Number\(frames\) \|\| 8\)\)/.test(mcp),
    'qq_watch_video 调用点上限 24 / 默认 8');
  ok(/layout: z\.enum\(\['sheet', 'list'\]\)/.test(mcp), 'qq_watch_video 暴露了 layout 参数');
  ok(/layout: layout === 'list' \? 'list' : 'sheet',/.test(mcp), 'qq_watch_video 把 layout 透传给 watchVideo');
  ok(/frames: z\.number\(\)\.optional\(\)\.describe\('采样几个时间点/.test(mcp),
    'qq_watch_video 的 frames 描述已改成「采样几个时间点」');

  // 卡片点开也走同一套（B 站卡片点开 = 看视频）
  const card = fs.readFileSync(path.join(root, 'src', 'card-open.js'), 'utf8');
  ok(/layout: opts\.layout === 'list' \? 'list' : 'sheet',/.test(card), 'openCard 的视频分支也传 layout');
  ok(/Math\.min\(24, Number\(opts\.frames\) \|\| 8\)/.test(card), 'openCard 的视频分支上限也是 24 / 默认 8');
  ok(/frames: Math\.max\(1, Math\.min\(24, Number\(frames\) \|\| 8\)\),\n\s*layout: layout === 'list' \? 'list' : 'sheet',/.test(mcp),
    'qq_open_card 同样放开到 24 帧并透传 layout');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
