const path = require("path");
const fs = require("fs/promises");
const { parseArgs } = require("./ml-utils");
const { readRows, eligibleExamples, evaluateRows, validateModel, validateRange } = require("../lib/logistic");

function evaluateModel(model, inputRows, options = {}) {
  if (!validateModel(model)) throw new Error("Invalid schema-2 model");
  const from = options.from || model.validationRange?.from;
  const to = options.to || model.validationRange?.to;
  if (!from || !to) throw new Error("Evaluation requires model.validationRange or explicit --from/--to");
  validateRange(from, to);
  const rows = eligibleExamples(inputRows, from, to);
  if (!rows.length) throw new Error("No eligible examples in evaluation range");
  return { modelVersion: model.version, requestedRange: { from, to }, ...evaluateRows(model, rows) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || path.join(process.cwd(), "data", "training_examples.kbo.ndjson");
  const modelFile = args.model || path.join(process.cwd(), "data", "model_coefficients.kbo.json");
  const model = JSON.parse(await fs.readFile(modelFile, "utf8"));
  console.log(JSON.stringify(evaluateModel(model, await readRows(input), args), null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { evaluateModel, main };
