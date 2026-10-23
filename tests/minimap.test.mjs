import test from 'node:test';
import assert from 'node:assert/strict';
import {Minimap,minimapLayout} from '../public/minimap.js';
import {setLanguage} from '../public/i18n.js';

const size = {width:800,height:600};
const project = (map,point) => ({x:map.x+point.x*map.scale,y:map.y+point.y*map.scale});
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('小地图包含负坐标、远处卡片、实际高度及当前视口，映射可逆',()=>{
  const nodes = [{id:'a',x:-800,y:-300,width:300},{id:'b',x:3000,y:2400,width:320}];
  const view = {x:350,y:-200,zoom:.5};
  const map = minimapLayout(nodes,view,size,216,132,new Map([['b',700]]));
  assert.equal(map.cards[1].height,700);
  assert.deepEqual(map.visible,{x:-700,y:400,width:1600,height:1200});
  for(const box of [...map.cards,map.visible]) {
    const start=project(map,box),end=project(map,{x:box.x+box.width,y:box.y+box.height});
    assert.ok(start.x>=12-1e-7 && start.y>=12-1e-7);
    assert.ok(end.x<=204+1e-7 && end.y<=120+1e-7);
    near((start.x-map.x)/map.scale,box.x);
    near((start.y-map.y)/map.scale,box.y);
  }
});

test('平移到内容外及改变缩放/面板尺寸时，视口仍在小地图内',()=>{
  const nodes = [{id:'a',x:0,y:0,width:300}];
  for(const zoom of [.2,1,2])for(const canvasSize of [size,{width:360,height:480}]) {
    const map=minimapLayout(nodes,{x:-15000,y:19000,zoom},canvasSize,156,96);
    const start=project(map,map.visible),end=project(map,{x:map.visible.x+map.visible.width,y:map.visible.y+map.visible.height});
    assert.ok(start.x>=0 && start.y>=0 && end.x<=156 && end.y<=96);
    near(map.visible.width,canvasSize.width/zoom);
  }
  assert.equal(minimapLayout([],null,size,216,132),null);
  assert.equal(minimapLayout([],{x:0,y:0,zoom:1},{width:0,height:600},216,132),null);
});

function element(rect={left:10,top:20,width:216,height:132}) {
  const classes=new Set(),attrs=new Map(),captures=new Set(),events=new Map();
  return {
    classList:{contains:name=>classes.has(name),toggle(name,on){if(on)classes.add(name);else classes.delete(name);}},
    addEventListener(name,fn){events.set(name,fn);},emit(name,event){events.get(name)?.(event);},
    setAttribute(name,value){attrs.set(name,value);},getAttribute:name=>attrs.get(name),
    getBoundingClientRect:()=>rect,focus(){},innerHTML:'',
    setPointerCapture:id=>captures.add(id),releasePointerCapture:id=>captures.delete(id),hasPointerCapture:id=>captures.has(id)
  };
}
function fixture(t) {
  const original={window:globalThis.window,ResizeObserver:globalThis.ResizeObserver,requestAnimationFrame:globalThis.requestAnimationFrame};
  const frames=[],windowEl=element();let nextFrame=0;
  globalThis.window=windowEl;globalThis.ResizeObserver=class {observe(){}};
  globalThis.requestAnimationFrame=fn=>{frames.push(fn);return ++nextFrame;};
  t.after(()=>{for(const [name,value] of Object.entries(original)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}});
  setLanguage('en');
  let task={nodes:[{id:'a',type:'markdown',title:'User <script> & 中文',x:100,y:200,width:300},{id:'b',type:'note',color:'yellow',title:'Far away',x:2000,y:1000,width:320}],edges:[{source:'a',target:'b'}],viewport:{x:0,y:0,zoom:.5}};
  const initialNodes=structuredClone(task.nodes),root=element(),surface=element(),toggle=element(),el=element();
  el.clientWidth=size.width;el.clientHeight=size.height;
  let changes=0,otherGesture=false,connecting=false,map;
  const canvas={el,nodesEl:{querySelectorAll:()=>task.nodes.map(node=>({dataset:{id:node.id},offsetHeight:240}))},getTask:()=>task,selected:'a',isConnecting:()=>connecting,onChange:()=>changes++,updateTransform:()=>map.update(),get interacting(){return otherGesture||!!map?.drag;}};
  map=new Minimap({canvas,root,surface,toggle});
  const flush=()=>{while(frames.length)frames.shift()();};flush();
  const event=(x,y,extra={})=>({button:0,pointerId:1,clientX:x+10,clientY:y+20,preventDefault(){this.defaultPrevented=true;},...extra});
  return {map,canvas,root,surface,toggle,task,initialNodes,windowEl,event,flush,changes:()=>changes,switchTask:next=>{task=next;},setOtherGesture:value=>{otherGesture=value;},setConnecting:value=>{connecting=value;}};
}

