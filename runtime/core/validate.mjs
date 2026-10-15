import { SCHEMAS, check, checkSchema, compileOutputSchema } from './schemas.mjs';
import { transportSchema } from './transport.mjs';

export const PROVIDERS = ['codex', 'claude', 'antigravity'];
export const M1_MAXIMUM_TIMEOUT = 600;
export const INPUT = '$input';
export const RETURN = '$return';
const MARKER = /\{\{([a-z][a-z0-9-]{0,63})\}\}/g;
const BOUNDARY_PORTS = ['value', 'iteration', 'feedback'];

export function nodePorts(node) {
  const { type, config } = node;
  switch (type) {
    case 'text': return { inputs: {}, outputs: { text: 'Text' } };
    case 'prompt-template': return { inputs: Object.fromEntries(config.slots.map(slot => [slot.id, 'Text'])), outputs: { text: 'Text' } };
    case 'agent': return {
      inputs: { prompt: 'Text', ...(config.attachFiles ? { files: 'ArtifactSet' } : {}) },
      outputs: { text: 'Text', ...(config.output.format === 'json' ? { json: 'JsonValue' } : {}), ...(config.captures ? { files: 'ArtifactSet' } : {}) },
    };
    case 'result-viewer': return { inputs: { value: ['Text', 'JsonValue', 'ArtifactSet'] }, outputs: {} };
    case 'file-input': return { inputs: {}, outputs: { value: config.mode === 'files' ? 'ArtifactSet' : config.valueType } };
    case 'merge': {
      if (config.mode === 'selected') return { inputs: Object.fromEntries(config.inputs.map(input => [input.id, config.valueType])), outputs: { value: config.valueType } };
      const type = config.mode === 'text' ? 'Text' : config.mode === 'artifacts' ? 'ArtifactSet' : null;
      return { inputs: Object.fromEntries(config.inputs.map(input => [input.id, type || input.type])), outputs: { value: type || 'JsonValue' } };
    }
    case 'json-select': return { inputs: { value: 'JsonValue' }, outputs: { value: config.outputType } };
    case 'condition': return { inputs: { value: 'JsonValue' }, outputs: { decision: 'JsonValue' } };
    case 'cache': return { inputs: { value: config.valueType }, outputs: { value: config.valueType } };
    case 'route': return { inputs: { selector: 'JsonValue', value: config.valueType }, outputs: Object.fromEntries(config.cases.map(item => [item.id, config.valueType])) };
    case 'gate': {
      const slots = config.policy.slots.map(slot => slot.id);
      if (config.mode === 'prepare' && config.subject === 'delivery') return {
        inputs: { documentation: 'ArtifactSet', approval: 'JsonValue', summary: 'JsonValue', candidate: 'ArtifactSet', issues: 'JsonValue', ...(config.technicalPolicy ? { technical: 'JsonValue' } : {}) },
        outputs: { subject: 'ArtifactSet', plan: 'JsonValue', ...Object.fromEntries(slots.map(id => [id, 'ArtifactSet'])) },
      };
      if (config.mode === 'prepare') return {
        inputs: { subject: 'ArtifactSet', issues: 'JsonValue', ...(config.carry ? { prior: 'JsonValue' } : {}) },
        outputs: { subject: 'ArtifactSet', plan: 'JsonValue', ...Object.fromEntries(slots.map(id => [id, 'ArtifactSet'])), ...(config.carry ? Object.fromEntries(slots.map(id => [`${id}-need`, 'JsonValue'])) : {}) },
      };
      if (config.mode === 'evaluate') return { inputs: { subject: 'ArtifactSet', plan: 'JsonValue', ...Object.fromEntries(slots.map(id => [id, 'JsonValue'])) }, outputs: { report: 'JsonValue', certificate: 'JsonValue' } };
      return { inputs: { subject: 'ArtifactSet', certificate: 'JsonValue' }, outputs: { report: 'JsonValue' } };
    }
    case 'map': return {
      inputs: { documentation: 'ArtifactSet', approval: 'JsonValue', base: 'ArtifactSet', ...Object.fromEntries(config.optionalInputs.map(id => [id, 'JsonValue'])) },
      outputs: { result: 'ArtifactSet', summary: 'JsonValue' },
    };
    case 'loop': return {
      inputs: { seed: config.valueType, ...Object.fromEntries(config.fixedInputs.map(input => [input.id, input.type])) },
      outputs: { result: config.valueType, decision: 'JsonValue' },
    };
    default: return { inputs: {}, outputs: {} };
  }
}

