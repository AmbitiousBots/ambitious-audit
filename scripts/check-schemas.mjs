#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireValidator } from "../src/domain/wire-validator.ts";

const repoRoot = join(import.meta.dirname, "..");
const schemaDirectory = join(repoRoot, "schemas");
const exampleDirectory = join(schemaDirectory, "examples");
const expectedFile = join(exampleDirectory, "EXPECTED.json");
const generatedFile = join(repoRoot, "src", "domain", "wire.generated.ts");

const SCHEMAS = [
  { file: "collector.v1.json", typeName: "CollectorV1", sentToService: false },
  { file: "collector.v2.json", typeName: "CollectorV2", sentToService: false },
  { file: "send_report.v1.json", typeName: "SendReportV1", sentToService: true, maxTextCharacters: 24000 },
  { file: "send_report.v2.json", typeName: "SendReportV2", sentToService: true, maxTextCharacters: 29000 },
  // WHY: V3 adds ten announcements, each with a 64-character id and a 120-character title: 29000 + 10 * (64 + 120). Priority enums add no free text.
  { file: "send_report.v3.json", typeName: "SendReportV3", sentToService: true, maxTextCharacters: 30840 },
  // WHY: Each of 200 bots adds a name and three timestamps. V4 also adds 200 connector names and one plan timestamp.
  { file: "send_report.v4.json", typeName: "SendReportV4", sentToService: true, maxTextCharacters: 93264 },
  { file: "send_feedback.v1.json", typeName: "SendFeedbackV1", sentToService: true, maxTextCharacters: 4100 },
];

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$defs"]);
const KEYWORDS = new Set([
  ...ANNOTATIONS,
  "type",
  "properties",
  "patternProperties",
  "required",
  "additionalProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "allOf",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "exclusiveMinimum",
  "multipleOf",
  "oneOf",
  "maximum",
  "$ref",
  "if",
  "then",
  "else",
]);
const ORGANISATION_NAME = /^org(ani[sz]ation)?[_-]?(id|key|slug|name)?$/i;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const typesOf = (node) => (node.type === undefined ? [] : [node.type].flat());
const pascal = (name) => name.charAt(0).toUpperCase() + name.slice(1);

