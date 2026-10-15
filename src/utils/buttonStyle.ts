import type { ButtonComponent } from "obsidian";

/**
 * Button styling methods across Obsidian versions. `setDestructive()` exists
 * since 1.13.0 and replaces the deprecated `setWarning()`, but minAppVersion
 * is 1.7.2, so both are looked up at runtime through this one local type.
 */
interface VersionedButtonStyles {
	setDestructive?: () => unknown;
	setWarning?: () => unknown;
}

/**
 * Style a button as destructive: `setDestructive()` when available (plus
 * `setCta()` for a destructive primary action), else the older
 * `setWarning()`, which already reads as a primary action.
 */
export function setDestructiveButton(btn: ButtonComponent, primary = false): ButtonComponent {
	const styles = btn as unknown as VersionedButtonStyles;
	if (typeof styles.setDestructive === "function") {
		styles.setDestructive.call(btn);
		if (primary) {
			btn.setCta();
		}
	} else {
		styles.setWarning?.call(btn);
	}
	return btn;
}
