"""Offline documentation checks and reusable contract fixtures; no runtime execution."""
import copy
import hashlib
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path, PurePosixPath
from urllib.parse import unquote
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]
ERRORS = []
COUNTS = Counter()

def require(ok, message):
    if not ok:
        ERRORS.append(message)

def strict(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key: " + key)
        result[key] = value
    return result

def reject_constant(value):
    raise ValueError("Non-finite JSON number: " + value)

def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"),
                      object_pairs_hook=strict, parse_constant=reject_constant)

def local_path(relative):
    path = (ROOT / relative).resolve()
    if not path.is_relative_to(ROOT):
        raise ValueError("Fixture path escapes the repository: " + relative)
    return path

def pointer(value, path):
    if not path:
        return value
    if not path.startswith("/"):
        raise ValueError("Expected JSON Pointer: " + path)
    for part in path[1:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value

def materialize(case):
    allowed = {"id", "source", "schema", "definition", "expected", "semantic", "mutations",
               "phase", "code", "maximumAgentTimeoutSeconds"}
    if set(case) - allowed or case["expected"] not in ("valid", "invalid"):
        raise ValueError("Invalid fixture fields or expected outcome")
    if case.get("semantic") not in (None, "workflow", "sections", "map", "capabilities"):
        raise ValueError("Unknown semantic rule group")
    if case["expected"] == "invalid" and case.get("phase") not in ("schema", "semantic"):
        raise ValueError("Invalid rejection phase")
    source = case["source"]
    value = copy.deepcopy(pointer(read(local_path(source["file"])), source.get("pointer", "")))
    for change in case.get("mutations", []):
        if change["op"] not in ("add", "replace", "remove"):
            raise ValueError("Unknown fixture mutation")
        parent_path, _, key = change["path"].rpartition("/")
        parent = pointer(value, parent_path)
        key = key.replace("~1", "/").replace("~0", "~")
        if isinstance(parent, list):
            if change["op"] == "add":
                parent.insert(len(parent) if key == "-" else int(key), copy.deepcopy(change["value"]))
            elif change["op"] == "remove":
                parent.pop(int(key))
            else:
                parent[int(key)] = copy.deepcopy(change["value"])
        elif change["op"] == "remove":
            del parent[key]
        else:
            if change["op"] == "replace" and key not in parent:
                raise KeyError(key)
            parent[key] = copy.deepcopy(change["value"])
    return value

def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)

SCHEMAS = {p.name: read(p) for p in sorted((ROOT / "docs/schemas").glob("*.json"))}
REGISTRY = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in SCHEMAS.values())
for name, schema in SCHEMAS.items():
    Draft202012Validator.check_schema(schema)
    for item in walk(schema):
        if "$ref" in item:
            REGISTRY.resolver(schema["$id"]).lookup(item["$ref"])
COUNTS["schemas"] = len(SCHEMAS)
require({"uuid", "date-time"} <= FormatChecker().checkers.keys(), "Install jsonschema format dependencies")

def validator(case):
    uri = SCHEMAS[case["schema"]]["$id"]
    if case.get("definition"):
        uri += "#/$defs/" + case["definition"]
    return Draft202012Validator({"$ref": uri}, registry=REGISTRY, format_checker=FormatChecker())

def cyclic(adjacency):
    visited, active = set(), set()
    def visit(key):
        if key in active:
            return True
        if key in visited:
            return False
        active.add(key)
        if any(visit(child) for child in adjacency.get(key, ())):
            return True
        active.remove(key)
        visited.add(key)
        return False
    return any(visit(key) for key in adjacency)

INPUT, RETURN = "$input", "$return"
MARKER = r"\{\{([a-z][a-z0-9-]{0,63})\}\}"

