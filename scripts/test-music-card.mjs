// 自检：src/music-card.js（纯函数：校验 + 构造 OneBot music 段）
import { buildMusicSegment, describeMusicSegment, MUSIC_PLATFORMS, MUSIC_MAX_TITLE_CHARS } from '../src/music-card.js';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => { if (cond) pass++; else fails.push(`${name}${extra ? ` :: ${extra}` : ''}`); };
const deep = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1) 平台卡
{
  const r = buildMusicSegment({ type: '163', id: '1234567' });
  ok('平台卡 ok', r.ok === true, JSON.stringify(r));
  ok('平台卡段形状', deep(r.segment, { type: 'music', data: { type: '163', id: '1234567' } }), JSON.stringify(r.segment));
  ok('平台卡 kind', r.kind === 'platform');
  ok('平台卡第三方签名告警', r.warnings.includes('third-party-sign') && r.thirdPartySign === true, JSON.stringify(r.warnings));
  ok('平台卡描述', describeMusicSegment(r.segment) === '平台音乐卡 163:1234567', describeMusicSegment(r.segment));
}
{
  const r = buildMusicSegment({ type: 'QQ', id: '  abc  ' });
  ok('平台卡 type 归一化小写+去空白', deep(r.segment.data, { type: 'qq', id: 'abc' }), JSON.stringify(r.segment.data));
}
{
  const r = buildMusicSegment({ type: '163', id: '1', title: '歌名', singer: '歌手' });
  ok('平台卡多余字段只告警不报错', r.ok === true && r.warnings.includes('platform-card-ignores-extra-fields'), JSON.stringify(r.warnings));
}

// 2) 自定义卡
{
  const r = buildMusicSegment({ type: 'custom', url: 'https://a.example/x', audio: 'https://a.example/x.mp3', title: '自建', image: 'https://a.example/x.jpg', singer: '我' });
  ok('自定义卡 ok', r.ok === true, JSON.stringify(r));
  ok('自定义卡 data.type 固定 custom', r.segment.data.type === 'custom');
  ok('自定义卡 content=singer', r.segment.data.content === '我', JSON.stringify(r.segment.data));
  ok('自定义卡不涉第三方', r.thirdPartySign === false && !r.warnings.includes('third-party-sign'));
  ok('自定义卡描述', describeMusicSegment(r.segment).includes('自建'), describeMusicSegment(r.segment));
}
{
  // 网关侧 `requireNonEmptyStringField(..., "type")` 是硬要求（见 snowluma/index.mjs:4196），
  // 所以「省略 type 但给了自定义字段」也必须本地拒绝，别让它去网关吃一个英文校验错。
  const r = buildMusicSegment({ url: 'https://a/x', audio: 'https://a/x.mp3', title: '省略 type' });
  ok('省略 type 被拒', r.ok === false, JSON.stringify(r));
}
{
  const r = buildMusicSegment({ type: 'custom', url: 'https://a/x', audio: 'https://a/x.mp3', title: '无歌手' });
  ok('缺 singer 只告警', r.ok === true && r.warnings.includes('no-singer'), JSON.stringify(r.warnings));
}

// 3) 校验失败路径
const bad = [
  [{}, '缺 type'],
  [{ type: '' }, '空 type'],
  [{ type: 'x'.repeat(17), id: '1' }, 'type 超长'],
  [{ type: '163' }, '平台卡缺 id'],
  [{ type: '163', id: '1'.repeat(33) }, 'id 超长'],
  [{ type: 'custom' }, '自定义卡缺字段'],
  [{ type: 'custom', url: 'https://a', audio: 'ftp://a/x.mp3', title: 't' }, 'audio 非 http'],
  [{ type: 'custom', url: 'file:///c:/x', audio: 'https://a/x.mp3', title: 't' }, 'url 非 http'],
  [{ type: 'custom', url: 'https://a', audio: 'https://a/x.mp3', title: 't'.repeat(MUSIC_MAX_TITLE_CHARS + 1) }, 'title 超长'],
  [{ type: 'spotify', id: '' }, '未知平台且无 id'],
  [{ type: '163', id: '1', allowThirdPartySign: false }, '禁第三方时平台卡被拒'],
  [{ type: 'custom', url: 'https://a', audio: 'https://a/x.mp3', title: '\n\n' }, 'title 只有换行']
];
for (const [input, name] of bad) {
  const r = buildMusicSegment(input);
  ok(`拒绝：${name}`, r.ok === false && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
}

// 4) 未知平台但有 id：放行（网关只要求非空字符串，别把新平台堵死）
{
  const r = buildMusicSegment({ type: 'spotify', id: 'abc' });
  ok('未知平台有 id 放行', r.ok === true, JSON.stringify(r));
}

// 5) title 换行被压平
{
  const r = buildMusicSegment({ type: 'custom', url: 'https://a', audio: 'https://a/x.mp3', title: '第一行\n第二行' });
  ok('title 换行压平', r.segment.data.title === '第一行 第二行', JSON.stringify(r.segment.data.title));
}

// 6) describeMusicSegment 对非 music 段的兜底
ok('非 music 段描述兜底', describeMusicSegment({ type: 'text', data: {} }) === '非 music 段');
ok('平台白名单非空', MUSIC_PLATFORMS.length > 0);

console.log(fails.length ? `FAIL:\n - ${fails.join('\n - ')}` : '');
console.log(`结果：${pass} 通过，${fails.length} 失败`);
process.exit(fails.length ? 1 : 0);
