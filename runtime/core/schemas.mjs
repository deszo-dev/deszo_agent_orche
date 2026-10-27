import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import workflow from '../../docs/schemas/workflow.schema.json' with { type: 'json' };
import value from '../../docs/schemas/value.schema.json' with { type: 'json' };
import journal from '../../docs/schemas/journal-event.schema.json' with { type: 'json' };
import attempt from '../../docs/schemas/attempt-record.schema.json' with { type: 'json' };
import api from '../../docs/schemas/runtime-api.schema.json' with { type: 'json' };
import settings from '../../docs/schemas/application-settings.schema.json' with { type: 'json' };
import loopDecision from '../../docs/schemas/loop-decision.schema.json' with { type: 'json' };
import pipelineState from '../../docs/schemas/pipeline-state.schema.json' with { type: 'json' };
import sectionIndex from '../../docs/schemas/spec-section-index.schema.json' with { type: 'json' };
import implementationMap from '../../docs/schemas/implementation-map.schema.json' with { type: 'json' };
import journalV2 from '../../docs/schemas/journal-event-v2.schema.json' with { type: 'json' };
import apiV2 from '../../docs/schemas/runtime-api-v2.schema.json' with { type: 'json' };
import apiV3 from '../../docs/schemas/runtime-api-v3.schema.json' with { type: 'json' };
import reviewDecision from '../../docs/schemas/review-decision.schema.json' with { type: 'json' };
import gate from '../../docs/schemas/gate.schema.json' with { type: 'json' };
import mapSchema from '../../docs/schemas/map.schema.json' with { type: 'json' };
import executionEvidence from '../../docs/schemas/execution-evidence.schema.json' with { type: 'json' };
import incident from '../../docs/schemas/incident.schema.json' with { type: 'json' };
import auditManifest from '../../docs/schemas/audit-manifest.schema.json' with { type: 'json' };
import runControlApi from '../../docs/schemas/run-control-api.schema.json' with { type: 'json' };
import taskAssessment from '../../docs/schemas/task-assessment.schema.json' with { type: 'json' };
import executionPlan from '../../docs/schemas/execution-plan.schema.json' with { type: 'json' };
import evaluationRecord from '../../docs/schemas/evaluation-record.schema.json' with { type: 'json' };
import acceptanceRecord from '../../docs/schemas/acceptance-record.schema.json' with { type: 'json' };
import contextPackage from '../../docs/schemas/context-package.schema.json' with { type: 'json' };
import deliveryPlan from '../../docs/schemas/delivery-plan.schema.json' with { type: 'json' };
import deliveryResult from '../../docs/schemas/delivery-result.schema.json' with { type: 'json' };
import managedTask from '../../docs/schemas/managed-task.schema.json' with { type: 'json' };
import autonomyPolicy from '../../docs/schemas/autonomy-policy.schema.json' with { type: 'json' };
import judgeControl from '../../docs/schemas/judge-control.schema.json' with { type: 'json' };
import apiV4 from '../../docs/schemas/runtime-api-v4.schema.json' with { type: 'json' };
import failureOutcome from '../../docs/schemas/failure-outcome.schema.json' with { type: 'json' };

export const SCHEMAS = {
  'workflow.schema.json': workflow,
  'value.schema.json': value,
  'journal-event.schema.json': journal,
  'attempt-record.schema.json': attempt,
  'runtime-api.schema.json': api,
  'application-settings.schema.json': settings,
  'loop-decision.schema.json': loopDecision,
  'pipeline-state.schema.json': pipelineState,
  'spec-section-index.schema.json': sectionIndex,
  'implementation-map.schema.json': implementationMap,
  'journal-event-v2.schema.json': journalV2,
  'runtime-api-v2.schema.json': apiV2,
  'runtime-api-v3.schema.json': apiV3,
  'runtime-api-v4.schema.json': apiV4,
  'review-decision.schema.json': reviewDecision,
  'gate.schema.json': gate,
  'map.schema.json': mapSchema,
  'execution-evidence.schema.json': executionEvidence,
  'incident.schema.json': incident,
  'audit-manifest.schema.json': auditManifest,
  'run-control-api.schema.json': runControlApi,
  'task-assessment.schema.json': taskAssessment,
  'execution-plan.schema.json': executionPlan,
  'evaluation-record.schema.json': evaluationRecord,
  'acceptance-record.schema.json': acceptanceRecord,
  'context-package.schema.json': contextPackage,
  'delivery-plan.schema.json': deliveryPlan,
  'delivery-result.schema.json': deliveryResult,
  'managed-task.schema.json': managedTask,
  'autonomy-policy.schema.json': autonomyPolicy,
  'judge-control.schema.json': judgeControl,
  'failure-outcome.schema.json': failureOutcome,
};

const AjvClass = Ajv2020.default || Ajv2020;
const formats = addFormats.default || addFormats;
const ajv = new AjvClass({ strict: false, allErrors: true, validateFormats: true });
formats(ajv);
for (const schema of Object.values(SCHEMAS)) ajv.addSchema(schema);
const cache = new Map();

function compiled(name, definition) {
  const key = `${name}#${definition || ''}`;
  if (!cache.has(key)) {
    const uri = SCHEMAS[name].$id + (definition ? `#/$defs/${definition}` : '');
    cache.set(key, ajv.getSchema(uri) || ajv.compile({ $ref: uri }));
  }
  return cache.get(key);
}

const describe = errors => (errors || []).map(error => ({
  path: error.instancePath || '/',
  message: `${error.message}${error.params && Object.keys(error.params).length ? ` (${JSON.stringify(error.params)})` : ''}`,
}));

export function check(name, definition, data) {
  const validate = compiled(name, definition);
  return validate(data) ? [] : describe(validate.errors);
}

const inline = new WeakMap();
export function checkSchema(schema, data) {
  if (!inline.has(schema)) inline.set(schema, ajv.compile(schema));
  const validate = inline.get(schema);
  return validate(data) ? [] : describe(validate.errors);
}

export class ContractError extends Error {
  constructor(message, details = []) { super(message); this.code = 'contract'; this.details = details; }
}

export function assertValid(name, definition, data, label = definition || name) {
  const issues = check(name, definition, data);
  if (issues.length) throw new ContractError(`${label} violates its contract`, issues);
  return data;
}

function walk(value, visit) {
  if (Array.isArray(value)) value.forEach(item => walk(item, visit));
  else if (value && typeof value === 'object') { visit(value); Object.values(value).forEach(item => walk(item, visit)); }
}

// Agent output schemas are user data: compile standalone, with only local #/ references.
export function compileOutputSchema(schema) {
  walk(schema, part => {
    if (typeof part.$ref === 'string' && !part.$ref.startsWith('#')) throw new ContractError('Output schema may only use local #/ references');
    if (typeof part.$dynamicRef === 'string' && !part.$dynamicRef.startsWith('#')) throw new ContractError('Output schema may only use local references');
  });
  if (schema.$schema && schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new ContractError('Output schema must use Draft 2020-12');
  const local = new AjvClass({ strict: false, allErrors: true, validateFormats: true, loadSchema: undefined });
  formats(local);
  const { $id, ...rest } = schema;
  try {
    const validate = local.compile(rest);
    return data => (validate(data) ? [] : describe(validate.errors));
  } catch (error) { throw new ContractError(`Output schema does not compile: ${error.message}`); }
}
