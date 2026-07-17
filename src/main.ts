import { Editor, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { t } from "./i18n";
import { OssGalleryView, GALLERY_VIEW_TYPE } from "./views/OssGalleryView";
import { PluginSettings, DEFAULT_SETTINGS } from "./types/settings";
import { SettingsManager } from "./settings/SettingsManager";
import { ObjectKeyBuilder } from "./services/ObjectKeyBuilder";
import { EmbedRenderer } from "./services/EmbedRenderer";
import { UploadService, UploadProgress } from "./services/UploadService";
import { getFileTypeByMime } from "./utils/FileUtils";
import { handleUploadError } from "./utils/ErrorHandler";
import { OssProviderManager } from "./providers/OssProviderManager";
import { providerRegistry } from "./providers/registry";
import { loadStoredSettings } from "./settings/loadStoredSettings";

export default class OssGalleryPlugin extends Plugin {
	settings: PluginSettings;
	providerManager: OssProviderManager;
	private uploadCounter = 0;

	// Services
	private keyBuilder: ObjectKeyBuilder;
	private embedRenderer: EmbedRenderer;
	private uploadService: UploadService;

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
		} else {
			// Handle case where no provider is active or found
			// For now, we might not initialize uploadService or handle it gracefully
			console.warn("No active provider found during initialization");
		}
	}

	private addCommands(): void {
		this.addCommand({
			id: "oss-upload",
			name: t("File upload"),
			icon: "upload-cloud",
			editorCallback: (editor: Editor) => {
				if (!this.validateSettings()) {
					new Notice(t("Please configure OSS settings first"));
					return;
				}
				this.triggerFileUpload(editor);
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

	private triggerFileUpload(editor: Editor): void {
		const input = document.createElement("input");
		input.setAttribute("type", "file");
		input.setAttribute(
			"accept",
			"image/*,video/*,audio/*,.doc,.docx,.pdf,.pptx,.xlsx,.xls"
		);

		input.onchange = async (event: Event) => {
			const file = (event.target as HTMLInputElement)?.files?.[0];
			if (file) {
				await this.performUpload(editor, file);
			}
		};

		input.click();
	}

	/**
	 * Upload a file and replace the preview placeholder with the final embed.
	 *
	 * The placeholder carries a unique upload id and every later edit locates it
	 * by searching the document text, so concurrent uploads and user edits
	 * elsewhere in the note cannot shift the replacement range.
	 */
	private async performUpload(editor: Editor, file: File): Promise<void> {
		if (!file || !getFileTypeByMime(file)) return;

		const uploadId = `oss-upload-${Date.now()}-${++this.uploadCounter}`;
		let previewText = await this.buildUploadPreview(file, uploadId);

		const cursor = editor.getCursor();
		editor.replaceRange(previewText, cursor);
		editor.setCursor(
			editor.offsetToPos(editor.posToOffset(cursor) + previewText.length)
		);

		try {
			if (!this.uploadService) {
				throw new Error("Upload service not initialized. Check settings.");
			}

			const objectName = this.keyBuilder.generateObjectName(file);
			const fileType = getFileTypeByMime(file);

			const url = await this.uploadService.uploadFile(
				file,
				objectName,
				(progress: UploadProgress) => {
					let updated = previewText.replace(
						/width: \d+%/,
						`width: ${progress.percentage}%`
					);
					if (progress.percentage === 100) {
						updated = updated.replace("uploading", "completed");
					}
					if (this.replaceUploadPlaceholder(editor, previewText, updated) !== null) {
						previewText = updated;
					}
				}
			);

			window.setTimeout(() => {
				try {
					const finalText = this.embedRenderer.render(
						fileType,
						url,
						file.name
					);
					const startOffset = this.replaceUploadPlaceholder(
						editor,
						previewText,
						finalText
					);
					if (startOffset !== null) {
						editor.setCursor(
							editor.offsetToPos(startOffset + finalText.length)
						);
						editor.focus();
					}
					this.refreshGalleryViews();
				} catch (error) {
					handleUploadError(error, file.name);
				}
			}, 500);
		} catch (error) {
			handleUploadError(error, file.name);
			this.replaceUploadPlaceholder(editor, previewText, "");
			new Notice(t("Upload failed"));
		}
	}

	/**
	 * Locate the placeholder by its (unique) text and replace it.
	 * Returns the placeholder's start offset, or null if the user removed it
	 * or the editor is no longer available.
	 */
	private replaceUploadPlaceholder(
		editor: Editor,
		oldText: string,
		newText: string
	): number | null {
		try {
			const content = editor.getValue();
			const index = content.indexOf(oldText);
			if (index === -1) return null;
			editor.replaceRange(
				newText,
				editor.offsetToPos(index),
				editor.offsetToPos(index + oldText.length)
			);
			return index;
		} catch {
			return null;
		}
	}

	async handleUploader(
		evt: ClipboardEvent | DragEvent,
		editor: Editor
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

		for (const file of supported) {
			await this.performUpload(editor, file);
		}
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

	private async buildUploadPreview(
		file: File,
		uploadId: string
	): Promise<string> {
		const fileType = getFileTypeByMime(file);
		const wrap = (inner: string): string =>
			`<div class="upload-preview-container uploading" data-upload-id="${uploadId}">${inner}<div class="upload-progress"><div class="upload-progress-bar" style="width: 0%"></div></div></div>\n`;

		if (fileType !== "image") {
			return wrap("");
		}

		return new Promise<string>((resolve) => {
			const reader = new FileReader();
			reader.onload = (e) => {
				const imgSrc = e.target?.result;
				if (typeof imgSrc === "string") {
					resolve(wrap(`<img src="${imgSrc}">`));
				} else {
					resolve(wrap(""));
				}
			};
			reader.onerror = () => resolve(wrap(""));
			reader.readAsDataURL(file);
		});
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

		if (!existingData) {
			this.settings = loadStoredSettings(null);
			await this.saveData(this.settings);
		} else {
			this.settings = loadStoredSettings(existingData);
		}

		if (!providerRegistry.get(this.settings.activeProvider, this.app)) {
			this.settings.activeProvider = DEFAULT_SETTINGS.activeProvider;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);

		this.keyBuilder?.updateSettings(this.settings);
		this.embedRenderer?.updateSettings(this.settings);
		this.providerManager?.updateSettings(this.settings);
		
		const activeProvider = this.providerManager.getActiveProvider();
		if (activeProvider) {
			this.uploadService?.updateProvider(activeProvider);

			// Update all gallery views
			this.app.workspace.getLeavesOfType(GALLERY_VIEW_TYPE).forEach(leaf => {
				if (leaf.view instanceof OssGalleryView) {
					leaf.view.updateProvider(activeProvider);
				}
			});
		}
	}
}
