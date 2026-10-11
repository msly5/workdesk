export function seedState(locale = 'zh-CN') {
  const now = new Date().toISOString();
  const state = {
    revision: 0, activeTaskId: 'task-welcome',
    tasks: [
      {
        id: 'task-welcome', title: '本地工作台 · 第一版', icon: 'layers', tag: '个人项目', status: 'active',
        goal: '让资料、思路和下一步，在同一张桌面上有序展开。', nextAction: '拖动一张卡片，试着把你的第一份资料放进来。',
        createdAt: now, updatedAt: now, viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: 'welcome-brief', type: 'markdown', title: '从这里开始', x: 65, y: 65, width: 310, content: '## 给每件工作一张桌面\n\n把工作需要的资料放在一起，留住思考过程，也看清下一步。\n\n- 左侧切换任务，各有独立画布\n- 拖动卡片，整理自己的工作路径\n- 双击卡片，展开编辑\n\n**所有内容，自动保存在本机。**' },
          { id: 'welcome-todo', type: 'todo', title: '试试你的工作流', x: 465, y: 65, width: 300, content: '', items: [ { id: 'item-1', text: '建立一个自己的任务', done: false }, { id: 'item-2', text: '拖入文件或粘贴截图', done: false }, { id: 'item-3', text: '写下下一步行动', done: false } ] },
          { id: 'welcome-note', type: 'note', title: '一点小灵感', x: 855, y: 65, width: 270, content: '不用急着整理得很完美。\n\n先把想法放下来，再慢慢连成自己的工作流。', color: 'yellow' },
          { id: 'welcome-image', type: 'image', title: '工作流示意', x: 65, y: 395, width: 310, content: '示例图片 · 拖入你自己的截图即可替换思路', assetId: 'demo-workflow', fileName: '工作流示意.svg', size: 0, mime: 'image/svg+xml' },
          { id: 'welcome-file', type: 'file', title: '工作台使用指南.md', x: 465, y: 395, width: 300, content: '一份可以下载的本地附件', assetId: 'demo-guide', fileName: '工作台使用指南.md', size: 0, mime: 'text/markdown' },
          { id: 'welcome-link', type: 'link', title: '本机数据文件夹', x: 855, y: 370, width: 270, content: '所有内容保存在本机，Markdown 文档同步生成 .md 副本。', url: '', localFolder: true }
        ],
        edges: [ { id: 'e-1', source: 'welcome-brief', target: 'welcome-todo', label: '拆成行动' }, { id: 'e-2', source: 'welcome-todo', target: 'welcome-note', label: '记录想法' }, { id: 'e-3', source: 'welcome-image', target: 'welcome-file', label: '整理资料' } ],
        activity: [{ id: 'a-welcome', text: '创建示例工作区', at: now }]
      },
      {
        id: 'task-weekly', title: '本周工作整理', icon: 'calendar', tag: '日常工作', status: 'active',
        goal: '收拢本周的工作，给重要的事情留出时间。', nextAction: '列出本周最重要的三件事。', createdAt: now, updatedAt: now,
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
          { id: 'weekly-todo', type: 'todo', title: '本周重点', x: 80, y: 80, width: 320, items: [{id:'week-1',text:'整理正在推进的工作',done:false},{id:'week-2',text:'跟进等待反馈的事项',done:false},{id:'week-3',text:'留一段时间做复盘',done:false}], content:'' },
          { id: 'weekly-md', type: 'markdown', title: '工作记录', x: 500, y: 80, width: 340, content: '## 本周记录\n\n### 已经完成\n\n写下值得留下的结果。\n\n### 需要跟进\n\n记录阻塞点和下一步。' }
        ], edges: [{id:'weekly-edge',source:'weekly-todo',target:'weekly-md',label:'推进与记录'}], activity: []
      },
      { id: 'task-inbox', title: '随手收集', icon: 'inbox', tag: '灵感收件箱', status: 'inbox', goal: '先收下，稍后整理。', nextAction: '把临时的想法、截图和资料放到这里。', createdAt: now, updatedAt: now, viewport: {x:0,y:0,zoom:1}, nodes: [], edges: [], activity: [] },
      { id: 'task-done', title: '工作空间搭建', icon: 'check', tag: '个人项目', status: 'done', goal: '准备一张可以安心工作的桌面。', nextAction: '已完成，可以开始新的工作。', createdAt: now, updatedAt: now, viewport: {x:0,y:0,zoom:1}, nodes: [{ id:'done-note',type:'note',title:'完成记录',content:'本地工作台准备好了。\n\n接下来，从一件小事开始。',x:100,y:100,width:320,color:'green'}], edges:[], activity:[] }
    ]
  };
  return locale === 'en' ? translateFreshSeed(state) : state;
}

