import { icon } from './icons.js';
import { markdown, escapeHTML as esc, safeURL } from './markdown.js';
import { Canvas } from './canvas.js';
import { restoreCard, mergeStates, updateInPlace, applyFormChanges } from './model.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const uid = () => crypto.randomUUID();
const TYPES = { todo:['待办清单','todo'], markdown:['Markdown 文档','markdown'], note:['便签','note'], image:['图片与截图','image'], file:['附件','file'], link:['链接','link'] };
const cardType = node => node.type === 'link' && node.localFolder ? ['本地文件夹','folder'] : TYPES[node.type];
const STATUS = { active:'进行中', waiting:'等待中', inbox:'收集中', done:'已完成', archived:'已归档' };
let state, filter = 'all', view = 'canvas', selected = null, connecting = null, inspectorMode = null;
let dirty = false, saving = null, saveTimer, lastError = null, editorTab = 'edit';
let savedBase, syncing = false, uploading = 0;
let composing = false, inspectorRendered = null;
const compositionWaiters = new Set();
const activeTask = () => state?.tasks.find(t => t.id === state.activeTaskId);
const activeNode = () => activeTask()?.nodes.find(n => n.id === selected);

$$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '操作未完成，请重试'); error.status = response.status; throw error; }
  return data;
}
function toast(message, options = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (options.error ? ' error' : '');
  el.innerHTML = icon(options.error ? 'help' : 'checkCircle') + '<span>' + esc(message) + '</span>';
  if (options.action) {
    const button = document.createElement('button'); button.textContent = options.label || '撤销';
    button.onclick = () => { options.action(); el.remove(); }; el.append(button);
  }
  $('#toasts').append(el); setTimeout(() => el.remove(), options.action ? 8000 : 4000);
}
function updateSaveStatus() {
  const el = $('#save-status');
  const text = lastError?.status === 409 ? '内容冲突 · 点击处理' : lastError ? '保存失败 · 点击重试' : saving ? '正在保存…' : dirty ? '等待保存…' : '已保存到本机';
  el.className = 'save-status' + (lastError ? ' error' : saving || dirty ? ' saving' : '');
  el.innerHTML = icon(lastError ? 'help' : saving || dirty ? 'clock' : 'checkCircle') + '<span>' + text + '</span>';
  el.title = lastError?.message || '更改会自动保存到本机';
}
function markChanged() {
  if (!state) return;
  dirty = true;
  if (activeTask()) activeTask().updatedAt = new Date().toISOString();
  clearTimeout(saveTimer); if(!composing)saveTimer = setTimeout(() => flushSave().catch(() => {}), 500);
  updateSaveStatus();
}
async function flushSave() {
  await waitForComposition();
  clearTimeout(saveTimer);
  if (saving) { await saving; if (dirty) return flushSave(); return; }
  if (!dirty || !state) return;
  if(lastError?.status===409) {showConflict();throw lastError;}
  const snapshot = structuredClone(state), base = structuredClone(savedBase); dirty = false; lastError = null;
  saving = request('/api/state', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:snapshot,base})})
    .then(async result => {
      await waitForComposition();
      const merged=mergeStates(snapshot,state,result.state);
      adoptState(merged); savedBase=structuredClone(result.state);
      if(!canvas.drag)renderWorkspace();
      if(inspectorMode==='node')syncInspector();
    })
    .catch(error => { dirty = true; lastError = error; toast(error.status===409?'同一份内容被同时修改，点击顶部保存状态处理。':error.message, {error:true}); throw error; })
    .finally(() => { saving = null; updateSaveStatus(); });
  updateSaveStatus(); await saving;
  if (dirty) return flushSave();
}
function adoptState(next) {
  updateInPlace(state,next);
  if(selected&&!activeNode()){selected=null;closeInspector();}
}
async function syncRemote() {
  if(!state||syncing||saving||dirty||uploading||canvas.drag||connecting||inspectorMode||$('#modal').open)return;
  syncing=true;
  const revision=state.revision;
  try {
    const remote=await request('/api/state');
    // Recheck after awaiting: the user may have begun editing during the request.
    if(dirty||saving||uploading||canvas.drag||connecting||inspectorMode||$('#modal').open||state.revision!==revision)return;
    if(remote.revision<=revision)return;
    const active=state.activeTaskId;
    const viewports=new Map(state.tasks.map(t=>[t.id,structuredClone(t.viewport)]));
    savedBase=structuredClone(remote);
    if(remote.tasks.some(t=>t.id===active))remote.activeTaskId=active;
    for(const task of remote.tasks)if(viewports.has(task.id))task.viewport=viewports.get(task.id);
    adoptState(remote);renderWorkspace();updateSaveStatus();
  } catch {} finally {syncing=false;}
}
function showConflict() {
  if($('#modal').open)return;
  showModal('这份内容有两处修改','<p class="help-note">网页和 AI（或另一窗口）修改了相同内容。你的页面内容仍然保留，服务端的新内容也没有被覆盖。</p><p class="help-note">先导出页面备份，再载入最新内容，对照备份整理修改。</p>',
    '<button class="secondary" data-close-modal>继续查看</button><button class="primary" id="resolve-conflict">备份页面并载入最新</button>');
  $('#resolve-conflict').onclick=async()=>{
    try {
      const snapshot=structuredClone(state), backup=await request('/api/backup');backup.state=snapshot;
      download('本地工作台-冲突页面备份-'+Date.now()+'.json',JSON.stringify(backup,null,2));
      const latest=await request('/api/state');const active=state.activeTaskId;
      if(latest.tasks.some(t=>t.id===active))latest.activeTaskId=active;
      savedBase=structuredClone(latest);adoptState(latest);dirty=false;lastError=null;
      closeInspector();$('#modal').close();renderWorkspace();updateSaveStatus();toast('已导出页面备份，并载入最新内容');
    }catch(error){toast(error.message,{error:true});}
  };
}
function activity(text, task = activeTask()) {
  if (!task) return;
  task.activity ??= [];
  task.activity.unshift({id:uid(),text,at:new Date().toISOString()});
  task.activity = task.activity.slice(0, 150);
}
function fileSize(size) {
  if (!size) return '本地文件';
  return size >= 1024 * 1024 ? (size / (1024 * 1024)).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB';
}
function taskMatches(task) {
  const matchesFilter = filter === 'all' ? task.status !== 'archived' : filter === 'active' ? ['active','waiting','inbox'].includes(task.status) : task.status === filter;
  const search = $('#task-search').value.trim().toLowerCase();
  const haystack = [task.title,task.tag,task.goal,...task.nodes.map(n => n.title + ' ' + (n.content || '') + ' ' + (n.items || []).map(i => i.text).join(' '))].join(' ').toLowerCase();
  return matchesFilter && (!search || haystack.includes(search));
}
function renderSidebar() {
  if (!state) return;
  const tasks = state.tasks.filter(taskMatches);
  $('#task-list').innerHTML = tasks.length ? tasks.map(task =>
    '<button class="task-entry' + (state.activeTaskId === task.id ? ' selected' : '') + '" data-task="' + task.id + '">' +
    '<span class="task-symbol">' + icon(task.icon || 'layers') + '</span><span class="task-entry-text"><span class="task-entry-title">' + esc(task.title) +
    '</span><span class="task-entry-meta ' + task.status + '"><span class="status-dot"></span>' + esc(task.tag || STATUS[task.status]) + '<span>·</span>' + task.nodes.length + ' 张卡片</span></span></button>'
  ).join('') : '<div class="no-results">' + ($('#task-search').value ? '没有找到匹配的内容' : '这里还没有任务') + '</div>';
  $$('[data-filter]').forEach(el => {
    const f = el.dataset.filter; el.classList.toggle('active', f === filter);
    const count = f === 'all' ? state.tasks.filter(t => t.status !== 'archived').length : f === 'active' ? state.tasks.filter(t => ['active','waiting','inbox'].includes(t.status)).length : state.tasks.filter(t => t.status === f).length;
    const target = el.querySelector('.count') || (f === 'archived' ? $('#archived-count') : null);
    if (target) target.textContent = count;
  });
  $('#task-list-label').textContent = filter === 'archived' ? '归档任务' : filter === 'done' ? '已完成任务' : '我的任务';
}
function renderHeader() {
  const task = activeTask();
  $('#task-header').classList.toggle('hidden', !task);
  if (!task) { $('#breadcrumb-title').textContent = '新建第一个任务'; return; }
  $('#breadcrumb-title').textContent = task.title;
  $('#task-title').textContent = task.title;
  $('#task-tag').textContent = task.tag || '个人任务';
  $('#task-goal').textContent = task.goal || '为这件工作写下一个清晰的目标。';
  $('#card-count').textContent = task.nodes.length + ' 张卡片';
  $('#next-action-text').textContent = task.nextAction || '写下一个可以开始的小行动';
  $('#task-status').className = 'status-pill ' + task.status;
  $('#task-status').innerHTML = '<span></span>' + STATUS[task.status];
  $('#empty-state').classList.toggle('hidden', task.nodes.length > 0);
  $('#canvas-caption').textContent = task.status === 'done' ? '让每一份完成，都留下值得复用的经验' : '每一个想法，都有自己的位置';
}
function renderCard(node) {
  const type = cardType(node), task = activeTask();
  let body = '', footer = '', extra = '';
  if (node.type === 'markdown') {
    body = '<div class="markdown">' + (node.content ? markdown(node.content) : '<p class="node-text-empty">双击，开始写下你的内容…</p>') + '</div>';
    footer = '<span>Markdown 文档</span><button data-edit="' + node.id + '">' + icon('edit') + '编辑</button>';
  } else if (node.type === 'todo') {
    const done = node.items.filter(i => i.done).length, total = node.items.length;
    body = '<div class="todo-progress"><span class="progress-track"><span class="progress-fill" style="display:block;width:' + (total ? done / total * 100 : 0) + '%"></span></span><span>' + done + ' / ' + total + '</span></div>';
    body += node.items.length ? node.items.slice(0,6).map(item => '<div class="todo-item' + (item.done ? ' done' : '') + '"><button class="check-box' + (item.done ? ' checked' : '') + '" data-toggle="' + item.id + '" aria-label="' + (item.done ? '取消完成：' : '完成：') + esc(item.text) + '">' + (item.done ? icon('check') : '') + '</button><span class="todo-text">' + esc(item.text) + '</span></div>').join('') : '<p class="node-text-empty">双击，添加一个具体的行动…</p>';
    if (total > 6) body += '<div class="todo-item-more">还有 ' + (total - 6) + ' 项，双击查看</div>';
    footer = '<span>' + (total && done === total ? '全部完成，做得不错' : '一步一步，向前推进') + '</span><button data-edit="' + node.id + '">' + icon('plus') + '添加</button>';
  } else if (node.type === 'note') {
    body = esc(node.content || '双击，记下一个想法…');
    extra = ' ' + (['yellow','blue','green','pink'].includes(node.color) ? node.color : 'yellow');
    footer = '<span>随手记下，稍后整理</span>' + icon('note');
  } else if (node.type === 'image') {
    body = node.assetId ? '<img src="/api/files/' + node.assetId + '" alt="' + esc(node.title) + '" draggable="false"><p class="image-caption">' + esc(node.content || node.fileName || '图片') + '</p>' : '<p class="node-text-empty">拖入或粘贴一张截图</p>';
    footer = '<span>图片 · ' + fileSize(node.size) + '</span><button data-preview="' + node.id + '">' + icon('external') + '查看原图</button>';
  } else if (node.type === 'file') {
    const ext = (node.fileName || node.title).split('.').at(-1).slice(0,5).toUpperCase();
    body = '<div class="file-content"><span class="file-ext">' + esc(ext) + '</span><span class="file-info"><strong>' + esc(node.content || node.fileName || '本地附件') + '</strong><small>' + fileSize(node.size) + ' · 保存在本机</small></span><a class="download-button" href="/api/files/' + node.assetId + '?download=1" title="下载附件" aria-label="下载附件">' + icon('download') + '</a></div>';
    footer = '<span>附件</span><button data-edit="' + node.id + '">' + icon('edit') + '备注</button>';
  } else if (node.type === 'link') {
    const url = safeURL(node.url || '');
    let label = '添加一个参考链接';
    if (url) { try { label = new URL(url).hostname || url; } catch {} }
    body = '<a class="link-preview" ' + (url ? 'href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"' : 'data-edit="' + node.id + '"') + '>' + icon('link') + '<span>' + esc(label) + '</span>' + icon('arrowUpRight') + '</a>';
    if (node.localFolder) {
      const folderLabel = node.folderPath === undefined ? '打开本地数据文件夹' : node.folderPath.trim() ? '打开文件夹' : '填写文件夹路径';
      body = '<button class="link-preview" data-folder="' + node.id + '">' + icon('folder') + '<span>' + folderLabel + '</span>' + icon('arrowUpRight') + '</button>';
      if (node.folderPath !== undefined) body += '<p class="folder-path" title="' + esc(node.folderPath) + '">' + esc(node.folderPath || '尚未设置路径') + '</p>';
    }
    body += '<p class="link-description">' + esc(node.content || '参考资料，随手可得。') + '</p>';
    footer = '<span>' + (node.localFolder ? '本机文件夹' : '参考链接') + '</span>' + (node.localFolder ? '<button data-edit="' + node.id + '">' + icon('edit') + '编辑路径</button>' : icon('link'));
  }
  return '<article class="node node-' + node.type + extra + (selected === node.id ? ' selected' : '') + '" data-id="' + node.id + '" style="left:' + node.x + 'px;top:' + node.y + 'px;width:' + node.width + 'px" tabindex="0" aria-label="' + esc(type[0] + '：' + node.title) + '">' +
    '<div class="node-header"><span class="node-type-icon">' + icon(type[1]) + '</span><span class="node-title">' + esc(node.title || type[0]) + '</span><button class="node-more" data-node-menu="' + node.id + '" aria-label="卡片菜单">' + icon('more') + '</button></div>' +
    '<div class="node-body">' + body + '</div><div class="node-footer">' + footer + '</div><button class="node-handle" data-connect="' + node.id + '" title="从这里连接到其他卡片" aria-label="从这张卡片建立连线"></button></article>';
}
const canvas = new Canvas({getTask:activeTask,renderCard,escape:esc,isConnecting:() => !!connecting,onSelect:selectNode,onEdit:openEditor,onChange:markChanged});
function renderList() {
  const task = activeTask();
  $('#list-surface').innerHTML = task ? '<div class="list-heading"><span>全部卡片</span><span>' + task.nodes.length + ' 张卡片 · 双击编辑</span></div><div class="list-grid">' + task.nodes.map(renderCard).join('') + '</div>' : '';
}
function renderWorkspace() {
  renderHeader(); renderSidebar(); canvas.render();
  if (view === 'list') renderList();
}
function selectNode(id) {
  if (id !== selected && inspectorMode === 'node') closeInspector();
  selected = id; canvas.select(id);
  $$('#list-surface .node').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
}
function selectTask(id) {
  if (!state.tasks.some(t => t.id === id)) return;
  state.activeTaskId = id; selected = null; cancelConnection(); closeInspector(); closePopover();
  $('#sidebar').classList.remove('open'); renderWorkspace(); markChanged();
}
function setView(mode) {
  view = mode;
  $('#canvas-view').classList.toggle('active', mode === 'canvas');
  $('#list-view').classList.toggle('active', mode === 'list');
  $('#list-surface').classList.toggle('hidden', mode !== 'list');
  $('#canvas').classList.toggle('hidden', mode !== 'canvas');
  $('.zoom-toolbar').classList.toggle('hidden', mode !== 'canvas');
  $('#canvas-caption').parentElement.classList.toggle('hidden', mode !== 'canvas');
  $('#canvas-hint').classList.toggle('hidden', mode !== 'canvas');
  cancelConnection(); if (mode === 'list') renderList();
}
function closeInspector() {
  finishComposition();
  $('#inspector').classList.add('hidden'); inspectorMode = null;
}
async function waitForComposition() {
  while(composing)await new Promise(resolve=>compositionWaiters.add(resolve));
}
function finishComposition() {
  composing=false;
  if(compositionWaiters.size)requestAnimationFrame(()=>{for(const resolve of compositionWaiters)resolve();compositionWaiters.clear();});
}
function syncInspector() {
  // A merge may update fields that were not being edited. Reflect the merged
  // content immediately so the next keystroke cannot overwrite an unseen AI edit.
  const node=activeNode();if(!node)return closeInspector();
  const todoInputs=$$('[data-item-input]');
  const todoChanged=node.type==='todo' && (todoInputs.length!==node.items.length || node.items.some((item,index)=>{
    const input=todoInputs[index];
    return !input || input.dataset.itemInput!==item.id || input.value!==item.text || input.parentElement.querySelector('.check-box').classList.contains('checked')!==item.done;
  }));
  const changed=($('#node-title-input')?.value!==node.title) ||
    ($('#node-content-input') && $('#node-content-input').value!==(node.content||'')) ||
    ($('#node-url-input') && $('#node-url-input').value!==(node.url||'')) ||
    ($('#node-folder-input') && $('#node-folder-input').value!==(node.folderPath||'')) ||
    (inspectorRendered?.localFolder!==node.localFolder) ||
    (inspectorRendered?.folderPath!==node.folderPath) ||
    (editorTab==='preview' && inspectorRendered?.content!==node.content) ||
    (inspectorRendered?.assetId!==node.assetId) ||
    (node.type==='note' && $('.color-swatch.selected')?.dataset.color!==node.color) ||
    todoChanged;
  if(!changed || composing)return;
  const focus=document.activeElement;
  const inside=$('#inspector').contains(focus);
  const selector=inside?(focus.id?'#'+focus.id:focus.dataset.itemInput?'[data-item-input="'+focus.dataset.itemInput+'"]':null):null;
  const start=focus.selectionStart,end=focus.selectionEnd,direction=focus.selectionDirection;
  const scroll=$('.inspector-main')?.scrollTop||0,controlScroll=focus.scrollTop;
  renderInspector();
  if($('.inspector-main'))$('.inspector-main').scrollTop=scroll;
  const replacement=selector?$(selector):null;
  if(replacement){
    replacement.focus({preventScroll:true});
    if(typeof start==='number'&&typeof replacement.setSelectionRange==='function')replacement.setSelectionRange(start,end,direction);
    replacement.scrollTop=controlScroll;
  }
}
function openEditor(id) {
  if (!activeTask()?.nodes.some(n => n.id === id)) return;
  selectNode(id); editorTab = 'edit'; inspectorMode = 'node'; renderInspector();
}
function renderInspector() {
  const node = activeNode(); if (!node) return closeInspector();
  inspectorRendered=structuredClone(node);
  const type = cardType(node);
  let editor = '<label class="field"><span>卡片标题</span><input id="node-title-input" value="' + esc(node.title) + '" maxlength="300"></label>';
  if (node.type === 'markdown') {
    editor += '<div class="editor-tabs"><button data-editor-tab="edit" class="' + (editorTab === 'edit' ? 'active' : '') + '">编辑</button><button data-editor-tab="preview" class="' + (editorTab === 'preview' ? 'active' : '') + '">预览</button></div>' +
      (editorTab === 'edit' ? '<textarea id="node-content-input" class="editor-textarea" spellcheck="false" placeholder="写下你的文档，支持 Markdown…">' + esc(node.content) + '</textarea><p class="editor-hint">支持标题、列表、粗体、引用、代码块和链接。<br>文档会同步保存为本地 .md 文件。</p>' : '<div class="editor-preview markdown">' + markdown(node.content || '*还没有内容*') + '</div>') +
      '<button class="subtle-button" id="download-md">' + icon('download') + '下载 Markdown</button>';
  } else if (node.type === 'todo') {
    editor += '<span class="field-label">行动清单</span><div id="editor-todos">' + node.items.map(item => '<div class="editor-todo-item"><button class="check-box' + (item.done ? ' checked' : '') + '" data-editor-toggle="' + item.id + '" aria-label="切换完成状态">' + (item.done ? icon('check') : '') + '</button><input data-item-input="' + item.id + '" value="' + esc(item.text) + '" aria-label="待办内容" maxlength="5000"><button class="icon-button" data-remove-item="' + item.id + '" aria-label="删除待办项">' + icon('close') + '</button></div>').join('') + '</div><button class="add-todo-item" id="add-todo-item">' + icon('plus') + '添加一项</button>';
  } else {
    if (node.type === 'image' && node.assetId) editor += '<img class="editor-image" src="/api/files/' + node.assetId + '" alt="' + esc(node.title) + '" data-preview="' + node.id + '">';
    if (node.type === 'file') editor += '<div class="editor-file"><span class="file-ext">' + esc((node.fileName || '').split('.').at(-1).slice(0,5).toUpperCase()) + '</span><span class="file-info"><strong>' + esc(node.fileName || '附件') + '</strong><small>' + fileSize(node.size) + '</small></span></div>';
    if (node.type === 'link') {
      editor += '<label class="field"><span>链接类型</span><select id="node-link-kind"><option value="web"' + (!node.localFolder ? ' selected' : '') + '>网页链接</option><option value="folder"' + (node.localFolder ? ' selected' : '') + '>本地文件夹</option></select></label>';
      if (node.localFolder) editor += '<label class="field"><span>文件夹路径</span><input id="node-folder-input" value="' + esc(node.folderPath || '') + '" placeholder="D:\\项目资料" maxlength="32767" spellcheck="false" autocomplete="off"></label><p class="editor-hint">' + (node.folderPath === undefined ? '当前打开工作台数据目录，填写路径后可改为指定文件夹。' : '填写本机完整文件夹路径。这里只保存引用，不复制文件夹内容。') + '</p><button class="subtle-button" data-folder="' + node.id + '">' + icon('folder') + '打开文件夹</button>';
      else editor += '<label class="field"><span>链接地址</span><input id="node-url-input" type="url" value="' + esc(node.url || '') + '" placeholder="https://…"></label>';
    }
    editor += '<label class="field"><span>' + (node.type === 'note' ? '便签内容' : '备注') + '</span><textarea id="node-content-input" rows="' + (node.type === 'note' ? 8 : 4) + '" placeholder="写下一点想法…">' + esc(node.content || '') + '</textarea></label>';
    if (node.type === 'note') editor += '<span class="field-label">便签颜色</span><div class="color-picker">' + ['yellow','blue','green','pink'].map((color,i) => '<button class="color-swatch ' + color + (node.color === color ? ' selected' : '') + '" data-color="' + color + '" aria-label="' + ['黄色','蓝色','绿色','粉色'][i] + '便签"></button>').join('') + '</div>';
    if (['image','file'].includes(node.type) && node.assetId) editor += '<a class="subtle-button" href="/api/files/' + node.assetId + '?download=1">' + icon('download') + '下载原文件</a>';
  }
  $('#inspector').classList.remove('hidden');
  $('#inspector').innerHTML = '<div class="inspector-header"><span class="inspector-type">' + icon(type[1]) + type[0] + '</span><span class="inspector-header-actions"><button class="icon-button" id="delete-node" title="删除卡片" aria-label="删除卡片">' + icon('trash') + '</button><button class="icon-button" id="close-inspector" aria-label="关闭编辑器">' + icon('close') + '</button></span></div><div class="inspector-main">' + editor + '</div><div class="inspector-footer"><span>' + icon('save') + ' 更改自动保存</span><button id="connect-from-editor">' + icon('link') + ' 连接卡片</button></div>';
}
function refreshNode(id = selected) {
  canvas.refreshNode(id); if (view === 'list') renderList();
  renderHeader(); renderSidebar();
}
function addNode(type, position, overrides = {}, open = true) {
  const task = activeTask(); if (!task) { taskDialog(); return; }
  const names = {todo:'新的行动清单',markdown:'未命名文档',note:'一个新想法',link:'参考链接',image:'图片',file:'附件'};
  const node = {id:uid(),type,title:names[type],content:'',width:310,...(position || canvas.newPosition()),...overrides};
  if (type === 'todo') node.items = [{id:uid(),text:'写下第一步行动',done:false}];
  if (type === 'note') { node.color ??= 'yellow'; node.width = 270; }
  task.nodes.push(node); activity('添加' + cardType(node)[0] + '「' + node.title + '」'); markChanged();
  selected = node.id; renderWorkspace(); if (open) openEditor(node.id);
  return node;
}
function deleteNode(id) {
  const task = activeTask(), index = task.nodes.findIndex(n => n.id === id);
  if (index < 0) return;
  const node = structuredClone(task.nodes[index]), edges = task.edges.filter(e => e.source === id || e.target === id);
  task.nodes.splice(index,1); task.edges = task.edges.filter(e => e.source !== id && e.target !== id);
  if (selected === id) { selected = null; closeInspector(); }
  cancelConnection(); activity('移除卡片「' + node.title + '」'); markChanged(); renderWorkspace();
  toast('卡片已移除', {action:() => { restoreCard(task,index,node,edges); activity('恢复卡片「' + node.title + '」',task); markChanged(); renderWorkspace(); }});
}
function startConnection(id) {
  if (view !== 'canvas') setView('canvas');
  connecting = id; closeInspector(); selectNode(id);
  $('#workspace').classList.add('connecting'); $('#connection-banner').classList.remove('hidden');
}
function cancelConnection() {
  connecting = null; $('#workspace').classList.remove('connecting'); $('#connection-banner').classList.add('hidden');
}
function finishConnection(target) {
  const task = activeTask();
  if (!connecting || connecting === target) return;
  if (task.edges.some(e => e.source === connecting && e.target === target)) { toast('这两张卡片已经有关联'); cancelConnection(); return; }
  task.edges.push({id:uid(),source:connecting,target,label:''}); activity('建立卡片关联'); cancelConnection(); markChanged(); canvas.renderEdges(); toast('关联已建立 · 点击连线可以编辑');
}
function closePopover() { $('#popover').classList.add('hidden'); }
function popover(anchor, entries) {
  const el = $('#popover'); el.innerHTML = '';
  entries.forEach(entry => {
    if (!entry) { el.append(document.createElement('hr')); return; }
    if (entry.caption) { const caption = document.createElement('div'); caption.className = 'menu-caption'; caption.textContent = entry.caption; el.append(caption); return; }
    const button = document.createElement('button'); button.classList.toggle('danger', !!entry.danger);
    button.innerHTML = icon(entry.icon || 'circle') + '<span>' + esc(entry.label) + '</span>';
    button.onclick = () => { closePopover(); entry.action(); }; el.append(button);
  });
  const rect = anchor.getBoundingClientRect(); el.classList.remove('hidden');
  el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 9, rect.right - el.offsetWidth)) + 'px';
  el.style.top = (rect.bottom + el.offsetHeight + 8 > innerHeight ? Math.max(8, rect.top - el.offsetHeight - 7) : rect.bottom + 6) + 'px';
}
function taskMenu(anchor = $('#task-menu')) {
  const task = activeTask(); if (!task) return;
  popover(anchor,[
    {label:'编辑任务',icon:'edit',action:() => taskDialog(task)},
    {label:task.status === 'done' ? '重新开始' : '标记为完成',icon:'checkCircle',action:() => setTaskStatus(task.status === 'done' ? 'active' : 'done')},
    {label:task.status === 'waiting' ? '继续推进' : '标记为等待',icon:'clock',action:() => setTaskStatus(task.status === 'waiting' ? 'active' : 'waiting')},
    null,
    {label:task.status === 'archived' ? '恢复任务' : '归档任务',icon:task.status === 'archived' ? 'undo' : 'archive',action:() => setTaskStatus(task.status === 'archived' ? 'active' : 'archived')}
  ]);
}
function setTaskStatus(status) {
  const task = activeTask(); if (!task) return;
  task.status = status; activity('任务状态改为' + STATUS[status]); markChanged(); renderWorkspace();
  toast(status === 'archived' ? '已归档 · 可以在左下角恢复' : '任务已设为' + STATUS[status]);
}
function nodeMenu(anchor, id) {
  popover(anchor,[
    {label:'编辑卡片',icon:'edit',action:() => openEditor(id)},
    {label:'连接到其他卡片',icon:'link',action:() => startConnection(id)},
    {label:'复制卡片',icon:'layers',action:() => {const node=structuredClone(activeTask().nodes.find(n=>n.id===id));node.id=uid();node.title+=' · 副本';node.x+=35;node.y+=35;if(node.items)node.items.forEach(i=>i.id=uid());activeTask().nodes.push(node);activity('复制卡片');markChanged();renderWorkspace();}},
    null,{label:'移除卡片',icon:'trash',danger:true,action:() => deleteNode(id)}
  ]);
}
function showModal(title, body, footer, options = {}) {
  const dialog = $('#modal'); dialog.className = options.className || '';
  $('#modal-content').innerHTML = '<div class="modal-header"><h2>' + esc(title) + '</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">' + icon('close') + '</button></div><div class="modal-body">' + body + '</div><div class="modal-footer">' + footer + '</div>';
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => options.focus ? $(options.focus)?.focus() : null);
}
function taskDialog(task = null) {
  const initial=task?{title:task.title,tag:task.tag||'',goal:task.goal||'',nextAction:task.nextAction||''}:null;
  const body = '<p class="modal-subtitle">' + (task ? '把目标和下一步写清楚，工作会更容易开始。' : '一件工作，一个独立的画布。') + '</p><form id="task-form"><label class="field"><span>任务名称</span><input id="task-name-input" maxlength="120" required placeholder="例如：整理本周工作" value="' + esc(task?.title || '') + '"></label><label class="field"><span>分类</span><input id="task-tag-input" maxlength="40" placeholder="个人项目、日常工作…" value="' + esc(task?.tag || '') + '"></label><label class="field"><span>工作目标</span><textarea id="task-goal-input" maxlength="5000" placeholder="这件事完成后，你希望得到什么？">' + esc(task?.goal || '') + '</textarea></label><label class="field"><span>下一步行动</span><input id="task-next-input" maxlength="5000" placeholder="一个现在就能着手的小行动" value="' + esc(task?.nextAction || '') + '"></label></form>';
  showModal(task ? '编辑任务' : '新建任务',body,'<button class="secondary" data-close-modal>取消</button><button class="primary" type="submit" form="task-form">' + (task ? '保存修改' : '创建工作区') + '</button>',{focus:'#task-name-input'});
  $('#task-form').onsubmit = event => {
    event.preventDefault(); const title = $('#task-name-input').value.trim();
    if (!title) return $('#task-name-input').focus();
    const values = {title,tag:$('#task-tag-input').value.trim(),goal:$('#task-goal-input').value.trim(),nextAction:$('#task-next-input').value.trim()};
    if (task) {
      try {applyFormChanges(task,initial,values);}
      catch {toast('这项内容已被同时更新。弹窗输入已保留，请先复制输入，再关闭弹窗查看最新内容。',{error:true});return;}
      activity('更新任务信息',task); markChanged(); renderWorkspace();
    }
    else {
      const now = new Date().toISOString();
      const created = {id:uid(),...values,icon:'layers',status:'active',createdAt:now,updatedAt:now,nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},activity:[]};
      state.tasks.unshift(created); filter = 'all'; $('#task-search').value = ''; selectTask(created.id); activity('创建任务'); markChanged(); toast('新工作区已准备好');
    }
    $('#modal').close();
  };
}
function editNextAction() {
  const task = activeTask(); if (!task) return;
  const initial={nextAction:task.nextAction||''};
  showModal('下一步，做什么？','<p class="modal-subtitle">越具体的小行动，越容易开始。</p><form id="next-form"><label class="field"><span>下一步行动</span><textarea id="next-input" maxlength="5000" rows="3" placeholder="例如：整理三张现场截图，确认复现步骤">' + esc(task.nextAction || '') + '</textarea></label></form>','<button class="secondary" data-close-modal>取消</button><button class="primary" form="next-form" type="submit">保存</button>',{focus:'#next-input'});
  $('#next-form').onsubmit = event => {
    event.preventDefault();
    try {applyFormChanges(task,initial,{nextAction:$('#next-input').value.trim()});}
    catch {toast('下一步已被同时更新，请先复制弹窗输入，再关闭查看最新内容。',{error:true});return;}
    activity('更新下一步行动');markChanged();renderHeader();$('#modal').close();
  };
}
function edgeDialog(id) {
  const task = activeTask(), edge = task?.edges.find(e => e.id === id); if (!edge) return;
  const initial={label:edge.label||''};
  showModal('卡片之间的关联','<p class="modal-subtitle">' + esc(task.nodes.find(n=>n.id===edge.source)?.title) + ' → ' + esc(task.nodes.find(n=>n.id===edge.target)?.title) + '</p><form id="edge-form"><label class="field"><span>关系说明</span><input id="edge-label-input" maxlength="100" value="' + esc(edge.label || '') + '" placeholder="例如：参考资料、下一步、验证结果"></label></form>','<button class="secondary danger" id="remove-edge">删除连线</button><button class="primary" type="submit" form="edge-form">保存</button>',{focus:'#edge-label-input'});
  $('#edge-form').onsubmit = event => {
    event.preventDefault();
    try {applyFormChanges(edge,initial,{label:$('#edge-label-input').value.trim()});}
    catch {toast('连线说明已被同时更新，请先复制弹窗输入，再关闭查看最新内容。',{error:true});return;}
    markChanged();canvas.renderEdges();$('#modal').close();
  };
  $('#remove-edge').onclick = () => {task.edges=task.edges.filter(e=>e.id!==id);activity('移除卡片关联');markChanged();canvas.renderEdges();$('#modal').close();};
}
function previewImage(id) {
  const node = activeTask()?.nodes.find(n => n.id === id); if (!node?.assetId) return;
  showModal(node.title,'<img class="image-full" src="/api/files/' + node.assetId + '" alt="' + esc(node.title) + '">','<a class="subtle-button" href="/api/files/' + node.assetId + '?download=1">' + icon('download') + '下载原图</a>',{className:'image-modal'});
}
function download(name, bytes, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([bytes],{type:mime})), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function exportBackup() {
  try {
    toast('正在打包本机资料…');
    await flushSave().catch(() => {});
    const snapshot = structuredClone(state);
    const backup = await request('/api/backup'); backup.state = snapshot;
    download('本地工作台备份-' + new Date().toLocaleDateString('sv-SE') + '.json',JSON.stringify(backup,null,2));
    toast('备份已导出，包含文档和附件');
  } catch (error) {toast(error.message,{error:true});}
}
async function openFolder(cardId) {
  try {
    const options = {method:'POST'};
    if (typeof cardId === 'string') {
      const task = activeTask(), node = task?.nodes.find(node => node.id === cardId);
      if (!node) throw new Error('文件夹卡片不存在');
      if (node.folderPath !== undefined && !node.folderPath.trim()) {
        openEditor(cardId); $('#node-folder-input')?.focus(); toast('请先填写文件夹路径',{error:true}); return;
      }
      options.headers = {'Content-Type':'application/json'};
      options.body = JSON.stringify({taskId:task.id,cardId});
      await flushSave();
    }
    const result = await request('/api/open-folder',options);
    toast(result.foreground === false ? '文件夹已打开，请点击任务栏中的资源管理器查看' : result.foreground === true ? '文件夹已打开' : typeof cardId === 'string' ? '已请求打开文件夹' : '已请求打开本机数据文件夹');
  }
  catch(error){toast(error.message,{error:true});}
}
async function uploadFiles(files, point) {
  if (!activeTask()) return taskDialog();
  const task = activeTask(); const taskId = task.id;
  try { await flushSave(); } catch { return; }
  uploading++;
  let added = 0;
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) {toast(file.name + ' 超过 25 MB，请选择较小文件',{error:true});continue;}
    try {
      const uploaded = await request('/api/files?taskId=' + taskId + '&name=' + encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':file.type || 'application/octet-stream'},body:file});
      let type = /^image\//.test(file.type) ? 'image' : 'file', content = '', title = file.name;
      if (/\.(md|markdown)$/i.test(file.name) && file.size < 200000) {type='markdown';content=await file.text();title=file.name.replace(/\.(md|markdown)$/i,'');}
      const position = point ? {x:point.x+added*35,y:point.y+added*35} : state.activeTaskId === taskId ? canvas.newPosition() : {x:80+added*35,y:80+added*35};
      const node = {id:uid(),type,title,content,width:310,...position,assetId:uploaded.id,fileName:uploaded.name,size:uploaded.size,mime:uploaded.mime};
      task.nodes.push(node); activity('添加文件「' + file.name + '」',task); added++;
      markChanged(); renderWorkspace();
    } catch (error) {toast('添加失败：' + error.message,{error:true});}
  }
  if (added) {toast('已添加 ' + added + ' 份资料');markChanged();}
  uploading--;
}
function connectAI() {
  const url=location.origin+'/mcp';
  const config=JSON.stringify({mcpServers:{workdesk:{url}}},null,2);
  showModal('让 AI 帮你整理工作台',
    '<div class="sync-pill">本地 MCP 已随工作台启动</div><p class="modal-subtitle">把下面的地址添加到智能体的 MCP 设置，选择 Streamable HTTP。</p><div class="connection-label">本机服务地址</div><div class="connection-field">'+esc(url)+'</div><div class="connection-label">支持 URL 的客户端配置</div><pre class="connection-field">'+esc(config)+'</pre><p class="help-note">智能体可以查询、新建和更新任务，编辑文档、待办和连线，添加附件。网页空闲时约 2 秒同步；编辑器打开时暂停刷新，保护输入。</p><div class="connection-example">试着对智能体说：<br>“在本地工作台里新建一个本周工作任务，列出三个待办，再放一份会议记录文档。”</div><p class="help-note">仅支持命令的客户端可使用项目中的 mcp-stdio.mjs，连接示例见 README。连接后，你授权的智能体将能读写工作台资料。</p>',
    '<button class="secondary" id="copy-mcp-url">复制地址</button><button class="primary" id="download-mcp-config">下载配置</button>',{className:'mcp-modal'});
  $('#copy-mcp-url').onclick=async()=>{try{await navigator.clipboard.writeText(url);toast('MCP 地址已复制');}catch{toast('请选中地址复制');}};
  $('#download-mcp-config').onclick=()=>download('workdesk-mcp.json',config);
}
function help() {
  showModal('让工作，慢慢有序','<p class="modal-subtitle">每个任务都有自己的画布，所有内容保存在本机。</p>' + [
    ['新建任务','N'],['搜索任务或卡片','/'],['添加卡片','底部工具栏'],['编辑卡片','双击卡片'],['移动卡片','拖动卡片'],['移动画布','拖动空白处 / 滚轮'],['缩放画布','Ctrl + 滚轮'],['建立关联','卡片右侧圆点 → 目标卡片'],['粘贴截图','Ctrl + V'],['取消选择或连线','Esc'],['保存当前更改','Ctrl + S']
  ].map(([name,key])=>'<div class="help-row"><strong>'+name+'</strong><kbd>'+key+'</kbd></div>').join('')+'<p class="help-note">文件也可以直接拖到画布里，单个附件最大 25 MB。<br>左下角菜单可打开数据文件夹、导出包含附件的备份。<br>首版用于手动组织工作，连线表示关联关系。</p>','<button class="primary" data-close-modal>开始整理</button>');
}
function showHistory() {
  if (inspectorMode === 'history' && !$('#inspector').classList.contains('hidden')) return closeInspector();
  inspectorMode = 'history'; $('#inspector').classList.remove('hidden');
  const items = activeTask()?.activity || [];
  $('#inspector').innerHTML = '<div class="inspector-header"><span class="inspector-type">' + icon('history') + '任务动态</span><button class="icon-button" id="close-inspector" aria-label="关闭动态">' + icon('close') + '</button></div><div class="inspector-main">' +
    (items.length ? items.map(item=>'<div class="activity-item"><strong>'+esc(item.text)+'</strong><small>'+new Date(item.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+'</small></div>').join('') : '<div class="activity-empty">从第一个行动开始，留下工作足迹。</div>') + '</div>';
}

// Task navigation and global controls.
$('#task-list').addEventListener('click', event => {const entry=event.target.closest('[data-task]');if(entry)selectTask(entry.dataset.task);});
$('#task-search').addEventListener('input',renderSidebar);
$$('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;renderSidebar();});
$('#new-task').onclick = $('#new-task-small').onclick = () => taskDialog();
$('#mobile-menu').onclick = () => $('#sidebar').classList.toggle('open');
$('#edit-task').onclick = () => taskDialog(activeTask());
$('#task-title').ondblclick = () => taskDialog(activeTask());
$('#next-action').onclick = editNextAction;
$('#task-menu').onclick = () => taskMenu();
$('#task-status').onclick = () => taskMenu($('#task-status'));
$('#canvas-view').onclick = () => setView('canvas');
$('#list-view').onclick = () => setView('list');
$('#zoom-in').onclick = () => canvas.zoom(1.15);
$('#zoom-out').onclick = () => canvas.zoom(1 / 1.15);
$('#zoom-value').onclick = () => {const task=activeTask();if(task)canvas.zoom(1/task.viewport.zoom);};
$('#fit-content').onclick = () => canvas.fit();
$('#cancel-connection').onclick = cancelConnection;
$('#save-status').onclick = () => lastError?.status===409?showConflict():flushSave().catch(()=>{});
$('#mcp-button').onclick = connectAI;
$('#toggle-task-details').onclick = () => {
  const button=$('#toggle-task-details'),open=button.getAttribute('aria-expanded')!=='true';
  button.setAttribute('aria-expanded',String(open));button.title=open?'收起任务说明':'展开任务说明';$('#task-goal').classList.toggle('hidden',!open);
};
$('#help-button').onclick = help;
$('#history-button').onclick = showHistory;
$('#empty-add').onclick = () => addNode('todo');
$('#workspace-menu').onclick = () => popover($('#workspace-menu'),[
  {caption:'本地工作空间'},{label:'连接 AI · 本地 MCP',icon:'bolt',action:connectAI},{label:'打开数据文件夹',icon:'folder',action:openFolder},{label:'导出完整备份',icon:'download',action:exportBackup},null,{label:'使用帮助',icon:'help',action:help}
]);
$$('[data-add]').forEach(button=>button.onclick=()=>addNode(button.dataset.add));
$('#add-folder').onclick = () => { addNode('link',undefined,{title:'本地文件夹',localFolder:true,folderPath:''}); $('#node-folder-input')?.focus(); };
$('#add-file').onclick = () => $('#file-input').click();
$('#add-image').onclick = () => $('#image-input').click();
[$('#file-input'),$('#image-input')].forEach(input=>input.onchange=()=>{uploadFiles([...input.files]);input.value='';});
$('#modal').addEventListener('click',event=>{if(event.target.closest('[data-close-modal]') || event.target===$('#modal'))$('#modal').close();});
document.addEventListener('pointerdown',event=>{
  if (!event.target.closest('#popover,#task-menu,#task-status,#workspace-menu,[data-node-menu]')) closePopover();
  if(innerWidth<=600 && $('#sidebar').classList.contains('open') && !event.target.closest('#sidebar,#mobile-menu'))$('#sidebar').classList.remove('open');
});

// Card actions are shared between the canvas, list and editor.
document.addEventListener('click',event=>{
  const target = event.target, card = target.closest('.node');
  const find = selector => target.closest(selector);
  if (find('[data-connect]')) return startConnection(find('[data-connect]').dataset.connect);
  if (find('[data-node-menu]')) return nodeMenu(find('[data-node-menu]'),find('[data-node-menu]').dataset.nodeMenu);
  if (find('[data-edit]')) {event.preventDefault();return openEditor(find('[data-edit]').dataset.edit);}
  if (find('[data-preview]')) return previewImage(find('[data-preview]').dataset.preview);
  if (find('[data-folder]')) return openFolder(find('[data-folder]').dataset.folder);
  if (card && connecting && !target.closest('a,button')) return finishConnection(card.dataset.id);
  if (find('.edge-group')) return edgeDialog(find('.edge-group').dataset.edge);
  if (find('[data-toggle]') && card) {
    const node=activeTask().nodes.find(n=>n.id===card.dataset.id), item=node.items.find(i=>i.id===find('[data-toggle]').dataset.toggle);
    item.done=!item.done;activity((item.done?'完成':'重新打开')+'待办「'+item.text+'」');markChanged();refreshNode(node.id);
    if(inspectorMode==='node' && selected===node.id)renderInspector();return;
  }
  if (find('#close-inspector')) return closeInspector();
  if (find('#delete-node')) return deleteNode(selected);
  if (find('#connect-from-editor')) return startConnection(selected);
  if (find('[data-editor-tab]')) {editorTab=find('[data-editor-tab]').dataset.editorTab;renderInspector();return;}
  if (find('[data-color]')) {activeNode().color=find('[data-color]').dataset.color;markChanged();refreshNode();renderInspector();return;}
  if (find('[data-editor-toggle]')) {
    const item=activeNode().items.find(i=>i.id===find('[data-editor-toggle]').dataset.editorToggle);item.done=!item.done;markChanged();refreshNode();renderInspector();return;
  }
  if (find('[data-remove-item]')) {const node=activeNode();node.items=node.items.filter(i=>i.id!==find('[data-remove-item]').dataset.removeItem);markChanged();refreshNode();renderInspector();return;}
  if (find('#add-todo-item')) {activeNode().items.push({id:uid(),text:'',done:false});markChanged();refreshNode();renderInspector();$$('[data-item-input]').at(-1)?.focus();return;}
  if (find('#download-md')) {const node=activeNode();return download(node.title.replace(/[\\/:*?"<>|]/g,'_')+'.md',node.content,'text/markdown;charset=utf-8');}
  if (card && !canvas.wasDragged) selectNode(card.dataset.id);
});
$('#list-surface').addEventListener('dblclick',event=>{const card=event.target.closest('.node');if(card&&!event.target.closest('button,a'))openEditor(card.dataset.id);});
$('#inspector').addEventListener('input',event=>{
  const node=activeNode();if(!node||inspectorMode!=='node')return;
  if(event.target.id==='node-title-input')node.title=event.target.value;
  else if(event.target.id==='node-content-input')node.content=event.target.value;
  else if(event.target.id==='node-url-input')node.url=event.target.value;
  else if(event.target.id==='node-folder-input')node.folderPath=event.target.value;
  else if(event.target.dataset.itemInput){const item=node.items.find(i=>i.id===event.target.dataset.itemInput);if(item)item.text=event.target.value;}
  else return;
  markChanged();refreshNode();
});
$('#inspector').addEventListener('compositionstart',()=>{composing=true;clearTimeout(saveTimer);});
$('#inspector').addEventListener('compositionend',()=>{finishComposition();if(dirty)markChanged();});
$('#inspector').addEventListener('change',event=>{
  if (event.target.id === 'node-link-kind') {
    const node=activeNode(); if (!node || node.type!=='link') return;
    node.localFolder=event.target.value==='folder';
    if (node.localFolder) node.folderPath ??= '';
    markChanged(); refreshNode(); renderInspector();
    $(node.localFolder?'#node-folder-input':'#node-url-input')?.focus();
  }
  if(event.target.id==='node-url-input'&&event.target.value&&!safeURL(event.target.value))toast('请填写以 http:// 或 https:// 开头的链接',{error:true});
});

// Drag-and-drop and clipboard attachment capture.
let dragDepth=0;
$('#workspace').addEventListener('dragenter',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth++;$('#drop-overlay').classList.remove('hidden');}});
$('#workspace').addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
$('#workspace').addEventListener('dragleave',event=>{if(event.dataTransfer.types.includes('Files')&&--dragDepth<=0){dragDepth=0;$('#drop-overlay').classList.add('hidden');}});
$('#workspace').addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('#drop-overlay').classList.add('hidden');if(event.dataTransfer.files.length)uploadFiles([...event.dataTransfer.files],activeTask()?canvas.point(event.clientX,event.clientY):null);});
document.addEventListener('paste',event=>{
  if(event.target.closest('input,textarea,[contenteditable="true"]'))return;
  const images=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
  if(images.length){event.preventDefault();uploadFiles(images.map((file,i)=>new File([file],'截图-'+new Date().toLocaleString('sv-SE').replace(/[: ]/g,'-')+'-'+(i+1)+'.png',{type:file.type})));}
});
document.addEventListener('keydown',event=>{
  const editing=event.target.closest('input,textarea,select,[contenteditable="true"]');
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();flushSave().then(()=>toast('已保存到本机')).catch(()=>{});return;}
  if(event.key==='Escape'){cancelConnection();closePopover();if(!$('#modal').open)closeInspector();selectNode(null);return;}
  if(editing||$('#modal').open)return;
  if(event.key.toLowerCase()==='n'&&!event.ctrlKey&&!event.metaKey){event.preventDefault();taskDialog();}
  else if(event.key==='/'){event.preventDefault();$('#task-search').focus();}
  else if(event.key==='Enter'&&selected){event.preventDefault();openEditor(selected);}
  else if((event.key==='Delete'||event.key==='Backspace')&&selected){event.preventDefault();deleteNode(selected);}
});
window.addEventListener('beforeunload',event=>{if(dirty||saving){event.preventDefault();event.returnValue='';}});

try {
  state=await request('/api/state');savedBase=structuredClone(state);
  if(!state.tasks.some(t=>t.id===state.activeTaskId))state.activeTaskId=state.tasks[0]?.id||null;
  renderWorkspace();updateSaveStatus();
  setInterval(syncRemote,2000);
  window.addEventListener('focus',syncRemote);
  if(state.revision===0 && activeTask()?.id==='task-welcome') {
    requestAnimationFrame(()=>{
      const task=activeTask(), width=$('#canvas').clientWidth;
      if(width<950){
        const positions=width<600?[[40,65],[390,65],[40,435],[390,370],[40,715],[390,700]]:[[40,65],[420,65],[800,65],[40,395],[420,395],[800,370]];
        task.nodes.forEach((node,i)=>{node.x=positions[i][0];node.y=positions[i][1];});
      }
      task.viewport.zoom=width<600?Math.min(1,(width-45)/700):Math.min(1,(width-60)/1125);
      task.viewport.x=0;task.viewport.y=0;canvas.render();
    });
  }
} catch(error) {
  $('#workspace').innerHTML='<div class="loading-error"><div><h2>暂时无法打开工作台</h2><p>'+esc(error.message)+'</p><button class="primary" id="reload-app">重新连接</button></div></div>';
  $('#reload-app').onclick=()=>location.reload();
  $('#save-status').innerHTML=icon('help')+'<span>连接失败</span>';
}
