// 从 bridge 的聊天归档造一份「星图」档案（记忆卡 + 日记 + 原始对话）。
// 用途：dsh-xingxi 的星图要有星星，而它的「拾星」只能在 DSH 控制台面板里点、且会花模型钱；
// 一次性把历史灌成档案更快也更省。
//
// 输入：state/history/*.jsonl（private_*.jsonl / group_*.jsonl，行含 seq/tsMs/dir/senderName/text/media/messageId）
// 输出：state/xingxi/记忆卡.md + state/xingxi/日记/YYYY-MM-DD.md + state/xingxi/原始对话/YYYY-MM-DD.txt
//
// 用法：ELECTRON_RUN_AS_NODE=1 '<DSH exe>' scripts/build-xingxi-archive.mjs
// 注意：日记正文是人工写的 D 表（我按真实对话总结的），重跑不会覆盖你的新日记以外的内容；
//       记忆卡.md 不由本脚本生成（它是手写的八章），重跑只重写 日记/ 与 原始对话/。

import fs from 'node:fs';
import path from 'node:path';
const ARCH='D:/qq-bot/qq-bridge/state/xingxi';
const HIST='D:/qq-bot/qq-bridge/state/history';
// 个人日记：原文是按真实聊天总结的，公开仓库里留示例；自己用就照格式补
const D={
 '2026-01-01':'（这一天的日记正文，随便写一句当天发生了什么）',
};
const wd=(d)=>{const t=new Date(d+'T12:00:00+08:00');return '周'+'日一二三四五六'[t.getUTCDay()]};
fs.mkdirSync(path.join(ARCH,'日记'),{recursive:true});
for(const d of Object.keys(D).sort()){
  const txt='## '+d.slice(0,7)+'\n\n- **'+d.slice(5)+' '+wd(d)+'**：'+D[d]+'\n';
  fs.writeFileSync(path.join(ARCH,'日记',d+'.md'), txt, 'utf8');
}

// 原始对话：按天落到一个文件，私聊与群分开标
const byDay={};
for(const f of fs.readdirSync(HIST)){
  if(!f.endsWith('.jsonl')) continue;
  const kind=f.startsWith('private')?'私聊':'群';
  for(const l of fs.readFileSync(path.join(HIST,f),'utf8').split('\n').filter(Boolean)){
    let o; try{o=JSON.parse(l)}catch{continue}
    const t=new Date(o.tsMs+8*3600e3); const day=t.toISOString().slice(0,10);
    const who=o.dir==='out'?'她':(o.senderName||'?');
    const text=String(o.text||'').replace(/\s+/g,' ').slice(0,300);
    if(!text) continue;
    (byDay[day]=byDay[day]||[]).push(t.toISOString().slice(11,16)+' ['+kind+'] '+who+'：'+text);
  }
}
let n=0; for(const d of Object.keys(byDay).sort()){ fs.writeFileSync(path.join(ARCH,'原始对话',d+'.txt'), byDay[d].join('\n')+'\n','utf8'); n++; }
console.log('diaries',Object.keys(D).length,'raw',n);