def node_ports(node):
    kind, config = node["type"], node["config"]
    if kind == "text":
        return {}, {"text": "Text"}
    if kind == "prompt-template":
        return {s["id"]: ("Text",) for s in config["slots"]}, {"text": "Text"}
    if kind == "agent":
        ins = {"prompt": ("Text",), **({"files": ("ArtifactSet",)} if config.get("attachFiles") else {})}
        outs = {"text": "Text", **({"json": "JsonValue"} if config["output"]["format"] == "json" else {}),
                **({"files": "ArtifactSet"} if config.get("captures") else {})}
        return ins, outs
    if kind == "result-viewer":
        return {"value": ("Text", "JsonValue", "ArtifactSet")}, {}
    if kind == "file-input":
        return {}, {"value": "ArtifactSet" if config["mode"] == "files" else config["valueType"]}
    if kind == "merge" and config["mode"] == "selected":
        return {i["id"]: (config["valueType"],) for i in config["inputs"]}, {"value": config["valueType"]}
    if kind == "cache":
        return {"value": (config["valueType"],)}, {"value": config["valueType"]}
    if kind == "route":
        return {"selector": ("JsonValue",), "value": (config["valueType"],)}, {c["id"]: config["valueType"] for c in config["cases"]}
    if kind == "gate":
        slots = [slot["id"] for slot in config["policy"]["slots"]]
        if config["mode"] == "prepare" and config.get("subject") == "delivery":
            ins = {"documentation": ("ArtifactSet",), "approval": ("JsonValue",), "summary": ("JsonValue",), "candidate": ("ArtifactSet",), "issues": ("JsonValue",),
                   **({"technical": ("JsonValue",)} if config.get("technicalPolicy") else {})}
            return ins, {"subject": "ArtifactSet", "plan": "JsonValue", **{x: "ArtifactSet" for x in slots}}
        if config["mode"] == "prepare":
            carry = config.get("carry", False)
            return ({"subject": ("ArtifactSet",), "issues": ("JsonValue",), **({"prior": ("JsonValue",)} if carry else {})},
                    {"subject": "ArtifactSet", "plan": "JsonValue", **{x: "ArtifactSet" for x in slots}, **({x + "-need": "JsonValue" for x in slots} if carry else {})})
        if config["mode"] == "evaluate":
            return {"subject": ("ArtifactSet",), "plan": ("JsonValue",), **{x: ("JsonValue",) for x in slots}}, {"report": "JsonValue", "certificate": "JsonValue"}
        return {"subject": ("ArtifactSet",), "certificate": ("JsonValue",)}, {"report": "JsonValue"}
    if kind == "merge":
        fixed = {"text": "Text", "artifacts": "ArtifactSet"}.get(config["mode"])
        return {i["id"]: (fixed or i["type"],) for i in config["inputs"]}, {"value": fixed or "JsonValue"}
    if kind == "json-select":
        return {"value": ("JsonValue",)}, {"value": config["outputType"]}
    if kind == "condition":
        return {"value": ("JsonValue",)}, {"decision": "JsonValue"}
    if kind == "map":
        ins = {"documentation": ("ArtifactSet",), "approval": ("JsonValue",), "base": ("ArtifactSet",), **{x: ("JsonValue",) for x in config["optionalInputs"]}}
        return ins, {"result": "ArtifactSet", "summary": "JsonValue"}
    if kind == "loop":
        ins = {"seed": (config["valueType"],), **{i["id"]: (i["type"],) for i in config["fixedInputs"]}}
        return ins, {"result": config["valueType"], "decision": "JsonValue"}
    return {}, {}

def relative_ok(path):
    if not path or "\\" in path or ":" in path or path.startswith("/") or "*" in path or "?" in path:
        return False
    return all(part not in ("", ".", "..") for part in path.split("/"))

def compiles(schema):
    try:
        Draft202012Validator.check_schema(schema)
        for part in walk(schema):
            if "$ref" in part:
                if not part["$ref"].startswith("#"):
                    return False
                pointer(schema, part["$ref"][1:])
        return True
    except Exception:
        return False

def transportable(schema):
    """Mirror of runtime/core/transport.mjs refusal rules for native structured output."""
    def resolve(node, seen):
        if node is True or node is None:
            return {}
        if node is False:
            raise ValueError("false schema")
        ref = node.get("$ref") if isinstance(node, dict) else None
        if not isinstance(ref, str):
            return node
        if not ref.startswith("#/") or ref in seen:
            raise ValueError("reference")
        target = schema
        for key in ref[2:].split("/"):
            target = target[key.replace("~1", "/").replace("~0", "~")]
        rest = {k: v for k, v in node.items() if k != "$ref"}
        return resolve({**target, **rest}, seen | {ref})
    def fold(base, extra):
        out = dict(base)
        for key, value in extra.items():
            if key == "properties":
                props = dict(out.get("properties", {}))
                for name, child in value.items():
                    props[name] = fold(props[name], child) if name in props else child
                out["properties"] = props
            elif key == "required":
                out["required"] = list(dict.fromkeys(out.get("required", []) + value))
            elif key not in out:
                out[key] = value
        return out
    is_object = lambda n: isinstance(n, dict) and (n.get("type") == "object" or ("type" not in n and "properties" in n))
    def convert(node, depth=0):
        if depth > 32:
            raise ValueError("depth")
        node = resolve(node, frozenset())
        if isinstance(node.get("allOf"), list):
            rest = {k: v for k, v in node.items() if k != "allOf"}
            for branch in node["allOf"]:
                rest = fold(rest, resolve(branch, frozenset()))
            node = rest
        union = node.get("oneOf") or node.get("anyOf")
        if union:
            branches = [resolve(b, frozenset()) for b in union]
            if all(is_object(b) for b in branches):
                for b in branches:
                    convert(b, depth + 1)
                return "object"
            for b in branches:
                convert(b, depth + 1)
            return "union"
        if is_object(node):
            if not node.get("properties"):
                raise ValueError("free-form object")
            extra = node.get("additionalProperties")
            if extra not in (None, False):
                raise ValueError("additional properties")
            for child in node["properties"].values():
                convert(child, depth + 1)
            return "object"
        if node.get("type") == "array" or "items" in node:
            convert(node.get("items", {}), depth + 1)
        return node.get("type")
    try:
        return convert(schema) == "object"
    except (ValueError, KeyError, TypeError):
        return False

def context_ids(node):
    if node["type"] == "agent":
        return [node["config"]["contextId"]] if node["config"].get("contextId") else []
    if node["type"] == "map":
        return sorted({r["context"]["contextId"] for r in node["config"]["roles"] if r["kind"] == "agent" and r["context"] != "task"})
    return []