const resolve = (root, node) => {
  if (node.$ref === undefined) return node;
  const name = node.$ref.match(/^#\/\$defs\/([A-Za-z0-9]+)$/)?.[1];
  if (name === undefined || root.$defs?.[name] === undefined) throw new Error(`cannot follow ${node.$ref}`);
  return root.$defs[name];
};

const sameMembers = (left, right) => left.length === right.length && left.every((item) => right.includes(item));

const oneOfForms = (node) => {
  const forms = [];
  if (!Array.isArray(node.oneOf) || node.if || node.then || node.else) return { problem: true };
  const nullable = typesOf(node).includes("null");
  if (node.oneOf.filter((branch) => branch?.type === "null").length !== Number(nullable)) return { problem: true };
  for (const branch of node.oneOf) {
    if (branch === null || typeof branch !== "object") return { problem: true };
    if (branch.type === "null" && sameMembers(Object.keys(branch), ["type"])) continue;
    if (branch.type !== "object" || !branch.properties || !typesOf(node).includes("object") ||
        Object.keys(branch).some((key) => !["type", "properties", "required"].includes(key))) return { problem: true };
    const properties = { ...node.properties };
    const required = [...(node.required ?? []), ...(branch.required ?? [])];
    for (const [key, limit] of Object.entries(branch.properties)) {
      const base = properties[key];
      if (!base) return { problem: true };
      if (limit === true) continue;
      if (limit === false) properties[key] = false;
      else if (limit === null || typeof limit !== "object") return { problem: true };
      else if (sameMembers(Object.keys(limit), ["enum"]) && Array.isArray(limit.enum) && limit.enum.every((value) => base.enum?.includes(value))) properties[key] = limit;
      else if (sameMembers(Object.keys(limit), ["type"]) && typesOf(base).includes(limit.type)) properties[key] = { ...base, type: limit.type };
      else return { problem: true };
    }
    if (required.some((key) => !properties[key])) return { problem: true };
    forms.push({ properties, required });
  }
  return { forms };
};

const formsOf = (node) => {
  if (node.oneOf !== undefined) return oneOfForms(node);
  if (node.if === undefined && node.then === undefined && node.else === undefined) return null;
  const tags = Object.keys(node.if?.properties ?? {});
  const tag = tags[0];
  const value = node.if?.properties?.[tag]?.const;
  const allowed = node.properties?.[tag]?.enum ?? [];
  const wellFormedIf =
    node.if !== undefined &&
    sameMembers(Object.keys(node.if), ["type", "required", "properties"]) &&
    node.if.type === "object" &&
    tags.length === 1 &&
    sameMembers(node.if.required ?? [], [tag]) &&
    sameMembers(Object.keys(node.if.properties[tag]), ["const"]) &&
    allowed.includes(value) &&
    (node.required ?? []).includes(tag);
  const wellFormedBranch = (branch) =>
    branch !== undefined &&
    Object.keys(branch).every((key) => key === "required" || key === "properties") &&
    (branch.required ?? []).every((name) => node.properties?.[name] !== undefined) &&
    Object.entries(branch.properties ?? {}).every(
      ([name, schema]) => node.properties?.[name] !== undefined && name !== tag && schema === (branch.required ?? []).includes(name),
    ) &&
    (branch.required ?? []).every((name) => branch.properties?.[name] === true);
  if (!wellFormedIf || !wellFormedBranch(node.then) || !wellFormedBranch(node.else)) return { problem: true };
  const form = (branch, tagSchema) => ({
    required: [...(node.required ?? []), ...(branch.required ?? [])],
    properties: Object.fromEntries(
      Object.entries(node.properties)
        .filter(([name]) => branch.properties?.[name] !== false)
        .map(([name, schema]) => [name, name === tag ? tagSchema : schema]),
    ),
  });
  return { problem: false, forms: [form(node.else, { enum: allowed.filter((item) => item !== value) }), form(node.then, { const: value })] };
};

const shapeChildren = (node) => [
  ...Object.entries(node.properties ?? {}).map(([key, child]) => [`/properties/${key}`, child]),
  ...Object.entries(node.patternProperties ?? {}).map(([key, child]) => [`/patternProperties/${key}`, child]),
  ...(node.items === undefined ? [] : [["/items", node.items]]),
  ...Object.entries(node.$defs ?? {}).map(([key, child]) => [`/$defs/${key}`, child]),
];

const lintNode = (root, node, at) => {
  const problems = [];
  const say = (message) => problems.push(`${at || "/"}: ${message}`);
  for (const keyword of Object.keys(node)) {
    if (!KEYWORDS.has(keyword)) say(`uses "${keyword}", which this check does not understand; a keyword it cannot read could let unbounded text through`);
  }
  const types = typesOf(node);
  if (node.$ref === undefined && types.length === 0 && node.enum === undefined && node.const === undefined) {
    say("accepts any value; give it a type, an enum or a const");
  }
  if (node.$ref !== undefined) {
    try {
      resolve(root, node);
    } catch (error) {
      say(error.message);
    }
  }
  if (types.includes("string") && !Number.isInteger(node.maxLength)) say("is a string with no maxLength");
  if (types.includes("array")) {
    if (!Number.isInteger(node.maxItems)) say("is a list with no maxItems");
    if (node.items === undefined) say("is a list with no items schema");
  }
  if (types.includes("object")) {
    if (node.additionalProperties !== false) say("is an object that does not reject unknown properties (additionalProperties: false)");
    if (node.patternProperties !== undefined && !Number.isInteger(node.maxProperties)) say("has patternProperties with no maxProperties");
    for (const name of node.required ?? []) {
      if (node.properties?.[name] === undefined) say(`requires "${name}" but does not describe it`);
    }
  }
  for (const name of Object.keys(node.properties ?? {})) {
    if (ORGANISATION_NAME.test(name)) say(`declares "${name}"; the organisation comes from the caller's credential and never from the payload`);
  }
  if (formsOf(node)?.problem === true) {
    if (node.oneOf !== undefined) say("oneOf branches must narrow properties of the enclosing object");
    else say('uses "if", "then" and "else" in a way this check does not understand. They may only split an object into two forms by one required property: "if" tests that property against a const, and "then" and "else" each list more required properties, set each of those to true under "properties", and set the properties of the other form to false');
  }
  for (const [index, part] of (node.allOf ?? []).entries()) {
    const keys = Object.keys(part);
    if (keys.length !== 1 || keys[0] !== "contains") say(`allOf/${index} may only hold a "contains" test`);
  }
  return [...problems, ...shapeChildren(node).flatMap(([suffix, child]) => lintNode(root, child, `${at}${suffix}`))];
};

const textBound = (root, node) => {
  const target = resolve(root, node);
  const types = typesOf(target);
  if (target.enum !== undefined || target.const !== undefined) return 0;
  const asString = types.includes("string") ? target.maxLength : 0;
  const asArray = types.includes("array") ? target.maxItems * textBound(root, target.items) : 0;
  const named = Object.values(target.properties ?? {}).reduce((sum, child) => sum + textBound(root, child), 0);
  const patterned = Object.values(target.patternProperties ?? {}).reduce(
    (most, child) => Math.max(most, target.maxProperties * textBound(root, child)),
    0,
  );
  return Math.max(asString, asArray, types.includes("object") ? named + patterned : 0);
};

const literal = (value) => JSON.stringify(value);

const typeOf = (root, typeName, node) => {
  if (node === false) return "never";
  if (node.$ref !== undefined) return `${typeName}${pascal(node.$ref.split("/").at(-1))}`;
  if (node.const !== undefined) return literal(node.const);
  if (node.enum !== undefined) return node.enum.map(literal).join(" | ");
  const variants = typesOf(node).map((type) => {
    if (type === "string") return "string";
    if (type === "integer" || type === "number") return "number";
    if (type === "boolean") return "boolean";
    if (type === "null") return "null";
    if (type === "array") {
      const item = typeOf(root, typeName, node.items);
      return `readonly ${/[ |{]/.test(item) ? `(${item})` : item}[]`;
    }
    if (type === "object") {
      const patterned = Object.values(node.patternProperties ?? {}).map(
        (child) => `readonly [name: string]: ${typeOf(root, typeName, child)}`,
      );
      const objectType = (form) => {
        const required = new Set(form.required ?? []);
        const named = Object.entries(form.properties ?? {}).map(
          ([key, child]) => `readonly ${key}${required.has(key) ? "" : "?"}: ${typeOf(root, typeName, child)}`,
        );
        return `{ ${[...named, ...patterned].join("; ")} }`;
      };
      return (formsOf(node)?.forms ?? [node]).map(objectType).join(" | ");
    }
    throw new Error(`no TypeScript type for JSON type "${type}"`);
  });
  return variants.join(" | ");
};

const generateTypes = (loaded) =>
  loaded
    .flatMap(({ schema, typeName }) => [
      ...Object.entries(schema.$defs ?? {}).map(
        ([name, node]) => `export type ${typeName}${pascal(name)} = ${typeOf(schema, typeName, node)};`,
      ),
      `export type ${typeName} = ${typeOf(schema, typeName, schema)};`,
    ])
    .join("\n\n")
    .concat("\n");

const exampleFiles = (schemaFile, kind) => {
  const directory = join(exampleDirectory, schemaFile.replace(/\.json$/, ""), kind);
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => ({ key: `${schemaFile.replace(/\.json$/, "")}/${kind}/${name}`, path: join(directory, name) }))
    : [];
};

