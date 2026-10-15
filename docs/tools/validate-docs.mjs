import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const checker = fileURLToPath(new URL("./validate_docs.py", import.meta.url));
const override = process.env.DESZO_DOCS_PYTHON;
const candidates = override
  ? [[override, []]]
  : process.platform === "win32"
    ? [["python", []], ["py", ["-3"]], ["python3", []]]
    : [["python3", []], ["python", []]];

for (const [executable, args] of candidates) {
  const probe = spawnSync(executable, [...args, "-c",
    "import sys; from importlib.metadata import version; assert sys.version_info >= (3,11); assert version('jsonschema') == '4.26.0'; from jsonschema import FormatChecker; assert {'uuid','date-time'} <= FormatChecker().checkers.keys()"],
    { cwd: root, encoding: "utf8", windowsHide: true });
  if (probe.error || probe.status !== 0) continue;
  const result = spawnSync(executable, [...args, checker], {
    cwd: root, stdio: "inherit", windowsHide: true,
  });
  if (result.error) {
    process.stderr.write(String(result.error) + "\n");
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

process.stderr.write(
  "docs:check needs Python >= 3.11 with jsonschema 4.26.0.\n" +
  "Install: python -m pip install -r docs/tools/requirements.txt\n" +
  "Set DESZO_DOCS_PYTHON to an interpreter path if Python is not on PATH.\n",
);
process.exit(1);