def workflow_issues(workflow, maximum=600):
    issues = set()
    caps = set(workflow["capabilities"])
    loops_enabled = "loops-v1" in caps
    everything, ids, edge_ids = {}, [], []
    def visit(nodes, edges, depth):
        for n in nodes:
            ids.append(n["id"]); everything.setdefault(n["id"], n)
            if (n["type"] == "map" or (n["type"] == "gate" and n["config"].get("subject") == "delivery")) and "delivery-v1" not in caps:
                issues.add("capability.delivery")
            if ((n["type"] == "gate" and n["config"].get("carry")) or (n["type"] == "map" and n["config"].get("carryAcrossRevisions"))) and "revisions-v1" not in caps:
                issues.add("capability.revisions")
            if n["type"] == "cache" and "cache-v1" not in caps:
                issues.add("capability.cache")
            if (n["type"] in ("gate", "route") or (n["type"] == "merge" and n["config"]["mode"] == "selected") or (n["type"] == "loop" and depth > 0)) and "pipeline-v1" not in caps:
                issues.add("capability.pipeline")
            if n["type"] == "loop":
                if depth + 1 > 3:
                    issues.add("loop.depth")
                visit(n["config"]["body"]["nodes"], n["config"]["body"]["edges"], depth + 1)
        edge_ids.extend(e["id"] for e in edges)
    visit(workflow["nodes"], workflow["edges"], 0)
    if len(ids) != len(set(ids)):
        issues.add("nodes.unique")
    if len(edge_ids) != len(set(edge_ids)):
        issues.add("edges.unique")
    outer_contexts = {n["id"]: n for n in workflow["nodes"] if n["type"] == "context"}
    key_of = lambda c: ("binding", c["config"]["bindingId"]) if c["config"]["mode"] == "continue" else ("node", c["id"])
    loop_keys = {}
    def collect(loop, visible):
        own = {n["id"]: n for n in loop["config"]["body"]["nodes"] if n["type"] == "context"}
        own_keys = {key_of(c) for c in own.values()}
        keys = set()
        for n in loop["config"]["body"]["nodes"]:
            for cid in context_ids(n):
                if cid not in own and cid in visible:
                    keys.add(key_of(visible[cid]))
            if n["type"] == "loop":
                keys |= collect(n, {**visible, **own}) - own_keys
        loop_keys[loop["id"]] = keys
        return keys
    for n in workflow["nodes"]:
        if n["type"] == "loop":
            collect(n, outer_contexts)

    def graph(nodes, edges, after, boundary, contexts):
        local = {n["id"]: n for n in nodes}
        adjacency = {key: set() for key in local}
        ports = {key: node_ports(n) for key, n in local.items()}
        if boundary:
            adjacency[INPUT], adjacency[RETURN] = set(), set()
            ports[INPUT] = ({}, boundary[0])
            ports[RETURN] = ({k: (v,) for k, v in boundary[1].items()}, {})
        for key, node in local.items():
            kind, config = node["type"], node["config"]
            if not loops_enabled and ((kind == "agent" and ("attachFiles" in config or config.get("captures"))) or (kind == "context" and config.get("lifetime"))):
                issues.add("capability.loops")
            if kind == "prompt-template":
                slots = [s["id"] for s in config["slots"]]
                if len(slots) != len(set(slots)):
                    issues.add("slots.unique")
                markers = re.findall(MARKER, config["template"])
                remainder = re.sub(MARKER, "", config["template"])
                if set(markers) != set(slots) or "{{" in remainder or "}}" in remainder:
                    issues.add("slots.markers")
            if kind == "agent":
                cid = config.get("contextId")
                if cid:
                    context = contexts.get(cid)
                    if not context:
                        issues.add("context.reference")
                    elif context["config"]["provider"] != config["provider"]:
                        issues.add("context.provider")
                if config["timeoutSeconds"] > maximum:
                    issues.add("timeout.capability")
                if "schema" in config["output"] and not compiles(config["output"]["schema"]):
                    issues.add("output.schema")
                if "schema" in config["output"] and not transportable(config["output"]["schema"]):
                    issues.add("output.transport")
                if any(not relative_ok(p) for p in config.get("captures", [])):
                    issues.add("file.path")
            if kind == "context" and config.get("lifetime") == "iteration" and not boundary:
                issues.add("context.lifetime")
            if kind == "file-input" and config["mode"] == "files" and any(not relative_ok(p) for p in config["paths"]):
                issues.add("file.path")
            if kind == "merge":
                names = [i["id"] for i in config["inputs"]]
                if len(names) != len(set(names)):
                    issues.add("merge.inputs")
                if config["mode"] == "record":
                    fields = [f["name"] for f in config["fields"]]
                    if len(fields) != len(set(fields)):
                        issues.add("merge.field")
                    declared = {i["id"]: i["type"] for i in config["inputs"]}
                    for field in config["fields"]:
                        source = field["source"]
                        if "input" in source:
                            if source["input"] not in declared:
                                issues.add("merge.field")
                            elif "pointer" in source and declared[source["input"]] != "JsonValue":
                                issues.add("merge.pointer")
                    if "schema" in config and not compiles(config["schema"]):
                        issues.add("output.schema")
            if kind == "loop":
                if "stateSchema" in config and not compiles(config["stateSchema"]):
                    issues.add("output.schema")
                if any(i["id"] in ("value", "iteration", "feedback", "seed") for i in config["fixedInputs"]):
                    issues.add("loop.boundary")
            if boundary and kind == "result-viewer":
                issues.add("loop.boundary")
            if kind == "map":
                roles = {r["id"]: r for r in config["roles"]}
                if len(roles) != len(config["roles"]):
                    issues.add("map.roles")
                for r in config["roles"]:
                    if r["kind"] == "utility" and roles.get(r["embeddedRoles"]["triage"], {}).get("kind") != "agent":
                        issues.add("map.roles")
                    if r["kind"] == "agent" and r["timeoutSeconds"] > maximum:
                        issues.add("timeout.capability")
                    if r["kind"] == "agent" and r["context"] != "task":
                        ctx = contexts.get(r["context"]["contextId"])
                        if not ctx or ctx["config"]["provider"] != r["provider"]:
                            issues.add("map.context")
                if len({x["id"] for x in config["approvalPolicy"]["slots"]}) != len(config["approvalPolicy"]["slots"]):
                    issues.add("gate.slot")
            if kind == "gate":
                slots = [x["id"] for x in config["policy"]["slots"]]
                if len(slots) != len(set(slots)) or set(slots) & {"subject", "plan", "issues", "report", "certificate", "documentation", "approval", "summary", "candidate", "technical", "prior"} or (config.get("carry") and any(len(x) > 59 for x in slots)):
                    issues.add("gate.slot")
            if kind == "route" and len({c["id"] for c in config["cases"]}) != len(config["cases"]):
                issues.add("route.cases")
        incoming = Counter()
        for edge in edges:
            source, target = edge["source"], edge["target"]
            if source["nodeId"] not in ports or target["nodeId"] not in ports:
                reserved = {source["nodeId"], target["nodeId"]} & {INPUT, RETURN}
                issues.add("loop.boundary" if reserved and not boundary else "edge.endpoint")
                continue
            produced = ports[source["nodeId"]][1].get(source["port"])
            accepted = ports[target["nodeId"]][0].get(target["port"])
            if produced is None or accepted is None:
                issues.add("loop.boundary" if INPUT in (source["nodeId"],) or target["nodeId"] == RETURN else "port.name")
            elif produced not in accepted:
                issues.add("port.type")
            incoming[target["nodeId"], target["port"]] += 1
            adjacency[source["nodeId"]].add(target["nodeId"])
        for key, (ins, _) in ports.items():
            for port in ins:
                if incoming[key, port] != 1:
                    issues.add("loop.return" if key == RETURN else "input.required")
        pairs = [(a["before"], a["after"]) for a in after]
        if len(pairs) != len(set(pairs)):
            issues.add("after.unique")
        for before, later in pairs:
            if (before not in local or later not in local or before == later
                    or local[before]["type"] == "context" or local[later]["type"] == "context"):
                issues.add("after.reference")
            else:
                adjacency[before].add(later)
        has_cycle = cyclic(adjacency)
        if has_cycle:
            issues.add("graph.cycle")
        def reaches(start, end):
            seen, stack = set(), list(adjacency[start])
            while stack:
                item = stack.pop()
                if item == end:
                    return True
                if item not in seen:
                    seen.add(item); stack.extend(adjacency[item])
            return False
        for key, node in local.items():
            if node["type"] == "gate" and node["config"]["mode"] == "evaluate":
                for slot in node["config"]["policy"]["slots"]:
                    for e in edges:
                        if e["target"]["nodeId"] == key and e["target"]["port"] == slot["id"]:
                            src = local.get(e["source"]["nodeId"])
                            direct = src and src["type"] == "agent" and e["source"]["port"] == "json"
                            joined = ("revisions-v1" in caps and src and src["type"] == "merge" and src["config"]["mode"] == "selected"
                                      and sum(1 for x in edges if x["target"]["nodeId"] == src["id"] and local.get(x["source"]["nodeId"], {}).get("type") == "agent" and x["source"]["port"] == "json") == 1)
                            if not direct and not joined:
                                issues.add("gate.review-source")
        if boundary and not has_cycle:
            decision = [e for e in edges if e["target"]["nodeId"] == RETURN and e["target"]["port"] == "decision"]
            if decision and decision[0]["source"]["nodeId"] != INPUT:
                target = decision[0]["source"]["nodeId"]
                for key, node in local.items():
                    if node["type"] == "cache" and node["config"]["mode"] == "frozen" and (key == target or reaches(key, target)):
                        issues.add("cache.decision")
        users = []
        for key, node in local.items():
            for cid in context_ids(node):
                if cid in contexts:
                    users.append((key, key_of(contexts[cid])))
            if node["type"] == "loop":
                users.extend((key, k) for k in loop_keys[key])
        if not has_cycle:
            for i, (a, ka) in enumerate(users):
                for b, kb in users[i + 1:]:
                    if a != b and ka == kb and not reaches(a, b) and not reaches(b, a):
                        issues.add("context.unordered")
        sinks = [RETURN] if boundary else [k for k, n in local.items() if n["type"] == "result-viewer"]
        if not boundary and not sinks:
            issues.add("viewer.required")
        for key, node in local.items():
            if node["type"] == "context":
                if not any(key in context_ids(o) for o in everything.values()):
                    issues.add("context.unused")
            elif node["type"] != "result-viewer" and not has_cycle and not any(reaches(key, s) for s in sinks):
                issues.add("node.sink")

    graph(workflow["nodes"], workflow["edges"], workflow["after"], None, outer_contexts)
    if set(workflow.get("view", {})) - {n["id"] for n in workflow["nodes"]}:
        issues.add("view.reference")
    def bodies(nodes, visible):
        for loop in [n for n in nodes if n["type"] == "loop"]:
            config, body = loop["config"], loop["config"]["body"]
            inputs = {"value": config["valueType"], "iteration": "JsonValue", "feedback": "Text", **{i["id"]: i["type"] for i in config["fixedInputs"]}}
            returns = {"candidate": config["valueType"], "decision": "JsonValue"}
            contexts = {**visible, **{n["id"]: n for n in body["nodes"] if n["type"] == "context"}}
            graph(body["nodes"], body["edges"], body["after"], (inputs, returns), contexts)
            if set(body.get("view", {})) - {n["id"] for n in body["nodes"]} - {INPUT, RETURN}:
                issues.add("view.reference")
            bodies(body["nodes"], contexts)
    bodies(workflow["nodes"], outer_contexts)
    return issues

