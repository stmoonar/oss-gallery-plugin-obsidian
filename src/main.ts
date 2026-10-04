import {
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
import { ObjectKeyBuilder } from "./services/ObjectKeyBuilder";
import { EmbedRenderer } from "./services/EmbedRenderer";
import { UploadService, UploadProgress } from "./services/UploadService";
import { getFileTypeByMime } from "./utils/FileUtils";
import { filterSensitiveInfo, handleUploadError } from "./utils/ErrorHandler";
import { OssProviderManager } from "./providers/OssProviderManager";
import { providerRegistry } from "./providers/registry";
import { isLegacyStoredSettings, loadStoredSettings } from "./settings/loadStoredSettings";

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
	private uploadCounter = 0;

	// Services
	private keyBuilder: ObjectKeyBuilder;
	private embedRenderer: EmbedRenderer;
	private uploadService: UploadService | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.providerManager = new OssProviderManager(this.settings, this.app);

		this.addSettingTab(new SettingsManager(this.app, this, this.providerManager));
		this.addCommands();

		this.initializeServices();
		this.registerEvents();
		this.setupView();
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
					new Notice(t("Please configure OSS settings first"));
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
					new Notice(t("Please configure OSS settings first"));
					return;
				}
				void this.openGalleryView();
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
				return new OssGalleryView(leaf, provider);
			}
		);

		this.addRibbonIcon("image-file", t("OSS gallery"), () => {
			if (!this.supportsActiveProviderCapability("list")) {
				new Notice(t("Image listing is not available"));
				return;
			}
			if (!this.validateSettings()) {
				new Notice(t("Please configure OSS settings first"));
				return;
			}
			void this.openGalleryView();
		});
	}

	async openGalleryView(): Promise<void> {
		if (!this.supportsActiveProviderCapability("list")) {
			new Notice(t("Image listing is not available"));
			return;
		}
		if (!this.validateSettings()) {
			new Notice(t("Please configure OSS settings first"));
			return;
		}

		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const currentView = workspace.getActiveViewOfType(OssGalleryView);

		if (currentView) {
			leaf = currentView.leaf;
		}

		if (!leaf) {
			leaf = workspace.getLeftLeaf(false);
			if (!leaf) return;

			await leaf.setViewState({
				type: GALLERY_VIEW_TYPE,
				active: true,
			});
		}

		void workspace.revealLeaf(leaf);
	}

	private createUploadTarget(
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo
	): UploadTarget {
		return { editor, info, file: info.file ?? null };
	}

	private triggerFileUpload(target: UploadTarget): void {
		const input = document.createElement("input");
		input.setAttribute("type", "file");
		input.setAttribute(
			"accept",
			"image/*,video/*,audio/*,.doc,.docx,.pdf,.pptx,.xlsx,.xls"
		);

		input.onchange = async (event: Event) => {
			const file = (event.target as HTMLInputElement)?.files?.[0];
			if (file && getFileTypeByMime(file)) {
				await this.uploadFiles(target, [file]);
			}
		};

		input.click();
	}

	/**
	 * Insert placeholders for all files into the originating note up front (so a
	 * batch never spills into a note the user switched to), then upload them
	 * one by one and swap each placeholder for its final embed.
	 */
	private async uploadFiles(target: UploadTarget, files: File[]): Promise<void> {
		if (files.length === 0) return;

		const pending: PendingUpload[] = files.map((file) => ({
			file,
			id: `oss-upload-${Date.now()}-${++this.uploadCounter}`,
		}));

		await this.insertPlaceholders(target, pending);

		for (const upload of pending) {
			await this.performUpload(target, upload);
		}
	}

	private async performUpload(
		target: UploadTarget,
		{ file, id }: PendingUpload
	): Promise<void> {
		let lastPercent = 0;

		try {
			const uploadService = this.getUploadService();
			const objectName = this.keyBuilder.generateObjectName(file);
			const fileType = getFileTypeByMime(file);

			const url = await uploadService.uploadFile(
				file,
				objectName,
				(progress: UploadProgress) => {
					const percent = Math.min(
						100,
						Math.max(0, Math.round(progress.percentage))
					);
					// Only touch the note when the displayed value changes.
					if (!Number.isFinite(percent) || percent === lastPercent) return;
					lastPercent = percent;
					this.updatePlaceholderProgress(target, id, file.name, percent);
				}
			);

			const finalText = this.embedRenderer.render(fileType, url, file.name);
			await this.replacePlaceholder(target, id, finalText);
			this.refreshGalleryViews();
		} catch (error) {
			handleUploadError(error, file.name);
			await this.replacePlaceholder(target, id, "");
			const message = error instanceof Error ? error.message : String(error);
			new Notice(
				t("Upload failed with reason")
					.replace("{name}", () => file.name)
					.replace("{message}", () => filterSensitiveInfo(message)),
				8000
			);
		}
	}

	/**
	 * Short, markdown-safe placeholder. It renders as a plain link labelled with
	 * the progress and carries the upload id in the link target.
	 */
	private buildPlaceholder(id: string, name: string, percent: number): string {
		const label = name.replace(/[[\]\\\r\n]/g, "_");
		return `[${t("Uploading")} ${label}... ${percent}%](#${id})`;
	}

	/** Matches the placeholder with the given id, whatever its current label. */
	private placeholderPattern(id: string, withTrailingNewline = false): RegExp {
		// The id only contains [a-z0-9-], so it needs no escaping.
		return new RegExp(`\\[[^\\]\\n]*\\]\\(#${id}\\)${withTrailingNewline ? "\\n?" : ""}`);
	}

	private async insertPlaceholders(
		target: UploadTarget,
		pending: PendingUpload[]
	): Promise<void> {
		const text = pending
			.map(({ id, file }) => `${this.buildPlaceholder(id, file.name, 0)}\n`)
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
	 * Progress updates are cosmetic: they are applied only while the note is
	 * open in an editor, so a background note is not rewritten on disk for
	 * every percent.
	 */
	private updatePlaceholderProgress(
		target: UploadTarget,
		id: string,
		name: string,
		percent: number
	): void {
		try {
			const editor = this.resolveEditor(target);
			if (!editor) return;
			this.replaceInEditor(
				editor,
				this.placeholderPattern(id),
				this.buildPlaceholder(id, name, percent)
			);
		} catch {
			// Ignore: the next update or the final replacement will retry.
		}
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
		const pattern = this.placeholderPattern(id, true);
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

	async handleUploader(
		evt: ClipboardEvent | DragEvent,
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo
	): Promise<void> {
		if (evt.defaultPrevented) return;

		const files = this.extractFilesFromEvent(evt);
		const supported = files.filter((f) => getFileTypeByMime(f));
		if (supported.length === 0) return;
		if (!this.validateSettings()) return;

		evt.preventDefault();

		const skipped = files.length - supported.length;
		if (skipped > 0) {
			new Notice(t("Some files are not supported and were skipped"));
		}

		await this.uploadFiles(this.createUploadTarget(editor, info), supported);
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
		// Cleanup
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
		await this.saveData(this.settings);

		this.keyBuilder?.updateSettings(this.settings);
		this.embedRenderer?.updateSettings(this.settings);
		this.providerManager?.updateSettings(this.settings);

		const activeProvider = this.providerManager?.getActiveProvider();
		if (activeProvider) {
			// Create the upload service if no provider was available at load.
			if (this.uploadService) {
				this.uploadService.updateProvider(activeProvider);
			} else {
				this.uploadService = new UploadService(activeProvider);
			}

			// Update all gallery views
			this.app.workspace.getLeavesOfType(GALLERY_VIEW_TYPE).forEach(leaf => {
				if (leaf.view instanceof OssGalleryView) {
					leaf.view.updateProvider(activeProvider);
				}
			});
		}
	}
}