export function boundaryPorts(loop) {
  return {
    input: { value: loop.config.valueType, iteration: 'JsonValue', feedback: 'Text', ...Object.fromEntries(loop.config.fixedInputs.map(input => [input.id, input.type])) },
    ret: { candidate: loop.config.valueType, decision: 'JsonValue' },
  };
}

export const isExecutable = node => node.type !== 'context';
const hasLoops = workflow => workflow.capabilities.includes('loops-v1');
const GATE_RESERVED = ['subject', 'plan', 'issues', 'report', 'certificate', 'documentation', 'approval', 'summary', 'candidate', 'technical', 'prior'];
export const MAX_LOOP_DEPTH = 3;
// Every loop with its enclosing chain, depth-first.
export function loopsOf(nodes, parents = []) {
  const result = [];
  for (const node of nodes) if (node.type === 'loop') { result.push({ loop: node, parents }); result.push(...loopsOf(node.config.body.nodes, [...parents, node])); }
  return result;
}

export function normalizedRelative(path) {
  if (!path || path.includes('\\') || path.includes(':') || path.startsWith('/') || /[*?]/.test(path)) return null;
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

// Semantic checks run only on structurally valid definitions; every issue carries a stable code.
export function semanticIssues(workflow, { maximumAgentTimeoutSeconds = M1_MAXIMUM_TIMEOUT } = {}) {
  const issues = [];
  const add = (code, path, message) => issues.push({ code, path, message });
  const seen = new Set();
  const all = new Map();
  const edgeIds = new Set();
  const caps = new Set(workflow.capabilities);
  // Walk every graph (outer and nested bodies) once for global identity and capability rules.
  const visitGraph = (nodes, edges, base, edgeBase, depth) => {
    nodes.forEach((node, index) => {
      const at = `${base}/${index}`;
      if (seen.has(node.id)) add('nodes.unique', `${at}/id`, `Duplicate node ID "${node.id}".`);
      seen.add(node.id); if (!all.has(node.id)) all.set(node.id, node);
      if (node.type === 'cache' && !caps.has('cache-v1')) add('capability.cache', `${at}/type`, `"${node.id}" needs the cache-v1 capability.`);
      if ((['gate', 'route'].includes(node.type) || (node.type === 'merge' && node.config.mode === 'selected') || (node.type === 'loop' && depth > 0)) && !caps.has('pipeline-v1'))
        add('capability.pipeline', `${at}/type`, `"${node.id}" needs the pipeline-v1 capability.`);
      if (node.type === 'map' && !caps.has('delivery-v1')) add('capability.delivery', `${at}/type`, `"${node.id}" needs the delivery-v1 capability.`);
      if (node.type === 'gate' && node.config.subject === 'delivery' && !caps.has('delivery-v1')) add('capability.delivery', `${at}/config/subject`, `"${node.id}" prepares a delivery subject; declare the delivery-v1 capability.`);
      if (((node.type === 'gate' && node.config.carry) || (node.type === 'map' && node.config.carryAcrossRevisions)) && !caps.has('revisions-v1'))
        add('capability.revisions', `${at}/config`, `"${node.id}" carries verified results across revisions; declare the revisions-v1 capability.`);
      if (node.type === 'loop') {
        if (depth + 1 > MAX_LOOP_DEPTH) add('loop.depth', `${at}`, `Loops may nest at most ${MAX_LOOP_DEPTH} levels deep.`);
        visitGraph(node.config.body.nodes, node.config.body.edges, `${at}/config/body/nodes`, `${at}/config/body/edges`, depth + 1);
      }
    });
    edges.forEach((edge, index) => { if (edgeIds.has(edge.id)) add('edges.unique', `${edgeBase}/${index}/id`, `Duplicate edge ID "${edge.id}".`); edgeIds.add(edge.id); });
  };
  visitGraph(workflow.nodes, workflow.edges, '/nodes', '/edges', 0);
  const loops = loopsOf(workflow.nodes).map(entry => entry.loop);

  const outerContexts = new Map(workflow.nodes.filter(node => node.type === 'context').map(node => [node.id, node]));
  const contextKey = context => context.config.mode === 'continue' ? `binding:${context.config.bindingId}` : `node:${context.id}`;
  // Contexts that a loop's body (at any depth) uses from outside that loop, per loop.
  const loopContexts = new Map();
  const collect = (loop, visible) => {
    const keys = new Set();
    const own = new Map(loop.config.body.nodes.filter(node => node.type === 'context').map(node => [node.id, node]));
    for (const node of loop.config.body.nodes) {
      for (const contextId of contextIdsOf(node)) if (!own.has(contextId) && visible.has(contextId)) keys.add(contextKey(visible.get(contextId)));
      if (node.type === 'loop') for (const key of collect(node, new Map([...visible, ...own]))) if (![...own.values()].some(context => contextKey(context) === key)) keys.add(key);
    }
    loopContexts.set(loop.id, keys);
    return keys;
  };
  for (const node of workflow.nodes) if (node.type === 'loop') collect(node, outerContexts);

  const graph = ({ nodes, edges, after, base, edgeBase, afterBase, boundary, contexts }) => {
    const local = new Map(nodes.map((node, index) => [node.id, { node, index }]));
    const adjacency = new Map([...local.keys()].map(key => [key, new Set()]));
    const ports = new Map([...local].map(([id, { node }]) => [id, nodePorts(node)]));
    if (boundary) {
      adjacency.set(INPUT, new Set()); adjacency.set(RETURN, new Set());
      ports.set(INPUT, { inputs: {}, outputs: boundary.input }); ports.set(RETURN, { inputs: boundary.ret, outputs: {} });
    }
    for (const [id, { node, index }] of local) {
      const at = `${base}/${index}`;
      if (!hasLoops(workflow) && ((node.type === 'agent' && (node.config.attachFiles !== undefined || node.config.captures)) || (node.type === 'context' && node.config.lifetime)))
        add('capability.loops', `${at}/config`, `"${id}" uses a loops-v1 field; declare the loops-v1 capability.`);
      if (node.type === 'prompt-template') {
        const slots = node.config.slots.map(slot => slot.id);
        if (new Set(slots).size !== slots.length) add('slots.unique', `${at}/config/slots`, 'Prompt Template slot IDs must be unique.');
        const markers = [...node.config.template.matchAll(MARKER)].map(match => match[1]);
        const remainder = node.config.template.replace(MARKER, '');
        const same = new Set(markers).size === new Set(slots).size && markers.every(marker => slots.includes(marker));
        if (!same || remainder.includes('{{') || remainder.includes('}}')) add('slots.markers', `${at}/config/template`, 'Template markers must match the declared slots exactly, and stray double braces are not allowed.');
      }
      if (node.type === 'agent') {
        const contextId = node.config.contextId;
        if (contextId) {
          const context = contexts.get(contextId);
          if (!context) add('context.reference', `${at}/config/contextId`, all.get(contextId)?.type === 'context' ? `Context "${contextId}" belongs to a loop body and is not visible here.` : `Context "${contextId}" does not exist.`);
          else if (context.config.provider !== node.config.provider) add('context.provider', `${at}/config/contextId`, `Context "${contextId}" belongs to ${context.config.provider}, not ${node.config.provider}.`);
        }
        if (node.config.timeoutSeconds > maximumAgentTimeoutSeconds) add('timeout.capability', `${at}/config/timeoutSeconds`, `Timeout exceeds the advertised maximum of ${maximumAgentTimeoutSeconds} seconds.`);
        if (node.config.output.schema !== undefined) {
          try { compileOutputSchema(node.config.output.schema); } catch (error) { add('output.schema', `${at}/config/output/schema`, error.message); }
          try { transportSchema(node.config.output.schema); } catch (error) { add('output.transport', `${at}/config/output/schema`, `Native structured output cannot carry this schema: ${error.message}`); }
        }
        (node.config.captures || []).forEach((path, i) => { if (!normalizedRelative(path)) add('file.path', `${at}/config/captures/${i}`, `"${path}" must be a normalized relative path.`); });
      }
      if (node.type === 'context' && node.config.lifetime === 'iteration' && !boundary) add('context.lifetime', `${at}/config/lifetime`, 'lifetime "iteration" is only valid for a Context inside a loop body.');
      if (node.type === 'file-input' && node.config.mode === 'files') node.config.paths.forEach((path, i) => { if (!normalizedRelative(path)) add('file.path', `${at}/config/paths/${i}`, `"${path}" must be a normalized relative path inside the workspace.`); });
      if (node.type === 'merge') {
        const ids = node.config.inputs.map(input => input.id);
        if (new Set(ids).size !== ids.length) add('merge.inputs', `${at}/config/inputs`, 'Merge input IDs must be unique.');
        if (node.config.mode === 'record') {
          const names = node.config.fields.map(field => field.name);
          if (new Set(names).size !== names.length) add('merge.field', `${at}/config/fields`, 'Record field names must be unique.');
          node.config.fields.forEach((field, i) => {
            if (!('input' in field.source)) return;
            const input = node.config.inputs.find(item => item.id === field.source.input);
            if (!input) add('merge.field', `${at}/config/fields/${i}`, `Field "${field.name}" reads undeclared input "${field.source.input}".`);
            else if (field.source.pointer !== undefined && input.type !== 'JsonValue') add('merge.pointer', `${at}/config/fields/${i}`, `Field "${field.name}" uses a pointer on ${input.type} input "${input.id}"; pointers need JsonValue.`);
          });
          if (node.config.schema !== undefined) { try { compileOutputSchema(node.config.schema); } catch (error) { add('output.schema', `${at}/config/schema`, error.message); } }
        }
      }
      if (node.type === 'loop') {
        if (node.config.stateSchema !== undefined) { try { compileOutputSchema(node.config.stateSchema); } catch (error) { add('output.schema', `${at}/config/stateSchema`, error.message); } }
        const reserved = node.config.fixedInputs.filter(input => BOUNDARY_PORTS.includes(input.id) || input.id === 'seed');
        if (reserved.length) add('loop.boundary', `${at}/config/fixedInputs`, `Fixed input IDs cannot be ${reserved.map(input => `"${input.id}"`).join(', ')}.`);
      }
      if (boundary && node.type === 'result-viewer') add('loop.boundary', at, 'A Result Viewer cannot be inside a loop body; return the value instead.');
      if (node.type === 'map') {
        const roles = new Map(node.config.roles.map(role => [role.id, role]));
        if (roles.size !== node.config.roles.length) add('map.roles', `${at}/config/roles`, 'Map role IDs must be unique.');
        node.config.roles.forEach((role, i) => {
          if (role.kind === 'utility' && roles.get(role.embeddedRoles.triage)?.kind !== 'agent') add('map.roles', `${at}/config/roles/${i}`, `Embedded triage role "${role.embeddedRoles.triage}" must be an Agent role of this Map.`);
          if (role.kind === 'agent' && role.timeoutSeconds > maximumAgentTimeoutSeconds) add('timeout.capability', `${at}/config/roles/${i}/timeoutSeconds`, `Timeout exceeds the advertised maximum of ${maximumAgentTimeoutSeconds} seconds.`);
          if (role.kind === 'agent' && role.context !== 'task') {
            const context = contexts.get(role.context.contextId);
            if (!context) add('map.context', `${at}/config/roles/${i}/context`, `Context "${role.context.contextId}" is not visible to this Map.`);
            else if (context.config.provider !== role.provider) add('map.context', `${at}/config/roles/${i}/context`, `Context "${role.context.contextId}" belongs to ${context.config.provider}, not ${role.provider}.`);
          }
        });
        const ids = node.config.approvalPolicy.slots.map(slot => slot.id);
        if (new Set(ids).size !== ids.length) add('gate.slot', `${at}/config/approvalPolicy/slots`, 'Approval policy slot IDs must be unique.');
      }
      if (node.type === 'gate') {
        const ids = node.config.policy.slots.map(slot => slot.id);
        if (new Set(ids).size !== ids.length || ids.some(id => GATE_RESERVED.includes(id) || (node.config.carry && id.length > 59))) add('gate.slot', `${at}/config/policy/slots`, `Slot IDs must be unique, at most 59 characters with carry, and cannot be ${GATE_RESERVED.join(', ')}.`);
      }
      if (node.type === 'route') {
        const ids = node.config.cases.map(item => item.id);
        if (new Set(ids).size !== ids.length) add('route.cases', `${at}/config/cases`, 'Route case IDs must be unique.');
      }
      if (node.type === 'merge' && node.config.mode === 'selected') {
        const ids = node.config.inputs.map(input => input.id);
        if (new Set(ids).size !== ids.length) add('merge.inputs', `${at}/config/inputs`, 'Merge input IDs must be unique.');
      }
    }
    const incoming = new Map();
    edges.forEach((edge, index) => {
      const { source, target } = edge;
      const at = `${edgeBase}/${index}`;
      if (!ports.has(source.nodeId) || !ports.has(target.nodeId)) {
        const reserved = [source.nodeId, target.nodeId].find(id => id === INPUT || id === RETURN);
        add(reserved && !boundary ? 'loop.boundary' : 'edge.endpoint', at, reserved && !boundary ? `${reserved} exists only inside a loop body.` : 'Edge endpoint does not exist in this graph.');
        return;
      }
      const produced = ports.get(source.nodeId).outputs[source.port];
      const accepted = ports.get(target.nodeId).inputs[target.port];
      if (produced === undefined || accepted === undefined) add(source.nodeId === INPUT || target.nodeId === RETURN ? 'loop.boundary' : 'port.name', at, `Unknown port ${source.nodeId}.${source.port} → ${target.nodeId}.${target.port}.`);
      else if (!(Array.isArray(accepted) ? accepted : [accepted]).includes(produced)) add('port.type', at, `${produced} cannot connect to ${target.nodeId}.${target.port}; conversions must be explicit.`);
      const key = `${target.nodeId}\u0000${target.port}`;
      incoming.set(key, (incoming.get(key) || 0) + 1);
      adjacency.get(source.nodeId).add(target.nodeId);
    });
    for (const [id, { inputs }] of ports) {
      for (const port of Object.keys(inputs)) {
        const count = incoming.get(`${id}\u0000${port}`) || 0;
        if (count === 1) continue;
        if (id === RETURN) add('loop.return', edgeBase, `${RETURN}.${port} needs exactly one connection (has ${count}).`);
        else add('input.required', `${base}/${local.get(id).index}`, `Input ${id}.${port} needs exactly one connection (has ${count}).`);
      }
    }
    const pairs = new Set();
    after.forEach((pair, index) => {
      const key = `${pair.before}\u0000${pair.after}`;
      if (pairs.has(key)) add('after.unique', `${afterBase}/${index}`, 'Duplicate After dependency.');
      pairs.add(key);
      const before = local.get(pair.before)?.node, later = local.get(pair.after)?.node;
      if (!before || !later || pair.before === pair.after || before.type === 'context' || later.type === 'context') add('after.reference', `${afterBase}/${index}`, 'After must connect two different executable nodes in the same graph.');
      else adjacency.get(pair.before).add(pair.after);
    });
    const cycle = findCycle(adjacency);
    if (cycle) add('graph.cycle', edgeBase, `Dependency cycle: ${cycle.join(' → ')}.`);
    const reach = new Map();
    const reaches = (from, to) => {
      if (!reach.has(from)) {
        const found = new Set(), stack = [...adjacency.get(from)];
        while (stack.length) { const next = stack.pop(); if (!found.has(next)) { found.add(next); stack.push(...adjacency.get(next)); } }
        reach.set(from, found);
      }
      return reach.get(from).has(to);
    };
    // Context users: Agents directly, and loops through the outer Contexts their bodies use.
    const users = [];
    for (const [id, { node }] of local) {
      for (const contextId of contextIdsOf(node)) if (contexts.has(contextId)) users.push([id, contextKey(contexts.get(contextId))]);
      if (node.type === 'loop') for (const key of loopContexts.get(id)) users.push([id, key]);
    }
    // Gate evaluate slots accept only an Agent's own JSON answer, so the engine can verify the reviewer.
    for (const [id, { node, index }] of local) {
      if (node.type !== 'gate' || node.config.mode !== 'evaluate') continue;
      for (const slot of node.config.policy.slots) {
        const edge = edges.find(item => item.target.nodeId === id && item.target.port === slot.id);
        const source = edge && local.get(edge.source.nodeId)?.node;
        const direct = source?.type === 'agent' && edge.source.port === 'json';
        // revisions-v1: a selected Merge joining exactly one live Agent answer with a carried decision.
        const joined = caps.has('revisions-v1') && source?.type === 'merge' && source.config.mode === 'selected'
          && edges.filter(item => item.target.nodeId === source.id).filter(item => local.get(item.source.nodeId)?.node.type === 'agent' && item.source.port === 'json').length === 1;
        if (edge && !direct && !joined) add('gate.review-source', `${base}/${index}`, `Gate slot "${slot.id}" must come from an Agent's json output${caps.has('revisions-v1') ? ' or a selected Merge of one live Agent answer and a carried decision' : ''}.`);
      }
    }
    // A frozen Cache must not feed the loop decision: each iteration is judged live.
    if (boundary && !cycle) {
      const decisionEdge = edges.find(item => item.target.nodeId === RETURN && item.target.port === 'decision');
      if (decisionEdge && decisionEdge.source.nodeId !== INPUT) {
        for (const [id, { node, index }] of local) if (node.type === 'cache' && node.config.mode === 'frozen' && (id === decisionEdge.source.nodeId || reaches(id, decisionEdge.source.nodeId)))
          add('cache.decision', `${base}/${index}`, `Frozen Cache "${id}" reaches the loop decision; the checker must run live.`);
      }
    }
    if (!cycle) for (let i = 0; i < users.length; i++) for (let j = i + 1; j < users.length; j++) {
      const [a, keyA] = users[i], [b, keyB] = users[j];
      if (a !== b && keyA === keyB && !reaches(a, b) && !reaches(b, a))
        add('context.unordered', `${base}/${local.get(b).index}`, `"${a}" and "${b}" share a Context but are not ordered by data or After dependencies.`);
    }
    const sinks = boundary ? [RETURN] : [...local.values()].filter(entry => entry.node.type === 'result-viewer').map(entry => entry.node.id);
    if (!boundary && !sinks.length) add('viewer.required', base, 'Add a Result Viewer to receive the workflow output.');
    for (const [id, { node, index }] of local) {
      if (node.type === 'context') {
        if (![...all.values()].some(other => contextIdsOf(other).includes(id))) add('context.unused', `${base}/${index}`, `Context "${id}" is not referenced by any Agent.`);
      } else if (node.type !== 'result-viewer' && !cycle && !sinks.some(sink => reaches(id, sink))) {
        add('node.sink', `${base}/${index}`, boundary ? `"${id}" does not lead to ${RETURN}.` : `"${id}" does not lead to a Result Viewer.`);
      }
    }
  };

  graph({ nodes: workflow.nodes, edges: workflow.edges, after: workflow.after, base: '/nodes', edgeBase: '/edges', afterBase: '/after', boundary: null, contexts: outerContexts });
  for (const id of Object.keys(workflow.view || {})) if (!workflow.nodes.some(node => node.id === id)) add('view.reference', `/view/${id}`, `View entry "${id}" names no node.`);
  const visitBodies = (nodes, base, visible) => nodes.forEach((loop, index) => {
    if (loop.type !== 'loop') return;
    const body = loop.config.body;
    const at = `${base}/${index}/config/body`;
    const contexts = new Map([...visible, ...body.nodes.filter(node => node.type === 'context').map(node => [node.id, node])]);
    graph({ nodes: body.nodes, edges: body.edges, after: body.after, base: `${at}/nodes`, edgeBase: `${at}/edges`, afterBase: `${at}/after`, boundary: boundaryPorts(loop), contexts });
    for (const id of Object.keys(body.view || {})) if (id !== INPUT && id !== RETURN && !body.nodes.some(node => node.id === id)) add('view.reference', `${at}/view/${id}`, `View entry "${id}" names no body node.`);
    visitBodies(body.nodes, `${at}/nodes`, contexts);
  });
  visitBodies(workflow.nodes, '/nodes', outerContexts);
  return issues;
}

// Context references of an Agent, or of a Map's Agent roles.
export function contextIdsOf(node) {
  if (node.type === 'agent') return node.config.contextId ? [node.config.contextId] : [];
  if (node.type === 'map') return [...new Set(node.config.roles.filter(role => role.kind === 'agent' && role.context !== 'task').map(role => role.context.contextId))];
  return [];
}

function findCycle(adjacency) {
  const state = new Map(), path = [];
  const visit = key => {
    state.set(key, 1); path.push(key);
    for (const child of adjacency.get(key)) {
      if (state.get(child) === 1) return [...path.slice(path.indexOf(child)), child];
      if (!state.has(child)) { const found = visit(child); if (found) return found; }
    }
    state.set(key, 2); path.pop(); return null;
  };
  for (const key of adjacency.keys()) if (!state.has(key)) { const found = visit(key); if (found) return found; }
  return null;
}

export function capabilityIssues(capabilities) {
  const ids = capabilities.providers.map(provider => provider.provider);
  return new Set(ids).size === PROVIDERS.length && PROVIDERS.every(id => ids.includes(id)) ? []
    : [{ code: 'providers.unique', path: '/providers', message: 'Capabilities need exactly one record per provider.' }];
}

const NODE_DEFS = {
  text: 'textNode', 'prompt-template': 'promptTemplateNode', agent: 'agentNode', context: 'contextNode', 'result-viewer': 'resultViewerNode',
  'file-input': 'fileInputNode', merge: 'mergeNode', 'json-select': 'jsonSelectNode', condition: 'conditionNode', loop: 'loopNode',
  cache: 'cacheNode', route: 'routeNode', gate: 'gateNode', map: 'mapNode',
};
const CORE = ['text', 'prompt-template', 'agent', 'context', 'result-viewer'];
const definitions = new Map();
const definition = name => {
  if (!definitions.has(name)) definitions.set(name, { $ref: `${SCHEMAS['workflow.schema.json'].$id}#/$defs/${name}` });
  return definitions.get(name);
};

// oneOf reports every node variant; re-check each node against its own type for readable errors.
export function structuralIssues(workflow) {
  const issues = check('workflow.schema.json', null, workflow);
  if (!issues.length || !Array.isArray(workflow?.nodes)) return issues;
  const capabilities = Array.isArray(workflow.capabilities) ? workflow.capabilities : [];
  const nodeIssues = [];
  const visit = (nodes, base, inBody) => nodes.forEach((node, index) => {
    const at = `${base}/${index}`;
    const name = NODE_DEFS[node?.type];
    if (!name) { nodeIssues.push({ path: `${at}/type`, message: `Unknown node type "${node?.type}".` }); return; }
    const needed = node.type === 'map' && !capabilities.includes('delivery-v1') ? 'delivery-v1' : node.type === 'map' ? 'pipeline-v1' : node.type === 'cache' ? 'cache-v1' : ['gate', 'route'].includes(node.type) || (inBody && node.type === 'loop') ? 'pipeline-v1' : CORE.includes(node.type) ? null : 'loops-v1';
    if (needed && !capabilities.includes(needed)) { nodeIssues.push({ path: `${at}/type`, message: `"${node.type}"${inBody && node.type === 'loop' ? ' inside a loop body' : ''} needs the ${needed} capability.` }); return; }
    let own;
    if (node.type === 'loop' && Array.isArray(node.config?.body?.nodes)) {
      own = checkSchema(definition(name), { ...node, config: { ...node.config, body: { ...node.config.body, nodes: [{ id: 'placeholder', type: 'text', config: { value: '' } }] } } });
      visit(node.config.body.nodes, `${at}/config/body/nodes`, true);
    } else own = checkSchema(definition(name), node);
    for (const issue of own) {
      const path = `${at}${issue.path === '/' ? '' : issue.path}`;
      nodeIssues.push({ path, message: issue.path === '/config/model' ? `Agent "${node.id}" needs an explicit model ID (letters, digits and ._:/[]-; no spaces or leading hyphen).` : issue.message });
    }
  });
  visit(workflow.nodes, '/nodes', false);
  const other = issues.filter(issue => !/^\/nodes\/\d+/.test(issue.path));
  const combined = [...other, ...nodeIssues];
  return combined.length ? combined : issues;
}

export function validateWorkflow(workflow, options) {
  const structural = structuralIssues(workflow).map(issue => ({ code: 'schema', ...issue }));
  if (structural.length) return { valid: false, issues: structural, structural: true };
  const issues = semanticIssues(workflow, options);
  return { valid: issues.length === 0, issues, structural: false };
}

// Topological order of one graph's executable nodes (outer graph or a loop body).
export function topologicalOrder(graph) {
  const executable = graph.nodes.filter(isExecutable).map(node => node.id);
  const indegree = new Map(executable.map(id => [id, 0])), next = new Map(executable.map(id => [id, []]));
  const link = (from, to) => { if (next.has(from) && indegree.has(to)) { next.get(from).push(to); indegree.set(to, indegree.get(to) + 1); } };
  graph.edges.forEach(edge => link(edge.source.nodeId, edge.target.nodeId));
  graph.after.forEach(pair => link(pair.before, pair.after));
  const queue = executable.filter(id => indegree.get(id) === 0), order = [];
  while (queue.length) { const id = queue.shift(); order.push(id); for (const child of next.get(id)) { indegree.set(child, indegree.get(child) - 1); if (!indegree.get(child)) queue.push(child); } }
  return order;
}