def section_issues(index):
    issues = set()
    sections = {s["id"]: s for s in index["sections"]}
    if len(sections) != len(index["sections"]):
        issues.add("sections.unique")
    adjacency = {key: set(s["dependsOn"]) for key, s in sections.items()}
    if any(dep not in sections for deps in adjacency.values() for dep in deps):
        issues.add("section.reference")
    if cyclic(adjacency):
        issues.add("section.cycle")
    if any(not sections[dep]["normative"] for section in sections.values() if section["normative"]
           for dep in section["dependsOn"] if dep in sections):
        issues.add("section.informative_dependency")
    return issues

INDEX = read(ROOT / "docs/examples/round-recovery/spec-index.json")
ROLES = read(ROOT / "docs/fixtures/roles.json")

def map_issues(mapping):
    issues = section_issues(INDEX)
    sections = {s["id"]: s for s in INDEX["sections"]}
    tasks = {t["id"]: t for t in mapping["tasks"]}
    if len(tasks) != len(mapping["tasks"]):
        issues.add("tasks.unique")
    def closure(roots):
        result = set()
        def visit(key):
            if key in result:
                return
            if key not in sections:
                issues.add("task.section")
                return
            result.add(key)
            for dependency in sections[key]["dependsOn"]:
                visit(dependency)
        for key in roots:
            visit(key)
        return result
    adjacency = {key: set() for key in tasks}
    for task in tasks.values():
        for field in ("inputs", "outputs", "acceptanceCriteria"):
            if len({item["id"] for item in task[field]}) != len(task[field]):
                issues.add("task." + field + ".unique")
        deps = {d["taskId"]: d["milestone"] for d in task["dependsOn"]}
        if len(deps) != len(task["dependsOn"]):
            issues.add("task.deps.unique")
        for key in deps:
            if key not in tasks or key == task["id"]:
                issues.add("task.dependency")
            if key in tasks:
                adjacency[key].add(task["id"])
        inputs = {i["ref"][5:] for i in task["inputs"] if i["ref"].startswith("spec:")}
        scopes = {s[5:] for s in task["readScopes"] if s.startswith("spec:")}
        checks = {c["checkId"] for c in task["acceptanceCriteria"] if c["method"] == "check"}
        output_paths = {p for o in task["outputs"] if o["type"] == "fileSet" for p in o["paths"]}
        named_checks = {
            key for key, section in sections.items() if section["kind"] == "check"
            and any(normalized_path(arg) in output_paths for arg in section["command"]["args"])
        }
        if not named_checks <= inputs or not named_checks <= scopes:
            issues.add("task.check_input")
        needed = closure(set(task["requirementRefs"]) | inputs | checks | named_checks)
        if not needed <= inputs or not needed <= scopes:
            issues.add("task.closure")
        if any(key not in sections or not sections[key]["normative"]
               or sections[key]["kind"] not in ("requirement", "contract")
               for key in task["requirementRefs"]):
            issues.add("task.requirement")
        if any(key not in sections or sections[key]["kind"] != "check" for key in checks):
            issues.add("task.check")
        for item in task["inputs"]:
            if item["ref"].startswith("task:"):
                _, producer, output_id = item["ref"].split(":")
                if deps.get(producer) != "accepted":
                    issues.add("task.input_dependency")
                if producer not in tasks or not any(o["id"] == output_id for o in tasks[producer]["outputs"]):
                    issues.add("task.output_reference")
        role = ROLES.get(task["executorRole"])
        if role is None:
            issues.add("role.missing")
        captures = []
        for output in task["outputs"]:
            if output["type"] == "candidate" and (not role or role["kind"] != "utility"
                                                 or "candidate" not in role["engineOutputs"]):
                issues.add("role.candidate")
            for path in output.get("paths", []):
                if normalized_path(path) != path or "*" in path or "?" in path:
                    issues.add("task.path")
                captures.append(path.casefold())
                if output["type"] == "fileSet" and not any(scope_matches(path, s) for s in task["writeScopes"]):
                    issues.add("task.write_scope")
        if len(captures) != len(set(captures)):
            issues.add("task.path_collision")
        for criterion in task["acceptanceCriteria"]:
            if criterion["method"] == "review" and ROLES.get(criterion["role"], {}).get("kind") != "agent":
                issues.add("role.review")
    if cyclic(adjacency):
        issues.add("task.cycle")
    return issues