const checkExamples = (validate, schemaFile, expected) => {
  const valid = exampleFiles(schemaFile, "valid");
  const invalid = exampleFiles(schemaFile, "invalid");
  const problems = [];
  if (valid.length === 0) problems.push(`${schemaFile}: add at least one example under examples/${schemaFile.replace(/\.json$/, "")}/valid`);
  if (invalid.length === 0) problems.push(`${schemaFile}: add at least one example under examples/${schemaFile.replace(/\.json$/, "")}/invalid`);
  for (const { key, path } of valid) {
    if (!validate(readJson(path))) problems.push(`${key}: must be accepted, but: ${validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}`);
  }
  for (const { key, path } of invalid) {
    const want = expected[key];
    if (want === undefined) {
      problems.push(`${key}: add it to schemas/examples/EXPECTED.json with the keyword and path that must reject it`);
      continue;
    }
    if (validate(readJson(path))) {
      problems.push(`${key}: must be rejected, but the schema accepts it`);
      continue;
    }
    const hit = validate.errors.some((e) => e.keyword === want.keyword && e.instancePath === want.at);
    if (!hit) {
      problems.push(
        `${key}: rejected, but not by "${want.keyword}" at "${want.at}" as EXPECTED.json says. It was rejected by: ${validate.errors.map((e) => `"${e.keyword}" at "${e.instancePath}"`).join(", ")}`,
      );
    }
  }
  return { problems, valid: valid.length, invalid: invalid.length, keys: invalid.map(({ key }) => key) };
};