test('点击远处卡片跳转至该处，保持缩放、卡片与连线不变且只保存一次',t=>{
  const f=fixture(t),map=f.map.layout,point=project(map,{x:2160,y:1120});
  f.map.pointerDown(f.event(point.x,point.y));
  assert.equal(f.canvas.interacting,true);assert.equal(f.surface.hasPointerCapture(1),true);
  near(-f.task.viewport.x/.5+400/.5,2160);near(-f.task.viewport.y/.5+300/.5,1120);
  f.surface.emit('pointerup',f.event(point.x,point.y));f.flush();
  assert.equal(f.changes(),1);assert.equal(f.map.drag,null);assert.equal(f.surface.hasPointerCapture(1),false);
  assert.deepEqual(f.task.nodes,f.initialNodes);assert.equal(f.task.viewport.zoom,.5);assert.equal(f.task.edges.length,1);
  assert.match(f.surface.innerHTML,/&lt;script&gt; &amp; 中文/);
  assert.doesNotMatch(f.surface.innerHTML,/<script>/);
  assert.match(f.surface.innerHTML,/<line /);
});

test('拖动视口保持按下处偏移，固定映射避免反馈漂移；以松开位置结束',t=>{
  const f=fixture(t),box=f.map.viewport;
  const start={x:box.x+box.width*.25,y:box.y+box.height*.25};
  f.map.pointerDown(f.event(start.x,start.y));
  const map=f.map.drag.layout;
  assert.deepEqual(f.task.viewport,{x:0,y:0,zoom:.5});
  f.map.pointerMove(f.event(start.x+10,start.y+6));f.flush();
  assert.equal(f.map.layout,map);
  near(f.task.viewport.x,-10/map.scale*.5);near(f.task.viewport.y,-6/map.scale*.5);
  assert.equal(f.changes(),0);
  f.surface.emit('pointerup',f.event(start.x+20,start.y+10));f.flush();
  near(f.task.viewport.x,-20/map.scale*.5);near(f.task.viewport.y,-10/map.scale*.5);
  assert.equal(f.changes(),1);assert.notEqual(f.map.layout,map);
});

test('轻点视口不改变位置；不同指针、已有拖动及连接模式不会接管手势',t=>{
  const f=fixture(t),box=f.map.viewport,point={x:box.x+box.width/2,y:box.y+box.height/2};
  f.setOtherGesture(true);f.map.pointerDown(f.event(point.x,point.y));assert.equal(f.map.drag,null);
  f.setOtherGesture(false);f.setConnecting(true);f.map.pointerDown(f.event(point.x,point.y));assert.equal(f.map.drag,null);
  f.setConnecting(false);f.map.pointerDown(f.event(point.x,point.y));
  f.map.pointerMove(f.event(point.x+30,point.y,{pointerId:2}));
  f.map.endDrag({pointerId:2});assert.ok(f.map.drag);
  f.surface.emit('pointerup',f.event(point.x+1,point.y+1));
  assert.deepEqual(f.task.viewport,{x:0,y:0,zoom:.5});assert.equal(f.changes(),0);
});

test('取消、失焦及切换任务释放捕获，不会修改新任务',t=>{
  const f=fixture(t),box=f.map.viewport,point={x:box.x+box.width/2,y:box.y+box.height/2};
  for(const reason of ['pointercancel','lostpointercapture','blur','Escape']) {
    f.map.pointerDown(f.event(point.x,point.y));f.map.pointerMove(f.event(point.x+8,point.y));
    if(reason==='blur')f.windowEl.emit('blur');
    else if(reason==='Escape')f.map.keyDown({key:'Escape',preventDefault(){}});
    else f.surface.emit(reason,{pointerId:1});
    assert.equal(f.map.drag,null);assert.equal(f.surface.hasPointerCapture(1),false);f.flush();
  }
  const before=f.changes();f.map.pointerDown(f.event(point.x,point.y));
  const next={nodes:[],edges:[],viewport:{x:99,y:88,zoom:1}};f.switchTask(next);
  f.map.pointerMove(f.event(point.x+20,point.y));f.flush();
  assert.equal(f.map.drag,null);assert.deepEqual(next.viewport,{x:99,y:88,zoom:1});assert.equal(f.changes(),before);
  assert.equal(f.root.classList.contains('hidden'),true);
});

test('列表/空任务不显示小地图，折叠与中英文标签正确，方向键只移动视口',t=>{
  const f=fixture(t);
  f.toggle.emit('click');f.flush();assert.equal(f.root.classList.contains('minimap-collapsed'),true);assert.equal(f.toggle.getAttribute('aria-expanded'),'false');assert.equal(f.toggle.title,'Expand minimap');
  setLanguage('zh-CN');f.toggle.emit('click');f.flush();assert.equal(f.toggle.title,'收起小地图');
  const key={key:'ArrowRight',preventDefault(){this.defaultPrevented=true;}};f.map.keyDown(key);f.flush();
  assert.equal(key.defaultPrevented,true);assert.equal(f.task.viewport.x,-160);assert.equal(f.task.viewport.zoom,.5);
  assert.deepEqual(f.task.nodes,f.initialNodes);
  f.canvas.el.classList.toggle('hidden',true);f.map.update();f.flush();assert.equal(f.root.classList.contains('hidden'),true);
  setLanguage('en');
});