def normalized_path(path):
    if (not path or "\\" in path or ":" in path or path.startswith("/")
            or any(part in ("", "..") for part in path.split("/"))):
        return None
    return str(PurePosixPath(path))

def scope_matches(path, scope):
    if scope.endswith("/**"):
        return path.startswith(scope[:-2])
    return PurePosixPath(path).match(scope) if "*" in scope or "?" in scope else path == scope

def semantic(case, value):
    kind = case.get("semantic")
    if kind == "workflow":
        return workflow_issues(value, case.get("maximumAgentTimeoutSeconds", 600))
    if kind == "sections":
        return section_issues(value)
    if kind == "map":
        return map_issues(value)
    if kind == "capabilities":
        ids = [p["provider"] for p in value["providers"]]
        return set() if len(set(ids)) == 3 and set(ids) == {"codex", "claude", "antigravity"} else {"providers.unique"}
    return set()

manifest = read(ROOT / "docs/fixtures/manifest.json")
cases = manifest["valid"] + read(local_path(manifest["invalidFixture"]))
require(len({c["id"] for c in cases}) == len(cases), "Duplicate fixture IDs")
for case in cases:
    try:
        value = materialize(case)
        structural = list(validator(case).iter_errors(value))
        if case["expected"] == "valid":
            require(not structural, case["id"] + ": structural rejection: " + " | ".join(e.message for e in structural))
            if not structural:
                require(not semantic(case, value), case["id"] + ": semantic rejection")
            COUNTS["positiveSchemaCases"] += 1
        elif case["phase"] == "schema":
            require(bool(structural), case["id"] + ": expected schema rejection")
            COUNTS["negativeSchemaCases"] += 1
        else:
            require(not structural, case["id"] + ": semantic fixture must be structurally valid")
            if not structural:
                issues = semantic(case, value)
                require(case["code"] in issues, case["id"] + ": missing semantic error " + case["code"] + "; got " + str(sorted(issues)))
            COUNTS["negativeSemanticCases"] += 1
    except Exception as exc:
        ERRORS.append(case["id"] + ": " + str(exc))