const domainAgreement = async (loaded) => {
  const { WIRE_PATTERNS, WIRE_LIMITS } = await import(join(repoRoot, "src", "domain", "types.ts"));
  const schema = Object.fromEntries(loaded.map((entry) => [entry.typeName, entry.schema]));
  const pairs = [
    ...[schema.SendReportV2, schema.SendReportV3, schema.SendReportV4].flatMap((report) => [
      ["WIRE_PATTERNS.uuidV7", WIRE_PATTERNS.uuidV7.source, report.$defs.uuidV7.pattern],
      ["WIRE_PATTERNS.evidenceId", WIRE_PATTERNS.evidenceId.source, report.$defs.evidenceId.pattern],
      ["WIRE_PATTERNS.ruleId", WIRE_PATTERNS.ruleId.source, report.$defs.finding.properties.ruleId.pattern],
      ["WIRE_PATTERNS.recommendationId", WIRE_PATTERNS.recommendationId.source, report.$defs.recommendation.properties.id.pattern],
      ["WIRE_PATTERNS.timestamp", WIRE_PATTERNS.timestamp.source, report.$defs.timestamp.pattern],
      ["WIRE_PATTERNS.semver", WIRE_PATTERNS.semver.source, report.$defs.semver.pattern],
      ["WIRE_LIMITS.summaryCharacters", WIRE_LIMITS.summaryCharacters, report.properties.summary.maxLength],
      ["WIRE_LIMITS.evidenceTextCharacters", WIRE_LIMITS.evidenceTextCharacters, report.$defs.evidence.properties.text.maxLength],
      ["WIRE_LIMITS.recommendations", WIRE_LIMITS.recommendations, report.properties.recommendations.maxItems],
    ]),
    ["WIRE_PATTERNS.uuidV7", WIRE_PATTERNS.uuidV7.source, schema.SendFeedbackV1.$defs.uuidV7.pattern],
    ...[schema.CollectorV1, schema.CollectorV2].flatMap((collector) => [
      ["WIRE_PATTERNS.evidenceId", WIRE_PATTERNS.evidenceId.source, collector.$defs.evidenceId.pattern],
      ["WIRE_PATTERNS.timestamp", WIRE_PATTERNS.timestamp.source, collector.$defs.timestamp.pattern],
      ["WIRE_LIMITS.evidenceTextCharacters", WIRE_LIMITS.evidenceTextCharacters, collector.$defs.evidence.properties.text.maxLength],
    ]),
    ["WIRE_LIMITS.feedbackTextCharacters", WIRE_LIMITS.feedbackTextCharacters, schema.SendFeedbackV1.properties.text.maxLength],
    ...[schema.SendReportV3, schema.SendReportV4].flatMap((report) => [
      ["WIRE_PATTERNS.announcementId", WIRE_PATTERNS.announcementId.source, report.$defs.announcement.properties.id.pattern],
      ["WIRE_LIMITS.announcements", WIRE_LIMITS.announcements, report.properties.announcements.maxItems],
      ["WIRE_LIMITS.announcementTitleCharacters", WIRE_LIMITS.announcementTitleCharacters, report.$defs.announcement.properties.title.maxLength],
    ]),
  ];
  return {
    compared: pairs.length,
    problems: pairs
      .filter(([, inTypes, inSchema]) => inTypes !== inSchema)
      .map(([name, inTypes, inSchema]) => `src/domain/types.ts: ${name} is ${inTypes} but the schema says ${inSchema}`),
  };
};

const REQUIRED_LIMITS = [
  ["send_report.v4.json bots", (s) => s.SendReportV4.properties.bots.maxItems, 200],
  ["send_report.v4.json connectors", (s) => s.SendReportV4.properties.connectors.maxItems, 200],
  ["send_report.v4.json bot name", (s) => s.SendReportV4.$defs.bot.properties.name.maxLength, 120],
  ["send_report.v4.json connector name", (s) => s.SendReportV4.$defs.connector.properties.name.maxLength, 120],
  ["send_report.v1.json summary", (s) => s.SendReportV1.properties.summary.maxLength, 1200],
  ["send_report.v1.json evidence text", (s) => s.SendReportV1.$defs.evidence.properties.text.maxLength, 280],
  ["collector.v1.json evidence text", (s) => s.CollectorV1.$defs.evidence.properties.text.maxLength, 280],
  ["send_feedback.v1.json text", (s) => s.SendFeedbackV1.properties.text.maxLength, 4000],
  ["send_report.v1.json recommendations", (s) => s.SendReportV1.properties.recommendations.maxItems, 3],
  ["send_report.v2.json summary", (s) => s.SendReportV2.properties.summary.maxLength, 1200],
  ["send_report.v2.json evidence text", (s) => s.SendReportV2.$defs.evidence.properties.text.maxLength, 280],
  ["send_report.v2.json recommendations", (s) => s.SendReportV2.properties.recommendations.maxItems, 3],
  ["send_report.v3.json summary", (s) => s.SendReportV3.properties.summary.maxLength, 1200],
  ["send_report.v3.json evidence text", (s) => s.SendReportV3.$defs.evidence.properties.text.maxLength, 280],
  ["send_report.v3.json findings", (s) => s.SendReportV3.properties.findings.maxItems, 20],
  ["send_report.v3.json recommendations", (s) => s.SendReportV3.properties.recommendations.maxItems, 3],
  ["send_report.v3.json announcements", (s) => s.SendReportV3.properties.announcements.maxItems, 10],
  ["send_report.v3.json announcement id", (s) => s.SendReportV3.$defs.announcement.properties.id.maxLength, 64],
  ["send_report.v3.json announcement title", (s) => s.SendReportV3.$defs.announcement.properties.title.maxLength, 120],
];

