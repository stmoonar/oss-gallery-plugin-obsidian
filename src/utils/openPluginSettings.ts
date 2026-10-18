/** Obsidian's settings dialog (`app.setting`, not in the public API typings). */
interface SettingDialog {
	open?: () => void;
	openTabById?: (id: string) => unknown;
}

/**
 * Open Obsidian's settings, on this plugin's tab when `pluginId` is given.
 * Shared by the upload notices, the gallery and the semantic status bar.
 */
export function openPluginSettings(app: unknown, pluginId?: string): void {
	const setting = (app as { setting?: SettingDialog } | null)?.setting;
	if (!setting) return;
	setting.open?.();
	if (pluginId) setting.openTabById?.(pluginId);
}
