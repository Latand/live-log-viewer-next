import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowRight,
  ArrowUpToLine,
  Ban,
  Binary,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  ClipboardList,
  Command,
  Copy,
  Eye,
  FileDiff,
  FileText,
  FoldVertical,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Layers,
  Link2,
  type LucideIcon,
  Mail,
  MessageCircle,
  Mic,
  Paperclip,
  PencilLine,
  Play,
  Power,
  RotateCw,
  Search,
  Sparkle,
  Square,
  SquareTerminal,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";

export {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowRight,
  ArrowUpToLine,
  Ban,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Command,
  Copy,
  Eye,
  FoldVertical,
  GitBranch,
  ImageIcon,
  Layers,
  Link2,
  Mail,
  MessageCircle,
  Mic,
  PencilLine,
  Play,
  Power,
  RotateCw,
  Sparkle,
  Square,
  SquareTerminal,
  Terminal,
  Trash2,
  X,
};

/** Loader kept as its own export so callers add `animate-spin` at the call site. */
export { Loader2 } from "lucide-react";

/**
 * Semantic keys the feed model carries in place of an emoji glyph. Keeping the
 * data layer on keys (not React nodes) lets buildFeed stay serialisable and
 * moves every icon choice into this one map.
 */
export type GlyphName =
  | "shell"
  | "tool"
  | "cmd-group"
  | "codex"
  | "claude"
  | "image"
  | "blob"
  | "note"
  | "citation"
  | "message"
  | "shutdown"
  | "plan"
  | "compact"
  | "file"
  | "edit"
  | "search"
  | "web"
  | "spawn"
  | "clock";

const GLYPHS: Record<GlyphName, LucideIcon> = {
  shell: ChevronRight,
  tool: Wrench,
  "cmd-group": Terminal,
  codex: Command,
  claude: Sparkle,
  image: ImageIcon,
  blob: Binary,
  note: PencilLine,
  citation: Paperclip,
  message: Mail,
  shutdown: Power,
  plan: ClipboardList,
  compact: FoldVertical,
  file: FileText,
  edit: FileDiff,
  search: Search,
  web: Globe,
  spawn: GitBranch,
  clock: AlarmClock,
};

export function GlyphIcon({ name, className }: { name: GlyphName; className?: string }) {
  const Icon = GLYPHS[name];
  return <Icon className={className ?? "h-3.5 w-3.5"} aria-hidden />;
}
