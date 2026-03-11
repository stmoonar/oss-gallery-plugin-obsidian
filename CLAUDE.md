# CLAUDE.md

This repository contains an Obsidian plugin that uploads media and documents to multiple OSS providers and provides a gallery view for providers that support listing.

## Common commands

```bash
npm run dev
npm run build
npm run version
tsc -noEmit -skipLibCheck
```

## Architecture

- `src/main.ts`: plugin entrypoint, commands, event registration, settings load/save
- `src/settings/SettingsManager.ts`: settings UI, active provider selection, global object rules, preview settings
- `src/providers/`: provider implementations and registry metadata
- `src/views/OssGalleryView.ts`: gallery view
- `src/components/`: gallery UI pieces
- `src/services/`: upload, sync, object key, search, embed rendering
- `src/types/`: shared types for settings, providers, and gallery state
- `src/locale/` and `src/i18n.ts`: localization

## Current settings model

Global settings:

- `activeProvider`
- `basepath`
- `nameRule`
- `pathRule`
- `imgPreview`
- `videoPreview`
- `audioPreview`
- `docsPreview`

Provider settings live under `settings.providers`.

## Provider model

Provider metadata is centralized in `src/providers/registry.ts`.

Each provider entry defines:

- label
- capabilities: upload/list/delete
- default settings
- configuration validation
- factory function

Use the registry as the source of truth when adding or changing providers.

## Notes for changes

- Keep README, `manifest.json`, and settings behavior aligned.
- If you add user-facing strings, update `src/locale/en.ts`, `src/locale/zh-cn.ts`, and `src/locale/zh-tw.ts`.
- Gallery features must respect provider capabilities. Imgur is upload-only in this plugin.
- `basepath`, `nameRule`, and `pathRule` all affect final object keys.
