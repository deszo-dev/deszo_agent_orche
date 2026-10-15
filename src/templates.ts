import chain from '../docs/examples/m1-context-chain/workflow.json';
import loop from '../docs/examples/m2-review-loop/workflow.json';
import specification from '../docs/examples/m4-specification-loop/workflow.json';
import delivery from '../docs/examples/m5-delivery/workflow.json';
import selective from '../docs/examples/m6-selective-delivery/workflow.json';
import referenceDelivery from '../docs/examples/reference-delivery/workflow.json';
import { DEFAULT_MODELS, allNodes } from './model';
import type { Workflow } from './types';
import { DEFAULT_EFFORT } from '../shared/effort.mjs';

// Documented examples with fixture model IDs replaced by explicit defaults the user must confirm.
function prepare(source: unknown): Workflow {
  const workflow = structuredClone(source) as Workflow;
  for (const node of allNodes(workflow)) {
    if (node.type === 'agent') { node.config.model = DEFAULT_MODELS[node.config.provider]; node.config.effort ??= DEFAULT_EFFORT; }
    if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') { role.model = DEFAULT_MODELS[role.provider]; role.effort ??= DEFAULT_EFFORT; }
  }
  // The documented layout is compact; spread it for the 230px canvas cards.
  for (const position of Object.values(workflow.view || {})) { position.x = Math.round(position.x * 1.25); position.y = Math.round(position.y * 1.1); }
  return workflow;
}

export const contextChainTemplate = () => prepare(chain);
export const reviewLoopTemplate = () => prepare(loop);
export const specificationLoopTemplate = () => prepare(specification);
export const deliveryTemplate = () => prepare(delivery);
export const selectiveDeliveryTemplate = () => prepare(selective);
export const referenceDeliveryTemplate = () => prepare(referenceDelivery);
