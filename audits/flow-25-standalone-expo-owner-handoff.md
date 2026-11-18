# Flow #25: standalone Expo application ownership handoff

Audit date: 2026-11-18

Status: **blocked on `ankhorage/projects#9`**. This report records the current published-owner
boundary; it does not claim that a runnable application exists.

## Decision

`@ankhorage/projects` is the owner of the missing concrete, runnable-app materialization
composition. It already owns project identity, immutable revisions, and the `projects.materialize`
application operation. It currently accepts an injected `ProjectMaterializer` port rather than
shipping an implementation. Its issue [projects#9](https://github.com/ankhorage/projects/issues/9)
is open, assigned to `artiphishle`, parented by this issue, and is the focused owner contract. No
additional owner issue is warranted.

This is deliberately not a Templates, Flow, Ankh, or Studio generator:

- Templates owns the selected template's manifest seed and packaged assets.
- Expo Runtime owns the Expo SDK/runtime, native config, dependency and layout-integration plans.
- Navigator owns deterministic Expo Router route output.
- Projects owns the lifecycle and concrete composition into a caller-owned, empty target directory.
- Ankh is a CLI provider front door, not an application scaffold owner.
- Studio's old private composition is a W3 migration source only. It must not be imported, copied,
  or used as a public dependency.

Studio [#961](https://github.com/ankhorage/studio/issues/961) and [#964](https://github.com/ankhorage/studio/issues/964)
place this work in W3 only after W2 owner releases. Their W5 manual-test hard stop remains in
force. Studio Phase B [#933](https://github.com/ankhorage/studio/issues/933) is not authorized by
this handoff.

## Evidence at the audited heads

| Repository   | audited `main`                             | released package                | source evidence                                                                                                                                                                                                                                                                                                                            | boundary established                                                                                                                                                                             |
| ------------ | ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Templates    | `05fb75df4ce50a661d2d3a029c2b7a6766984a01` | `@ankhorage/templates@12.6.33`  | [`projectSeed.ts:63-124`](https://github.com/ankhorage/templates/blob/05fb75df4ce50a661d2d3a029c2b7a6766984a01/src/projectSeed.ts#L63-L124)                                                                                                                                                                                                | `materializeTemplateRevision` writes `ankh.config.json`, `ankh.template.json`, README and assets only.                                                                                           |
| Projects     | `699835ba31753bdb6e7543e2950771c0ceafbaea` | `@ankhorage/projects@0.3.0`     | [`ProjectRepository.ts:3-7`](https://github.com/ankhorage/projects/blob/699835ba31753bdb6e7543e2950771c0ceafbaea/src/features/projects/ports/ProjectRepository.ts#L3-L7), [`projects.ts:60-71`](https://github.com/ankhorage/projects/blob/699835ba31753bdb6e7543e2950771c0ceafbaea/src/features/projects/application/projects.ts#L60-L71) | `projects.materialize` selects a stored revision but delegates output to injected `ProjectMaterializer`.                                                                                         |
| Expo Runtime | `43bb6eb18a753d9eb8916b9404718487390f1eda` | `@ankhorage/expo-runtime@7.1.0` | [`generatedAppOutput.ts:17-55`](https://github.com/ankhorage/expo-runtime/blob/43bb6eb18a753d9eb8916b9404718487390f1eda/src/generatedAppOutput.ts#L17-L55), [`platform.ts:17-40`](https://github.com/ankhorage/expo-runtime/blob/43bb6eb18a753d9eb8916b9404718487390f1eda/src/platform.ts#L17-L40)                                         | `resolveExpoRuntimeGeneratedAppOutput` yields plans; it does not write a complete project. Its SDK authority is Expo 57 (`expo@57.0.33`, `expo-router@~57.0.31`).                                |
| Navigator    | `cf89bbb88d70ed3d667b4e1da6037c16be7056c9` | `@ankhorage/navigator@3.5.22`   | [`generateNavigator.ts:22-75`](https://github.com/ankhorage/navigator/blob/cf89bbb88d70ed3d667b4e1da6037c16be7056c9/src/utils/generateNavigator.ts#L22-L75)                                                                                                                                                                                | `generateNavigator` returns deterministic files and dependency requirements; it has no project filesystem composition.                                                                           |
| Ankh         | `a63f911dc21fb677ddd89ae90056e3813bc93247` | `@ankhorage/ankh@0.13.7`        | [`package.json`](https://github.com/ankhorage/ankh/blob/a63f911dc21fb677ddd89ae90056e3813bc93247/package.json)                                                                                                                                                                                                                             | Published `ankh` is the provider-command front door, not a materializer.                                                                                                                         |
| Studio       | `9d83a481b671bd27c547e0019ab1838c2012ba77` | `@ankhorage/studio@8.1.67`      | [`projectManager.ts:39-65`](https://github.com/ankhorage/studio/blob/9d83a481b671bd27c547e0019ab1838c2012ba77/src/host/orchestrator/projectManager.ts#L39-L65), [`projectManager.ts:123-180`](https://github.com/ankhorage/studio/blob/9d83a481b671bd27c547e0019ab1838c2012ba77/src/host/orchestrator/projectManager.ts#L123-L180)         | The only complete composition found is private Studio host code (`ProjectManager`, `ProjectScaffolder`, `GeneratedAppFileGenerator`); the source itself marks its move to Projects as follow-up. |

## Required Projects public contract

`projects#9` must add the smallest published concrete materializer/factory that implements
`ProjectMaterializer` for a persisted immutable revision and a caller-provided empty directory. Its
result must report the target and generated files. It must fail before a success claim when any
required owner plan or emitted file is unavailable.

The implementation coordinates released public APIs only:

1. Call Templates `materializeTemplateRevision` for the selected manifest revision and assets.
2. Resolve Expo Runtime's runtime plan and project its dependency map, config plugins, permissions,
   native configuration and runtime layout integration.
3. Call Navigator `generateNavigator`, reject unsupported/diagnostic-error results, and write only
   its returned files.
4. Materialize the minimal `package.json`, Expo config, entry/runtime shell and generated routes
   from those owner outputs. It must never copy Studio's generator.
5. Preserve path safety, no-overwrite behavior, deterministic output, project/revision identity,
   and a standalone package boundary: no Studio, `@ankh/*`, `workspace:`, `file:`, or sibling-source
   dependency.

The release baseline is the published owner set above, with Expo Runtime as the canonical Expo 57
version authority. The resulting generated project's lockfile must pin the resolved concrete
versions, rather than this report inventing a competing version policy.

## Start contract after `projects#9` is released

The generated project must declare these scripts and a committed lockfile:

```sh
bun install --frozen-lockfile
bun run start --web
bun run start --ios
bun run start --android
```

The project must start without Studio, Ankh CLI workspace state, a local server, or a sibling
checkout. The commands are required output contract, not currently executable evidence: no published
Projects materializer can create that output today.

## Acceptance gate contract

Projects must prove a fresh npm-installed consumer against packed/released packages:

1. Persist a template-backed manifest revision and materialize it into an empty target; verify the
   output contains package metadata, Expo config, lockfile, Runtime shell, Expo Router files and
   packaged template assets.
2. Run `bun install --frozen-lockfile` in that generated target; run platform-neutral static,
   type, and Expo start/build validation there.
3. Web: launch the generated app in a real browser and prove the start screen/routes render.
4. iOS and Android: build/export and run on the respective available device or emulator; record the
   exact device/runtime evidence. If a native environment is unavailable, mark that lane
   **unexecuted**, never passed.
5. Include focused project/revision, target-empty/path safety, owner-plan propagation,
   deterministic-output, no-overwrite and fail-closed missing-owner tests; then the Projects
   repository gates, nonempty Changeset, packed-consumer proof and exact-HEAD CI.

## Templates handoff

Templates [#813](https://github.com/ankhorage/templates/issues/813) and
[#814](https://github.com/ankhorage/templates/issues/814) remain blocked only at the runnable-app
materialization boundary. Their manifest and assets can continue independently, but neither issue
may claim standalone Web/iOS/Android acceptance until a released `projects#9` API produces the
target app and the above gates pass. Their current Draft PRs are
[#879](https://github.com/ankhorage/templates/pull/879) and
[#843](https://github.com/ankhorage/templates/pull/843), respectively.

No Flow feature code, Template-local generator, Studio Phase B work, or second generator is part of
this audit.