for name, role in ROLES.items():
    require(role["kind"] in ("agent", "utility"), name + ": unsupported role kind")
    require(all(ROLES.get(r, {}).get("kind") == "agent" for r in role["embeddedRoles"]), name + ": invalid embedded role")
    require(role["kind"] != "agent" or not role["engineOutputs"], name + ": Agent claims engine output")

def outside_fences(text):
    lines, inside = [], False
    for line in text.splitlines():
        if line.startswith("```"):
            inside = not inside
            lines.append("")
        else:
            lines.append("" if inside else line)
    require(not inside, "Unbalanced Markdown fence")
    return "\n".join(lines)

def anchors(text):
    result, counts = set(), Counter()
    for line in outside_fences(text).splitlines():
        match = re.match(r"^#{1,6}\s+(.+)$", line)
        if not match:
            continue
        label = re.sub(r"<[^>]*>", "", match[1]).lower()
        slug = "".join(c for c in label if c.isalnum() or c in "_- ").replace(" ", "-")
        ordinal = counts[slug]
        counts[slug] += 1
        result.add(slug if ordinal == 0 else slug + "-" + str(ordinal))
    return result

for path in sorted((ROOT / "docs").rglob("*.md")) + [ROOT / "README.md"]:
    text = path.read_text(encoding="utf-8")
    COUNTS["markdownFiles"] += 1
    require(not re.search(r"[\u0400-\u04ff]", text), str(path.relative_to(ROOT)) + ": non-English documentation")
    plain = outside_fences(text)
    for match in re.finditer(r"(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)", plain):
        url = match[1].strip("<>")
        if re.match(r"^[a-z]+://", url) or url.startswith("mailto:"):
            continue
        target, _, fragment = url.partition("#")
        dest = (path.parent / unquote(target)).resolve() if target else path.resolve()
        COUNTS["localLinks"] += 1
        require(dest.exists(), str(path.relative_to(ROOT)) + ": missing link " + url)
        if fragment and dest.exists() and dest.suffix == ".md":
            require(unquote(fragment) in anchors(dest.read_text(encoding="utf-8")), str(path.relative_to(ROOT)) + ": missing anchor " + url)
    for match in re.finditer(r"```json\s*\n(.*?)\n```", text, re.S):
        value = json.loads(match[1], object_pairs_hook=strict, parse_constant=reject_constant)
        case = None
        if isinstance(value, dict) and "continue" in value:
            case = {"schema": "loop-decision.schema.json"}
        elif isinstance(value, dict) and "businessTask" in value:
            case = {"schema": "pipeline-state.schema.json", "definition": "deliveryState"}
        if case:
            require(validator(case).is_valid(value), str(path.relative_to(ROOT)) + ": invalid fenced JSON")
        COUNTS["jsonFences"] += 1
    COUNTS["mermaidDiagrams"] += len(re.findall(r"^```mermaid", text, re.M))
    if "reviews" not in path.parts:
        previous_list = False
        for i, line in enumerate(plain.splitlines()):
            is_list = bool(re.match(r"^(?:-|\d+\.) ", line))
            if is_list and i and plain.splitlines()[i - 1].strip() and not previous_list:
                ERRORS.append(str(path.relative_to(ROOT)) + ": blank line required before list at " + str(i + 1))
            previous_list = is_list

spec = (ROOT / "docs/examples/round-recovery/SPEC.md").read_text(encoding="utf-8")
headings = re.findall(r"^## ([A-Z][A-Z0-9-]*)\s*$", outside_fences(spec), re.M)
require(set(headings) == {s["id"] for s in INDEX["sections"]} and len(headings) == len(INDEX["sections"]),
        "Specification headings and section index differ")