// Only generated sample content passes through this table. Existing workspace
// data, including edited sample cards, is never translated on a language change.
const englishSeed = new Map([
  ['本地工作台 · 第一版', 'Welcome to Workdesk'], ['个人项目', 'Personal projects'],
  ['让资料、思路和下一步，在同一张桌面上有序展开。', 'Keep your materials, ideas, and next steps together on one desk.'],
  ['拖动一张卡片，试着把你的第一份资料放进来。', 'Move a card, then add your first document or file.'],
  ['从这里开始', 'Start here'],
  ['## 给每件工作一张桌面\n\n把工作需要的资料放在一起，留住思考过程，也看清下一步。\n\n- 左侧切换任务，各有独立画布\n- 拖动卡片，整理自己的工作路径\n- 双击卡片，展开编辑\n\n**所有内容，自动保存在本机。**', '## A desk for every task\n\nKeep the materials you need together, capture your thinking, and see what to do next.\n\n- Switch tasks on the left; each has its own canvas\n- Drag cards to organize your work\n- Double-click a card to edit it\n\n**Everything is saved automatically on this computer.**'],
  ['试试你的工作流', 'Try your workflow'], ['建立一个自己的任务', 'Create a task of your own'],
  ['拖入文件或粘贴截图', 'Drop in a file or paste a screenshot'], ['写下下一步行动', 'Write down your next action'],
  ['一点小灵感', 'A small idea'],
  ['不用急着整理得很完美。\n\n先把想法放下来，再慢慢连成自己的工作流。', 'There is no need to organize everything at once.\n\nCapture your ideas first, then connect them into your own workflow.'],
  ['工作流示意', 'Workflow example'], ['工作流示意.svg', 'workflow-example.svg'],
  ['示例图片 · 拖入你自己的截图即可替换思路', 'Sample image — add your own screenshots to capture your process'],
  ['工作台使用指南.md', 'workdesk-guide.md'], ['一份可以下载的本地附件', 'A local attachment you can download'],
  ['本机数据文件夹', 'Local data folder'],
  ['所有内容保存在本机，Markdown 文档同步生成 .md 副本。', 'Everything stays on this computer. Markdown cards are also exported as .md files.'],
  ['拆成行动', 'Turn into actions'], ['记录想法', 'Capture ideas'], ['整理资料', 'Organize materials'],
  ['创建示例工作区', 'Created the sample workspace'],
  ['本周工作整理', 'Plan your week'], ['日常工作', 'Daily work'],
  ['收拢本周的工作，给重要的事情留出时间。', 'Gather this week\'s work and make time for what matters.'],
  ['列出本周最重要的三件事。', 'List your three most important tasks for this week.'],
  ['本周重点', 'This week\'s priorities'], ['整理正在推进的工作', 'Review your current work'],
  ['跟进等待反馈的事项', 'Follow up on items waiting for feedback'], ['留一段时间做复盘', 'Make time to reflect'],
  ['工作记录', 'Work notes'],
  ['## 本周记录\n\n### 已经完成\n\n写下值得留下的结果。\n\n### 需要跟进\n\n记录阻塞点和下一步。', '## This week\'s notes\n\n### Completed\n\nRecord the results you want to keep.\n\n### Follow up\n\nNote any blockers and next steps.'],
  ['推进与记录', 'Act and document'], ['随手收集', 'Inbox'], ['灵感收件箱', 'Ideas'],
  ['先收下，稍后整理。', 'Capture it now. Organize it later.'],
  ['把临时的想法、截图和资料放到这里。', 'Put quick ideas, screenshots, and materials here.'],
  ['工作空间搭建', 'Set up your workspace'], ['准备一张可以安心工作的桌面。', 'Prepare a desk where you can focus.'],
  ['已完成，可以开始新的工作。', 'All set. You can start your next task.'], ['完成记录', 'Setup complete'],
  ['本地工作台准备好了。\n\n接下来，从一件小事开始。', 'Your Workdesk is ready.\n\nStart with one small task.']
]);
function translateFreshSeed(value) {
  if (typeof value === 'string') return englishSeed.get(value) ?? value;
  if (Array.isArray(value)) return value.map(translateFreshSeed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translateFreshSeed(item)]));
  return value;
}

