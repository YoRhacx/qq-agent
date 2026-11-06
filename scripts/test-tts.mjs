// 文字转语音（TTS）自检：
// 1) src/tts.js 纯函数：文本清洗/截断、音色解析、音色表完整性、缓存统计
// 2) bridge 接线：ttsCfg 默认值与钳制、prepareVoiceForV2 的互斥/开关、TTS 产物落语音库内
// 3) 端到端（虚拟网关 + 桩掉合成）：qq_send_voice 走 text 时真的发 record 段、且把说过的话记进会话
//
// 注意：**测试绝不联网**——harness 里 synthesizeSpeech 已被桩掉（见 audit-bridge-harness.mjs）。
// 真的合成一次请用：node -e "import('./src/tts.js').then(m=>m.synthesizeSpeech('测试'))"
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  TTS_DEFAULT_VOICE, TTS_LIMITS, TTS_VOICES, normalizeSpeechText, resolveTtsVoice, ttsCacheStats
} from '../src/tts.js';

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}
function throws(fn, re, name) {
  try {
    fn();
    ok(false, name);
  } catch (error) {
    ok(re.test(String(error?.message ?? error)), `${name}（实际：${error?.message ?? error}）`);
  }
}

const VOICE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}-[A-Za-z0-9]+Neural$/;

console.log('## 音色表');
ok(VOICE_RE.test(TTS_DEFAULT_VOICE), '默认音色是合法的 edge ShortName');
ok(TTS_VOICES.some((v) => v.name === TTS_DEFAULT_VOICE), '默认音色在精选音色表里');
ok(TTS_VOICES.every((v) => VOICE_RE.test(v.name) && v.label && v.hint), '音色表每一项都有合法 name/label/hint');
ok(new Set(TTS_VOICES.map((v) => v.name)).size === TTS_VOICES.length, '音色表没有重复');
ok(TTS_VOICES.every((v) => /[\u4e00-\u9fa5]/.test(v.label)), '音色表都带中文别名（给模型认）');

console.log('## normalizeSpeechText 清洗');
{
  const r = normalizeSpeechText('**嘿嘿** [CQ:at,qq=123] 看这个 https://b23.tv/xxx 啦！！！');
  ok(r.text === '嘿嘿 看这个 啦！', `CQ/链接/markdown/重复标点都被清掉（实际：${r.text}）`);
  ok(r.truncated === false && r.originalLength === r.text.length, '未截断时不设 truncated');
}
ok(normalizeSpeechText('![logo](https://a/b.png) 图呢').text === 'logo 图呢', 'markdown 图片只留替代文字');
ok(normalizeSpeechText('@某人 你说呢').text === '你说呢', '@昵称被去掉');
ok(normalizeSpeechText('a\u200Bb\u0001c').text === 'ab c', '零宽字符被删、控制字符变空格（不粘连）');
ok(normalizeSpeechText('  多   空\n\n白  ').text === '多 空 白', '空白折叠成单个空格');
ok(normalizeSpeechText('``````').text === '', '纯符号清洗后为空（调用方要当错误处理）');
ok(normalizeSpeechText('😀😀😀').text === '😀😀😀', 'emoji 保留');

console.log('## normalizeSpeechText 截断');
{
  const long = `${'啊'.repeat(70)}。${'哦'.repeat(70)}。`;
  const r = normalizeSpeechText(long, 80);
  ok(r.truncated === true, '超长被截断');
  ok(r.text.length <= 80, `截断后不超过上限（实际 ${r.text.length}）`);
  ok(r.text.endsWith('。'), '优先在句号处断开');
  ok(r.originalLength === long.length, 'originalLength 记录清洗后的原始长度');
  ok(normalizeSpeechText('x'.repeat(500), 9999).text.length <= TTS_LIMITS.hardMaxChars, 'maxChars 再大也不越过硬上限');
  ok(normalizeSpeechText('短句', 0).text === '短句', 'maxChars<=0 时退回默认值');
}

console.log('## resolveTtsVoice 音色解析');
ok(resolveTtsVoice('') === TTS_DEFAULT_VOICE, '空值 → 默认音色');
ok(resolveTtsVoice('zh-CN-XiaoxiaoNeural') === 'zh-CN-XiaoxiaoNeural', 'ShortName 精确命中');
ok(resolveTtsVoice('ZH-CN-XIAOXIAONEURAL') === 'zh-CN-XiaoxiaoNeural', 'ShortName 大小写不敏感');
ok(resolveTtsVoice('晓伊') === 'zh-CN-XiaoyiNeural', '中文别名命中');
ok(resolveTtsVoice('东北话') === 'zh-CN-liaoning-XiaobeiNeural', 'hint 关键词命中');
ok(resolveTtsVoice('en-US-AriaNeural') === 'en-US-AriaNeural', '表外的合法 edge 音色放行');
throws(() => resolveTtsVoice('小鲸鱼'), /不认识这个音色/, '非法音色名被拒');

console.log('## ttsCacheStats');
ok(ttsCacheStats('C:\\definitely-not-here\\tts').files === 0, '目录不存在时返回 0 而不是抛错');

