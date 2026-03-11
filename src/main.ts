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

interface Position {
	line: number;
	ch: number;
}

export default class OssGalleryPlugin extends Plugin {
	settings: PluginSettings;
	providerManager: OssProviderManager;

	// Services
	private keyBuilder: ObjectKeyBuilder;
	private embedRenderer: EmbedRenderer;
	private uploadService: UploadService;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.providerManager = new OssProviderManager(this.settings);

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
			id: "open-oss-gallery",
			name: t("Open Minio gallery"), // Keep name for familiarity or update
			icon: "image-file",
			callback: () => {
				if (!this.supportsActiveProviderCapability("list")) {
					new Notice(t("Image listing is not available"));
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
				const provider = this.providerManager.getActiveProvider();
				if (!provider) throw new Error("No active provider");
				return new OssGalleryView(leaf, provider);
			}
		);

		this.addRibbonIcon("image-file", t("Minio gallery"), () => {
			if (!this.supportsActiveProviderCapability("list")) {
				new Notice(t("Image listing is not available"));
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

		workspace.revealLeaf(leaf);
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
				await this.uploadFileToEditor(editor, file);
			}
		};

		input.click();
	}

	/**
	 * Upload a file directly (used by command palette file picker)
	 */
	private async uploadFileToEditor(editor: Editor, file: File): Promise<void> {
		if (!file || !getFileTypeByMime(file)) return;

		const cursor = editor.getCursor();
		const startPos: Position = { line: cursor.line, ch: cursor.ch };
		let previewText = await this.showUploadPreview(editor, startPos, file);

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
					previewText = this.updateUploadProgress(
						editor,
						startPos,
						previewText,
						progress.percentage
					);
				}
			);

			setTimeout(() => {
				const finalText = this.embedRenderer.render(
					fileType,
					url,
					file.name
				);
				const endPos = editor.offsetToPos(
					editor.posToOffset(startPos) + previewText.length
				);
				editor.replaceRange(finalText, startPos, endPos);
				const newCursorPos = editor.offsetToPos(
					editor.posToOffset(startPos) + finalText.length
				);
				editor.setCursor(newCursorPos);
				editor.focus();
				this.refreshGalleryViews();
			}, 500);
		} catch (error) {
			handleUploadError(error, file.name);
			const endPos = editor.offsetToPos(
				editor.posToOffset(startPos) + previewText.length
			);
			editor.replaceRange("", startPos, endPos);
			editor.setCursor(startPos);
			new Notice(t("Upload failed"));
		}
	}

	async handleUploader(
		evt: ClipboardEvent | DragEvent,
		editor: Editor
	): Promise<void> {
		if (evt.defaultPrevented) return;

		const file = this.extractFileFromEvent(evt);
		if (!file || !getFileTypeByMime(file)) return;
		if (!this.validateSettings()) return;

		evt.preventDefault();

		const cursor = editor.getCursor();
		const startPos: Position = { line: cursor.line, ch: cursor.ch };
		let previewText = await this.showUploadPreview(editor, startPos, file);

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
					previewText = this.updateUploadProgress(
						editor,
						startPos,
						previewText,
						progress.percentage
					);
				}
			);

			// Wait a bit for the progress bar to complete visually
			setTimeout(() => {
				const finalText = this.embedRenderer.render(
					fileType,
					url,
					file.name
				);
				// Get actual range of preview text
				const endPos = editor.offsetToPos(
					editor.posToOffset(startPos) + previewText.length
				);
				editor.replaceRange(finalText, startPos, endPos);
				// Move cursor to end of inserted text
				const newCursorPos = editor.offsetToPos(
					editor.posToOffset(startPos) + finalText.length
				);
				editor.setCursor(newCursorPos);
				// Ensure editor focus
				editor.focus();

				// Refresh all gallery views to show the new upload
				this.refreshGalleryViews();
			}, 500);
		} catch (error) {
			handleUploadError(error, file.name);
			// Remove preview text
			const endPos = editor.offsetToPos(
				editor.posToOffset(startPos) + previewText.length
			);
			editor.replaceRange("", startPos, endPos);
			editor.setCursor(startPos);
			new Notice(t("Upload failed"));
		}
	}

	private extractFileFromEvent(evt: ClipboardEvent | DragEvent): File | null {
		switch (evt.type) {
			case "paste":
				return (evt as ClipboardEvent).clipboardData?.files[0] || null;
			case "drop":
				return (evt as DragEvent).dataTransfer?.files[0] || null;
			default:
				return null;
		}
	}

	private async showUploadPreview(
		editor: Editor,
		startPos: Position,
		file: File
	): Promise<string> {
		const fileType = getFileTypeByMime(file);
		let previewText = `<div class="upload-preview-container uploading"><div class="upload-progress"><div class="upload-progress-bar" style="width: 0%"></div></div></div>\n`;

		if (fileType === "image") {
			const reader = new FileReader();

			const imgPreview = await new Promise<string>((resolve) => {
				reader.onload = (e) => {
					const imgSrc = e.target?.result as string;
					const newText = `<div class="upload-preview-container uploading"><img src="${imgSrc}"><div class="upload-progress"><div class="upload-progress-bar" style="width: 0%"></div></div></div>\n`;
					resolve(newText);
				};
				reader.readAsDataURL(file);
			});

			previewText = imgPreview;
		}

		editor.replaceRange(previewText, startPos);
		editor.setCursor({ line: startPos.line + 1, ch: 0 });

		return previewText;
	}

	private updateUploadProgress(
		editor: Editor,
		startPos: Position,
		currentText: string,
		percentage: number
	): string {
		const progressText = currentText.replace(
			/width: \d+%/,
			`width: ${percentage}%`
		);
		const endPos = editor.offsetToPos(
			editor.posToOffset(startPos) + currentText.length
		);
		editor.replaceRange(progressText, startPos, endPos);

		if (percentage === 100) {
			const completedText = progressText.replace(
				"uploading",
				"completed"
			);
			const completedEndPos = editor.offsetToPos(
				editor.posToOffset(startPos) + progressText.length
			);
			editor.replaceRange(completedText, startPos, completedEndPos);
			return completedText;
		}

		return progressText;
	}

	validateSettings(): boolean {
		return providerRegistry.isConfigured(
			this.settings.activeProvider,
			this.settings.providers[this.settings.activeProvider]
		);
	}

	private supportsActiveProviderCapability(
		capability: "upload" | "list" | "delete"
	): boolean {
		return providerRegistry.supports(this.settings.activeProvider, capability);
	}

	/**
	 * Refresh all gallery views after upload
	 */
	private refreshGalleryViews(): void {
		// Get all gallery views and force refresh them
		this.app.workspace.getLeavesOfType('oss-gallery-view').forEach(leaf => {
			if (leaf.view instanceof OssGalleryView) {
				// Force refresh by calling loadGallery with true
				(leaf.view as OssGalleryView).loadGallery(true);
			}
		});
	}

	onunload(): void {
		// Cleanup
	}

	async loadSettings(): Promise<void> {
		const existingData = await this.loadData();

		if (!existingData) {
			await this.saveData(DEFAULT_SETTINGS);
			this.settings = { ...DEFAULT_SETTINGS };
		} else {
			// Migration logic for old settings (pre-multi-provider)
			if (!existingData.providers) {
				const oldSettings = existingData as any;
				this.settings = {
					...DEFAULT_SETTINGS,
					activeProvider: 'minio',
					basepath: oldSettings.basepath || '',
					providers: {
						...DEFAULT_SETTINGS.providers,
						minio: {
							accessKey: oldSettings.accessKey || '',
							secretKey: oldSettings.secretKey || '',
							region: oldSettings.region || '',
							bucket: oldSettings.bucket || '',
							endpoint: oldSettings.endpoint || '',
							port: oldSettings.port || 9000,
							customDomain: oldSettings.customDomain || '',
							useSSL: oldSettings.useSSL ?? true,
						},
					},
				};
			} else {
				// Deep merge providers: ensure all provider keys exist with defaults from registry
				const registryDefaults = providerRegistry.buildDefaultProviderSettings();
				const mergedProviders = { ...registryDefaults };
				for (const key of Object.keys(registryDefaults) as Array<keyof typeof registryDefaults>) {
					mergedProviders[key] = {
						...registryDefaults[key],
						...(existingData.providers[key] || {}),
					} as any;
				}

				this.settings = {
					...DEFAULT_SETTINGS,
					...existingData,
					providers: mergedProviders,
				};
			}
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
			this.app.workspace.getLeavesOfType('oss-gallery-view').forEach(leaf => {
				if (leaf.view instanceof OssGalleryView) {
					leaf.view.updateProvider(activeProvider);
				}
			});
		}
	}
}
