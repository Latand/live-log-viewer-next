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

/* An anchor can sit inside another element (a link wrapped in bold), so collect
   them by walking the whole rendered tree instead of its top level only. */
function collectAnchors(node: unknown, found: ReactElement<AnchorProps>[] = []): ReactElement<AnchorProps>[] {
  for (const child of Children.toArray(node as ReturnType<typeof md>)) {
    if (!isValidElement(child)) continue;
    const props = child.props as AnchorProps & { children?: unknown };
    if (typeof props.href === "string") found.push(child as ReactElement<AnchorProps>);
    else collectAnchors(props.children, found);
  }
  return found;
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
  test("hands local links to the Anchor with their raw spelling", () => {
    /* The Anchor decides at render time: artifact extensions (like this .tsx)
       open the in-app preview (#875), transcripts keep the `#f=` deep link —
       see artifactAnchor.dom.test.tsx for the rendered behavior of both. */
    const link = findAnchor(md("see [markdown.tsx](~/app/src/components/feed/markdown.tsx:57)"));
    expect(link.props.href).toBe("~/app/src/components/feed/markdown.tsx:57");
    expect(link.props.label).toBe("markdown.tsx");
  });

  test("keeps external markdown links clickable", () => {
    const link = findAnchor(md("[docs](https://example.com/docs)"));
    expect(link.props.href).toBe("https://example.com/docs");
    expect(link.props.label).toBe("docs");
  });

  /* The reported defect: an agent's release note writes its links inside bold,
     and the bold alternative used to swallow the whole construct and print it
     as text — brackets, parens and all. */
  test("a link wrapped in bold is still a link", () => {
    const [link] = collectAnchors(md("- **[#2722](https://example.com/acme/widgets/pull/2722)** — merged"));
    expect(link).toBeDefined();
    expect(link.props.href).toBe("https://example.com/acme/widgets/pull/2722");
    expect(link.props.label).toBe("#2722");
  });

  test("a bare URL inside bold is still a link", () => {
    const [link] = collectAnchors(md("**see https://example.com/acme/widgets/issues/7**"));
    expect(link).toBeDefined();
    expect(link.props.href).toBe("https://example.com/acme/widgets/issues/7");
  });

  test("bold around a link keeps the label bold", () => {
    const rendered = md("**[#2722](https://example.com/acme/widgets/pull/2722)**");
    const bold = Children.toArray(rendered).find(
      (node): node is ReactElement<{ children?: unknown }> => isValidElement(node) && node.type === "b",
    );
    expect(bold).toBeDefined();
    expect(collectAnchors(bold!.props.children).length).toBe(1);
  });

  /* The Anchor unescapes `\(`/`\)` at render (see artifactAnchor.dom.test.tsx
     for the resolved href); what matters here is that the target is not cut at
     the first escaped paren. */
  test("an escaped paren stays inside the URL", () => {
    const link = findAnchor(md("see [the page](https://example.com/acme/widgets/wiki/Home_\\(draft\\)) now"));
    expect(link.props.href).toBe("https://example.com/acme/widgets/wiki/Home_\\(draft\\)");
    expect(link.props.label).toBe("the page");
  });

  test("an image wrapped in bold still embeds instead of linking", () => {
    const rendered = md("**![shot](https://example.com/a.png)**");
    expect(findImg(rendered)).not.toBeNull();
    expect(collectAnchors(rendered).length).toBe(0);
  });
});

describe("feed markdown images", () => {
  test("embeds image markdown instead of rendering a link", () => {
    const rendered = md("![Admins screen](~/Projects/app/shot.png)");
    const img = findImg(rendered);
    expect(img).not.toBeNull();
    expect(img!.props.alt).toBe("Admins screen");
    expect(img!.props.src).toBe("~/Projects/app/shot.png");
    expect(() => findAnchor(rendered)).toThrow();
  });

  test("embeds remote image markdown", () => {
    const img = findImg(md("![shot](https://example.com/a.png)"));
    expect(img).not.toBeNull();
    expect(img!.props.src).toBe("https://example.com/a.png");
  });
});