sections = {s["id"]: s for s in INDEX["sections"]}
public = {key for key, s in sections.items() if s["normative"] and s["visibility"] == "public"
          and s["kind"] in ("business", "requirement", "acceptance")}
require(all(set(sections[key]["dependsOn"]) <= public for key in public), "Customer public view has an internal dependency")
COUNTS["sections"] = len(sections)
COUNTS["tasks"] = len(read(ROOT / "docs/examples/round-recovery/implementation-map.json")["tasks"])

decisions = read(ROOT / "docs/fixtures/decisions.json")
for case in decisions["selectedMerge"]:
    states = case["inputs"]
    active = sum(s in ("succeeded", "running", "failed") for s in states)
    if active > 1:
        result = "contract_error"
    elif "failed" in states:
        result = "recovery"
    elif "pending" in states or "running" in states:
        result = "wait"
    elif active == 1:
        result = "commit"
    else:
        result = "inactive"
    require(result == case["expected"], "Merge fixture: " + case["id"])
for case in decisions["verificationCycles"]:
    count = case["before"] + (1 if case["outcome"] == "failed" else 0)
    state = ("paused_recovery" if case["outcome"] == "operational_failure" else
             "paused_limit" if count >= case["limit"] else
             "passed" if case["outcome"] == "passed" else "repair_allowed")
    require({"count": count, "state": state} == case["expected"], "Map bound fixture: " + case["id"])
for case in decisions["capacity"]:
    result = len(case["running"]) < case["globalLimit"] and sum(
        r["provider"] == case["provider"] for r in case["running"]) < case["providerLimit"]
    require(result == case["expected"], "Capacity fixture: " + case["id"])
for case in decisions["failurePolicy"]:
    state = ("stopping" if case["action"] == "root_stop" else
             "failed" if case["action"] == "siblings_finished" and case["runningSiblings"] == 0 else "draining")
    result = {"state": state, "dispatch": False, "cancelSiblings": case["action"] == "root_stop"}
    if "bindingState" in case:
        result["bindingState"] = "needs_review" if case["nativeMayHaveAdvanced"] else case["bindingState"]
    require(result == case["expected"], "Failure fixture: " + case["id"])
for case in decisions["contextAvailability"]:
    require(case["stage"] in ("create_continue", "dispatch"), "Unknown Context availability stage")
    ready = case["bindingState"] == "ready"
    at_creation = case["stage"] == "create_continue"
    result = {
        "runState": ("queued" if ready else None) if at_creation else ("running" if ready else "draining"),
        "attemptState": None if at_creation or ready else "failed",
        "bindingState": case["bindingState"],
        "error": None if ready else "context_unavailable",
    }
    require(result == case["expected"], "Context availability fixture: " + case["id"])
M2_TRANSITIONS = {
    ("running", "attempt_failed"): "draining", ("draining", "running_finished"): "waiting_for_user",
    ("running", "idle_with_held_work"): "waiting_for_user", ("running", "all_succeeded"): "succeeded",
    ("waiting_for_user", "retry"): "running", ("waiting_for_user", "raise_limit"): "running",
    ("waiting_for_user", "restart_iteration"): "running", ("waiting_for_user", "close"): "failed",
}
for case in decisions["m2Lifecycle"]:
    state, event = case["state"], case["event"]
    if state in ("succeeded", "failed", "canceled", "interrupted"):
        result = "rejected"
    elif event == "runtime_restart":
        result = "interrupted"
    elif event == "root_stop":
        result = "stopping"
    else:
        result = M2_TRANSITIONS.get((state, event), "rejected")
    require(result == case["expected"], "M2 lifecycle fixture: " + case["id"])
for case in decisions["gateStatus"]:
    status = "OPEN" if all(v == "APPROVED" for v in case["verdicts"]) and case["openBlockers"] == 0 else "REVISION_REQUIRED"
    require(status == case["expected"], "Gate status fixture: " + case["id"])
for case in decisions["routeSelection"]:
    matches = [c for c in case["cases"] if json.dumps(c) == json.dumps(case["selector"])]
    result = "contract_error" if len(matches) > 1 else "unmatched" if not matches else matches[0]
    require(result == case["expected"], "Route fixture: " + case["id"])
for case in decisions["loopIteration"]:
    result = "finish" if not case["continue"] else "pause_iteration_limit" if case["iteration"] >= case["maxIterations"] else "next"
    require(result == case["expected"], "Loop iteration fixture: " + case["id"])
COUNTS["decisionCases"] = sum(len(v) for v in decisions.values())

db = sqlite3.connect(":memory:")
db.executescript((ROOT / "docs/storage/m1.sql").read_text(encoding="utf-8"))
require(db.execute("PRAGMA foreign_keys").fetchone()[0] == 1, "SQLite foreign keys disabled")
sql = read(ROOT / "docs/fixtures/sql-cases.json")
tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
require(tables == set(sql["tables"]), "SQLite table catalogue changed without fixtures")
COUNTS["sqlTables"] = len(tables)
for operation in sql["setup"]:
    db.execute(operation["sql"], operation.get("params", []))
for case in sql["cases"]:
    require(case["expected"] in ("accept", "reject"), case["id"] + ": invalid SQL expectation")
    try:
        cursor = db.execute(case["sql"], case.get("params", []))
        if case["expected"] == "reject":
            ERRORS.append(case["id"] + ": expected SQLite rejection")
        elif "rows" in case:
            require([list(row) for row in cursor.fetchall()] == case["rows"], case["id"] + ": wrong SQL projection")
    except sqlite3.IntegrityError as exc:
        require(case["expected"] == "reject" and case["reason"] in str(exc), case["id"] + ": unexpected constraint " + str(exc))
    COUNTS["sqlCases"] += 1

