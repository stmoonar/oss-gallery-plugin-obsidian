import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
					]
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ["src/**/*.ts"],
		extends: [
			...tseslint.configs.recommendedTypeChecked,
		],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		rules: {
			// Downgrade unsafe-* rules to warnings — the codebase uses `any`
			// extensively in provider settings and Obsidian's loadData() return.
			"@typescript-eslint/no-unsafe-assignment": "warn",
			"@typescript-eslint/no-unsafe-member-access": "warn",
			"@typescript-eslint/no-unsafe-argument": "warn",
			"@typescript-eslint/no-unsafe-return": "warn",
			"@typescript-eslint/no-unsafe-call": "warn",
			"@typescript-eslint/no-explicit-any": "warn",

			// Allow unused vars with "args: none" pattern
			"@typescript-eslint/no-unused-vars": ["error", { "args": "none" }],

			// Node built-in modules are available in Obsidian (Electron)
			"import/no-nodejs-modules": "off",

			// console is used for debug/error logging in providers
			"no-console": "off",

			// Obsidian APIs use innerHTML and inline styles extensively
			"@microsoft/sdl/no-inner-html": "warn",
			"obsidianmd/no-static-styles-assignment": "warn",

			// i18n strings don't follow Obsidian sentence-case convention
			"obsidianmd/ui/sentence-case": "warn",

			// Template expressions with error.message patterns
			"@typescript-eslint/restrict-template-expressions": "warn",

			// Obsidian event handlers are often async callbacks
			"@typescript-eslint/no-misused-promises": ["error", {
				"checksVoidReturn": false,
			}],

			// Fire-and-forget promises are common in event handlers
			"@typescript-eslint/no-floating-promises": "warn",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.mts",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
