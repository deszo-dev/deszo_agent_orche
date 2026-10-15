import { canonicalHash } from './canonical.mjs';
import { INPUT, RETURN, isExecutable } from './validate.mjs';

// Scoped instance IDs: [loop, iteration]* node, for example "delivery/2/spec/1/analyst".
export function parseInstance(id) {
  const parts = id.split('/');
  const nodeId = parts.at(-1);
  if (parts.length === 1) return { prefix: '', nodeId, loopInstance: null, iteration: null };
  const prefix = `${parts.slice(0, -1).join('/')}/`;
  return { prefix, nodeId, loopInstance: parts.slice(0, -2).join('/'), iteration: Number(parts.at(-2)) };
}
export const bodyPrefix = (loopInstance, iteration) => `${loopInstance}/${iteration}/`;

// Enclosing loop instances of a scope prefix, innermost first: [{ loopInstance, iteration }].
export function enclosingLoops(prefix) {
  const parts = prefix.split('/').filter(Boolean);
  const result = [];
  for (let i = 1; i < parts.length; i += 2) result.push({ loopInstance: parts.slice(0, i).join('/'), iteration: Number(parts[i]) });
  return result.reverse();
}

export function allNodesDeep(nodes) {
  return nodes.flatMap(node => node.type === 'loop' ? [node, ...allNodesDeep(node.config.body.nodes)] : [node]);
}

// Nodes required to produce `targets`, following data and After edges backwards.
// A frozen Cache's data input is cut: its producer is needed only by other consumers.
// After prerequisites of a frozen Cache remain required.
export function requiredSet(graph, targets, frozen) {
  const required = new Set();
  const stack = [...targets];
  while (stack.length) {
    const id = stack.pop();
    if (required.has(id) || id === INPUT || id === RETURN) continue;
    required.add(id);
    if (!frozen.has(id)) for (const edge of graph.edges) if (edge.target.nodeId === id) stack.push(edge.source.nodeId);
    for (const pair of graph.after) if (pair.after === id) stack.push(pair.before);
  }
  return required;
}

export function returnSources(graph) {
  return graph.edges.filter(edge => edge.target.nodeId === RETURN).map(edge => edge.source.nodeId).filter(id => id !== INPUT);
}

// Merkle fingerprint of a node's definition and everything upstream of it (view excluded).
export function fingerprints(graph, pins = {}) {
  const memo = new Map();
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const bodyPins = node => Object.fromEntries(allNodesDeep(node.config.body.nodes).filter(item => item.type === 'cache').map(item => [item.id, pins[item.id]?.value?.artifact?.sha256 ?? null]));
  const visit = id => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, null);
    const node = nodes.get(id);
    const { view, ...definition } = node.type === 'loop' ? { ...node, config: { ...node.config, body: { ...node.config.body, view: undefined } } } : node;
    const inputs = graph.edges.filter(edge => edge.target.nodeId === id && edge.source.nodeId !== INPUT)
      .map(edge => [edge.target.port, edge.source.port, visit(edge.source.nodeId)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const after = graph.after.filter(pair => pair.after === id).map(pair => visit(pair.before)).sort();
    const pin = node.type === 'cache' && node.config.mode === 'frozen' ? pins[id]?.value?.artifact?.sha256 ?? null : null;
    const value = canonicalHash({ definition, inputs, after, pin, bodyPins: node.type === 'loop' ? bodyPins(node) : null });
    memo.set(id, value);
    return value;
  };
  return Object.fromEntries(graph.nodes.filter(isExecutable).map(node => [node.id, visit(node.id)]));
}
