import {
	debounce,
	Editor,
	MarkdownFileInfo,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { t } from "./i18n";
import { OssGalleryView, GALLERY_VIEW_TYPE } from "./views/OssGalleryView";
import { PluginSettings, DEFAULT_SETTINGS } from "./types/settings";
import { SettingsManager } from "./settings/SettingsManager";
import { normalizeBasePath, ObjectKeyBuilder } from "./services/ObjectKeyBuilder";
import { EmbedRenderer } from "./services/EmbedRenderer";
import { UploadService, UploadProgress } from "./services/UploadService";
import { SavedToVault, UploadQueue, UploadQueueHost, UploadResult } from "./services/UploadQueue";
import {
	FileTriage,
	formatNameList,
	SkippedSummary,
	summarizeSkipped,
	triageFiles,
} from "./services/uploadFileTriage";
import { UploadAnnouncer } from "./editor/uploadAnnouncer";
import { formatMissingSummary } from "./settings/settingsUx";
import { openPluginSettings } from "./utils/openPluginSettings";
import { getFileTypeByMime } from "./utils/FileUtils";
import { filterSensitiveInfo, handleUploadError } from "./utils/ErrorHandler";
import { OssProviderManager } from "./providers/OssProviderManager";
import { providerRegistry } from "./providers/registry";
import { isLegacyStoredSettings, loadStoredSettings } from "./settings/loadStoredSettings";
import { UploadProgressStore } from "./services/UploadProgressStore";
import { createUploadId, placeholderPattern } from "./services/uploadPlaceholder";
import { uploadProgressExtension } from "./editor/uploadProgressExtension";
import { createUploadProgressPostProcessor } from "./editor/uploadProgressPostProcessor";
import { SemanticController } from "./semantic/SemanticController";
import { runSemanticSelfTestCommand } from "./semantic/selfTestCommand";
import { SemanticIndexing } from "./semantic/SemanticIndexing";
import { GalleryThumbnails } from "./thumbnails/GalleryThumbnails";
import type { ThumbnailWriter } from "./thumbnails/ThumbnailCache";

/**
 * Where an upload was started from. The Editor (and MarkdownView) of a leaf is
 * reused when the user opens another note in it, so the originating note is
 * captured up front and every later edit is checked against it.
 */
interface UploadTarget {
	editor: Editor;
	info: MarkdownView | MarkdownFileInfo;
	/** Note the upload was started from; null for editors without a backing file. */
	file: TFile | null;
}

interface PendingUpload {
	file: File;
	/** Unique id embedded in the placeholder so it can always be located again. */
	id: string;
}

export default class OssGalleryPlugin extends Plugin {
	settings: PluginSettings;
	providerManager: OssProviderManager;
	/** Semantic image search install state (downloads outlive the settings tab). */
	semantic: SemanticController;
	/** Semantic index/search services (per-scope indexes, upload/delete hooks). */
	semanticIndexing: SemanticIndexing;
	/** Local gallery thumbnails (independent of semantic search). */
	galleryThumbnails: GalleryThumbnails;
	private uploadCounter = 0;
	/** Upload progress shown in editors/reading view; never written to notes. */
	private readonly uploadProgress = new UploadProgressStore();
	/** Runs uploads one at a time and keeps failed ones (with their file) until resolved. */
	private uploadQueue: UploadQueue<UploadTarget>;
	/** Polite live region announcing upload results to screen readers. */
	private uploadAnnouncer: UploadAnnouncer | null = null;

	// Services
	private keyBuilder: ObjectKeyBuilder;
	private embedRenderer: EmbedRenderer;
	private uploadService: UploadService | null = null;

	/**
	 * Settings fire on every keystroke: write data.json once typing pauses.
	 * Pending writes are flushed in onunload.
	 */
	private readonly requestSaveData = debounce(
		() => {
			this.saveData(this.settings).catch((error) => {
				console.error("Failed to save settings", error);
			});
		},
		500,
		true
	);

	/**
	 * Re-list galleries once a batch of uploads settles instead of after
	 * every single file.
	 */
	private readonly requestGalleryRefresh = debounce(
		() => this.refreshGalleryViews(),
		1500,
		true
	);

	/**
	 * After edits settle, forget failed uploads whose placeholder the user
	 * deleted, so their files do not stay in memory.
	 */
	private readonly requestFailedUploadSweep = debounce(
		() => this.releaseOrphanedFailedUploads(),
		1000,
		true
	);

	async onload(): Promise<void> {
		await this.loadSettings();

		this.providerManager = new OssProviderManager(this.settings, this.app);
		this.galleryThumbnails = new GalleryThumbnails(this);
		this.semantic = new SemanticController(this);
		this.semanticIndexing = new SemanticIndexing(this);
		this.semantic.indexing = this.semanticIndexing;
		this.semanticIndexing.attachStatusBar(this.addStatusBarItem());

		this.addSettingTab(new SettingsManager(this.app, this, this.providerManager, this.semantic, this.galleryThumbnails));
		this.addCommands();

		this.initializeServices();
		this.uploadQueue = new UploadQueue(this.uploadProgress, this.createUploadQueueHost());
		this.uploadAnnouncer = new UploadAnnouncer();
		this.registerEvents();
		this.registerUploadProgressRendering();
		this.setupView();

		// Trim the thumbnail cache to its cap once the vault has settled.
		this.app.workspace.onLayoutReady(() => {
			this.galleryThumbnails.start();
		});

		// Startup check for users who opted in: presence + size only, no
		// rehash and no automatic re-download (needs-repair shows in settings).
		if (this.settings.semantic.enabled) {
			this.app.workspace.onLayoutReady(() => {
				void this.semantic.refresh();
			});
		}
	}

	/**
	 * Render upload placeholders as a progress card (thumbnail + bar) in
	 * Source/Live Preview and Reading mode. Display-only: the note keeps the
	 * short placeholder text until the upload finishes.
	 */
	private registerUploadProgressRendering(): void {
		this.registerEditorExtension(uploadProgressExtension(this.uploadProgress));
		this.registerMarkdownPostProcessor(
			createUploadProgressPostProcessor(this.uploadProgress)
		);
	}

	private initializeServices(): void {
		this.keyBuilder = new ObjectKeyBuilder(this.settings);
		this.embedRenderer = new EmbedRenderer(this.settings);

		const activeProvider = this.providerManager.getActiveProvider();
		if (activeProvider) {
			this.uploadService = new UploadService(activeProvider);
		}
		// Otherwise the upload service is created lazily (see getUploadService)
		// once a provider becomes available.
	}

	/**
	 * Return the upload service bound to the current active provider, creating
	 * it on demand so uploads work right after first-time setup.
	 */
	private getUploadService(): UploadService {
		const activeProvider = this.providerManager.getActiveProvider();
		if (!activeProvider) {
			throw new Error(t("No active provider"));
		}
		if (this.uploadService) {
			this.uploadService.updateProvider(activeProvider);
		} else {
			this.uploadService = new UploadService(activeProvider);
		}
		return this.uploadService;
	}

	private addCommands(): void {
		this.addCommand({
			id: "oss-upload",
			name: t("File upload"),
			icon: "upload-cloud",
			editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				if (!this.validateSettings()) {
					this.showNotConfiguredNotice();
					return;
				}
				this.triggerFileUpload(this.createUploadTarget(editor, ctx));
			},
		});

		this.addCommand({
			id: "open-gallery",
			name: t("Open OSS gallery"),
			icon: "image-file",
			callback: () => {
				if (!this.supportsActiveProviderCapability("list")) {
					new Notice(t("Image listing is not available"));
					return;
				}
				if (!this.validateSettings()) {
					this.showNotConfiguredNotice();
					return;
				}
				void this.openGalleryView();
			},
		});

		// Real inference check for the semantic search install (P2). Shown
		// once the feature is enabled or the files are known to be installed.
		this.addCommand({
			id: "semantic-self-test",
			name: t("Semantic search: run self-test"),
			checkCallback: (checking: boolean) => {
				const kind = this.semantic.getState().kind;
				if (kind === "unsupported" || !(this.settings.semantic.enabled || kind === "installed")) {
					return false;
				}
				if (!checking) {
					void runSemanticSelfTestCommand(this.app, this.semantic);
				}
				return true;
			},
		});

		// Searching happens in the gallery (semantic toggle, "find similar");
		// these commands remain for keyboard users and troubleshooting.
		this.addCommand({
			id: "semantic-index-now",
			name: t("Semantic search: index current provider now"),
			checkCallback: (checking: boolean) => {
				// `enabled` syncs between devices: also require the model here.
				if (!this.semantic.isReady() || !this.supportsActiveProviderCapability("list")) {
					return false;
				}
				if (!checking) {
					this.semanticIndexing.indexNow().catch((error) => {
						console.error("OSS Gallery: semantic indexing failed", error);
					});
				}
				return true;
			},
		});
		this.addCommand({
			id: "semantic-stop-indexing",
			name: t("Semantic search: stop indexing"),
			checkCallback: (checking: boolean) => {
				if (!this.semanticIndexing.index.isRunning()) {
					return false;
				}
				if (!checking) {
					this.semanticIndexing.index.cancel();
				}
				return true;
			},
		});
	}

	private registerEvents(): void {
		this.registerEvent(
			this.app.workspace.on(
				"editor-paste",
				this.handleUploader.bind(this)
			)
		);
		this.registerEvent(
			this.app.workspace.on("editor-drop", this.handleUploader.bind(this))
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				if (this.uploadQueue.failedJobs().length > 0) {
					this.requestFailedUploadSweep();
				}
			})
		);
	}

	private setupView(): void {
		this.registerView(
			GALLERY_VIEW_TYPE,
			(leaf) => {
				// Fall back to any available provider so restoring a persisted
				// workspace leaf never leaves a broken view behind.
				const provider = this.providerManager.getActiveProvider()
					?? this.providerManager.getAllProviders()[0];
				if (!provider) throw new Error(t("No active provider"));
				return new OssGalleryView(
					leaf,
					provider,
					this.getGalleryListPrefix(),
					this.semanticIndexing.galleryHooks(),
					this.galleryThumbnails.galleryHooks(),
					{
						renderEmbed: (url, name) => this.embedRenderer.render("image", url, name),
						pluginId: this.manifest.id,
					}
				);
			}
		);

		this.addRibbonIcon("image-file", t("OSS gallery"), () => {
			if (!this.supportsActiveProviderCapability("list")) {
				new Notice(t("Image listing is not available"));
				return;
			}
			if (!this.validateSettings()) {
				this.showNotConfiguredNotice();
				return;
			}
			void this.openGalleryView();
		});
	}

	/** Open (or focus) the gallery; `semantic` switches its search box to semantic mode. */
	async openGalleryView(options: { semantic?: boolean } = {}): Promise<void> {
		if (!this.supportsActiveProviderCapability("list")) {
			new Notice(t("Image listing is not available"));
			return;
		}
		if (!this.validateSettings()) {
			this.showNotConfiguredNotice();
			return;
		}

		const { workspace } = this.app;
		// Reuse an existing gallery (even if it is not the active view)
		// instead of opening a duplicate.
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(GALLERY_VIEW_TYPE)[0] ?? null;

		if (!leaf) {
			leaf = workspace.getLeftLeaf(false);
			if (!leaf) return;

			await leaf.setViewState({
				type: GALLERY_VIEW_TYPE,
				active: true,
			});
		}

		await workspace.revealLeaf(leaf);
		if (options.semantic && leaf.view instanceof OssGalleryView) {
			leaf.view.enterSemanticMode();
		}
	}

	/** Where semantic indexing hands its thumbnails (SemanticIndexingHost). */
	thumbnailWriter(): ThumbnailWriter | null {
		return this.galleryThumbnails?.service ?? null;
	}

	/**
	 * Directory the gallery lists: the global base path, so it shows what
	 * this plugin uploads rather than the whole bucket.
	 */
	getGalleryListPrefix(): string {
		const basePath = normalizeBasePath(this.settings.basepath);
		return basePath ? `${basePath}/` : "";
	}

	private createUploadTarget(
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo
	): UploadTarget {
		return { editor, info, file: info.file ?? null };
	}

	private triggerFileUpload(target: UploadTarget): void {
		const input = createEl("input");
		input.setAttribute("type", "file");
		input.setAttribute("accept", this.getFilePickerAccept());
		input.multiple = true;

		input.onchange = async () => {
			const files = Array.from(input.files ?? []);
			if (files.length === 0) return;
			const triage = this.triageFiles(files);
			this.showSkippedNotice(summarizeSkipped(triage, "picker"));
			await this.uploadFiles(target, triage.accepted);
		};

		input.click();
	}

	/**
	 * Insert placeholders for all files into the originating note up front (so a
	 * batch never spills into a note the user switched to), then queue the
	 * uploads; each placeholder is swapped for its final embed when done.
	 */
	private async uploadFiles(target: UploadTarget, files: File[]): Promise<void> {
		if (files.length === 0) return;

		const pending: PendingUpload[] = files.map((file) => ({
			file,
			id: createUploadId(++this.uploadCounter),
		}));

		// Register progress entries before the placeholders land in the note so
		// the first render already shows the card ("Waiting").
		for (const { id, file } of pending) {
			this.uploadQueue.add(id, file, target);
		}

		await this.insertPlaceholders(target, pending);

		this.uploadQueue.enqueue(pending.map(({ id }) => id));
	}

	/** Upload with the active provider; side effects of a finished upload. */
	private async uploadToProvider(
		file: File,
		onProgress: (percent: number) => void
	): Promise<UploadResult> {
		const uploadService = this.getUploadService();
		// Where the semantic index files this upload: the provider and
		// scope at upload start (settings may change while it runs).
		const indexTarget = this.semanticIndexing.uploadTarget(
			this.providerManager.getActiveProvider()
		);
		const objectName = this.keyBuilder.generateObjectName(file);
		const fileType = getFileTypeByMime(file);

		const url = await uploadService.uploadFile(
			file,
			objectName,
			// Display-only: the note text is not touched, and the store
			// ignores unchanged values.
			(progress: UploadProgress) => onProgress(progress.percentage)
		);

		// The object exists now, even if the user cancelled meanwhile: index
		// it from the bytes in hand (no download) and refresh galleries.
		this.semanticIndexing.onUploaded(indexTarget, objectName, file).catch((error) => {
			console.error("OSS Gallery: semantic upload indexing failed", error);
		});
		this.requestGalleryRefresh();
		return { url, text: this.embedRenderer.render(fileType, url, file.name) };
	}

	/** Note, notice and vault access for the upload queue. */
	private createUploadQueueHost(): UploadQueueHost<UploadTarget> {
		const fill = (template: string, values: Record<string, string>) =>
			template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
		return {
			upload: (file, onProgress) => this.uploadToProvider(file, onProgress),
			replacePlaceholder: (target, id, text) => this.replacePlaceholder(target, id, text),
			replacePlaceholderNow: (target, id, text) => this.replacePlaceholderNow(target, id, text),
			saveToVault: (target, file) => this.saveUploadToVault(target, file),
			interruptedText: (name) =>
				fill(t("Upload interrupted marker"), { name: this.sanitizePlaceholderLabel(name) }),
			describeError: (error) =>
				filterSensitiveInfo(error instanceof Error ? error.message : String(error)),
			onUploaded: (name) => {
				this.uploadAnnouncer?.announce(fill(t("Upload aria done"), { name }));
			},
			onFailed: (name, message, error) => {
				handleUploadError(error, name);
				this.uploadAnnouncer?.announce(fill(t("Upload aria failed"), { name, message }));
				new Notice(fill(t("Upload failed kept"), { name, message }), 8000);
			},
			onPlaceholderLost: (name, url) => this.showPlaceholderLostNotice(name, url),
			onCancelled: (name) => {
				new Notice(fill(t("Upload cancelled"), { name }), 6000);
			},
			onSavedToVault: (name, path) => {
				new Notice(fill(t("Upload saved to vault"), { name, path }));
			},
			onSaveToVaultFailed: (name, message, error) => {
				handleUploadError(error, name);
				new Notice(fill(t("Upload save to vault failed"), { name, message }), 8000);
			},
		};
	}

	/**
	 * Save a file whose upload failed as an ordinary attachment of the note,
	 * where Obsidian would have put it, linked the way the user's "use
	 * [[Wikilinks]]" / link format settings say.
	 */
	private async saveUploadToVault(target: UploadTarget, file: File): Promise<SavedToVault> {
		const sourcePath = target.file?.path ?? "";
		const name = file.name.trim() || "attachment";
		const path = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
		const created = await this.app.vault.createBinary(path, await file.arrayBuffer());
		const link = this.app.fileManager.generateMarkdownLink(created, sourcePath);
		const fileType = getFileTypeByMime(file);
		const embed =
			fileType === "image" ||
			fileType === "video" ||
			fileType === "audio" ||
			created.extension.toLowerCase() === "pdf";
		const text = `${embed && !link.startsWith("!") ? "!" : ""}${link}\n`;
		return { text, path: created.path };
	}

	/**
	 * Upload finished, but the user removed its placeholder: offer the URL
	 * instead of losing it. Stays until dismissed.
	 */
	private showPlaceholderLostNotice(name: string, url: string): void {
		const fragment = createFragment((frag) => {
			frag.createDiv({ text: t("Upload placeholder lost").replace("{name}", () => name) });
			const button = frag.createEl("button", {
				cls: "oss-gallery-notice-button",
				text: t("Copy URL"),
			});
			button.addEventListener("click", () => {
				navigator.clipboard.writeText(url).then(
					() => new Notice(t("URL copied")),
					() => new Notice(url, 0)
				);
			});
		});
		new Notice(fragment, 0);
	}

	/**
	 * Short, markdown-safe placeholder carrying the upload id in the link
	 * target. Its text stays constant for the whole upload; progress is drawn
	 * over it by the editor extension / reading mode post processor.
	 */
	private buildPlaceholder(id: string, name: string): string {
		return `[${t("Uploading")} ${this.sanitizePlaceholderLabel(name)}\u2026](#${id})`;
	}

	private sanitizePlaceholderLabel(name: string): string {
		return name.replace(/[[\]\\\r\n]/g, "_");
	}

	private async insertPlaceholders(
		target: UploadTarget,
		pending: PendingUpload[]
	): Promise<void> {
		const text = pending
			.map(({ id, file }) => `${this.buildPlaceholder(id, file.name)}\n`)
			.join("");

		const editor = this.resolveEditor(target);
		if (editor) {
			const cursor = editor.getCursor();
			const offset = editor.posToOffset(cursor);
			editor.replaceRange(text, cursor);
			editor.setCursor(editor.offsetToPos(offset + text.length));
			return;
		}

		// The note is no longer shown in an editor: append to the file instead.
		if (target.file) {
			try {
				await this.app.vault.process(target.file, (data) =>
					data + (data === "" || data.endsWith("\n") ? "" : "\n") + text
				);
			} catch (error) {
				handleUploadError(error);
			}
		}
	}

	/**
	 * Return an editor that currently shows the upload's note in source mode,
	 * or null when the note is not open for editing anymore.
	 */
	private resolveEditor(target: UploadTarget): Editor | null {
		const { editor, info, file } = target;
		if (!file) {
			// Editors without a backing file cannot be switched to another note.
			return editor;
		}

		const openViews = this.app.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.filter(
				(view): view is MarkdownView =>
					view instanceof MarkdownView && view.getMode() === "source"
			);

		const originalStillShowsFile = info instanceof MarkdownView
			? openViews.includes(info) && info.file === file
			: info.file === file;
		if (originalStillShowsFile) {
			return editor;
		}

		return openViews.find((view) => view.file === file)?.editor ?? null;
	}

	/**
	 * Replace the first match of `pattern` in the editor. Keeps the cursor
	 * after the replacement when it sat right at the end of the replaced text.
	 */
	private replaceInEditor(editor: Editor, pattern: RegExp, text: string): boolean {
		const match = pattern.exec(editor.getValue());
		if (!match) return false;

		const start = match.index;
		const end = start + match[0].length;
		const cursorAtEnd =
			!editor.somethingSelected() &&
			editor.posToOffset(editor.getCursor()) === end;

		editor.replaceRange(text, editor.offsetToPos(start), editor.offsetToPos(end));
		if (cursorAtEnd) {
			editor.setCursor(editor.offsetToPos(start + text.length));
		}
		return true;
	}

	/**
	 * Replace the placeholder (and the line break inserted with it) with the
	 * final text, in the editor if the note is still open there, otherwise
	 * directly in the note file. Returns false when the placeholder is gone.
	 */
	private async replacePlaceholder(
		target: UploadTarget,
		id: string,
		text: string
	): Promise<boolean> {
		const pattern = placeholderPattern(id, true);
		try {
			const editor = this.resolveEditor(target);
			if (editor) {
				return this.replaceInEditor(editor, pattern, text);
			}
			if (!target.file) return false;

			let replaced = false;
			await this.app.vault.process(target.file, (data) => {
				const match = pattern.exec(data);
				if (!match) return data;
				replaced = true;
				return (
					data.slice(0, match.index) +
					text +
					data.slice(match.index + match[0].length)
				);
			});
			return replaced;
		} catch (error) {
			handleUploadError(error);
			return false;
		}
	}

	/**
	 * Plugin unload: replace the placeholder right away in an open editor;
	 * a note that is not open is rewritten in the background (best effort).
	 * The placeholder line itself is kept.
	 */
	private replacePlaceholderNow(target: UploadTarget, id: string, text: string): void {
		const pattern = placeholderPattern(id);
		const editor = this.resolveEditor(target);
		if (editor) {
			this.replaceInEditor(editor, pattern, text);
			return;
		}
		if (!target.file) return;
		this.app.vault
			.process(target.file, (data) => data.replace(pattern, () => text))
			.catch((error) => handleUploadError(error));
	}

	/**
	 * Forget failed uploads whose placeholder is gone from the editor that
	 * shows their note. Notes that are not open are left alone: their
	 * placeholder is still in the file as far as we know.
	 */
	private releaseOrphanedFailedUploads(): void {
		for (const { id, target } of this.uploadQueue.failedJobs()) {
			const editor = this.resolveEditor(target);
			if (editor && !placeholderPattern(id).test(editor.getValue())) {
				this.uploadQueue.releaseFailed(id);
			}
		}
	}

	async handleUploader(
		evt: ClipboardEvent | DragEvent,
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo
	): Promise<void> {
		if (evt.defaultPrevented) return;
		if (this.isRichTextPaste(evt)) return;

		const files = this.extractFilesFromEvent(evt);
		if (files.length === 0) return;
		const triage = this.triageFiles(files);
		// Nothing this plugin uploads: an ordinary Obsidian paste / drop.
		if (triage.accepted.length === 0 && triage.rejectedByProvider.length === 0) return;

		if (!this.validateSettings()) {
			// Obsidian still handles the event; say why nothing was uploaded,
			// but only when the active provider would have taken a file.
			if (triage.accepted.length > 0) {
				this.showNotConfiguredNotice(t("Not configured paste fallback"));
			}
			return;
		}

		this.showSkippedNotice(summarizeSkipped(triage, "drop"));
		// Nothing the active provider can take: leave the event to Obsidian.
		if (triage.accepted.length === 0) return;

		evt.preventDefault();
		await this.uploadFiles(this.createUploadTarget(editor, info), triage.accepted);
	}

	/**
	 * Office / Excel / browsers put a rendered image next to the copied text
	 * on the clipboard. When there is text, it is a text paste: let Obsidian
	 * handle it instead of uploading the rendering.
	 */
	private isRichTextPaste(evt: ClipboardEvent | DragEvent): boolean {
		if (evt.type !== "paste") return false;
		const text = (evt as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
		return text.trim() !== "";
	}

	/**
	 * Split files into those the active provider takes, those it does not
	 * (e.g. non-images for Imgur) and those this plugin never uploads.
	 */
	private triageFiles(files: File[]): FileTriage<File> {
		const providerId = this.settings.activeProvider;
		return triageFiles(
			files,
			(file) => getFileTypeByMime(file) !== "",
			(file) => providerRegistry.acceptsFileType(providerId, getFileTypeByMime(file), this.app)
		);
	}

	/** One notice for every file left out of a paste, drop or pick. */
	private showSkippedNotice(summary: SkippedSummary | null): void {
		if (!summary) return;
		const provider = providerRegistry.getLabel(this.settings.activeProvider, this.app);
		const list = (names: string[]) =>
			formatNameList(names, t("List separator"), (shown, count) =>
				t("Upload more names")
					.replace("{names}", () => shown)
					.replace("{count}", () => String(count))
			);
		const heading =
			summary.heading === "partial"
				? t("Upload skipped heading")
				: summary.heading === "native"
					? t("Upload native heading")
					: t("Upload none heading");

		const fragment = createFragment((frag) => {
			frag.createDiv({ text: heading });
			if (summary.rejectedNames.length > 0) {
				frag.createDiv({
					text: t("Upload rejected by provider")
						.replace("{provider}", () => provider)
						.replace("{names}", () => list(summary.rejectedNames)),
				});
			}
			if (summary.unsupportedNames.length > 0) {
				frag.createDiv({
					text: t("Upload unsupported type").replace("{names}", () =>
						list(summary.unsupportedNames)
					),
				});
			}
		});
		new Notice(fragment, 8000);
	}

	/**
	 * The active provider is missing required settings: name them and offer
	 * a way to the settings tab. `detail` adds what happened instead.
	 */
	private showNotConfiguredNotice(detail?: string): void {
		const providerId = this.settings.activeProvider;
		const provider = providerRegistry.getLabel(providerId, this.app);
		const missing = providerRegistry.getMissingFields(providerId, this.settings.providers[providerId]);

		const fragment = createFragment((frag) => {
			frag.createDiv({ text: t("Provider not configured").replace("{provider}", () => provider) });
			if (missing.length > 0) {
				frag.createDiv({
					text: formatMissingSummary(
						missing.map((spec) => t(spec.label)),
						t("Missing required fields"),
						t("List separator")
					),
				});
			}
			if (detail) frag.createDiv({ text: detail });
			const button = frag.createEl("button", {
				cls: "oss-gallery-notice-button mod-cta",
				text: t("Open settings"),
			});
			button.addEventListener("click", () => openPluginSettings(this.app, this.manifest.id));
		});
		new Notice(fragment, 10000);
	}

	/**
	 * File picker filter matching the active provider's accepted types.
	 */
	private getFilePickerAccept(): string {
		const acceptByType: Record<string, string> = {
			image: "image/*",
			video: "video/*",
			audio: "audio/*",
			doc: ".doc,.docx,.pdf,.pptx,.xlsx,.xls",
		};
		return Object.entries(acceptByType)
			.filter(([type]) =>
				providerRegistry.acceptsFileType(this.settings.activeProvider, type, this.app)
			)
			.map(([, accept]) => accept)
			.join(",");
	}

	private extractFilesFromEvent(evt: ClipboardEvent | DragEvent): File[] {
		let fileList: FileList | null | undefined;
		switch (evt.type) {
			case "paste":
				fileList = (evt as ClipboardEvent).clipboardData?.files;
				break;
			case "drop":
				fileList = (evt as DragEvent).dataTransfer?.files;
				break;
		}
		return fileList ? Array.from(fileList) : [];
	}

	validateSettings(): boolean {
		return providerRegistry.isConfigured(
			this.settings.activeProvider,
			this.settings.providers[this.settings.activeProvider],
			this.app
		);
	}

	private supportsActiveProviderCapability(
		capability: "upload" | "list" | "delete"
	): boolean {
		return providerRegistry.supports(
			this.settings.activeProvider,
			capability,
			this.app
		);
	}

	/**
	 * Refresh all gallery views after upload
	 */
	private refreshGalleryViews(): void {
		// Get all gallery views and force refresh them
		this.app.workspace.getLeavesOfType(GALLERY_VIEW_TYPE).forEach(leaf => {
			if (leaf.view instanceof OssGalleryView) {
				// Force refresh by calling loadGallery with true
				void leaf.view.loadGallery(true);
			}
		});
	}

	onunload(): void {
		// Write settings still waiting for the debounce, and drop the
		// pending gallery refresh.
		this.requestSaveData.run();
		this.requestGalleryRefresh.cancel();
		this.requestFailedUploadSweep.cancel();
		// Stop waiting for uploads; placeholders that can no longer finish
		// become a readable "did not finish" note (the card needs this
		// session's state, so it could never render them again).
		this.uploadQueue?.dispose();
		this.uploadAnnouncer?.destroy();
		this.uploadAnnouncer = null;
		// Stop indexing and write every open index (synchronously).
		this.semanticIndexing?.dispose();
		// Write pending thumbnail manifests (synchronously).
		this.galleryThumbnails?.dispose();
		// Stop a running model download; finished files are kept.
		this.semantic?.dispose();
		// Drop progress entries and revoke thumbnail object URLs.
		this.uploadProgress.clear();
	}

	async loadSettings(): Promise<void> {
		const existingData: unknown = await this.loadData();

		this.settings = loadStoredSettings(existingData ?? null);

		if (!providerRegistry.get(this.settings.activeProvider, this.app)) {
			this.settings.activeProvider = DEFAULT_SETTINGS.activeProvider;
		}

		// Persist defaults on first run, and migrated settings once after
		// converting the legacy MinIO-only format.
		if (!existingData || isLegacyStoredSettings(existingData)) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		// Apply in memory right away; the disk write is debounced.
		this.requestSaveData();

		this.keyBuilder?.updateSettings(this.settings);
		this.embedRenderer?.updateSettings(this.settings);
		this.providerManager?.updateSettings(this.settings);
		this.semanticIndexing?.onSettingsChanged();
		this.galleryThumbnails?.onSettingsChanged();

		const activeProvider = this.providerManager?.getActiveProvider();
		if (activeProvider) {
			// Create the upload service if no provider was available at load.
			if (this.uploadService) {
				this.uploadService.updateProvider(activeProvider);
			} else {
				this.uploadService = new UploadService(activeProvider);
			}

			// Update all gallery views; they reload only when the provider
			// instance (rebuilt only on changed settings) or base path changed.
			const listPrefix = this.getGalleryListPrefix();
			this.app.workspace.getLeavesOfType(GALLERY_VIEW_TYPE).forEach(leaf => {
				if (leaf.view instanceof OssGalleryView) {
					leaf.view.updateProvider(activeProvider, listPrefix);
				}
			});
		}
	}
}
