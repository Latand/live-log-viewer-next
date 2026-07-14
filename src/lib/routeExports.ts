import ts from "typescript";

const ALLOWED_ROUTE_EXPORTS = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "config",
  "generateStaticParams",
  "unstable_instant",
  "unstable_dynamicStaleTime",
  "revalidate",
  "dynamic",
  "dynamicParams",
  "fetchCache",
  "preferredRegion",
  "runtime",
  "maxDuration",
]);

export type InvalidRouteExport = {
  file: string;
  line: number;
  name: string;
};

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

export function invalidRouteExports(sourceText: string, file = "route.ts"): InvalidRouteExport[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const invalid: InvalidRouteExport[] = [];

  const report = (name: string, node: ts.Node) => {
    if (ALLOWED_ROUTE_EXPORTS.has(name)) return;
    invalid.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      name,
    });
  };

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause) {
        report("*", statement);
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        report(statement.exportClause.name.text, statement.exportClause.name);
      } else {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) report(element.name.text, element.name);
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      report("default", statement);
      continue;
    }

    if (!hasExportModifier(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) report(name.text, name);
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const isDefault = ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true;
      if (isDefault) report("default", statement);
      else if (statement.name) report(statement.name.text, statement.name);
      continue;
    }

    if (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      report(statement.name.getText(source), statement.name);
    }
  }

  return invalid;
}
