import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasoningControls } from "./ReasoningControls";

for (const model of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna"]) {
  test(`launch reasoning selector follows ${model}`, () => {
    const html = renderToStaticMarkup(<ReasoningControls engine="codex" model={model} effort="max" speed="" onModel={() => {}} onEffort={() => {}} onSpeed={() => {}} />);
    expect(html).toContain('value="max" selected=""');
    expect(html.includes('value="ultra"')).toBe(model !== "gpt-5.6-luna");
  });
}
