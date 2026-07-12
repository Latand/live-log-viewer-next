import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ParentRemovedChip } from "./BranchPane";

test("deleted parent lineage renders a compact tombstone chip", () => {
  const html = renderToStaticMarkup(<ParentRemovedChip />);
  expect(html).toContain("parent removed");
  expect(html).toContain("The parent conversation transcript was removed");
});
