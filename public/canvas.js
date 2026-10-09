export class Canvas {
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
    this.el.addEventListener('wheel', event => this.wheel(event), { passive: false });
    this.el.addEventListener('dblclick', event => {
      const node = event.target.closest('.node');
      if (node && !event.target.closest('button,a,input')) this.onEdit(node.dataset.id);
    });
    new ResizeObserver(() => this.updateTransform()).observe(this.el);
    new ResizeObserver(() => this.renderEdges()).observe(this.nodesEl);
  }
  render() {
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
    const fragment = document.createElement('template'); fragment.innerHTML = this.renderCard(node);
    el.replaceWith(fragment.content.firstElementChild);
    this.select(this.selected);
    requestAnimationFrame(() => this.renderEdges());
  }
  select(id) {
    this.selected = id;
    this.nodesEl.querySelectorAll('.node').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  }
  updateTransform() {
    const view = this.getTask()?.viewport;
    if (!view) return;
    this.world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')';
    this.el.parentElement.style.backgroundPosition = view.x + 'px ' + view.y + 'px';
    this.el.parentElement.style.backgroundSize = 20 * view.zoom + 'px ' + 20 * view.zoom + 'px';
    document.querySelector('#zoom-value').textContent = Math.round(view.zoom * 100) + '%';
  }
  renderEdges() {
    const task = this.getTask();
    if (!task) { this.paths.innerHTML = ''; return; }
    const heights = new Map([...this.nodesEl.querySelectorAll('.node')].map(el => [el.dataset.id, el.offsetHeight]));
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
      return '<g class="edge-group" data-edge="' + edge.id + '"><path class="edge-hit" d="' + d + '"/><path class="edge-path" d="' + d + '"/>' + (label ? '<text class="edge-label" x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 - 10) + '" text-anchor="middle">' + label + '</text>' : '') + '</g>';
    }).join('');
  }
  pointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (this.isConnecting() || event.target.closest('button,a,input,textarea,.edge-group')) return;
    const task = this.getTask(); if (!task) return;
    const nodeEl = event.target.closest('.node');
    const node = nodeEl ? task.nodes.find(n => n.id === nodeEl.dataset.id) : null;
    if (node) this.onSelect(node.id);
    else this.onSelect(null);
    this.drag = { pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, moved:false, node, nodeEl, x:node ? node.x : task.viewport.x, y:node ? node.y : task.viewport.y };
  }
  pointerMove(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const task = this.getTask();
    const dx = event.clientX - this.drag.startX, dy = event.clientY - this.drag.startY;
    if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
    this.drag.moved = true;
    if (!this.el.hasPointerCapture(event.pointerId)) this.el.setPointerCapture(event.pointerId);
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
    this.wasDragged = this.drag.moved;
    if (this.drag.moved) this.onChange();
    this.drag.nodeEl?.classList.remove('dragging');
    this.el.classList.remove('panning');
    this.drag = null;
    if (this.el.hasPointerCapture(event.pointerId)) this.el.releasePointerCapture(event.pointerId);
    setTimeout(() => { this.wasDragged = false; }, 0);
  }
  wheel(event) {
    if (!this.getTask()) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = this.el.getBoundingClientRect();
      this.zoom(Math.exp(-event.deltaY * .003), event.clientX - rect.left, event.clientY - rect.top);
    } else {
      const view = this.getTask().viewport;
      view.x -= event.deltaX; view.y -= event.deltaY;
      this.updateTransform(); this.onChange();
    }
  }
  zoom(factor, cx = this.el.clientWidth / 2, cy = this.el.clientHeight / 2) {
    const view = this.getTask()?.viewport; if (!view) return;
    const zoom = Math.min(2, Math.max(.2, view.zoom * factor));
    view.x = cx - (cx - view.x) * zoom / view.zoom;
    view.y = cy - (cy - view.y) * zoom / view.zoom;
    view.zoom = zoom;
    this.updateTransform(); this.onChange();
  }
  fit() {
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
