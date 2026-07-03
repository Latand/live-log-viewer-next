"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { FileEntry } from "@/lib/types";

import { FileRow } from "./FileRow";
import {
  buildFlatFiles,
  buildTreeGroups,
  type SidebarFilter,
  type TechnicalGroup,
  type TreeNode,
} from "./sidebarModel";

type OpenMap = Record<string, boolean>;

interface Props {
  files: FileEntry[];
  selected: FileEntry | null;
  onSelect: (file: FileEntry) => void;
}

function readMap(key: string): OpenMap {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as OpenMap;
  } catch {
    return {};
  }
}

function writeMap(key: string, value: OpenMap) {
  localStorage.setItem(key, JSON.stringify(value));
}

function containsPath(node: TreeNode, pathname: string | null): boolean {
  return Boolean(pathname && (node.file.path === pathname || node.kids.some((kid) => containsPath(kid, pathname))));
}

function hiddenStats(node: TreeNode): { count: number; live: boolean } {
  let count = 0;
  let live = false;
  const walk = (cur: TreeNode) => {
    for (const kid of cur.kids) {
      count += 1;
      if (kid.live) live = true;
      walk(kid);
    }
  };
  walk(node);
  return { count, live };
}

export function Sidebar({ files, selected, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SidebarFilter>(() => {
    if (typeof window === "undefined") return "all";
    const raw = localStorage.getItem("llvFilter");
    return raw === "conversations" || raw === "active" ? raw : "all";
  });
  const [tree, setTree] = useState(() => (typeof window === "undefined" ? true : localStorage.getItem("llvTree") !== "0"));
  const [projOpen, setProjOpen] = useState<OpenMap>(() => readMap("llvProjOpen"));
  const [nodeOpen, setNodeOpenState] = useState<OpenMap>(() => readMap("llvNodeOpen"));

  const q = query.toLowerCase();
  const treeData = useMemo(() => buildTreeGroups(files, filter, q), [files, filter, q]);
  const flat = useMemo(() => buildFlatFiles(files, filter, q), [files, filter, q]);

  const selectedPath = selected?.path ?? null;
  const activeSearch = q.length > 0;

  const projectDefaultOpen = (nodes: TreeNode[], technical: TechnicalGroup | null) =>
    activeSearch ||
    nodes.some((node) => node.live || containsPath(node, selectedPath)) ||
    Boolean(technical?.nodes.some((node) => node.live || containsPath(node, selectedPath)));
  const projectIsOpen = (project: string, nodes: TreeNode[], technical: TechnicalGroup | null) =>
    Object.hasOwn(projOpen, project) ? projOpen[project] : projectDefaultOpen(nodes, technical);
  const nodeDefaultOpen = (node: TreeNode) => activeSearch || node.live || containsPath(node, selectedPath);
  const nodeIsOpen = (node: TreeNode) =>
    Object.hasOwn(nodeOpen, node.file.path) ? nodeOpen[node.file.path] : nodeDefaultOpen(node);
  const techIsOpen = (tech: TechnicalGroup) =>
    Object.hasOwn(nodeOpen, tech.key) ? nodeOpen[tech.key] : activeSearch || tech.live || tech.nodes.some((node) => containsPath(node, selectedPath));

  const setProjectOpen = (project: string, open: boolean) => {
    setProjOpen((prev) => {
      const next = { ...prev, [project]: open };
      writeMap("llvProjOpen", next);
      return next;
    });
  };
  const persistNodeOpen = (pathname: string, open: boolean) => {
    setNodeOpenState((prev) => {
      const next = { ...prev, [pathname]: open };
      writeMap("llvNodeOpen", next);
      return next;
    });
  };

  const setFilterChoice = (next: SidebarFilter) => {
    setFilter(next);
    localStorage.setItem("llvFilter", next);
  };

  const renderNode = (node: TreeNode, depth: number): ReactNode[] => {
    const hasChildren = node.kids.length > 0;
    const open = hasChildren ? nodeIsOpen(node) : false;
    const hidden = hasChildren && !open ? hiddenStats(node) : { count: 0, live: false };
    const rows: ReactNode[] = [
      <FileRow
        key={node.file.path}
        file={node.file}
        active={selected?.path === node.file.path}
        depth={Math.min(depth, 4)}
        hasChildren={hasChildren}
        expanded={open}
        hiddenCount={hidden.count}
        hiddenLive={hidden.live}
        onToggle={() => persistNodeOpen(node.file.path, !open)}
        onSelect={onSelect}
      />,
    ];
    if (open) for (const kid of node.kids) rows.push(...renderNode(kid, depth + 1));
    return rows;
  };

  return (
    <aside className="flex w-[340px] min-w-[270px] flex-col border-r border-line bg-panel">
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3 text-[15px] font-bold">
        Логи
        <span className="flex-1" />
        <button
          className={`rounded-[10px] border border-line px-2.5 py-1 text-xs ${tree ? "bg-[#ecebfb] font-semibold text-accent" : "bg-panel"}`}
          onClick={() => {
            const next = !tree;
            setTree(next);
            localStorage.setItem("llvTree", next ? "1" : "0");
          }}
        >
          {tree ? "Дерево" : "Стрічка"}
        </button>
      </header>
      <div className="mx-3 mt-3 flex overflow-hidden rounded-[10px] border border-line bg-bg p-0.5 text-[12px]">
        {[
          ["all", "Все"],
          ["conversations", "Розмови"],
          ["active", "Активні"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`flex-1 rounded-lg px-2 py-1 ${filter === key ? "bg-panel font-semibold text-accent shadow-card" : "text-dim"}`}
            onClick={() => setFilterChoice(key as SidebarFilter)}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        className="m-3 rounded-[10px] border border-line bg-bg px-3 py-2 text-[13px] outline-none"
        placeholder="Пошук…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {!tree
          ? flat.map((file) => (
              <FileRow key={file.path} file={file} active={selected?.path === file.path} flat onSelect={onSelect} />
            ))
          : treeData.map((group) => {
              const open = projectIsOpen(group.project, group.nodes, group.technical);
              return (
                <section key={group.project}>
                  <button
                    className="flex w-full select-none items-center gap-1.5 rounded-lg px-2.5 pb-1 pt-3.5 text-left text-[11px] font-bold uppercase tracking-[.5px] text-dim hover:text-ink"
                    onClick={() => setProjectOpen(group.project, !open)}
                  >
                    <span className="w-2.5 text-[9px]">{open ? "▼" : "▶"}</span>
                    <span className="truncate">{group.project}</span>
                    <span className="ml-auto text-[10.5px] font-semibold normal-case tracking-normal">
                      {group.live ? <span className="font-bold text-ok">{group.live} live</span> : null}
                      {group.live ? " · " : ""}
                      {open ? group.total : `+${group.total}`}
                    </span>
                  </button>
                  {open ? group.nodes.flatMap((node) => renderNode(node, 0)) : null}
                  {open && group.technical ? (
                    <section>
                      <button
                        className="mb-0.5 mt-1 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px] font-semibold text-dim hover:bg-bg hover:text-ink"
                        onClick={() => persistNodeOpen(group.technical!.key, !techIsOpen(group.technical!))}
                      >
                        <span className="w-2.5 text-[9px]">{techIsOpen(group.technical) ? "▼" : "▶"}</span>
                        <span>⚙ Технічне ({group.technical.count})</span>
                        <span className="ml-auto text-[10.5px]">{group.technical.live ? "● live" : ""}</span>
                      </button>
                      {techIsOpen(group.technical) ? group.technical.nodes.flatMap((node) => renderNode(node, 0)) : null}
                    </section>
                  ) : null}
                </section>
              );
            })}
      </div>
    </aside>
  );
}
