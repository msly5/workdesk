import {t} from './i18n.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// Include both the cards and the visible canvas, so the viewport remains visible
// even after panning away from all content. All coordinates here are world units.
export function minimapLayout(nodes, view, size, width, height, heights = new Map()) {
  if (!view || view.zoom <= 0 || size.width <= 0 || size.height <= 0 || width <= 24 || height <= 24) return null;
  const visible = {x:-view.x/view.zoom,y:-view.y/view.zoom,width:size.width/view.zoom,height:size.height/view.zoom};
  const cards = nodes.map(node=>({id:node.id,title:node.title,type:node.type,color:node.color,x:node.x,y:node.y,width:node.width || 310,height:heights.get(node.id) || 200}));
  const left = Math.min(visible.x,...cards.map(node=>node.x));
  const top = Math.min(visible.y,...cards.map(node=>node.y));
  const right = Math.max(visible.x+visible.width,...cards.map(node=>node.x+node.width));
  const bottom = Math.max(visible.y+visible.height,...cards.map(node=>node.y+node.height));
  const scale = Math.min((width-24)/(right-left),(height-24)/(bottom-top));
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x = (width-(right-left)*scale)/2-left*scale;
  const y = (height-(bottom-top)*scale)/2-top*scale;
  return {width,height,scale,x,y,cards,visible};
}

