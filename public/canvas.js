import {t,formatNumber} from './i18n.js';

const INTERACTIVE = 'button,a,input,textarea,select,[contenteditable]:not([contenteditable="false"]),.edge-group';

export class Canvas {
  get interacting() { return !!this.drag || !!this.minimap?.drag; }
  constructor(options) {
    Object.assign(this, options);
    this.el = document.querySelector('#canvas');
    this.world = document.querySelector('#canvas-world');
    this.nodesEl = document.querySelector('#nodes');
    this.paths = document.querySelector('#edge-paths');
    this.drag = null;
    this.el.addEventListener('pointerdown', event => this.pointerDown(event));
    this.el.addEventListener('pointermove', event => this.pointerMove(event));
    this.el.addEventListener('pointerup', event => this.pointerUp(event));
    this.el.addEventListener('pointercancel', event => this.pointerUp(event));
    this.el.addEventListener('lostpointercapture', event => this.pointerUp(event));
    window.addEventListener('blur', () => {
      if (this.drag) this.pointerUp({ pointerId: this.drag.pointerId });
    });
    this.el.addEventListener('click', event => {
      if (this.wasDragged) { event.preventDefault(); event.stopPropagation(); }
    }, true);
    this.el.addEventListener('auxclick', event => {
      // The middle button pans even over a card or link.
      if (event.button === 1) event.preventDefault();
    });
    this.el.addEventListener('wheel', event => this.wheel(event), { passive: false });
    this.el.addEventListener('dblclick', event => {
      const node = event.target.closest('.node');
      if (node && !this.wasDragged && !event.target.closest(INTERACTIVE)) this.onEdit(node.dataset.id);
    });
    new ResizeObserver(() => this.updateTransform()).observe(this.el);
    new ResizeObserver(() => this.renderEdges()).observe(this.nodesEl);
  }
  render() {
    this.minimap?.endDrag();
    if (this.drag) this.pointerUp({ pointerId: this.drag.pointerId });
    const task = this.getTask();
    this.nodesEl.innerHTML = task ? task.nodes.map(node => this.renderCard(node)).join('') : '';
    this.updateTransform();
    requestAnimationFrame(() => this.renderEdges());
    this.nodesEl.querySelectorAll('img').forEach(img => img.addEventListener('load', () => this.renderEdges(), { once: true }));
  }
  refreshNode(id) {
    const node = this.getTask()?.nodes.find(n => n.id === id);
    const el = this.nodesEl.querySelector('[data-id="' + id + '"]');
    if (!node || !el) return;
    if (this.drag?.node?.id === id) this.pointerUp({ pointerId: this.drag.pointerId });
    const fragment = document.createElement('template'); fragment.innerHTML = this.renderCard(node);
    el.replaceWith(fragment.content.firstElementChild);
    this.select(this.selected);
    requestAnimationFrame(() => this.renderEdges());
  }
  select(id) {
    this.selected = id;
    this.nodesEl.querySelectorAll('.node').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
    this.minimap?.update();
  }
  updateTransform() {
    const view = this.getTask()?.viewport;
    if (!view) return;
    this.world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')';
    this.el.parentElement.style.backgroundPosition = view.x + 'px ' + view.y + 'px';
    this.el.parentElement.style.backgroundSize = 20 * view.zoom + 'px ' + 20 * view.zoom + 'px';
    document.querySelector('#zoom-value').textContent = formatNumber(view.zoom,{style:'percent',maximumFractionDigits:0});
    this.minimap?.update();
  }
  renderEdges() {
    this.minimap?.update();
    const task = this.getTask();
    if (!task) { this.paths.innerHTML = ''; return; }
    this.paths.innerHTML = task.edges.map(edge => {
      const a = task.nodes.find(n => n.id === edge.source), b = task.nodes.find(n => n.id === edge.target);
      if (!a || !b) return '';
      let x1, x2;
      if (b.x >= a.x + a.width / 2) { x1 = a.x + a.width; x2 = b.x; }
      else { x1 = a.x; x2 = b.x + b.width; }
      const y1 = a.y + 29, y2 = b.y + 29;
      const curve = Math.max(35, Math.abs(x2 - x1) * .48), direction = x2 >= x1 ? 1 : -1;
      const d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + curve * direction) + ' ' + y1 + ', ' + (x2 - curve * direction) + ' ' + y2 + ', ' + x2 + ' ' + y2;
      const label = this.escape(edge.label || '');
      const description=label || this.escape(t('点击编辑卡片关联'));
      return '<g class="edge-group" data-edge="' + edge.id + '" aria-label="' + this.escape(t('卡片关联')) + '"><title>'+description+'</title><path class="edge-hit" d="' + d + '"/><path class="edge-path" d="' + d + '"/>' + (label ? '<text class="edge-label" x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 - 10) + '" text-anchor="middle">' + label + '</text>' : '') + '</g>';
    }).join('') + this.connectionPreview();
  }
  connectionPreview() {
    const drag = this.drag;
    if (drag?.kind !== 'connection' || !drag.moved) return '';
    const source = drag.task.nodes.find(node => node.id === drag.source);
    if (!source) return '';
    const target = drag.task.nodes.find(node => node.id === drag.target);
    const x1 = source.x + source.width, y1 = source.y + 29;
    const x2 = target ? (target.x >= x1 ? target.x : target.x + target.width) : drag.point.x;
    const y2 = target ? target.y + 29 : drag.point.y;
    const curve = Math.max(35, Math.abs(x2 - x1) * .48);
    return '<path class="edge-preview" d="M ' + x1 + ' ' + y1 + ' C ' + (x1 + curve) + ' ' + y1 + ', ' + (x2 - curve) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '"/>';
  }
  connectionTarget(event, drag) {
    const el = document.elementFromPoint(event.clientX, event.clientY)?.closest('.node');
    const id = el?.dataset.id;
    return el && this.nodesEl.contains(el) && id !== drag.source && drag.task.nodes.some(node => node.id === id) ? id : null;
  }
  cancelConnectionDrag() {
    if (this.drag?.kind === 'connection') this.pointerUp({ pointerId:this.drag.pointerId, type:'pointercancel' });
  }
  pointerDown(event) {
    if (this.interacting || (event.button !== 0 && event.button !== 1)) return;
    const task = this.getTask(); if (!task) return;
    const handle = event.button === 0 ? event.target.closest('[data-connect]') : null;
    if (handle && task.nodes.some(node => node.id === handle.dataset.connect)) {
      event.preventDefault();
      this.onConnectionStart(handle.dataset.connect);
      this.drag = { kind:'connection', task, source:handle.dataset.connect, captureEl:this.el, pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, moved:false, target:null, point:this.point(event.clientX,event.clientY) };
      this.el.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button === 0 && (this.isConnecting() || event.target.closest(INTERACTIVE))) return;
    const nodeEl = event.button === 0 ? event.target.closest('.node') : null;
    const node = nodeEl ? task.nodes.find(n => n.id === nodeEl.dataset.id) : null;
    if (event.button === 0) {
      this.onSelect(node?.id ?? null);
      nodeEl?.focus({ preventScroll: true });
    }
    // Prevent native text/image dragging before it starts. Capture the card itself
    // so an ordinary double click still targets that card and opens its editor.
    event.preventDefault();
    const captureEl = nodeEl || this.el;
    this.drag = { task, captureEl, pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, moved:false, node, nodeEl, x:node ? node.x : task.viewport.x, y:node ? node.y : task.viewport.y };
    captureEl.setPointerCapture(event.pointerId);
  }
  pointerMove(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const task = this.getTask();
    if (task !== this.drag.task) { this.pointerUp({pointerId:event.pointerId,type:'pointercancel'}); return; }
    event.preventDefault();
    const dx = event.clientX - this.drag.startX, dy = event.clientY - this.drag.startY;
    if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
    this.drag.moved = true;
    if (this.drag.kind === 'connection') {
      if (!task.nodes.some(node => node.id === this.drag.source)) { this.cancelConnectionDrag(); return; }
      this.drag.point = this.point(event.clientX,event.clientY);
      this.drag.target = this.connectionTarget(event,this.drag);
      this.nodesEl.querySelectorAll('.node').forEach(el => el.classList.toggle('connection-target',el.dataset.id === this.drag.target));
      this.renderEdges();
      return;
    }
    if (this.drag.node) {
      this.drag.nodeEl.classList.add('dragging');
      this.drag.node.x = Math.round(this.drag.x + dx / task.viewport.zoom);
      this.drag.node.y = Math.round(this.drag.y + dy / task.viewport.zoom);
      this.drag.nodeEl.style.left = this.drag.node.x + 'px';
      this.drag.nodeEl.style.top = this.drag.node.y + 'px';
      this.renderEdges();
    } else {
      this.el.classList.add('panning');
      task.viewport.x = this.drag.x + dx; task.viewport.y = this.drag.y + dy;
      this.updateTransform();
    }
  }
  pointerUp(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    if (this.drag.kind === 'connection' && event.type === 'pointerup') {
      this.pointerMove(event);
      if (!this.drag) return;
    }
    const drag = this.drag;
    this.drag = null;
    this.wasDragged = drag.moved;
    drag.nodeEl?.classList.remove('dragging');
    this.el.classList.remove('panning');
    if (drag.captureEl.hasPointerCapture(event.pointerId)) drag.captureEl.releasePointerCapture(event.pointerId);
    if (drag.kind === 'connection') {
      this.nodesEl.querySelectorAll('.connection-target').forEach(el => el.classList.remove('connection-target'));
      if (event.type === 'pointerup' && drag.moved && this.getTask() === drag.task && drag.task.nodes.some(node => node.id === drag.source) && drag.target) this.onConnect(drag.source,drag.target);
      this.onConnectionEnd();
      this.renderEdges();
    } else if (drag.moved) this.onChange();
    setTimeout(() => { this.wasDragged = false; }, 0);
  }
  wheel(event) {
    if (!this.getTask()) return;
    event.preventDefault();
    if (this.interacting) return;
    // Trackpads report pixels; some mice report lines or pages.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.el.clientHeight : 1;
    let dx = event.deltaX * unit, dy = event.deltaY * unit;
    if (event.ctrlKey || event.metaKey) {
      const rect = this.el.getBoundingClientRect();
      this.zoom(Math.exp(-dy * .003), event.clientX - rect.left, event.clientY - rect.top);
    } else {
      if (event.shiftKey && !dx) { dx = dy; dy = 0; }
      const view = this.getTask().viewport;
      view.x -= dx; view.y -= dy;
      this.updateTransform(); this.onChange();
    }
  }
  zoom(factor, cx = this.el.clientWidth / 2, cy = this.el.clientHeight / 2) {
    if (this.minimap?.drag) return;
    const view = this.getTask()?.viewport; if (!view) return;
    const zoom = Math.min(2, Math.max(.2, view.zoom * factor));
    view.x = cx - (cx - view.x) * zoom / view.zoom;
    view.y = cy - (cy - view.y) * zoom / view.zoom;
    view.zoom = zoom;
    this.updateTransform(); this.onChange();
  }
  fit() {
    this.minimap?.endDrag();
    const task = this.getTask(); if (!task?.nodes.length) { if (task) { task.viewport = {x:0,y:0,zoom:1}; this.updateTransform(); this.onChange(); } return; }
    const minX = Math.min(...task.nodes.map(n => n.x)), minY = Math.min(...task.nodes.map(n => n.y));
    const maxX = Math.max(...task.nodes.map(n => n.x + n.width));
    const maxY = Math.max(...task.nodes.map(n => n.y + (this.nodesEl.querySelector('[data-id="' + n.id + '"]')?.offsetHeight || 200)));
    const availableHeight = Math.max(180, this.el.clientHeight - 150);
    const zoom = Math.max(.2, Math.min(1, (this.el.clientWidth - 90) / Math.max(1, maxX - minX), availableHeight / Math.max(1, maxY - minY)));
    task.viewport = { x:(this.el.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom, y:48 - minY * zoom, zoom };
    this.updateTransform(); this.onChange();
  }
  point(clientX, clientY) {
    const rect = this.el.getBoundingClientRect(), view = this.getTask().viewport;
    return { x:Math.round((clientX - rect.left - view.x) / view.zoom), y:Math.round((clientY - rect.top - view.y) / view.zoom) };
  }
  newPosition() {
    const task = this.getTask(), view = task.viewport;
    const heights = new Map([...this.nodesEl.querySelectorAll('.node')].map(el => [el.dataset.id,el.offsetHeight]));
    const left = Math.round((35 - view.x) / view.zoom), top = Math.round((50 - view.y) / view.zoom);
    const columns = Math.max(1, Math.floor((this.el.clientWidth / view.zoom - 55) / 350));
    const overlaps = (x,y) => task.nodes.some(n => x < n.x+n.width+28 && x+310+28 > n.x && y < n.y+(heights.get(n.id)||240)+28 && y+240+28 > n.y);
    for (let row=0;row<50;row++) {
      for(let col=0;col<columns;col++) {
        const x=left+col*350,y=top+row*300;
        if(!overlaps(x,y)) {
          if((y*view.zoom+view.y)>this.el.clientHeight-330) {
            view.y=60-y*view.zoom;
            this.updateTransform();
          }
          return {x,y};
        }
      }
    }
    const y=Math.max(0,...task.nodes.map(n=>n.y+(heights.get(n.id)||240)))+45;
    view.y=60-y*view.zoom;this.updateTransform();
    return {x:left,y};
  }
}
