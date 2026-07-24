import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "..");

function productionSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "fixtures" ? [] : productionSources(filename);
      if (!/\.(?:js|mjs|ts|tsx)$/.test(entry.name) || /(?:\.test|\.fixture)\.[^.]+$/.test(entry.name)) return [];
      return [filename];
    });
}

test("production Bun child paths use the credential-isolated environment seam", () => {
  const inventory: Array<{ file: string; method: string }> = [];
  const uncovered: string[] = [];
  for (const filename of ["bin", "scripts", "src"].flatMap((directory) => productionSources(path.join(root, directory)))) {
    const sourceText = fs.readFileSync(filename, "utf8");
    const source = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "Bun"
        && (node.expression.name.text === "spawn" || node.expression.name.text === "spawnSync")) {
        const method = node.expression.name.text;
        const options = ts.isObjectLiteralExpression(node.arguments[0]) ? node.arguments[0] : node.arguments[1];
        const env = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property)
            && ((ts.isIdentifier(property.name) && property.name.text === "env")
              || (ts.isStringLiteral(property.name) && property.name.text === "env")))
          : undefined;
        const relativeFile = path.relative(root, filename);
        inventory.push({ file: relativeFile, method });
        if (!env || !env.initializer.getText(source).includes("withoutWakatimeCredential")) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          uncovered.push(`${relativeFile}:${line}:${method}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  expect(uncovered).toEqual([]);
  expect(inventory).toEqual([
    { file: "scripts/deploy-staging.ts", method: "spawn" },
    ...Array.from({ length: 8 }, () => ({ file: "scripts/privacy-publication-gate.ts", method: "spawnSync" })),
    { file: "scripts/runtime-host-viewer-adapter.ts", method: "spawn" },
  ]);
});
