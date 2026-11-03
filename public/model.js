export function restoreCard(task, index, node, edges) {
  if (!task.nodes.some(existing => existing.id === node.id)) task.nodes.splice(index,0,node);
  const nodes = new Set(task.nodes.map(existing => existing.id));
  const existingEdges = new Set(task.edges.map(edge => edge.id));
  for (const edge of edges) {
    if (nodes.has(edge.source) && nodes.has(edge.target) && !existingEdges.has(edge.id)) {
      task.edges.push(edge);
      existingEdges.add(edge.id);
    }
  }
}

export class MergeConflict extends Error {
  constructor(field) { super('网页与其他窗口或 AI 同时修改了相同内容：' + field); this.status = 409; }
}

// Keep references held by dragging, dialogs, uploads and undo callbacks alive.
export function updateInPlace(target, next) {
  if (Array.isArray(target) && Array.isArray(next)) {
    const byId=new Map(target.filter(item=>item&&typeof item.id==='string').map(item=>[item.id,item]));
    const values=next.map((item,index)=>{
      const previous=item&&typeof item.id==='string'?byId.get(item.id):target[index];
      return updateInPlace(previous,item);
    });
    target.splice(0,target.length,...values);return target;
  }
  if (target && next && typeof target==='object' && typeof next==='object' && !Array.isArray(target) && !Array.isArray(next)) {
    for(const key of Object.keys(target))if(!(key in next))delete target[key];
    for(const [key,value] of Object.entries(next))target[key]=updateInPlace(target[key],value);
    return target;
  }
  return structuredClone(next);
}

export function applyFormChanges(target, initial, values) {
  const changed=Object.entries(values).filter(([key,value])=>value!==initial[key]);
  for(const [key,value] of changed) {
    if(target[key]!==initial[key] && target[key]!==value) throw new MergeConflict(key);
  }
  for(const [key,value] of changed)target[key]=value;
}
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Three-way merge: independent fields and ID-addressed cards/items can be saved together.
// Concurrent edits to one field are rejected, so neither writer silently loses content.
export function mergeStates(base, local, remote) {
  function merge(b,l,r,field) {
    if (equal(l,b)) return structuredClone(r);
    if (equal(r,b) || equal(l,r)) return structuredClone(l);
    if (field.endsWith('.updatedAt')) return [l,r].sort().at(-1);
    if (field === 'activeTaskId' || field.endsWith('.viewport')) return structuredClone(l);
    if ([b,l,r].every(Array.isArray) && [b,l,r].every(arr => arr.every(item => object(item) && typeof item.id === 'string'))) {
      const bm = new Map(b.map(i=>[i.id,i])), lm = new Map(l.map(i=>[i.id,i])), rm = new Map(r.map(i=>[i.id,i]));
      const ids = [...new Set([...l.map(i=>i.id),...r.map(i=>i.id),...b.map(i=>i.id)])];
      const result = ids.map(id=>merge(bm.get(id),lm.get(id),rm.get(id),field+'.'+id)).filter(i=>i!==undefined);
      return field.endsWith('.activity') ? result.sort((a,c)=>c.at.localeCompare(a.at)).slice(0,150) : result;
    }
    if ([b,l,r].every(object)) {
      const result = {};
      for (const key of new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])) {
        if (!field && key === 'revision') {result.revision = remote.revision; continue;}
        const value = merge(b[key],l[key],r[key],field ? field+'.'+key : key);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    throw new MergeConflict(field);
  }
  const result = merge(base,local,remote,''); result.revision=remote.revision;
  const groups = new Set((result.groups || []).map(group=>group.id));
  for (const task of result.tasks) if (task.groupId != null && !groups.has(task.groupId)) throw new MergeConflict('groupId');
  // A card removed by one writer cannot leave a newly merged dangling connection.
  for (const task of result.tasks) {
    const ids = new Set(task.nodes.map(n=>n.id));
    if (task.edges.some(e=>!ids.has(e.source)||!ids.has(e.target))) throw new MergeConflict('卡片关联');
  }
  return result;
}