const run = async (argv) => {
  const write = argv.includes("--write");
  const expected = readJson(expectedFile);
  const loaded = SCHEMAS.map((entry) => ({ ...entry, schema: readJson(join(schemaDirectory, entry.file)) }));
  const problems = [];
  const seenKeys = [];
  let readable = true;
  for (const { file, schema, sentToService, maxTextCharacters } of loaded) {
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") problems.push(`${file}: $schema must be JSON Schema draft 2020-12`);
    const lint = lintNode(schema, schema, "").map((problem) => `${file}${problem}`);
    problems.push(...lint);
    if (lint.length > 0) {
      readable = false;
      continue;
    }
    const bound = textBound(schema, schema);
    if (sentToService && bound > maxTextCharacters) {
      problems.push(`${file}: a payload could carry ${bound} characters of free text, more than the ${maxTextCharacters} allowed for something sent to the service`);
    }
    const examples = checkExamples(wireValidator.compile(schema), file, expected);
    problems.push(...examples.problems);
    seenKeys.push(...examples.keys);
    process.stdout.write(
      `${file}: unknown properties rejected everywhere, every string and list bounded, at most ${bound} characters of free text; ${examples.valid} valid and ${examples.invalid} invalid example(s)\n`,
    );
  }
  for (const key of readable ? Object.keys(expected) : []) {
    if (!seenKeys.includes(key)) problems.push(`schemas/examples/EXPECTED.json: "${key}" has no example file`);
  }
  if (readable) {
    const byType = Object.fromEntries(loaded.map((entry) => [entry.typeName, entry.schema]));
    for (const [name, read, most] of REQUIRED_LIMITS) {
      if (read(byType) > most) problems.push(`${name} allows ${read(byType)}, more than the published limit of ${most}`);
    }
    const { COMMAND_INPUT_SCHEMAS } = await import(join(repoRoot, "src", "domain", "command-inputs.ts"));
    const inputProblems = Object.entries(COMMAND_INPUT_SCHEMAS).flatMap(([command, schema]) =>
      lintNode(schema, schema, "").map((problem) => `input of "${command}"${problem}`),
    );
    problems.push(...inputProblems);
    if (inputProblems.length === 0) {
      process.stdout.write(`command inputs: ${Object.keys(COMMAND_INPUT_SCHEMAS).length} schemas reject unknown properties and bound every string and list\n`);
    }
    const agreement = await domainAgreement(loaded);
    problems.push(...agreement.problems);
    if (agreement.problems.length === 0) {
      process.stdout.write(`src/domain/types.ts: ${agreement.compared} patterns and limits equal the schemas\n`);
    }
    const types = generateTypes(loaded);
    if (write) {
      writeFileSync(generatedFile, types);
      process.stdout.write("src/domain/wire.generated.ts: written\n");
    } else if (!existsSync(generatedFile) || readFileSync(generatedFile, "utf8") !== types) {
      problems.push("src/domain/wire.generated.ts is out of date with the schemas. Run: npm run generate:wire-types");
    } else {
      process.stdout.write("src/domain/wire.generated.ts: matches the schemas\n");
    }
  }
  for (const problem of problems) process.stdout.write(`FAIL: ${problem}\n`);
  process.stdout.write(problems.length === 0 ? "check:schemas: ok\n" : `check:schemas: ${problems.length} problem(s)\n`);
  return problems.length === 0 ? 0 : 1;
};

process.exitCode = await run(process.argv.slice(2));
