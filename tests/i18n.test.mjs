import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveLanguage,getLanguage,setLanguage,t,formatNumber,formatDate,translateSystemMessage,registerMessages,hasTranslation,localizeStatic} from '../public/i18n.js';
import {staticMessages} from '../public/messages-static.js';
import {markdown} from '../public/markdown.js';

const run=promisify(execFile);

test('语言优先使用有效设置，然后匹配浏览器首个支持语言，默认英文',()=>{
  assert.equal(resolveLanguage('en',['zh-CN']),'en');
  assert.equal(resolveLanguage('zh-CN',['en-US']),'zh-CN');
  assert.equal(resolveLanguage(null,['zh-TW','en-US']),'zh-CN');
  assert.equal(resolveLanguage(null,['en-GB','zh-CN']),'en');
  assert.equal(resolveLanguage('invalid',['fr-FR','zh-HK']),'zh-CN');
  assert.equal(resolveLanguage(undefined,['ja-JP']),'en');
  assert.equal(resolveLanguage(undefined,[]),'en');
});

test('无浏览器或存储访问被拒绝时可导入、切换语言，不依赖 DOM',async()=>{
  const moduleUrl=new URL('../public/i18n.js',import.meta.url).href;
  const script=`Object.defineProperty(globalThis,'localStorage',{get(){throw new Error('denied')}}); const i18n=await import(${JSON.stringify(moduleUrl)}); i18n.setLanguage('zh-CN'); if(i18n.t('本地工作台')!=='本地工作台')throw new Error('Chinese failed'); i18n.setLanguage('en'); if(i18n.t('本地工作台')!=='Workdesk')throw new Error('English failed');`;
  await run(process.execPath,['--input-type=module','-e',script]);
});

test('语言持久化、占位符和卡片计数单复数正确，未知文本保持不变',()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const saved=new Map();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{setItem:(key,value)=>saved.set(key,value)}});
  try {
    setLanguage('en');
    assert.equal(saved.get('workdesk.language'),'en');
    assert.equal(t('{count} 张卡片',{count:1}),'1 card');
    assert.equal(t('{count} 张卡片',{count:2}),'2 cards');
    assert.equal(t('{count} 张卡片',{count:formatNumber(1200)}),'1,200 cards');
    assert.equal(t('{width} 像素',{width:420}),'420 pixels');
    assert.equal(t('用户创建的中文标题'),'用户创建的中文标题');
    assert.equal(t('{width} 像素'),' {width} pixels'.trim());
    setLanguage('zh-CN');
    assert.equal(t('{count} 张卡片',{count:1}),'1 张卡片');
    assert.equal(saved.get('workdesk.language'),'zh-CN');
    assert.throws(()=>setLanguage('fr'),RangeError);
    assert.equal(getLanguage(),'zh-CN');
  } finally {
    if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;
    setLanguage('en');
  }
});

test('系统提示按明确模板翻译并原样保留动态路径和用户值',()=>{
  registerMessages({'无法打开「{path}」：{reason}':'Could not open “{path}”: {reason}'});
  setLanguage('en');
  assert.equal(translateSystemMessage('无法打开「/资料/中文 $1.md」：用户自己的说明'),'Could not open “/资料/中文 $1.md”: 用户自己的说明');
  assert.equal(translateSystemMessage('本地服务暂时无法完成操作，请重试。'),'The local service could not complete this action. Please try again.');
  assert.equal(translateSystemMessage('未注册的用户文字'),'未注册的用户文字');
  setLanguage('zh-CN');
  assert.equal(translateSystemMessage('无法打开「/资料/a.md」：权限不足'),'无法打开「/资料/a.md」：权限不足');
  setLanguage('en');
});

test('日期和数字按当前语言格式化，非法日期不泄漏 Invalid Date',()=>{
  const date=new Date('2026-10-11T09:30:00Z');
  const options={year:'numeric',month:'long',day:'numeric',timeZone:'UTC'};
  for(const locale of ['en','zh-CN']) {
    setLanguage(locale);
    assert.equal(formatNumber(1234.5),new Intl.NumberFormat(locale).format(1234.5));
    assert.equal(formatDate(date,options),date.toLocaleString(locale,options));
    assert.equal(formatDate('invalid'), '');
  }
  setLanguage('en');
});

test('静态翻译只更新标注元素和属性，保留用户内容与图标节点',()=>{
  const element=(attributes,textContent='')=>({
    attributes:{...attributes},textContent,
    hasAttribute(name){return Object.hasOwn(this.attributes,name);},
    getAttribute(name){return this.attributes[name]??null;},
    setAttribute(name,value){this.attributes[name]=value;}
  });
  const label=element({'data-i18n':'添加任务'},'添加任务');
  const input=element({'data-i18n-placeholder':'搜索任务或卡片…','data-i18n-aria-label':'搜索任务或卡片'});
  const user=element({},'添加任务，这是用户的正文');
  const icon={innerHTML:'<svg><path d="M0 0L1 1"/></svg>'};
  const select={value:''};
  const root={nodeType:9,documentElement:{lang:''},querySelectorAll:()=>[label,input],querySelector:()=>select};
  setLanguage('en');localizeStatic(root);
  assert.equal(label.textContent,'Add task');
  assert.equal(input.attributes.placeholder,'Search tasks or cards…');
  assert.equal(input.attributes['aria-label'],'Search tasks or cards');
  assert.equal(root.documentElement.lang,'en');assert.equal(select.value,'en');
  setLanguage('zh-CN');localizeStatic(root);
  assert.equal(label.textContent,'添加任务');
  assert.equal(root.documentElement.lang,'zh-CN');assert.equal(select.value,'zh-CN');
  assert.equal(user.textContent,'添加任务，这是用户的正文');
  assert.equal(icon.innerHTML,'<svg><path d="M0 0L1 1"/></svg>');
  setLanguage('en');
});