console.log('## bridge 接线：ttsCfg 默认值');
{
  const voiceOn = { socialV2: { voice: { enabled: true } } };
  const h = await bridgeHarness({ config: voiceOn });
  try {
    const tts = h.voiceCfg().tts;
    ok(tts.enabled === true, '默认开启 TTS（config.example 才是关的）');
    ok(tts.voice === TTS_DEFAULT_VOICE, '默认音色来自 tts.js');
    ok(tts.maxChars === TTS_LIMITS.maxChars && tts.timeoutMs === TTS_LIMITS.timeoutMs, '默认上限来自 TTS_LIMITS');
    ok(tts.dir.endsWith(`${'audio'}${'\\'}tts`) || tts.dir.endsWith('audio/tts'), `TTS 产物固定在语音库的子目录里（${tts.dir}）`);
  } finally { await h.close(); }
}
{
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, tts: { enabled: false, maxChars: 9999 } } } } });
  try {
    const tts = h.voiceCfg().tts;
    ok(tts.enabled === false, 'config 里 tts.enabled=false 生效');
    ok(tts.maxChars === TTS_LIMITS.hardMaxChars, 'config 里超大的 maxChars 被钳到硬上限');
    ok(tts.voice === TTS_DEFAULT_VOICE, 'config 只给 tts.enabled 时其余字段仍有默认值');
  } finally { await h.close(); }
}

console.log('## bridge 接线：prepareVoiceForV2 互斥与开关');
{
  const voiceOn = { socialV2: { voice: { enabled: true } } };
  const h = await bridgeHarness({ config: voiceOn });
  try {
    await h.prepareVoiceForV2('group:456', { text: '晚安', voice: 'hello.mp3' }).then(
      () => ok(false, 'text 与 voice 同时给要被拒'),
      (error) => ok(/只能给一个/.test(String(error?.message)), 'text 与 voice 同时给被拒')
    );
    const bad = await h.prepareVoiceForV2('group:456', { ttsVoice: '小鲸鱼' }).then(() => null, (e) => e);
    ok(/缺少音频/.test(String(bad?.message)), '什么都没给时报「缺少音频」并提示可用 text');
    const wrongVoice = await h.prepareVoiceForV2('group:456', { text: '晚安', ttsVoice: '小鲸鱼' }).then(() => null, (e) => e);
    ok(/不认识这个音色/.test(String(wrongVoice?.message)), '非法 ttsVoice 被拒');
  } finally { await h.close(); }
}
{
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, tts: { enabled: false } } } } });
  try {
    const blocked = await h.prepareVoiceForV2('group:456', { text: '晚安' }).then(() => null, (e) => e);
    ok(/文字转语音已关闭/.test(String(blocked?.message)), 'TTS 关闭时合成被拒');
  } finally { await h.close(); }
}

console.log('## bridge 接线：text → 语音条（虚拟网关 + 桩合成）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true } } } });
  try {
    const prepared = await h.prepareVoiceForV2('group:456', { text: '晚安，我先睡了～' });
    const ttsDir = path.join(h.temp, 'audio', 'tts');
    ok(prepared.via === 'tts-edge', '未命中缓存时 via=tts-edge');
    ok(path.resolve(prepared.path).startsWith(path.resolve(ttsDir)), '合成产物落在语音库内（audio/tts/）');
    ok(fs.existsSync(prepared.path), '合成产物确实写盘了');
    ok(prepared.tts.text === '晚安，我先睡了～', 'TTS 文本保留可读内容');
    ok(prepared.tts.voice === TTS_DEFAULT_VOICE, '默认音色透传给 TTS');

    const alias = await h.prepareVoiceForV2('group:456', { text: '整活', ttsVoice: '东北话' });
    ok(alias.tts.voice === 'zh-CN-liaoning-XiaobeiNeural', 'ttsVoice 中文别名解析后透传');

    const long = await h.prepareVoiceForV2('group:456', { text: '啊'.repeat(300) });
    ok(long.tts.truncated === true && long.tts.text.length <= TTS_LIMITS.maxChars, '超长文本在合成前被截断');

    const sent = await h.sendVoiceForV2('group:456', '', { text: '晚安' });
    const call = h.calls.http.find((c) => c.url.endsWith('/send_group_msg'));
    ok(Boolean(call), 'TTS 语音走 send_group_msg');
    ok(call.body.message.length === 1 && call.body.message[0].type === 'record', '只发一个 record 段');
    ok(path.resolve(call.body.message[0].data.file).startsWith(path.resolve(ttsDir)), 'record 段指向库内绝对路径');
    ok(sent.verification?.confirmed === true, '默认回读 get_msg 确认落地');
    ok(sent.tts?.text === '晚安', '返回里带回说过的那句话');
    const st = h.getSocialV2State('group:456');
    const last = st.recentMessages[st.recentMessages.length - 1];
    ok(last?.text === '[语音] 晚安', `说过的话被写进会话记录（实际：${last?.text}）`);

    const labeled = await h.sendVoiceForV2('group:456', '', { text: '在吗', label: '问了一句' });
    const st2 = h.getSocialV2State('group:456');
    ok(st2.recentMessages[st2.recentMessages.length - 1]?.text === '问了一句', '自定义 label 覆盖默认记录文案');
    ok(labeled.tts?.text === '在吗', '自定义 label 不影响真正说出口的内容');
  } finally { await h.close(); }
}

console.log('## 合成前的前置校验（不联网）');
{
  // 这里故意用**真实**的 synthesizeSpeech：两条守卫都在联网之前抛错。
  const { synthesizeSpeech } = await import('../src/tts.js');
  const empty = await synthesizeSpeech('！！！', { outDir: 'state/tmp-tts-should-not-exist' }).then(() => null, (e) => e);
  // 连续标点会被收成一个「！」，所以走的是第二条守卫（只剩标点/表情）。
  ok(/没有可合成|没有可朗读/.test(String(empty?.message)), `纯标点被拒（实际：${empty?.message}）`);
  const emoji = await synthesizeSpeech('🐟🐟🐟', { outDir: 'state/tmp-tts-should-not-exist' }).then(() => null, (e) => e);
  ok(/没有可朗读的内容/.test(String(emoji?.message)), `只剩 emoji 被拒（实际：${emoji?.message}）`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
