# Issue #1012: Keep each project cwd within its own project

The files response currently allows session-derived cwd evidence from one project to populate another project's `projectCwds` entry. The create-orchestrator sheet consumes this projection, so poisoned evidence can launch an orchestrator in an unrelated repository. The scanner/files projection must validate cwd ownership through the existing project resolver and recover repository-less directory projects to their own directory.

## Acceptance criteria

AC1: A canonical `dir-` project's `projectCwds` value is the directory from which that project identity is derived.

AC2: A canonical `repo-` project's cwd candidate is accepted only when `projectInfoFromCwd(candidate)` resolves to that same project.

AC3: Session evidence whose cwd resolves to another project is excluded from the candidate set and cannot collapse distinct projects onto one repository checkout.

AC4: Cwd ownership uses the scanner's existing `projectInfoFromCwd` and worktree-grouping resolution. No additional project naming or grouping scheme is introduced.

AC5: A focused poisoned-evidence regression covers distinct directory and repository projects and proves that their `projectCwds` values remain distinct.

AC6: Product source changes stay within the scanner/files projection that derives `projectCwds`; no flow, agent, runtime, or UI source changes are made.

AC7: The focused files-route and project-directory tests pass, `bunx tsc --noEmit` passes, and the publication privacy gate passes without running broad runtime or registry suites.

AC8: The fix is delivered in a non-draft pull request titled `fix(files): projectCwds must not leak one project's cwd into another (#1012)` with an identity-free diagnosis.

## Validation gates

- `bun test src/app/api/files/route.test.ts`
- `bun test src/lib/scanner/projectDirectories.test.ts`
- `bunx tsc --noEmit`
- `bun scripts/privacy-publication-gate.ts --base origin/main`
