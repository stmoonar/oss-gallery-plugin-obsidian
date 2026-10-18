import { requireApiVersion, Setting, SettingGroup, setTooltip } from "obsidian";

/**
 * Settings tab layout. Obsidian 1.11+ draws every `.setting-item` that is
 * not inside a `.setting-group` as its own rounded card (app.css:
 * `.setting-item { border-radius; background; margin-bottom }`), which is
 * what made the tab look like a pile of separate boxes. Inside a group the
 * same rows become one container with thin dividers. So every section
 * renders its rows into one group: Obsidian's `SettingGroup` where it exists
 * (1.11+), else a plain container styled like it (styles.css,
 * `.oss-gallery-setting-group-fallback`; older versions draw rows as a flat
 * list with dividers anyway).
 */

export interface SettingsSectionOptions {
	heading: string;
	/** One short muted line under the heading. */
	intro?: string;
	/** Extra class on the section (e.g. a smaller sub-section). */
	cls?: string;
}

/** A group container; returns the element its rows go into. */
export function createSettingsGroup(parentEl: HTMLElement): HTMLElement {
	if (requireApiVersion("1.11.0")) {
		return new SettingGroup(parentEl).addClass("oss-gallery-setting-group").listEl;
	}
	const group = parentEl.createDiv({ cls: "oss-gallery-setting-group oss-gallery-setting-group-fallback" });
	return group.createDiv({ cls: "oss-gallery-setting-items" });
}

/**
 * A section: a strong heading, an optional one-line intro, and one group.
 * Returns the element the section's rows go into.
 */
export function createSettingsSection(containerEl: HTMLElement, options: SettingsSectionOptions): HTMLElement {
	const section = containerEl.createDiv({ cls: "oss-gallery-settings-section" });
	if (options.cls) {
		section.addClass(options.cls);
	}
	const heading = new Setting(section).setName(options.heading).setHeading();
	heading.settingEl.addClass("oss-gallery-section-heading");
	if (options.intro) {
		heading.setDesc(options.intro);
	}
	return createSettingsGroup(section);
}

/** A row that belongs to the row above it (indented, no divider in between). */
export function markChildSetting(setting: Setting): Setting {
	setting.settingEl.addClass("oss-gallery-setting-child");
	return setting;
}

/**
 * Extra detail (default path, URL format) on hover and for screen readers,
 * instead of repeating it in the description.
 */
export function addInputHint(inputEl: HTMLElement, hint: string): void {
	setTooltip(inputEl, hint);
	inputEl.setAttr("aria-description", hint);
}