test('HTML 所有静态标注都有英文词条，初始可见文本和辅助属性无中文残留',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const keys=[...html.matchAll(/\bdata-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(match=>match[1]);
  assert.ok(keys.length>80);
  for(const key of keys) {
    assert.ok(hasTranslation(key),'Missing translation: '+key);
    assert.ok(staticMessages[key]?.length,'Missing static message: '+key);
  }
  assert.doesNotMatch(html.replace(/<[^>]*>/g,''),/[\p{Script=Han}]/u);
  for(const match of html.matchAll(/(?:^|\s)(?:title|aria-label|placeholder|content|alt)="([^"]*)"/g))assert.doesNotMatch(match[1],/[\p{Script=Han}]/u);
  for(const [source,translation] of Object.entries(staticMessages)) {
    assert.deepEqual([...(source.match(/\{\w+\}/g)||[])].sort(),[...(translation.match(/\{\w+\}/g)||[])].sort(),source);
  }
  assert.match(html,/<select id="language-select"/);
  for(const id of ['task-title','breadcrumb-title','task-tag','next-action-text']) {
    const tag=html.match(new RegExp('<[^>]*\\bid="'+id+'"[^>]*>'))?.[0];
    assert.ok(tag);assert.doesNotMatch(tag,/data-i18n=/,'Dynamic user-content container must not carry a static text marker');
  }
});

test('Markdown 只翻译表格辅助标签，正文和表格内容保持原语言',()=>{
  setLanguage('en');
  const source='名称 | 说明\n--- | ---\n用户文字 | 保持中文';
  const english=markdown(source);
  assert.match(english,/aria-label="Markdown table"/);
  assert.match(english,/<td>用户文字<\/td><td>保持中文<\/td>/);
  setLanguage('zh-CN');assert.match(markdown(source),/aria-label="Markdown 表格"/);
  setLanguage('en');
});

test('活动元数据随界面语言翻译状态词，切换不修改原记录',async()=>{
  const {localizedActivity}=await import('../public/messages-app.js');
  const statuses=[
    ['active','进行中','In progress'],['waiting','等待中','Waiting'],
    ['inbox','收集中','Inbox'],['done','已完成','Done'],['archived','已归档','Archived']
  ];
  const records=statuses.map(([status])=>({text:'原始显示文字',i18n:{source:'任务状态改为{status}',vars:{status}}}));
  const original=structuredClone(records);
  try {
    for(const locale of ['en','zh-CN','en']) {
      setLanguage(locale);
      records.forEach((record,index)=>assert.equal(localizedActivity(record),locale==='en'
        ? 'Task status changed to '+statuses[index][2]
        : '任务状态改为'+statuses[index][1]));
    }
    assert.deepEqual(records,original);
  } finally {setLanguage('en');}
});

test('活动标题中的中文、引号、HTML字符及插值符号在两种语言中原样保留',async()=>{
  const {localizedActivity}=await import('../public/messages-app.js');
  const title='用户中文「内层」 "\' <b>& $& $1 {status}\n第二行 😀';
  const record={text:'之前的活动',i18n:{source:'添加卡片「{title}」',vars:{title}}};
  const original=structuredClone(record);
  try {
    setLanguage('en');
    assert.equal(localizedActivity(record),'Added card “'+title+'”');
    setLanguage('zh-CN');
    assert.equal(localizedActivity(record),'添加卡片「'+title+'」');
    assert.deepEqual(record,original);
  } finally {setLanguage('en');}
});

test('已知旧AI活动模板可翻译，未知旧记录保持原文',async()=>{
  const {localizedActivity}=await import('../public/messages-app.js');
  const title='报告「中文」 <&> $1 {title}';
  const known=[
    ['AI · 创建任务','AI · Created task'],
    ['AI · 更新卡片「'+title+'」','AI · Updated card “'+title+'”'],
    ['AI · 更新待办「'+title+'」','AI · Updated to-do “'+title+'”'],
    ['AI · 任务状态改为等待中','AI · Task status changed to Waiting']
  ];
  const unknown=[
    '用户自己记录：已完成，等待中。',
    'AI · 用户自定义的中文活动 <&> {title}',
    'Custom legacy entry with 中文 and $&',
    '任意前缀 添加卡片「用户内容」'
  ];
  try {
    for(const locale of ['en','zh-CN']) {
      setLanguage(locale);
      for(const [text,english] of known)assert.equal(localizedActivity({text}),locale==='en'?english:text);
      for(const text of unknown)assert.equal(localizedActivity({text}),text);
      assert.equal(localizedActivity({text:unknown[0],i18n:{source:'未知活动模板{title}',vars:{title}}}),unknown[0]);
    }
  } finally {setLanguage('en');}
});
