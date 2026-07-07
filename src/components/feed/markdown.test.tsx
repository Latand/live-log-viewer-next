import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, test } from "bun:test";

import { md } from "./markdown";

type AnchorProps = { href?: string; label?: string };
type ImgProps = { alt?: string; src?: string };

function findAnchor(rendered: ReturnType<typeof md>): ReactElement<AnchorProps> {
  const link = Children.toArray(rendered).find(
    (node): node is ReactElement<AnchorProps> => isValidElement(node) && Boolean((node.props as AnchorProps).href),
  );
  if (!link) throw new Error("no anchor rendered");
  return link;
}

/* MdImage renders its <img> inside a fragment, so walk the rendered tree for
   the first element carrying an `alt` prop. */
function findImg(node: unknown): ReactElement<ImgProps> | null {
  for (const child of Children.toArray(node as ReturnType<typeof md>)) {
    if (!isValidElement(child)) continue;
    const props = child.props as ImgProps & { children?: unknown };
    if (typeof props.src === "string" && "alt" in props) return child as ReactElement<ImgProps>;
    const nested = findImg(props.children);
    if (nested) return nested;
  }
  return null;
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

describe("feed markdown images", () => {
  test("embeds image markdown instead of rendering a link", () => {
    const rendered = md("![Admins screen](/home/latand/Projects/app/shot.png)");
    const img = findImg(rendered);
    expect(img).not.toBeNull();
    expect(img!.props.alt).toBe("Admins screen");
    expect(img!.props.src).toBe("/home/latand/Projects/app/shot.png");
    expect(() => findAnchor(rendered)).toThrow();
  });

  test("embeds remote image markdown", () => {
    const img = findImg(md("![shot](https://example.com/a.png)"));
    expect(img).not.toBeNull();
    expect(img!.props.src).toBe("https://example.com/a.png");
  });
});
