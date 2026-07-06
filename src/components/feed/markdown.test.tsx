import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, test } from "bun:test";

import { md } from "./markdown";

type AnchorProps = { href?: string; label?: string };

function findAnchor(rendered: ReturnType<typeof md>): ReactElement<AnchorProps> {
  const link = Children.toArray(rendered).find(
    (node): node is ReactElement<AnchorProps> => isValidElement(node) && Boolean((node.props as AnchorProps).href),
  );
  if (!link) throw new Error("no anchor rendered");
  return link;
}

describe("feed markdown links", () => {
  test("renders local markdown links as viewer deep links", () => {
    const link = findAnchor(md("see [markdown.tsx](/home/latand/app/src/components/feed/markdown.tsx:57)"));
    expect(link.props.href).toBe("#f=%2Fhome%2Flatand%2Fapp%2Fsrc%2Fcomponents%2Ffeed%2Fmarkdown.tsx");
    expect(link.props.label).toBe("markdown.tsx");
  });

  test("keeps external markdown links clickable", () => {
    const link = findAnchor(md("[docs](https://example.com/docs)"));
    expect(link.props.href).toBe("https://example.com/docs");
    expect(link.props.label).toBe("docs");
  });
});