db.commit()
db.executescript((ROOT / "docs/storage/m2.sql").read_text(encoding="utf-8"))
require(db.execute("PRAGMA foreign_keys").fetchone()[0] == 1, "SQLite foreign keys disabled after migration 2")
require(not db.execute("PRAGMA foreign_key_check").fetchall(), "Migration 2 broke foreign keys")
sql2 = read(ROOT / "docs/fixtures/sql-cases-m2.json")
tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
require(tables == set(sql2["tables"]), "SQLite table catalogue after migration 2 changed without fixtures")
COUNTS["sqlTablesAfterMigration2"] = len(tables)
for case in sql2["cases"]:
    try:
        cursor = db.execute(case["sql"], case.get("params", []))
        if case["expected"] == "reject":
            ERRORS.append(case["id"] + ": expected SQLite rejection")
        elif "rows" in case:
            require([list(row) for row in cursor.fetchall()] == case["rows"], case["id"] + ": wrong SQL projection")
    except sqlite3.IntegrityError as exc:
        require(case["expected"] == "reject" and case["reason"] in str(exc), case["id"] + ": unexpected constraint " + str(exc))
    COUNTS["sqlCases"] += 1

db.commit()
db.executescript((ROOT / "docs/storage/m3.sql").read_text(encoding="utf-8"))
require(not db.execute("PRAGMA foreign_key_check").fetchall(), "Migration 3 broke foreign keys")
sql3 = read(ROOT / "docs/fixtures/sql-cases-m3.json")
tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
require(tables == set(sql3["tables"]), "SQLite table catalogue after migration 3 changed without fixtures")
COUNTS["sqlTablesAfterMigration3"] = len(tables)
for case in sql3["cases"]:
    try:
        cursor = db.execute(case["sql"], case.get("params", []))
        if case["expected"] == "reject":
            ERRORS.append(case["id"] + ": expected SQLite rejection")
        elif "rows" in case:
            require([list(row) for row in cursor.fetchall()] == case["rows"], case["id"] + ": wrong SQL projection")
    except sqlite3.IntegrityError as exc:
        require(case["expected"] == "reject" and case["reason"] in str(exc), case["id"] + ": unexpected constraint " + str(exc))
    COUNTS["sqlCases"] += 1

db.commit()
db.executescript((ROOT / "docs/storage/m4.sql").read_text(encoding="utf-8"))
require(not db.execute("PRAGMA foreign_key_check").fetchall(), "Migration 4 broke foreign keys")
sql4 = read(ROOT / "docs/fixtures/sql-cases-m4.json")
tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
require(tables == set(sql4["tables"]), "SQLite table catalogue after migration 4 changed without fixtures")
COUNTS["sqlTablesAfterMigration4"] = len(tables)
for case in sql4["cases"]:
    try:
        cursor = db.execute(case["sql"], case.get("params", []))
        if case["expected"] == "reject":
            ERRORS.append(case["id"] + ": expected SQLite rejection")
        elif "rows" in case:
            require([list(row) for row in cursor.fetchall()] == case["rows"], case["id"] + ": wrong SQL projection")
    except sqlite3.IntegrityError as exc:
        require(case["expected"] == "reject" and case["reason"] in str(exc), case["id"] + ": unexpected constraint " + str(exc))
    COUNTS["sqlCases"] += 1

db.commit()
db.executescript((ROOT / "docs/storage/m5.sql").read_text(encoding="utf-8"))
require(not db.execute("PRAGMA foreign_key_check").fetchall(), "Migration 5 broke foreign keys")
sql5 = read(ROOT / "docs/fixtures/sql-cases-m5.json")
tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
require(tables == set(sql5["tables"]), "SQLite table catalogue after migration 5 changed without fixtures")
COUNTS["sqlTablesAfterMigration5"] = len(tables)
for case in sql5["cases"]:
    try:
        cursor = db.execute(case["sql"], case.get("params", []))
        if case["expected"] == "reject":
            ERRORS.append(case["id"] + ": expected SQLite rejection")
        elif "rows" in case:
            require([list(row) for row in cursor.fetchall()] == case["rows"], case["id"] + ": wrong SQL projection")
    except sqlite3.IntegrityError as exc:
        require(case["expected"] == "reject" and case["reason"] in str(exc), case["id"] + ": unexpected constraint " + str(exc))
    COUNTS["sqlCases"] += 1

# Exercise integrity checks and strict parsing without files or provider processes.
raw = b'{"schemaVersion":1}'
expected_digest = hashlib.sha256(raw).hexdigest()
require(hashlib.sha256(raw + b" ").hexdigest() != expected_digest, "Byte mutation must change digest")
for text in ('{"id":1,"id":2}', '{"number":NaN}'):
    try:
        json.loads(text, object_pairs_hook=strict, parse_constant=reject_constant)
        ERRORS.append("Strict JSON accepted invalid bytes")
    except ValueError:
        COUNTS["strictJsonRejections"] += 1

print(json.dumps({**dict(COUNTS), "errors": ERRORS}, indent=2))
sys.exit(1 if ERRORS else 0)