export class Minimap {
  constructor({canvas,root,surface,toggle}) {
    this.canvas = canvas;
    this.root = root ?? document.querySelector('#minimap');
    this.surface = surface ?? document.querySelector('#minimap-surface');
    this.toggle = toggle ?? document.querySelector('#toggle-minimap');
    this.drag = null;
    this.collapsed = false;
    this.surface.addEventListener('pointerdown',event=>this.pointerDown(event));
    this.surface.addEventListener('pointermove',event=>this.pointerMove(event));
    this.surface.addEventListener('pointerup',event=>{
      this.pointerMove(event);
      this.endDrag(event);
    });
    for (const type of ['pointercancel','lostpointercapture']) this.surface.addEventListener(type,event=>this.endDrag(event));
    window.addEventListener('blur',()=>this.endDrag());
    this.surface.addEventListener('keydown',event=>this.keyDown(event));
    // Keep card shortcuts (Enter/Delete) from acting on a selected card while
    // keyboard focus is inside this navigation control.
    this.root.addEventListener('keydown',event=>{
      if (event.defaultPrevented || ['Enter',' ','Delete','Backspace','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) event.stopPropagation();
    });
    this.toggle.addEventListener('click',()=>{
      this.endDrag();
      this.collapsed = !this.collapsed;
      this.update();
    });
    new ResizeObserver(()=>this.update()).observe(this.surface);
    this.update();
  }
  update() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(()=>{
      this.frame = null;
      this.render();
    });
  }
  render() {
    const task = this.canvas.getTask();
    const hidden = !task || !task.nodes.length || this.canvas.el.classList.contains('hidden');
    if (this.drag && (hidden || task !== this.drag.task)) this.endDrag();
    this.root.classList.toggle('hidden',hidden);
    this.root.classList.toggle('minimap-collapsed',this.collapsed);
    const label = t(this.collapsed?'展开小地图':'收起小地图');
    this.toggle.setAttribute('aria-label',label);
    this.toggle.title = label;
    this.toggle.setAttribute('aria-expanded',String(!this.collapsed));
    this.toggle.textContent = this.collapsed ? '+' : '−';
    if (hidden || this.collapsed) return;
    const rect = this.surface.getBoundingClientRect();
    const heights = new Map([...this.canvas.nodesEl.querySelectorAll('.node')].map(el=>[el.dataset.id,el.offsetHeight]));
    // Freeze the mapping during a gesture; recomputing bounds while dragging
    // the viewport would move the map underneath the pointer.
    this.layout = this.drag?.layout ?? minimapLayout(task.nodes,task.viewport,{width:this.canvas.el.clientWidth,height:this.canvas.el.clientHeight},rect.width,rect.height,heights);
    const map = this.layout;
    if (!map) {this.surface.innerHTML='';return;}
    this.surface.setAttribute('viewBox','0 0 '+map.width+' '+map.height);
    const byId = new Map(map.cards.map(node=>[node.id,node]));
    const edges = task.edges.map(edge=>{
      const a = byId.get(edge.source), b = byId.get(edge.target);
      if (!a || !b) return '';
      const right = b.x >= a.x+a.width/2;
      const x1 = map.x+(a.x+(right?a.width:0))*map.scale, x2 = map.x+(b.x+(right?0:b.width))*map.scale;
      const y1 = map.y+(a.y+29)*map.scale, y2 = map.y+(b.y+29)*map.scale;
      return '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'"/>';
    }).join('');
    const cards = map.cards.map(node=>{
      const kind = ['markdown','todo','note','image','link','file'].includes(node.type)?node.type:'file';
      const color = ['yellow','blue','green','pink'].includes(node.color)?node.color:'yellow';
      return '<rect class="minimap-card '+kind+(kind==='note'?' '+color:'')+(node.id===this.canvas.selected?' selected':'')+'" x="'+(map.x+node.x*map.scale)+'" y="'+(map.y+node.y*map.scale)+'" width="'+Math.max(2,node.width*map.scale)+'" height="'+Math.max(2,node.height*map.scale)+'" rx="2"><title>'+escape(node.title)+'</title></rect>';
    }).join('');
    const view = task.viewport;
    const viewport = {x:map.x-view.x/view.zoom*map.scale,y:map.y-view.y/view.zoom*map.scale,width:this.canvas.el.clientWidth/view.zoom*map.scale,height:this.canvas.el.clientHeight/view.zoom*map.scale};
    this.viewport = viewport;
    this.surface.innerHTML = '<g class="minimap-edges" aria-hidden="true">'+edges+'</g><g aria-hidden="true">'+cards+'</g><rect class="minimap-viewport" aria-hidden="true" x="'+viewport.x+'" y="'+viewport.y+'" width="'+viewport.width+'" height="'+viewport.height+'" rx="2"/>';
  }
  point(event, map) {
    const rect = this.surface.getBoundingClientRect();
    return {x:Math.max(0,Math.min(map.width,(event.clientX-rect.left)/rect.width*map.width)),y:Math.max(0,Math.min(map.height,(event.clientY-rect.top)/rect.height*map.height))};
  }
  pointerDown(event) {
    if (event.button !== 0 || this.canvas.interacting || this.canvas.isConnecting() || this.collapsed || !this.layout) return;
    const task = this.canvas.getTask();
    if (!task?.nodes.length) return;
    event.preventDefault();
    this.surface.focus({preventScroll:true});
    // Bring pending pan/resize updates into the same coordinate system as this
    // press before taking the fixed mapping for the gesture.
    this.render();
    const map = this.layout;
    if (!map) return;
    const point = this.point(event,map), box = this.viewport;
    const inside = point.x >= box.x && point.x <= box.x+box.width && point.y >= box.y && point.y <= box.y+box.height;
    const before = {x:task.viewport.x,y:task.viewport.y};
    if (!inside) {
      task.viewport.x = this.canvas.el.clientWidth/2-(point.x-map.x)/map.scale*task.viewport.zoom;
      task.viewport.y = this.canvas.el.clientHeight/2-(point.y-map.y)/map.scale*task.viewport.zoom;
    }
    this.drag = {task,layout:map,pointerId:event.pointerId,start:point,view:{x:task.viewport.x,y:task.viewport.y},moved:before.x!==task.viewport.x || before.y!==task.viewport.y};
    this.surface.setPointerCapture(event.pointerId);
    this.canvas.updateTransform();
  }
  pointerMove(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (this.canvas.getTask() !== drag.task) {this.endDrag();return;}
    event.preventDefault();
    const point = this.point(event,drag.layout);
    const dx = point.x-drag.start.x, dy = point.y-drag.start.y;
    if (Math.hypot(dx,dy) < 3 && !drag.panning) return;
    drag.panning = true;
    const view = drag.task.viewport;
    view.x = drag.view.x-dx/drag.layout.scale*view.zoom;
    view.y = drag.view.y-dy/drag.layout.scale*view.zoom;
    drag.moved = true;
    this.canvas.updateTransform();
  }
  endDrag(event) {
    const drag = this.drag;
    if (!drag || event && event.pointerId !== drag.pointerId) return;
    this.drag = null;
    if (this.surface.hasPointerCapture(drag.pointerId)) this.surface.releasePointerCapture(drag.pointerId);
    if (drag.moved && this.canvas.getTask() === drag.task) this.canvas.onChange();
    this.update();
  }
  keyDown(event) {
    if (event.key === 'Escape') {if(this.drag){event.preventDefault();this.endDrag();}return;}
    const direction = {ArrowLeft:[1,0],ArrowRight:[-1,0],ArrowUp:[0,1],ArrowDown:[0,-1]}[event.key];
    const task = this.canvas.getTask();
    if (!direction || !task || this.canvas.interacting || this.canvas.isConnecting() || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const distance = event.shiftKey ? .6 : .2;
    task.viewport.x += direction[0]*this.canvas.el.clientWidth*distance;
    task.viewport.y += direction[1]*this.canvas.el.clientHeight*distance;
    this.canvas.updateTransform();
    this.canvas.onChange();
  }
}