export const demoGuide = '# 本地工作台 · 使用指南\n\n## 开始\n左侧新建任务，每个任务有独立画布。\n\n## 卡片\n下方工具栏添加待办、Markdown、便签、链接或附件。双击卡片编辑。\n\n## 文件\n拖入文件，或直接粘贴剪贴板图片。单个文件最大 25 MB。\n\n## 画布\n拖动空白区域平移，滚轮上下移动，Ctrl + 滚轮缩放。卡片右侧圆点开始连线，点击目标卡片完成。点击连线可删除。\n\n## 保存\n更改自动保存到本机 data 文件夹。左下角菜单可导出包含附件的备份。请不要同时在多个窗口编辑。\n';

export const demoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="320" viewBox="0 0 620 320"><defs><pattern id="d" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#d9deeb"/></pattern></defs><rect width="620" height="320" fill="#f5f7fc"/><rect width="620" height="320" fill="url(#d)"/><path d="M180 115H250Q270 115 270 140V198Q270 220 292 220H340M180 115H340" fill="none" stroke="#a5a9c3" stroke-width="2"/><g font-family="Microsoft YaHei, sans-serif" font-size="17"><rect x="38" y="70" width="145" height="90" rx="12" fill="white" stroke="#dce1ed"/><rect x="340" y="70" width="235" height="90" rx="12" fill="white" stroke="#dce1ed"/><rect x="340" y="192" width="235" height="82" rx="12" fill="#fff8db" stroke="#eee1ae"/><circle cx="62" cy="96" r="6" fill="#7773df"/><text x="80" y="102" fill="#34384d">收集资料</text><text x="59" y="133" fill="#85899b" font-size="13">文档 · 截图 · 附件</text><circle cx="365" cy="96" r="6" fill="#62a58e"/><text x="382" y="102" fill="#34384d">推进工作</text><text x="361" y="133" fill="#85899b" font-size="13">清晰的步骤，让行动更轻松</text><text x="361" y="224" fill="#766537">留住思考</text><text x="361" y="250" fill="#97875a" font-size="13">每一个想法，都有自己的位置</text></g></svg>`;

const demoGuideEnglish = '# Workdesk guide\n\n## Get started\nCreate tasks on the left. Each task has its own canvas.\n\n## Cards\nUse the bottom toolbar to add to-dos, Markdown documents, notes, links, or attachments. Double-click a card to edit it.\n\n## Files\nDrop files onto the canvas or paste an image from your clipboard. Each attachment can be up to 25 MB.\n\n## Canvas\nDrag empty space to pan, scroll to move, and hold Ctrl (or Cmd on macOS) while scrolling to zoom. Click a card\'s connector, then another card, to connect them. Click a connection to edit or remove it.\n\n## Save and back up\nChanges are saved automatically in the local data folder. Open the menu at the bottom left to export a backup with attachments. Independent edits from another window or AI can merge; conflicting changes keep your input so you can resolve them.\n';

export function demoAssets(locale = 'zh-CN') {
  if (locale !== 'en') return [
    {id:'demo-workflow', name:'工作流示意.svg', content:demoSvg, mime:'image/svg+xml'},
    {id:'demo-guide', name:'工作台使用指南.md', content:demoGuide, mime:'text/markdown'}
  ];
  const workflow = demoSvg
    .replace('收集资料', 'Collect')
    .replace('文档 · 截图 · 附件', 'Notes · files · images')
    .replace('推进工作', 'Make progress')
    .replace('清晰的步骤，让行动更轻松', 'Clear steps for your next action')
    .replace('留住思考', 'Keep ideas')
    .replace('每一个想法，都有自己的位置', 'Give every idea a place')
    .replaceAll('font-size="13"', 'font-size="11"');
  return [
    {id:'demo-workflow', name:'workflow-example.svg', content:workflow, mime:'image/svg+xml'},
    {id:'demo-guide', name:'workdesk-guide.md', content:demoGuideEnglish, mime:'text/markdown'}
  ];
}
