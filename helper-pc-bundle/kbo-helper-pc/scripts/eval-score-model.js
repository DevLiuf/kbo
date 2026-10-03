const fs = require("fs/promises");
const path = require("path");
const { parseArgs } = require("./ml-utils");
const { evaluateRows, validateModel } = require("../lib/score-model");
const { readNdjson } = require("../lib/artifacts");
const { eligibleExamples, rejectObsoleteOptions } = require("./score-training-utils");
function evaluateModel(model, inputRows, options = {}) {
  rejectObsoleteOptions(options);
  if (!validateModel(model)) throw new Error("Invalid schema-3 count model");
  const from = options.from || model.validationRange?.from;
  const to = options.to || model.validationRange?.to;
  if (!from || !to) throw new Error("Evaluation requires an explicit range or independent model validation range");
  const rows = eligibleExamples(inputRows, from, to);
  if (!rows.length) throw new Error("No eligible count examples in evaluation range");
  return evaluateRows(model, rows);
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  rejectObsoleteOptions(args);
  const model = JSON.parse(await fs.readFile(args.model || path.join(process.cwd(), "data", "run_model.kbo.json"), "utf8"));
  console.log(JSON.stringify(evaluateModel(model, await readNdjson(args.input || path.join(process.cwd(), "data", "run_training_examples.kbo.ndjson")), args), null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { evaluateModel, main };
